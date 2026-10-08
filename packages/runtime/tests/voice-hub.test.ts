import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockModel } from '@oh-my-pi/pi-ai/providers/mock'
import { ModelResolver } from '../src/models.ts'
import { SettingsStore } from '../src/settings.ts'
import { CallRefused, VoiceHub, type VoiceSettings } from '../src/voice/hub.ts'
import { SmartTurn } from '../src/voice/smart-turn.ts'
import { OpenAiCompatibleStt, PhononStt } from '../src/voice/stt.ts'
import { FunctionTts, KittenTts } from '../src/voice/tts.ts'
import { SileroVad } from '../src/voice/vad.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(voice: Partial<VoiceSettings> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'myr-voicehub-'))
  dirs.push(home)
  const stored = new SettingsStore(home).get().voice
  // Most tests are about a call, so voice is on unless the test says otherwise.
  const defaults = { ...stored, enabled: true }
  const resolver = new ModelResolver()
  const model = createMockModel({ handler: () => ({ content: ['Okay.'] }) })
  resolver.register('mock/voice', { model: model.model, streamFn: model.stream })
  const hub = new VoiceHub({
    home,
    resolver,
    settings: () => ({ voice: { ...defaults, ...voice }, fallbackModel: 'mock/voice' }),
    omp: {
      transcribe: async () => 'from omp',
      speak: async () => ({ audio: new Uint8Array(), mimeType: 'audio/wav' }),
      speechModels: () => ({ stt: ['openai/whisper-1'], tts: [] }),
    },
  })
  return { home, hub, stored }
}

test('voice settings default to the engines on this machine', () => {
  const { hub, stored } = setup()
  expect(stored).toEqual({
    enabled: false,
    stt: { provider: 'phonon' },
    tts: { provider: 'kitten', kittenModel: 'nano', voice: 'Leo', speed: 1 },
    sensitivity: 'normal',
  })
  expect(hub.stt()).toBeInstanceOf(PhononStt)
  expect(hub.tts()).toBeInstanceOf(KittenTts)
  expect(hub.status()).toMatchObject({
    callModel: 'mock/voice',
    stt: { provider: 'phonon', omp: ['openai/whisper-1'], keySet: false },
    tts: { provider: 'kitten', kitten: { state: 'missing' }, keySet: false },
  })
})

test('any OpenAI-compatible endpoint can be chosen; its key is kept apart, readable only by this user', () => {
  const { hub, home } = setup({
    stt: { provider: 'endpoint', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
    tts: { provider: 'omp', kittenModel: 'nano', voice: 'Leo', speed: 1 },
  })
  hub.setKey('stt', 'gsk-secret')
  expect(hub.stt()).toBeInstanceOf(OpenAiCompatibleStt)
  expect(hub.tts()).toBeInstanceOf(FunctionTts)
  expect(hub.status().stt.keySet).toBe(true)
  const file = join(home, 'voice', 'secrets.json')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ sttKey: 'gsk-secret' })
  hub.setKey('stt', '')
  expect(hub.status().stt.keySet).toBe(false)
})

test('an endpoint without its address says what to set', () => {
  const { hub } = setup({ stt: { provider: 'endpoint' } })
  expect(() => hub.stt()).toThrow('set the speech-to-text endpoint and model in Settings → Voice')
})

test("a call's transcript is saved with its chat when it ends", async () => {
  const { hub } = setup({
    stt: { provider: 'omp' },
    tts: { provider: 'omp', kittenModel: 'nano', voice: 'Leo', speed: 1 },
  })
  const chats = {
    send: async () => ({ chatId: 'c1', colonyId: 'col', started: true }),
    onEvents: () => () => {},
    decideApproval: async () => {},
  }
  // omp's fake speech returns an empty WAV, so speaking fails; the call still hears and records the person.
  const out: string[] = []
  const call = hub.call(chats, { chatId: 'c1', name: 'Robin', sampleRate: 16_000 }, (o) => out.push(o.type))
  const loud = Int16Array.from({ length: 320 }, (_, i) => Math.round(3000 * Math.sin(i / 3)))
  for (let i = 0; i < 25; i++) call.audio(loud)
  for (let i = 0; i < 50; i++) call.audio(new Int16Array(320))
  const end = Date.now() + 2000
  while (!call.transcript().some((t) => t.who === 'person') && Date.now() < end) await Bun.sleep(5)
  call.hangUp()
  expect(out.at(-1)).toBe('ended')
  const saved = hub.calls('c1')
  expect(saved).toHaveLength(1)
  expect(saved[0]?.turns[0]).toMatchObject({ who: 'person', text: 'from omp' })
  expect(hub.calls('other')).toEqual([])
  // The next message in the chat carries the transcript to the crew, once.
  const untold = hub.untold('c1')
  expect(untold?.context).toContain('Person: from omp')
  untold?.tell()
  expect(hub.untold('c1')).toBeUndefined()
  expect(hub.calls('c1')[0]?.told).toBe(true)
})

