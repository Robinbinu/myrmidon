import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatus, EventId } from '@myrmidon/protocol'
import { Agent, type AgentEvent, type AgentMessage, type AgentState } from '@oh-my-pi/pi-agent-core'
import type { AssistantMessage } from '@oh-my-pi/pi-ai'
import { agentActor, type ColonyHost } from './host.ts'
import type { ModelResolver } from './models.ts'
import { kickoff, startsAwake, systemPrompt, thinkingFor, toolsFor } from './patterns.ts'
import type { AgentSpec } from './spec.ts'
import { buildAgentTools } from './tools.ts'
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
const MAX_CONSECUTIVE_FAILURES = 3

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
  private _failures = 0
  private readonly _agent: Agent
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
    resolver: ModelResolver,
    options: { restore?: boolean } = {},
  ) {
    this._transcript = join(host.workspace.colonyDir, 'agents', `${spec.name}.jsonl`)
    const history = options.restore ? readTranscript(this._transcript) : []
    this.restored = history.length
    const resolved = resolver.resolve(spec.model)
    const tools = buildAgentTools(spec.name, toolsFor(host.spec, spec), host)
    this._agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt(host.spec, spec, {
          sandbox: host.sandbox.kind,
          web: host.web !== noWebTools,
        }),
        model: resolved.model,
        tools,
        ...(history.length ? { messages: history } : {}),
        ...(resolved.model.reasoning
          ? { thinkingLevel: thinkingFor(host.spec, spec) as NonNullable<AgentState['thinkingLevel']> }
          : {}),
      },
      getApiKey: (m) => resolver.apiKey(m),
      ...(resolved.streamFn ? { streamFn: resolved.streamFn } : {}),
    })
    this._agent.subscribe((e) => this._onEvent(e))
  }

  get name() {
    return this.spec.name
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
      this.notify({ text: kickoff(this.host.spec, this.host.state()), trigger: 'kickoff' })
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
      if (this._failures >= MAX_CONSECUTIVE_FAILURES) {
        await this._status('failed', `${this._failures} consecutive failed turns`)
        return
      }
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
      const last = this._agent.state.messages.at(-1) as AssistantMessage | undefined
      this._failures = last?.role === 'assistant' && last.stopReason === 'error' ? this._failures + 1 : 0
      await this._deliverUnsentAnswer(from)
    } catch (err) {
      this._failures += 1
      await this._status('working', `turn error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
      this._requeueUnread()
      this.working = false
    }
    if (this._failures > 0 && this._failures < MAX_CONSECUTIVE_FAILURES) {
      await Bun.sleep(1000 * 2 ** this._failures)
      this.inbox.push({ text: 'Your previous turn failed. Check observe and continue.', trigger: 'retry' })
    }
    await this.host.append({
      type: 'agent/turn',
      actor: SYS,
      payload: { agent: this.name, phase: 'end', turn: this.turn, trigger },
    })
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
    try {
      mkdirSync(join(this._transcript, '..'), { recursive: true })
      appendFileSync(this._transcript, `${JSON.stringify(message)}\n`)
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

/** Turns kept word for word when a transcript is carried into a later round; older tool output is elided. */
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
