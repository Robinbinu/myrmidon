import { expect, test } from 'bun:test'
import { type AgentStatus, AWAITING_USER, stopCause } from '@myrmidon/protocol'
import { copy } from '../src/client/copy.ts'
import { clock, day, duration, knownCost, money } from '../src/client/ui/hooks.ts'
import { agentPhase, needsYou, runPhase, toneFor } from '../src/client/ui/status.ts'

test('each state has one colour: asking is accent, moving is work, done is green, only failure is red', () => {
  expect(toneFor('awaiting')).toBe('accent')
  expect(toneFor('working')).toBe('work')
  expect(toneFor('running')).toBe('work')
  expect(toneFor('completed')).toBe('ok')
  expect(toneFor('done')).toBe('ok')
  expect(toneFor('failed')).toBe('bad')
  for (const calm of ['stopped', 'idle', 'resting']) expect(toneFor(calm)).toBe('neutral')
})

test("a channel's connection uses the same colours: connected is green, connecting moves, an error is red", () => {
  expect(toneFor('on')).toBe('ok')
  expect(toneFor('connecting')).toBe('work')
  expect(toneFor('linking')).toBe('work')
  expect(toneFor('retrying')).toBe('warn')
  expect(toneFor('error')).toBe('bad')
  expect(toneFor('off')).toBe('neutral')
})

test('a chat that stopped to ask the person waits for them rather than reading as stopped', () => {
  expect(runPhase({ status: 'stopped', awaiting: true })).toBe('awaiting')
  expect(runPhase({ status: 'stopped' })).toBe('stopped')
  expect(runPhase({ status: 'running', awaiting: true })).toBe('working')
  expect(runPhase({ status: 'created' })).toBe('working')
  expect(runPhase({ status: 'completed' })).toBe('completed')
  expect(toneFor(runPhase({ status: 'stopped', awaiting: true }))).toBe('accent')
})

test('only a chat waiting on an answer or approval needs the person, and the window title counts them', () => {
  expect(needsYou({ status: 'stopped', awaiting: true })).toBe(true)
  // Still working, failed or done: the person is not what it waits on.
  expect(needsYou({ status: 'running', awaiting: true })).toBe(false)
  expect(needsYou({ status: 'stopped', awaiting: true, failed: true })).toBe(false)
  expect(needsYou({ status: 'completed' })).toBe(false)
  expect(copy.app.documentTitle(2)).toBe('(2) Myrmidon')
  expect(copy.app.documentTitle(0)).toBe(copy.brand.name)
})

const worker = (status: AgentStatus, detail?: string) => ({
  status,
  ...(detail ? { detail } : {}),
  info: { name: 'rune' },
})

test('an agent stopped by the end of its round is done or resting, without the round status repeated', () => {
  expect(agentPhase(worker('stopped', 'completed'))).toEqual({ phase: 'done' })
  expect(agentPhase(worker('stopped', 'stopped'))).toEqual({ phase: 'resting' })
  expect(agentPhase(worker('stopped', 'failed'))).toEqual({ phase: 'resting' })
  expect(agentPhase(worker('stopped', 'turn limit 40 reached'))).toEqual({
    phase: 'stopped',
    detail: 'turn limit 40 reached',
  })
  expect(agentPhase(worker('working'))).toEqual({ phase: 'working' })
  for (const phase of ['done', 'resting', 'stopped'] as const) expect(copy.status.agent[phase]).toBeTruthy()
})

test('a run a model failure stopped reads as failed, and so does the agent whose model failed', () => {
  const modelError = { agent: 'rune', model: 'm/x', kind: 'error' as const, message: 'boom', time: '' }
  expect(runPhase({ status: 'stopped', failed: true })).toBe('failed')
  expect(toneFor(runPhase({ status: 'stopped', failed: true }))).toBe('bad')
  // The failing agent never reports a status of its own, so it is still "working" when the round ends.
  expect(agentPhase(worker('working'), { modelError })).toEqual({ phase: 'failed' })
  expect(agentPhase({ ...worker('stopped', 'stopped'), info: { name: 'lead' } }, { modelError })).toEqual({
    phase: 'resting',
  })
})

test('a run stopped to wait for the person, or by a model failure, is told apart from an ordinary stop', () => {
  expect(stopCause({ status: 'stopped', statusReason: AWAITING_USER })).toEqual({ awaiting: true })
  expect(
    stopCause({
      status: 'stopped',
      statusReason: 'model failed: lead on m/x',
      modelError: { agent: 'lead', model: 'm/x', kind: 'error', message: 'boom', time: '' },
    }),
  ).toEqual({ failed: true })
  expect(stopCause({ status: 'stopped', statusReason: 'stopped by user' })).toEqual({})
  expect(stopCause({ status: 'running', statusReason: AWAITING_USER })).toEqual({})
})

test('event times read in the local zone, not UTC', () => {
  const local = new Date(2026, 0, 2, 9, 5, 7)
  expect(clock(local.toISOString())).toMatch(/0?9\D05/)
  expect(clock(local.toISOString(), true)).toMatch(/0?9\D05\D07/)
  expect(clock(undefined)).toBe('')
  expect(clock('not a time')).toBe('')
  // Late on 2 January locally is still the 2nd, whatever the UTC date.
  const late = new Date(2026, 0, 2, 23, 30)
  expect(day(late.toISOString())).toBe(
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(late),
  )
  expect(day(late.toISOString(), true)).toContain(day(late.toISOString()))
})

test('long durations read in minutes and an unpriced model costs n/a, not $0', () => {
  expect(duration(1_415_000)).toBe('23m 35s')
  expect(knownCost(0, 12_000)).toBeUndefined()
  expect(knownCost(0, 0)).toBe(0)
  expect(money(undefined, 10)).toBe(copy.unknownCost)
  expect(money(0, 12_000)).toBe(copy.unknownCost)
  expect(money(0.0421, 12_000)).toBe('$0.042')
})
