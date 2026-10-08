import { expect, test } from 'bun:test'
import type { MyrEvent } from '@myrmidon/protocol'
import { deriveSteps } from '../src/client/chat/steps.ts'
import { describeEvent } from '../src/client/describe.ts'

let seq = 0
const ev = (type: string, payload: object) =>
  ({
    id: `e${++seq}`,
    seq,
    type,
    time: `2026-10-06T12:00:0${seq % 10}Z`,
    actor: { kind: 'system', id: 'x' },
    payload,
  }) as unknown as MyrEvent

test('a round nobody reviewed is never shown as approved or verified', () => {
  const delivered = ev('verifier/verdict', {
    target: 'colony',
    verifierId: 'delivered',
    pass: true,
    evidence: 'Final answer delivered; this round is not reviewed.',
  })
  const completed = ev('colony/completed', { verdicts: [delivered.id] })
  expect(deriveSteps([delivered, completed]).filter((s) => s.agent === 'judge')).toEqual([])
  expect(describeEvent(delivered)).not.toMatch(/pass/i)
  expect(describeEvent(completed)).not.toContain('verified')
})

test('a judged round still shows the judge approving it', () => {
  const judged = ev('verifier/verdict', {
    target: 'colony',
    verifierId: 'judge#0',
    pass: true,
    score: 0.9,
    evidence: 'score 0.90 (threshold 0.70): good',
  })
  expect(deriveSteps([judged])).toEqual([
    expect.objectContaining({ agent: 'judge', lead: 'Reviewer approved', strong: 'score 0.90' }),
  ])
})

test('event lines name the final answer and check-ins in plain words, never the runtime ids', () => {
  const verdict = ev('verifier/verdict', {
    target: 'colony',
    verifierId: 'judge#0',
    pass: false,
    evidence: '',
  })
  const signal = ev('observer/signal', {
    kind: 'stall',
    severity: 'warn',
    facts: 'nova idle 5m',
    targets: [],
  })
  const stopped = ev('colony/stopped', { reason: 'time limit' })
  for (const e of [verdict, signal, stopped])
    expect(describeEvent(e)).not.toMatch(/colony|observer|verdict|judge/i)
  expect(describeEvent(verdict)).toContain('the final answer')
  expect(describeEvent(signal)).toContain('stalled')
})

test('a failed hook is named as Settings → Hooks names it, not by its event id', () => {
  const failed = ev('hook/ran', {
    event: 'PreToolUse',
    agent: 'lead',
    tool: 'shell',
    command: 'check.sh',
    code: 1,
    ms: 12,
    outcome: 'failed',
  })
  const [step] = deriveSteps([failed])
  expect(step?.lead).toContain('Before a tool')
  expect(step?.lead).not.toContain('PreToolUse')
})
