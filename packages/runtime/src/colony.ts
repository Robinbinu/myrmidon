import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  BlobStore,
  EventLog,
  MyrError,
  newColonyId,
  type SqliteLogStore,
  sqliteLogStore,
} from '@myrmidon/core'
import {
  ACCESS_GROUPS,
  AWAITING_USER,
  accessChange,
  accessOf,
  applyEvent,
  asksSomething,
  type CallRecord,
  type ColonyId,
  type ColonyState,
  callKey,
  callRecords,
  crewOf,
  DELIVERED_VERIFIER,
  decide,
  describeEffect,
  type EventDraft,
  type EventPayloads,
  emptyColonyState,
  foldColony,
  hasOpenWork,
  type MyrEvent,
  mentionsIn,
  offersFor,
  openWork,
  outsideEffects,
  type PermissionCall,
  type PermissionLevels,
  type PermissionVerdict,
  type QuestionAnswers,
  type Review,
  type RoundAccess,
  rulesIn,
  SYSTEM,
  type TaskSnapshot,
  tightened,
  toolHidden,
  unreadMailFor,
} from '@myrmidon/protocol'
import { Advisor } from './advisor.ts'
import { ColonyAgent, type ModelError } from './agent.ts'
import type { BrowserHub } from './browser.ts'
import { namingModel } from './catalog.ts'
import { cellKernels } from './cells.ts'
import type { ChatRecallRequest, ChatRecallScope } from './chat-recall.ts'
import type { ComputerHub } from './computer/driver.ts'
import { COMPUTER_TOOL_NAMES } from './computer/names.ts'
import {
  APPROVAL_MS,
  BOOTSTRAP_MS,
  CHAT_SETTLE_MS,
  HUDDLE_MS,
  LEASE_MS,
  LOGIN_MS,
  MAX_SERVERS,
  MAX_VERIFY_ROUNDS,
  MAX_WORKERS,
  MISSED_CHARS,
  MISSED_SHOWN,
  QUIET_NUDGES,
  RECALL_TOOL_COUNT,
  SERVER_START_MS,
  SETTLE_QUIET_MS,
  SKILL_PROPOSALS_PER_ROUND,
  WIND_DOWN_MESSAGES,
} from './config.ts'
import { ProjectCopies } from './copies.ts'
import { debugSessions } from './debugger.ts'
import { registerColonyEvents } from './events.ts'
import { chatJudge } from './find.ts'
import { type HookEvent, type HookOutcome, type HookStore, hookToolInput, runHooks } from './hooks.ts'
import {
  agentActor,
  type ColonyHost,
  type ExperimentTree,
  type ReviewDecision,
  type TodoItem,
} from './host.ts'
import type { ToolLibrary } from './made-tools.ts'
import type { McpHub } from './mcp.ts'
import type { MediaTools } from './media.ts'
import { type MemoryStore, neverSave, sensitive } from './memory.ts'
import { ModelResolver } from './models.ts'
import { pickName } from './names.ts'
import { FactualObserver } from './observer.ts'
import { formatCurrentTime } from './omp/memory.ts'
import { attachedNote, isLead, snapshot, toolsFor } from './patterns.ts'
import { levelsOf, presetOf, roleOf } from './permissions.ts'
import type { PluginHost } from './plugin-host.ts'
import { listeningPorts } from './ports.ts'
import { type ProjectContext, readProjectContext } from './project-context.ts'

import { prompts } from './prompts.ts'
import { chatsAt, grantCovers, keysAt, readFolder, realPath, within } from './read-access.ts'
import {
  detectSandbox,
  fullAccessIn,
  type Sandbox,
  type SandboxProcess,
  unconfinedSandbox,
} from './sandbox.ts'
import { redactDeep } from './secrets.ts'
import type { SkillProposalStore } from './skill-learning.ts'
import { SKILL_NAME, type SkillLibrary } from './skills.ts'
import type { AgentSpec, ColonySpec } from './spec.ts'
import type { SshHub } from './ssh.ts'
import type { StreamRule, StreamRuleStore } from './stream-rules.ts'
import { cellAccess, guessMediaType } from './tools.ts'
import { Verifier } from './verifier.ts'
import { noWebTools, type WebTools } from './web.ts'
import { ColonyWorkspace } from './workspace.ts'
import { ProjectWorktrees } from './worktrees.ts'

export interface Runtime {
  readonly ctx: Context
  readonly home: string
  /** Work still writing to the log (a round winding down), which disposing waits for. */
  track?(work: Promise<unknown>): void
  dispose(): Promise<void>
}

/** Raised for a message that reaches a round as its completion is being logged: it belongs to the next round. */
export class RoundClosingError extends Error {
  constructor() {
    super('this round is closing')
    this.name = 'RoundClosingError'
  }
}

/** How long shutting down waits for rounds and agents still winding down before closing the log under them. */
export const SETTLE_MS = 3_000

/** Boots the plugin tree: SQLite log store, the event log, and colony event types. */
export async function bootRuntime(home: string): Promise<Runtime> {
  const ctx = new Context()
  await ctx.plugin(sqliteLogStore, { home })
  await ctx.plugin(EventLog)
  await ctx.plugin({
    name: 'colony-events',
    inject: ['log'],
    apply(c: Context) {
      c.effect(() => registerColonyEvents(c.log))
    },
  })
  for (let i = 0; i < 100 && !ctx.get('log'); i++) await Bun.sleep(5)
  if (!ctx.get('log')) throw new Error('event log service failed to start')
  const pending = new Set<Promise<unknown>>()
  return {
    ctx,
    home,
    track(work) {
      pending.add(work)
      void work.finally(() => pending.delete(work))
    },
    // A round that is still ending writes its last events (agents' turn ends, worktree closes) to the log; closing
    // it first would leave them writing into nothing.
    dispose: async () => {
      await Promise.race([Promise.allSettled([...pending]), Bun.sleep(SETTLE_MS)])
      await ctx.fiber.dispose()
    },
  }
}

export interface RunOptions {
  readonly unsafeNoSandbox?: boolean
  readonly resolver?: ModelResolver
  /** Search and fetch backends; defaults to keyless DuckDuckGo plus any search keys in the environment. */
  readonly web?: WebTools
  /** Pictures and speech (generate_image, tts); without it those tools say they are not available here. */
  readonly media?: MediaTools
  readonly sandbox?: Sandbox
  /** How long all agents may sit idle with empty inboxes before the colony is nudged. */
  readonly quietMs?: number
  /** Reopen this existing colony (see `resume`) instead of creating a new one. */
  readonly resumeId?: ColonyId
  /** Shared MCP connections; their tools are offered to agents allowed `mcp`. */
  readonly mcp?: McpHub
  /** The person's plugins with code: their tools and prompt sections reach agents. */
  readonly plugins?: PluginHost
  /** Receives the speaking agent's reply as it is written, for live display (`plain`: see AgentHost.streamed). */
  readonly onStream?: (agent: string, text: string, done: boolean, plain: boolean) => void
  /** The person's kept tools, loaded into every fresh round. */
  readonly library?: ToolLibrary
  /** The round's changes to its project folder so far, as a unified diff (from the start checkpoint). */
  readonly projectDiff?: () => Promise<string | undefined>
  /** Shared headless Chrome for the browser_* tools. */
  readonly browser?: BrowserHub
  /** Computer use (the person's Mac through Cua Driver), for rounds whose spec allows it. */
  readonly computer?: ComputerHub
  /** The person's ssh client, for rounds whose spec names remote hosts. */
  readonly ssh?: SshHub
  /** What the person keeps across chats; agents propose additions to it with remember. */
  readonly memory?: MemoryStore
  /** The person's past chats an agent may search (search_chats), in the scope this round gives it. */
  readonly pastChats?: (scope: ChatRecallScope, request: ChatRecallRequest) => Promise<string>
  /** Skills agents can load by name (use_skill). */
  readonly skills?: SkillLibrary
  /** Where skills agents propose (learn, manage_skill) wait for the person, beside the reviewer's. */
  readonly skillProposals?: SkillProposalStore
  /** The person's hooks, run before and after tools and when the round ends. */
  readonly hooks?: HookStore
  /** The person's stream rules, which stop an agent's reply mid-stream when it breaks one. */
  readonly rules?: StreamRuleStore
}

/**
 * Prewalk's hand-off points: the lead's first change to the work (a file edit or write, or a task for the crew) means
 * the plan is made. Like omp's, read-only steps and shell commands (often just looking) do not count.
 */
const PREWALK_AFTER = new Set(['fs_write', 'fs_edit', 'ast_edit', 'create_task'])
/** Tools that answer or ask the person: calling one is not work toward a goal (see `_workedSince`). */
const ANSWERING = new Set(['reply_user', 'reply_person', 'ask_user'])
const isComputerTool = (tool: string) => (COMPUTER_TOOL_NAMES as readonly string[]).includes(tool)

/**
 * What agents read, run and write is redacted before it is stored, so a key read from a .env file does not sit in
 * the log. The person's own messages are kept as typed: a key they paste is meant for the agents to use.
 */
function redacted(draft: EventDraft): EventDraft {
  return draft.type === 'chat/user' ? draft : { ...draft, payload: redactDeep(draft.payload) }
}

/** Whether something accepts TCP connections on this local port. */
async function listening(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } })
    socket.end()
    return true
  } catch {
    return false
  }
}

/** A file the person attached to a chat message. */
export interface Attachment {
  readonly name: string
  readonly bytes: Uint8Array
}

/** Cost and tokens every agent of the colony has used, over all of its rounds. */
function totals(state: ColonyState): { cost: number; tokens: number } {
  const agents = Object.values(state.agents)
  return { cost: agents.reduce((n, a) => n + a.cost, 0), tokens: agents.reduce((n, a) => n + a.tokens, 0) }
}

/** How a wake is delivered: `mail` is recorded as read when the agent sees it; `queue` waits for the agent's current work. */
interface Delivery {
  readonly mail?: MyrEvent['id']
  readonly mails?: readonly MyrEvent['id'][]
  readonly queue?: boolean
  readonly quiet?: boolean
}

export class ColonyRun implements ColonyHost {
  readonly id: ColonyId
  readonly blobs: BlobStore
  readonly workspace: ColonyWorkspace
  readonly project?: ProjectContext
  private readonly _confined: Sandbox
  private readonly _unconfined = unconfinedSandbox()
  readonly unsafeNoSandbox: boolean
  readonly resolver: ModelResolver
  readonly web: WebTools
  readonly media?: MediaTools
  readonly done: Promise<ColonyState>

  private _state: ColonyState
  private readonly _agents = new Map<string, ColonyAgent>()
  private readonly _verifier: Verifier
  private readonly _observer: FactualObserver
  readonly advisor?: Advisor
  private readonly _timers: ReturnType<typeof setInterval>[] = []
  private _finish!: (s: ColonyState) => void
  private _deadline = 0
  /** The colony's totals when this round started: a chat's colony keeps running totals across its rounds. */
  private _spentBefore = { cost: 0, tokens: 0 }
  private _finalRunning = false
  private _verifying = 0
  private _quietSince?: number
  /**
   * A chat round whose final answer is in, still open while the crew finishes talking: it completes with these verdicts
   * once everyone has been quiet a moment, or at `until` whatever is still going on.
   */
  private _settling?: {
    verdicts: MyrEvent['id'][]
    until: number
    quietSince?: number
    /** Messages each agent has sent since the wind-down began. */
    said: Map<string, number>
    /** Agents told the conversation is winding down. */
    told: string[]
  }
  /** Its completion is being logged: a message from the person now belongs to the next round. */
  private _closing = false
  /** Set once the round has begun ending (see `_end`): from then on the log updates its state but wakes nobody. */
  private _ending = false
  private _ended?: Promise<void>
  private _nudges = 0
  private _mirrorTimer?: ReturnType<typeof setTimeout>
  private _offLog?: () => void
  private _seed?: () => Promise<void>
  /** Set while the colony waits on the person's answer; wakes for agents are held until it arrives. */
  private _awaiting = false
  private _held: ({ name: string; text: string; trigger: string } & Delivery)[] = []
  private readonly _assigned = new Map<string, string>()
  /**
   * Task wakes held until the creator's tool batch finishes: a plan note and its tasks arrive in one batch whose
   * calls run concurrently, and nobody should wake before the plan is in.
   */
  private readonly _afterBatch = new Map<string, (() => void)[]>()
  private readonly _idleSince = new Map<string, number>()
  private _failedVerifications = 0
  /** Goal mode: checks of the goal so far, the log position of the latest, and whether one is running. */
  private _goalChecks = 0
  private _goalCheckedAt = 0
  private _goalRunning = false
  /** Prewalk hands off once a round: set when the lead has switched to the carry-out model (or could not). */
  private _handedOff = false
  private _speakerOwesAnswer = false
  private _bootstrapAt = 0
  private _bootstrapped = 1
  /** Set while a swarm's peers are proposing how to split the work; `after` is the seq it opened at. */
  private _huddle?: { since: number; after: number; proposed: Set<string> }
  /** Reminders sent to agents that stopped with work open, keyed by agent and task (or todo list). */
  private readonly _reminded = new Map<string, number>()
  /** Calls waiting for the person: the tool that asked, and what answers it. */
  private readonly _approvals = new Map<string, { tool: string; done: (decision: ReviewDecision) => void }>()
  private readonly _servers = new Map<string, SandboxProcess>()
  /** The localhost port each running server opened (see `localPorts`). */
  private readonly _serverPorts = new WeakMap<SandboxProcess, number>()
  /** Who started each running server, under which rules, and whether it is up yet (see `_stopLooserServers`). */
  private readonly _serverRules = new WeakMap<
    SandboxProcess,
    { agent: string; fullAccess: boolean; readOnly: boolean; up: boolean }
  >()
  private readonly _untrusted = new Map<string, { source: string; text: string }[]>()
  private readonly _logins = new Map<string, (outcome: 'handed-back' | 'timeout' | 'stopped') => void>()
  readonly boundary = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
  private readonly _todos = new Map<string, readonly TodoItem[]>()
  /** Folders the person allowed reading once (request_read): for this round only, never kept with the chat. */
  private readonly _readOnce = new Set<string>()
  /**
   * Opened on the first worker that needs a worktree: git worktrees for a git project, else copies (copies.ts) where
   * this computer can clone the folder; null once known to have neither.
   */
  private _worktrees?: ProjectWorktrees | ProjectCopies | null
  /** Agents given a worktree for an experiment (autoresearch), who go back to the folder when it finishes. */
  private readonly _experimenting = new Set<string>()

