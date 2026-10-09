import { expect, test } from 'bun:test'
import type { MyrEvent } from '../src/index.ts'
import { foldColony } from '../src/index.ts'

let seq = 0
const ev = (type: string, payload: Record<string, unknown>) =>
  ({
    id: `e${++seq}`,
    seq,
    colonyId: 'c',
    time: new Date(Date.UTC(2026, 9, 9, 12, 0, seq)).toISOString(),
    type,
    actor: { kind: 'system', id: 'x' },
    trace: { traceId: 't', spanId: 's' },
    schema: 1,
    payload,
  }) as MyrEvent

test('a message that answers a question card keeps which question and what was picked', () => {
  const question = ev('chat/reply', {
    agent: 'lead',
    text: 'What should I look at?',
    final: false,
    question: true,
    choices: [{ question: 'Which?', options: [{ label: 'Full listing' }, { label: 'Public keys only' }] }],
  })
  const answer = ev('chat/user', {
    text: 'Which? → Full listing',
    answers: { seq: question.seq, picks: [{ picked: ['Full listing'], other: '', skipped: false }] },
  })
  const state = foldColony('c' as never, [question, answer])
  expect(state.chatMessages.at(-1)?.answers).toEqual({
    seq: question.seq,
    picks: [{ picked: ['Full listing'], other: '', skipped: false }],
  })
})
