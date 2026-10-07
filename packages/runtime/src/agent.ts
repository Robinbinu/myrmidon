import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatus, EventId } from '@myrmidon/protocol'
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentState,
  type StreamFn,
} from '@oh-my-pi/pi-agent-core'
import { type AssistantMessage, streamSimple } from '@oh-my-pi/pi-ai'
import { ContextCompactor } from './compaction.ts'
import { agentActor, type ColonyHost } from './host.ts'
import type { ModelResolver } from './models.ts'
import { kickoff, onDemand, preloaded, startsAwake, systemPrompt, thinkingFor, toolsFor } from './patterns.ts'
import { redactDeep } from './secrets.ts'
import type { AgentSpec } from './spec.ts'
import { buildAgentTools, matchTools } from './tools.ts'
import { noWebTools } from './web.ts'

export interface InboxItem {
  readonly text: string
  readonly trigger: string
  readonly mail?: EventId
  /** Arriving mid-turn, wait until the agent finishes its current work instead of joining its next step. */
  readonly queue?: boolean
}

// A safety net only: one turn can include many model calls and large file writes.
const TURN_TIMEOUT_MS = 15 * 60_000
/** Retries for a transient model failure (rate limit, overload, timeout) before the person is asked. */
const MODEL_RETRIES = 2

const SYS = { kind: 'system', id: 'scheduler' } as const

/**
 * One colony member: a pi-agent-core Agent plus an inbox. Idle agents sleep until something is
 * delivered; deliveries during a turn are steered into its next step, or queued as a follow-up.
 */
export class ColonyAgent {
  readonly inbox: InboxItem[] = []
  turn = 0
  working = false
  private _wake?: () => void
  private _stopped = false
  private _failed = false
  private readonly _agent: Agent
  /** The current model's own stream function, if it has one (test models); otherwise pi's default. */
  private _stream?: StreamFn
  private readonly _compactor = new ContextCompactor({
    model: () => this._agent.state.model,
    apiKey: (m) => this.resolver.apiKey(m),
    onCompacted: (info) =>
      void this.host.append({
        type: 'agent/compacted',
        actor: agentActor(this.spec.name),
        payload: { agent: this.spec.name, ...info },
      }),
  })
  /** Mid-turn deliveries not yet read, keyed by the message timestamp pi echoes back when it injects them. */
  private readonly _unread = new Map<number, InboxItem>()
  private _stamp = 0
  /** Every finished message of this agent's conversation, one JSON line each, like an omp session file. */
  private readonly _transcript: string
  /** Messages restored from the transcript when a stopped colony resumed. */
  readonly restored: number

