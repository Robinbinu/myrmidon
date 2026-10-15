import type { MyrEvent } from '@myrmidon/protocol'

export type Tier = 'answer' | 'solo' | 'team'
export type Mode = 'orchestrated' | 'swarm'

/**
 * A code-based check on one trial. The colony's own judge is the model-based grader (`judge`). A `regression`
 * check guards something the request never asked to change (unrelated files, the person's uncommitted edits, the
 * rest of the suite): its failures count toward the regression rate as well as failing the trial.
 */
export type Check = (
  | { kind: 'reply'; label: string; matches: RegExp }
  | { kind: 'artifact'; label: string; name: RegExp; contains?: RegExp }
  | { kind: 'tool'; label: string; used: RegExp }
  /** Some event of a matching type is in the round's log. */
  | { kind: 'event'; label: string; type: RegExp }
  /** A command run in the case's project folder after the round; exit code 0 passes. */
  | { kind: 'command'; label: string; run: string[] }
  /** A project file must still hold exactly its fixture content (the agent must not "fix" the test). */
  | { kind: 'unchanged'; label: string; file: string }
  | { kind: 'judge'; label: string }
) & { regression?: boolean }

export interface EvalCase {
  id: string
  pillar: 'answer' | 'coding' | 'browser' | 'research' | 'build'
  prompt: string
  /** Tiers the round may end up at (solo, or team after the lead escalates); anything else is a mismatch. */
  tiers: Tier[]
  modes?: Mode[]
  /** Breaching either fails the run. Tokens count cached input, like the run card. */
  budget: { seconds: number; tokens: number }
  /** Fixture files written to a fresh folder that becomes the chat's project. */
  project?: Record<string, string>
  /** Make the project a git repository with the fixture committed (team rounds then give workers worktrees). */
  git?: boolean
  /**
   * Files written after the fixture commit: the person's uncommitted work in progress. An `unchanged` check on one
   * of them compares against this content.
   */
  dirty?: Record<string, string>
  /** Messages sent in the same chat, each after the previous round ended: a task continued with its history. */
  followUps?: string[]
  /**
   * A local website served for the trial (deterministic, unlike the live web); `{url}` in the prompt becomes its
   * address.
   */
  site?: (request: Request) => Response
  checks: Check[]
}

/** What a trial produced, gathered by the runner. */
export interface TrialView {
  events: MyrEvent[]
  /** Latest version of each published artifact, as text. */
  artifacts: Record<string, string>
  /** Results of `command` and `unchanged` checks, by label. */
  local: Record<string, boolean>
}

export interface Metrics {
  /** The tier the request finished at (after any escalation). */
  tier?: Tier
  /** Tiers the request went through when its round escalated, e.g. `answer → solo`. */
  escalated?: string
  mode?: Mode
  outcome: string
  seconds: number
  tokens: number
  costUsd?: number
  toolCalls: number
  failedToolCalls: number
  agents: number
  /** Agent turns started before the first task existed; high numbers mean slow planning. */
  turnsBeforeFirstTask?: number
  verificationRounds: number
  /**
   * For a trial that edited files: whether a test run that went through came after its last edit (run_checks, or a
   * shell test command that exited 0). False means the agent finished on an edit it never tested.
   */
  testedAfterEdit?: boolean
  judge?: { pass: boolean; score?: number }
  finalReply?: string
}

type Payload = Record<string, unknown>
const payload = (e: MyrEvent) => e.payload as Payload

const EDIT_TOOLS = new Set(['fs_edit', 'fs_write', 'ast_edit'])
/** A shell command that runs a test suite, in the runners the fixtures and most projects use. */
const TEST_COMMAND =
  /\b(bun|npm|pnpm|yarn|npx|bunx)\s+(run\s+)?test\b|\bpytest\b|\bvitest\b|\bjest\b|\b(cargo|go)\s+test\b/

/** Whether a test run that went through came after the last edit; undefined when nothing was edited. */
function testedAfterEdit(events: readonly MyrEvent[]): boolean | undefined {
  const calls = events.filter((e) => e.type === 'tool/call')
  const lastEdit = calls.findLast((e) => EDIT_TOOLS.has(String(payload(e).tool)))
  if (!lastEdit) return undefined
  const tests = new Set(
    calls
      .filter((e) => e.seq > lastEdit.seq)
      .filter((e) => {
        const p = payload(e)
        if (p.tool === 'run_checks') return true
        const command = (p.args as { command?: unknown } | undefined)?.command
        return p.tool === 'shell' && typeof command === 'string' && TEST_COMMAND.test(command)
      })
      .map((e) => payload(e).callId),
  )
  // The run counts when it went through: run_checks found checks, the shell ran (a failing suite still exits).
  return events.some(
    (e) => e.type === 'tool/result' && tests.has(payload(e).callId) && payload(e).ok !== false,
  )
}

