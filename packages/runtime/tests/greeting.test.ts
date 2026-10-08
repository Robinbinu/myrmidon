import { expect, test } from 'bun:test'
import { createMockModel } from '@oh-my-pi/pi-ai/providers/mock'
import {
  type GreetingFacts,
  GreetingWriter,
  ModelResolver,
  parseGreeting,
  ruleGreeting,
} from '../src/index.ts'

const at = (iso: string) => new Date(iso)
const chat = (id: string, title: string, status: string, updatedAt: string, awaiting = false) => ({
  chatId: id,
  title,
  status: status as never,
  updatedAt,
  ...(awaiting ? { awaiting } : {}),
})

const base: GreetingFacts = {
  name: 'Robin',
  // A Wednesday evening.
  now: at('2026-10-07T19:30:00'),
  lastSeen: at('2026-10-07T12:00:00'),
  chats: [],
}

test('the greeting leads with what matters most, in one line', () => {
  const chats = [
    chat('a', 'portfolio site', 'completed', '2026-10-07T15:00:00'),
    chat('b', 'SSL research', 'failed', '2026-10-07T16:00:00'),
    chat('c', 'pricing table', 'running', '2026-10-07T18:00:00', true),
  ]
  expect(ruleGreeting({ ...base, chats }).headline).toBe('Robin, I have a question for you.')
  expect(ruleGreeting({ ...base, chats: chats.slice(0, 2) }).headline).toBe(
    'Robin, your last run hit a snag.',
  )
  expect(ruleGreeting({ ...base, chats: chats.slice(0, 1) }).headline).toBe('Your last run is done, Robin.')
  // A title is the person's first message; the line never repeats it, however short or long.
  for (const title of ['Hi', 'Add a multiply(a, b) function to calc.py and test it'])
    expect(
      ruleGreeting({ ...base, chats: [chat('d', title, 'completed', '2026-10-07T15:00:00')] }).headline,
    ).not.toContain(title)
  // Done before the person last looked is not news.
  const old = [chat('a', 'portfolio site', 'completed', '2026-10-07T09:00:00')]
  expect(ruleGreeting({ ...base, chats: old }).headline).toBe('Welcome back, Robin.')
  expect(ruleGreeting({ ...base, chats: [], lastSeen: undefined }).headline).toBe("Hi Robin, I'm your lead.")
  for (const c of [chats, chats.slice(0, 2), chats.slice(0, 1), old])
    expect(ruleGreeting({ ...base, chats: c }).headline.length).toBeLessThanOrEqual(48)
})

test('with no news, the greeting plays on the time and the day', () => {
  const quiet = { ...base, lastSeen: at('2026-10-07T19:20:00') }
  expect(ruleGreeting(quiet).headline).toBe('Good evening, Robin.')
  expect(ruleGreeting({ ...quiet, now: at('2026-10-05T09:00:00') }).headline).toBe(
    "Monday again, Robin. What's first?",
  )
  expect(ruleGreeting({ ...quiet, now: at('2026-10-07T02:00:00') }).headline).toMatch(/Robin\?$/)
  const away = { ...base, lastSeen: at('2026-10-01T12:00:00') }
  expect(ruleGreeting(away).headline).toMatch(/It's been 6 days, Robin\.|There you are, Robin\./)
})

test("the model's line is checked, written once per change in the facts, and the rules' line stands until then", async () => {
  expect(parseGreeting('Sure: {"headline": "Evening, Robin. All quiet."}')).toEqual({
    headline: 'Evening, Robin. All quiet.',
  })
  expect(() => parseGreeting('{"headline": ""}')).toThrow('unusable')
  expect(() => parseGreeting(`{"headline": "${'x'.repeat(60)}"}`)).toThrow('unusable')

  let calls = 0
  const resolver = new ModelResolver()
  const mock = createMockModel({
    handler: () => {
      calls++
      return { content: ['{"headline": "Evening, Robin. Crew is resting."}'] }
    },
  })
  resolver.register('mock/lead', { model: mock.model, streamFn: mock.stream })
  const writer = new GreetingWriter(resolver)
  expect(writer.written(base, 'mock/lead')).toBeUndefined()
  for (let i = 0; i < 50 && !writer.written(base, 'mock/lead'); i++) await Bun.sleep(10)
  expect(writer.written(base, 'mock/lead')?.headline).toBe('Evening, Robin. Crew is resting.')
  // A minute later nothing has changed, so nothing is asked again.
  expect(writer.written({ ...base, now: at('2026-10-07T19:31:00') }, 'mock/lead')).toBeDefined()
  expect(calls).toBe(1)
})
