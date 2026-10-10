import { join } from 'node:path'
import type { ActorRef, ColonyState, EventId, EventPayloads, MyrEvent, RoundGoal } from '@myrmidon/protocol'
import { localDate } from './clock.ts'
import {
  GOAL,
  MAX_DIFF_CHARS,
  MAX_JUDGE_CHARS,
  MAX_SOURCES,
  OBSERVED_CALLS,
  OBSERVED_CHARS,
  SOURCE_CHARS,
  SOURCE_MS,
} from './config.ts'
import type { ColonyHost } from './host.ts'
import type { ModelResolver } from './models.ts'
import { completeSimple, type Context as LlmContext } from './omp/ai.ts'
import { scratchChecks } from './project-context.ts'
import { prompts } from './prompts.ts'
import { hideInContext } from './provider-secrets.ts'
import type { AcceptanceCheck } from './spec.ts'
import { pickChecks, runProjectChecks, spotlight } from './tools.ts'
import { assertPublicUrl } from './web.ts'

export interface CheckOutcome {
  readonly pass: boolean
  readonly score?: number
  readonly evidence: string
}

export interface ColonyVerification {
  readonly pass: boolean
  readonly verdicts: EventId[]
  readonly report: string
}

const actor = (id: string): ActorRef => ({ kind: 'verifier', id })

/**
 * The "Done when" part of a task brief (prompts.system.brief): its lines up to the next head, or undefined when the
 * brief has none.
 */
export function doneWhen(description: string): string | undefined {
  const match =
    /(?:^|\s)Done when:\s*([\s\S]*?)(?=(?:^|\s)(?:Goal|Context|Deliverable|Approach|Not yours|Not in scope):|$(?![\s\S]))/m.exec(
      description,
    )
  const text = match?.[1]?.trim()
  return text ? text : undefined
}

/** Independent judge of colony output. Only this component appends `verifier/verdict` events. */
export class Verifier {
  constructor(
    private readonly host: ColonyHost,
    private readonly resolver: ModelResolver,
  ) {}

  async verifyTask(taskId: string): Promise<{ pass: boolean; evidence: string }> {
    const state = this.host.state()
    const task = state.tasks[taskId]
    if (!task) throw new Error(`no such task: ${taskId}`)
    const missing = task.artifacts.filter((a) => !state.artifacts[a])
    const outputs = task.outputs ?? []
    let outcome: CheckOutcome =
      missing.length > 0
        ? { pass: false, evidence: `missing artifacts: ${missing.join(', ')}` }
        : task.artifacts.length > 0
          ? { pass: true, evidence: `artifacts present: ${task.artifacts.join(', ')}` }
          : outputs.length > 0
            ? { pass: false, evidence: `no artifacts were submitted; the task names ${outputs.join(', ')}` }
            : { pass: true, evidence: 'the task names no files; its work is in notes and messages' }
    if (outcome.pass && this.host.spec.taskJudge) {
      // With no files, the doer's notes and messages are the work; the rest of the round's files are not its.
      const owner = task.owner ?? ''
      const work =
        task.artifacts.length > 0
          ? ''
          : prompts.judge.taskNotes(
              owner,
              state.notes
                .filter((n) => n.agent === owner)
                .slice(-6)
                .map((n) => `[${n.section ?? 'note'}] ${n.text}`)
                .join('\n'),
              state.mail
                .filter((m) => m.from === owner)
                .slice(-6)
                .map((m) => `[to ${m.to}] ${m.body}`)
                .join('\n'),
            )
      outcome = await this.judge(
        this.host.spec.taskJudge,
        prompts.judge.task(task.subject, task.description, doneWhen(task.description)),
        0.7,
        task.artifacts,
        work,
      )
    }
    await this.host.append({
      type: 'verifier/verdict',
      actor: actor('task-review'),
      payload: {
        target: `task:${taskId}`,
        verifierId: 'task-review',
        pass: outcome.pass,
        ...score(outcome),
        evidence: outcome.evidence,
      },
    })
    await this.host.appendAtomic((s) => {
      const current = s.tasks[taskId]
      if (current?.status !== 'submitted') return []
      return [
        {
          type: 'task/changed',
          actor: actor('task-review'),
          payload: {
            task: {
              ...current,
              revision: current.revision + 1,
              status: outcome.pass ? 'verified' : 'rejected',
            },
            by: 'verifier',
          },
        },
      ]
    })
    return outcome
  }