export function metrics(events: readonly MyrEvent[]): Metrics {
  const of = (type: string) => events.filter((e) => e.type === type)
  // A chat's later rounds (an escalation's rerun among them) start with round/started in the same colony.
  const rounds = events.filter((e) => e.type === 'colony/created' || e.type === 'round/started').map(payload)
  const created = rounds.at(-1) ?? {}
  const end = events.findLast((e) => ['colony/completed', 'colony/stopped', 'colony/failed'].includes(e.type))
  const start = events[0]
  const responses = of('llm/response').map(
    (e) => payload(e).usage as { totalTokens?: number; cost?: number } | undefined,
  )
  const costKnown = responses.every((u) => u?.cost !== undefined)
  const results = of('tool/result')
  const firstTask = events.find((e) => e.type === 'task/changed')
  const turnStarts = of('agent/turn').filter((e) => payload(e).phase === 'start')
  const colonyVerdicts = of('verifier/verdict').filter((e) => payload(e).target === 'colony')
  const lastVerdict = colonyVerdicts.at(-1)
  const replies = of('chat/reply').map(payload)
  const final = replies.filter((r) => r.final).at(-1) ?? replies.at(-1)
  const team = created.team as { mode?: Mode } | undefined
  const tested = testedAfterEdit(events)
  return {
    ...(created.tier ? { tier: created.tier as Tier } : {}),
    ...(rounds.length > 1 ? { escalated: rounds.map((r) => String(r.tier)).join(' → ') } : {}),
    ...(team?.mode ? { mode: team.mode } : {}),
    outcome: !end
      ? 'unfinished'
      : end.type === 'colony/completed'
        ? 'completed'
        : `${end.type === 'colony/failed' ? 'failed' : 'stopped'}: ${String(payload(end).reason ?? '')}`,
    seconds: start
      ? Math.round((Date.parse((end ?? events.at(-1) ?? start).time) - Date.parse(start.time)) / 1000)
      : 0,
    tokens: responses.reduce((n, u) => n + (u?.totalTokens ?? 0), 0),
    ...(costKnown && responses.length ? { costUsd: responses.reduce((n, u) => n + (u?.cost ?? 0), 0) } : {}),
    toolCalls: of('tool/call').length,
    failedToolCalls: results.filter((e) => payload(e).ok === false).length,
    agents: ((created.agents as unknown[] | undefined)?.length ?? 0) + of('agent/joined').length,
    ...(firstTask ? { turnsBeforeFirstTask: turnStarts.filter((e) => e.seq < firstTask.seq).length } : {}),
    verificationRounds: colonyVerdicts.length,
    ...(tested === undefined ? {} : { testedAfterEdit: tested }),
    ...(lastVerdict
      ? {
          judge: {
            pass: payload(lastVerdict).pass === true,
            ...(typeof payload(lastVerdict).score === 'number'
              ? { score: payload(lastVerdict).score as number }
              : {}),
          },
        }
      : {}),
    ...(typeof final?.text === 'string' ? { finalReply: final.text } : {}),
  }
}

export interface CheckResult {
  label: string
  pass: boolean
  regression?: boolean
}

export interface Grade {
  checks: CheckResult[]
  /** Every check passed and the round completed. */
  pass: boolean
  /** Hard failures: the harness itself misbehaved, independent of answer quality. */
  tierMismatch: boolean
  budgetBreach?: string
}

export function grade(c: EvalCase, view: TrialView, m: Metrics = metrics(view.events)): Grade {
  const tools = view.events.filter((e) => e.type === 'tool/call').map((e) => String(payload(e).tool))
  const passes = (check: Check): boolean => {
    switch (check.kind) {
      case 'reply':
        return check.matches.test(m.finalReply ?? '')
      case 'artifact':
        return Object.entries(view.artifacts).some(
          ([name, text]) => check.name.test(name) && (!check.contains || check.contains.test(text)),
        )
      case 'tool':
        return tools.some((t) => check.used.test(t))
      case 'event':
        return view.events.some((e) => check.type.test(e.type))
      case 'command':
      case 'unchanged':
        return view.local[check.label] === true
      case 'judge':
        return m.judge?.pass === true
    }
  }
  const checks = c.checks.map(
    (check): CheckResult => ({
      label: check.label,
      pass: passes(check),
      ...(check.regression ? { regression: true } : {}),
    }),
  )
  const breach =
    m.seconds > c.budget.seconds
      ? `${m.seconds}s > ${c.budget.seconds}s`
      : m.tokens > c.budget.tokens
        ? `${m.tokens} tokens > ${c.budget.tokens}`
        : undefined
  return {
    checks,
    pass: m.outcome === 'completed' && checks.every((x) => x.pass),
    tierMismatch: m.tier !== undefined && !c.tiers.includes(m.tier),
    ...(breach ? { budgetBreach: breach } : {}),
  }
}

