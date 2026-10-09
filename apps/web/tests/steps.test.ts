import { expect, test } from 'bun:test'
import type { MyrEvent } from '@myrmidon/protocol'
import { deriveSteps, editedFiles } from '../src/client/chat/steps.ts'
import { copy } from '../src/client/copy.ts'
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

test('the replay bar names every event type in plain words, not by its log id', () => {
  const restored = ev('checkpoint/restored', { commit: 'abc', undo: 'def', changed: 2 })
  expect(describeEvent(restored)).toBe(copy.events.types['checkpoint/restored'])
  for (const label of Object.values(copy.events.types)) {
    expect(label).not.toContain('/')
    expect(label).not.toMatch(/colony|round|judge|verdict|verifier|observer|helper|worker/i)
  }
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

test('a file an agent edited or wrote shows as a step naming the file, with what changed', () => {
  const edit = ev('tool/call', {
    agent: 'lead',
    callId: 'c1',
    tool: 'fs_edit',
    args: { path: 'calc.py', old: 'return a - b', new: 'return a + b' },
  })
  const write = ev('tool/call', {
    agent: 'nova',
    callId: 'c2',
    tool: 'fs_write',
    args: { path: 'notes/plan.md', content: '# Plan\n' },
  })
  const denied = ev('tool/call', {
    agent: 'lead',
    callId: 'c3',
    tool: 'fs_edit',
    args: { path: 'secret.py', old: 'a', new: 'b' },
  })
  const done = (callId: string, tool: string, ok = true) =>
    ev('tool/result', {
      agent: callId === 'c2' ? 'nova' : 'lead',
      callId,
      tool,
      ok,
      output: ok ? 'ok' : 'denied',
    })
  // Only once it went through: an edit waiting for the person, or denied, has not changed the file.
  expect(deriveSteps([edit, write, denied]).filter((s) => s.kind === 'file')).toEqual([])
  expect(
    deriveSteps([
      edit,
      write,
      denied,
      done('c1', 'fs_edit'),
      done('c2', 'fs_write'),
      done('c3', 'fs_edit', false),
    ]).filter((s) => s.kind === 'file'),
  ).toEqual([
    expect.objectContaining({
      kind: 'file',
      agent: 'lead',
      lead: copy.steps.edited,
      strong: 'calc.py',
      file: 'calc.py',
      change: { before: 'return a - b', after: 'return a + b' },
    }),
    expect.objectContaining({
      kind: 'file',
      agent: 'nova',
      lead: copy.steps.wrote,
      strong: 'notes/plan.md',
      file: 'notes/plan.md',
      change: { after: '# Plan\n' },
    }),
  ])
})

test('the files a round changed are the ones whose edit went through, newest first, each once', () => {
  const call = (callId: string, tool: string, path: string) =>
    ev('tool/call', { agent: 'lead', callId, tool, args: { path } })
  const result = (callId: string, tool: string, ok: boolean) =>
    ev('tool/result', { agent: 'lead', callId, tool, ok, output: ok ? 'ok' : 'ERROR: no match' })
  expect(
    editedFiles([
      call('a', 'fs_edit', 'calc.py'),
      result('a', 'fs_edit', true),
      call('b', 'fs_write', 'README.md'),
      result('b', 'fs_write', true),
      call('c', 'fs_edit', 'nope.py'),
      result('c', 'fs_edit', false),
      call('d', 'fs_read', 'other.py'),
      result('d', 'fs_read', true),
      call('e', 'fs_edit', 'calc.py'),
      result('e', 'fs_edit', true),
    ]),
  ).toEqual(['calc.py', 'README.md'])
})
