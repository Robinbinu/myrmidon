import { expect, test } from 'bun:test'
import type { MyrEvent } from '@myrmidon/protocol'
import type { Context as LlmContext } from '@oh-my-pi/pi-ai'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import { ModelResolver } from '../src/models.ts'
import { type CallChats, type CallOutput, CallSession, splitSentences } from '../src/voice/call.ts'
import type { SpeechDetector } from '../src/voice/vad.ts'

const RATE = 16_000
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(5)
  }
}
const tool = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})
const lastText = (ctx: LlmContext) => {
  const m = ctx.messages.at(-1)
  if (!m) return ''
  if (m.role === 'toolResult') return `tool:${m.toolName}`
  return typeof m.content === 'string' ? m.content : ''
}

/** A call with a scripted ear, an instant voice, fake chats and a mock call model answering by `reply`. */
function setup(
  reply: (said: string, ctx: LlmContext) => MockContent[],
  options: { slowVoiceMs?: number; detector?: SpeechDetector } = {},
) {
  const heard: string[] = []
  const out: CallOutput[] = []
  const sent: { text: string; chatId?: string }[] = []
  const decided: [string, string, boolean][] = []
  let listener: ((colonyId: string, events: readonly MyrEvent[]) => void) | undefined
  const chats: CallChats = {
    send: async (text, chatId) => {
      sent.push({ text, ...(chatId ? { chatId } : {}) })
      return { chatId: chatId ?? 'chat-1', colonyId: `col-${sent.length}`, started: true }
    },
    onEvents: (l) => {
      listener = l
      return () => {
        listener = undefined
      }
    },
    decideApproval: async (colonyId, id, approved) => {
      decided.push([colonyId, id, approved])
    },
  }
  const resolver = new ModelResolver()
  const model = createMockModel({ handler: (ctx) => ({ content: reply(lastText(ctx), ctx) }) })
  resolver.register('mock/voice', { model: model.model, streamFn: model.stream })
  const call = new CallSession(
    {
      chats,
      resolver,
      stt: { transcribe: async () => heard.shift() ?? '' },
      ...(options.detector ? { detector: options.detector } : {}),
      tts: {
        speak: async (text) => {
          if (options.slowVoiceMs) await Bun.sleep(options.slowVoiceMs)
          return { pcm: new Int16Array(Math.max(1, text.length) * 16), sampleRate: RATE }
        },
      },
    },
    { model: 'mock/voice', name: 'Robin', start: 0.5, hold: 0.35, threshold: 400, sampleRate: RATE },
    (o) => out.push(o),
  )
  const loud = Int16Array.from({ length: 320 }, (_, i) => Math.round(3000 * Math.sin(i / 3)))
  const quiet = new Int16Array(320)
  /** The person says `text`: half a second of speech, then a second of quiet. */
  const say = (text: string) => {
    heard.push(text)
    for (let i = 0; i < 25; i++) call.audio(loud)
    for (let i = 0; i < 50; i++) call.audio(quiet)
  }
  const events = (colonyId: string, list: { type: string; payload: Record<string, unknown> }[]) =>
    listener?.(colonyId, list as unknown as MyrEvent[])
  const said = () => out.flatMap((o) => (o.type === 'said' ? [o.text] : []))
  return { call, out, sent, decided, say, events, said, model, heard }
}

test('sentences are split as they are written', () => {
  expect(splitSentences('Sure. I can do that! And then')).toEqual({
    sentences: ['Sure.', 'I can do that!'],
    rest: 'And then',
  })
})

test('the call greets, hears a turn and answers it a sentence at a time', async () => {
  const { call, out, say, said } = setup((text) =>
    text === 'how are you' ? ['Doing well. What can I do?'] : [],
  )
  await call.start()
  expect(said()).toEqual(['Hi Robin, I’m listening.'.replace('’', "'")])
  say('how are you')
  await until(() => said().length === 3)
  expect(said().slice(1)).toEqual(['Doing well.', 'What can I do?'])
  expect(out.find((o) => o.type === 'heard')).toEqual({ type: 'heard', text: 'how are you' })
  expect(out.filter((o) => o.type === 'audio')).toHaveLength(3)
  await until(() => out.at(-1)?.type === 'state' && (out.at(-1) as { state: string }).state === 'listening')
  expect(call.transcript().map((t) => [t.who, t.text])).toEqual([
    ['voice', "Hi Robin, I'm listening."],
    ['person', 'how are you'],
    ['voice', 'Doing well.'],
    ['voice', 'What can I do?'],
  ])
  call.hangUp()
  expect(out.at(-1)).toEqual({ type: 'ended', reason: 'hung-up' })
})