test('voice calls start off: nothing is downloaded or started, and no call can begin', async () => {
  const { hub } = setup({ enabled: false })
  await hub.warm()
  expect(hub.vad.ready).toBe(false)
  expect(hub.status()).toMatchObject({ enabled: false, tts: { kitten: { state: 'missing' } } })
  const chats = {
    send: async () => ({ chatId: 'c', colonyId: 'x', started: true }),
    onEvents: () => () => {},
    decideApproval: async () => {},
  }
  expect(() => hub.call(chats, { name: 'Robin', sampleRate: 16_000 }, () => {})).toThrow(
    'Voice calls are off',
  )
})

test('turning voice on downloads the chosen Kitten model then, and Settings is told each download size', async () => {
  const files: Record<string, string> = {
    'config.json': JSON.stringify({ model_file: 'net.onnx', voices: 'voices.npz' }),
    'net.onnx': 'not really a network',
    'voices.npz': 'voices',
  }
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
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const name = new URL(req.url).pathname.split('/').pop() ?? ''
      return files[name] ? new Response(files[name]) : new Response('no', { status: 404 })
    },
  })
  try {
    const home = mkdtempSync(join(tmpdir(), 'myr-voicehub-'))
    dirs.push(home)
    const voice = { ...new SettingsStore(home).get().voice, enabled: true, stt: { provider: 'omp' as const } }
    const kitten = new KittenTts(
      home,
      () => ({ model: 'nano', voice: 'Leo', speed: 1 }),
      undefined,
      `http://127.0.0.1:${server.port}`,
      { nano: pin, micro: pin, mini: pin },
    )
    const offline = `http://127.0.0.1:${server.port}/no-model.onnx`
    const hub = new VoiceHub({
      home,
      resolver: new ModelResolver(),
      settings: () => ({ voice }),
      kitten,
      vad: new SileroVad(home, offline),
      turn: new SmartTurn(home, offline),
    })
    expect(hub.status()).toMatchObject({
      tts: { kitten: { state: 'missing' } },
      vad: { ready: false },
      turn: { ready: false },
      sizes: { kitten: { nano: Buffer.byteLength(Object.values(files).join('')) } },
    })
    // The worker cannot run a fake network; what matters is that the model is fetched now, not at the first sentence.
    await hub.warm()
    expect(kitten.status()).not.toMatchObject({ state: 'missing' })
    expect(existsSync(join(home, 'voice', 'kitten', 'nano', 'net.onnx'))).toBe(true)
    kitten.stop()
  } finally {
    server.stop(true)
  }
})

test('the real pins tell Settings the real sizes', () => {
  const { hub } = setup()
  expect(hub.status().sizes).toEqual({
    phonon: 163_515_201,
    kitten: { nano: 60_046_685, micro: 44_664_345, mini: 81_547_388 },
    vad: 1_289_603,
    turn: 8_679_182,
  })
})

test('one call per chat, a few calls at most, and engines that are not ready refuse a call with a code', () => {
  const { hub } = setup({
    stt: { provider: 'omp' },
    tts: { provider: 'omp', kittenModel: 'nano', voice: 'Leo', speed: 1 },
  })
  const chats = {
    send: async () => ({ chatId: 'c', colonyId: 'x', started: true }),
    onEvents: () => () => {},
    decideApproval: async () => {},
  }
  const refusal = (start: () => unknown) => {
    try {
      start()
    } catch (err) {
      return err instanceof CallRefused ? err.code : 'not refused'
    }
    return 'started'
  }
  const open = (chatId: string) => hub.call(chats, { chatId, name: 'Robin', sampleRate: 16_000 }, () => {})
  const first = open('c1')
  expect(refusal(() => open('c1'))).toBe(4423)
  const more = [open('c2'), open('c3'), open('c4')]
  expect(refusal(() => open('c5'))).toBe(4429)
  first.hangUp()
  expect(refusal(() => open('c1'))).toBe('started')
  for (const c of more) c.hangUp()

  const kitten = setup({ stt: { provider: 'omp' } }).hub
  expect(() => kitten.call(chats, { name: 'Robin', sampleRate: 16_000 }, () => {})).toThrow(
    'the Kitten TTS model is still downloading',
  )
})

