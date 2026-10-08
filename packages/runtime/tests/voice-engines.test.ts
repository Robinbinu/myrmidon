import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseWav, wav } from '../src/voice/audio.ts'
import { OpenAiCompatibleStt, PhononStt } from '../src/voice/stt.ts'
import { KittenTts, OpenAiCompatibleTts } from '../src/voice/tts.ts'

const dirs: string[] = []
const servers: { stop(force?: boolean): void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'myr-voice-'))
  dirs.push(d)
  return d
}

const tone = Int16Array.from({ length: 1600 }, (_, i) => Math.round(8000 * Math.sin(i / 5)))

test('WAV files round-trip 16-bit audio and read float WAVs too', () => {
  const back = parseWav(wav(tone, 16_000))
  expect(back.sampleRate).toBe(16_000)
  expect([...back.pcm]).toEqual([...tone])
  expect(() => parseWav(new Uint8Array([1, 2, 3]))).toThrow('not a WAV file')
})

test('an OpenAI-compatible endpoint transcribes a turn and speaks a sentence', async () => {
  const seen: { auth?: string | null; model?: unknown; file?: string; speech?: unknown } = {}
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url)
      seen.auth = req.headers.get('authorization')
      if (url.pathname === '/v1/audio/transcriptions') {
        const form = await req.formData()
        seen.model = form.get('model')
        const file = form.get('file') as File
        seen.file = file.type
        expect(parseWav(new Uint8Array(await file.arrayBuffer())).pcm.length).toBe(tone.length)
        return Response.json({ text: '  start the report  ' })
      }
      if (url.pathname === '/v1/audio/speech') {
        seen.speech = await req.json()
        return new Response(wav(tone, 24_000), { headers: { 'content-type': 'audio/wav' } })
      }
      return new Response('no', { status: 404 })
    },
  })
  servers.push(server)
  const base = `http://127.0.0.1:${server.port}/v1/`
  const stt = new OpenAiCompatibleStt({ baseUrl: base, model: 'whisper-1', apiKey: 'k1' })
  expect(await stt.transcribe(tone, 16_000)).toBe('start the report')
  expect(seen).toMatchObject({ auth: 'Bearer k1', model: 'whisper-1' })
  expect(seen.file).toMatch(/wav/)

  const tts = new OpenAiCompatibleTts({ baseUrl: base, model: 'tts-1', voice: 'alloy', speed: 1.1 })
  const speech = await tts.speak('Done.')
  expect(speech.sampleRate).toBe(24_000)
  expect(speech.pcm.length).toBe(tone.length)
  expect(seen.speech).toEqual({
    model: 'tts-1',
    input: 'Done.',
    voice: 'alloy',
    response_format: 'wav',
    speed: 1.1,
  })

  const failing = new OpenAiCompatibleStt({ baseUrl: `http://127.0.0.1:${server.port}/nope`, model: 'x' })
  await expect(failing.transcribe(tone, 16_000)).rejects.toThrow('transcription failed (404)')
})

test("Kitten's model downloads into Myrmidon's own folder, all or nothing", async () => {
  const files: Record<string, string> = {
    'config.json': JSON.stringify({ model_file: 'net.onnx', voices: 'voices.npz' }),
    'net.onnx': 'network',
    'voices.npz': 'voices',
  }
  let fail = false
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const name = new URL(req.url).pathname.split('/').pop() ?? ''
      if (fail && name === 'voices.npz') return new Response('gone', { status: 500 })
      return files[name] ? new Response(files[name]) : new Response('no', { status: 404 })
    },
  })
  servers.push(server)
  const h = home()
  const settings = { model: 'nano' as const, voice: 'Leo', speed: 1 }
  const kitten = new KittenTts(h, () => settings, undefined, `http://127.0.0.1:${server.port}`)
  expect(kitten.status()).toEqual({ state: 'missing' })

  fail = true
  await expect(kitten.download()).rejects.toThrow('downloading voices.npz')
  expect(kitten.status()).toMatchObject({ state: 'error' })
  expect(existsSync(join(h, 'voice', 'kitten', 'nano'))).toBe(false)

  fail = false
  await kitten.download()
  expect(kitten.status()).toEqual({ state: 'ready' })
  expect(readdirSync(join(h, 'voice', 'kitten', 'nano')).sort()).toEqual([
    'config.json',
    'net.onnx',
    'voices.npz',
  ])
})

test('Phonon-2 says it is missing when its command line is not installed', async () => {
  const phonon = new PhononStt(home(), undefined, join(home(), 'no-bin'))
  if (Bun.which('fermion')) return
  expect(phonon.status()).toEqual({ state: 'missing' })
  await expect(phonon.transcribe(tone, 16_000)).rejects.toThrow('Phonon-2 is not installed')
  expect(phonon.status()).toMatchObject({ state: 'error' })
})

// The real engines: downloads Kitten nano (25 MB) and uses an installed Phonon-2 (164 MB model). Opt in.
test.skipIf(!process.env.MYR_VOICE_E2E)(
  'Kitten speaks a sentence and Phonon-2 hears it back',
  async () => {
    const h = home()
    const kitten = new KittenTts(h, () => ({ model: 'nano', voice: 'Leo', speed: 1 }))
    const phonon = new PhononStt(h, (l) => console.error(l))
    try {
      const speech = await kitten.speak('The crew finished the report.')
      expect(speech.sampleRate).toBe(24_000)
      // Phonon takes 16 kHz; a crude decimation is enough for a check.
      const down = Int16Array.from(
        { length: Math.floor(speech.pcm.length / 1.5) },
        (_, i) => speech.pcm[Math.floor(i * 1.5)] ?? 0,
      )
      const heard = await phonon.transcribe(down, 16_000)
      expect(heard.toLowerCase()).toContain('crew finished the report')
    } finally {
      kitten.stop()
      phonon.stop()
    }
  },
  15 * 60_000,
)
