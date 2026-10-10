import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockModel } from '@oh-my-pi/pi-ai/providers/mock'
import { VOICE_GREETING_RECENT, VOICE_GREETING_WORDS } from '../src/config.ts'
import { ModelResolver } from '../src/models.ts'
import { prompts } from '../src/prompts.ts'
import { SettingsStore } from '../src/settings.ts'
import { wav } from '../src/voice/audio.ts'
import type { CallOutput } from '../src/voice/call.ts'
import {
  CallGreeter,
  type CallGreetingFacts,
  callGreetingLines,
  fitToSay,
  parseCallGreeting,
  spokenTitle,
} from '../src/voice/greeting.ts'
import { VoiceHub } from '../src/voice/hub.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const at = (iso: string) => new Date(iso)
type Chat = CallGreetingFacts['chats'][number]
const chat = (chatId: string, title: string, status: string, updatedAt: string, more: Partial<Chat> = {}) =>
  ({ chatId, title, status: status as Chat['status'], updatedAt, ...more }) as Chat

const base: CallGreetingFacts = {
  name: 'Robin',
  // A Wednesday evening, an hour after the last call.
  now: at('2026-10-07T19:30:00'),
  lastSeen: at('2026-10-07T18:30:00'),
  chats: [],
}
const g = prompts.voice.greeting
/** Whether every line the rules would say holds one of `phrases`. */
const allSay = (facts: CallGreetingFacts, phrases: readonly string[]) =>
  callGreetingLines(facts).every((l) => phrases.some((p) => l.includes(p)))

test('the greeting reflects the moment: the time, the day, and how long since the last call', () => {
  expect(allSay(base, g.open.evening('Robin'))).toBe(true)
  expect(
    allSay({ ...base, now: at('2026-10-07T08:30:00'), lastSeen: undefined }, g.open.morning('Robin')),
  ).toBe(true)
  expect(
    allSay({ ...base, now: at('2026-10-07T02:00:00'), lastSeen: undefined }, g.open.night('Robin')),
  ).toBe(true)
  expect(allSay({ ...base, now: at('2026-10-09T16:00:00') }, g.open.friday('Robin'))).toBe(true)
  expect(allSay({ ...base, lastSeen: at('2026-10-07T19:25:00') }, g.open.again('Robin'))).toBe(true)
  expect(allSay({ ...base, lastSeen: at('2026-10-01T12:00:00') }, g.open.away('Robin', 6))).toBe(true)
  expect(callGreetingLines({ ...base, lastSeen: at('2026-10-01T12:00:00') })[0]).toContain('6 days')
})

test("in a chat, the greeting leads with that chat's state; elsewhere with what waits, failed, finished or runs", () => {
  const here = (status: string, more: Partial<Chat> = {}) => ({
    ...base,
    chatId: 'c1',
    chats: [chat('c1', 'Planning', status, '2026-10-07T19:00:00', more)],
  })
  expect(allSay(here('running', { approving: true }), g.here.approval)).toBe(true)
  expect(allSay(here('completed', { awaiting: true }), g.here.question)).toBe(true)
  expect(allSay(here('failed'), g.here.failed)).toBe(true)
  // Stopped because a model failed is a failure too.
  expect(allSay(here('stopped', { failed: true }), g.here.failed)).toBe(true)
  expect(allSay(here('running'), g.here.running)).toBe(true)
  expect(allSay(here('completed'), g.here.done)).toBe(true)
  // Done before the last call is not news.
  const old = here('completed')
  expect(
    callGreetingLines({ ...old, lastSeen: at('2026-10-07T19:10:00') }).some((l) => l.includes('done')),
  ).toBe(false)

  // Another chat waiting on the person comes before this chat's finished run.
  const elsewhere = {
    ...here('completed'),
    chats: [
      chat('c1', 'Planning', 'completed', '2026-10-07T19:00:00'),
      chat('c2', 'SSL research', 'running', '2026-10-07T19:10:00', { approving: true }),
    ],
  }
  expect(allSay(elsewhere, g.news.waitingOne('SSL research'))).toBe(true)
  const failed = { ...base, chats: [chat('c3', 'Pricing table', 'failed', '2026-10-07T19:00:00')] }
  expect(allSay(failed, g.news.failedOne('Pricing table'))).toBe(true)
  const many = {
    ...base,
    chats: [
      chat('a', 'One', 'completed', '2026-10-07T19:00:00'),
      chat('b', 'Two', 'completed', '2026-10-07T19:05:00'),
    ],
  }
  expect(allSay(many, g.news.finishedMany(2))).toBe(true)
})

test('a long, odd or slight chat title is never read out; a short one may be', () => {
  expect(spokenTitle('Planning')).toBe('Planning')
  expect(spokenTitle('SSL research.')).toBe('SSL research')
  for (const title of [
    'Add a multiply(a, b) function to calc.py and test it',
    'Fix the flaky login test on CI please',
    'hi',
    'Hello',
    'chat-3f9a2b7c',
    '**bold** idea',
  ])
    expect(spokenTitle(title)).toBeUndefined()
  const long = 'Add a multiply(a, b) function to calc.py and test it'
  const facts = { ...base, chats: [chat('c3', long, 'failed', '2026-10-07T19:00:00')] }
  const lines = callGreetingLines(facts)
  expect(lines.some((l) => l.includes('calc'))).toBe(false)
  expect(allSay(facts, g.news.failedOne())).toBe(true)
})

