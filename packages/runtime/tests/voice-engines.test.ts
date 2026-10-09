import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { VOICE_KITTEN_MODELS, VOICE_PHONON_VERSION } from '../src/config.ts'
import { parseWav, trimSilence, wav } from '../src/voice/audio.ts'
import { PhononStream } from '../src/voice/phonon-stream.ts'
import { SmartTurn } from '../src/voice/smart-turn.ts'
import { SpeechSplitter } from '../src/voice/speech.ts'
import { OpenAiCompatibleStt, PHONON_INSTALL, PhononStt, stopLeftovers } from '../src/voice/stt.ts'
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

test('hotwords go only to an endpoint that takes them, as a JSON list', async () => {
  const fields: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      fields.push((await req.formData()).get('hotwords') as string | null)
      return Response.json({ text: 'ok' })
    },
  })
  servers.push(server)
  const baseUrl = `http://127.0.0.1:${server.port}/v1`
  const hotwords = ['Quillon', 'Smith, Jones']
  await new OpenAiCompatibleStt({ baseUrl, model: 'phonon-2', hotwords: true }).transcribe(tone, 16_000, {
    hotwords,
  })
  await new OpenAiCompatibleStt({ baseUrl, model: 'whisper-1' }).transcribe(tone, 16_000, { hotwords })
  await new OpenAiCompatibleStt({ baseUrl, model: 'phonon-2', hotwords: true }).transcribe(tone, 16_000)
  expect(fields).toEqual(['["Quillon","Smith, Jones"]', null, null])
})

test("Phonon's live stream sends the turn's audio as it comes and says the words so far", async () => {
  const dir = home()
  const unix = join(dir, 's.sock')
  const got: { config?: unknown; samples: number[]; texts: string[]; ended?: boolean } = {
    samples: [],
    texts: [],
  }
  let peer: ServerWebSocket<undefined> | undefined
  const server = Bun.serve({
    unix,
    fetch: (req, s) =>
      new URL(req.url).pathname === '/v1/audio/stream' && s.upgrade(req)
        ? undefined
        : new Response('no', { status: 404 }),
    websocket: {
      open: (ws) => {
        peer = ws
      },
      message: (ws, msg) => {
        if (typeof msg === 'string') {
          const m = JSON.parse(msg)
          if (m.type === 'end') got.ended = true
          else got.config = m
          return
        }
        got.samples.push(...new Int16Array(msg.buffer, msg.byteOffset, msg.byteLength / 2))
        if (got.samples.length === 4) ws.send(JSON.stringify({ type: 'partial', text: 'check the' }))
        if (got.samples.length === 6) {
          ws.send(JSON.stringify({ type: 'final', text: 'Check the build.', segment: 1 }))
          ws.send(JSON.stringify({ type: 'partial', text: 'then' }))
        }
      },
      close: () => {
        peer = undefined
      },
    },
  })
  servers.push(server)
  const stream = new PhononStream(unix, 16_000, (text) => got.texts.push(text))
  // Audio from before the server answers is kept, then sent in order.
  stream.push(Int16Array.from([1, 2]))
  stream.push(Int16Array.from([3, 4]))
  const until = async (check: () => boolean) => {
    const end = Date.now() + 3000
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out')
      await Bun.sleep(5)
    }
  }
  await until(() => got.texts.length === 1)
  stream.push(Int16Array.from([5, -6]))
  await until(() => got.texts.length === 3)
  expect(got.config).toEqual({ sample_rate: 16_000, format: 'pcm_s16le' })
  expect(got.samples).toEqual([1, 2, 3, 4, 5, -6])
  expect(got.texts).toEqual(['check the', 'Check the build.', 'Check the build. then'])
  stream.close()
  await until(() => peer === undefined)
  // Ended without asking Phonon to decode the rest, which would hold up the turn's transcript.
  expect(got.ended).toBeUndefined()
})

