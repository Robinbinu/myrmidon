import type { AgentStatus, EventId } from '@myrmidon/protocol'
import { Agent, type AgentEvent, type AgentState } from '@oh-my-pi/pi-agent-core'
import type { AssistantMessage } from '@oh-my-pi/pi-ai'
import { agentActor, type ColonyHost } from './host.ts'
import type { ModelResolver } from './models.ts'
import { kickoff, startsAwake, systemPrompt, toolsFor } from './patterns.ts'
import type { AgentSpec } from './spec.ts'
import { buildAgentTools } from './tools.ts'
import { noWebTools } from './web.ts'

export interface InboxItem {
  readonly text: string
  readonly trigger: string
  readonly mail?: EventId
}

// A safety net only: one turn can include many model calls and large file writes.
const TURN_TIMEOUT_MS = 15 * 60_000
const MAX_CONSECUTIVE_FAILURES = 3

const SYS = { kind: 'system', id: 'scheduler' } as const

/**
 * One colony member: a pi-agent-core Agent plus an inbox. Idle agents sleep until something is
 * delivered; deliveries during a turn are steered into the running turn.
 */
export class ColonyAgent {
  readonly inbox: InboxItem[] = []
  turn = 0
  working = false
  private _wake?: () => void
  private _stopped = false
  private _failures = 0
  private readonly _agent: Agent

  constructor(
    readonly spec: AgentSpec,
    private readonly host: ColonyHost,
    resolver: ModelResolver,
  ) {
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
        ...(resolved.model.reasoning
          ? { thinkingLevel: 'low' as NonNullable<AgentState['thinkingLevel']> }
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
      this._agent.steer({ role: 'user', content: render([item]), timestamp: Date.now() })
      void this._markDelivered([item])
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

  /** Runs until the colony ends. Agents that do not start awake sleep until a task, mail, or mention wakes them. */
  async run(): Promise<void> {
    if (startsAwake(this.host.spec, this.spec))
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
    try {
      await this._agent.prompt(render(items))
      const last = this._agent.state.messages.at(-1) as AssistantMessage | undefined
      this._failures = last?.role === 'assistant' && last.stopReason === 'error' ? this._failures + 1 : 0
    } catch (err) {
      this._failures += 1
      await this._status('working', `turn error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
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