test('every line is fit to be spoken: short, plain words, the name, and an invitation to talk', () => {
  const many = Array.from({ length: 5 }, (_, i) =>
    chat(`c${i}`, `Chat ${i}`, 'running', '2026-10-07T19:00:00', { awaiting: i < 3 }),
  )
  const variants: CallGreetingFacts[] = [
    base,
    { ...base, chats: many },
    { ...base, chats: many, chatId: 'c4', talkTo: 'lead' },
    { ...base, talkTo: 'ana', lastSeen: at('2026-09-20T10:00:00') },
    {
      ...base,
      now: at('2026-10-10T10:00:00'),
      chatId: 'c1',
      chats: [chat('c1', 'x', 'failed', '2026-10-10T09:00:00')],
    },
  ]
  for (const facts of variants) {
    const lines = callGreetingLines(facts)
    expect(lines.length).toBeGreaterThan(VOICE_GREETING_RECENT)
    for (const line of lines) {
      expect(line.split(/\s+/).length).toBeLessThanOrEqual(VOICE_GREETING_WORDS)
      expect(line).not.toMatch(/[*_#`[\]<>]|\p{Extended_Pictographic}/u)
      expect(line).toContain('Robin')
      expect(g.invite.some((i) => line.endsWith(i))).toBe(true)
    }
  }
  expect(fitToSay('Hi Robin, **all** done.')).toBe(false)
  expect(fitToSay(`Hi Robin, ${'very '.repeat(VOICE_GREETING_WORDS)}good.`)).toBe(false)
  expect(fitToSay('Hi Robin, run 7f3a9c21 is done.')).toBe(false)
  expect(fitToSay('Hi Robin 🎉 all done.')).toBe(false)
})

test('a direct call always says who answers, in varied words', () => {
  const lead = callGreetingLines({ ...base, talkTo: 'lead' })
  expect(lead.every((l) => /\blead\b/.test(l))).toBe(true)
  expect(new Set(lead.map((l) => g.who('lead').find((w) => l.includes(w)))).size).toBe(g.who('lead').length)
  expect(callGreetingLines({ ...base, talkTo: 'ana' }).every((l) => l.includes('ana'))).toBe(true)
})

test('calls in a row never open with a line said within the last few', () => {
  const greeter = new CallGreeter()
  for (const facts of [
    base,
    { ...base, talkTo: 'lead' },
    { ...base, chatId: 'c1', chats: [chat('c1', 'Planning', 'failed', '2026-10-07T19:00:00')] },
  ]) {
    const said = Array.from({ length: 30 }, () => greeter.line(facts))
    said.forEach((line, i) => {
      expect(said.slice(Math.max(0, i - VOICE_GREETING_RECENT), i)).not.toContain(line)
    })
  }
  // Even a picker that always takes the first fresh line rotates.
  const first = new CallGreeter(undefined, () => 0)
  const lines = Array.from({ length: VOICE_GREETING_RECENT + 1 }, () => first.line(base))
  expect(new Set(lines).size).toBe(lines.length)
})

/** A resolver with `mock/writer` answering `reply`, or never answering when `reply` is undefined. */
function writer(reply?: () => string) {
  const resolver = new ModelResolver()
  const calls: string[] = []
  const mock = createMockModel({
    handler: (ctx) => {
      const m = ctx.messages.at(-1)
      calls.push(typeof m?.content === 'string' ? m.content : '')
      return { content: [reply?.() ?? ''] }
    },
  })
  const never = (async () => new Promise(() => {})) as unknown as typeof mock.stream
  resolver.register('mock/writer', { model: mock.model, streamFn: reply ? mock.stream : never })
  return { resolver, calls }
}

test("the model's lines are held to the rules: spoken, with the name and who answers", () => {
  const ok = parseCallGreeting(
    'Sure: {"lines": ["Evening, Robin. The lead here, what do you need?", "Hi **Robin**, lead here.", "Hello lead.", "Hi Robin, the lead here, all quiet. Go ahead."]}',
    { ...base, talkTo: 'lead' },
  )
  expect(ok).toEqual([
    'Evening, Robin. The lead here, what do you need?',
    'Hi Robin, the lead here, all quiet. Go ahead.',
  ])
  expect(() => parseCallGreeting('{"lines": ["Hello."]}', base)).toThrow('no usable')
  expect(() => parseCallGreeting('no json', base)).toThrow('no JSON')
})

test("the greeting never waits on the model: it is ready at once, and a later call may open with the model's line", async () => {
  // A model that never answers.
  const slow = new CallGreeter(writer().resolver)
  const started = performance.now()
  expect(callGreetingLines(base)).toContain(slow.line(base, 'mock/writer'))
  expect(performance.now() - started).toBeLessThan(50)

  // A model that answers: the first call says the rules' line while it writes, a later one says its own.
  const { resolver, calls } = writer(
    () => '{"lines": ["Evening, Robin. Quiet night so far, what can I do?"]}',
  )
  const greeter = new CallGreeter(resolver)
  expect(callGreetingLines(base)).toContain(greeter.line(base, 'mock/writer'))
  const end = Date.now() + 2000
  let line = ''
  while (Date.now() < end) {
    line = greeter.line(base, 'mock/writer')
    if (!callGreetingLines(base).includes(line)) break
    await Bun.sleep(10)
  }
  expect(line).toBe('Evening, Robin. Quiet night so far, what can I do?')
  // Once said, it is not said again on the next call: the rules' phrasings carry on.
  expect(callGreetingLines(base)).toContain(greeter.line(base, 'mock/writer'))
  // Asked once for these facts; it is told a short title, never an id or a long one.
  expect(calls).toHaveLength(1)
  const facts = {
    ...base,
    chats: [
      chat('chat-123456', 'Pricing table', 'failed', '2026-10-07T19:00:00'),
      chat(
        'chat-654321',
        'Add a multiply(a, b) function to calc.py and test it',
        'failed',
        '2026-10-07T19:00:00',
      ),
    ],
  }
  const { resolver: r2, calls: c2 } = writer(() => '{"lines": ["Hi Robin, go ahead."]}')
  new CallGreeter(r2).line(facts, 'mock/writer')
  await Bun.sleep(50)
  expect(c2[0]).toContain('Pricing table')
  expect(c2[0]).not.toContain('chat-')
  expect(c2[0]).not.toContain('calc')
})

/** A hub with a voice that records what it is asked to say. */
function hub(resolver = new ModelResolver()) {
  const home = mkdtempSync(join(tmpdir(), 'myr-voicegreet-'))
  dirs.push(home)
  const spoken: string[] = []
  const model = createMockModel({ handler: () => ({ content: ['Okay.'] }) })
  resolver.register('mock/voice', { model: model.model, streamFn: model.stream })
  const voice = new VoiceHub({
    home,
    resolver,
    settings: () => ({
      voice: {
        ...new SettingsStore(home).get().voice,
        enabled: true,
        stt: { provider: 'omp' },
        tts: { provider: 'omp', kittenModel: 'nano', voice: 'Leo', speed: 1 },
      },
      fallbackModel: 'mock/voice',
    }),
    omp: {
      transcribe: async () => '',
      speak: async (text) => {
        spoken.push(text)
        return { audio: wav(new Int16Array(160), 16_000), mimeType: 'audio/wav' }
      },
      speechModels: () => ({ stt: ['openai/whisper-1'], tts: ['openai/tts-1'] }),
    },
  })
  const chats = {
    send: async () => ({ chatId: 'c1', colonyId: 'col', started: true }),
    onEvents: () => () => {},
    decideApproval: async () => {},
  }
  /** A call that greets, then hangs up; what it said. */
  const call = async (options: Partial<Parameters<VoiceHub['call']>[1]> = {}) => {
    const out: CallOutput[] = []
    const session = voice.call(chats, { name: 'Robin', sampleRate: 16_000, ...options }, (o) => out.push(o))
    await session.start()
    session.hangUp()
    return out.flatMap((o) => (o.type === 'said' ? [o.text] : []))
  }
  return { voice, call, spoken }
}

test('calls through the hub open from the chats, differently each time, and soon after one another "again"', async () => {
  const { call } = hub()
  const failed = [chat('c1', 'Planning', 'failed', new Date().toISOString())]
  const first = await call({ chatId: 'c1', greeting: { chats: failed } })
  expect(first).toHaveLength(1)
  expect(g.here.failed.some((p) => first[0]?.includes(p))).toBe(true)
  const said = [first[0]]
  for (let i = 0; i < 6; i++) {
    const [line] = await call({ chatId: 'c1', greeting: { chats: failed } })
    // The last call ended moments ago.
    expect(g.open.again('Robin').some((o) => line?.startsWith(o))).toBe(true)
    expect(said.slice(-VOICE_GREETING_RECENT)).not.toContain(line)
    said.push(line)
  }
  const [direct] = await call({ talkTo: 'lead' })
  expect(direct).toMatch(/\blead\b/)
})

test('a member calling in hears the plain hello, never the news of the owner’s chats', async () => {
  const { call } = hub()
  const said = await call({
    name: 'there',
    member: { name: 'Sam', channel: 'SMS' },
    greeting: { chats: [chat('c1', 'Planning', 'failed', new Date().toISOString())] },
  })
  expect(said).toEqual([prompts.voice.hello('there')])
})

test('a call greets as fast with a model that never answers as without one', async () => {
  const { resolver } = writer()
  const { call } = hub(resolver)
  const started = performance.now()
  const said = await call({ greeting: { chats: [], model: 'mock/writer' } })
  expect(said).toHaveLength(1)
  expect(performance.now() - started).toBeLessThan(1000)
})
