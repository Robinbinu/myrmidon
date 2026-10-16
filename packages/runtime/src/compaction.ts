import type { CompactionMethod } from '@myrmidon/protocol'
import {
  COMPACTION_ORDER,
  COMPACTION_SETTLED,
  KEEP_MIN,
  KEEP_SHARE,
  SHAKE_KEPT_TOOLS,
  SHAKE_MIN_SHARE,
  SHAKE_MIN_TOKENS,
} from './config.ts'
import type { AgentMessage, StreamFn, ToolResultShakeRegion } from './omp/agent-core.ts'
import {
  applyShakeRegions,
  base64ImageSize,
  type CompactionSettings,
  calculateContextTokens,
  collectShakeRegions,
  DEFAULT_COMPACTION_SETTINGS,
  DEFAULT_RESERVE_TOKENS,
  DEFAULT_SHAKE_CONFIG,
  generateSummary,
  resolveBudgetReserveTokens,
  resolveThresholdTokens,
  type SessionEntry,
  shouldCompact,
  Tokenizer,
} from './omp/agent-core.ts'
import type { ImageContent, Message, Model, TextContent, ToolResultMessage, Usage } from './omp/ai.ts'
import * as snapcompact from './omp/snapcompact.ts'
import { prompts } from './prompts.ts'
import { hideInMessages, hideSecrets } from './provider-secrets.ts'
import { tokensOf } from './tokens.ts'

/**
 * Keeps an agent's context inside its model's window, like omp's and Claude Code's auto-compaction. Before each
 * model call, once the context passes the threshold, the methods of COMPACTION_ORDER run cheapest first until one
 * leaves it comfortably under: shake elides old bulky tool output, snapcompact archives the older part as text images
 * a vision model reads back, and a model summarizes it. Each later fold takes in the previous one. Only the request
 * changes: the agent's stored messages, its transcript, and the colony log keep everything.
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
  /** Messages folded into the summary or archive so far. */
  readonly messages: number
  /** Estimated context size that triggered this pass. */
  readonly tokens: number
  /** Length of the summary or archive guide this pass wrote (0 when it only shook). */
  readonly summaryChars: number
  /** The methods that changed the context in this pass, in order; the last one settled it. */
  readonly methods: CompactionMethod[]
  /** Tool results shake elided in this pass. */
  readonly elided: number
  /** Image frames of the archive snapcompact wrote in this pass. */
  readonly frames: number
  /** Estimated context size after this pass. */
  readonly tokensAfter: number
}

/** The older part of the conversation, replaced in the request by a summary or a snapcompact archive. */
interface Fold {
  /** Messages before this index are folded. */
  readonly upTo: number
  readonly method: 'summary' | 'snapcompact'
  /** The summary, or the archive's reading guide. */
  readonly text: string
  /** snapcompact's archive (its preserveData), which the next fold re-renders with the newly folded messages. */
  readonly archive?: Record<string, unknown>
  /** The archive as request blocks: its text edges and image frames. */
  readonly blocks?: readonly (TextContent | ImageContent)[]
}

/** One tool result shake elides: omp's region for its text, which also loses its images. */
interface Shaken {
  readonly index: number
  readonly region: ToolResultShakeRegion
  readonly placeholder: string
  readonly placeholderTokens: number
}

const keepTokens = (window: number, settings: CompactionSettings) =>
  Math.min(
    settings.keepRecentTokens,
    Math.max(KEEP_MIN, Math.floor(resolveThresholdTokens(window, settings) * KEEP_SHARE)),
  )

const readsImages = (model: Model) => model.input?.includes('image') === true

/**
 * snapcompact's text edges and reading guide, which an archive carries on top of its frames: omp's sizing of the
 * same (two edge pages of the frame shape at ~4 chars a token with 15% slack, and ~2k tokens of guide).
 */
const archiveOverhead = (shape: snapcompact.Shape) =>
  Math.ceil((2 * snapcompact.geometry(shape).capacity * 1.15) / 4) + 2_000

/**
 * A token count for messages that have not been through the model yet, by the model's tokenizer (tokens.ts), each
 * message as the JSON it travels in. An image counts by its pixel size, as providers bill it, not by the length of
 * its base64 data.
 */
