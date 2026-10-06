import type { MyrEvent } from '@myrmidon/protocol'

export type Tier = 'answer' | 'solo' | 'team'
export type Mode = 'orchestrated' | 'swarm'

/** A code-based check on one trial. The colony's own judge is the model-based grader (`judge`). */
export type Check =
  | { kind: 'reply'; label: string; matches: RegExp }
  | { kind: 'artifact'; label: string; name: RegExp; contains?: RegExp }
  | { kind: 'tool'; label: string; used: RegExp }
  /** A command run in the case's project folder after the round; exit code 0 passes. */
  | { kind: 'command'; label: string; run: string[] }
  /** A project file must still hold exactly its fixture content (the agent must not "fix" the test). */
  | { kind: 'unchanged'; label: string; file: string }
  | { kind: 'judge'; label: string }

export interface EvalCase {
  id: string
  pillar: 'answer' | 'coding' | 'browser' | 'research' | 'build'
  prompt: string
  /** Tiers the triage may pick; anything else is a mismatch. */
  tiers: Tier[]
  modes?: Mode[]
  /** Breaching either fails the run. Tokens count cached input, like the run card. */
  budget: { seconds: number; tokens: number }
  /** Fixture files written to a fresh folder that becomes the chat's project. */
  project?: Record<string, string>
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
  tier?: Tier
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
  judge?: { pass: boolean; score?: number }
  finalReply?: string
}

type Payload = Record<string, unknown>
const payload = (e: MyrEvent) => e.payload as Payload

export function metrics(events: readonly MyrEvent[]): Metrics {
  const of = (type: string) => events.filter((e) => e.type === type)
  const created = payload(of('colony/created')[0] ?? ({ payload: {} } as MyrEvent))
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
  return {
    ...(created.tier ? { tier: created.tier as Tier } : {}),
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
  const checks = c.checks.map((check): CheckResult => {
    switch (check.kind) {
      case 'reply':
        return { label: check.label, pass: check.matches.test(m.finalReply ?? '') }
      case 'artifact': {
        const hits = Object.entries(view.artifacts).filter(([name]) => check.name.test(name))
        return {
          label: check.label,
          pass: hits.some(([, text]) => !check.contains || check.contains.test(text)),
        }
      }
      case 'tool':
        return { label: check.label, pass: tools.some((t) => check.used.test(t)) }
      case 'command':
      case 'unchanged':
        return { label: check.label, pass: view.local[check.label] === true }
      case 'judge':
        return { label: check.label, pass: m.judge?.pass === true }
    }
  })
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
      hardFailures: rs.flatMap((r) => [
        ...(r.error ? [`#${r.trial} error: ${r.error}`] : []),
        ...(r.grade.tierMismatch ? [`#${r.trial} tier ${r.metrics.tier}`] : []),
        ...(r.grade.budgetBreach ? [`#${r.trial} budget ${r.grade.budgetBreach}`] : []),
      ]),
    }
  })
}

/** Side-by-side lines for two reports: pass rate and median time/tokens per case and mode. */
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
      `${a.medianTokens} → ${b.medianTokens} tok${delta(a.medianTokens, b.medianTokens)}`
    )
  })
}
