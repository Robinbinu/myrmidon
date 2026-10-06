import { join } from 'node:path'
import type { ActorRef, ColonyState, EventId, EventPayloads, MyrEvent } from '@myrmidon/protocol'
import { completeSimple, type Context as LlmContext } from '@oh-my-pi/pi-ai'
import type { ColonyHost } from './host.ts'
import type { ModelResolver } from './models.ts'
import type { AcceptanceCheck } from './spec.ts'

const MAX_JUDGE_CHARS = 60_000

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
    let outcome: CheckOutcome =
      missing.length > 0
        ? { pass: false, evidence: `missing artifacts: ${missing.join(', ')}` }
        : task.artifacts.length === 0
          ? { pass: false, evidence: 'no artifacts were submitted' }
          : { pass: true, evidence: `artifacts present: ${task.artifacts.join(', ')}` }
    if (outcome.pass && this.host.spec.taskJudge) {
      outcome = await this.judge(
        this.host.spec.taskJudge,
        `Task: ${task.subject}\n${task.description}\n\nDoes the submitted work fully and correctly complete this task?`,
        0.7,
        task.artifacts,
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

  private async runCheck(check: AcceptanceCheck, index: number): Promise<CheckOutcome> {
    const state = this.host.state()
    switch (check.verifier) {
      case 'checks':
        return this.rules(state, check.rules)
      case 'command':
        return this.command(state, check, index)
      case 'llm-judge':
        return this.judge(check.model, check.rubric, check.threshold, [])
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
  private async _observations(): Promise<string> {
    const events = await this.host.log.read(this.host.id)
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

  private async judge(
    modelRef: string,
    rubric: string,
    threshold: number,
    only: readonly string[],
  ): Promise<CheckOutcome> {
    const state = this.host.state()
    const names = only.length > 0 ? only : Object.keys(state.artifacts)
    let corpus = ''
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
    if (!corpus) return { pass: false, score: 0, evidence: 'no artifacts or replies to judge' }
    const observed = await this._observations()
    const resolved = this.resolver.resolve(modelRef)
    const context: LlmContext = {
      systemPrompt: [
        'You are a strict, independent reviewer. You judge only the artifacts shown, never claims about them.',
        `Today is ${new Date().toISOString().slice(0, 10)}. Your own memory of websites, prices, versions, and ` +
          'current events may be out of date. OBSERVED lists what the agents actually saw with their tools during ' +
          'this round: trust it over your memory. Fail claims that are unsupported or contradict the observations, ' +
          'not claims that merely differ from what you remember.',
        'Reply with ONLY a JSON object: {"score": number between 0 and 1, "reasons": "short justification"}.',
      ],
      messages: [
        {
          role: 'user',
          content: `MISSION:\n${state.mission}\n\nRUBRIC:\n${rubric}\n\nARTIFACTS:${corpus.slice(0, MAX_JUDGE_CHARS)}${observed ? `\n\nOBSERVED (latest tool results, clipped):${observed}` : ''}`,
          timestamp: Date.now(),
        },
      ],
    }
    const apiKey = await this.resolver.requireApiKey(resolved.model)
    const reply = resolved.streamFn
      ? await (await resolved.streamFn(resolved.model, context, { apiKey })).result()
      : await completeSimple(resolved.model, context, { apiKey })
    if (reply.stopReason === 'error')
      throw new Error(`judge model failed: ${reply.errorMessage ?? 'unknown error'}`)
    const text = reply.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')
    const json = /\{[\s\S]*\}/.exec(text)?.[0]
    if (!json) throw new Error(`judge did not return JSON: ${text.slice(0, 200)}`)
    const parsed = JSON.parse(json) as { score?: unknown; reasons?: unknown }
    const value = Number(parsed.score)
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new Error(`judge returned invalid score: ${parsed.score}`)
    return {
      pass: value >= threshold,
      score: value,
      evidence: `score ${value.toFixed(2)} (threshold ${threshold}): ${String(parsed.reasons ?? '')}`,
    }
  }
}

/** Tools whose results show the world as the agents found it (pages, searches, files, command output). */
const OBSERVING =
  /^(web_fetch|web_search|browser_(open|snapshot|eval|console)|shell|fs_read|read_artifact|tool_.+|mcp__.+)$/
const OBSERVED_CALLS = 8
const OBSERVED_CHARS = 1_500

function score(o: CheckOutcome): Partial<Pick<EventPayloads['verifier/verdict'], 'score'>> {
  return o.score === undefined ? {} : { score: o.score }
}
