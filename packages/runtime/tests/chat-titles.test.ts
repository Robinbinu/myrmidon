import { expect, test } from 'bun:test'
import { parseTitle, titleModel } from '../src/chat-titles.ts'

test("a model's chat name is cleaned up, and a non-answer is no name", () => {
  expect(parseTitle('{"title": "Weekly sales summary"}')).toBe('Weekly sales summary')
  expect(parseTitle('Sure! {"title": "\\"Fix login redirect.\\""}')).toBe('Fix login redirect')
  expect(parseTitle('{"title": null}')).toBeUndefined()
  expect(parseTitle('{"title": "Chat"}')).toBeUndefined()
  expect(parseTitle('{"title": ""}')).toBeUndefined()
  expect(parseTitle('no json here')).toBeUndefined()
  expect(parseTitle(`{"title": "${'x'.repeat(80)}"}`)).toBeUndefined()
})

test('chats are named on the cheapest model that fits, by price, else by a fast tier, else the lead', () => {
  const m = (provider: string, id: string, inputPrice?: number, contextWindow?: number | null) => ({
    provider,
    id,
    ...(inputPrice !== undefined ? { inputPrice } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  })
  const lead = 'anthropic/claude-opus-4-5'
  // The lowest known input price wins, across providers.
  expect(
    titleModel(
      [
        m('anthropic', 'claude-opus-4-5', 5),
        m('anthropic', 'claude-haiku-4-5', 1),
        m('openai', 'gpt-5-nano', 0.05),
      ],
      lead,
    ),
  ).toBe('openai/gpt-5-nano')
  // Too small a window is left out; an unknown window is not. A price of 0 counts as unknown.
  expect(
    titleModel(
      [m('x', 'tiny', 0.01, 4_096), m('x', 'local-free', 0), m('anthropic', 'claude-haiku-4-5', 1)],
      lead,
    ),
  ).toBe('anthropic/claude-haiku-4-5')
  // The same price: the lead's provider first.
  expect(titleModel([m('openai', 'gpt-4o-mini', 0.15), m('anthropic', 'claude-x', 0.15)], lead)).toBe(
    'anthropic/claude-x',
  )
  // No prices at all: the best fast tier by the words of its id ("gemini" is not "mini"), the lead's provider first.
  expect(
    titleModel(
      [m('google', 'gemini-2.5-pro'), m('openai', 'gpt-4o-mini'), m('anthropic', 'claude-haiku-4-5')],
      lead,
    ),
  ).toBe('anthropic/claude-haiku-4-5')
  expect(titleModel([m('google', 'gemini-2.5-pro'), m('openai', 'gpt-4o-mini')], lead)).toBe(
    'openai/gpt-4o-mini',
  )
  // Nothing priced and nothing fast: the lead names it.
  expect(titleModel([m('google', 'gemini-2.5-pro')], lead)).toBe(lead)
  expect(titleModel([], lead)).toBe(lead)
})
