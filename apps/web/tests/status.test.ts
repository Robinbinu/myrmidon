import { expect, test } from 'bun:test'
import { copy } from '../src/client/copy.ts'
import { clock, duration, knownCost, money } from '../src/client/ui/hooks.ts'
import { agentPhase, runPhase, toneFor } from '../src/client/ui/status.ts'

test('each state has one colour: asking is accent, moving is work, done is green, only failure is red', () => {
  expect(toneFor('awaiting')).toBe('accent')
  expect(toneFor('working')).toBe('work')
  expect(toneFor('running')).toBe('work')
  expect(toneFor('completed')).toBe('ok')
  expect(toneFor('done')).toBe('ok')
  expect(toneFor('failed')).toBe('bad')
  for (const calm of ['stopped', 'idle', 'resting']) expect(toneFor(calm)).toBe('neutral')
})

test('a chat that stopped to ask the person waits for them rather than reading as stopped', () => {
  expect(runPhase({ status: 'stopped', awaiting: true })).toBe('awaiting')
  expect(runPhase({ status: 'stopped' })).toBe('stopped')
  expect(runPhase({ status: 'running', awaiting: true })).toBe('working')
  expect(runPhase({ status: 'created' })).toBe('working')
  expect(runPhase({ status: 'completed' })).toBe('completed')
  expect(toneFor(runPhase({ status: 'stopped', awaiting: true }))).toBe('accent')
})

test('an agent stopped by the end of its round is done or resting, without the round status repeated', () => {
  expect(agentPhase({ status: 'stopped', detail: 'completed' })).toEqual({ phase: 'done' })
  expect(agentPhase({ status: 'stopped', detail: 'stopped' })).toEqual({ phase: 'resting' })
  expect(agentPhase({ status: 'stopped', detail: 'failed' })).toEqual({ phase: 'resting' })
  expect(agentPhase({ status: 'stopped', detail: 'turn limit 40 reached' })).toEqual({
    phase: 'stopped',
    detail: 'turn limit 40 reached',
  })
  expect(agentPhase({ status: 'working' })).toEqual({ phase: 'working' })
  for (const phase of ['done', 'resting', 'stopped'] as const) expect(copy.status.agent[phase]).toBeTruthy()
})

test('event times read in the local zone, not UTC', () => {
  const local = new Date(2026, 0, 2, 9, 5, 7)
  expect(clock(local.toISOString())).toMatch(/0?9\D05/)
  expect(clock(local.toISOString(), true)).toMatch(/0?9\D05\D07/)
  expect(clock(undefined)).toBe('')
  expect(clock('not a time')).toBe('')
})

test('long durations read in minutes and an unpriced model costs n/a, not $0', () => {
  expect(duration(1_415_000)).toBe('23m 35s')
  expect(knownCost(0, 12_000)).toBeUndefined()
  expect(knownCost(0, 0)).toBe(0)
  expect(money(undefined, 10)).toBe(copy.unknownCost)
  expect(money(0, 12_000)).toBe(copy.unknownCost)
  expect(money(0.0421, 12_000)).toBe('$0.042')
})