export interface TrialResult {
  case: string
  mode: Mode
  trial: number
  chatId?: string
  colonyId?: string
  metrics: Metrics
  grade: Grade
  error?: string
}

export interface CaseSummary {
  case: string
  mode: Mode
  trials: number
  /** At least one trial passed. */
  passAtK: boolean
  /** Every trial passed: the reliability number. */
  passHatK: boolean
  passRate: number
  medianSeconds: number
  medianTokens: number
  medianToolCalls: number
  /** Share of trials where a `regression` check failed: something outside the request broke. */
  regressionRate: number
  /** Summed over the trials; absent when a provider reported no price. */
  costUsd?: number
  /** Trials that ended on an edit no test run followed (Metrics.testedAfterEdit false). */
  untestedEdits: number
  /** Tool calls that returned an error, summed over the trials. */
  failedToolCalls: number
  hardFailures: string[]
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length === 0 ? 0 : s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

export function summarize(results: readonly TrialResult[]): CaseSummary[] {
  const groups = new Map<string, TrialResult[]>()
  for (const r of results) {
    const key = `${r.case}\u0000${r.mode}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  return [...groups.values()].map((rs) => {
    const passed = rs.filter((r) => r.grade.pass).length
    const first = rs[0] as TrialResult
    return {
      case: first.case,
      mode: first.mode,
      trials: rs.length,
      passAtK: passed > 0,
      passHatK: passed === rs.length,
      passRate: passed / rs.length,
      medianSeconds: median(rs.map((r) => r.metrics.seconds)),
      medianTokens: median(rs.map((r) => r.metrics.tokens)),
      medianToolCalls: median(rs.map((r) => r.metrics.toolCalls)),
      regressionRate:
        rs.filter((r) => r.grade.checks.some((x) => x.regression && !x.pass)).length / rs.length,
      ...(rs.every((r) => r.metrics.costUsd !== undefined)
        ? { costUsd: rs.reduce((n, r) => n + (r.metrics.costUsd ?? 0), 0) }
        : {}),
      untestedEdits: rs.filter((r) => r.metrics.testedAfterEdit === false).length,
      failedToolCalls: rs.reduce((n, r) => n + r.metrics.failedToolCalls, 0),
      hardFailures: rs.flatMap((r) => [
        ...(r.error ? [`#${r.trial} error: ${r.error}`] : []),
        ...(r.grade.tierMismatch ? [`#${r.trial} tier ${r.metrics.tier}`] : []),
        ...(r.grade.budgetBreach ? [`#${r.trial} budget ${r.grade.budgetBreach}`] : []),
      ]),
    }
  })
}

/** Side-by-side lines for two reports: pass and regression rates, median time/tokens/tool calls per case and mode. */
export function compare(before: readonly CaseSummary[], after: readonly CaseSummary[]): string[] {
  const pct = (n: number) => `${Math.round(n * 100)}%`
  const delta = (a: number, b: number) =>
    a === 0 ? '' : ` (${b >= a ? '+' : ''}${Math.round(((b - a) / a) * 100)}%)`
  return after.map((b) => {
    const a = before.find((x) => x.case === b.case && x.mode === b.mode)
    if (!a)
      return `${b.case} [${b.mode}]  new: ${pct(b.passRate)} pass, ${b.medianSeconds}s, ${b.medianTokens} tok`
    return (
      `${b.case} [${b.mode}]  pass ${pct(a.passRate)} → ${pct(b.passRate)}, ` +
      `${a.medianSeconds}s → ${b.medianSeconds}s${delta(a.medianSeconds, b.medianSeconds)}, ` +
      `${a.medianTokens} → ${b.medianTokens} tok${delta(a.medianTokens, b.medianTokens)}, ` +
      `${a.medianToolCalls} → ${b.medianToolCalls} tools, ` +
      `regressions ${pct(a.regressionRate ?? 0)} → ${pct(b.regressionRate ?? 0)}, ` +
      `untested edits ${a.untestedEdits ?? 0} → ${b.untestedEdits}, failed calls ${a.failedToolCalls ?? 0} → ${b.failedToolCalls}`
    )
  })
}