  constructor(
    private readonly runtime: Runtime,
    readonly spec: ColonySpec,
    private readonly options: RunOptions = {},
  ) {
    this.id = options.resumeId ?? newColonyId()
    const dir = (runtime.ctx.logStore as SqliteLogStore).colonyDir(this.id)
    this.blobs = new BlobStore(join(dir, 'blobs'))
    this.workspace = new ColonyWorkspace(dir, spec.chat?.project?.path, () => this.fullAccess, {
      dataDir: realPath(runtime.home),
      reads: () => this.extraReads(),
      // Skills say their scripts run from their own folder, so the shell may read the ones agents are offered.
      commandReads: () =>
        (this.options.skills?.offered(this.spec.chat?.project?.path) ?? []).map((s) => s.dir),
    })
    const folder = spec.chat?.project?.path
    // Read once per round, so every agent works from the same rules even if a file changes mid-round.
    if (folder) this.project = readProjectContext(folder)
    this._confined = options.sandbox ?? detectSandbox()
    this.unsafeNoSandbox = options.unsafeNoSandbox ?? false
    this.resolver = options.resolver ?? new ModelResolver()
    this.web = options.web ?? noWebTools
    if (options.media) this.media = options.media
    this._state = emptyColonyState(this.id)
    this._verifier = new Verifier(this, this.resolver)
    this._observer = new FactualObserver(this)
    if (spec.advisor) this.advisor = new Advisor(this, this.resolver, spec.advisor)
    this.done = new Promise((resolve) => {
      this._finish = resolve
    })
    this.options.computer?.newRound(this.id, () => this._computerStopped())
  }

  get log() {
    return this.runtime.ctx.log
  }

  /** Read at each use, so a round a channel member writes into is confined from their message on. */
  get fullAccess(): boolean {
    return fullAccessIn(this.spec)
  }

  get sandbox(): Sandbox {
    return this.fullAccess ? this._unconfined : this._confined
  }

  state() {
    return this._state
  }

  /** The tool calls the log held when this round was resumed or continued, by agent and call id. */
  private _calls?: ReadonlyMap<string, CallRecord>

  recordedCall(agent: string, callId: string): CallRecord | undefined {
    return this._calls?.get(callKey(agent, callId))
  }

  deadline() {
    return this._deadline
  }

  spent() {
    const now = totals(this._state)
    return { cost: now.cost - this._spentBefore.cost, tokens: now.tokens - this._spentBefore.tokens }
  }

  get browser() {
    return this.options.browser?.available ? this.options.browser : undefined
  }

  /**
   * find's judge: a small yes-or-no job, so the cheapest model the person can use, else the agent's own. A model that
   * no longer resolves leaves find to rank by words, which it says.
   */
  judge(agent: string) {
    const model = this.spec.agents.find((a) => a.name === agent)?.model
    if (!model) return undefined
    const omp = this.resolver.omp
    try {
      return chatJudge(this.resolver, omp ? namingModel(omp, undefined, model) : model)
    } catch (err) {
      console.error(`[${agent}] find has no judge:`, err instanceof Error ? err.message : err)
      return undefined
    }
  }

  /**
   * The person's Mac, while this round may use it: the chat allowed it when the round started, and only the person
   * wrote into it (a channel member's message takes it away at once, like full access).
   */
  get computer() {
    return this.spec.computerUse && !this.spec.askAll ? this.options.computer : undefined
  }

  /** The person pressed Stop on computer use: agents driving their Mac stop at once, and are told why. */
  private _computerStopped() {
    const holding = new Set(
      (this.options.computer?.controls() ?? []).filter((c) => c.colonyId === this.id).map((c) => c.agent),
    )
    for (const agent of holding)
      void this.append({
        type: 'computer/control',
        actor: { kind: 'user', id: 'user' },
        payload: { agent, active: false },
      }).catch(() => {})
    for (const a of this._agents.values())
      if (holding.has(a.name) && a.working)
        a.interrupt('the person stopped computer use', prompts.computer.stoppedNote)
    // A card asking to use the Mac would stay up until it timed out: nothing it allows can happen any more.
    for (const [id, waiting] of this._approvals)
      if (isComputerTool(waiting.tool)) void this.decideApproval(id, false, 'stopped').catch(() => {})
  }

  remotes() {
    const hub = this.options.ssh
    const hosts = this.spec.remotes ?? []
    return hub && hosts.length && !this.spec.askAll ? { hub, hosts } : undefined
  }

  mcpTools() {
    return this.options.mcp?.tools() ?? []
  }

  mcpReadOnly(tool: string) {
    return this.options.mcp?.readOnly(tool) ?? false
  }

  mcpServer(tool: string) {
    return this.options.mcp?.serverOf(tool)
  }

  permit(agent: string, call: PermissionCall): PermissionVerdict {
    return decide(levelsOf(this.spec), call, {
      ...(this.spec.askAll ? { askAll: true } : {}),
      role: roleOf(this.spec, agent),
    })
  }

  hidden(agent: string, tool: string, server?: string): boolean {
    return toolHidden(levelsOf(this.spec), tool, roleOf(this.spec, agent), server)
  }

  pluginTools(agent: string) {
    const tools = this.options.plugins?.tools({ colonyId: this.id, agent }) ?? []
    // Messaging the person on a channel is speaking to them: only for agents that do (reply_user).
    const spec = this.spec.agents.find((a) => a.name === agent)
    const speaks = spec !== undefined && toolsFor(this.spec, spec).includes('reply_user')
    return speaks ? tools : tools.filter((t) => t.name !== 'channels_send')
  }

  pluginPrompts(role: 'lead' | 'worker') {
    return this.options.plugins?.prompts(role) ?? []
  }

  get plugins() {
    return this.options.plugins
  }

  streamed(agent: string, text: string, done: boolean, plain: boolean) {
    this.options.onStream?.(agent, text, done, plain)
  }

  /**
   * Switches running agents to another model (agent → model ref). Each takes effect on that agent's next step;
   * an agent in the middle of a model call finishes it on the old one.
   */
  async switchModels(models: Record<string, string>) {
    if (this._state.status !== 'running') throw new Error('this round is not running')
    for (const [name, model] of Object.entries(models)) {
      const agent = this._agents.get(name)
      if (!agent) throw new Error(`no agent called ${name}`)
      this.resolver.resolve(model)
      const previous = agent.spec.model
      if (previous === model) continue
      agent.switchModel(model)
      await this.append({
        type: 'agent/model',
        actor: { kind: 'user', id: 'user' },
        payload: { agent: name, model, previous },
      })
    }
  }

  async requestLogin(agent: string, site: string, url: string, reason: string) {
    if (this._logins.has(agent)) throw new Error('you are already waiting for a sign-in')
    const outcome = new Promise<'handed-back' | 'timeout' | 'stopped'>((resolve) => {
      const timer = setTimeout(() => void this.finishLogin(agent, 'timeout'), LOGIN_MS)
      this._logins.set(agent, (o) => {
        clearTimeout(timer)
        resolve(o)
      })
    })
    await this.append({
      type: 'login/requested',
      actor: agentActor(agent),
      payload: { agent, site, url, reason },
    })
    return outcome
  }

  /** Ends a sign-in wait (handed back, timed out, or the round stopped); returns whether one was waiting. */
  async finishLogin(agent: string, outcome: 'handed-back' | 'timeout' | 'stopped'): Promise<boolean> {
    const done = this._logins.get(agent)
    if (!done) return false
    this._logins.delete(agent)
    await this.append({
      type: 'login/finished',
      actor: outcome === 'handed-back' ? { kind: 'user', id: 'user' } : SYSTEM,
      payload: { agent, outcome },
    })
    done(outcome)
    return true
  }

  rememberUntrusted(agent: string, source: string, text: string) {
    const list = this._untrusted.get(agent) ?? []
    list.push({ source, text: text.slice(0, 200_000) })
    this._untrusted.set(agent, list.slice(-8))
  }

  recentUntrusted(agent: string) {
    return this._untrusted.get(agent) ?? []
  }

  /**
   * Folders this round's agents may read beyond the defaults: the person's (Settings, the project), this chat's
   * grants and this round's one-off ones. None from the moment a channel member writes into the round.
   */
  extraReads(): string[] {
    if (this.spec.askAll) return []
    // A key folder the person allowed for this chat or once opens (it is named exactly); other chats' data never does.
    const granted = [...(this._state.chatReads ?? []), ...this._readOnce].filter((f) => !this._otherChats(f))
    return [...new Set([...(this.spec.reads ?? []), ...granted])]
  }

  /**
   * What this round's agents may do now, to tell them what changed (see `RoundAccess`). The folders read once are left
   * out: the agent that asked knows, and they end with the round.
   */
  access(): RoundAccess {
    const reads = this.spec.askAll
      ? []
      : [...(this.spec.reads ?? []), ...(this._state.chatReads ?? []).filter((f) => !this._otherChats(f))]
    return accessOf(levelsOf(this.spec), this.fullAccess, reads)
  }

  /** What the agents were last told they may do; a log from before that was kept knows only full access. */
  private _told(): RoundAccess {
    return this._state.access ?? (this._state.fullAccess ? { fullAccess: true } : {})
  }

  /** What changed for each agent between what it was told and `now`, in words, for the agents it changed for. */
  private _accessNotices(
    told: RoundAccess,
    now: RoundAccess,
    when: 'since' | 'now',
    agents: readonly string[],
  ) {
    const out: Record<string, string> = {}
    for (const name of agents) {
      const change = accessChange(told, now, roleOf(this.spec, name))
      if (change) out[name] = prompts.colony.accessChanged(change, when, !!now.fullAccess)
    }
    return out
  }

  /** Whether a folder is or lies in Myrmidon's data folder outside this chat's own: no request opens it. */
  private _otherChats(folder: string) {
    return chatsAt(folder, { dataDir: this.runtime.home, colonyDir: this.workspace.colonyDir })
  }

  async requestRead(agent: string, path: string, reason?: string): Promise<string> {
    const self = this.spec.agents.find((a) => a.name === agent)
    const tools = self ? toolsFor(this.spec, self) : []
    if (this.fullAccess) return prompts.toolResults.readFull(tools)
    if (this.spec.askAll) throw new Error(prompts.toolResults.readNotHere)
    const folder = realPath(readFolder(path))
    if (this._otherChats(folder)) throw new Error(prompts.toolResults.readChats(path))
    if (this.workspace.mayRead(agent, folder)) return prompts.toolResults.readAlready(path)
    // Keys and sign-ins may be asked for: the card says what the folder holds and offers only once or this chat.
    const sensitive = keysAt(folder) !== undefined
    const home = homedir()
    const shown = within(folder, home) ? `~${folder.slice(home.length)}` : folder
    const decision = await this.reviewChange(agent, 'request_read', prompts.reviewCard.read(shown, reason), {
      read: folder,
      ...(sensitive ? { sensitive: true } : {}),
    })
    if (!decision.approved) throw new Error(prompts.toolResults.declined(`reading ${path}`, decision.note))
    if (!(this._state.chatReads ?? []).some((f) => grantCovers(f, folder))) this._readOnce.add(folder)
    return sensitive
      ? prompts.toolResults.readAllowedKeys(path, tools)
      : prompts.toolResults.readAllowed(path, tools)
  }

  async requestApproval(agent: string, tool: string, summary: string): Promise<boolean> {
    return (await this.reviewChange(agent, tool, summary, {})).approved
  }

