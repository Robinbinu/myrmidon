import { expect, test } from 'bun:test'
import type { MyrEvent } from '@myrmidon/protocol'
import { MEMORY_CASES } from '../src/memory-cases.ts'

const call = (tool: string, args: unknown) =>
  ({ type: 'tool/call', payload: { tool, args } }) as unknown as MyrEvent
const result = (output: string) =>
  ({ type: 'tool/result', payload: { tool: 'search_chats', output } }) as unknown as MyrEvent
const grade = (id: string, view: { events: MyrEvent[]; reply?: string; files?: Record<string, string> }) =>
  (MEMORY_CASES.find((c) => c.id === id)?.checks ?? []).map((c) =>
    c.pass({ events: view.events, reply: view.reply ?? '', files: (n) => view.files?.[n] }),
  )

test('the stale-command case passes the repo command and fails the remembered one', () => {
  expect(
    grade('memory-stale-command', { events: [call('shell', { command: 'bun test' })], reply: 'All pass.' }),
  ).toEqual([true, true, true])
  expect(
    grade('memory-stale-command', { events: [call('shell', { command: 'npm test' })], reply: 'pass' })[1],
  ).toBe(false)
})

test("the leak case fails when another project's codeword reaches the reply or a search result", () => {
  expect(grade('memory-no-leak', { events: [], reply: 'No such chat here.' })).toEqual([true])
  expect(grade('memory-no-leak', { events: [result('codeword PELICAN-42')], reply: 'not found' })).toEqual([
    false,
  ])
  expect(grade('memory-no-leak', { events: [], reply: 'It was PELICAN-42' })).toEqual([false])
})

test('the follow-up case wants a past-chat search, no question, and the extended file', () => {
  const events = [call('search_chats', { query: 'HERON' })]
  expect(grade('memory-follow-up', { events, files: { 'src/slug.ts': "t.normalize('NFD')" } })).toEqual([
    true,
    true,
    true,
  ])
  expect(grade('memory-follow-up', { events: [call('ask_user', {})] })).toEqual([false, false, false])
})
