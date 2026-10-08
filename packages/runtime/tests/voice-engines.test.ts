import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseWav, trimSilence, wav } from '../src/voice/audio.ts'
import { SmartTurn } from '../src/voice/smart-turn.ts'
import { SpeechSplitter } from '../src/voice/speech.ts'
import { OpenAiCompatibleStt, PhononStt } from '../src/voice/stt.ts'
import { KittenTts, OpenAiCompatibleTts } from '../src/voice/tts.ts'
import { SileroVad, VAD_CHUNK } from '../src/voice/vad.ts'
import { whisperFeatures } from '../src/voice/whisper-features.ts'

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

test('quiet around a spoken sentence is cut to a breath, the speech kept whole', () => {
  const rate = 24_000
  const quiet = new Int16Array(rate) // a second
  const speech = Int16Array.from({ length: rate / 2 }, (_, i) => Math.round(6000 * Math.sin(i / 4)))
  const pcm = new Int16Array(quiet.length * 2 + speech.length)
  pcm.set(speech, quiet.length)
  const trimmed = trimSilence(pcm, rate)
  // 50 ms before, the half second of speech, 150 ms after (to the nearest 10 ms window).
  expect(trimmed.length / rate).toBeCloseTo(0.7, 1)
  expect(trimSilence(new Int16Array(100), rate).length).toBe(100)
})

test('the speech detector is saved only if it matches its pinned hash', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('not a model') })
  servers.push(server)
  const h = home()
  const vad = new SileroVad(h, `http://127.0.0.1:${server.port}/vad.onnx`)
  await expect(vad.load()).rejects.toThrow('did not match its hash')
  expect(vad.ready).toBe(false)
  expect(existsSync(join(h, 'voice'))).toBe(false)
})

test.skipIf(!process.env.MYR_VOICE_E2E)(
  'Silero tells speech from silence and a tone; Phonon-2 warms up',
  async () => {
    const h = home()
    const kitten = new KittenTts(h, () => ({ model: 'nano', voice: 'Leo', speed: 1 }))
    const vad = new SileroVad(h)
    const phonon = new PhononStt(h)
    try {
      const speech = await kitten.speak('The crew finished the report.')
      const down = Float32Array.from(
        { length: Math.floor(speech.pcm.length / 1.5) },
        (_, i) => (speech.pcm[Math.floor(i * 1.5)] ?? 0) / 32768,
      )
      const score = async (audio: Float32Array) => {
        const s = vad.stream()
        let best = 0
        for (let i = 0; i + VAD_CHUNK <= audio.length; i += VAD_CHUNK)
          best = Math.max(best, await s.chance(audio.subarray(i, i + VAD_CHUNK)))
        return best
      }
      expect(await score(down)).toBeGreaterThan(0.9)
      expect(await score(new Float32Array(16_000))).toBeLessThan(0.1)
      expect(
        await score(Float32Array.from({ length: 16_000 }, (_, i) => 0.3 * Math.sin(i / 3))),
      ).toBeLessThan(0.5)
      await phonon.warm()
      expect(phonon.status()).toEqual({ state: 'running' })
    } finally {
      kitten.stop()
      phonon.stop()
    }
  },
  15 * 60_000,
)

test('replies are split for speech as they are written: first clause early, code held until it closes', () => {
  const s = new SpeechSplitter({ firstClause: true })
  expect(s.push('I looked', false)).toEqual([])
  // A clause of a few words goes at once; a short one ("Sure thing,") waits for the sentence.
  expect(s.push('I looked at the build, and', false)).toEqual(['I looked at the build,'])
  expect(s.push('I looked at the build, and it is green. Then', false)).toEqual(['and it is green.'])
  const code = 'I looked at the build, and it is green. Then run:\n```\nnpm test'
  expect(s.push(code, false)).toEqual(['Then run:'])
  expect(s.push(`${code}\n\`\`\`\nDone.`, true)).toEqual(['(there is code in the chat)', 'Done.'])
  expect(new SpeechSplitter({ firstClause: true }).push('Sure thing, I will check', false)).toEqual([])
})

test('the turn model is saved only if it matches its pinned hash', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('not a model') })
  servers.push(server)
  const turn = new SmartTurn(home(), `http://127.0.0.1:${server.port}/st.onnx`)
  await expect(turn.load()).rejects.toThrow('did not match its hash')
  expect(turn.ready).toBe(false)
})

test('Whisper features match the reference shape and range', () => {
  const tone = Float32Array.from({ length: 16_000 }, (_, i) => 0.3 * Math.sin(i / 5))
  const f = whisperFeatures(tone)
  expect(f.length).toBe(80 * 800)
  // (log10 + 4) / 4, floored 8 below the peak: everything lies within 2 of the top.
  const max = f.reduce((m, x) => Math.max(m, x), -Infinity)
  const min = f.reduce((m, x) => Math.min(m, x), Infinity)
  expect(max - min).toBeLessThanOrEqual(2.0001)
})

test.skipIf(!process.env.MYR_VOICE_E2E)(
  'Smart Turn hears a finished sentence as finished and a trailing "um" as not',
  async () => {
    const h = home()
    const kitten = new KittenTts(h, () => ({ model: 'nano', voice: 'Jasper', speed: 1 }))
    const turn = new SmartTurn(h)
    try {
      const at16k = async (text: string) => {
        const pcm = trimSilence((await kitten.speak(text)).pcm, 24_000, 0, 0)
        return Int16Array.from(
          { length: Math.floor(pcm.length / 1.5) },
          (_, i) => pcm[Math.floor(i * 1.5)] ?? 0,
        )
      }
      expect(await turn.finished(await at16k('What is the weather in Paris today?'))).toBeGreaterThan(0.8)
      expect(await turn.finished(await at16k('So the thing is, um'))).toBeLessThan(0.3)
    } finally {
      kitten.stop()
    }
  },
  15 * 60_000,
)