  constructor(
    readonly spec: AgentSpec,
    private readonly host: ColonyHost,
    private readonly resolver: ModelResolver,
    /** `compact`: a new round of the chat, so earlier rounds' tool output is elided from the restored history. */
    options: { restore?: boolean; compact?: boolean } = {},
  ) {
    this._transcript = join(host.workspace.colonyDir, 'agents', `${spec.name}.jsonl`)
    const restored = options.restore ? readTranscript(this._transcript) : []
    const history = options.compact ? compactTranscript(restored) : restored
    this.restored = history.length
    const resolved = resolver.resolve(spec.model)
    this._stream = resolved.streamFn
    const tools = buildAgentTools(spec.name, toolsFor(host.spec, spec), host)
    for (const name of preloaded(
      host.spec.chat?.request ?? host.spec.mission,
      tools.map((t) => t.name),
    ))
      this._loaded.add(name)
    this._agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt(host.spec, spec, {
          sandbox: host.sandbox.kind,
          web: host.web !== noWebTools,
          browser: host.browser !== undefined,
          boundary: host.boundary,
          ...(host.project ? { project: host.project } : {}),
          ...(host.workspace.isolation(spec.name) ? { worktree: host.workspace.isolation(spec.name) } : {}),
          skills: host.skills(),
        }),
        model: resolved.model,
        tools,
        ...(history.length ? { messages: history } : {}),
        ...(resolved.model.reasoning
          ? { thinkingLevel: thinkingFor(host.spec, spec) as NonNullable<AgentState['thinkingLevel']> }
          : {}),
      },
      getApiKey: (m) => resolver.apiKey(m),
      transformContext: (messages, signal) => this._compactor.transform(messages, signal),
      // pi reads the model afresh each step but keeps the stream function for a whole loop; dispatching here lets
      // a mid-round model switch reach models that bring their own stream too.
      // On-demand tools stay callable but are left out of the request until loaded (find_tools), so their
      // definitions do not ride along in every model call.
      streamFn: (model, context, options) =>
        (this._stream ?? streamSimple)(
          model,
          context.tools ? { ...context, tools: context.tools.filter((t) => this._shown(t.name)) } : context,
          options,
        ),
    })
    this._agent.subscribe((e) => this._onEvent(e))
  }

  get name() {
    return this.spec.name
  }

  /** Moves this agent to another model from its next step on; its conversation so far carries over. */
  switchModel(ref: string) {
    const resolved = this.resolver.resolve(ref)
    this._agent.setModel(resolved.model)
    this._stream = resolved.streamFn
    this._agent.setThinkingLevel(
      resolved.model.reasoning
        ? (thinkingFor(this.host.spec, this.spec) as NonNullable<AgentState['thinkingLevel']>)
        : undefined,
    )
    ;(this.spec as { model: string }).model = ref
  }

  /** On-demand tools this agent loaded with find_tools; the rest stay out of its model calls. */
  private readonly _loaded = new Set<string>()

  private _shown(name: string): boolean {
    return !onDemand(name) || this._loaded.has(name)
  }

  /** Picks up tools made since this agent started; takes effect on its next model call. */
  refreshTools() {
    this._agent.setTools(buildAgentTools(this.spec.name, toolsFor(this.host.spec, this.spec), this.host))
  }

  /** Loads the on-demand tools matching `query` for this agent's next steps (find_tools). */
  loadTools(query: string): string {
    const waiting = this._agent.state.tools.filter((t) => !this._shown(t.name))
    const found = matchTools(waiting, query)
    if (found.length === 0) {
      const names = waiting.map((t) => t.name)
      return names.length
        ? `nothing matches "${query}". Tools you can load: ${names.join(', ')}`
        : 'every tool you have is already loaded'
    }
    for (const t of found) this._loaded.add(t.name)
    const first = (d: string) => d.split(/(?<=\.)\s/)[0] ?? d
    return `Loaded, callable from your next step:\n${found.map((t) => `- ${t.name}: ${first(t.description)}`).join('\n')}`
  }

  get idle() {
    return !this.working && this.inbox.length === 0
  }

  notify(item: InboxItem) {
    if (this._stopped) return
    if (this.working) {
      this._stamp = Math.max(Date.now(), this._stamp + 1)
      const message = { role: 'user' as const, content: render([item]), timestamp: this._stamp }
      if (item.mail) this._unread.set(message.timestamp, item)
      if (item.queue) this._agent.followUp(message)
      else this._agent.steer(message)
      return
    }
    this.inbox.push(item)
    this._wake?.()
  }

  stop() {
    this._stopped = true
    this._agent.abort('colony stopped')
    this._wake?.()
  }

  /**
   * Runs until the colony ends. Agents that do not start awake sleep until a task, mail, or mention wakes them.
   * A resumed colony wakes its agents itself, so `kickoffFirst` is false there.
   */
  async run(kickoffFirst = true): Promise<void> {
    if (kickoffFirst && startsAwake(this.host.spec, this.spec))
      this.notify({ text: kickoff(this.host.spec, this.host.state(), this.restored > 0), trigger: 'kickoff' })
    while (!this._stopped && this.host.state().status === 'running') {
      if (this.inbox.length === 0) {
        await this._status('idle')
        await new Promise<void>((resolve) => {
          this._wake = resolve
        })
        this._wake = undefined
        continue
      }
      if (this.turn >= this.host.spec.budget.maxTurns) {
        await this._status('stopped', `turn limit ${this.host.spec.budget.maxTurns} reached`)
        return
      }
      const items = this.inbox.splice(0)
      await this._turn(items)
      if (this._failed) return
    }
    if (this.host.state().status !== 'running') await this._status('stopped', this.host.state().status)
  }

  private async _turn(items: InboxItem[]) {
    this.turn += 1
    const trigger = [...new Set(items.map((i) => i.trigger))].join(',')
    this.working = true
    await this.host.append({
      type: 'agent/turn',
      actor: SYS,
      payload: { agent: this.name, phase: 'start', turn: this.turn, trigger },
    })
    await this._status('working')
    await this._markDelivered(items)
    const timer = setTimeout(() => this._agent.abort('turn timeout'), TURN_TIMEOUT_MS)
    const from = this._agent.state.messages.length
    try {
      await this._agent.prompt(render(items))
      if (await this._recover()) this._failed = true
      else await this._deliverUnsentAnswer(from)
    } catch (err) {
      if (!this._stopped) {
        this._failed = true
        await this.host.modelFailed(this.name, this.spec.model, {
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      clearTimeout(timer)
      this._requeueUnread()
      this.working = false
    }
    await this.host.append({
      type: 'agent/turn',
      actor: SYS,
      payload: { agent: this.name, phase: 'end', turn: this.turn, trigger },
    })
  }

  /**
   * A failed model reply never stays in the agent's context: it is removed, and the turn either continues after a
   * short wait (transient failures) or stops so the person can choose another model. Returns true if it stopped.
   */
  private async _recover(): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      const last = this._agent.state.messages.at(-1) as AssistantMessage | undefined
      if (last?.role !== 'assistant' || last.stopReason !== 'error' || this._stopped) return false
      this._agent.popMessage()
      const error = classifyModelError(last)
      if (error.transient && attempt < MODEL_RETRIES) {
        await Bun.sleep(2_000 * 2 ** attempt)
        await this._agent.continue()
        continue
      }
      // The configured ref, not the provider's internal id, so the person sees the model they chose.
      await this.host.modelFailed(this.name, this.spec.model, error)
      return true
    }
  }

  /**
   * A one-agent chat round whose turn ends in plain text, without reply_user or ask_user, has written its
   * answer where the person cannot see it. Deliver that text as the final answer.
   */
  private async _deliverUnsentAnswer(from: number) {
    const spec = this.host.spec
    if (!spec.chat || spec.agents.length !== 1 || this._stopped) return
    const turn = this._agent.state.messages
      .slice(from)
      .filter((m) => m.role === 'assistant') as AssistantMessage[]
    const spoke = turn.some((m) =>
      m.content.some((c) => c.type === 'toolCall' && (c.name === 'reply_user' || c.name === 'ask_user')),
    )
    const last = turn.at(-1)
    const text =
      last?.content
        .flatMap((c) => (c.type === 'text' ? [c.text] : []))
        .join('\n')
        .trim() ?? ''
    if (spoke || !last || last.stopReason !== 'stop' || text.length < 20) return
    await this.host.append({
      type: 'chat/reply',
      actor: agentActor(this.name),
      payload: { agent: this.name, text, final: true },
    })
  }

  private _record(message: AgentMessage) {
    // Failed replies are never part of the conversation, so they are not kept for a resume either.
    if (
      (message as AssistantMessage).role === 'assistant' &&
      (message as AssistantMessage).stopReason === 'error'
    )
      return
    try {
      mkdirSync(join(this._transcript, '..'), { recursive: true })
      // Stored transcripts carry no secrets in clear; the model's live context is unchanged.
      appendFileSync(this._transcript, `${JSON.stringify(redactDeep(message))}\n`)
    } catch (err) {
      // The log stays authoritative; a lost transcript only means a resume starts from a summary.
      console.error(`[${this.name}] transcript write failed:`, err)
    }
  }

  /** Deliveries that arrived as the turn was ending were never injected; they start the next turn instead. */
  private _requeueUnread() {
    if (!this._agent.hasQueuedMessages()) return
    const left = this._agent.peekUndeliveredQueuedMessages()
    this._agent.clearAllQueues()
    for (const m of left) {
      const item = this._unread.get(m.timestamp)
      this._unread.delete(m.timestamp)
      const content = (m as { content?: unknown }).content
      if (item) this.inbox.push(item)
      else if (typeof content === 'string' && content) this.inbox.push({ text: content, trigger: 'mail' })
    }
  }

  private async _markDelivered(items: readonly InboxItem[]) {
    for (const item of items) {
      if (item.mail)
        await this.host.append({
          type: 'mail/delivered',
          actor: SYS,
          payload: { mail: item.mail, to: this.name },
        })
    }
  }

  private _status(status: AgentStatus, detail?: string) {
    return this.host.append({
      type: 'agent/status',
      actor: SYS,
      payload: { agent: this.name, status, ...(detail ? { detail } : {}) },
    })
  }

  private _onEvent(e: AgentEvent) {
    if (e.type === 'message_end') this._record(e.message)
    if (e.type === 'message_end' && e.message.role === 'user') {
      const item = this._unread.get(e.message.timestamp)
      if (item) {
        this._unread.delete(e.message.timestamp)
        void this._markDelivered([item])
      }
      return
    }
    if (e.type === 'turn_end') {
      this.host.batchEnded(this.name)
      return
    }
    if (e.type !== 'message_end' || e.message.role !== 'assistant') return
    const m = e.message as AssistantMessage
    // The abort that ends a stopped colony is not a model failure.
    if (this._stopped && m.stopReason !== 'stop' && m.stopReason !== 'toolUse') return
    const text = m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
    const thinking = m.content.flatMap((c) => (c.type === 'thinking' ? [c.thinking] : [])).join('\n')
    const toolCalls = m.content.flatMap((c) =>
      c.type === 'toolCall' ? [{ id: c.id, name: c.name, arguments: c.arguments ?? {} }] : [],
    )
    const cost = (m.usage as { cost?: { total?: number } } | undefined)?.cost?.total
    void this.host
      .append({
        type: 'llm/response',
        actor: agentActor(this.name),
        payload: {
          agent: this.name,
          model: `${m.provider}/${m.model}`,
          text,
          ...(thinking ? { thinking } : {}),
          toolCalls,
          ...(m.usage
            ? {
                usage: {
                  input: m.usage.input,
                  output: m.usage.output,
                  totalTokens: m.usage.totalTokens,
                  ...(typeof cost === 'number' ? { cost } : {}),
                },
              }
            : {}),
          stopReason: String(m.stopReason),
          ...(m.errorMessage ? { error: m.errorMessage } : {}),
        },
      })
      .catch((err) => console.error(`[${this.name}] failed to log response:`, err))
  }
}

