import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AgentStatus, type CallRecord, type EventId, recipientsOf } from '@myrmidon/protocol'
import { ContextCompactor } from './compaction.ts'
import { ANTHROPIC_MEMBERS, anthropicToolsetPayload, computerProtocol } from './computer/actions.ts'
import { COMPUTER_TOOL, computerMember } from './computer/tool.ts'
import {
  FALLBACK_COOLDOWN_MS,
  KEEP_TURNS,
  MODEL_RETRIES,
  QUIET_KEPT,
  STREAM_RULE_RETRIES,
  TRANSIENT_STATUS,
  TURN_TIMEOUT_MS,
} from './config.ts'
import { agentActor, type ColonyHost } from './host.ts'
import { type ModelResolver, withOllamaContext } from './models.ts'
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentState,
  type AgentTurnEndContext,
  type StreamFn,
} from './omp/agent-core.ts'
import {
  type AssistantMessage,
  isContextOverflow,
  type Model,
  streamSimple,
  type ToolResultMessage,
} from './omp/ai.ts'
import { getModelPricingStatus } from './omp/catalog.ts'
import {
  kickoff,
  onDemand,
  preloaded,
  speaksForColony,
  startsAwake,
  toolsFor,
  withCompanions,
} from './patterns.ts'
import { type AssembledPrompt, assemble } from './prompt/assemble.ts'
import { factsFor, type PromptFacts } from './prompt/facts.ts'
import { prompts } from './prompts.ts'
import { hideInContext, restoreSecrets, secretsHidden } from './provider-secrets.ts'
import { redactDeep } from './secrets.ts'
import type { AgentSpec } from './spec.ts'
import { rulesFor, StreamRuleGuard } from './stream-rules.ts'
import { agentEffort } from './thinking.ts'
import { buildAgentTools, matchTools } from './tools.ts'
import { noWebTools } from './web.ts'

export interface InboxItem {
  readonly text: string
  readonly trigger: string
  readonly mail?: EventId
  /** Several messages in one item (catching up on what was missed): each is recorded as read when it is seen. */
  readonly mails?: readonly EventId[]
  /** Arriving mid-turn, wait until the agent finishes its current work instead of joining its next step. */
  readonly queue?: boolean
  /** Seen, not a reason to wake: it waits for whatever wakes the agent next (team chat it was not @mentioned in). */
  readonly quiet?: boolean
}

