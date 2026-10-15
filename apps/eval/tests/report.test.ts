import { expect, test } from 'bun:test'
import type { MyrEvent } from '@myrmidon/protocol'
import { compare, type EvalCase, grade, metrics, summarize, type TrialResult } from '../src/report.ts'

let seq = 0
const ev = (type: string, payload: Record<string, unknown>, second = seq): MyrEvent =>
  ({
    colonyId: 'c',
    seq: ++seq,
    id: `e${seq}`,
    time: new Date(Date.UTC(2026, 9, 7, 12, 0, second)).toISOString(),
    type,
    actor: { kind: 'system', id: 'x' },
    trace: { traceId: 't', spanId: 's' },
    schema: 1,
    payload,
  }) as MyrEvent

function run(): MyrEvent[] {
  seq = 0
  return [
    ev('colony/created', { tier: 'solo', team: { mode: 'orchestrated' }, agents: [{ name: 'lead' }] }, 0),
    ev('agent/turn', { agent: 'lead', phase: 'start' }, 1),
    ev('llm/response', { agent: 'lead', usage: { totalTokens: 1000, cost: 0.01 } }, 2),
    ev('agent/turn', { agent: 'lead', phase: 'start' }, 3),
    ev('task/changed', { task: { id: 't1' } }, 4),
    ev('agent/joined', { agent: { name: 'coder' } }, 5),
    ev('tool/call', { agent: 'coder', tool: 'browser_open' }, 6),
    ev('tool/result', { agent: 'coder', tool: 'browser_open', ok: false }, 7),
    ev('llm/response', { agent: 'coder', usage: { totalTokens: 500, cost: 0.02 } }, 8),
    ev('chat/reply', { agent: 'lead', text: 'The heading is Example Domain', final: true }, 9),
    ev('verifier/verdict', { target: 'colony', pass: true, score: 0.9 }, 10),
    ev('colony/completed', { verdicts: [] }, 30),
  ]
}

const CASE: EvalCase = {
  id: 'heading',
  pillar: 'browser',
  prompt: 'p',
  tiers: ['answer', 'solo'],
  budget: { seconds: 60, tokens: 10_000 },
  checks: [
    { kind: 'tool', label: 'browser', used: /^browser_/ },
    { kind: 'reply', label: 'heading', matches: /Example Domain/ },
    { kind: 'artifact', label: 'page', name: /\.html$/, contains: /<canvas/ },
    { kind: 'command', label: 'tests', run: ['true'] },
    { kind: 'judge', label: 'judge' },
  ],
}

test('metrics read time, tokens, cost, agents, planning turns and the verdict from the log', () => {
  const m = metrics(run())
  expect(m).toMatchObject({
    tier: 'solo',
    mode: 'orchestrated',
    outcome: 'completed',
    seconds: 30,
    tokens: 1500,
    toolCalls: 1,
    failedToolCalls: 1,
    agents: 2,
    turnsBeforeFirstTask: 2,
    verificationRounds: 1,
    judge: { pass: true, score: 0.9 },
    finalReply: 'The heading is Example Domain',
  })
  expect(m.costUsd).toBeCloseTo(0.03)
})

test('an escalated request is measured across both rounds, at the tier it finished in', () => {
  seq = 0
  const first = [
    ev('colony/created', { tier: 'answer', agents: [{ name: 'lead' }] }, 0),
    ev('llm/response', { agent: 'lead', usage: { totalTokens: 100 } }, 1),
    ev('colony/escalated', { by: 'lead', to: 'solo', reason: 'needs files' }, 2),
  ]
  // The rerun is the same colony's next round.
  const rerun = run().map((e) =>
    e.type === 'colony/created' ? { ...e, type: 'round/started' } : e,
  ) as MyrEvent[]
  expect(metrics([...first, ...rerun])).toMatchObject({ tier: 'solo', escalated: 'answer → solo' })
  const m = metrics([...first, ...run()])
  expect(m).toMatchObject({ tier: 'solo', escalated: 'answer → solo', outcome: 'completed', tokens: 1600 })
  expect(grade(CASE, { events: [...first, ...run()], artifacts: {}, local: {} }).tierMismatch).toBe(false)
})