function render(items: readonly InboxItem[]): string {
  return items.map((i) => (i.trigger === 'kickoff' ? i.text : `[${i.trigger}] ${i.text}`)).join('\n\n')
}

/**
 * Reads an agent's transcript for a resume. A crash can leave the last assistant message with tool calls
 * that never got results; that unfinished step is dropped so the conversation is valid to continue.
 */
export function readTranscript(path: string): AgentMessage[] {
  if (!existsSync(path)) return []
  const messages: AgentMessage[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      messages.push(JSON.parse(line) as AgentMessage)
    } catch {
      // A torn final line from a crash mid-write.
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown }
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    const calls = (m.content as { type: string; id?: string }[])
      .filter((c) => c.type === 'toolCall')
      .map((c) => c.id)
    const answered = new Set(
      messages
        .slice(i + 1)
        .flatMap((r) =>
          (r as { role?: string }).role === 'toolResult' ? [(r as { toolCallId?: string }).toolCallId] : [],
        ),
    )
    if (calls.some((id) => !answered.has(id))) messages.length = i
    break
  }
  return messages
}

/** Turns kept word for word when a new round of the chat starts; older tool output is elided. */
const KEEP_TURNS = 4

/**
 * Compacts a transcript at turn boundaries (a turn is a user message and everything after it until the next):
 * the latest turns stay verbatim, while older turns keep their messages but drop tool output and reasoning,
 * which is where the bulk is. The agent still sees what it did and decided, without paying for every page it read.
 */
