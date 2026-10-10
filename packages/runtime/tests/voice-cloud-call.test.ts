import { expect, test } from 'bun:test'
import { ModelResolver } from '../src/models.ts'
import { createMockModel } from '../src/omp/mock.ts'
import { prompts } from '../src/prompts.ts'
import { type CallChats, type CallOutput, CallSession } from '../src/voice/call.ts'
import type { LiveTranscription } from '../src/voice/phonon-stream.ts'
import type { SpeechToText } from '../src/voice/stt.ts'
import type { Speech, TextToSpeech } from '../src/voice/tts.ts'

const RATE = 16_000
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(5)
  }
}
const loud = Int16Array.from({ length: 320 }, (_, i) => Math.round(3000 * Math.sin(i / 3)))
const quiet = new Int16Array(320)
const voiced = (n: number): Speech => ({ pcm: new Int16Array(n).fill(4000), sampleRate: 24_000 })

const chats: CallChats = {
  send: async (_text, chatId) => ({ chatId: chatId ?? 'chat-1', colonyId: 'col-1', started: true }),
  onEvents: () => () => {},
  decideApproval: async () => {},
}

/** A call with the engines given, answering every turn with `answer`. */
function call(engines: {
  stt: SpeechToText
  tts: TextToSpeech
  fallback?: { stt?: SpeechToText; tts?: TextToSpeech }
}) {
  const out: CallOutput[] = []
  const resolver = new ModelResolver()
  const model = createMockModel({ handler: () => ({ content: ['Sure thing.'] }) })
  resolver.register('mock/voice', { model: model.model, streamFn: model.stream })
  const logged: string[] = []
  const session = new CallSession(
    { chats, resolver, ...engines, log: (l) => logged.push(l) },
    { model: 'mock/voice', name: 'Robin', start: 0.5, hold: 0.35, threshold: 400, sampleRate: RATE },
    (o) => out.push(o),
  )
  const say = () => {
    for (let i = 0; i < 25; i++) session.audio(loud)
    for (let i = 0; i < 50; i++) session.audio(quiet)
  }
  const said = () => out.flatMap((o) => (o.type === 'said' ? [o.text] : []))
  const heard = () => out.flatMap((o) => (o.type === 'heard' ? [o.text] : []))
  const errors = () => out.flatMap((o) => (o.type === 'error' ? [o.message] : []))
  return { session, out, say, said, heard, errors, logged }
}

const voice: TextToSpeech = { speak: async () => voiced(240) }

test("a streaming speech to text gives the turn's words from its stream, without a second request", async () => {
  let batch = 0
  const pushed: number[] = []
  const stt: SpeechToText = {
    transcribe: async () => {
      batch += 1
      return 'from the upload'
    },
    listen: (_rate, heard, options): LiveTranscription => {
      expect(options?.hotwords).toEqual([])
      return {
        push: (pcm) => {
          pushed.push(pcm.length)
          heard('what ti')
        },
        close: () => {},
        finish: async () => 'what time is it',
      }
    },
  }
  const c = call({ stt, tts: voice })
  await c.session.start()
  c.say()
  await until(() => c.heard().length === 1)
  expect(c.heard()).toEqual(['what time is it'])
  expect(batch).toBe(0)
  // The turn so far went in when it started (from just before it), then each chunk as it came.
  expect(pushed.length).toBeGreaterThan(1)
  expect(c.out.some((o) => o.type === 'partial' && o.text === 'what ti')).toBe(true)
  c.session.hangUp()
})

test('a stream that fails mid-turn leaves the turn to a batch request', async () => {
  const stt: SpeechToText = {
    transcribe: async () => 'from the upload',
    listen: () => ({
      push: () => {},
      close: () => {},
      finish: () => Promise.reject(new Error('socket dropped')),
    }),
  }
  const c = call({ stt, tts: voice })
  await c.session.start()
  c.say()
  await until(() => c.heard().length === 1)
  expect(c.heard()).toEqual(['from the upload'])
  expect(c.logged.some((l) => l.includes('socket dropped'))).toBe(true)
  c.session.hangUp()
})

test('a cloud speech to text that fails hands the call to the one on this machine, and says so', async () => {
  let cloud = 0
  const stt: SpeechToText = {
    transcribe: async () => {
      cloud += 1
      throw new Error('Deepgram transcription failed (401)')
    },
  }
  const local: SpeechToText = { transcribe: async () => 'call me later' }
  const c = call({ stt, tts: voice, fallback: { stt: local } })
  await c.session.start()
  c.say()
  await until(() => c.heard().length === 1)
  // The turn that failed is heard with the fallback, and the call says why the person may need to repeat.
  expect(c.heard()).toEqual(['call me later'])
  expect(c.errors()).toEqual([prompts.voice.fallback.error('stt', 'Deepgram transcription failed (401)')])
  await until(() => c.said().includes(prompts.voice.fallback.said('stt')))
  // The next turn goes straight to the fallback.
  c.say()
  await until(() => c.heard().length === 2)
  expect(cloud).toBe(1)
  c.session.hangUp()
})

test('a voice that streams plays each piece as it comes, the sentence said once', async () => {
  const tts: TextToSpeech = {
    speak: async () => voiced(1),
    async *stream() {
      // Quiet first (cut), then speech in three pieces.
      yield { pcm: new Int16Array(480), sampleRate: 24_000 }
      yield voiced(2400)
      yield voiced(2400)
      yield voiced(1200)
    },
  }
  const c = call({ stt: { transcribe: async () => '' }, tts })
  await c.session.start()
  const audio = c.out.filter((o) => o.type === 'audio') as Extract<CallOutput, { type: 'audio' }>[]
  expect(audio.map((a) => a.pcm.length)).toEqual([2400, 2400, 1200])
  expect(c.said()).toEqual(["Hi Robin, I'm listening."])
  // "speaking" once for the sentence, not for every piece.
  expect(c.out.filter((o) => o.type === 'state' && o.state === 'speaking')).toHaveLength(1)
  c.session.hangUp()
})

test('a cloud voice that fails before a word was heard goes on with the one on this machine', async () => {
  const tts: TextToSpeech = {
    speak: () => Promise.reject(new Error('ElevenLabs speech failed (500)')),
    // biome-ignore lint/correctness/useYield: a stream that fails before its first piece
    async *stream() {
      throw new Error('ElevenLabs speech failed (500)')
    },
  }
  const spoken: string[] = []
  const local: TextToSpeech = {
    speak: async (text) => {
      spoken.push(text)
      return voiced(240)
    },
  }
  const c = call({ stt: { transcribe: async () => '' }, tts, fallback: { tts: local } })
  await c.session.start()
  expect(c.errors()).toEqual([prompts.voice.fallback.error('tts', 'ElevenLabs speech failed (500)')])
  // The fallback says why, then the greeting itself.
  expect(spoken).toEqual([prompts.voice.fallback.said('tts'), "Hi Robin, I'm listening."])
  c.session.hangUp()
})

test('without an engine to fall back on, a failure shows and the call goes on', async () => {
  let tries = 0
  const stt: SpeechToText = {
    transcribe: async () => {
      tries += 1
      if (tries === 1) throw new Error('AssemblyAI transcription failed (503)')
      return 'second try'
    },
  }
  const c = call({ stt, tts: voice })
  await c.session.start()
  c.say()
  await until(() => c.errors().length === 1)
  expect(c.errors()).toEqual(['AssemblyAI transcription failed (503)'])
  c.say()
  await until(() => c.heard().length === 1)
  expect(c.heard()).toEqual(['second try'])
  c.session.hangUp()
})