test('transcripts go with their chat, a call that made no chat is not kept, and old ones are dropped', async () => {
  const { hub, home } = setup({
    stt: { provider: 'omp' },
    tts: { provider: 'omp', kittenModel: 'nano', voice: 'Leo', speed: 1 },
  })
  const chats = {
    send: async () => ({ chatId: 'c1', colonyId: 'col', started: true }),
    onEvents: () => () => {},
    decideApproval: async () => {},
  }
  const loud = Int16Array.from({ length: 320 }, (_, i) => Math.round(3000 * Math.sin(i / 3)))
  const talk = async (chatId?: string) => {
    const call = hub.call(
      chats,
      { ...(chatId ? { chatId } : {}), name: 'Robin', sampleRate: 16_000 },
      () => {},
    )
    for (let i = 0; i < 25; i++) call.audio(loud)
    for (let i = 0; i < 50; i++) call.audio(new Int16Array(320))
    const end = Date.now() + 2000
    while (!call.transcript().some((t) => t.who === 'person') && Date.now() < end) await Bun.sleep(5)
    return call
  }
  // Heard, but it started no work, so no chat: nothing is kept.
  ;(await talk()).hangUp()
  const dir = join(home, 'calls')
  expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  ;(await talk('c1')).hangUp()
  expect(hub.calls('c1')).toHaveLength(1)
  // A call still going in a deleted chat ends, and nothing of the chat's is left.
  await talk('c1')
  hub.forget('c1')
  expect(hub.calls('c1')).toEqual([])
  expect(readdirSync(dir)).toEqual([])

  const old = {
    id: 'old',
    chatId: 'c2',
    startedAt: '2020-01-01T00:00:00.000Z',
    endedAt: '2020-01-01T00:01:00.000Z',
  }
  writeFileSync(join(dir, 'old.json'), JSON.stringify({ ...old, turns: [], rounds: [] }))
  const later = new VoiceHub({
    home,
    resolver: new ModelResolver(),
    settings: () => ({ voice: new SettingsStore(home).get().voice }),
  })
  expect(later.calls('c2')).toEqual([])
  expect(later.status().transcriptDays).toBe(30)
})

test('a running gateway drops old transcripts, and telling the crew never brings back a deleted one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-voicehub-'))
  dirs.push(home)
  const dir = join(home, 'calls')
  mkdirSync(dir, { recursive: true })
  const write = (id: string, chatId: string, endedAt: string) =>
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        id,
        chatId,
        startedAt: endedAt,
        endedAt,
        turns: [{ at: endedAt, who: 'person', text: 'hi' }],
        rounds: [],
      }),
    )
  const hub = new VoiceHub({
    home,
    resolver: new ModelResolver(),
    settings: () => ({ voice: new SettingsStore(home).get().voice }),
    pruneMs: 20,
  })
  write('fresh', 'c1', new Date().toISOString())
  const untold = hub.untold('c1')
  hub.forget('c1')
  untold?.tell()
  expect(readdirSync(dir)).toEqual([])
  // Aged past the limit while the gateway was up.
  write('aged', 'c2', '2020-01-01T00:00:00.000Z')
  await Bun.sleep(60)
  expect(readdirSync(dir)).toEqual([])
})

test("a channel's voice note is read by the chosen speech to text while voice is on, as the file it came in", async () => {
  const got: { type?: string; name?: string }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const file = (await req.formData()).get('file') as File
      got.push({ type: file.type, name: file.name })
      return Response.json({ text: ' remind me at five ' })
    },
  })
  try {
    const stt = { provider: 'endpoint' as const, baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'm' }
    const on = setup({ stt })
    const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53])
    expect(await on.hub.transcribeFile(ogg, 'audio/ogg', 'voice-9.ogg')).toBe('remind me at five')
    expect(got).toEqual([{ type: 'audio/ogg', name: 'voice-9.ogg' }])
    // Voice off: the hub does not take it (the gateway falls back to omp's cloud models).
    expect(await setup({ enabled: false, stt }).hub.transcribeFile(ogg, 'audio/ogg', 'v.ogg')).toBeUndefined()
  } finally {
    server.stop(true)
  }
})