  async verifyColony(): Promise<ColonyVerification> {
    const checks = this.host.spec.acceptance
    if (checks.length === 0) {
      return {
        pass: false,
        verdicts: [],
        report: 'no acceptance checks are declared, so the colony cannot be verified',
      }
    }
    const verdicts: EventId[] = []
    const lines: string[] = []
    let pass = true
    for (const [i, check] of checks.entries()) {
      const verifierId = `${check.verifier}#${i}`
      let outcome: CheckOutcome
      try {
        outcome = await this.runCheck(check, i)
      } catch (err) {
        outcome = {
          pass: false,
          evidence: `verifier error: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      const e: MyrEvent = await this.host.append({
        type: 'verifier/verdict',
        actor: actor(verifierId),
        payload: {
          target: 'colony',
          verifierId,
          pass: outcome.pass,
          ...score(outcome),
          evidence: outcome.evidence,
        },
      })
      verdicts.push(e.id)
      pass &&= outcome.pass
      lines.push(`${outcome.pass ? 'PASS' : 'FAIL'} ${verifierId}: ${outcome.evidence}`)
    }
    return { pass, verdicts, report: lines.join('\n') }
  }

  /**
   * Checks a goal round's condition in the work as it stands (goal mode), where `by` works: in a project, the folder
   * with every crewmate's changes merged. Logged as a `goal` verdict numbered by `check`. `broken`: the condition
   * itself cannot be checked, so going on would loop on a check that can never pass.
   */
  async verifyGoal(goal: RoundGoal, check: number, by: string): Promise<CheckOutcome & { broken: boolean }> {
    let outcome: CheckOutcome & { broken: boolean }
    try {
      outcome = await this._goalOutcome(goal, by)
    } catch (err) {
      outcome = {
        pass: false,
        broken: false,
        evidence: `verifier error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    await this.host.append({
      type: 'verifier/verdict',
      actor: actor('goal'),
      payload: {
        target: 'goal',
        verifierId: `goal#${check}`,
        pass: outcome.pass,
        ...score(outcome),
        evidence: outcome.evidence,
      },
    })
    return outcome
  }

  private async _goalOutcome(goal: RoundGoal, by: string): Promise<CheckOutcome & { broken: boolean }> {
    // A project's folder holds every crewmate's merged changes; without one, the work is in the speaker's own folder.
    const path = this.host.workspace.workdir(this.host.project ? 'verifier' : by)
    const writable = [path, this.host.workspace.scratch('verifier')]
    const sandboxed = this.host.sandbox.kind !== 'none' || this.host.unsafeNoSandbox
    if (goal.check.kind === 'command') {
      if (!sandboxed) return { pass: false, broken: true, evidence: prompts.judge.goalNeedsSandbox }
      const run = goal.check.run
      const r = await this.host.sandbox.run({
        command: run,
        cwd: path,
        writable,
        ...this.host.workspace.confinement(),
        timeoutMs: GOAL.commandMs,
      })
      const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-60).join('\n')
      const status = r.timedOut ? 'timed out' : `exit ${r.code}`
      // After omp's /loop --until: 126 (not executable) and 127 (not found) are the condition breaking, not answering.
      // Any other failing status is an answer: test runners and type checkers fail with 1, 2 and more.
      return {
        pass: !r.timedOut && r.code === 0,
        broken: !r.timedOut && (r.code === 126 || r.code === 127),
        evidence: `\`${run}\` ${status}\n${tail}`.trim(),
      }
    }
    if (goal.check.kind === 'checks' && sandboxed) {
      const picked = pickChecks(this.host.project?.checks ?? scratchChecks(path))
      if (picked.length > 0) {
        const r = await runProjectChecks(this.host, path, writable, picked)
        return { pass: r.ok, broken: false, evidence: r.report }
      }
    }
    // Judged, and so also a "tests pass" goal where there are no checks to run: the reviewer reads the work for it.
    return {
      ...(await this.judge(goal.judge, prompts.judge.goal(goal.condition), goal.threshold)),
      broken: false,
    }
  }

  private async runCheck(check: AcceptanceCheck, index: number): Promise<CheckOutcome> {
    const state = this.host.state()
    switch (check.verifier) {
      case 'checks':
        return this.rules(state, check.rules)
      case 'command':
        return this.command(state, check, index)
      case 'llm-judge':
        return this.judge(check.model, check.rubric, check.threshold)
    }
  }

  private async rules(state: ColonyState, rules: Extract<AcceptanceCheck, { verifier: 'checks' }>['rules']) {
    const failures: string[] = []
    for (const rule of rules) {
      const latest = state.artifacts[rule.artifact]?.at(-1)
      if (!latest) {
        if (rule.exists !== false) failures.push(`${rule.artifact} does not exist`)
        continue
      }
      if (rule.exists === false) failures.push(`${rule.artifact} must not exist`)
      if (rule.minBytes !== undefined && latest.size < rule.minBytes)
        failures.push(`${rule.artifact} is ${latest.size} bytes (< ${rule.minBytes})`)
      if (rule.maxBytes !== undefined && latest.size > rule.maxBytes)
        failures.push(`${rule.artifact} is ${latest.size} bytes (> ${rule.maxBytes})`)
      if (rule.contains !== undefined || rule.notContains !== undefined) {
        const text = await this.host.blobs.text(latest.blob)
        if (rule.contains !== undefined && !text.includes(rule.contains))
          failures.push(`${rule.artifact} lacks "${rule.contains}"`)
        if (rule.notContains !== undefined && text.includes(rule.notContains))
          failures.push(`${rule.artifact} contains "${rule.notContains}"`)
      }
    }
    return failures.length === 0
      ? { pass: true, evidence: `${rules.length} rule(s) satisfied` }
      : { pass: false, evidence: failures.join('; ') }
  }

  private async command(
    state: ColonyState,
    check: Extract<AcceptanceCheck, { verifier: 'command' }>,
    index: number,
  ) {
    if (this.host.sandbox.kind === 'none' && !this.host.unsafeNoSandbox) {
      return { pass: false, evidence: 'command checks need an OS sandbox (or --unsafe-no-sandbox)' }
    }
    const dir = join(this.host.workspace.colonyDir, 'verify', `check-${index}`)
    const missing = await this.host.workspace.materialize(state, this.host.blobs, check.against, dir)
    if (missing.length > 0) return { pass: false, evidence: `missing artifacts: ${missing.join(', ')}` }
    const r = await this.host.sandbox.run({
      command: check.run,
      cwd: dir,
      writable: [dir],
      ...this.host.workspace.confinement(),
      timeoutMs: check.timeoutMs ?? 120_000,
    })
    const tail = (s: string) => s.slice(-3000)
    const status = r.timedOut ? 'timed out' : `exit ${r.code}`
    return {
      pass: !r.timedOut && r.code === 0,
      evidence: `\`${check.run}\` ${status}\n${tail(r.stdout)}\n${tail(r.stderr)}`.trim(),
    }
  }

  /** The latest observing tool calls with their results, so the judge checks claims against what was seen. */
  private async _observations(events: readonly MyrEvent[]): Promise<string> {
    const calls = new Map<string, EventPayloads['tool/call']>()
    const seen: string[] = []
    for (const e of events) {
      if (e.type === 'tool/call') {
        const p = e.payload as EventPayloads['tool/call']
        calls.set(`${p.agent}/${p.callId}`, p)
      } else if (e.type === 'tool/result') {
        const p = e.payload as EventPayloads['tool/result']
        if (!p.ok || !OBSERVING.test(p.tool)) continue
        const args = JSON.stringify(calls.get(`${p.agent}/${p.callId}`)?.args ?? {}).slice(0, 200)
        seen.push(`\n----- ${p.agent} ${p.tool} ${args}\n${p.output.slice(0, OBSERVED_CHARS)}`)
      }
    }
    return seen.slice(-OBSERVED_CALLS).join('')
  }

  /**
   * The pages a research answer cites, so the judge checks claims against their sources (as DeepResearch Bench's
   * FACT does): what an agent already fetched is reused, the rest is fetched now, a few at a time.
   */
  private async _citedSources(corpus: string, events: readonly MyrEvent[]): Promise<string> {
    const cited = citedUrls(corpus)
    const urls = cited.slice(0, MAX_SOURCES)
    if (urls.length === 0) return ''
    const seen = new Map<string, string>()
    const calls = new Map<string, string>()
    for (const e of events) {
      if (e.type === 'tool/call') {
        const p = e.payload as EventPayloads['tool/call']
        const url = (p.args as { url?: unknown }).url
        if (p.tool === 'web_fetch' && typeof url === 'string') calls.set(`${p.agent}/${p.callId}`, url)
      } else if (e.type === 'tool/result') {
        const p = e.payload as EventPayloads['tool/result']
        const url = calls.get(`${p.agent}/${p.callId}`)
        if (url && p.ok) seen.set(normalizeUrl(url), p.output)
      }
    }
    const pages = await Promise.all(
      urls.map(async (url) => {
        const known = seen.get(normalizeUrl(url))
        if (known) return { url, how: 'as the agent saw it', text: known }
        try {
          const page = await withTimeout(this.host.web.read(url), SOURCE_MS)
          return { url, how: 'fetched by you now', text: page.output }
        } catch (err) {
          return { url, how: 'could not be fetched', text: err instanceof Error ? err.message : String(err) }
        }
      }),
    )
    const shown = pages
      .map((p) => {
        const excerpt =
          p.how === 'could not be fetched' ? p.text : relevantExcerpt(p.text, claimsCiting(corpus, p.url))
        return `\n----- ${p.url} (${p.how})\n${spotlight(this.host.boundary, p.url, excerpt)}`
      })
      .join('')
    const rest = cited.length - urls.length
    return rest > 0 ? `${shown}\n----- ${rest} more cited page(s) were not checked.` : shown
  }

  /** `only`: the artifacts to judge (default: all of them); `work`: more of the work, shown before them. */
  private async judge(
    modelRef: string,
    rubric: string,
    threshold: number,
    only?: readonly string[],
    work = '',
  ): Promise<CheckOutcome> {
    const state = this.host.state()
    const names = only ?? Object.keys(state.artifacts)
    let corpus = work
    for (const name of names) {
      const latest = state.artifacts[name]?.at(-1)
      if (!latest) continue
      corpus += `\n===== ${name} (v${latest.version}, ${latest.mediaType}) =====\n${await this.host.blobs.text(latest.blob)}\n`
      if (corpus.length > MAX_JUDGE_CHARS) break
    }
    const replies = state.chatMessages.filter((m) => m.from !== 'user')
    if (state.chat && replies.length > 0) {
      corpus += `\n===== replies to the user (latest last) =====\n${replies
        .slice(-6)
        .map((m) => `[${m.from}${m.final ? ', final' : ''}] ${m.text}`)
        .join('\n\n')}\n`
    }
    const events = await this.host.log.read(this.host.id)
    // In a project the work is the folder itself: show the round's diff, and run the project's own checks when
    // an agent touched files, so code is judged on whether it builds and passes, not only on how it reads.
    const diff = await this.host.projectDiff().catch(() => undefined)
    if (diff?.trim())
      corpus += `\n===== changes to the project in this round (unified diff) =====\n${diff.slice(0, MAX_DIFF_CHARS)}\n`
    let checks = ''
    const project = this.host.project
    const edited = events.some(
      (e) => e.type === 'tool/call' && EDITING.has((e.payload as EventPayloads['tool/call']).tool),
    )
    const path = this.host.workspace.workdir('verifier')
    const picked = project ? pickChecks(project.checks) : []
    if (
      project &&
      edited &&
      picked.length > 0 &&
      (this.host.sandbox.kind !== 'none' || this.host.unsafeNoSandbox)
    )
      checks = (
        await runProjectChecks(this.host, path, [path, this.host.workspace.scratch('verifier')], picked)
      ).report
    if (!corpus) return { pass: false, score: 0, evidence: 'no artifacts or replies to judge' }
    const observed = await this._observations(events)
    const kinds = workKinds(events, names, project !== undefined)
    const sources = kinds.includes('research') ? await this._citedSources(corpus, events) : ''
    const resolved = this.resolver.resolve(modelRef)
    const context: LlmContext = {
      systemPrompt: [
        prompts.judge.role,
        prompts.judge.threshold(threshold),
        prompts.judge.today(localDate()),
        prompts.judge.kinds(kinds.join(' + '), kinds.map((k) => `- ${prompts.judge.judging[k]}`).join('\n')),
        ...(sources ? [prompts.judge.sources(this.host.boundary)] : []),
        ...(checks ? [prompts.judge.checks] : []),
        prompts.judge.reply,
      ],
      messages: [
        {
          role: 'user',
          content: prompts.judge.work({
            mission: state.mission,
            rubric,
            artifacts: corpus.slice(0, MAX_JUDGE_CHARS),
            checks,
            sources,
            observed,
          }),
          timestamp: Date.now(),
        },
      ],
    }
    const apiKey = await this.resolver.requireApiKey(resolved.model)
    const reply = resolved.streamFn
      ? await (await resolved.streamFn(resolved.model, hideInContext(context), { apiKey })).result()
      : await completeSimple(resolved.model, hideInContext(context), { apiKey })
    if (reply.stopReason === 'error')
      throw new Error(`judge model failed: ${reply.errorMessage ?? 'unknown error'}`)
    const text = reply.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')
    const json = /\{[\s\S]*\}/.exec(text)?.[0]
    if (!json) throw new Error(`judge did not return JSON: ${text.slice(0, 200)}`)
    const parsed = JSON.parse(json) as { score?: unknown; reasons?: unknown; findings?: unknown }
    const value = Number(parsed.score)
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new Error(`judge returned invalid score: ${parsed.score}`)
    const findings = gradedFindings(parsed.findings)
    return {
      pass: value >= threshold,
      score: value,
      evidence: [
        `score ${value.toFixed(2)} (threshold ${threshold}): ${String(parsed.reasons ?? '')}`,
        ...findings.map((f) => `- [${f.severity}] ${f.where ? `${f.where}: ` : ''}${f.what}`),
        ...(checks
          ? [
              '',
              'Project checks run by the reviewer:',
              checks
                .split('\n')
                .filter((l) => /^(PASS|FAIL) /.test(l))
                .join('\n'),
            ]
          : []),
      ].join('\n'),
    }
  }
}

export type WorkKind = 'code' | 'research' | 'browser' | 'writing'

const CODE_FILE =
  /\.(tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|html?|css|scss|sql|sh|vue|svelte)$/i
const TEXT_FILE = /\.(md|markdown|txt|rst|docx?|rtf)$/i

/** The kinds of work a round did, from its tool calls and the files it delivered. */
export function workKinds(
  events: readonly MyrEvent[],
  artifacts: readonly string[],
  project: boolean,
): WorkKind[] {
  const tools = new Set(
    events.filter((e) => e.type === 'tool/call').map((e) => (e.payload as EventPayloads['tool/call']).tool),
  )
  // Uploads and saved pages are inputs, not deliverables.
  const delivered = artifacts.filter((n) => !n.startsWith('uploads/') && !n.startsWith('web/'))
  const kinds: WorkKind[] = []
  if ((project && [...EDITING].some((t) => tools.has(t))) || delivered.some((n) => CODE_FILE.test(n)))
    kinds.push('code')
  if (tools.has('web_search') || tools.has('web_fetch')) kinds.push('research')
  if ([...tools].some((t) => t.startsWith('browser_'))) kinds.push('browser')
  if (kinds.length === 0 || delivered.some((n) => TEXT_FILE.test(n))) kinds.push('writing')
  return kinds
}

/** Public http(s) URLs cited in the work, in order of first appearance, without trailing punctuation. */
export function citedUrls(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
    const url = m[0].replace(/[.,;:!?*_]+$/, '')
    try {
      assertPublicUrl(url)
    } catch {
      continue
    }
    if (!out.some((u) => normalizeUrl(u) === normalizeUrl(url))) out.push(url)
  }
  return out
}

/** The lines of the work that cite `url`: the claims its page should support. */
function claimsCiting(corpus: string, url: string): string {
  return corpus
    .split('\n')
    .filter((line) => line.includes(url))
    .slice(0, 6)
    .join('\n')
}

const STOPWORDS = new Set([
  'about',
  'after',
  'their',
  'there',
  'these',
  'those',
  'which',
  'while',
  'would',
  'source',
])

/**
 * The page's opening plus the passages that share the most numbers and words with the claims citing it, in page
 * order, so a figure deep in a long page still reaches the judge.
 */
export function relevantExcerpt(page: string, claims: string, limit = SOURCE_CHARS): string {
  if (page.length <= limit) return page
  const plain = claims.replace(/https?:\/\/\S+/g, ' ')
  const terms = new Set([
    ...(plain.match(/\d[\d.,]*\d|\d/g) ?? []).filter((n) => n.length > 1),
    ...(plain.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []).filter((w) => !STOPWORDS.has(w)),
  ])
  const head = page.slice(0, 600)
  const chunks: { at: number; text: string; score: number }[] = []
  for (let at = 600; at < page.length; at += 400) {
    const text = page.slice(at, at + 400)
    const lower = text.toLowerCase()
    let score = 0
    for (const t of terms) if (lower.includes(t)) score += /\d/.test(t) ? 3 : 1
    if (score > 0) chunks.push({ at, text, score })
  }
  const picked: typeof chunks = []
  let size = head.length
  for (const c of [...chunks].sort((a, b) => b.score - a.score)) {
    if (size + c.text.length > limit) break
    picked.push(c)
    size += c.text.length
  }
  return [head, ...picked.sort((a, b) => a.at - b.at).map((c) => `…${c.text}`)].join('\n')
}

const normalizeUrl = (url: string) => url.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase()

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms)),
  ])
}

