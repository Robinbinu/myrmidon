import type { AgentMessage, StreamFn } from '@oh-my-pi/pi-agent-core'
import {
  type CompactionSettings,
  calculateContextTokens,
  DEFAULT_COMPACTION_SETTINGS,
  generateSummary,
  resolveBudgetReserveTokens,
  resolveThresholdTokens,
  shouldCompact,
} from '@oh-my-pi/pi-agent-core'
import type { Model, Usage } from '@oh-my-pi/pi-ai'
import { KEEP_MIN, KEEP_SHARE } from './config.ts'
import { prompts } from './prompts.ts'

/**
 * Keeps an agent's context inside its model's window, like omp's and Claude Code's auto-compaction. Before each
 * model call, once the context passes the threshold, the older part of the conversation is summarized and the model
 * sees that summary plus the recent messages. Each later pass folds the next stretch into the previous summary.
 * Only the request changes: the agent's stored messages, its transcript, and the colony log keep everything.
 *
 * Every size follows the current model's window, so moving a long conversation to a small model still fits: the
 * recent part kept word for word is a share of the window (opencode's rule), the summary is sized for the window it
 * lands in, and the summary is written by the largest-window model the agent has used (Codex's downshift rule), since
 * a small model cannot read the history it is asked to fold.
 */

export type Summarize = (
  messages: AgentMessage[],
  model: Model,
  reserveTokens: number,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
  previous: string | undefined,
) => Promise<string>

export interface Compacted {
  /** Messages folded into the summary so far. */
  readonly messages: number
  /** Estimated context size that triggered this pass. */
  readonly tokens: number
  readonly summaryChars: number
}

const keepTokens = (window: number, settings: CompactionSettings) =>
  Math.min(
    settings.keepRecentTokens,
    Math.max(KEEP_MIN, Math.floor(resolveThresholdTokens(window, settings) * KEEP_SHARE)),
  )

/** A rough token count for messages that have not been through the model yet. */
function estimate(messages: readonly AgentMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4)
}

export class ContextCompactor {
  private _summary?: { upTo: number; text: string }
  /** Models this agent has run on in this process, keyed `provider/id`. */
  private readonly _seen = new Map<string, Model>()
  private _forced = false

  constructor(
    private readonly options: {
      model(): Model
      /** A model's own stream function, for models that bring one (test models); others use pi's default. */
      stream?(model: Model): StreamFn | undefined
      /** Other models that may write the summary (those the restored history was written with); unusable ones are skipped. */
      summarizers?(): readonly Model[]
      apiKey(model: Model): Promise<string | undefined>
      onCompacted(info: Compacted): void
      summarize?: Summarize
      settings?: CompactionSettings
    },
  ) {}

  /** For pi's `transformContext`: returns the messages to send for this call. */
  async transform(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
    // Stored messages only grow, except when a failed reply is popped; a shorter history invalidates the cut.
    if (this._summary && messages.length < this._summary.upTo) this._summary = undefined
    const model = this.options.model()
    this._seen.set(`${model.provider}/${model.id}`, model)
    const window = model.contextWindow
    // Without a known window there is nothing to measure against; the provider's own limit errors still apply.
    if (!window) return this._view(messages)
    const settings = this.options.settings ?? DEFAULT_COMPACTION_SETTINGS
    const tokens = this._tokens(messages)
    const forced = this._forced
    this._forced = false
    if (!forced && !shouldCompact(tokens, window, settings)) return this._view(messages)
    const cut = this._cut(messages, keepTokens(window, settings) / (forced ? 2 : 1))
    const from = this._summary?.upTo ?? 0
    if (cut <= from) return this._view(messages)
    // The summary's budget comes from the window it must fit in, not from the model writing it.
    const text = await this._summarize(
      messages.slice(from, cut),
      model,
      resolveBudgetReserveTokens(window, settings),
      signal,
    )
    this._summary = { upTo: cut, text }
    this.options.onCompacted({ messages: cut, tokens, summaryChars: text.length })
    return this._view(messages)
  }

