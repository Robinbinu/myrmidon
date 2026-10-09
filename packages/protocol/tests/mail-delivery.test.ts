import { expect, test } from 'bun:test'
import type { MyrEvent } from '../src/index.ts'
import { foldColony, linesOf, unreadMailFor } from '../src/index.ts'

let seq = 0
const ev = (type: string, payload: Record<string, unknown>) =>
  ({
    id: `e${++seq}`,
    seq,
    colonyId: 'c',
    time: new Date(Date.UTC(2026, 9, 9, 11, 0, seq)).toISOString(),
    type,
    actor: { kind: 'system', id: 'x' },
    trace: { traceId: 't', spanId: 's' },
    schema: 1,
    payload,
  }) as MyrEvent

const group = (from: string, body: string) =>
  ev('mail/sent', { from, to: 'game', subject: '', body, members: ['lead', 'bix', 'zephyr'] })

test('a group message is read by each member on their own, and counts as read once everyone has it', () => {
  const sent = group('lead', "It's a book!")
  const state = foldColony('c' as never, [sent, ev('mail/delivered', { mail: sent.id, to: 'bix' })])
  const mail = state.mail[0]
  expect(mail?.readBy).toEqual(['bix'])
  // One member reading it is not the group reading it.
  expect(mail?.delivered).toBe(false)
  expect(linesOf(state, 'group:game')[0]?.read).toBe(false)
  expect(unreadMailFor(state, 'zephyr').map((m) => m.body)).toEqual(["It's a book!"])
  expect(unreadMailFor(state, 'bix')).toEqual([])
  // The sender never has its own message waiting for it.
  expect(unreadMailFor(state, 'lead')).toEqual([])

  const all = foldColony('c' as never, [
    sent,
    ev('mail/delivered', { mail: sent.id, to: 'bix' }),
    ev('mail/delivered', { mail: sent.id, to: 'zephyr' }),
  ])
  expect(all.mail[0]?.delivered).toBe(true)
  expect(linesOf(all, 'group:game')[0]?.read).toBe(true)
  expect(unreadMailFor(all, 'zephyr')).toEqual([])
})

test('a one-to-one message waits for its one reader, oldest first among the unread', () => {
  const a = ev('mail/sent', { from: 'lead', to: 'zephyr', subject: '', body: 'first' })
  const b = group('bix', 'second')
  const c = ev('mail/sent', { from: 'zephyr', to: 'lead', subject: '', body: 'not for zephyr' })
  const state = foldColony('c' as never, [a, b, c])
  expect(unreadMailFor(state, 'zephyr').map((m) => m.body)).toEqual(['first', 'second'])
  expect(state.mail[0]?.delivered).toBe(false)
  const read = foldColony('c' as never, [a, b, c, ev('mail/delivered', { mail: a.id, to: 'zephyr' })])
  expect(read.mail[0]?.delivered).toBe(true)
  expect(unreadMailFor(read, 'zephyr').map((m) => m.body)).toEqual(['second'])
})