/** Tools that change files; a project round that used any of them gets its checks run by the judge. */
const EDITING = new Set(['fs_write', 'fs_edit', 'ast_edit', 'shell', 'eval'])
const SEVERITIES = ['blocker', 'major', 'minor'] as const

/** The judge's findings, kept only when well formed and ordered most serious first. */
export function gradedFindings(
  raw: unknown,
): { severity: (typeof SEVERITIES)[number]; where?: string; what: string }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .flatMap((f) => {
      const x = f as { severity?: unknown; where?: unknown; what?: unknown }
      const severity = SEVERITIES.find((s) => s === x.severity) ?? 'major'
      if (typeof x.what !== 'string' || !x.what.trim()) return []
      return [
        {
          severity,
          ...(typeof x.where === 'string' && x.where.trim() ? { where: x.where.trim() } : {}),
          what: x.what.trim(),
        },
      ]
    })
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
    .slice(0, 12)
}

/** Tools whose results show the world as the agents found it (pages, searches, files, command output). */
const OBSERVING =
  /^(web_fetch|web_search|browser_.+|shell|fs_read|read_artifact|grep|glob|run_checks|start_server|server_logs|tool_.+|mcp__.+)$/

function score(o: CheckOutcome): Partial<Pick<EventPayloads['verifier/verdict'], 'score'>> {
  return o.score === undefined ? {} : { score: o.score }
}