test('a stream the server refuses ends quietly, and Phonon streams only once it is running', async () => {
  const dir = home()
  const unix = join(dir, 's.sock')
  const server = Bun.serve({ unix, fetch: () => new Response('busy', { status: 503 }) })
  servers.push(server)
  const logged: string[] = []
  const texts: string[] = []
  const stream = new PhononStream(
    unix,
    16_000,
    (t) => texts.push(t),
    (l) => logged.push(l),
  )
  stream.push(new Int16Array(4))
  const end = Date.now() + 3000
  while (!logged.length && Date.now() < end) await Bun.sleep(5)
  expect(logged[0]).toContain('503')
  stream.push(new Int16Array(4))
  expect(texts).toEqual([])
  expect(new PhononStt(home(), undefined, join(home(), 'no-bin')).listen(16_000, () => {})).toBeUndefined()
})

/** Pins for a stand-in model whose files are `files`, so the downloads check against their real hashes. */
const pinsFor = (files: Record<string, string>) => {
  const pin = {
    repo: 'KittenML/test',
    revision: 'abc123',
    files: Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        name,
        { sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body) },
      ]),
    ),
  }
  return { nano: pin, micro: pin, mini: pin }
}

test("Kitten's model downloads into Myrmidon's own folder, all or nothing, from a pinned revision", async () => {
  const files: Record<string, string> = {
    'config.json': JSON.stringify({ model_file: 'net.onnx', voices: 'voices.npz' }),
    'net.onnx': 'network',
    'voices.npz': 'voices',
  }
  let fail = false
  const paths: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const path = new URL(req.url).pathname
      paths.push(path)
      const name = path.split('/').pop() ?? ''
      if (fail && name === 'voices.npz') return new Response('gone', { status: 500 })
      return files[name] ? new Response(files[name]) : new Response('no', { status: 404 })
    },
  })
  servers.push(server)
  const h = home()
  const settings = { model: 'nano' as const, voice: 'Leo', speed: 1 }
  const kitten = new KittenTts(
    h,
    () => settings,
    undefined,
    `http://127.0.0.1:${server.port}`,
    pinsFor(files),
  )
  expect(kitten.status()).toEqual({ state: 'missing' })

  fail = true
  await expect(kitten.download()).rejects.toThrow('downloading voices.npz')
  expect(kitten.status()).toMatchObject({ state: 'error' })
  expect(existsSync(join(h, 'voice', 'kitten', 'nano'))).toBe(false)

  fail = false
  paths.length = 0
  // The Download button and a warm-up at once share one download.
  await Promise.all([kitten.download(), kitten.download()])
  expect(paths.every((p) => p.startsWith('/KittenML/test/resolve/abc123/'))).toBe(true)
  expect(paths.filter((p) => p.endsWith('/net.onnx'))).toHaveLength(1)
  expect(kitten.status()).toEqual({ state: 'ready' })
  expect(readdirSync(join(h, 'voice', 'kitten', 'nano')).sort()).toEqual([
    '.pinned',
    'config.json',
    'net.onnx',
    'voices.npz',
  ])
})

test('a Kitten model already here is checked against its pins once, and downloaded again if it is not them', async () => {
  const files: Record<string, string> = {
    'config.json': JSON.stringify({ model_file: 'net.onnx', voices: 'voices.npz' }),
    'net.onnx': 'network',
    'voices.npz': 'voices',
  }
  let fetched = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      fetched++
      const name = new URL(req.url).pathname.split('/').pop() ?? ''
      return files[name] ? new Response(files[name]) : new Response('no', { status: 404 })
    },
  })
  servers.push(server)
  const h = home()
  const dir = join(h, 'voice', 'kitten', 'nano')
  const settings = { model: 'nano' as const, voice: 'Leo', speed: 1 }
  const kitten = () =>
    new KittenTts(h, () => settings, undefined, `http://127.0.0.1:${server.port}`, pinsFor(files))
  // An install from before the pins, with another network in it.
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries({ ...files, 'net.onnx': 'an older network' }))
    writeFileSync(join(dir, name), body)
  await kitten().download()
  expect(readFileSync(join(dir, 'net.onnx'), 'utf8')).toBe('network')
  expect(fetched).toBe(3)
  // The pinned one is kept, and once checked it is known by its revision.
  rmSync(join(dir, '.pinned'))
  await kitten().download()
  expect(readFileSync(join(dir, '.pinned'), 'utf8')).toBe('abc123')
  await kitten().download()
  expect(fetched).toBe(3)
})