export function compactTranscript(messages: readonly AgentMessage[], keepTurns = KEEP_TURNS): AgentMessage[] {
  const starts = messages.flatMap((m, i) => ((m as { role?: string }).role === 'user' ? [i] : []))
  const cut = starts.length > keepTurns ? (starts[starts.length - keepTurns] ?? 0) : 0
  return messages.map((m, i) => {
    if (i >= cut) return m
    const msg = m as { role?: string; content?: unknown }
    if (msg.role === 'toolResult' && Array.isArray(msg.content)) {
      const size = JSON.stringify(msg.content).length
      return {
        ...msg,
        content: [{ type: 'text', text: `[output from an earlier round elided, ${size} chars]` }],
      } as AgentMessage
    }
    if (msg.role === 'assistant' && Array.isArray(msg.content))
      return {
        ...msg,
        content: (msg.content as { type: string }[]).filter((c) => c.type !== 'thinking'),
      } as AgentMessage
    return m
  })
}

export interface ModelError {
  /** A refusal is the model declining (a policy filter); `error` is anything else that went wrong. */
  readonly kind: 'refusal' | 'error'
  readonly message: string
  readonly transient?: boolean
}

const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

export function classifyModelError(m: AssistantMessage): ModelError {
  const message = m.errorMessage?.trim() || 'the model returned an error with no message'
  if (/refus/i.test(message)) return { kind: 'refusal', message }
  const transient =
    (m.errorStatus !== undefined && TRANSIENT_STATUS.has(m.errorStatus)) ||
    /timed? ?out|ECONNRESET|ETIMEDOUT|socket hang up|overloaded|rate.?limit|temporar|try again/i.test(message)
  return { kind: 'error', message, transient }
}
