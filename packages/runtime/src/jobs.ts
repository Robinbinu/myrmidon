import type { EventPayloads, JobResult, MyrEvent } from '@myrmidon/protocol'
import type { JobReport } from './host.ts'

/**
 * Checking a delegated job's report against what its agent really did, after omp's `<task-result>` ("claimed
 * artifacts unverified") and Claude Code's coordinator ("trust but verify worker reports ... check the actual
 * diff"): the files come from the harness, each claimed check is looked up in the agent's own calls, and a confidence
 * the evidence does not back is lowered, with the reason.
 */

/** Tools that change a file at the path in their arguments. */
const EDITS = new Set(['fs_write', 'fs_edit', 'ast_edit'])

const LEVELS = ['low', 'medium', 'high'] as const
type Level = (typeof LEVELS)[number]
const lower = (a: Level, b: Level): Level => (LEVELS.indexOf(a) <= LEVELS.indexOf(b) ? a : b)

/** One command the agent ran, from a shell call or a run_checks line, and whether it went through. */
export interface CheckRun {
  readonly command: string
  readonly passed: boolean
  readonly seq: number
}

const squash = (command: string) => command.replace(/\s+/g, ' ').trim()

/** The commands `agent` ran in `events` (its shell calls and run_checks' checks), in order. */
export function runsOf(events: readonly MyrEvent[], agent: string): CheckRun[] {
  const calls = new Map<string, EventPayloads['tool/call'] & { seq: number }>()
  const runs: CheckRun[] = []
  for (const e of events) {
    if (e.type === 'tool/call') {
      const p = e.payload as EventPayloads['tool/call']
      if (p.agent === agent && (p.tool === 'shell' || p.tool === 'run_checks'))
        calls.set(p.callId, { ...p, seq: e.seq })
      continue
    }
    if (e.type !== 'tool/result') continue
    const p = e.payload as EventPayloads['tool/result']
    const call = calls.get(p.callId)
    if (!call) continue
    if (call.tool === 'shell') {
      const command = (call.args as { command?: unknown } | undefined)?.command
      // The shell tool's output opens with the command's exit status (tools.ts, `exit 0`).
      if (typeof command === 'string')
        runs.push({ command: squash(command), passed: p.ok && /^exit 0\b/.test(p.output), seq: call.seq })
      continue
    }
    // run_checks reports one line per check: PASS name (`command`, 1.2s) or FAIL ...
    for (const m of p.output.matchAll(/^(PASS|FAIL) .*?\(`([^`]+)`/gm))
      runs.push({ command: squash(m[2] ?? ''), passed: m[1] === 'PASS', seq: call.seq })
  }
  return runs
}

/** The seq of `agent`'s last file edit in `events`, or 0. */
export function lastEditOf(events: readonly MyrEvent[], agent: string): number {
  let last = 0
  for (const e of events)
    if (e.type === 'tool/call') {
      const p = e.payload as EventPayloads['tool/call']
      if (p.agent === agent && EDITS.has(p.tool)) last = e.seq
    }
  return last
}

/** Paths `agent` edited with the file tools in `events`, for a job with no worktree to diff. */
export function editedBy(events: readonly MyrEvent[], agent: string): string[] {
  const files = new Set<string>()
  for (const e of events)
    if (e.type === 'tool/call') {
      const p = e.payload as EventPayloads['tool/call']
      const path = (p.args as { path?: unknown } | undefined)?.path
      if (p.agent === agent && EDITS.has(p.tool) && typeof path === 'string') files.add(path)
    }
  return [...files]
}

/**
 * The job's result: the agent's report with what the log shows. `events` are the agent's job's events (from its
 * start); `filesChanged` what its worktree or edits changed.
 */
export function checkReport(
  events: readonly MyrEvent[],
  agent: string,
  report: JobReport,
  filesChanged: readonly string[],
  seconds: number,
): JobResult {
  const runs = runsOf(events, agent)
  const lastEdit = lastEditOf(events, agent)
  const checks = report.checks.map((c) => {
    const claimed = squash(c.command)
    const match = runs.findLast((r) => r.command.includes(claimed) || claimed.includes(r.command))
    return { command: c.command, passed: match ? match.passed : c.passed, seen: match !== undefined }
  })
  const claimed = report.confidence
  let confidence: Level = claimed
  let why: string | undefined
  const testedAfterEdit = runs.some((r) => r.passed && r.seq > lastEdit)
  const unbacked = checks.filter((c, i) => report.checks[i]?.passed && (!c.seen || !c.passed))
  if (report.status === 'done' && filesChanged.length > 0 && !testedAfterEdit) {
    confidence = lower(confidence, 'low')
    why = 'no check it ran passed after its last edit'
  } else if (unbacked.length > 0) {
    confidence = lower(confidence, 'medium')
    why = `its log does not show ${unbacked.map((c) => `\`${c.command}\``).join(', ')} passing`
  }
  return {
    status: report.status,
    summary: report.summary,
    filesChanged: [...filesChanged],
    checks,
    blockers: [...report.blockers],
    followUps: [...report.followUps],
    confidence,
    ...(confidence !== claimed ? { claimedConfidence: claimed, confidenceWhy: why } : {}),
    seconds,
  }
}

/** A result the harness writes for a job whose agent failed, stopped or never reported. */
export function harnessResult(
  status: 'blocked' | 'failed',
  summary: string,
  filesChanged: readonly string[],
  seconds: number,
): JobResult {
  return {
    status,
    summary,
    filesChanged: [...filesChanged],
    checks: [],
    blockers: [summary],
    followUps: [],
    confidence: 'low',
    byHarness: true,
    seconds,
  }
}

/** Normalized path of a file a job owns, so `./src/a.ts` and `src/a.ts` are one file. */
export const ownedPath = (file: string) =>
  file.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
