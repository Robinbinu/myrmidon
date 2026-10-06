import type { AgentMessage } from '@oh-my-pi/pi-agent-core'
import {
  type CompactionSettings,
  calculateContextTokens,
  DEFAULT_COMPACTION_SETTINGS,
  effectiveReserveTokens,
  generateSummary,
  shouldCompact,
} from '@oh-my-pi/pi-agent-core'
import type { Model, Usage } from '@oh-my-pi/pi-ai'

/**
 * Keeps an agent's context inside its model's window, like omp's and Claude Code's auto-compaction. Before each
 * model call, once the context passes the threshold, the older part of the conversation is summarized and the model
 * sees that summary plus the recent messages. Each later pass folds the next stretch into the previous summary.
 * Only the request changes: the agent's stored messages, its transcript, and the colony log keep everything.
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

const SUMMARY_HEADER =
  '[Summary of your earlier work in this round. The full conversation is kept in the log; this replaces it to fit ' +
  'your context window.]'

const defaultSummarize: Summarize = (messages, model, reserve, apiKey, signal, previous) =>
  generateSummary(messages, model, reserve, apiKey as never, signal, undefined, previous)

/** A rough token count for messages that have not been through the model yet. */
function estimate(messages: readonly AgentMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4)
}

export class ContextCompactor {
  private _summary?: { upTo: number; text: string }

  constructor(
    private readonly options: {
      model(): Model
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
    const window = model.contextWindow
    // Without a known window there is nothing to measure against; the provider's own limit errors still apply.
    if (!window) return this._view(messages)
    const settings = this.options.settings ?? DEFAULT_COMPACTION_SETTINGS
    const tokens = this._tokens(messages)
    if (!shouldCompact(tokens, window, settings)) return this._view(messages)
    const cut = this._cut(messages, settings.keepRecentTokens)
    const from = this._summary?.upTo ?? 0
    if (cut <= from) return this._view(messages)
    const text = await (this.options.summarize ?? defaultSummarize)(
      messages.slice(from, cut),
      model,
      effectiveReserveTokens(window, settings),
      await this.options.apiKey(model),
      signal,
      this._summary?.text,
    )
    this._summary = { upTo: cut, text }
    this.options.onCompacted({ messages: cut, tokens, summaryChars: text.length })
    return this._view(messages)
  }

  private _view(messages: AgentMessage[]): AgentMessage[] {
    if (!this._summary) return messages
    const summary = {
      role: 'user',
      content: [{ type: 'text', text: `${SUMMARY_HEADER}\n\n${this._summary.text}` }],
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
  private _cut(messages: AgentMessage[], keep: number): number {
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