  /**
   * The provider rejected the last request as too long, though the estimate said it fit. The next call folds what
   * it can with half the usual recent part. Returns false when nothing is left to fold, so a retry cannot help.
   */
  overflowed(messages: readonly AgentMessage[]): boolean {
    const model = this.options.model()
    const settings = this.options.settings ?? DEFAULT_COMPACTION_SETTINGS
    const window = model.contextWindow
    if (!window) return false
    if (this._cut(messages, keepTokens(window, settings) / 2) <= (this._summary?.upTo ?? 0)) return false
    this._forced = true
    return true
  }

  private readonly _generate: Summarize = (messages, model, reserve, apiKey, signal, previous) => {
    const stream = this.options.stream?.(model)
    const completeImpl = stream
      ? async (m: Model, context: Parameters<StreamFn>[1], options: Parameters<StreamFn>[2]) =>
          (await stream(m, context, options)).result()
      : undefined
    return generateSummary(
      messages,
      model,
      reserve,
      apiKey as never,
      signal,
      prompts.compaction.focus,
      previous,
      {
        ...(completeImpl ? { completeImpl: completeImpl as never } : {}),
      },
    )
  }

  /** The estimated size of the context the next call would send, in tokens. */
  size(messages: AgentMessage[]): number {
    return this._tokens(messages)
  }

  /** Summarizes with the largest-window model that works, falling back to the current one. */
  private async _summarize(
    messages: AgentMessage[],
    current: Model,
    reserve: number,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const summarize = this.options.summarize ?? this._generate
    const byRef = new Map(
      [...this._seen.values(), ...(this.options.summarizers?.() ?? [])].map((m) => [
        `${m.provider}/${m.id}`,
        m,
      ]),
    )
    const others = [...byRef.values()]
      .filter((m) => (m.contextWindow ?? 0) > (current.contextWindow ?? 0))
      .sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))
    for (const model of others) {
      try {
        const key = await this.options.apiKey(model)
        return await summarize(messages, model, reserve, key, signal, this._summary?.text)
      } catch (err) {
        if (signal?.aborted) throw err
        // A model the agent used earlier may have lost its key or gone away since; the next one can still help.
        console.error(`compaction with ${model.provider}/${model.id} failed, trying another model:`, err)
      }
    }
    return summarize(
      messages,
      current,
      reserve,
      await this.options.apiKey(current),
      signal,
      this._summary?.text,
    )
  }

  private _view(messages: AgentMessage[]): AgentMessage[] {
    if (!this._summary) return messages
    const summary = {
      role: 'user',
      content: [{ type: 'text', text: `${prompts.compaction.summaryHeader}\n\n${this._summary.text}` }],
      timestamp: 0,
    } as AgentMessage
    return [summary, ...messages.slice(this._summary.upTo)]
  }

  /**
   * The context the next call would send: the last reply's reported context (which covered the view it was sent
   * with, including the system prompt and tools) plus an estimate for what arrived since.
   */
  private _tokens(messages: AgentMessage[]): number {
    const view = this._view(messages)
    for (let i = view.length - 1; i >= 0; i--) {
      const usage = (view[i] as { role?: string; usage?: Usage }).usage
      if ((view[i] as { role?: string }).role === 'assistant' && usage)
        return calculateContextTokens(usage) + estimate(view.slice(i + 1))
    }
    return estimate(view)
  }

  /**
   * Where the kept recent part starts: about `keep` tokens back from the end, moved to the start of a user or
   * assistant message so a tool call is never separated from its result.
   */
  private _cut(messages: readonly AgentMessage[], keep: number): number {
    let size = 0
    let i = messages.length
    while (i > 0 && size < keep) {
      i -= 1
      size += estimate([messages[i] as AgentMessage])
    }
    while (i < messages.length && (messages[i] as { role?: string }).role === 'toolResult') i += 1
    return i
  }
}
