import { expect, test } from 'bun:test'
import type { MyrEvent } from '../src/index.ts'
import {
  applyEvent,
  emptyColonyState,
  foldColony,
  hasOpenWork,
  openWork,
  unfinishedCalls,
} from '../src/index.ts'

let seq = 0
const ev = (type: string, payload: Record<string, unknown>) =>
  ({
    id: `e${++seq}`,
    seq,
    colonyId: 'c',
    time: new Date(Date.UTC(2026, 9, 15, 12, 0, seq)).toISOString(),
    type,
    actor: { kind: 'system', id: 'x' },
    trace: { traceId: 't', spanId: 's' },
    schema: 1,
    payload,
  }) as MyrEvent

const created = () =>
  ev('colony/created', {
    name: 'n',
    mission: 'm',
    pattern: 'blackboard',
    agents: [{ name: 'a', role: 'worker', model: 'x/y', tools: [] }],
    budget: { wallMs: 0 },
  })

test('an event delivered twice, or after a later one, changes the state once', () => {
  seq = 0
  const events = [
    created(),
    ev('colony/started', {}),
    ev('tool/call', { agent: 'a', callId: 'c1', tool: 'shell', args: {} }),
    ev('llm/response', {
      agent: 'a',
      model: 'x/y',
      text: '',
      toolCalls: [],
      usage: { totalTokens: 10, cost: 0.5 },
    }),
    ev('chat/user', { text: 'again' }),
  ]
  const once = foldColony('c', events)
  // A subscriber that missed nothing but is handed the same events again (a reconnect, a replay).
  const state = foldColony('c', events)
  for (const e of [events[2], events[3], events[4], events[3]] as MyrEvent[]) applyEvent(state, e)
  expect(state.agents.a?.toolCalls).toBe(1)
  expect(state.agents.a?.tokens).toBe(10)
  expect(state.agents.a?.cost).toBe(0.5)
  expect(state.chatMessages).toHaveLength(1)
  expect(state).toEqual(once)
  // Folding a log that holds the same event twice gives the same state as folding it once.
  expect(foldColony('c', [...events, events[3] as MyrEvent])).toEqual(once)
})

test('open work: tasks under way and undecided approvals, never planned work or the closing task', () => {
  seq = 0
  const task = (id: string, status: string) =>
    ev('task/changed', {
      by: 'a',
      task: { id, revision: 1, subject: id, status, blockedBy: [], artifacts: [] },
    })
  const state = foldColony('c', [
    created(),
    task('task-1', 'verified'),
    task('task-2', 'in_progress'),
    task('task-3', 'deleted'),
    task('task-4', 'pending'),
    task('task-final', 'in_progress'),
    ev('approval/requested', { id: 'ap1', agent: 'a', tool: 'shell', summary: 'ls' }),
    ev('approval/requested', { id: 'ap2', agent: 'a', tool: 'shell', summary: 'pwd' }),
    ev('approval/decided', { id: 'ap2', approved: true, by: 'person' }),
  ])
  const work = openWork(state)
  expect(work.tasks.map((t) => t.id)).toEqual(['task-2'])
  expect(work.approvals.map((a) => a.id)).toEqual(['ap1'])
  expect(hasOpenWork(work)).toBe(true)
  expect(hasOpenWork(openWork(emptyColonyState('c')))).toBe(false)
})

test('unfinished calls are those the latest start began and never answered', () => {
  seq = 0
  const events = [
    created(),
    ev('colony/started', {}),
    ev('tool/call', { agent: 'a', callId: 'old', tool: 'shell', args: { command: 'make' } }),
    ev('colony/stopped', { reason: 'r' }),
    ev('colony/started', { resumed: true }),
    ev('tool/call', { agent: 'a', callId: 'c1', tool: 'shell', args: { command: 'npm publish' } }),
    ev('tool/call', { agent: 'a', callId: 'c2', tool: 'fs_read', args: { path: 'x' } }),
    ev('tool/result', { agent: 'a', callId: 'c2', tool: 'fs_read', ok: true, output: 'x' }),
  ]
  expect(unfinishedCalls(events).map((c) => c.callId)).toEqual(['c1'])
})