test('grading applies each check and flags tier mismatches and budget breaches', () => {
  const view = { events: run(), artifacts: { 'snake.html': '<canvas id=c>' }, local: { tests: true } }
  const g = grade(CASE, view)
  expect(g.checks.every((c) => c.pass)).toBe(true)
  expect(g.pass).toBe(true)
  expect(g.tierMismatch).toBe(false)
  expect(g.budgetBreach).toBeUndefined()

  const strict = grade(
    { ...CASE, tiers: ['answer'], budget: { seconds: 10, tokens: 10_000 } },
    { ...view, local: {} },
  )
  expect(strict.pass).toBe(false)
  expect(strict.checks.find((c) => c.label === 'tests')?.pass).toBe(false)
  expect(strict.tierMismatch).toBe(true)
  expect(strict.budgetBreach).toBe('30s > 10s')
})

test('summaries give pass@k, pass^k and medians, and compare shows the change', () => {
  const trial = (n: number, pass: boolean, seconds: number): TrialResult => ({
    case: 'heading',
    mode: 'orchestrated',
    trial: n,
    metrics: { ...metrics(run()), seconds, tokens: 1000 * n },
    grade: { checks: [], pass, tierMismatch: false },
  })
  const [s] = summarize([trial(1, true, 10), trial(2, false, 20), trial(3, true, 40)])
  expect(s).toMatchObject({
    trials: 3,
    passAtK: true,
    passHatK: false,
    medianSeconds: 20,
    medianTokens: 2000,
  })
  expect(s?.passRate).toBeCloseTo(2 / 3)
  const [after] = summarize([trial(1, true, 10), trial(2, true, 10)])
  expect(compare(s ? [s] : [], after ? [after] : [])).toEqual([
    'heading [orchestrated]  pass 67% → 100%, 20s → 10s (-50%), 2000 → 1500 tok (-25%), 1 → 1 tools, regressions 0% → 0%, untested edits 0 → 0, failed calls 3 → 2',
  ])
})

test('a failed regression check counts toward the regression rate, and cost sums over the trials', () => {
  const trial = (n: number, regressed: boolean): TrialResult => ({
    case: 'dirty',
    mode: 'orchestrated',
    trial: n,
    metrics: metrics(run()),
    grade: {
      checks: [
        { label: 'tests pass', pass: true },
        { label: 'your edits kept', pass: !regressed, regression: true },
      ],
      pass: !regressed,
      tierMismatch: false,
    },
  })
  const [s] = summarize([trial(1, true), trial(2, false), trial(3, false), trial(4, false)])
  expect(s?.regressionRate).toBe(0.25)
  expect(s?.costUsd).toBeCloseTo(0.12)
  const g = grade(
    { ...CASE, checks: [{ kind: 'unchanged', label: 'kept', file: 'a.ts', regression: true }] },
    { events: run(), artifacts: {}, local: { kept: false } },
  )
  expect(g.checks).toEqual([{ label: 'kept', pass: false, regression: true }])
})

test('an edit counts as tested only when a test run that went through follows it', () => {
  seq = 0
  const call = (id: string, tool: string, args: Record<string, unknown>) =>
    ev('tool/call', { agent: 'lead', callId: id, tool, args })
  const result = (id: string, tool: string, ok: boolean) =>
    ev('tool/result', { agent: 'lead', callId: id, tool, ok, output: '' })
  // Each step makes fresh events, so a log's order is its seq order, as in a real one.
  const edit = () => [call('e', 'fs_edit', { path: 'a.ts' }), result('e', 'fs_edit', true)]
  const shellTest = () => [call('t', 'shell', { command: 'bun test 2>&1' }), result('t', 'shell', true)]
  const checks = (ok: boolean) => [call('c', 'run_checks', {}), result('c', 'run_checks', ok)]
  expect(metrics([call('r', 'fs_read', {}), result('r', 'fs_read', true)]).testedAfterEdit).toBeUndefined()
  expect(metrics(edit()).testedAfterEdit).toBe(false)
  // A one-off script is not the project's tests; a test run before the edit does not cover it.
  const script = () => [call('s', 'shell', { command: 'bun -e "f()"' }), result('s', 'shell', true)]
  expect(metrics([...edit(), ...script()]).testedAfterEdit).toBe(false)
  expect(metrics([...shellTest(), ...edit()]).testedAfterEdit).toBe(false)
  expect(metrics([...edit(), ...shellTest()]).testedAfterEdit).toBe(true)
  // run_checks with no checks to run fails, and tests nothing.
  expect(metrics([...edit(), ...checks(false)]).testedAfterEdit).toBe(false)
  expect(metrics([...edit(), ...checks(true)]).testedAfterEdit).toBe(true)
})