test('real work goes to the crew as a round; the call hears back when it is done', async () => {
  const { call, out, sent, say, events, said } = setup((text) => {
    if (text === 'write the weekly report')
      return [tool('start_task', { request: 'Write the weekly report' })]
    if (text === 'tool:start_task') return ['The crew is on it.']
    if (text.startsWith('[Crew update] The crew finished')) return ['The report is ready, three pages.']
    return []
  })
  await call.start()
  say('write the weekly report')
  await until(() => said().includes('The crew is on it.'))
  expect(sent).toEqual([{ text: 'Write the weekly report' }])
  expect(call.chatId).toBe('chat-1')
  expect(out).toContainEqual({ type: 'chat', chatId: 'chat-1' })
  expect(out).toContainEqual({ type: 'task', colonyId: 'col-1', request: 'Write the weekly report' })

  events('col-1', [
    { type: 'chat/reply', payload: { agent: 'lead', text: 'Report written: 3 pages.', final: true } },
    { type: 'colony/completed', payload: {} },
  ])
  await until(() => said().includes('The report is ready, three pages.'))
  const crew = call.transcript().find((t) => t.who === 'crew')
  expect(crew?.text).toContain('Report written: 3 pages.')
  // Rounds the call did not start are not its business.
  events('col-9', [{ type: 'colony/completed', payload: {} }])
  await Bun.sleep(30)
  expect(call.transcript().filter((t) => t.who === 'crew')).toHaveLength(1)
  call.hangUp()
})

test('an approval the crew asks for is put to the person and decided only on their answer', async () => {
  const { call, decided, say, events, said } = setup((text) => {
    if (text === 'clean the build') return [tool('start_task', { request: 'Clean the build folder' })]
    if (text === 'tool:start_task') return ['Starting.']
    if (text.includes('waiting for approval a1')) return ['They want to delete the build folder. Okay?']
    if (text === 'yes go ahead') return [tool('answer_approval', { id: 'a1', approve: true })]
    if (text === 'tool:answer_approval') return ['Done, they can carry on.']
    return []
  })
  await call.start()
  say('clean the build')
  await until(() => said().includes('Starting.'))
  events('col-1', [
    {
      type: 'approval/requested',
      payload: { id: 'a1', agent: 'lead', tool: 'shell', summary: 'rm -rf build' },
    },
  ])
  await until(() => said().includes('Okay?'))
  expect(decided).toEqual([])
  say('yes go ahead')
  await until(() => said().includes('Done, they can carry on.'))
  expect(decided).toEqual([['col-1', 'a1', true]])
  call.hangUp()
})

test('talking over the call agent stops it at once', async () => {
  const { call, out, say, said } = setup(
    (text) =>
      text === 'tell me a long story'
        ? ['Once upon a time. There was a crew. It worked hard. The end.']
        : ['Sure.'],
    { slowVoiceMs: 60 },
  )
  await call.start()
  say('tell me a long story')
  await until(() => said().includes('Once upon a time.'))
  say('stop')
  await until(() => out.some((o) => o.type === 'stop-audio'))
  await until(() => said().at(-1) === 'Sure.')
  expect(said()).not.toContain('The end.')
  call.hangUp()
})

test('saying goodbye ends the call after the goodbye is spoken', async () => {
  const { call, out, say, said } = setup((text) =>
    text === 'bye' ? ['Bye Robin.', tool('end_call', {})] : text === 'tool:end_call' ? [] : [],
  )
  await call.start()
  say('bye')
  await until(() => out.some((o) => o.type === 'ended'))
  expect(said()).toContain('Bye Robin.')
  expect(out.at(-1)).toEqual({ type: 'ended', reason: 'agent' })
})

test('with a speech detector, loud noise is not a turn and quiet speech is', async () => {
  // A stand-in detector: "speech" is a quiet tone at 1000 amplitude, anything else (loud included) is not.
  const detector: SpeechDetector = {
    stream: () => ({
      chance: async (chunk) => {
        const peak = chunk.reduce((m, x) => Math.max(m, Math.abs(x)), 0)
        return peak > 0.02 && peak < 0.05 ? 0.95 : 0.02
      },
    }),
  }
  const { call, say, said, out, heard } = setup((text) => (text === 'hello' ? ['Hi.'] : []), { detector })
  await call.start()
  say('noise')
  await Bun.sleep(100)
  expect(out.some((o) => o.type === 'heard')).toBe(false)
  heard.splice(0, heard.length, 'hello')
  const quiet = Int16Array.from({ length: 320 }, (_, i) => Math.round(1000 * Math.sin(i / 3)))
  for (let i = 0; i < 25; i++) call.audio(quiet)
  for (let i = 0; i < 50; i++) call.audio(new Int16Array(320))
  await until(() => said().includes('Hi.'))
  call.hangUp()
})