test("one Kitten model's failed download says nothing about another", async () => {
  const files: Record<string, string> = {
    'config.json': JSON.stringify({ model_file: 'net.onnx', voices: 'voices.npz' }),
    'net.onnx': 'network',
    'voices.npz': 'voices',
  }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const path = new URL(req.url).pathname
      const name = path.split('/').pop() ?? ''
      if (path.startsWith('/KittenML/broken/')) return new Response('gone', { status: 500 })
      return files[name] ? new Response(files[name]) : new Response('no', { status: 404 })
    },
  })
  servers.push(server)
  const pins = pinsFor(files)
  const settings = { model: 'nano' as const, voice: 'Leo', speed: 1 }
  const kitten = new KittenTts(home(), () => settings, undefined, `http://127.0.0.1:${server.port}`, {
    ...pins,
    mini: { ...pins.mini, repo: 'KittenML/broken' },
  })
  await kitten.download('nano')
  await expect(kitten.download('mini')).rejects.toThrow('failed (500)')
  expect(kitten.status('nano')).toEqual({ state: 'ready' })
  expect(kitten.status('mini')).toMatchObject({ state: 'error' })
  expect(kitten.status('micro')).toEqual({ state: 'missing' })
})

test('a Kitten file that does not match its pinned hash, or a config naming a path, is refused', async () => {
  const good: Record<string, string> = {
    'config.json': JSON.stringify({ model_file: '../../escape.onnx', voices: 'voices.npz' }),
    '../../escape.onnx': 'network',
    'voices.npz': 'voices',
  }
  const served: Record<string, string> = { ...good }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const name = decodeURIComponent(new URL(req.url).pathname.split('/resolve/abc123/')[1] ?? '')
      return served[name] ? new Response(served[name]) : new Response('no', { status: 404 })
    },
  })
  servers.push(server)
  const h = home()
  const settings = { model: 'nano' as const, voice: 'Leo', speed: 1 }
  const traversal = new KittenTts(
    h,
    () => settings,
    undefined,
    `http://127.0.0.1:${server.port}`,
    pinsFor(good),
  )
  await expect(traversal.download()).rejects.toThrow('names an unexpected file')
  expect(existsSync(join(h, 'voice', 'escape.onnx'))).toBe(false)
  expect(existsSync(join(h, 'escape.onnx'))).toBe(false)

  const plain = {
    'config.json': JSON.stringify({ model_file: 'net.onnx' }),
    'net.onnx': 'network',
    'voices.npz': 'v',
  }
  Object.assign(served, plain, { 'net.onnx': 'tampered' })
  const tampered = new KittenTts(
    h,
    () => settings,
    undefined,
    `http://127.0.0.1:${server.port}`,
    pinsFor(plain),
  )
  await expect(tampered.download()).rejects.toThrow('did not match its pinned hash')
  expect(existsSync(join(h, 'voice', 'kitten', 'nano'))).toBe(false)
})

test('the pinned Kitten models and Phonon-2 release are fixed, not whatever was published last', () => {
  for (const pin of Object.values(VOICE_KITTEN_MODELS)) {
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/)
    for (const f of Object.values(pin.files)) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
  }
  expect(PHONON_INSTALL).toContain(`fermion-research==${VOICE_PHONON_VERSION}`)
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

test('a Phonon server left by an earlier run is stopped before a new one takes its socket, and no other', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myr-phonon-'))
  const socket = join(dir, 'phonon.sock')
  // Stand-ins whose command lines read like Phonon's; one ignores the polite stop and has to be killed.
  const fake = (sock: string, stubborn = false) =>
    Bun.spawn(
      [
        process.execPath,
        '-e',
        `${stubborn ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000)`,
        'serve',
        'phonon-2',
        '--unix-socket',
        sock,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
  const polite = fake(socket)
  const stubborn = fake(socket, true)
  const other = fake(join(dir, 'other.sock'))
  try {
    await Bun.sleep(300)
    const stopped = await stopLeftovers(socket, 500)
    expect(stopped.sort()).toEqual([polite.pid, stubborn.pid].sort())
    await Promise.all([polite.exited, stubborn.exited])
    expect(other.killed || other.exitCode !== null).toBe(false)
  } finally {
    for (const p of [polite, stubborn, other]) p.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