const SYS = { kind: 'system', id: 'scheduler' } as const
/** Tools that put something in front of the person; a turn that used one has already spoken. */
const REPLY_TOOLS = new Set(['reply_user', 'reply_person', 'ask_user'])
/** Tools that hand the conversation to a crewmate: text written after one is a holding line, not an answer. */
const HANDOFF_TOOLS = new Set(['message', 'create_group'])

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
  /** A note for the start of the next turn, from an interrupt that cut this one short. */
  private _afterTurn?: InboxItem
  private _failed = false
  private readonly _agent: Agent
  /** The current model's own stream function, if it has one (test models); otherwise pi's default. */
  private _stream?: StreamFn
  /** The model the latest call streamed with: a reply is priced by it, even if the agent switched model meanwhile. */
  private _streamedWith?: Model
  /** The model this agent was set up with, or the person last switched it to: its fallbacks stand in for it. */
  private _primary: string
  /** When each model this agent fell back from failed; it is not tried again until FALLBACK_COOLDOWN_MS has passed. */
  private readonly _failedAt = new Map<string, number>()
  private readonly _compactor = new ContextCompactor({
    model: () => this._agent.state.model,
    summarizers: () => this._earlierModels(),
    stream: (m) => (m === this._agent.state.model ? this._stream : undefined),
    apiKey: (m) => this.resolver.apiKey(m),
    onCompacted: (info) =>
      void this.host.append({
        type: 'agent/compacted',
        actor: agentActor(this.spec.name),
        payload: { agent: this.spec.name, ...info },
      }),
  })
  /**
   * Mid-turn deliveries not yet read, kept whole (trigger and flags) for a requeue, keyed by the message timestamp pi
   * echoes back when it injects them.
   */
  private readonly _unread = new Map<number, InboxItem>()
  private _stamp = 0
  /** Every finished message of this agent's conversation, one JSON line each, like an omp session file. */
  private readonly _transcript: string
  /** Messages restored from the transcript when a stopped colony resumed. */
  readonly restored: number
  /** What this agent's prompt and tool descriptions were built from, and the prompt itself. */
  private readonly _facts: PromptFacts
  private readonly _prompt: AssembledPrompt
  /** The person's stream rules, enforced on this agent's model calls; each stop is logged as `rule/fired`. */
  private readonly _rules: StreamRuleGuard

  constructor(
    readonly spec: AgentSpec,
    private readonly host: ColonyHost,
    private readonly resolver: ModelResolver,
    /** `compact`: a new round of the chat, so earlier rounds' tool output is elided from the restored history. */
    options: { restore?: boolean; compact?: boolean } = {},
  ) {
    this._transcript = join(host.workspace.colonyDir, 'agents', `${spec.name}.jsonl`)
    const restored = options.restore
      ? readTranscript(this._transcript, (callId) => host.recordedCall?.(spec.name, callId))
      : []
    const history = options.compact ? compactTranscript(restored) : restored
    this.restored = history.length
    const resolved = resolver.resolve(spec.model)
    this._primary = spec.model
    this._stream = resolved.streamFn
    this._facts = factsFor(host.spec, spec, {
      sandbox: host.sandbox.kind,
      web: host.web !== noWebTools,
      browser: host.browser !== undefined,
      computer: host.computer !== undefined,
      ...(host.computer ? { computerEngine: host.computer.engine } : {}),
      boundary: host.boundary,
      ...(host.project ? { project: host.project } : {}),
      ...(host.workspace.isolation(spec.name) ? { worktree: host.workspace.isolation(spec.name) } : {}),
      scratch: host.workspace.scratch(spec.name),
      skills: host.skills(),
      plugins: host.pluginPrompts(speaksForColony(host.spec, spec) ? 'lead' : 'worker'),
      secretsHidden: secretsHidden(),
    })
    this._prompt = assemble(this._facts)
    this._rules = new StreamRuleGuard({
      retries: STREAM_RULE_RETRIES,
      cwd: () => host.workspace.workdir(spec.name),
      ...(host.spec.chat?.project?.path ? { project: host.spec.chat.project.path } : {}),
      onFire: (fire) =>
        void host
          .append({
            type: 'rule/fired',
            actor: SYS,
            payload: {
              agent: spec.name,
              rule: fire.rule.name,
              ...(fire.rule.description ? { description: fire.rule.description } : {}),
              source: fire.source,
              ...(fire.tool ? { tool: fire.tool } : {}),
              path: fire.path,
            },
          })
          .catch((err) => console.error(`[${spec.name}] failed to log a stream rule:`, err)),
    })
    const tools = buildAgentTools(spec.name, this._facts.tools.names, host, this._model, this._facts)
    for (const name of preloaded(
      host.spec.chat?.request ?? host.spec.mission,
      tools.map((t) => t.name),
    ))
      this._loaded.add(name)
    this._agent = new Agent({
      initialState: {
        systemPrompt: this._prompt.system,
        model: resolved.model,
        tools,
        ...(history.length ? { messages: history } : {}),
        thinkingLevel: this._effort(resolved.model),
      },
      getApiKey: (m) => resolver.apiKey(m),
      // Everything that came in while a step ran is read at the next one, as when someone looks at a busy chat; one
      // message per step (pi's default) leaves a busy agent further behind with every burst.
      steeringMode: 'all',
      // Tools see their call's provider metadata and batch: OpenAI's native computer actions arrive that way.
      getToolContext: (call) => (call ? ({ toolCall: call } as never) : undefined),
      // Anthropic's computer toolset calls each action by its own name (left_click, scroll…).
      resolveFallbackTool: (name, advertised) =>
        ANTHROPIC_MEMBERS.has(name) &&
        advertised.some((t) => t.name === COMPUTER_TOOL) &&
        computerProtocol(this._agent.state.model) === 'anthropic'
          ? computerMember(name, this.spec.name, this.host, this._model)
          : undefined,
      transformContext: (messages, signal) => this._compactor.transform(messages, signal),
      // pi reads the model afresh each step but keeps the stream function for a whole loop; dispatching here lets
      // a mid-round model switch reach models that bring their own stream too.
      // On-demand tools stay callable but are left out of the request until loaded (find_tools), so their
      // definitions do not ride along in every model call.
      // The person's stream rules wrap the call, so a reply they stop is sent again through the same hiding.
      streamFn: this._rules.wrap((model, context, options) => {
        this._streamedWith = model
        const tools = context.tools?.filter((t) => this._shown(t.name))
        // Here, the one place every model call of the agent loop passes, so no request leaves with a secret in it.
        return (this._stream ?? streamSimple)(
          model,
          hideInContext(tools ? { ...context, tools } : context),
          withComputerToolset(model, tools, withOllamaContext(model, options)),
        )
      }),
      // Only the arguments the tool runs with: the conversation keeps the placeholder the model wrote.
      transformToolCallArguments: (args, tool) =>
        restoreSecrets(tool, args, {
          inside: (path) => host.workspace.keepsInside(spec.name, path),
          confined: !host.fullAccess && host.sandbox.kind !== 'none',
        }),
    })
    this._agent.subscribe((e) => this._onEvent(e))
    this._agent.setOnTurnEnd((messages, signal, context) => {
      if (!signal?.aborted) this._atTurnEnd(messages, context)
    })
    // A signed-off agent stops before its next model call; aborting once pi has sent it would bill a request and
    // leave an aborted reply in its history. Something written to it meanwhile still gets its answer.
    this._agent.setBeforeModelCall((context) =>
      this._endAfterStep && context.messages.at(-1)?.role !== 'user'
        ? { stop: true, reason: 'signed off: final answer sent' }
        : undefined,
    )
  }

  get name() {
    return this.spec.name
  }

  /**
   * Moves this agent to another model from its next step on, as the person chose; its conversation so far carries
   * over, and its fallbacks now stand in for this model.
   */
  switchModel(ref: string) {
    this._use(ref)
    this._primary = ref
    this._failedAt.delete(ref)
  }

  private _use(ref: string) {
    const resolved = this.resolver.resolve(ref)
    this._agent.setModel(resolved.model)
    this._stream = resolved.streamFn
    this._agent.setThinkingLevel(this._effort(resolved.model))
    ;(this.spec as { model: string }).model = ref
  }

  /** How hard `model` thinks for this agent (thinking.ts). */
  private _effort(model: Model): AgentState['thinkingLevel'] {
    return agentEffort(model, this.host.spec, this.spec) as AgentState['thinkingLevel']
  }

  /** On-demand tools this agent loaded with find_tools; the rest stay out of its model calls. */
  private readonly _loaded = new Set<string>()

  private _shown(name: string): boolean {
    return !onDemand(name) || this._loaded.has(name)
  }

  /** The model this agent calls now (it may switch mid-round); sizes computer use's screenshots. */
  private readonly _model = (): Model => this._agent.state.model

  /** Picks up tools made since this agent started; takes effect on its next model call. */
  refreshTools() {
    this._agent.setTools(
      buildAgentTools(
        this.spec.name,
        toolsFor(this.host.spec, this.spec),
        this.host,
        this._model,
        this._facts,
      ),
    )
  }

  /** Shows these on-demand tools, and those that work with them, in this agent's next model calls. */
  load(names: readonly string[]) {
    for (const name of withCompanions(names)) this._loaded.add(name)
  }

  /** Loads the on-demand tools matching `query` for this agent's next steps (find_tools). */
  loadTools(query: string): string {
    const waiting = this._agent.state.tools.filter((t) => !this._shown(t.name))
    const matched = matchTools(waiting, query)
    const companions = withCompanions(matched.found.map((t) => t.name))
    const found = [
      ...matched.found,
      ...waiting.filter((t) => companions.includes(t.name) && !matched.found.includes(t)),
    ]
    const more = matched.more.filter((t) => !found.includes(t))
    if (found.length === 0) {
      const names = waiting.map((t) => t.name)
      return names.length ? prompts.agent.noMatch(query, names) : prompts.agent.allLoaded
    }
    this.load(found.map((t) => t.name))
    const first = (d: string) => d.split(/(?<=\.)\s/)[0] ?? d
    return `${prompts.agent.loaded(found.map((t) => `- ${t.name}: ${first(t.description)}`).join('\n'))}${
      more.length ? prompts.agent.more(more.map((t) => t.name)) : ''
    }`
  }

  get idle() {
    return !this.working && this.inbox.length === 0
  }

  /**
   * The exploration checkpoint this agent holds (the checkpoint tool), after omp's CheckpointState: `kept` is how many
   * messages stay once it rewinds (through the checkpoint's own step), `report` what rewind will leave in their place.
   */
  private _checkpoint?: { goal: string; kept?: number; report?: string; reminded?: boolean }
  /** Set once a checkpoint has rewound, so a second rewind is told the report is already in place. */
  private _rewound = false

  /** Marks the point the agent's context goes back to once it rewinds (checkpoint). */
  checkpoint(goal: string): string {
    if (this._checkpoint) throw new Error(prompts.checkpoint.active)
    this._checkpoint = { goal }
    this._rewound = false
    return prompts.checkpoint.started(goal)
  }

  /** Ends the checkpoint: at the end of this step the exploration since it is replaced by `report` (rewind). */
  rewind(report: string): string {
    if (!this._checkpoint) throw new Error(this._rewound ? prompts.checkpoint.done : prompts.checkpoint.none)
    if (!report.trim()) throw new Error(prompts.checkpoint.empty)
    this._checkpoint.report = report.trim()
    return prompts.checkpoint.rewinding
  }

  /**
   * After each step, as omp's onTurnEnd: notes where a new checkpoint stands, applies a rewind the step asked for, and
   * reminds an agent that is about to stop with a checkpoint still open. `messages` is the loop's live context.
   */
  private _atTurnEnd(messages: AgentMessage[], context?: AgentTurnEndContext) {
    const cp = this._checkpoint
    if (!cp) return
    if (cp.kept === undefined) {
      const at = messages.findLastIndex(
        (m) => m.role === 'toolResult' && m.toolName === 'checkpoint' && !m.isError,
      )
      if (at < 0) return
      // The step's other results stay with it: a call never loses its result.
      let kept = at + 1
      while (messages[kept]?.role === 'toolResult') kept++
      cp.kept = kept
    }
    if (cp.report !== undefined) return this._applyRewind(messages, cp.kept, cp.goal, cp.report, context)
    const last = context?.message
    const stopping =
      last?.role === 'assistant' && !last.content.some((c) => c.type === 'toolCall') && !context?.willContinue
    if (stopping && !cp.reminded) {
      cp.reminded = true
      this._agent.steer({ role: 'user', content: prompts.checkpoint.remind, timestamp: Date.now() })
    }
  }

  /**
   * Replaces everything after the checkpoint with the report, after omp's applyRewind: messages the agent was sent
   * meanwhile (the person's, a crewmate's) and the calls that ran beside rewind in its last step are kept after it.
   */
  private _applyRewind(
    messages: AgentMessage[],
    kept: number,
    goal: string,
    report: string,
    context?: AgentTurnEndContext,
  ) {
    const later = messages.slice(kept)
    const heard = later.filter((m) => m.role === 'user')
    const step = context?.message
    const beside = (context?.toolResults ?? []).filter((r) => r.toolName !== 'rewind')
    const ids = new Set(beside.map((r) => r.toolCallId))
    const siblings =
      step?.role === 'assistant' && beside.length
        ? [
            {
              ...step,
              content: step.content.filter((c) => c.type !== 'toolCall' || ids.has(c.id)),
            } as AgentMessage,
            ...(beside as ToolResultMessage[]),
          ]
        : []
    const reportMessage: AgentMessage = {
      role: 'user',
      content: prompts.checkpoint.report(report),
      timestamp: Date.now(),
    }
    const next = [...messages.slice(0, kept), reportMessage, ...heard, ...siblings]
    messages.splice(0, messages.length, ...next)
    this._agent.replaceMessages(next)
    this._checkpoint = undefined
    this._rewound = true
    this._rewriteTranscript(next)
    void this.host
      .append({
        type: 'agent/rewound',
        actor: agentActor(this.spec.name),
        payload: { agent: this.spec.name, goal, report, dropped: later.length - heard.length },
      })
      .catch((err) => console.error(`[${this.name}] failed to log a rewind:`, err))
  }

  /** The transcript a resume reads, made to match the context after a rewind. */
  private _rewriteTranscript(messages: readonly AgentMessage[]) {
    try {
      mkdirSync(join(this._transcript, '..'), { recursive: true })
      writeFileSync(this._transcript, messages.map((m) => `${JSON.stringify(redactDeep(m))}\n`).join(''))
    } catch (err) {
      console.error(`[${this.name}] transcript rewrite failed:`, err)
    }
  }

  /** Quiet items waiting for the next turn. */
  private readonly _quiet: InboxItem[] = []

  notify(item: InboxItem) {
    if (this._stopped) return
    if (item.quiet) {
      this._quiet.push(item)
      this._quiet.splice(0, Math.max(0, this._quiet.length - QUIET_KEPT))
      return
    }
    if (this.working) return this._inject(item)
    this.inbox.push(item)
    this._wake?.()
  }

  /** Puts `item` before the working agent: read at its next step, or with `queue` once its current work is done. */
  private _inject(item: InboxItem) {
    this._stamp = Math.max(Date.now(), this._stamp + 1)
    const message = { role: 'user' as const, content: render([item]), timestamp: this._stamp }
    this._unread.set(message.timestamp, item)
    if (item.queue) this._agent.followUp(message)
    else this._agent.steer(message)
  }

  /**
   * Shows a step that called tools to the round's advisor, which reviews it beside the agent's next model call; the
   * agent never waits on it.
   */
  private _showAdvisor(toolResults: number) {
    const advisor = this.host.advisor
    if (!advisor || toolResults === 0 || this._stopped || this._endAfterStep) return
    void advisor.stepEnded(this.spec, this._agent.state.messages, (note) => this._advised(note))
  }

  /**
   * The advisor's note: read at the agent's next step while it works. Otherwise, or once it has signed off, it waits
   * quietly for whatever wakes the agent next: advice alone is no reason to start a turn or reopen a finished one.
   */
  private _advised(note: string) {
    if (this._stopped) return
    const item: InboxItem = { text: prompts.advisor.note(note), trigger: 'advisor', quiet: true }
    if (this.working && !this._endAfterStep) this._inject(item)
    else this.notify(item)
  }

  stop() {
    this._stopped = true
    this._agent.abort('colony stopped')
    this._wake?.()
  }

  /** Set once the agent has signed off (its final answer is out): the turn ends when the current step is done. */
  private _endAfterStep = false

  /**
   * Ends the turn once the step in progress has its tool results, before the model is asked again, the way someone
   * stops after saying goodbye. Anything written to the agent afterwards still wakes it.
   */
  endTurnAfterStep() {
    if (this.working && !this._stopped) this._endAfterStep = true
  }

  /**
   * The conversation is open again (the person wrote while it wound down): the sign-off no longer holds, and notes
   * with this trigger it has not seen yet are stale. Returns whether one was dropped before it was seen.
   */
  reopen(stale: string): boolean {
    this._endAfterStep = false
    let dropped = false
    for (const waiting of [this._quiet, this.inbox]) {
      const kept = waiting.filter((i) => i.trigger !== stale)
      dropped ||= kept.length < waiting.length
      waiting.splice(0, waiting.length, ...kept)
    }
    return dropped
  }

  /** Cuts the turn in progress short, then wakes the agent with why (the rules it was working under changed). */
  interrupt(reason: string, note: string) {
    if (this._stopped) return
    if (!this.working) return this.notify({ text: note, trigger: 'permissions' })
    // The abort drops whatever was steered into this turn, so the note waits and opens the next turn instead.
    this._afterTurn = { text: note, trigger: 'permissions' }
    this._agent.abort(reason)
  }

  /**
   * Runs until the colony ends. Agents that do not start awake sleep until a task, mail, or mention wakes them.
   * A resumed colony wakes its agents itself, so `kickoffFirst` is false there.
   */
  async run(kickoffFirst = true): Promise<void> {
    // Which sections, at which versions, this agent was given: runs compare by it.
    await this.host.append({ type: 'agent/prompt', actor: SYS, payload: this._prompt.manifest })
    const opening = () =>
      `${this._prompt.kickoffPrefix}${kickoff(this.host.spec, this.host.state(), this.restored > 0, this.name)}`
    if (kickoffFirst && startsAwake(this.host.spec, this.spec))
      this.notify({ text: opening(), trigger: 'kickoff' })
    // The person opened this round by writing to someone else: the rest hear of it when something wakes them.
    else if (kickoffFirst && this.host.spec.chat?.addressed?.length)
      this.notify({ text: opening(), trigger: 'kickoff', quiet: true })
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
      const items = [...this._quiet.splice(0), ...this.inbox.splice(0)]
      await this._turn(items)
      // Its model failure stopped the round: it ends as stopped below, not left "working" in a stopped round.
      if (this._failed) break
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
    this._rules.newTurn(
      rulesFor(this.host.streamRules?.() ?? [], this.name, speaksForColony(this.host.spec, this.spec)),
    )
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
      if (this._afterTurn) this.inbox.unshift(this._afterTurn)
      this._afterTurn = undefined
      this._endAfterStep = false
      this.working = false
    }
    await this.host.append({
      type: 'agent/turn',
      actor: SYS,
      payload: { agent: this.name, phase: 'end', turn: this.turn, trigger },
    })
  }

  /** Models the conversation so far was written with, other than the current one, that can still be called. */
  private _earlierModels(): Model[] {
    const current = this._agent.state.model
    const refs = new Set<string>()
    for (const m of this._agent.state.messages)
      if (m.role === 'assistant' && (m.provider !== current.provider || m.model !== current.id))
        refs.add(`${m.provider}/${m.model}`)
    return [...refs].flatMap((ref) => {
      try {
        const resolved = this.resolver.resolve(ref)
        return resolved.streamFn ? [] : [resolved.model]
      } catch {
        return []
      }
    })
  }

  /**
   * A failed model reply never stays in the agent's context: it is removed, and the turn either continues after a
   * short wait (transient failures), continues once more after folding the context (the provider said it was too
   * long), continues on the next of the person's fallback models (anything else, or a transient failure the waits did
   * not clear), or stops so the person can choose another model. Returns true if it stopped.
   */
  private async _recover(): Promise<boolean> {
    let compacted = false
    // Retries count per model: one the agent fell back to gets its own.
    let attempt = 0
    for (;;) {
      const last = this._agent.state.messages.at(-1) as AssistantMessage | undefined
      if (last?.role !== 'assistant' || last.stopReason !== 'error' || this._stopped) return false
      this._agent.popMessage()
      const model = this._agent.state.model
      if (isContextOverflow(last, model.contextWindow ?? undefined)) {
        if (!compacted && this._compactor.overflowed(this._agent.state.messages)) {
          compacted = true
          await this._agent.continue()
          continue
        }
        await this.host.modelFailed(this.name, this.spec.model, {
          kind: 'overflow',
          message: last.errorMessage?.trim() || 'the conversation is too long for this model',
          tokens: this._compactor.size(this._agent.state.messages),
          ...(model.contextWindow ? { window: model.contextWindow } : {}),
        })
        return true
      }
      const error = classifyModelError(last)
      if (error.transient && attempt < MODEL_RETRIES) {
        await Bun.sleep(2_000 * 2 ** attempt)
        attempt += 1
        await this._agent.continue()
        continue
      }
      if (await this._fallBack(error)) {
        attempt = 0
        await this._agent.continue()
        continue
      }
      // The configured ref, not the provider's internal id, so the person sees the model they chose.
      await this.host.modelFailed(this.name, this.spec.model, error)
      return true
    }
  }

  /**
   * After this agent's model failed with `error`, moves it to the next of the person's fallback models (Settings →
   * Crew & budget): the model it was set up with once that has had time to recover, then the fallbacks in order,
   * skipping any that failed lately or have no credentials. Logs the move; false when there is none to move to.
   * Overflows never come here (folding the context is their remedy), nor a stop or an interrupt (not failures).
   */
  private async _fallBack(error: ModelError): Promise<boolean> {
    const chain = this.host.spec.fallbacks?.[this.spec.role === 'lead' ? 'lead' : 'workers'] ?? []
    if (chain.length === 0 || this._stopped) return false
    const now = Date.now()
    const from = this.spec.model
    this._failedAt.set(from, now)
    for (const ref of new Set([this._primary, ...chain])) {
      const failed = this._failedAt.get(ref)
      if (ref === from || (failed !== undefined && now - failed < FALLBACK_COOLDOWN_MS)) continue
      try {
        await this.resolver.requireCredentials(ref)
      } catch {
        // Removed from the provider list, or signed out: the next one may still answer.
        continue
      }
      this._use(ref)
      await this.host.append({
        type: 'agent/fallback',
        actor: SYS,
        payload: {
          agent: this.name,
          model: ref,
          previous: from,
          kind: error.kind === 'refusal' ? 'refusal' : 'error',
          message: error.message.slice(0, 2_000),
        },
      })
      return true
    }
    return false
  }

  /**
   * A chat round's speaker (its one agent, a lead with a crew, or the agent the person opened it by writing to)
   * whose turn ends in plain text without a reply tool has written its answer where the person cannot see it, and
   * nothing else would end the round. Deliver that text as the final answer.
   */
  private async _deliverUnsentAnswer(from: number) {
    const spec = this.host.spec
    const addressed = spec.chat?.addressed?.includes(this.name) ?? false
    const leadsCrew = !addressed && spec.agents.length > 1 && speaksForColony(spec, this.spec)
    if (!spec.chat || (spec.agents.length !== 1 && !addressed && !leadsCrew) || this._stopped) return
    const all = this._agent.state.messages.slice(from)
    const turn = all.filter((m) => m.role === 'assistant') as AssistantMessage[]
    const callsIn = (ms: readonly AgentMessage[]) =>
      (ms.filter((m) => m.role === 'assistant') as AssistantMessage[]).flatMap((m) =>
        m.content.flatMap((c) => (c.type === 'toolCall' ? [c.name] : [])),
      )
    const calls = callsIn(all)
    const spoke = calls.some((name) => REPLY_TOOLS.has(name))
    // Text written while it waits on a teammate ("I've asked the lead, will reply then") is not its answer: it
    // messaged someone after the last thing it heard, or mail has come in since, and that reply starts the turn
    // that answers.
    const heard = all.findLastIndex((m) => m.role === 'user')
    const state = this.host.state()
    const since = state.rounds.at(-1)?.startSeq ?? 0
    // A lead is also waiting while its crew still has tasks open, or a crewmate it asked this round has not answered
    // yet (to it, or in the group it asked in).
    const crewOwes =
      leadsCrew &&
      (Object.values(state.tasks).some((t) => t.status !== 'verified' && t.status !== 'deleted') ||
        state.mail.some(
          (asked) =>
            asked.from === this.name &&
            asked.seq >= since &&
            recipientsOf(asked).some(
              (r) =>
                !state.mail.some(
                  (m) => m.from === r && m.seq > asked.seq && (m.to === this.name || m.to === asked.to),
                ),
            ),
        ))
    const waiting =
      callsIn(all.slice(heard + 1)).some((name) => HANDOFF_TOOLS.has(name)) ||
      this.inbox.length > 0 ||
      this._agent.hasQueuedMessages() ||
      crewOwes
    // A first answer of nothing but text counts at any length ("4"). After tool work, or once this round has a final
    // answer (a review sent it back, say), a short remark is filler, not another answer.
    const answered = state.chatMessages.some((m) => m.from === this.name && m.final && m.seq >= since)
    // Once a lead has answered, its plain text is talk with the crew (thanks, a goodbye), not another answer, unless
    // the person has written since or a review sent the answer back.
    const answer = state.chatMessages.findLast((m) => m.from === this.name && m.final && m.seq >= since)
    const chatting =
      leadsCrew &&
      answer !== undefined &&
      !state.chatMessages.some((m) => m.from === 'user' && m.seq > answer.seq) &&
      !state.verdicts.some((v) => v.target === 'colony' && !v.pass && v.seq > answer.seq)
    const worked = answered || calls.length > 0
    const last = turn.at(-1)
    const text =
      last?.content
        .flatMap((c) => (c.type === 'text' ? [c.text] : []))
        .join('\n')
        .trim() ?? ''
    if (
      spoke ||
      waiting ||
      chatting ||
      !last ||
      last.stopReason !== 'stop' ||
      !text ||
      (worked && text.length < 20)
    )
      return
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

  /**
   * Deliveries the turn never injected (taken but not yet shown, or still queued when it ended or was cut short) start
   * the next turn instead, in the order they came; clearing the queues without them would lose them unread.
   */
  private _requeueUnread() {
    const seen = new Set<number>()
    const left = [
      ...this._agent.peekUndeliveredQueuedMessages(),
      ...this._agent.peekSteeringQueue(),
      ...this._agent.peekFollowUpQueue(),
    ].filter((m) => !seen.has(m.timestamp) && seen.add(m.timestamp))
    if (left.length === 0 && !this._agent.hasQueuedMessages()) return
    this._agent.clearAllQueues()
    for (const m of left) {
      const item = this._unread.get(m.timestamp)
      this._unread.delete(m.timestamp)
      // A quiet one (the advisor's note) waits for the next wake rather than being one.
      if (item) (item.quiet ? this._quiet : this.inbox).push(item)
    }
  }

  private async _markDelivered(items: readonly InboxItem[]) {
    for (const item of items) {
      for (const mail of [...(item.mail ? [item.mail] : []), ...(item.mails ?? [])])
        await this.host.append({
          type: 'mail/delivered',
          actor: SYS,
          payload: { mail, to: this.name },
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

  /** When the last piece of a reply was streamed, and what it said, so updates go out at most every 100ms. */
  private _streamedAt = 0
  private _streamedText = ''

  /**
   * The reply as it is written, for the person watching: the text of reply_user (read from the tool call's
   * arguments, which the model streams) or the plain text of a direct answer. Only the agent that speaks streams.
   */
  private _streamReply(m: AssistantMessage, done: boolean) {
    // The speaker streams its replies and plain answers; a crew member, only what it writes to the person directly.
    const speaks = speaksForColony(this.host.spec, this.spec)
    const tool = speaks ? 'reply_user' : 'reply_person'
    const reply = m.content.flatMap((c) =>
      c.type === 'toolCall' && c.name === tool && typeof c.arguments?.text === 'string'
        ? [c.arguments.text]
        : [],
    )
    if (!speaks && reply.length === 0 && !this._streamedText) return
    const text = (
      reply.length || !speaks ? reply : m.content.flatMap((c) => (c.type === 'text' ? [c.text] : []))
    ).join('\n')
    const now = Date.now()
    if (!done && (text === this._streamedText || now - this._streamedAt < 100)) return
    if (!text && !this._streamedText) return
    this._streamedAt = now
    this._streamedText = done ? '' : text
    this.host.streamed(this.name, text, done, reply.length === 0)
  }

  private _onEvent(e: AgentEvent) {
    if (e.type === 'message_update' && e.message.role === 'assistant')
      return this._streamReply(e.message as AssistantMessage, false)
    if (e.type === 'message_end' && e.message.role === 'assistant')
      this._streamReply(e.message as AssistantMessage, true)
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
      this._showAdvisor(e.toolResults.length)
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
    // pi prices a reply from the rate card of the model the call went to, so a model without one reports $0: that
    // cost is unknown, not free, and is left out so totals say n/a instead of undercounting. The reply's own model
    // name can differ (a provider's fallback), and a /model switch can land mid-reply, so neither decides.
    const model = this._streamedWith ?? this._agent.state.model
    const priced = ['fixed', 'free', 'included'].includes(getModelPricingStatus(model))
    const cost = priced ? (m.usage as { cost?: { total?: number } } | undefined)?.cost?.total : undefined
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
 * Reads an agent's transcript for a resume. A crash can leave the last assistant message with tool calls that never
 * got results. With nothing of them in the log they never ran, and that unfinished step is dropped so the conversation
 * is valid to continue. Once one of them ran (`recorded`, from the log), dropping the step would have the model ask
 * for it again: the step is kept, each call answered with its recorded result, or as interrupted when it started and
 * recorded none, and the repaired transcript is written back so a later resume reads it whole too.
 */
export function readTranscript(
  path: string,
  recorded?: (callId: string) => CallRecord | undefined,
): AgentMessage[] {
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
    const calls = (m.content as { type: string; id?: string; name?: string }[]).filter(
      (c) => c.type === 'toolCall',
    )
    const answered = new Set(
      messages
        .slice(i + 1)
        .flatMap((r) =>
          (r as { role?: string }).role === 'toolResult' ? [(r as { toolCallId?: string }).toolCallId] : [],
        ),
    )
    const open = calls.filter((c) => !answered.has(c.id))
    if (open.length === 0) break
    if (!recorded || !open.some((c) => c.id && recorded(c.id))) {
      messages.length = i
      break
    }
    // Results go right after the step's own results, before anything that came in after them.
    let at = i + 1
    while ((messages[at] as { role?: string } | undefined)?.role === 'toolResult') at++
    messages.splice(at, 0, ...open.map((c) => recoveredResult(c, c.id ? recorded(c.id) : undefined)))
    try {
      writeFileSync(path, messages.map((msg) => `${JSON.stringify(msg)}\n`).join(''))
    } catch (err) {
      // The repaired conversation is used anyway; the next resume repairs it again from the log.
      console.error(`transcript repair could not be saved (${path}):`, err)
    }
    break
  }
  return messages
}

/** The result a resumed step's call gets: what the log recorded, or that it was interrupted or never ran. */
function recoveredResult(call: { id?: string; name?: string }, record: CallRecord | undefined): AgentMessage {
  const text = record?.result
    ? record.result.output
    : record
      ? prompts.agent.interruptedCall(record.tool)
      : prompts.agent.neverRan
  return {
    role: 'toolResult',
    toolCallId: call.id ?? '',
    toolName: call.name ?? record?.tool ?? '',
    content: [{ type: 'text', text }],
    isError: !record?.result?.ok,
    timestamp: Date.now(),
  } as AgentMessage
}

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
        content: [{ type: 'text', text: prompts.agent.elided(size) }],
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
  /**
   * A refusal is the model declining (a policy filter); `overflow` is a conversation too long for the model's window
   * even after folding it; `error` is anything else that went wrong.
   */
  readonly kind: 'refusal' | 'overflow' | 'error'
  readonly message: string
  readonly transient?: boolean
  /**
   * Why trying the same model again cannot work: the provider retired it, or one request is bigger than the
   * account's tokens-per-minute limit (`limit`; `tokens` is the request's size).
   */
  readonly cause?: 'retired' | 'per-minute'
  readonly limit?: number
  /** For an overflow: the conversation's estimated size and the model's window, in tokens. */
  readonly tokens?: number
  readonly window?: number
}

/** A provider saying it no longer serves the model (Groq: 400 `model_decommissioned`). */
const RETIRED = /\bdecommissioned\b/i
/** A provider's tokens-per-minute limit and what one request asked for (Groq's 413, OpenAI's 429). */
const PER_MINUTE = /tokens per min(?:ute)?\b[\s\S]*?Limit:? (\d+), Requested:? (\d+)/i

export function classifyModelError(m: AssistantMessage): ModelError {
  const message = m.errorMessage?.trim() || 'the model returned an error with no message'
  if (/refus/i.test(message)) return { kind: 'refusal', message }
  if (RETIRED.test(message)) return { kind: 'error', message, transient: false, cause: 'retired' }
  const [, limit, tokens] = (PER_MINUTE.exec(message) ?? []).map(Number)
  // Waiting cannot help a request that alone is over the limit for any minute.
  if (limit !== undefined && tokens !== undefined && tokens > limit)
    return { kind: 'error', message, transient: false, cause: 'per-minute', limit, tokens }
  const transient =
    (m.errorStatus !== undefined && TRANSIENT_STATUS.has(m.errorStatus)) ||
    /timed? ?out|ECONNRESET|ETIMEDOUT|socket hang up|overloaded|rate.?limit|temporar|try again/i.test(message)
  return { kind: 'error', message, transient }
}

/**
 * A Claude model that takes Anthropic's computer toolset gets it in place of the generic `computer` function tool:
 * pi-ai builds the request with plain tools, and its payload hook swaps the definition in (and marks the history's
 * member calls), after any hook the caller set.
 */
function withComputerToolset<O extends { onPayload?: (params: unknown, model: Model) => unknown }>(
  model: Model,
  tools: readonly { name: string }[] | undefined,
  options: O | undefined,
): O | undefined {
  if (computerProtocol(model) !== 'anthropic' || !tools?.some((t) => t.name === COMPUTER_TOOL)) return options
  const before = options?.onPayload
  return {
    ...(options ?? ({} as O)),
    onPayload: async (params: unknown, m: Model) => {
      const changed = await before?.(params, m)
      const body = changed === undefined ? params : changed
      return anthropicToolsetPayload(body) ?? changed
    },
  }
}