  async reviewChange(
    agent: string,
    tool: string,
    summary: string,
    options: {
      review?: Review
      key?: string
      read?: string
      sensitive?: boolean
      permission?: { call: PermissionCall; verdict: PermissionVerdict }
    },
  ): Promise<ReviewDecision> {
    if (this._state.status !== 'running') return { approved: false }
    // Once the person stopped this round's computer use, nothing may ask to use the Mac again.
    if (isComputerTool(tool) && this.options.computer?.stopped(this.id)) return { approved: false }
    const read = options.read
    if (read && this._state.chatReads?.some((f) => grantCovers(f, read))) return { approved: true }
    const id = `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const decided = new Promise<ReviewDecision>((resolve) => {
      const timer = setTimeout(
        () => void this.decideApproval(id, false, 'timeout').catch(() => {}),
        APPROVAL_MS,
      )
      this._approvals.set(id, {
        tool,
        done: (decision) => {
          clearTimeout(timer)
          resolve(decision)
        },
      })
    })
    await this.append({
      type: 'approval/requested',
      actor: agentActor(agent),
      payload: {
        id,
        agent,
        tool,
        summary,
        ...(options.review ? { review: options.review } : {}),
        ...(options.key ? { key: options.key } : {}),
        ...(options.read ? { read: options.read } : {}),
        ...(options.sensitive ? { sensitive: true } : {}),
        ...(options.permission ? this._permissionCard(agent, options.permission) : {}),
      },
    })
    return decided
  }

  /**
   * What an approval card shows about the permission model: why it asked, and what it may remember from the answer
   * (nothing when it asked because someone else started the round, or because the project is read-only: no rule
   * lifts either).
   */
  private _permissionCard(agent: string, p: { call: PermissionCall; verdict: PermissionVerdict }) {
    const by = p.verdict.source.by
    const offer = by === 'askAll' || by === 'read-only' ? [] : offersFor(p.call)
    return {
      why: p.verdict.source,
      call: p.call,
      role: roleOf(this.spec, agent),
      ...(offer.length ? { offer } : {}),
    }
  }

  /**
   * Decides again every call still waiting for the person under the rules as they are now: the ones the new rules
   * allow go ahead, the ones they deny are refused, the rest keep waiting. "Allow `bun test` everywhere" on one card
   * clears every other card it covers.
   */
  async redecideApprovals() {
    for (const a of Object.values(this._state.approvals)) {
      if (a.decided || !a.call || !this._approvals.has(a.id)) continue
      const verdict = this.permit(a.agent, a.call)
      if (verdict.decision !== 'ask')
        await this.decideApproval(a.id, verdict.decision === 'allow').catch(() => {})
    }
  }

  /**
   * The person's answer to an approval request (or a timeout, or the round stopping). Edits count only for fields the
   * review marked editable, and only when approving.
   */
  async decideApproval(
    id: string,
    approved: boolean,
    by: 'person' | 'timeout' | 'stopped' = 'person',
    answer: { edits?: Record<string, string>; note?: string } = {},
  ) {
    const done = this._approvals.get(id)?.done
    if (!done) throw new Error('that request is no longer waiting')
    this._approvals.delete(id)
    const editable = new Set(
      this._state.approvals[id]?.review?.fields.filter((f) => f.editable).map((f) => f.key) ?? [],
    )
    const edits = Object.fromEntries(
      Object.entries(approved ? (answer.edits ?? {}) : {}).filter(([key]) => editable.has(key)),
    )
    const note = answer.note?.trim() || undefined
    const changed = Object.keys(edits).length > 0
    await this.append({
      type: 'approval/decided',
      actor: by === 'person' ? { kind: 'user', id: 'user' } : SYSTEM,
      payload: { id, approved, by, ...(changed ? { edits } : {}), ...(note ? { note } : {}) },
    })
    done({ approved, ...(changed ? { edits } : {}), ...(note ? { note } : {}) })
  }

  async startServer(agent: string, name: string, command: string, port?: number): Promise<string> {
    if (this._servers.has(name)) throw new Error(`a server called ${name} is already running; stop it first`)
    if (this._servers.size >= MAX_SERVERS) throw new Error(`at most ${MAX_SERVERS} servers may run at once`)
    const cwd = this.workspace.workdir(agent)
    const scratch = this.workspace.scratch(agent)
    // A port already in use is someone else's (the dashboard's, another app's): claiming it would open it to agents.
    const before = listeningPorts()
    if (port && (before?.has(port) || (await listening(port))))
      throw new Error(prompts.toolResults.portInUse(port))
    // Read with the sandbox below, after the await, so the rules it starts under are the ones in force then.
    const readOnly = presetOf(this.spec) === 'read-only'
    const proc = this.sandbox.start({
      command,
      cwd,
      writable: readOnly ? [scratch] : [...new Set([cwd, scratch])],
      ...this.workspace.confinement(),
      ...(port ? { env: { PORT: String(port) } } : {}),
    })
    this._servers.set(name, proc)
    const rules = { agent, fullAccess: this.fullAccess, readOnly, up: false }
    this._serverRules.set(proc, rules)
    let ended = false
    void proc.exited.then(() => {
      ended = true
      if (this._servers.get(name) === proc) {
        this._servers.delete(name)
        if (this._state.servers[name] && !this._state.servers[name]?.stopped)
          void this.append({
            type: 'server/stopped',
            actor: SYSTEM,
            payload: { name, reason: 'the process exited' },
          })
      }
    })
    const deadline = Date.now() + SERVER_START_MS
    let url: string | undefined
    let opened = port
    while (!url && !ended && this._servers.get(name) === proc && Date.now() < deadline) {
      await Bun.sleep(300)
      if (port) url = (await listening(port)) ? `http://localhost:${port}` : undefined
      else {
        const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/.exec(proc.output())
        if (m && (await listening(Number(m[1])))) {
          opened = Number(m[1])
          url = `http://localhost:${opened}`
        }
      }
    }
    // Stopped by `_stopLooserServers` while it was starting.
    if (this._servers.get(name) !== proc) throw new Error(prompts.toolResults.serverRulesChanged(name))
    if (url && opened && !port && before?.has(opened)) {
      proc.stop()
      this._servers.delete(name)
      throw new Error(prompts.toolResults.portWasInUse(opened))
    }
    if (!url) {
      proc.stop()
      this._servers.delete(name)
      const tail = proc.output().trim().split('\n').slice(-30).join('\n')
      throw new Error(
        `${ended ? 'the command exited' : `nothing served within ${SERVER_START_MS / 1000}s`}${port ? ` on port ${port}` : ' (no local URL printed; pass port)'}\n${tail}`,
      )
    }
    // Without a record of the ports in use before, a printed port cannot be told from someone else's.
    if (opened && (port || before)) this._serverPorts.set(proc, opened)
    rules.up = true
    await this.append({
      type: 'server/started',
      actor: agentActor(agent),
      payload: { agent, name, command, url },
    })
    return url
  }

  localPorts(): ReadonlySet<number> | 'all' {
    if (this.fullAccess) return 'all'
    const ports = new Set<number>()
    for (const proc of this._servers.values()) {
      const port = this._serverPorts.get(proc)
      if (port) ports.add(port)
    }
    return ports
  }

  serverLogs(name: string): string {
    const proc = this._servers.get(name)
    if (!proc) throw new Error(`no running server called ${name}`)
    return proc.output()
  }

  async stopServer(name: string, reason: string): Promise<void> {
    const proc = this._servers.get(name)
    if (!proc) throw new Error(`no running server called ${name}`)
    this._servers.delete(name)
    proc.stop()
    await this.append({ type: 'server/stopped', actor: SYSTEM, payload: { name, reason } })
  }

  /**
   * Stops the servers started under looser rules than the round has now (full access since taken back, a project
   * since made read-only): a running process keeps the sandbox it started in. All are stopped and their agents told
   * before anything is awaited, so a second tightening finds nothing left to stop and an agent just interrupted hears
   * of it in the turn that follows. A server still starting fails its start_server call instead. Code cell runtimes
   * started under looser rules stop too; their agents hear of it with their next cell.
   */
  private async _stopLooserServers() {
    const readOnly = presetOf(this.spec) === 'read-only'
    cellKernels.stopLooser(this.id, cellAccess(this))
    debugSessions.stopLooser(this.id, cellAccess(this))
    const stopped: string[] = []
    const byAgent = new Map<string, string[]>()
    for (const [name, proc] of [...this._servers]) {
      const rules = this._serverRules.get(proc)
      if (!rules || !((rules.fullAccess && !this.fullAccess) || (!rules.readOnly && readOnly))) continue
      this._servers.delete(name)
      proc.stop()
      if (!rules.up) continue
      stopped.push(name)
      byAgent.set(rules.agent, [...(byAgent.get(rules.agent) ?? []), name])
    }
    for (const [agent, names] of byAgent)
      this._wake(agent, prompts.colony.serversStopped(names), 'permissions', { quiet: true })
    for (const name of stopped)
      await this.append({
        type: 'server/stopped',
        actor: SYSTEM,
        payload: { name, reason: 'it ran with access this round no longer has' },
      })
  }

  projectDiff(): Promise<string | undefined> {
    return this.options.projectDiff?.() ?? Promise.resolve(undefined)
  }

  /** Runs the hooks for an event and records each run; `undefined` when none listens. */
  private async _hooks(event: HookEvent, agent: string | undefined, tool: string | undefined, input: object) {
    const store = this.options.hooks
    if (!store?.has(event)) return undefined
    const cwd = agent
      ? this.workspace.workdir(agent)
      : (this.spec.chat?.project?.path ?? this.workspace.colonyDir)
    const env = {
      MYRMIDON_COLONY: this.id,
      ...(agent ? { MYRMIDON_AGENT: agent } : {}),
      // Hooks written for Claude Code find the project here.
      CLAUDE_PROJECT_DIR: this.spec.chat?.project?.path ?? cwd,
      MYRMIDON_PROJECT_DIR: this.spec.chat?.project?.path ?? cwd,
    }
    const outcome = await runHooks(
      store.active(),
      event,
      tool,
      { hook_event_name: event, session_id: this.id, cwd, ...(agent ? { agent } : {}), ...input },
      cwd,
      env,
    )
    await this._recordHooks(event, agent, tool, outcome)
    return outcome
  }

  private async _recordHooks(
    event: HookEvent,
    agent: string | undefined,
    tool: string | undefined,
    o: HookOutcome,
  ) {
    for (const [i, run] of o.runs.entries()) {
      const last = i === o.runs.length - 1
      const outcome =
        last && o.blocked
          ? 'blocked'
          : last && o.ask
            ? 'asked'
            : run.code === 2
              ? 'feedback'
              : run.code !== 0
                ? 'failed'
                : 'ok'
      const message = (
        outcome === 'blocked' ? o.blocked : outcome === 'asked' ? o.ask : run.stderr.trim()
      )?.slice(0, 500)
      await this.append({
        type: 'hook/ran',
        actor: SYSTEM,
        payload: {
          event,
          ...(agent ? { agent } : {}),
          ...(tool ? { tool } : {}),
          command: run.command.slice(0, 300),
          code: run.code,
          ms: run.ms,
          outcome,
          ...(message ? { message } : {}),
        },
      })
    }
  }

  async beforeTool(agent: string, tool: string, input: unknown): Promise<void> {
    const o = await this._hooks('PreToolUse', agent, tool, {
      tool_name: tool,
      tool_input: hookToolInput(input, this.workspace.workdir(agent)),
    })
    if (o?.blocked) throw new Error(`a hook blocked this call: ${o.blocked}`)
    if (o?.ask && !(await this.requestApproval(agent, tool, `hook: ${o.ask}`)))
      throw new Error(`the person did not approve this call (${o.ask})`)
  }

  async afterTool(agent: string, tool: string, input: unknown, output: string): Promise<string> {
    const o = await this._hooks('PostToolUse', agent, tool, {
      tool_name: tool,
      tool_input: hookToolInput(input, this.workspace.workdir(agent)),
      tool_response: output.slice(0, 20_000),
    })
    return o?.feedback.length ? `\n\n[hook] ${o.feedback.join('\n[hook] ')}` : ''
  }

  streamRules(): StreamRule[] {
    return this.options.rules?.list(this.spec.chat?.project?.path) ?? []
  }

  skills(): { name: string; description: string }[] {
    return (this.options.skills?.offered(this.spec.chat?.project?.path) ?? []).map((s) => ({
      name: s.name,
      description: s.description,
    }))
  }

  async useSkill(agent: string, name: string, file?: string): Promise<string> {
    const library = this.options.skills
    if (!library) throw new Error('no skills are installed')
    const text = library.read(name, this.spec.chat?.project?.path, file)
    if (!file) library.noteUse(name)
    await this.append({
      type: 'skill/used',
      actor: agentActor(agent),
      payload: { agent, name, ...(file ? { file } : {}) },
    })
    return text
  }

  loadTools(agent: string, query: string): string {
    const a = this._agents.get(agent)
    if (!a) throw new Error(`no agent called ${agent}`)
    return a.loadTools(query)
  }

  /**
   * Resets every agent's provider stream state (/fresh), keeping their conversations; refused while one is mid-step,
   * as omp refuses while streaming. Logged, so the round's later agents and the chat's next rounds start fresh too.
   */
  async fresh(): Promise<number> {
    if ([...this._agents.values()].some((a) => a.working)) throw new Error(prompts.chat.freshWhileWorking)
    const generation = (this._state.freshes ?? 0) + 1
    let closed = 0
    for (const a of this._agents.values()) closed += a.fresh(generation)
    await this.append({ type: 'chat/fresh', actor: { kind: 'user', id: 'user' }, payload: { closed } })
    return closed
  }

  checkpoint(agent: string, goal: string): string {
    const a = this._agents.get(agent)
    if (!a) throw new Error(`no agent called ${agent}`)
    return a.checkpoint(goal)
  }

  rewind(agent: string, report: string): string {
    const a = this._agents.get(agent)
    if (!a) throw new Error(`no agent called ${agent}`)
    return a.rewind(report)
  }

  toolsChanged(made?: { readonly by: string; readonly tool: string }) {
    for (const a of this._agents.values()) a.refreshTools()
    if (made) this._agents.get(made.by)?.load([made.tool])
  }

  /**
   * Someone other than the person wrote into this round: from now on it asks before every outside step (`askAll`),
   * logged so a resumed round keeps asking.
   */
  async askForAll() {
    if (this.spec.askAll) return
    this.spec.askAll = true
    await this.append({
      type: 'permissions/changed',
      actor: { kind: 'user', id: 'user' },
      payload: { off: [], ask: [], allow: [], askAll: true, interrupted: [] },
    })
    await this._stopLooserServers()
  }

  /**
   * New permission levels from the person (any of global, project, chat), applied to this round at once. If they got
   * stricter (a deny or ask rule added, a tool group taken away, a stricter preset, full access taken back), an agent
   * mid-turn is stopped, so a call the person just took back cannot go ahead, and told what changed. Calls waiting
   * for the person are decided again. Full access gained holds from the next call on, so the mode the person picked
   * is the one agents run under; a command already running keeps the sandbox it started in.
   */
  async applyRules(next: {
    permissions: PermissionLevels
    /** Whether the round would get full access now (`true` gives it, `false` takes it back). */
    fullAccess?: boolean
    /** The folders the person now lets agents read (Settings and the project); they apply from the next read. */
    reads?: string[]
  }) {
    const spec = this.spec
    const told = this._told()
    const readsBefore = JSON.stringify(this.access().reads ?? [])
    if (next.reads) spec.reads = next.reads
    const before = levelsOf(spec)
    const wasFull = this.fullAccess
    const fullAfter = fullAccessIn({
      ...spec,
      permissions: next.permissions,
      ...(next.fullAccess !== undefined ? { fullAccess: next.fullAccess } : {}),
    })
    const confined = wasFull && !fullAfter
    const freed = !wasFull && fullAfter
    const readsChanged = JSON.stringify(this.access().reads ?? []) !== readsBefore
    if (!confined && !freed && !readsChanged && JSON.stringify(before) === JSON.stringify(next.permissions))
      return
    const t = tightened(before, next.permissions)
    const allows = (levels: PermissionLevels) =>
      rulesIn(levels).flatMap((r) => (r.decision === 'allow' ? [r.target] : []))
    const before_ = new Set(allows(before))
    const allowed = [...new Set(allows(next.permissions).filter((t) => !before_.has(t)))]
    spec.permissions = next.permissions
    const project = spec.chat?.project
    if (project && next.permissions.project)
      project.permissions = {
        ...next.permissions.project,
        ...(project.permissions?.read ? { read: project.permissions.read } : {}),
      }
    if (next.fullAccess !== undefined) spec.fullAccess = next.fullAccess
    this.toolsChanged()
    const off = [...t.denied, ...t.groups.flatMap((g) => ACCESS_GROUPS[g])]
    const stricter = off.length > 0 || t.asked.length > 0 || !!t.preset || confined
    const interrupted = stricter ? [...this._agents.values()].filter((a) => a.working) : []
    await this.append({
      type: 'permissions/changed',
      actor: { kind: 'user', id: 'user' },
      payload: {
        off,
        ask: t.asked,
        allow: allowed,
        ...(t.preset ? { project: t.preset } : {}),
        ...(confined ? { fullAccess: false } : {}),
        ...(freed ? { fullAccess: true } : {}),
        interrupted: interrupted.map((a) => a.name),
        access: this.access(),
      },
    })
    const note = prompts.colony.permissionsChanged({
      off,
      ask: t.asked,
      ...(t.preset ? { project: t.preset } : {}),
      confined,
      freed,
    })
    for (const a of interrupted) a.interrupt('the person changed permissions', note)
    // Everyone else hears of it too: steered into a step in progress, or waiting for whatever wakes them next.
    const notices = this._accessNotices(
      told,
      this.access(),
      'now',
      [...this._agents.keys()].filter((name) => !interrupted.some((a) => a.name === name)),
    )
    for (const [name, text] of Object.entries(notices))
      this._wake(name, text, 'permissions', this._agents.get(name)?.working ? {} : { quiet: true })
    await this.redecideApprovals()
    // Servers started under looser rules than these stop; the rest keep running.
    await this._stopLooserServers()
  }

  /** Wakes one agent with a note from outside the colony (e.g. the person handing back its browser). */
  nudge(agent: string, text: string) {
    if (this._state.status === 'running') this._wake(agent, text, 'person')
  }

  async modelFailed(agent: string, model: string, error: ModelError) {
    if (this._state.status !== 'running') return
    await this.append({
      type: 'agent/error',
      actor: SYSTEM,
      payload: {
        agent,
        model,
        kind: error.kind,
        message: error.message.slice(0, 2_000),
        ...(error.cause ? { cause: error.cause } : {}),
        ...(error.limit !== undefined ? { limit: error.limit } : {}),
        ...(error.tokens !== undefined ? { tokens: error.tokens } : {}),
        ...(error.window !== undefined ? { window: error.window } : {}),
      },
    })
    const what = { refusal: 'refused', overflow: 'ran out of context', error: 'failed' }[error.kind]
    await this.stop(`model ${what}: ${agent} on ${model}`)
  }

  setTodos(agent: string, items: readonly TodoItem[]) {
    this._todos.set(agent, items)
    this._reminded.delete(`${agent}:todo`)
  }

  huddling() {
    return this._huddle !== undefined
  }

  /**
   * Ends the opening huddle. The peer who proposed first merges the proposals into the plan and assigns the
   * tasks; the others are woken by their assignments. If nobody proposed, the first peer plans.
   */
  private _closeHuddle(why: string) {
    const huddle = this._huddle
    if (!huddle) return
    this._huddle = undefined
    const peers = this.spec.agents.map((a) => a.name)
    const proposals = this._state.board.filter((b) => b.seq > huddle.after && peers.includes(b.agent))
    const planner = proposals[0]?.agent ?? peers[0]
    if (!planner) return
    this._bootstrapAt = Date.now()
    this._bootstrapped = peers.indexOf(planner) + 1
    const listed = proposals.map((b) => `- ${b.agent}: ${b.text}`).join('\n') || prompts.colony.noProposals
    this._wake(
      planner,
      prompts.colony.huddleOver({ why, proposals: listed, snapshot: snapshot(this.spec, this._state) }),
      'kickoff',
    )
  }

  append(draft: EventDraft): Promise<MyrEvent> {
    return this.log.appendOne(this.id, redacted(draft))
  }

  async appendAtomic(build: (state: ColonyState) => EventDraft[]): Promise<MyrEvent[]> {
    for (let attempt = 0; ; attempt++) {
      const head = this._state.lastSeq
      const drafts = build(this._state)
      if (drafts.length === 0) return []
      try {
        return await this.log.append(this.id, drafts.map(redacted), { expectedHead: head })
      } catch (err) {
        if (!(err instanceof MyrError && err.code === 'HEAD_MISMATCH') || attempt >= 20) throw err
        await Bun.sleep(5 + Math.random() * 20)
      }
    }
  }

  /** Fails loudly before anything starts if a model, credential, or capability is missing. */
  async preflight(): Promise<void> {
    const refs = new Set(this.spec.agents.map((a) => a.model))
    for (const c of this.spec.acceptance) if (c.verifier === 'llm-judge') refs.add(c.model)
    if (this.spec.taskJudge) refs.add(this.spec.taskJudge)
    for (const m of this.spec.team?.workerModels ?? []) refs.add(m)
    // A chat round starts at once: the lead's first call tests its model, and a model that fails pauses the round
    // on the error. Only missing credentials, which cost nothing to find, stop it up front.
    await Promise.all(
      [...refs].map((ref) =>
        this.spec.chat ? this.resolver.requireCredentials(ref) : this.resolver.probe(ref),
      ),
    )
    const needsExec =
      this.spec.acceptance.some((c) => c.verifier === 'command') ||
      this.spec.agents.some((a) => toolsFor(this.spec, a).includes('shell'))
    if (needsExec && this.sandbox.kind === 'none' && !this.unsafeNoSandbox) {
      const commandChecks = this.spec.acceptance.some((c) => c.verifier === 'command')
      if (commandChecks)
        throw new Error(
          'command acceptance checks need an OS sandbox; none found (use --unsafe-no-sandbox to override)',
        )
    }
  }

  /** The spec as the log records it: in colony/created for the first round, in round/started for later ones. */
  private _specPayload(): EventPayloads['colony/created'] {
    return {
      name: this.spec.name,
      mission: this.spec.mission,
      pattern: this.spec.pattern,
      agents: this.spec.agents.map((a) => ({
        name: a.name,
        role: a.role,
        model: a.model,
        tools: toolsFor(this.spec, a),
        ...(a.specialty ? { specialty: a.specialty } : {}),
        ...(a.focus ? { focus: a.focus } : {}),
      })),
      acceptance: this.spec.acceptance,
      budget: {
        wallMs: this.spec.budget.wallMs,
        maxTurns: this.spec.budget.maxTurns,
        ...(this.spec.budget.costUsd !== undefined ? { costUsd: this.spec.budget.costUsd } : {}),
        ...(this.spec.budget.tokens !== undefined ? { tokens: this.spec.budget.tokens } : {}),
        ...(this.spec.budget.total ? { total: this.spec.budget.total } : {}),
      },
      unsafeNoSandbox: this.unsafeNoSandbox,
      ...(this.spec.chat
        ? {
            chat: {
              chatId: this.spec.chat.chatId,
              round: this.spec.chat.round,
              request: this.spec.chat.request,
              ...(this.spec.chat.history ? { history: this.spec.chat.history } : {}),
              ...(this.spec.chat.project ? { project: this.spec.chat.project } : {}),
              ...(this.spec.chat.escalate?.length ? { escalate: this.spec.chat.escalate } : {}),
              ...(this.spec.chat.memory?.length ? { memory: this.spec.chat.memory } : {}),
              ...(this.spec.chat.memoryMore ? { memoryMore: this.spec.chat.memoryMore } : {}),
              ...(this.spec.chat.handoff ? { handoff: this.spec.chat.handoff } : {}),
              ...(this.spec.chat.memorySummary ? { memorySummary: this.spec.chat.memorySummary } : {}),
              ...(this.spec.chat.addressed?.length ? { addressed: this.spec.chat.addressed } : {}),
            },
          }
        : {}),
      ...(this.spec.team ? { team: this.spec.team } : {}),
      ...(this.spec.tier ? { tier: this.spec.tier } : {}),
      observerMs: this.spec.observer.intervalMs,
      ...(this.spec.thinking ? { thinking: this.spec.thinking } : {}),
      ...(this.spec.taskJudge ? { taskJudge: this.spec.taskJudge } : {}),
      ...(this.spec.disabledTools?.length ? { disabledTools: this.spec.disabledTools } : {}),
      ...(this.spec.askAll ? { askAll: true } : {}),
      ...(this.spec.review ? { review: this.spec.review } : {}),
      ...(this.fullAccess ? { fullAccess: true } : {}),
      ...(this.computer ? { computerUse: true } : {}),
      ...(this.spec.goal ? { goal: this.spec.goal } : {}),
      ...(this.spec.prewalk ? { prewalk: this.spec.prewalk } : {}),
      access: this.access(),
    }
  }

  /**
   * Starts a chat's next round in this colony (built with `resumeId`): the log, files, notes, tasks and agents'
   * conversations carry on, and the new round's spec (tier, team, budget) applies from here. Agents restore their
   * transcripts and are woken with the new request.
   */
  async continueRound(): Promise<void> {
    if (!this.options.resumeId) throw new Error('continueRound needs a colony built with resumeId')
    const past = await this.log.read(this.id)
    for (const e of past) applyEvent(this._state, e)
    this._calls = callRecords(past)
    if (this._state.status === 'running') throw new Error('this colony is already running a round')
    await this.preflight()
    // Agents remember their earlier answers: a refusal the old permissions forced would stand unless they hear why not.
    const notices = this._accessNotices(
      this._told(),
      this.access(),
      'since',
      this.spec.agents.map((a) => a.name),
    )
    if (this.spec.chat && Object.keys(notices).length) this.spec.chat.accessNotices = notices
    this._listen()
    await this.append({ type: 'round/started', actor: SYSTEM, payload: this._specPayload() })
    await this._seed?.()
    await this._launch(this.spec.budget.wallMs, undefined, {}, true)
  }

  /**
   * Follows the colony's log: each event updates the state and is routed to the agents. Once the round is ending,
   * events still update the state (its agents' last turns, closed worktrees) but wake nobody, and when a later round
   * of this colony starts, the log is that round's alone.
   */
  private _listen() {
    this._offLog = this.runtime.ctx.on('log/appended', (colonyId, events) => {
      if (colonyId !== this.id) return
      for (const e of events) {
        if (this._ending && (e.type === 'round/started' || e.type === 'colony/started')) {
          this._offLog?.()
          this._offLog = undefined
          return
        }
        applyEvent(this._state, e)
        if (!this._ending) this._route(e)
      }
    })
  }

  async start(): Promise<void> {
    await this.preflight()
    this._listen()
    await this.append({ type: 'colony/created', actor: SYSTEM, payload: this._specPayload() })
    await this._seed?.()
    await this._launch(this.spec.budget.wallMs)
  }

  /**
   * Picks up a stopped or interrupted colony (built with `resumeId`) where it left off. Agents start with
   * fresh context: the durable state (tasks, notes, files, conversation) is all in the log, so the speaker gets
   * a summary of it plus anything the person said that nobody read, and agents holding tasks are told to
   * carry on. The wall clock restarts with what was left, or half the budget if less remained.
   */
  /** `models` switches agents to another model (agent → model), e.g. after one refused or failed. */
  async resume(reason: string, models: Record<string, string> = {}): Promise<void> {
    if (!this.options.resumeId) throw new Error('resume needs a colony built with resumeId')
    const past = await this.log.read(this.id)
    for (const e of past) applyEvent(this._state, e)
    this._calls = callRecords(past)
    if (this._state.status === 'completed') throw new Error('this round already completed')
    const started = past.find((e) => e.type === 'colony/started')
    const used = started ? Date.parse(past.at(-1)?.time ?? started.time) - Date.parse(started.time) : 0
    const wall = this.spec.budget.wallMs
    const left = wall > 0 ? Math.max(wall - used, wall / 2) : 0
    // Like the clock, a resumed round gets at least half its spend and token limits back, so a round a limit
    // stopped can go on.
    const start = this._state.rounds.at(-1)?.startSeq
    const now = totals(this._state)
    const before = start ? totals(foldColony(this.id, past, start - 1)) : { cost: 0, tokens: 0 }
    const counted = (used: number, limit: number | undefined) =>
      limit === undefined ? used : Math.min(used, limit / 2)
    this._spentBefore = {
      cost: now.cost - counted(now.cost - before.cost, this.spec.budget.costUsd),
      tokens: now.tokens - counted(now.tokens - before.tokens, this.spec.budget.tokens),
    }
    await this.preflight()
    this._listen()
    // Full access is decided afresh on resume (the person may have turned the sandbox back on); the log says so.
    if (!!this._state.fullAccess !== this.fullAccess)
      await this.append({
        type: 'permissions/changed',
        actor: { kind: 'user', id: 'user' },
        payload: { off: [], ask: [], allow: [], fullAccess: this.fullAccess, interrupted: [] },
      })
    await this._launch(left, reason, models)
  }

  /** `newRound`: turn limits count from zero again, as each round has its own budget. */
  private async _launch(
    wallMs: number,
    resumedBecause?: string,
    models: Record<string, string> = {},
    newRound = false,
  ) {
    // The person's kept tools join a fresh round before its agents are built, so they see them from the start.
    if (!resumedBecause)
      for (const tool of this.options.library?.list() ?? [])
        if (!this._state.madeTools[tool.name])
          await this.append({
            type: 'tool/created',
            actor: SYSTEM,
            payload: { agent: 'library', ...tool, library: true },
          })
    for (const a of this.spec.agents) await this._isolate(a.name)
    for (const a of this.spec.agents) {
      const agent = new ColonyAgent(a, this, this.resolver, { restore: true, compact: newRound })
      agent.turn = newRound ? 0 : (this._state.agents[a.name]?.turns ?? 0)
      this._agents.set(a.name, agent)
    }
    this._deadline = wallMs > 0 ? Date.now() + wallMs : Number.POSITIVE_INFINITY
    if (!resumedBecause) this._spentBefore = totals(this._state)
    this._bootstrapAt = Date.now()
    // So the person can see which of their files the agents were told to follow, other tools' rules included.
    const guide = this.project?.instructions
    const rules = guide ? [...guide.files, ...guide.rules.map((r) => r.file)] : []
    const swarm = this.spec.team?.mode === 'swarm' && this.spec.tier === 'team' && this.spec.agents.length > 1
    const from = this._state.rounds.at(-1)?.startSeq ?? 0
    const planned =
      this._state.notes.some((n) => n.section === 'plan' && n.seq >= from && n.agent !== 'previous-round') ||
      Object.keys(this._state.tasks).length > 0
    if (swarm && !planned && !this.spec.chat?.addressed?.length)
      this._huddle = { since: Date.now(), after: this._state.lastSeq, proposed: new Set() }
    await this.append({
      type: 'colony/started',
      actor: SYSTEM,
      payload: {
        pid: process.pid,
        hostname: hostname(),
        ...(resumedBecause ? { resumed: true } : {}),
        ...(Object.keys(models).length ? { models } : {}),
        ...(rules.length && !resumedBecause ? { rules } : {}),
      },
    })
    if (resumedBecause) await this._wakeAfterResume(resumedBecause)
    for (const a of this._agents.values()) this._catchUp(a.name)
    this.runtime.track?.(this.done)
    for (const a of this._agents.values()) this._runAgent(a, !resumedBecause)
    this._timers.push(setInterval(() => void this._observe(), this.spec.observer.intervalMs))
    // A short quiet window (tests) needs a matching tick, or each stall nudge waits a full second.
    const tick = Math.min(1000, this.options.quietMs ?? 1000)
    this._timers.push(setInterval(() => void this._watch(), tick))
  }

  /**
   * Messages an agent never got to read (its last round ended first) wait for it like unread texts: it sees them when
   * something next wakes it, before anything newer, so it catches up instead of answering old news as if it were new.
   */
  private _catchUp(name: string) {
    const unread = unreadMailFor(this._state, name)
    if (unread.length === 0) return
    const shown = unread.slice(-MISSED_SHOWN)
    const cut = (text: string) => (text.length > MISSED_CHARS ? `${text.slice(0, MISSED_CHARS)}…` : text)
    const lines = shown.map((m) =>
      m.members
        ? `[group:${m.to}] #${m.seq} ${m.from}: ${cut(m.body)}`
        : `#${m.seq} from ${m.from}${m.subject && !m.subject.startsWith('Re: ') ? ` [${m.subject}]` : ''}: ${cut(m.body)}`,
    )
    this._agents.get(name)?.notify({
      text: prompts.colony.missed(lines, unread.length - shown.length),
      trigger: 'unread',
      quiet: true,
      mails: shown.map((m) => m.id),
    })
  }

  private async _wakeAfterResume(reason: string) {
    const s = this._state
    const since = s.rounds.at(-1)?.startSeq ?? 0
    const effects = outsideEffects((await this.log.read(this.id)).filter((e) => e.seq >= since))
    const done = (agent: string) =>
      prompts.colony.resumeEffects(effects.filter((e) => e.agent === agent).map(describeEffect))
    const swarm = this.spec.team?.mode === 'swarm' && this.spec.tier === 'team'
    const speaker = swarm
      ? (s.tasks['task-final']?.owner ?? this.spec.agents[0]?.name)
      : (this.spec.agents.find((a) => toolsFor(this.spec, a).includes('reply_user'))?.name ??
        this.spec.agents[0]?.name)
    const unread = s.chatMessages.filter((m, i) => i > 0 && m.from === 'user' && !m.readBy?.length)
    const said = unread.length
      ? prompts.colony.unread(unread.map((m) => `- ${m.text}${attachedNote(m.attachments)}`).join('\n'))
      : ''
    // Agents whose transcript was restored remember their own work; the rest start from the recorded state.
    const fresh = (name: string) =>
      this._agents.get(name)?.restored
        ? prompts.colony.resumedRestored(reason)
        : prompts.colony.resumedFresh(reason)
    if (speaker) {
      const request = this.spec.chat ? prompts.colony.resumeRequest(this.spec.chat.request) : ''
      this._wake(
        speaker,
        prompts.colony.resumeSpeaker({
          fresh: fresh(speaker),
          request,
          snapshot: `${snapshot(this.spec, s, { request: request === '' })}${done(speaker)}`,
          said,
        }),
        'resume',
      )
    }
    for (const t of Object.values(s.tasks)) {
      if (t.status !== 'in_progress' || !t.owner || t.owner === speaker) continue
      this._wake(
        t.owner,
        prompts.colony.resumeHolder({
          fresh: fresh(t.owner),
          id: t.id,
          revision: t.revision,
          subject: t.subject,
          description: t.description,
          snapshot: `${snapshot(this.spec, s)}${done(t.owner)}`,
        }),
        'resume',
      )
    }
  }

  /**
   * Records an agent's proposal to remember something, maybe in place of kept memories it corrects or merges
   * (`replaces`); it applies only once the person keeps it. A secret or personal detail is refused outright.
   */
  async proposeMemory(
    agent: string,
    input: {
      text: string
      kind: string
      scope: 'everywhere' | 'project'
      why: string
      replaces?: readonly string[]
    },
  ): Promise<string> {
    const store = this.options.memory
    if (!store) throw new Error('memory is not available in this run')
    if (Object.values(this._state.memories).filter((m) => m.agent === agent).length >= 5)
      throw new Error('you proposed 5 memories this round already; keep the rest for your reply')
    const project = input.scope === 'project' ? this.spec.chat?.project?.id : undefined
    if (input.scope === 'project' && !project)
      throw new Error('this chat has no project; use scope "everywhere"')
    if (sensitive(input.text)) throw new Error(prompts.colony.memorySensitive)
    if (neverSave(input.text)) throw new Error(prompts.colony.memoryNeverSave)
    const kept = new Map(store.kept(this.spec.chat?.project?.id).map((m) => [m.id, m]))
    const ids = [...new Set(input.replaces ?? [])]
    const unknown = ids.filter((id) => !kept.has(id))
    if (unknown.length) throw new Error(prompts.colony.memoryUnknown(unknown))
    const memory = store.add({
      text: input.text,
      kind: input.kind,
      ...(project ? { project } : {}),
      status: 'proposed',
      ...(ids.length ? { replaces: ids } : {}),
      source: {
        by: 'agent',
        agent,
        colonyId: this.id,
        ...(this.spec.chat ? { chatId: this.spec.chat.chatId } : {}),
        why: input.why,
      },
    })
    if (memory.status === 'active') return prompts.colony.memoryKept
    if (this._state.memories[memory.id]) return prompts.colony.memoryPending
    const replaces = (memory.replaces ?? []).flatMap((id) => {
      const old = kept.get(id)
      return old ? [{ id, text: old.text }] : []
    })
    await this.append({
      type: 'memory/proposed',
      actor: agentActor(agent),
      payload: {
        id: memory.id,
        agent,
        text: memory.text,
        kind: memory.kind,
        ...(project ? { project } : {}),
        why: input.why,
        ...(replaces.length ? { replaces } : {}),
      },
    })
    return prompts.colony.memoryProposed
  }

  /**
   * An agent's proposal to create, change or retire one of Myrmidon's learned skills (learn, manage_skill), after
   * omp's managed skills: it applies only once the person keeps it, beside the reviewer's proposals. Skills the person
   * wrote, installed, or that came with Myrmidon or a plugin are never touched, and a name they hold is refused.
   */
  async proposeSkill(
    agent: string,
    input: {
      action: 'create' | 'update' | 'delete'
      name: string
      description?: string
      body?: string
      why: string
    },
  ): Promise<string> {
    const library = this.options.skills
    const store = this.options.skillProposals
    if (!library || !store) throw new Error(prompts.colony.skillsUnavailable)
    const name = input.name.trim()
    if (!SKILL_NAME.test(name)) throw new Error(prompts.colony.skillName(name))
    const since = this._state.rounds.at(-1)?.startSeq ?? 0
    const mine = Object.values(this._state.skillProposals).filter((p) => p.by === agent && p.seq >= since)
    if (mine.length >= SKILL_PROPOSALS_PER_ROUND)
      throw new Error(prompts.colony.skillsPerRound(SKILL_PROPOSALS_PER_ROUND))
    const learned = library.learned().find((s) => s.name === name)
    const taken = library.list(this.spec.chat?.project?.path).find((s) => s.name === name)
    if (taken && !learned) throw new Error(prompts.colony.skillAuthored(name))
    if (input.action === 'create' && learned) throw new Error(prompts.colony.skillExists(name))
    if (input.action !== 'create' && !learned) throw new Error(prompts.colony.skillMissing(name))
    const description = input.description?.replace(/\s+/g, ' ').trim() || learned?.description || ''
    const body = input.body?.trim() || (input.action === 'delete' ? (learned?.body ?? '') : '')
    if (!description || !body) throw new Error(prompts.colony.skillIncomplete)
    if (sensitive(`${description}\n${body}`)) throw new Error(prompts.colony.memorySensitive)
    const proposal = store.add({
      name,
      description,
      body,
      why: input.why,
      ...(input.action === 'update' && learned
        ? { update: { description: learned.description, body: learned.body } }
        : {}),
      ...(input.action === 'delete' ? { remove: true as const } : {}),
      by: agent,
      colonyId: this.id,
      ...(this.spec.chat ? { chatId: this.spec.chat.chatId } : {}),
    })
    await this.append({
      type: 'skill/proposed',
      actor: agentActor(agent),
      payload: {
        id: proposal.id,
        name,
        description,
        body,
        why: input.why,
        ...(proposal.update ? { update: proposal.update } : {}),
        ...(proposal.remove ? { remove: true as const } : {}),
        by: agent,
      },
    })
    return prompts.colony.skillProposed(input.action, name)
  }

  /** The kept memories best matching `query` that this chat may use, with the ids remember's `replaces` takes. */
  async recallMemory(query: string): Promise<string> {
    const store = this.options.memory
    if (!store) throw new Error('memory is not available in this run')
    const found = await store.searchFor(query, RECALL_TOOL_COUNT, this.spec.chat?.project?.id)
    // Measured, not shown: a suggestion the person has not reviewed yet would have answered this.
    if (!found.length && store.waitingMatches(query, this.spec.chat?.project?.id)) store.count('missed')
    if (!found.length) return prompts.colony.recallNone
    return prompts.colony.recalled(
      found.map((m) =>
        prompts.colony.recalledLine(m.id, m.kind, m.project !== undefined, m.text, m.updatedAt.slice(0, 10)),
      ),
      formatCurrentTime(),
    )
  }

  /**
   * search_chats: the person's past chats in this round's scope, which the round fixes and the agent cannot widen:
   * this chat's project (or none), never this chat, never a chat someone else wrote in. A round someone other than
   * the person started or wrote into reads none of them.
   */
  async searchChats(request: ChatRecallRequest): Promise<string> {
    const search = this.options.pastChats
    const chat = this.spec.chat
    if (!search || !chat) throw new Error('past chats are not available in this run')
    if (this.spec.askAll) throw new Error(prompts.chatRecall.notHere)
    return search({ project: chat.project?.id, chatId: chat.chatId }, request)
  }

  /** Ends the round so the chat can rerun its request at a bigger tier; see ChatService. */
  async escalate(by: string, to: 'solo' | 'team', reason: string): Promise<string> {
    const allowed = this.spec.chat?.escalate ?? []
    if (!allowed.includes(to))
      throw new Error(
        allowed.length
          ? `this round can move to ${allowed.join(' or ')}, not ${to}`
          : 'this round cannot move to a bigger tier',
      )
    if (this._state.status !== 'running') throw new Error('this round is not running')
    await this.append({ type: 'colony/escalated', actor: agentActor(by), payload: { by, to, reason } })
    void this._end()
    return prompts.colony.escalated(to)
  }

  /**
   * `finish`: the person's Stop or shutting down. A round winding down already has its answer, so that completes it;
   * anything else (a limit, a failure) stops it with its reason.
   */
  async stop(reason: string, finish = false): Promise<void> {
    if (this._state.status !== 'running' || this._closing) return
    if (finish && this._settling) return this._closeSettled()
    await this.append({ type: 'colony/stopped', actor: SYSTEM, payload: { reason } })
    await this._end()
  }

  /** Runs `seed` right after colony/created, before any agent starts (used to carry files between chat rounds). */
  beforeStart(seed: () => Promise<void>) {
    this._seed = seed
  }

  async postUserMessage(
    text: string,
    mode: 'steer' | 'queue' = 'steer',
    attachments: readonly Attachment[] = [],
    to: readonly string[] = [],
    extra: { voice?: boolean; context?: string; answers?: QuestionAnswers } = {},
  ): Promise<void> {
    if (this._state.status !== 'running') throw new Error('this colony is not running')
    if (this._closing) throw new RoundClosingError()
    const names = await this.attach(attachments)
    await this.append({
      type: 'chat/user',
      actor: { kind: 'user', id: 'user' },
      payload: {
        text,
        mode,
        ...(names.length ? { attachments: names } : {}),
        ...(to.length ? { to: [...to] } : {}),
        ...(extra.voice ? { voice: true } : {}),
        ...(extra.context ? { context: extra.context } : {}),
        ...(extra.answers ? { answers: extra.answers } : {}),
      },
    })
  }

  /** Stores files the person attached as `uploads/…` artifacts and returns their names. */
  async attach(files: readonly Attachment[]): Promise<string[]> {
    const names: string[] = []
    for (const file of files) {
      const base =
        file.name
          .replace(/[^A-Za-z0-9._-]+/g, '-')
          .replace(/^[-.]+/, '')
          .slice(-120) || 'file'
      let name = `uploads/${base}`
      for (let n = 2; this._state.artifacts[name] || names.includes(name); n++)
        name = `uploads/${base.replace(/(\.[^.]*)?$/, `-${n}$1`)}`
      const { hash, size } = await this.blobs.put(file.bytes)
      await this.append({
        type: 'artifact/versioned',
        actor: { kind: 'user', id: 'user' },
        payload: { name, version: 1, blob: hash, size, author: 'user', mediaType: guessMediaType(name) },
      })
      names.push(name)
    }
    return names
  }

  /**
   * Adds a specialist to an orchestrated team. `label` is its role (e.g. `researcher`); it gets a call sign
   * and sleeps until the lead assigns it a task.
   */
  async spawnWorker(
    by: string,
    label: string,
    focus: string,
    model?: string,
    specialist?: string,
  ): Promise<string> {
    const team = this.spec.team
    if (team?.mode !== 'orchestrated') throw new Error('only an orchestrated team can add crewmates')
    if (this.spec.agents.find((a) => a.name === by)?.role !== 'lead')
      throw new Error('only the lead can add crewmates')
    const workers = this.spec.agents.filter((a) => a.role !== 'lead').length
    // The person's own specialists may join past the extra-worker allowance, up to the team's ceiling.
    const limit = specialist ? MAX_WORKERS : team.maxWorkers
    if (workers >= limit) throw new Error(`crewmate limit reached (${limit})`)
    const saved = specialist ? team.specialists?.find((s) => s.name === specialist) : undefined
    if (specialist && !saved) {
      const here = this.spec.agents.some((a) => a.name === specialist)
      throw new Error(
        here
          ? `${specialist} is already on the team: assign it a task`
          : `no saved specialist called ${specialist}; the person keeps: ${team.specialists?.map((s) => s.name).join(', ') || 'none'}`,
      )
    }
    const chosen = model ?? saved?.model ?? team.workerModels[0]
    if (!chosen || (!saved && !team.workerModels.includes(chosen))) {
      throw new Error(`model must be one of: ${team.workerModels.join(', ')}`)
    }
    const name = saved?.name ?? pickName(new Set(this.spec.agents.map((a) => a.name)))
    label = saved?.specialty ?? label
    const spec: AgentSpec = {
      ...saved,
      name,
      role: 'worker',
      model: chosen,
      specialty: label,
      focus,
      instructions: [saved?.instructions, prompts.colony.workerFocus(by, focus)].filter(Boolean).join('\n\n'),
    }
    if (team.specialists) team.specialists = team.specialists.filter((s) => s.name !== name)
    this.spec.agents.push(spec)
    await this.append({
      type: 'agent/joined',
      actor: SYSTEM,
      payload: {
        agent: {
          name,
          role: 'worker',
          model: chosen,
          tools: toolsFor(this.spec, spec),
          specialty: label,
          focus,
        },
        by,
        focus: `${label}: ${focus}`,
      },
    })
    await this._isolate(name)
    const agent = new ColonyAgent(spec, this, this.resolver)
    this._agents.set(name, agent)
    this._runAgent(agent)
    return prompts.colony.spawned({ name, label, model: chosen })
  }

  /** Crewmates that joined for a job and opened with it: the job's mail is for the log, not delivered again. */
  private readonly _jobInKickoff = new Map<string, string>()
  /** Crewmates the lead is waiting on (ask_crewmate): their next reply to the lead answers it. */
  private readonly _asked = new Map<
    string,
    { lead: string; since: number; resolve(text: string): void; reject(err: Error): void }
  >()

  async askCrewmate(by: string, name: string, job: string): Promise<string> {
    if (this.spec.agents.find((a) => a.name === by)?.role !== 'lead')
      throw new Error('only the lead asks its crewmates')
    const onCall = this.spec.team?.crewmates ?? []
    const want = name.trim().toLowerCase()
    const here = this.spec.agents.find((a) => a.role === 'worker' && a.name.toLowerCase() === want)
    const called = here ?? onCall.find((c) => c.name.toLowerCase() === want)
    if (!called)
      throw new Error(
        prompts.toolResults.noCrewmate(
          name,
          onCall.map((c) => `${c.name} (${c.specialty ?? 'crewmate'})`),
        ),
      )
    if (this._state.agents[called.name]?.dismissed) throw new Error(`${called.name} has left this round`)
    if (this._asked.has(called.name))
      throw new Error(`${called.name} is still working on what you asked; wait for that answer first`)
    const since = this._state.lastSeq
    const answer = new Promise<string>((resolve, reject) =>
      this._asked.set(called.name, { lead: by, since, resolve, reject }),
    )
    try {
      if (!here) {
        // On call until now: it joins the round and opens with its job, which is all it is told to do.
        const spec: AgentSpec = { ...called, role: 'worker', focus: job }
        this._jobInKickoff.set(spec.name, job)
        this.spec.agents.push(spec)
        await this.append({
          type: 'agent/joined',
          actor: SYSTEM,
          payload: {
            agent: {
              name: spec.name,
              role: 'worker',
              model: spec.model,
              tools: toolsFor(this.spec, spec),
              ...(spec.specialty ? { specialty: spec.specialty } : {}),
              focus: job,
            },
            by,
            focus: `${spec.specialty ?? 'crewmate'}: ${job}`,
          },
        })
        await this._isolate(spec.name)
        const agent = new ColonyAgent(spec, this, this.resolver)
        this._agents.set(spec.name, agent)
        this._runAgent(agent)
      }
      // The job goes by mail, as any message between crewmates does, so it shows in the round's Mail.
      await this.append({
        type: 'mail/sent',
        actor: { kind: 'agent', id: by },
        payload: { from: by, to: called.name, subject: '', body: job },
      })
      const ended = this.done.then(() => {
        throw new Error('the round ended before the answer came')
      })
      return prompts.toolResults.crewmateAnswer(called.name, await Promise.race([answer, ended]))
    } finally {
      this._asked.delete(called.name)
    }
  }

  async dismissWorker(by: string, name: string, reason: string): Promise<string> {
    if (this.spec.agents.find((a) => a.name === by)?.role !== 'lead')
      throw new Error('only the lead can dismiss crewmates')
    const worker = this.spec.agents.find((a) => a.name === name)
    if (!worker || worker.role === 'lead') throw new Error(`no crewmate named ${name}`)
    if (this._state.agents[name]?.dismissed) throw new Error(`${name} was already dismissed`)
    await this.append({ type: 'agent/dismissed', actor: SYSTEM, payload: { agent: name, by, reason } })
    this._agents.get(name)?.stop()
    cellKernels.close(this.id, name)
    void debugSessions.close(this.id, name)
    const held = Object.values(this._state.tasks).filter(
      (t) => t.status === 'in_progress' && t.owner === name,
    )
    return `dismissed ${name}${held.length ? `; ${held.map((t) => t.id).join(', ')} will be released for re-assignment` : ''}`
  }

  requestTaskVerification(taskId: string, by: string): void {
    this._verifying += 1
    this._verifier
      .verifyTask(taskId)
      .catch(async (err) => {
        await this.append({
          type: 'board/posted',
          actor: { kind: 'user', id: 'verifier' },
          payload: {
            agent: 'verifier',
            text: `Task review for ${taskId} failed to run: ${String(err)}`,
            mentions: [by],
          },
        }).catch(() => {})
      })
      .finally(() => {
        this._verifying -= 1
      })
  }

  /**
   * Gives a coding worker of a team round its own git worktree (outside git, its own copy), so parallel workers never
   * edit the same files.
   * The lead, single-agent rounds, and "ask" or read-only projects keep working in the folder itself.
   */
  private async _isolate(name: string) {
    const project = this.spec.chat?.project
    const agent = this.spec.agents.find((a) => a.name === name)
    if (!agent || !project || this._worktrees === null) return
    if (presetOf(this.spec) !== 'auto' || this.spec.tier !== 'team' || isLead(this.spec, agent)) return
    if (!toolsFor(this.spec, agent).some((t) => t === 'fs_write' || t === 'fs_edit' || t === 'shell')) return
    try {
      const root = join(this.workspace.colonyDir, 'worktrees')
      this._worktrees ??=
        (await ProjectWorktrees.open(project.path, root, this.id)) ??
        (await ProjectCopies.open(project.path, root)) ??
        null
      if (!this._worktrees) return
      const tree = await this._worktrees.create(name)
      this.workspace.isolate(name, {
        ...tree,
        ...(this._worktrees instanceof ProjectCopies ? { copy: true } : {}),
      })
      if (!this._state.worktrees[name])
        await this.append({
          type: 'worktree/created',
          actor: SYSTEM,
          payload: { agent: name, branch: tree.branch, path: tree.path },
        })
    } catch (err) {
      // Without a worktree the worker still works, in the shared folder as before.
      console.error(`worktree for ${name} failed:`, err)
    }
  }

  async experimentTree(agent: string): Promise<ExperimentTree> {
    const project = this.spec.chat?.project
    if (!project) throw new Error(prompts.autoresearch.noProject)
    const preset = presetOf(this.spec)
    if (preset !== 'auto' && preset !== 'full') throw new Error(prompts.autoresearch.preset(preset))
    if (this._worktrees === undefined)
      this._worktrees =
        (await ProjectWorktrees.open(project.path, join(this.workspace.colonyDir, 'worktrees'), this.id)) ??
        null
    const trees = this._worktrees
    // An experiment keeps and drops trials as commits on its branch: a copy has none.
    if (!(trees instanceof ProjectWorktrees)) throw new Error(prompts.autoresearch.notGit(project.name))
    const tree = await trees.create(agent)
    if (!this.workspace.isolation(agent)) {
      this.workspace.isolate(agent, tree)
      this._experimenting.add(agent)
    }
    if (!this._state.worktrees[agent])
      await this.append({
        type: 'worktree/created',
        actor: SYSTEM,
        payload: { agent, branch: tree.branch, path: tree.path },
      })
    return {
      workdir: tree.workdir,
      branch: tree.branch,
      keep: (message) => trees.keep(agent, message),
      revert: () => trees.revert(agent),
      finish: async () => {
        const files = await this.mergeWork(agent)
        if (this._experimenting.delete(agent)) this.workspace.release(agent)
        return files
      },
    }
  }

  async refreshWork(agent: string): Promise<string[]> {
    if (!this._worktrees || !this.workspace.isolation(agent)) return []
    const result = await this._worktrees.refresh(agent).catch((err) => {
      console.error(`refreshing ${agent}'s worktree failed:`, err)
      return { kind: 'nothing' } as const
    })
    if (result.kind !== 'merged') return []
    await this.append({ type: 'worktree/updated', actor: SYSTEM, payload: { agent, files: result.files } })
    return result.files
  }

  async mergeWork(agent: string): Promise<string[]> {
    if (!this._worktrees || !this.workspace.isolation(agent)) return []
    const result = await this._worktrees.merge(agent)
    if (result.kind === 'nothing') return []
    if (result.kind === 'merged') {
      await this.append({ type: 'worktree/merged', actor: SYSTEM, payload: { agent, files: result.files } })
      return result.files
    }
    await this.append({ type: 'worktree/conflict', actor: SYSTEM, payload: { agent, files: result.files } })
    throw new Error(
      `your changes conflict with what others changed in the project, in ${result.files.join(', ')}. Your worktree now has both sides, marked with <<<<<<< ======= >>>>>>>: keep what both changes need, remove the markers, run the checks, and submit again.`,
    )
  }

  /** The judge checks the project folder, so every worker's changes land there first; returns what failed to merge. */
  private async _mergeWorktrees(): Promise<string | undefined> {
    const conflicts: string[] = []
    for (const name of Object.keys(this._state.worktrees))
      await this.mergeWork(name).catch((err: Error) => conflicts.push(`${name}: ${err.message}`))
    return conflicts.length ? conflicts.join('\n') : undefined
  }

  async requestReview(by: string, summary: string): Promise<string> {
    if (this._finalRunning) return prompts.colony.reviewRunning
    // Claimed before the merge: a second trigger arriving while it runs must not start its own review.
    this._finalRunning = true
    this._verifying += 1
    try {
      const conflicts = await this._mergeWorktrees()
      if (conflicts) return prompts.colony.notReviewed(conflicts)
      await this.append({
        type: 'verifier/requested',
        actor: { kind: 'agent', id: by },
        payload: { target: 'colony', by },
      })
      const result = await this._verifier.verifyColony()
      return result.pass
        ? prompts.colony.reviewPassed(result.report)
        : prompts.colony.reviewFailed(summary.slice(0, 300), result.report)
    } finally {
      this._finalRunning = false
      this._verifying -= 1
    }
  }

  async requestFinalVerification(by: string, summary: string): Promise<string> {
    if (this._finalRunning) return prompts.colony.verificationRunning
    const open = this._openWork()
    if (open) return open
    this._finalRunning = true
    this._verifying += 1
    try {
      const conflicts = await this._mergeWorktrees()
      if (conflicts) return prompts.colony.notVerified(conflicts)
      await this.append({
        type: 'verifier/requested',
        actor: { kind: 'agent', id: by },
        payload: { target: 'colony', by },
      })
      const result = await this._verifier.verifyColony()
      if (result.pass) {
        // Work can open while the checks run (a task claimed, a call asking the person).
        const opened = this._openWork()
        if (opened) return opened
        await this._complete(result.verdicts, by)
        return prompts.colony.verified(result.report)
      }
      // Outside chat, everyone hears about a failed check; in chat the speaker owns the fix.
      if (!this.spec.chat) {
        for (const agent of this._agents.values()) {
          if (agent.name !== by)
            agent.notify({
              trigger: 'verdict',
              text: prompts.colony.verificationFailedFor(by, result.report),
            })
        }
      }
      return prompts.colony.verificationFailed({ report: result.report, by, summary: summary.slice(0, 500) })
    } finally {
      this._finalRunning = false
      this._verifying -= 1
    }
  }

  /**
   * Why a run outside a chat cannot complete yet: a task someone is still doing, or waiting for its check, or a call
   * waiting for the person (see `openWork`). In a chat the answer the person got completes the round instead, and the
   * crew winds down after it (`_complete`).
   */
  private _openWork(): string | undefined {
    if (this.spec.chat) return undefined
    const work = openWork(this._state)
    if (!hasOpenWork(work)) return undefined
    return prompts.colony.workStillOpen({
      tasks: work.tasks.map((t) => `${t.id} [${t.status}${t.owner ? `, ${t.owner}` : ''}]: ${t.subject}`),
      approvals: work.approvals.map((a) => a.summary),
    })
  }

  /**
   * Completes the round. In a chat with a crew it winds down like a group chat first: the answer is with the person,
   * but anyone mid-reply finishes and what was said gets read (see `_watch`), so nobody is cut off.
   */
  private async _complete(verdicts: MyrEvent['id'][], by: string) {
    if (this.spec.chat && this._agents.size > 1) {
      if (this._settling) return
      const told = [...this._agents.keys()].filter((name) => name !== by)
      this._settling = { verdicts, until: Date.now() + CHAT_SETTLE_MS, said: new Map(), told }
      // The rest hear the conversation is ending: mid-reply, at once; otherwise with whatever wakes them next.
      for (const name of told)
        this._wake(
          name,
          prompts.colony.windDown(by),
          'wind-down',
          this._agents.get(name)?.idle ? { quiet: true } : {},
        )
      return
    }
    this._closing = true
    await this.append({ type: 'colony/completed', actor: SYSTEM, payload: { verdicts } })
    void this._end()
  }

  /** Ends the wind-down: the round completes with the verdicts its answer earned. */
  private async _closeSettled() {
    const settle = this._settling
    if (!settle) return
    this._closing = true
    this._settling = undefined
    await this.append({ type: 'colony/completed', actor: SYSTEM, payload: { verdicts: settle.verdicts } })
    await this._end()
  }

  /**
   * The conversation picked up again before the round closed (the person wrote, or the latest answer was rejected):
   * it runs as before the answer, and winds down again after the next one.
   */
  private _reopen() {
    const settle = this._settling
    if (!settle) return
    this._settling = undefined
    // A wind-down note an agent has seen, or that is already on its way into its current step, is answered with one
    // saying the conversation goes on; an unseen one is simply dropped.
    for (const a of this._agents.values())
      if (!a.reopen('wind-down') && settle.told.includes(a.name))
        this._wake(a.name, prompts.colony.reopened, 'reopened', a.idle ? { quiet: true } : {})
  }

  closing(agent: string): string | undefined {
    const settle = this._settling
    if (!settle) return undefined
    const said = settle.said.get(agent) ?? 0
    if (said < WIND_DOWN_MESSAGES) {
      settle.said.set(agent, said + 1)
      return undefined
    }
    // Like someone who has said goodbye: it still reads what comes in, but it is done talking this round.
    this._agents.get(agent)?.endTurnAfterStep()
    return prompts.colony.chatClosing
  }

  /**
   * A chat round's final answer verifies itself: no judge completes it outright, otherwise the judge runs. In goal
   * mode the goal's condition is checked first, and the answer goes on to its review only once the goal holds.
   */
  private async _verifyFinalAnswer(by: string) {
    if (this.spec.goal && !this._settling && !(await this._goalHolds(by, this.spec.goal))) return
    if (this.spec.acceptance.length === 0 || this.spec.review === 'off' || this.spec.review === 'auto') {
      // Winding down, the round has its delivered verdict already, and nobody reviews this answer either.
      if (this._settling) return
      // Completion always cites a passing verdict; an unjudged direct answer records that it was delivered.
      const verdict = await this.append({
        type: 'verifier/verdict',
        actor: { kind: 'verifier', id: DELIVERED_VERIFIER },
        payload: {
          target: 'colony',
          verifierId: DELIVERED_VERIFIER,
          pass: true,
          evidence:
            this.spec.review === 'auto'
              ? 'Final answer delivered; the agent asks for a review when the work needs one.'
              : 'Final answer delivered; this round is not reviewed.',
        },
      })
      return void (await this._complete([verdict.id], by))
    }
    // A review already reading the work gives the verdict for this answer too; asking again would count as a failure.
    if (this._finalRunning) return
    const before = this._state.verdicts.length
    const report = await this.requestFinalVerification(by, 'final answer sent to the person')
    if (this._state.status !== 'running') return
    // Passed with a crew: the round winds down on this answer instead of completing, so it is still running.
    const judged = this._state.verdicts.slice(before).filter((v) => v.target === 'colony')
    if (judged.length > 0 && judged.every((v) => v.pass)) return
    this._reopen()
    this._failedVerifications += 1
    if (this._failedVerifications >= MAX_VERIFY_ROUNDS)
      return void this.stop(`verification failed ${MAX_VERIFY_ROUNDS} times; see the last verdict`)
    if (this.spec.team?.mode === 'swarm' && this.spec.tier === 'team') {
      // Peers fix the findings as a normal task; the speaker answers again once it is verified.
      this._speakerOwesAnswer = true
      await this.appendAtomic((s) => [
        {
          type: 'task/changed',
          actor: SYSTEM,
          payload: {
            by: 'verifier',
            task: {
              id: `task-${Object.keys(s.tasks).length + 1}`,
              revision: 1,
              subject: prompts.colony.findingsTask,
              description: report.slice(0, 4000),
              status: 'pending',
              blockedBy: [],
              artifacts: [],
            },
          },
        },
      ])
      return
    }
    this._agents.get(by)?.notify({
      trigger: 'verdict',
      text: prompts.colony.fixFinalAnswer(report),
    })
  }

  /**
   * Goal mode (after omp's goal mode and `/loop --until`): checks the goal on a final answer. While it fails, whoever
   * answered hears the result and keeps working; the round stops once the checks run out, when nothing was done since
   * the last check (omp's no-progress stop), or when the condition cannot be checked at all. The person's Stop ends it
   * like any round. True when the goal holds.
   */
  private async _goalHolds(by: string, goal: NonNullable<ColonySpec['goal']>): Promise<boolean> {
    // A check already running answers for this answer too, as a running review does.
    if (this._goalRunning) return false
    this._goalRunning = true
    // Counted before anything is awaited: a round whose speaker has signed off must not close as quiet meanwhile.
    this._verifying += 1
    // The answer it signed off with does not meet the goal, so the sign-off no longer holds (a quick check can come
    // back before that turn has even ended), and an earlier result it has not read yet is stale.
    const keepGoing = (text: string) => {
      this._reopen()
      const agent = this._agents.get(by)
      agent?.reopen('goal')
      agent?.notify({ trigger: 'goal', text })
      return false
    }
    try {
      const conflicts = await this._mergeWorktrees()
      if (conflicts) return keepGoing(prompts.colony.notVerified(conflicts))
      const since = this._goalCheckedAt
      const check = ++this._goalChecks
      const outcome = await this._verifier.verifyGoal(goal, check, by)
      this._goalCheckedAt = this._state.lastSeq
      if (this._state.status !== 'running') return false
      if (outcome.pass) return true
      const stop = outcome.broken
        ? prompts.colony.goalBroken(outcome.evidence.split('\n')[0] ?? '')
        : check >= goal.maxChecks
          ? prompts.colony.goalCapped(check)
          : check > 1 && !(await this._workedSince(since))
            ? prompts.colony.goalStalled
            : undefined
      if (stop) {
        void this.stop(stop)
        return false
      }
      return keepGoing(
        prompts.colony.goalNotMet({
          condition: goal.condition,
          check,
          max: goal.maxChecks,
          report: outcome.evidence,
        }),
      )
    } finally {
      this._goalRunning = false
      this._verifying -= 1
    }
  }

  /**
   * Prewalk (after omp's prewalk): the lead planned on its own model; at its first change it switches, once, to the
   * cheaper carry-out model, its conversation intact, from its next step. Logged as `agent/handoff` and shown in the
   * chat. In plan mode the lead changes nothing before the person approves the plan, so the switch follows approval.
   * A carry-out model that cannot be used (signed out, removed) leaves the lead on its own model.
   */
  private async _handOff(name: string, after: string, target: string) {
    const agent = this._agents.get(name)
    if (agent?.spec.role !== 'lead' || this._handedOff) return
    this._handedOff = true
    const previous = agent.spec.model
    if (previous === target || this._state.status !== 'running') return
    try {
      await this.resolver.requireCredentials(target)
    } catch (err) {
      console.warn(
        `prewalk: staying on ${previous}: ${target} is not usable: ${err instanceof Error ? err.message : err}`,
      )
      return
    }
    agent.switchModel(target)
    await this.append({
      type: 'agent/handoff',
      actor: SYSTEM,
      payload: { agent: name, model: target, previous, after },
    })
    this._wake(name, prompts.colony.prewalkHandoff(target), 'prewalk')
  }

  /** Whether any agent did something (a tool call other than answering or asking) after log position `since`. */
  private async _workedSince(since: number): Promise<boolean> {
    return (await this.log.read(this.id)).some(
      (e) =>
        e.seq > since &&
        e.type === 'tool/call' &&
        !ANSWERING.has((e.payload as EventPayloads['tool/call']).tool),
    )
  }

  batchEnded(agent: string): void {
    const queued = this._afterBatch.get(agent)
    if (!queued) return
    this._afterBatch.delete(agent)
    for (const announce of queued) announce()
  }

  private _wake(name: string, text: string, trigger: string, extra: Delivery = {}) {
    // While the person is being asked something, nobody acts on anything else.
    if (this._awaiting) {
      this._held.push({ name, text, trigger, ...extra })
      return
    }
    this._agents.get(name)?.notify({ text, trigger, ...extra })
  }

  private _route(e: MyrEvent) {
    const notify = (name: string, text: string, trigger: string, extra: Delivery = {}) =>
      this._wake(name, text, trigger, extra)
    const swarm = this.spec.team?.mode === 'swarm' && this.spec.tier === 'team'
    switch (e.type) {
      case 'chat/user': {
        const p = e.payload as EventPayloads['chat/user']
        this._awaiting = false
        this._reopen()
        const held = this._held.splice(0)
        // The event id doubles as a mail id, so the agent's mail/delivered marks the message read.
        const delivery: Delivery = { mail: e.id, ...(p.mode === 'queue' ? { queue: true } : {}) }
        const text = `${p.context ? prompts.chat.context(p.context) : ''}${p.text}${attachedNote(p.attachments)}${p.voice ? prompts.chat.spoken : ''}`
        // Written to someone directly (@name): they hear it and answer; whoever speaks for the round only hears of it.
        const to = (p.to ?? []).filter((name) => this._agents.has(name))
        if (to.length) {
          for (const name of to) notify(name, prompts.colony.direct(text), 'user', delivery)
          for (const a of this._agents.values())
            if (!to.includes(a.name) && toolsFor(this.spec, a.spec).includes('reply_user'))
              notify(a.name, prompts.colony.directElsewhere(to, text), 'user', { quiet: true })
        } else if (swarm) {
          const target = this._state.tasks['task-final']?.owner ?? this.spec.agents[0]?.name
          if (target) notify(target, `${text}\n\n${snapshot(this.spec, this._state)}`, 'user', delivery)
        } else {
          const talkers = [...this._agents.values()].filter((a) =>
            toolsFor(this.spec, a.spec).includes('reply_user'),
          )
          for (const a of talkers.length > 0 ? talkers : [...this._agents.values()])
            notify(a.name, text, 'user', delivery)
        }
        for (const { name, text, trigger, ...rest } of held) notify(name, text, trigger, rest)
        break
      }
      case 'chat/reply': {
        const p = e.payload as EventPayloads['chat/reply']
        if (p.question) this._awaiting = true
        else if (p.final && this.spec.chat) {
          // Whoever gave the final answer has signed off; it still hears anything written to it afterwards.
          this._agents.get(p.agent)?.endTurnAfterStep()
          void this._verifyFinalAnswer(p.agent)
        }
        break
      }
      case 'mail/sent': {
        const p = e.payload as EventPayloads['mail/sent']
        const message = {
          seq: e.seq,
          from: p.from,
          subject: p.subject,
          body: p.body,
          ...(p.replyTo !== undefined ? { replyTo: p.replyTo } : {}),
        }
        // A group message reaches every member, like a group chat's notification; one-to-one, just the person.
        const group = p.members?.length ? p.members : undefined
        if (group)
          for (const m of group)
            if (m !== p.from)
              notify(m, prompts.colony.groupMessage({ ...message, group: p.to }), `group:${p.to}`, {
                mail: e.id,
              })
        // A crewmate answering what the lead asked it (ask_crewmate): the answer goes back as the tool's result.
        const asked = !group ? this._asked.get(p.from) : undefined
        if (asked && p.to === asked.lead && e.seq > asked.since) {
          this._asked.delete(p.from)
          asked.resolve(p.body)
          break
        }
        if (!group && this._jobInKickoff.get(p.to) === p.body) {
          this._jobInKickoff.delete(p.to)
          void this.append({ type: 'mail/delivered', actor: SYSTEM, payload: { mail: e.id, to: p.to } })
          break
        }
        if (!group) notify(p.to, prompts.colony.mail(message), 'mail', { mail: e.id })
        break
      }
      case 'group/created':
      case 'group/changed': {
        const p = e.payload as EventPayloads['group/created'] & Partial<EventPayloads['group/changed']>
        const added = e.type === 'group/created' ? p.members : (p.add ?? [])
        const members = this._state.groups[p.name]?.members ?? []
        for (const m of added)
          if (m !== p.by)
            notify(m, prompts.colony.addedToGroup(p.by, p.name, members), 'group', { quiet: true })
        for (const m of p.remove ?? [])
          if (m !== p.by) notify(m, prompts.colony.removedFromGroup(p.by, p.name), 'group', { quiet: true })
        break
      }
      case 'board/posted': {
        const p = e.payload as EventPayloads['board/posted']
        if (this._huddle && this._agents.has(p.agent)) {
          this._huddle.proposed.add(p.agent)
          if (this._huddle.proposed.size >= this._agents.size) this._closeHuddle('every peer proposed')
        }
        for (const m of p.mentions)
          if (m !== p.agent) notify(m, prompts.colony.mentioned(e.seq, p.agent, p.text), 'mention')
        // Everyone else sees it at their next turn, the way a team chat is read: not a reason to wake.
        for (const m of crewOf(this._state))
          if (m !== p.agent && !p.mentions.includes(m))
            notify(m, prompts.colony.teamMessage(e.seq, p.agent, p.text), 'team', { quiet: true })
        break
      }
      case 'observer/signal': {
        const p = e.payload as EventPayloads['observer/signal']
        const everyone =
          this.spec.chat && this.spec.tier === 'team' ? this._stallTargets() : [...this._agents.keys()]
        const targets = p.targets.length > 0 ? p.targets : everyone
        for (const t of targets) notify(t, `${p.kind} (${p.severity}): ${p.facts}`, `observer:${p.kind}`)
        break
      }
      case 'task/changed': {
        const p = e.payload as EventPayloads['task/changed']
        // Task verdicts are announced once the task's status reflects them, so nobody acts on a task that is
        // still marked submitted, and a verdict on work already sent back is not announced at all.
        if (p.by === 'verifier' && (p.task.status === 'verified' || p.task.status === 'rejected')) {
          const task = p.task
          const pass = task.status === 'verified'
          const evidence =
            this._state.verdicts.filter((v) => v.target === `task:${task.id}`).at(-1)?.evidence ?? ''
          if (task.owner) notify(task.owner, prompts.colony.taskVerdict(task.id, pass, evidence), 'verdict')
          // Leads coordinate integration, so they hear about every task outcome, not only their own.
          for (const lead of this.spec.agents.filter((a) => a.role === 'lead' && a.name !== task.owner)) {
            const open = Object.values(this._state.tasks).filter(
              (t) => t.status !== 'verified' && t.status !== 'deleted',
            )
            notify(
              lead.name,
              prompts.colony.leadVerdict({
                id: task.id,
                revision: task.revision,
                owner: task.owner ?? '?',
                pass,
                evidence,
                open: open.map((t) => `${t.id}[${t.status}]`).join(', '),
              }),
              'verdict',
            )
          }
        }
        const creator = this._agents.get(p.by)
        if (creator?.working) {
          const queued = this._afterBatch.get(p.by) ?? []
          queued.push(() => this._announceTask(p))
          this._afterBatch.set(p.by, queued)
        } else this._announceTask(p)
        if (p.task.status === 'verified') this._announceUnblocked(p.task.id)
        break
      }
      case 'agent/status':
      case 'agent/dismissed': {
        const p = e.payload as { agent: string; status?: string; detail?: string; reason?: string }
        const asked = this._asked.get(p.agent)
        if (asked && (e.type === 'agent/dismissed' || p.status === 'failed')) {
          this._asked.delete(p.agent)
          asked.reject(
            new Error(
              `${p.agent} ${e.type === 'agent/dismissed' ? 'was dismissed' : 'failed'}: ${p.detail ?? p.reason ?? ''}`,
            ),
          )
        }
        break
      }
      case 'tool/result': {
        const p = e.payload as EventPayloads['tool/result']
        if (p.ok && this.spec.prewalk && !this._handedOff && PREWALK_AFTER.has(p.tool))
          void this._handOff(p.agent, p.tool, this.spec.prewalk)
        // A tool that pays for a model call itself (generate_image) spends from the same budget.
        if (p.usage) this._checkBudget()
        break
      }
      case 'agent/turn':
      case 'llm/response': {
        // Fallback for wakes held past a batch: release them when the creator speaks again or ends its turn.
        const agent = (e.payload as { agent: string }).agent
        if (e.type === 'llm/response' || (e.payload as EventPayloads['agent/turn']).phase === 'end')
          this.batchEnded(agent)
        if (e.type === 'agent/turn') {
          if ((e.payload as EventPayloads['agent/turn']).phase === 'end') {
            this._remindHolder(agent)
            // A crewmate that stops without answering the lead: the lead is told, not left waiting.
            const asked = this._asked.get(agent)
            if (asked && e.seq > asked.since) {
              this._asked.delete(agent)
              asked.resolve(prompts.toolResults.crewmateSilent(agent))
            }
          }
          break
        }
        this._checkBudget()
        break
      }
    }
    if (e.type === 'artifact/versioned' || e.type === 'note/appended' || e.type === 'board/posted')
      this._scheduleMirror()
  }

  /** Stops the round once what it spent reaches its money or token limit. */
  private _checkBudget() {
    const { costUsd, tokens, total } = this.spec.budget
    const spent = this.spent()
    // Stopped by a running total, the total spent is its cap less what this run had left of it, plus any overshoot.
    if (costUsd !== undefined && spent.cost >= costUsd)
      void this.stop(
        total
          ? prompts.colony.totalLimit(total.scope, total.usd + spent.cost - costUsd, total.usd)
          : prompts.colony.spendLimit(spent.cost, costUsd),
      )
    else if (tokens !== undefined && spent.tokens >= tokens)
      void this.stop(prompts.colony.tokenLimit(spent.tokens, tokens))
  }

  /** Wakes whoever should hear about a task: its assignee, or idle teammates for a new unassigned task. */
  /**
   * An agent that ends its turn still holding a task has usually stopped early. It is woken to finish and
   * submit, or release the task with what blocks it; at most twice per task, so a real blocker cannot loop.
   */
  private _remindHolder(agent: string) {
    if (this._state.status !== 'running' || this._awaiting) return
    const held = Object.values(this._state.tasks).find(
      (t) => t.status === 'in_progress' && t.owner === agent && t.id !== 'task-final',
    )
    if (this._remindMail(agent)) return
    if (!held) return this._remindTodos(agent)
    const key = `${agent}:${held.id}`
    const sent = this._reminded.get(key) ?? 0
    if (sent >= 2) return
    this._reminded.set(key, sent + 1)
    this._wake(
      agent,
      prompts.colony.holderReminder({
        id: held.id,
        revision: held.revision,
        subject: held.subject,
        sent: sent + 1,
      }),
      'reminder',
    )
  }

  /**
   * A message that asks this agent something (a question or a request, sent to it directly or @mentioning it in a
   * group), read but not answered (nothing from it in that conversation since), is waiting on it like an unanswered
   * text. Acks and FYIs are never chased. It is reminded once per message. Returns whether it was reminded.
   */
  private _remindMail(agent: string): boolean {
    const all = this._state.mail
    const open = all.filter((m) => {
      if (!m.readBy.includes(agent) || !this._agents.has(m.from) || this._state.agents[m.from]?.dismissed)
        return false
      const forMe = m.members ? mentionsIn(m.body, m.members).includes(agent) : m.to === agent
      if (!forMe || !asksSomething(m.body) || this._reminded.has(`${agent}:mail:${m.seq}`)) return false
      return !all.some(
        (r) =>
          r.from === agent &&
          r.seq > m.seq &&
          (r.replyTo === m.seq || (m.members ? r.to === m.to : r.to === m.from && !r.members)),
      )
    })
    if (open.length === 0 || this._state.status !== 'running' || this._awaiting) return false
    for (const m of open) this._reminded.set(`${agent}:mail:${m.seq}`, 1)
    this._wake(
      agent,
      prompts.colony.mailReminder(
        open.map((m) => ({ seq: m.seq, from: m.from, ...(m.members ? { group: m.to } : {}) })),
      ),
      'reminder',
    )
    return true
  }

  /** Like a held task: an agent that stops with its own checklist unfinished is reminded, at most twice. */
  private _remindTodos(agent: string) {
    const open = (this._todos.get(agent) ?? []).filter((t) => !t.done)
    const answered = this._state.chatMessages.some((m) => m.from === agent && m.final)
    if (open.length === 0 || answered) return
    const key = `${agent}:todo`
    const sent = this._reminded.get(key) ?? 0
    if (sent >= 2) return
    this._reminded.set(key, sent + 1)
    this._wake(
      agent,
      prompts.colony.todoReminder(
        open.map((t) => t.text),
        sent + 1,
      ),
      'reminder',
    )
  }

  private _ready(t: TaskSnapshot) {
    return t.blockedBy.every((b) => this._state.tasks[b]?.status === 'verified')
  }

  /** Tasks waiting on `done` that have nothing left blocking them are announced now, as if just created. */
  private _announceUnblocked(done: string) {
    for (const t of Object.values(this._state.tasks)) {
      if (t.blockedBy.includes(done) && t.status === 'pending' && this._ready(t))
        this._announceTask({ task: t, by: 'scheduler' }, true)
    }
  }

  private _announceTask(p: EventPayloads['task/changed'], unblocked = false) {
    const t = p.task
    // Work sent back with a reason goes straight to whoever did it, even if it was assigned to them before.
    const redo = t.owner ?? t.assignee
    if (t.status === 'rejected' && p.reason && redo) {
      this._wake(
        redo,
        prompts.colony.sentBack({
          by: p.by,
          id: t.id,
          reason: p.reason,
          revision: t.revision,
          subject: t.subject,
          description: t.description,
        }),
        'task',
      )
      return
    }
    const open = t.status === 'pending' || t.status === 'rejected' || t.id === 'task-final'
    // Waking someone for a task they cannot claim yet only costs a turn; they hear once it is unblocked.
    if (open && !this._ready(t)) return
    if (t.assignee && open && this._assigned.get(t.id) !== t.assignee) {
      this._assigned.set(t.id, t.assignee)
      const outputs = t.outputs?.length ? prompts.colony.outputs(t.outputs) : ''
      this._wake(
        t.assignee,
        prompts.colony.assigned({
          id: t.id,
          revision: t.revision,
          subject: t.subject,
          description: t.description,
          outputs,
          snapshot: snapshot(this.spec, this._state),
        }),
        'task',
      )
      return
    }
    if ((t.revision !== 1 && !unblocked) || t.assignee) return
    for (const a of this._agents.values()) {
      // In an orchestrated team the lead creates tasks for workers; it does not pick them up itself.
      if (a.name === p.by || !a.idle || (this.spec.team?.mode === 'orchestrated' && a.spec.role === 'lead'))
        continue
      const what = unblocked ? prompts.colony.unblocked(t.id) : prompts.colony.newTask(t.id)
      this._wake(
        a.name,
        prompts.colony.taskAnnounced(what, t.subject, snapshot(this.spec, this._state)),
        'task',
      )
    }
  }

  private async _observe() {
    for (const signal of this._observer.tick()) {
      await this.append({
        type: 'observer/signal',
        actor: { kind: 'observer', id: 'factual' },
        payload: { ...signal, targets: signal.targets ?? [] },
      })
    }
  }

  private async _watch() {
    if (this._state.status !== 'running') return
    if (!this.runtime.ctx.get('log')) return void this._end()
    if (Date.now() >= this._deadline)
      return void this.stop(`budget: wall time ${Math.round(this.spec.budget.wallMs / 1000)}s exhausted`)
    const agents = [...this._agents.values()]
    const live = agents.filter((a) => {
      const status = this._state.agents[a.name]?.status
      return status !== 'failed' && status !== 'stopped'
    })
    if (live.length === 0) return void this.stop('all agents have stopped or failed')
    const now = Date.now()
    for (const a of agents) {
      if (a.idle) this._idleSince.set(a.name, this._idleSince.get(a.name) ?? now)
      else this._idleSince.delete(a.name)
    }
    if (this._settling) {
      const settle = this._settling
      const still = this._verifying === 0 && live.every((a) => a.idle)
      if (still) settle.quietSince ??= now
      else settle.quietSince = undefined
      const quietFor = Math.min(this.options.quietMs ?? SETTLE_QUIET_MS, SETTLE_QUIET_MS)
      if ((settle.quietSince !== undefined && now - settle.quietSince >= quietFor) || now >= settle.until)
        await this._closeSettled()
      return
    }
    if (!this._awaiting) {
      await this._releaseStaleClaims(now)
      if (this._huddle && now - this._huddle.since >= HUDDLE_MS) this._closeHuddle('time is up')
      if (this.spec.team?.mode === 'swarm' && this.spec.tier === 'team') await this._tendSwarm(now)
    }
    const quiet = this._verifying === 0 && live.every((a) => a.idle)
    if (!quiet) {
      this._quietSince = undefined
      return
    }
    // A question to the person pauses the round as soon as everyone has stopped; nothing else can move it on.
    if (this._awaiting && this.spec.chat) return void this.stop(AWAITING_USER)
    this._quietSince ??= now
    if (now - this._quietSince < (this.options.quietMs ?? 8000)) return
    this._quietSince = undefined
    // In a chat, a colony that spoke last and then went quiet is waiting on the human, not stuck.
    const lastChat = this._state.chatMessages.at(-1)
    if (this.spec.chat && lastChat && lastChat.from !== 'user') return void this.stop(AWAITING_USER)
    if (this._nudges >= QUIET_NUDGES)
      return void this.stop('stalled: every agent is idle and the work is not finished')
    this._nudges += 1
    await this.append({
      type: 'observer/signal',
      actor: { kind: 'observer', id: 'factual' },
      payload: {
        targets: this._stallTargets(),
        kind: 'stall',
        severity: this._nudges === QUIET_NUDGES ? 'critical' : 'warn',
        facts: prompts.colony.stall(QUIET_NUDGES - this._nudges + 1, this.spec.chat !== undefined),
      },
    })
  }

  /**
   * Who a stall nudge should wake. In a chat team, only the agents who can move things on: the speaker (lead,
   * swarm seed, or task-final holder) and anyone holding a task. Sleeping specialists stay asleep.
   */
  private _stallTargets(): string[] {
    if (!this.spec.chat || this.spec.tier !== 'team') return []
    const holders = Object.values(this._state.tasks)
      .filter((t) => t.status === 'in_progress' && t.owner)
      .map((t) => t.owner as string)
    const speaker =
      this.spec.team?.mode === 'swarm'
        ? (this._state.tasks['task-final']?.owner ?? this.spec.agents[0]?.name)
        : this.spec.agents.find((a) => a.role === 'lead')?.name
    return [...new Set([...(speaker ? [speaker] : []), ...holders])]
  }

  /** Puts tasks back in the pool when their holder has stopped, failed, or sat idle past the lease. */
  private async _releaseStaleClaims(now: number) {
    for (const t of Object.values(this._state.tasks)) {
      if (t.status !== 'in_progress' || !t.owner || t.id === 'task-final') continue
      const status = this._state.agents[t.owner]?.status
      const idleFor = now - (this._idleSince.get(t.owner) ?? now)
      if (status !== 'failed' && status !== 'stopped' && idleFor < LEASE_MS) continue
      await this.appendAtomic((s) => {
        const cur = s.tasks[t.id]
        if (cur?.status !== 'in_progress' || cur.owner !== t.owner) return []
        const { owner: _owner, ...rest } = cur
        return [
          {
            type: 'task/changed',
            actor: SYSTEM,
            payload: { by: 'scheduler', task: { ...rest, revision: cur.revision + 1, status: 'pending' } },
          },
        ]
      })
      const others = [...this._agents.values()].filter(
        (a) =>
          a.idle &&
          a.name !== t.owner &&
          !(this.spec.team?.mode === 'orchestrated' && a.spec.role === 'lead'),
      )
      const lead = this.spec.agents.find((a) => a.role === 'lead')
      const text = prompts.colony.released(t.id, t.owner, t.subject)
      if (this.spec.team?.mode === 'orchestrated' && lead)
        this._wake(lead.name, prompts.colony.reassign(text), 'task')
      else
        for (const a of others)
          this._wake(a.name, prompts.colony.releasedToPeers(text, snapshot(this.spec, this._state)), 'task')
    }
  }

  /** Swarm upkeep: a second bootstrapper if the first produced nothing, and a speaker once the work is done. */
  private async _tendSwarm(now: number) {
    const tasks = Object.values(this._state.tasks).filter((t) => t.status !== 'deleted')
    const work = tasks.filter((t) => t.id !== 'task-final')
    if (this._huddle) return
    if (work.length === 0) {
      const next = this.spec.agents[this._bootstrapped]
      const seedsIdle = this.spec.agents
        .slice(0, this._bootstrapped)
        .every((a) => this._agents.get(a.name)?.idle)
      if (
        next &&
        seedsIdle &&
        now - this._bootstrapAt >= BOOTSTRAP_MS &&
        this._state.chatMessages.at(-1)?.from === 'user'
      ) {
        this._bootstrapped += 1
        this._bootstrapAt = now
        this._wake(next.name, prompts.colony.bootstrap(snapshot(this.spec, this._state)), 'kickoff')
      }
      return
    }
    if (this._verifying > 0 || !work.every((t) => t.status === 'verified')) return
    const final = this._state.tasks['task-final']
    if (!final) {
      const done = new Map<string, number>()
      for (const t of work) if (t.owner) done.set(t.owner, (done.get(t.owner) ?? 0) + 1)
      // Most verified tasks speaks; ties go to the earliest peer, so the choice is predictable.
      const order = this.spec.agents.map((a) => a.name)
      const speaker =
        [...done].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))[0]?.[0] ??
        order[0] ??
        ''
      await this.appendAtomic((s) =>
        s.tasks['task-final']
          ? []
          : [
              {
                type: 'task/changed',
                actor: SYSTEM,
                payload: {
                  by: 'scheduler',
                  task: {
                    id: 'task-final',
                    revision: 1,
                    subject: prompts.colony.finalTask.subject,
                    description: prompts.colony.finalTask.description,
                    status: 'in_progress',
                    owner: speaker,
                    assignee: speaker,
                    blockedBy: [],
                    artifacts: [],
                  },
                },
              },
            ],
      )
      return
    }
    if (this._speakerOwesAnswer && final.owner && this._agents.get(final.owner)?.idle) {
      this._speakerOwesAnswer = false
      this._wake(final.owner, prompts.colony.findingsAddressed(snapshot(this.spec, this._state)), 'verdict')
    }
  }

  private _scheduleMirror() {
    if (this._mirrorTimer) return
    this._mirrorTimer = setTimeout(() => {
      this._mirrorTimer = undefined
      this.workspace
        .writeMirror(this._state, this.blobs)
        .catch((err) => console.error('mirror write failed:', err))
    }, 300)
  }

  /**
   * Starts an agent's loop. An agent mid-turn when the round ends still records its turn's end once its model call
   * returns, so the runtime waits for the loop before closing the log. The round itself does not wait: the agent
   * ending it (a final answer, a model failure) is inside that very loop.
   */
  private _runAgent(agent: ColonyAgent, fresh?: boolean) {
    const loop = agent.run(fresh).catch((err) => {
      console.error(`[${agent.name}] crashed:`, err)
      void this.append({
        type: 'agent/status',
        actor: SYSTEM,
        payload: { agent: agent.name, status: 'failed', detail: String(err) },
      })
    })
    this.runtime.track?.(loop)
  }

  /** Ends the round once, however many ways it ended at once; every caller waits for the same ending. */
  private _end(): Promise<void> {
    this._ended ??= this._shutDown()
    return this._ended
  }

  private async _shutDown() {
    this._ending = true
    // Nothing of the round runs once it is logged as over: agents stop first, mid-turn or not.
    for (const a of this._agents.values()) a.stop()
    // The round's Stop hooks (notify, archive, …) see how it ended; they cannot change it.
    await this._hooks('Stop', undefined, undefined, {
      status: this._state.status,
      ...(this._state.statusReason ? { reason: this._state.statusReason } : {}),
    }).catch((err) => console.error('Stop hooks failed:', err))
    for (const name of [...this._servers.keys()])
      await this.stopServer(name, 'the round ended').catch(() => {})
    // Code cells' state lasts a round, not a chat: each round's runtimes stop with it, and so do its debug sessions.
    cellKernels.close(this.id)
    await debugSessions.close(this.id)
    for (const { agent, kept } of (await this._worktrees?.close()) ?? [])
      await this.append({ type: 'worktree/closed', actor: SYSTEM, payload: { agent, kept } }).catch(() => {})
    for (const agent of [...this._logins.keys()]) await this.finishLogin(agent, 'stopped').catch(() => false)
    // Nothing may stay waiting on the person once the round is over.
    for (const id of [...this._approvals.keys()])
      await this.decideApproval(id, false, 'stopped').catch(() => {})
    for (const t of this._timers) clearInterval(t)
    this._timers.length = 0
    clearTimeout(this._mirrorTimer)
    this._mirrorTimer = undefined
    await this.options.browser?.closeColony(this.id).catch(() => {})
    this.options.computer?.release(this.id)
    await Bun.sleep(50)
    await this.workspace.writeMirror(this._state, this.blobs).catch(() => {})
    this._offLog?.()
    this._offLog = undefined
    this._finish(this._state)
  }
}
