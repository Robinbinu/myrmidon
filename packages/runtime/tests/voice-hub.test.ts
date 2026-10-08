import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockModel } from '@oh-my-pi/pi-ai/providers/mock'
import { ModelResolver } from '../src/models.ts'
import { SettingsStore } from '../src/settings.ts'
import { VoiceHub, type VoiceSettings } from '../src/voice/hub.ts'
import { OpenAiCompatibleStt, PhononStt } from '../src/voice/stt.ts'
import { FunctionTts, KittenTts } from '../src/voice/tts.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(voice: Partial<VoiceSettings> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'myr-voicehub-'))
  dirs.push(home)
  const defaults = new SettingsStore(home).get().voice
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
  return { home, hub, defaults }
}

test('voice settings default to the engines on this machine', () => {
  const { hub, defaults } = setup()
  expect(defaults).toEqual({
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
})
