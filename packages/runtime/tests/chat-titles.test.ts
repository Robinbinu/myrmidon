import { expect, test } from 'bun:test'
import { parseTitle } from '../src/chat-titles.ts'

test("a model's chat name is cleaned up, and a non-answer is no name", () => {
  expect(parseTitle('{"title": "Weekly sales summary"}')).toBe('Weekly sales summary')
  expect(parseTitle('Sure! {"title": "\\"Fix login redirect.\\""}')).toBe('Fix login redirect')
  expect(parseTitle('{"title": null}')).toBeUndefined()
  expect(parseTitle('{"title": "Chat"}')).toBeUndefined()
  expect(parseTitle('{"title": ""}')).toBeUndefined()
  expect(parseTitle('no json here')).toBeUndefined()
  expect(parseTitle(`{"title": "${'x'.repeat(80)}"}`)).toBeUndefined()
})
