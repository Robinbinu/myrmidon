import { ADVICE_KINDS, type AdviceKind, type TaskStatus } from '@myrmidon/protocol'
import type { AgentMessage } from '@oh-my-pi/pi-agent-core'
import {
  type AssistantMessage,
  completeSimple,
  type Context as LlmContext,
  type Model,
} from '@oh-my-pi/pi-ai'
import { getModelPricingStatus } from '@oh-my-pi/pi-catalog'
import { ADVISOR } from './config.ts'
import type { ColonyHost } from './host.ts'
import type { ModelResolver } from './models.ts'
import { prompts } from './prompts.ts'
import type { AgentSpec } from './spec.ts'

/** What the advisor needs from the round: the request and budget, the tasks, what was spent, and the log. */
export type AdvisorHost = Pick<ColonyHost, 'spec' | 'state' | 'spent' | 'append'>

const ACTOR = { kind: 'system', id: 'advisor' } as const
/** Tasks an agent is still working toward; finished and dropped ones say nothing about its next step. */
const OPEN = new Set<TaskStatus>(['pending', 'in_progress', 'rejected'])

/**
 * A second model that watches the agents of one round (after omp's advisor): after an agent's step that called tools,
 * it reads that agent's latest steps and, only when it sees a concrete problem, hands back one short note for the
 * agent's next step. It never holds an agent up: each review runs beside the agent's next model call, and one that
 * arrives after the agent moved on is still read, at the step after.
 *
 * Its cost is capped three ways: a review per Nth tool step and at most one in flight per agent, a number of calls
 * per round, and none once the round has spent most of its limit. Silent reviews are not logged; notes are
 * (`agent/advised`), and the same note is never sent to an agent twice.
 */
export class Advisor {
  private _calls = 0
  private _cost = 0
  private _tokens = 0
  /** Set once the model failed: a missing key or an outage would fail every step the same way. */
  private _off = false
  private readonly _steps = new Map<string, number>()
  private readonly _busy = new Set<string>()
  private readonly _sent = new Map<string, string[]>()

  constructor(
    private readonly host: AdvisorHost,
    private readonly resolver: ModelResolver,
    readonly model: string,
  ) {}

  /** Model calls made this round. */
  get calls(): number {
    return this._calls
  }

