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
  expect(describeEvent(delivered)).not.toContain('PASS')
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
    expect.objectContaining({ agent: 'judge', lead: 'Judge approved', strong: 'score 0.90' }),
  ])
})