function estimate(messages: readonly AgentMessage[], model: Model): number {
  let tokenizer: Tokenizer | undefined
  let images = 0
  const parts = messages.map((m) =>
    JSON.stringify(m, (_key, value) => {
      if (value?.type === 'image' && typeof value.data === 'string') {
        tokenizer ??= new Tokenizer(model)
        images += imageTokens(tokenizer, value)
        return { type: 'image' }
      }
      return value
    }),
  )
  return tokensOf(parts, model) + images
}

/** One image's input tokens at the reading model's catalog image rule, from the pixel size in its header. */
const imageTokens = (tokenizer: Tokenizer, image: ImageContent) =>
  tokenizer.imageTokens(base64ImageSize(image.data), image.detail)

export class ContextCompactor {
  private _fold?: Fold
  /** Tool results shake elided, by the stored message each stands in for. */
  private readonly _shaken = new WeakMap<AgentMessage, AgentMessage>()
  private _shook = false
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
      /** The methods to try, in order; COMPACTION_ORDER by default. */
      order?: readonly CompactionMethod[]
    },
  ) {}

  /** For pi's `transformContext`: returns the messages to send for this call. */
  async transform(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
    // Stored messages only grow, except when a failed reply is popped; a shorter history invalidates the cut.
    if (this._fold && messages.length < this._fold.upTo) this._fold = undefined
    const model = this.options.model()
    this._seen.set(`${model.provider}/${model.id}`, model)
    const window = model.contextWindow
    const settings = this.options.settings ?? DEFAULT_COMPACTION_SETTINGS
    if (this._fold?.method === 'snapcompact' && !readsImages(model))
      await this._toText(model, window ?? undefined, signal)
    // Without a known window there is nothing to measure against; the provider's own limit errors still apply.
    if (!window) return this._view(messages)
    const tokens = this._tokens(messages)
    const forced = this._forced
    this._forced = false
    if (!forced && !shouldCompact(tokens, window, settings)) return this._view(messages)

    const keep = keepTokens(window, settings) / (forced ? 2 : 1)
    const threshold = resolveThresholdTokens(window, settings)
    const settled = Math.floor(threshold * COMPACTION_SETTLED)
    const methods: CompactionMethod[] = []
    let after = tokens
    let elided = 0
    let frames = 0
    let written = 0
    for (const method of this.options.order ?? COMPACTION_ORDER) {
      if (method === 'shake') {
        const shaken = this._shakePlan(messages, model, keep, threshold)
        if (!shaken) continue
        after = Math.max(0, after - this._shake(messages, shaken))
        elided = shaken.length
        methods.push('shake')
        // After an overflow the estimate has proved too low, so an elision that looks enough by it is not trusted to
        // be: the pass goes on to fold, when there is anything to fold.
        if (!forced && after <= settled) break
        continue
      }
      const cut = this._cut(messages, keep)
      const from = this._fold?.upTo ?? 0
      if (cut <= from) continue
      // What the fold replaces: the previous fold and the messages up to the cut, as the last view sent them.
      const replaced = this._estimate(this._view(messages).slice(0, (this._fold ? 1 : 0) + cut - from))
      const folded = messages.slice(from, cut).map((m) => this._shaken.get(m) ?? m)
      if (method === 'snapcompact') {
        if (!readsImages(model)) continue
        const archived = await this._snapcompact(folded, model, cut, after - replaced, settled)
        if (!archived) continue
        this._fold = archived.fold
        after = archived.after
        frames = archived.frames
        written = archived.fold.text.length
        methods.push('snapcompact')
        break
      }
      // The summary's budget comes from the window it must fit in, not from the model writing it.
      const text = await this._summarize(folded, model, resolveBudgetReserveTokens(window, settings), signal)
      this._fold = { upTo: cut, method: 'summary', text }
      after = after - replaced + this._estimate([this._foldMessage(this._fold)])
      written = text.length
      methods.push('summary')
      break
    }
    if (methods.length > 0)
      this.options.onCompacted({
        messages: this._fold?.upTo ?? 0,
        tokens,
        summaryChars: written,
        methods,
        elided,
        frames,
        tokensAfter: Math.max(0, Math.round(after)),
      })
    return this._view(messages)
  }

  /**
   * The provider rejected the last request as too long, though the estimate said it fit. The next call folds what
   * it can with half the usual recent part. Returns false when nothing is left to fold or elide, so a retry cannot help.
   */
  overflowed(messages: readonly AgentMessage[]): boolean {
    const model = this.options.model()
    const settings = this.options.settings ?? DEFAULT_COMPACTION_SETTINGS
    const window = model.contextWindow
    if (!window) return false
    const order = this.options.order ?? COMPACTION_ORDER
    const keep = keepTokens(window, settings) / 2
    const folds =
      order.some((m) => m === 'summary' || (m === 'snapcompact' && readsImages(model))) &&
      this._cut(messages, keep) > (this._fold?.upTo ?? 0)
    const shakes =
      order.includes('shake') &&
      this._shakePlan(messages, model, keep, resolveThresholdTokens(window, settings)) !== undefined
    if (!folds && !shakes) return false
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
      hideInMessages(messages),
      model,
      reserve,
      apiKey as never,
      signal,
      prompts.compaction.focus(new Date().toISOString().slice(0, 10)),
      previous === undefined ? undefined : hideSecrets(previous),
      {
        ...(completeImpl ? { completeImpl: completeImpl as never } : {}),
      },
    )
  }

  /** The estimated size of the context the next call would send, in tokens. */
  size(messages: AgentMessage[]): number {
    return this._tokens(messages)
  }

  /**
   * Bulky tool results old enough to elide, chosen by omp's shake (outside the recent part, not a protected tool, not
   * elided before), with their images, or none when the pass would free too little to be worth the prompt cache it
   * breaks. omp's shake keeps images and passes over results without text, so results that are only images (an
   * image read with fs_read) are added here by the same recent-part rule.
   */
  private _shakePlan(
    messages: readonly AgentMessage[],
    model: Model,
    protect: number,
    threshold: number,
  ): Shaken[] | undefined {
    const from = this._fold?.upTo ?? 0
    const tokenizer = new Tokenizer(model)
    const entries = messages.slice(from).map(
      (m, i) =>
        ({
          type: 'message',
          id: String(from + i),
          parentId: null,
          timestamp: '',
          message: this._shaken.get(m) ?? m,
        }) as SessionEntry,
    )
    const regions = collectShakeRegions(entries, tokenizer, {
      ...DEFAULT_SHAKE_CONFIG,
      protectTokens: protect,
      // Judged below with images counted, which omp's shake leaves out.
      minSavings: 0,
      protectedTools: [...SHAKE_KEPT_TOOLS],
    }).filter(
      // Fenced blocks in messages stay: those are the person's and crewmates' words, which the summary keeps verbatim.
      (r): r is ToolResultShakeRegion => r.kind === 'toolResult',
    )
    const withText = new Set<SessionEntry>(regions.map((r) => r.entry))
    let after = 0
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as ToolResultShakeRegion['entry']
      const old = after >= protect
      after += tokenizer.countMessage(entry.message)
      const result = entry.message as ToolResultMessage
      if (!old || withText.has(entry) || result.role !== 'toolResult' || result.prunedAt !== undefined)
        continue
      if (SHAKE_KEPT_TOOLS.includes(result.toolName) || !result.content.some((c) => c.type === 'image'))
        continue
      regions.push({ kind: 'toolResult', entry, tokens: 0, originalText: '', label: result.toolName })
    }
    const plan: Shaken[] = []
    let freed = 0
    for (const region of regions) {
      const images = (region.entry.message as ToolResultMessage).content.filter(
        (c): c is ImageContent => c.type === 'image',
      )
      const tokens = region.tokens + images.reduce((n, c) => n + imageTokens(tokenizer, c), 0)
      if (tokens < SHAKE_MIN_TOKENS) continue
      const placeholder = prompts.compaction.shaken(region.label, tokens, images.length)
      const placeholderTokens = tokenizer.countTokens(placeholder)
      plan.push({ index: Number(region.entry.id), region, placeholder, placeholderTokens })
      freed += tokens - placeholderTokens
    }
    const minSavings = Math.min(DEFAULT_SHAKE_CONFIG.minSavings, Math.floor(threshold * SHAKE_MIN_SHARE))
    return plan.length > 0 && freed >= minSavings ? plan : undefined
  }

  /** Elides the planned tool results from the request; returns the tokens freed. */
  private _shake(messages: readonly AgentMessage[], plan: readonly Shaken[]): number {
    let freed = 0
    for (const { index, region, placeholder, placeholderTokens } of plan) {
      const stored = messages[index] as AgentMessage
      const current = region.entry.message as ToolResultMessage
      const before = this._estimate([current])
      // omp's shake rewrites the message in place; here the stored conversation stays whole, so it works on a copy.
      const copy = { ...current, content: [...current.content] }
      ;(region.entry as { message: AgentMessage }).message = copy as AgentMessage
      applyShakeRegions([{ region, replacement: placeholder, replacementTokens: placeholderTokens }])
      copy.content = copy.content.filter((c) => c.type !== 'image')
      // A result that was only images has no text for omp's shake to replace.
      if (!copy.content.some((c) => c.type === 'text' && c.text === placeholder)) {
        copy.content = [{ type: 'text', text: placeholder }]
        copy.prunedAt = Date.now()
      }
      this._shaken.set(stored, copy as AgentMessage)
      freed += before - this._estimate([copy as AgentMessage])
    }
    this._shook = true
    return Math.max(0, freed)
  }

  /**
   * Archives `folded` (with the previous fold) onto snapcompact frames sized to land under `settled`, the way omp
   * sizes them: the frames fill what the kept part (`base`), the text edges and the reading guide leave. Returns none
   * when the archive cannot render the text or would not fit, so the next method runs.
   */
  private async _snapcompact(
    folded: AgentMessage[],
    model: Model,
    cut: number,
    base: number,
    settled: number,
  ): Promise<{ fold: Fold; after: number; frames: number } | undefined> {
    const previous = this._fold
    // Before the text is drawn into images: a secret in a picture could not be hidden from the provider afterwards.
    const hidden = hideInMessages(folded)
    const preparation: snapcompact.CompactionPreparation<AgentMessage> = {
      firstKeptEntryId: String(cut),
      messagesToSummarize: hidden,
      turnPrefixMessages: [],
      tokensBefore: Math.round(base),
      ...(previous?.method === 'summary' ? { previousSummary: previous.text } : {}),
      ...(previous?.archive ? { previousPreserveData: previous.archive } : {}),
      fileOps: snapcompact.createFileOps(),
    }
    // Reasoning stays out: it is the least needed part of the history, and Claude refuses its own reasoning played
    // back to it as text (omp issue #6093).
    const serialized = snapcompact.serializeConversation(hidden as Message[], { includeThinking: false })
    const probe = snapcompact.renderabilityProbeText(
      serialized,
      previous?.archive,
      preparation.previousSummary,
    )
    const shape = snapcompact.resolveShapeForText(probe, model)
    if (!snapcompact.scanRenderability(probe, { shape }).isSafe) return undefined
    const room = settled - base - archiveOverhead(shape)
    if (room <= 0) return undefined
    const frameCost = Math.max(snapcompact.FRAME_TOKEN_ESTIMATE, shape.frameTokenEstimate)
    const frameBytes = snapcompact.frameDataBytesBudget(model)
    const maxFrames = Math.max(
      1,
      Math.min(
        Math.floor(room / frameCost),
        snapcompact.MAX_FRAMES_DEFAULT,
        snapcompact.maxFramesForDataBudget(shape, frameBytes),
        snapcompact.providerFrameBudget(model),
      ),
    )
    const result = await snapcompact.compact(preparation, { model, shape, maxFrames, includeThinking: false })
    const archive = snapcompact.getPreservedArchive(result.preserveData)
    if (archive && snapcompact.frameDataBytes(archive.frames) > frameBytes) return undefined
    const fold: Fold = {
      upTo: cut,
      method: 'snapcompact',
      text: result.summary,
      ...(result.preserveData ? { archive: result.preserveData } : {}),
      blocks: archive ? snapcompact.historyBlocks(archive, { maxFrameDataBytes: frameBytes }) : [],
    }
    // The text edges have a floor of their own: on a small window they can cost more than the summary would.
    const after = base + this._estimate([this._foldMessage(fold)])
    if (after > settled) return undefined
    return { fold, after, frames: archive?.frames.length ?? 0 }
  }

  /**
   * The agent moved to a model that cannot read images: the archive's frames would be dropped from its requests, so
   * the archive's text is summarized once (the summarizer folds text larger than its window piece by piece).
   */
  private async _toText(model: Model, window: number | undefined, signal: AbortSignal | undefined) {
    const fold = this._fold
    if (!fold) return
    const archive = snapcompact.getPreservedArchive(fold.archive)
    const settings = this.options.settings ?? DEFAULT_COMPACTION_SETTINGS
    const reserve = window ? resolveBudgetReserveTokens(window, settings) : DEFAULT_RESERVE_TOKENS
    const archived = {
      role: 'user',
      content: [{ type: 'text', text: (archive && snapcompact.archiveSourceText(archive)) ?? '' }],
      timestamp: 0,
    } as AgentMessage
    const before = this._estimate([this._foldMessage(fold)])
    const text = await this._summarize([archived], model, reserve, signal, undefined)
    this._fold = { upTo: fold.upTo, method: 'summary', text }
    this.options.onCompacted({
      messages: fold.upTo,
      tokens: before,
      summaryChars: text.length,
      methods: ['summary'],
      elided: 0,
      frames: 0,
      tokensAfter: this._estimate([this._foldMessage(this._fold)]),
    })
  }

  /** Summarizes with the largest-window model that works, falling back to the current one. */
  private async _summarize(
    messages: AgentMessage[],
    current: Model,
    reserve: number,
    signal: AbortSignal | undefined,
    previous = this._previousText(),
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
        return await summarize(messages, model, reserve, key, signal, previous)
      } catch (err) {
        if (signal?.aborted) throw err
        // A model the agent used earlier may have lost its key or gone away since; the next one can still help.
        console.error(`compaction with ${model.provider}/${model.id} failed, trying another model:`, err)
      }
    }
    return summarize(messages, current, reserve, await this.options.apiKey(current), signal, previous)
  }

  /**
   * What the next summary folds forward: the previous summary, or a snapcompact archive's text, of which the newest
   * part is kept as large as a summary would be, since the summarizer reads it whole.
   */
  private _previousText(): string | undefined {
    const fold = this._fold
    if (!fold || fold.method === 'summary') return fold?.text
    const archive = snapcompact.getPreservedArchive(fold.archive)
    const text = archive && snapcompact.archiveSourceText(archive)
    return text ? text.slice(-DEFAULT_RESERVE_TOKENS * 4) : undefined
  }

  private _foldMessage(fold: Fold): AgentMessage {
    const header =
      fold.method === 'snapcompact' ? prompts.compaction.archiveHeader : prompts.compaction.summaryHeader
    return {
      role: 'user',
      content: [{ type: 'text', text: `${header}\n\n${fold.text}` }, ...(fold.blocks ?? [])],
      timestamp: 0,
    } as AgentMessage
  }

  /** Tokens these messages take for the model the agent calls now. */
  private _estimate(messages: readonly AgentMessage[]): number {
    return estimate(messages, this.options.model())
  }

  private _view(messages: AgentMessage[]): AgentMessage[] {
    if (!this._fold && !this._shook) return messages
    const kept = messages.slice(this._fold?.upTo ?? 0).map((m) => this._shaken.get(m) ?? m)
    return this._fold ? [this._foldMessage(this._fold), ...kept] : kept
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
        return calculateContextTokens(usage) + this._estimate(view.slice(i + 1))
    }
    return this._estimate(view)
  }

  /**
   * Where the kept recent part starts: about `keep` tokens back from the end (as the request carries it, elisions
   * included), moved to the start of a user or assistant message so a tool call is never separated from its result.
   */
  private _cut(messages: readonly AgentMessage[], keep: number): number {
    let size = 0
    let i = messages.length
    while (i > 0 && size < keep) {
      i -= 1
      const m = messages[i] as AgentMessage
      size += this._estimate([this._shaken.get(m) ?? m])
    }
    while (i < messages.length && (messages[i] as { role?: string }).role === 'toolResult') i += 1
    return i
  }
}