  /**
   * One of `agent`'s steps that called tools has ended, leaving `messages` as its conversation: reviews it if this
   * step is due and the round can afford it, and calls `deliver` with a note if there is one. The returned promise is
   * for tests; the agent does not wait on it.
   */
  stepEnded(
    agent: AgentSpec,
    messages: readonly AgentMessage[],
    deliver: (note: string) => void,
  ): Promise<void> {
    const name = agent.name
    const steps = (this._steps.get(name) ?? 0) + 1
    this._steps.set(name, steps)
    if (
      this._off ||
      steps % ADVISOR.every !== 0 ||
      // The review in flight will be followed by one that sees this step too.
      this._busy.has(name) ||
      this._calls >= ADVISOR.callsPerRound ||
      this._nearLimit()
    )
      return Promise.resolve()
    this._calls += 1
    this._busy.add(name)
    return this._review(agent, messages.slice())
      .then((note) => {
        if (note) deliver(note)
      })
      .catch((err) => {
        this._off = true
        console.error(
          `[advisor] off for the rest of this round: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
      .finally(() => this._busy.delete(name))
  }

  /** The round has used most of its spend or token limit, counting what the advisor itself used. */
  private _nearLimit(): boolean {
    const { costUsd, tokens } = this.host.spec.budget
    const spent = this.host.spent()
    return (
      (!!costUsd && spent.cost + this._cost >= costUsd * ADVISOR.budgetShare) ||
      (!!tokens && spent.tokens + this._tokens >= tokens * ADVISOR.budgetShare)
    )
  }

  private async _review(agent: AgentSpec, messages: readonly AgentMessage[]): Promise<string | undefined> {
    const sent = this._sent.get(agent.name) ?? []
    const resolved = this.resolver.resolve(this.model)
    const context: LlmContext = {
      systemPrompt: [prompts.advisor.system(ADVICE_KINDS)],
      messages: [
        {
          role: 'user',
          content: prompts.advisor.review({ ...this._view(agent, messages), sent }),
          timestamp: Date.now(),
        },
      ],
    }
    const apiKey = await this.resolver.requireApiKey(resolved.model)
    const signal = AbortSignal.timeout(ADVISOR.timeoutMs)
    const options = { apiKey, maxTokens: ADVISOR.maxTokens, signal }
    let reply: AssistantMessage
    try {
      reply = resolved.streamFn
        ? await (await resolved.streamFn(resolved.model, context, options)).result()
        : await completeSimple(resolved.model, context, options)
    } catch (err) {
      // Too slow is not broken: the agent has moved on, and the next review sees where it is now.
      if (signal.aborted) return undefined
      throw err
    }
    this._count(reply, resolved.model)
    if (reply.stopReason === 'aborted') return undefined
    if (reply.stopReason === 'error') throw new Error(reply.errorMessage ?? 'the advisor model failed')
    const advice = parseAdvice(reply.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(''))
    if (!advice || sent.some((s) => sameNote(s, advice.note))) return undefined
    this._sent.set(agent.name, [...sent, advice.note])
    await this.host.append({
      type: 'agent/advised',
      actor: ACTOR,
      payload: {
        agent: agent.name,
        model: this.model,
        note: advice.note,
        ...(advice.kind ? { kind: advice.kind } : {}),
      },
    })
    return advice.note
  }

  /** Adds a reply's tokens and, when its model has a rate card, its cost (unknown is not free; see agent.ts). */
  private _count(reply: AssistantMessage, model: Model) {
    this._tokens += reply.usage?.totalTokens ?? 0
    const cost = (reply.usage as { cost?: { total?: number } } | undefined)?.cost?.total
    if (typeof cost === 'number' && ['fixed', 'free', 'included'].includes(getModelPricingStatus(model)))
      this._cost += cost
  }

  /** The compact view of the agent's work: the goal, its open tasks, and its latest steps, every piece clipped. */
  private _view(agent: AgentSpec, messages: readonly AgentMessage[]) {
    const spec = this.host.spec
    const tasks = Object.values(this.host.state().tasks)
      .filter((t) => (t.owner === agent.name || t.assignee === agent.name) && OPEN.has(t.status))
      .map((t) => prompts.advisor.task(t.subject, t.status, clip(t.description, ADVISOR.textChars)))
      .join('\n')
    const assistants = messages.flatMap((m, i) => (m.role === 'assistant' ? [i] : []))
    const from = assistants.at(-ADVISOR.steps) ?? 0
    const asked = messages.slice(0, from).findLast((m) => m.role === 'user')
    return {
      goal: clip(spec.chat?.request ?? spec.mission, ADVISOR.goalChars),
      agent: prompts.advisor.who(agent.name, agent.role, agent.specialty, agent.focus),
      tasks,
      asked: asked ? clip(textOf(asked), ADVISOR.textChars) : '',
      steps: messages.slice(from).flatMap(stepLines).join('\n'),
    }
  }
}

/** One message of the agent's conversation as the advisor reads it. */
function stepLines(m: AgentMessage): string[] {
  if (m.role === 'user') return [prompts.advisor.told(clip(textOf(m), ADVISOR.textChars))]
  if (m.role === 'toolResult')
    return [prompts.advisor.returned(m.toolName, clip(textOf(m), ADVISOR.resultChars), m.isError)]
  if (m.role !== 'assistant') return []
  // Reasoning is left out: the advisor judges what the agent did, and thoughts would multiply what it reads.
  return m.content.flatMap((c) =>
    c.type === 'text' && c.text.trim()
      ? [prompts.advisor.said(clip(c.text.trim(), ADVISOR.textChars))]
      : c.type === 'toolCall'
        ? [prompts.advisor.called(c.name, clip(JSON.stringify(c.arguments ?? {}), ADVISOR.argsChars))]
        : [],
  )
}

function textOf(m: AgentMessage): string {
  const content = (m as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as { type: string; text?: string }[])
    .flatMap((c) => (c.type === 'text' && c.text ? [c.text] : []))
    .join('\n')
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}${prompts.advisor.cut(text.length - max)}` : text
}

/**
 * The advisor's reply as a note, or undefined for silence: `{"note": null}`, an empty note, or a reply that is not
 * the JSON asked for (a note it could not state plainly is not worth an agent's attention).
 */
export function parseAdvice(text: string): { note: string; kind?: AdviceKind } | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return undefined
  let parsed: { note?: unknown; kind?: unknown }
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  const note = typeof parsed.note === 'string' ? parsed.note.trim() : ''
  if (!note) return undefined
  const kind = ADVICE_KINDS.find((k) => k === parsed.kind)
  return {
    note: note.length > ADVISOR.noteChars ? `${note.slice(0, ADVISOR.noteChars - 1)}…` : note,
    ...(kind ? { kind } : {}),
  }
}

/** Two notes that say the same thing, give or take case, spacing and punctuation. */
function sameNote(a: string, b: string): boolean {
  const key = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  return key(a) === key(b)
}
