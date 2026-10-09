import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
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
  AWAITING_USER,
  applyEvent,
  asksSomething,
  type ChatGrant,
  type ColonyId,
  type ColonyState,
  crewOf,
  DELIVERED_VERIFIER,
  describeEffect,
  type EventDraft,
  type EventPayloads,
  emptyColonyState,
  foldColony,
  type MyrEvent,
  mentionsIn,
  outsideEffects,
  type ProjectPermissions,
  type Review,
  SYSTEM,
  type TaskSnapshot,
} from '@myrmidon/protocol'
import { ColonyAgent, type ModelError } from './agent.ts'
import type { BrowserHub } from './browser.ts'
import {
  APPROVAL_MS,
  BOOTSTRAP_MS,
  HUDDLE_MS,
  LEASE_MS,
  LOGIN_MS,
  MAX_SERVERS,
  MAX_VERIFY_ROUNDS,
  MAX_WORKERS,
  QUIET_NUDGES,
  SERVER_START_MS,
} from './config.ts'
import { registerColonyEvents } from './events.ts'
import { type HookEvent, type HookOutcome, type HookStore, hookToolInput, runHooks } from './hooks.ts'
import { agentActor, type ColonyHost, type ReviewDecision, type TodoItem } from './host.ts'
import type { ToolLibrary } from './made-tools.ts'
import type { McpHub } from './mcp.ts'
import type { MemoryStore } from './memory.ts'
import { ModelResolver } from './models.ts'
import { pickName } from './names.ts'
import { FactualObserver } from './observer.ts'
import { attachedNote, isLead, snapshot, toolsFor } from './patterns.ts'
import type { PluginHost } from './plugin-host.ts'
import { type ProjectContext, readProjectContext } from './project-context.ts'

import { prompts } from './prompts.ts'
import {
  detectSandbox,
  fullAccessIn,
  type Sandbox,
  type SandboxProcess,
  unconfinedSandbox,
} from './sandbox.ts'
import { redactDeep } from './secrets.ts'
import type { SkillLibrary } from './skills.ts'
import type { AgentSpec, ColonySpec } from './spec.ts'
import { guessMediaType } from './tools.ts'
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

/** Whether two sets of tool rules are the same, order aside. */
function sameRules(
  a: { disabledTools?: string[]; askTools?: string[]; allowTools?: string[] },
  b: { disabledTools: string[]; askTools: string[]; allowTools: string[] },
) {
  const same = (x: readonly string[] | undefined, y: readonly string[]) =>
    (x ?? []).length === y.length && y.every((t) => (x ?? []).includes(t))
  return (
    same(a.disabledTools, b.disabledTools) && same(a.askTools, b.askTools) && same(a.allowTools, b.allowTools)
  )
}

/** How long shutting down waits for rounds and agents still winding down before closing the log under them. */
const SETTLE_MS = 3_000

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
  /** What the person keeps across chats; agents propose additions to it with remember. */
  readonly memory?: MemoryStore
  /** Skills agents can load by name (use_skill). */
  readonly skills?: SkillLibrary
  /** The person's hooks, run before and after tools and when the round ends. */
  readonly hooks?: HookStore
}

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

/**
 * Every TCP port something on this machine listens on, or undefined where that cannot be read. Taken before a
 * server starts, it tells the ports the server opened from ones that were already in use (the dashboard's, say).
 */
function listeningPorts(): Set<number> | undefined {
  try {
    if (process.platform === 'linux') {
      const ports = new Set<number>()
      for (const table of ['/proc/net/tcp', '/proc/net/tcp6'])
        for (const line of readFileSync(table, 'utf8').split('\n').slice(1)) {
          // "sl local_address rem_address st ...": local_address is HEXIP:HEXPORT, state 0A is LISTEN.
          const [, local, , state] = line.trim().split(/\s+/)
          if (state === '0A' && local) ports.add(Number.parseInt(local.split(':').at(-1) ?? '', 16))
        }
      return ports
    }
    if (process.platform === 'darwin') {
      const out = Bun.spawnSync(['netstat', '-an', '-p', 'tcp'])
      if (out.exitCode !== 0) return undefined
      const ports = new Set<number>()
      for (const line of new TextDecoder().decode(out.stdout).split('\n')) {
        // "tcp4  0  0  127.0.0.1.4318  *.*  LISTEN": the port is the last dotted part of the local address.
        const columns = line.trim().split(/\s+/)
        const port = /\.(\d+)$/.exec(columns[3] ?? '')?.[1]
        if (columns.at(-1) === 'LISTEN' && port) ports.add(Number(port))
      }
      return ports
    }
  } catch {
    return undefined
  }
  return undefined
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
  readonly done: Promise<ColonyState>

  private _state: ColonyState
  private readonly _agents = new Map<string, ColonyAgent>()
  private readonly _verifier: Verifier
  private readonly _observer: FactualObserver
  private readonly _timers: ReturnType<typeof setInterval>[] = []
  private _finish!: (s: ColonyState) => void
  private _deadline = 0
  /** The colony's totals when this round started: a chat's colony keeps running totals across its rounds. */
  private _spentBefore = { cost: 0, tokens: 0 }
  private _finalRunning = false
  private _verifying = 0
  private _quietSince?: number
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
  private _speakerOwesAnswer = false
  private _bootstrapAt = 0
  private _bootstrapped = 1
  /** Set while a swarm's peers are proposing how to split the work; `after` is the seq it opened at. */
  private _huddle?: { since: number; after: number; proposed: Set<string> }
  /** Reminders sent to agents that stopped with work open, keyed by agent and task (or todo list). */
  private readonly _reminded = new Map<string, number>()
  private readonly _approvals = new Map<string, (decision: ReviewDecision) => void>()
  private readonly _servers = new Map<string, SandboxProcess>()
  /** The localhost port each running server opened (see `localPorts`). */
  private readonly _serverPorts = new WeakMap<SandboxProcess, number>()
  private readonly _untrusted = new Map<string, { source: string; text: string }[]>()
  private readonly _logins = new Map<string, (outcome: 'handed-back' | 'timeout' | 'stopped') => void>()
  readonly boundary = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
  private readonly _todos = new Map<string, readonly TodoItem[]>()
  /** Opened on the first worker that needs a worktree; null once known not to be a git project. */
  private _worktrees?: ProjectWorktrees | null

  constructor(
    private readonly runtime: Runtime,
    readonly spec: ColonySpec,
    private readonly options: RunOptions = {},
  ) {
    this.id = options.resumeId ?? newColonyId(spec.name)
    const dir = (runtime.ctx.logStore as SqliteLogStore).colonyDir(this.id)
    this.blobs = new BlobStore(join(dir, 'blobs'))
    this.workspace = new ColonyWorkspace(dir, spec.chat?.project?.path, () => this.fullAccess)
    const folder = spec.chat?.project?.path
    // Read once per round, so every agent works from the same rules even if a file changes mid-round.
    if (folder) this.project = readProjectContext(folder)
    this._confined = options.sandbox ?? detectSandbox()
    this.unsafeNoSandbox = options.unsafeNoSandbox ?? false
    this.resolver = options.resolver ?? new ModelResolver()
    this.web = options.web ?? noWebTools
    this._state = emptyColonyState(this.id)
    this._verifier = new Verifier(this, this.resolver)
    this._observer = new FactualObserver(this)
    this.done = new Promise((resolve) => {
      this._finish = resolve
    })
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

  mcpTools() {
    return this.options.mcp?.tools() ?? []
  }

  mcpReadOnly(tool: string) {
    return this.options.mcp?.readOnly(tool) ?? false
  }

  pluginTools(agent: string) {
    return this.options.plugins?.tools({ colonyId: this.id, agent }) ?? []
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

  async requestApproval(agent: string, tool: string, summary: string): Promise<boolean> {
    return (await this.reviewChange(agent, tool, summary, {})).approved
  }

  async reviewChange(
    agent: string,
    tool: string,
    summary: string,
    options: { review?: Review; key?: string; grant?: ChatGrant },
  ): Promise<ReviewDecision> {
    if (this._state.status !== 'running') return { approved: false }
    if (options.grant && this._state.chatGrants?.includes(options.grant)) return { approved: true }
    const id = `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const decided = new Promise<ReviewDecision>((resolve) => {
      const timer = setTimeout(
        () => void this.decideApproval(id, false, 'timeout').catch(() => {}),
        APPROVAL_MS,
      )
      this._approvals.set(id, (decision) => {
        clearTimeout(timer)
        resolve(decision)
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
        ...(options.grant ? { grant: options.grant } : {}),
      },
    })
    return decided
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
    const done = this._approvals.get(id)
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
    const readOnly = this.spec.chat?.project?.permissions?.mode === 'read-only'
    // A port already in use is someone else's (the dashboard's, another app's): claiming it would open it to agents.
    const before = listeningPorts()
    if (port && (before?.has(port) || (await listening(port))))
      throw new Error(prompts.toolResults.portInUse(port))
    const proc = this.sandbox.start({
      command,
      cwd,
      writable: readOnly ? [scratch] : [...new Set([cwd, scratch])],
      ...(port ? { env: { PORT: String(port) } } : {}),
    })
    this._servers.set(name, proc)
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
    while (!url && !ended && Date.now() < deadline) {
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

  skills(): { name: string; description: string }[] {
    return (this.options.skills?.list(this.spec.chat?.project?.path) ?? [])
      .filter((s) => s.enabled)
      .map((s) => ({ name: s.name, description: s.description }))
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

  toolsChanged() {
    for (const a of this._agents.values()) a.refreshTools()
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
  }

  /**
   * New tool rules from the person, applied to this round at once. If they got stricter (a tool switched off or
   * made to ask first, a project made read-only or ask-first, full access taken back), an agent mid-turn is stopped,
   * so a call the person just took back cannot go ahead, and told what changed. Looser rules wait for the next round.
   */
  async applyRules(next: {
    disabledTools: string[]
    askTools: string[]
    allowTools: string[]
    project?: ProjectPermissions
    /** Whether the round would get full access now (`false` takes it back). */
    fullAccess?: boolean
  }) {
    const spec = this.spec as ColonySpec & {
      disabledTools?: string[]
      askTools?: string[]
      allowTools?: string[]
    }
    const added = (now: readonly string[], before: readonly string[] | undefined) =>
      now.filter((t) => !(before ?? []).includes(t))
    const off = added(next.disabledTools, spec.disabledTools)
    const ask = added(next.askTools, spec.askTools)
    const project = spec.chat?.project
    // Full access is the absence of the sandbox, not a looser mode: losing it is told apart below.
    const strictness = { full: 0, auto: 0, ask: 1, 'read-only': 2 } as const
    const stricter =
      project && next.project
        ? strictness[next.project.mode] > strictness[project.permissions?.mode ?? 'auto']
        : false
    const confined = next.fullAccess === false && this.fullAccess
    const allowedNow = added(next.allowTools, spec.allowTools)
    if (!off.length && !ask.length && !allowedNow.length && !stricter && !confined && sameRules(spec, next))
      return
    spec.disabledTools = next.disabledTools
    spec.askTools = next.askTools
    spec.allowTools = next.allowTools
    if (project && next.project) project.permissions = next.project
    if (confined) spec.fullAccess = false
    this.toolsChanged()
    const interrupted =
      off.length || ask.length || stricter || confined
        ? [...this._agents.values()].filter((a) => a.working)
        : []
    await this.append({
      type: 'permissions/changed',
      actor: { kind: 'user', id: 'user' },
      payload: {
        off,
        ask,
        allow: allowedNow,
        ...(stricter && next.project ? { project: next.project.mode } : {}),
        ...(confined ? { fullAccess: false } : {}),
        interrupted: interrupted.map((a) => a.name),
      },
    })
    const note = prompts.colony.permissionsChanged({
      off,
      ask,
      ...(stricter && next.project ? { project: next.project.mode } : {}),
      confined,
    })
    for (const a of interrupted) a.interrupt('the person changed permissions', note)
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
      ...(this.spec.askTools?.length ? { askTools: this.spec.askTools } : {}),
      ...(this.spec.allowTools?.length ? { allowTools: this.spec.allowTools } : {}),
      ...(this.spec.askAll ? { askAll: true } : {}),
      ...(this.spec.review ? { review: this.spec.review } : {}),
      ...(this.fullAccess ? { fullAccess: true } : {}),
    }
  }

  /**
   * Starts a chat's next round in this colony (built with `resumeId`): the log, files, notes, tasks and agents'
   * conversations carry on, and the new round's spec (tier, team, budget) applies from here. Agents restore their
   * transcripts and are woken with the new request.
   */
  async continueRound(): Promise<void> {
    if (!this.options.resumeId) throw new Error('continueRound needs a colony built with resumeId')
    for (const e of await this.log.read(this.id)) applyEvent(this._state, e)
    if (this._state.status === 'running') throw new Error('this colony is already running a round')
    await this.preflight()
    this._offLog = this.runtime.ctx.on('log/appended', (colonyId, events) => {
      if (colonyId !== this.id) return
      for (const e of events) {
        applyEvent(this._state, e)
        this._route(e)
      }
    })
    await this.append({ type: 'round/started', actor: SYSTEM, payload: this._specPayload() })
    await this._seed?.()
    await this._launch(this.spec.budget.wallMs, undefined, {}, true)
  }

  async start(): Promise<void> {
    await this.preflight()
    const listener = (colonyId: ColonyId, events: readonly MyrEvent[]) => {
      if (colonyId !== this.id) return
      for (const e of events) {
        applyEvent(this._state, e)
        this._route(e)
      }
    }
    this._offLog = this.runtime.ctx.on('log/appended', listener)
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
    if (this._state.status === 'completed') throw new Error('this round already completed')
    const started = past.find((e) => e.type === 'colony/started')
    const used = started ? Date.parse(past.at(-1)?.time ?? started.time) - Date.parse(started.time) : 0
    const left = Math.max(this.spec.budget.wallMs - used, this.spec.budget.wallMs / 2)
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
    this._offLog = this.runtime.ctx.on('log/appended', (colonyId, events) => {
      if (colonyId !== this.id) return
      for (const e of events) {
        applyEvent(this._state, e)
        this._route(e)
      }
    })
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
    this._deadline = Date.now() + wallMs
    if (!resumedBecause) this._spentBefore = totals(this._state)
    this._bootstrapAt = Date.now()
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
      },
    })
    if (resumedBecause) await this._wakeAfterResume(resumedBecause)
    this.runtime.track?.(this.done)
    for (const a of this._agents.values()) this._runAgent(a, !resumedBecause)
    this._timers.push(setInterval(() => void this._observe(), this.spec.observer.intervalMs))
    // A short quiet window (tests) needs a matching tick, or each stall nudge waits a full second.
    const tick = Math.min(1000, this.options.quietMs ?? 1000)
    this._timers.push(setInterval(() => void this._watch(), tick))
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
          snapshot: `${snapshot(this.spec, s)}${done(speaker)}`,
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

  /** Records an agent's proposal to remember something; it applies only once the person keeps it. */
  async proposeMemory(
    agent: string,
    input: { text: string; kind: string; scope: 'everywhere' | 'project'; why: string },
  ): Promise<string> {
    const store = this.options.memory
    if (!store) throw new Error('memory is not available in this run')
    if (Object.values(this._state.memories).filter((m) => m.agent === agent).length >= 5)
      throw new Error('you proposed 5 memories this round already; keep the rest for your reply')
    const project = input.scope === 'project' ? this.spec.chat?.project?.id : undefined
    if (input.scope === 'project' && !project)
      throw new Error('this chat has no project; use scope "everywhere"')
    const memory = store.add({
      text: input.text,
      kind: input.kind,
      ...(project ? { project } : {}),
      status: 'proposed',
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
      },
    })
    return prompts.colony.memoryProposed
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

  async stop(reason: string): Promise<void> {
    if (this._state.status !== 'running') return
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
    extra: { voice?: boolean; context?: string } = {},
  ): Promise<void> {
    if (this._state.status !== 'running') throw new Error('this colony is not running')
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
        `no crewmate called ${name}; yours are: ${onCall.map((c) => c.name).join(', ') || 'none'}`,
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
        // On call until now: it joins the round, its job in its instructions, and is woken by the job's mail below.
        const spec: AgentSpec = {
          ...called,
          role: 'worker',
          instructions: [called.instructions, prompts.colony.crewmateJob(by)].filter(Boolean).join('\n\n'),
        }
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
   * Gives a coding worker of a team round its own git worktree, so parallel workers never edit the same files.
   * The lead, single-agent rounds, and "ask" or read-only projects keep working in the folder itself.
   */
  private async _isolate(name: string) {
    const project = this.spec.chat?.project
    const agent = this.spec.agents.find((a) => a.name === name)
    if (!agent || !project || this._worktrees === null) return
    if (
      (project.permissions?.mode ?? 'auto') !== 'auto' ||
      this.spec.tier !== 'team' ||
      isLead(this.spec, agent)
    )
      return
    if (!toolsFor(this.spec, agent).some((t) => t === 'fs_write' || t === 'fs_edit' || t === 'shell')) return
    try {
      this._worktrees ??=
        (await ProjectWorktrees.open(project.path, join(this.workspace.colonyDir, 'worktrees'), this.id)) ??
        null
      if (!this._worktrees) return
      const tree = await this._worktrees.create(name)
      this.workspace.isolate(name, tree)
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
    const conflicts = await this._mergeWorktrees()
    if (conflicts) return prompts.colony.notReviewed(conflicts)
    this._finalRunning = true
    this._verifying += 1
    try {
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
    const conflicts = await this._mergeWorktrees()
    if (conflicts) return prompts.colony.notVerified(conflicts)
    this._finalRunning = true
    this._verifying += 1
    try {
      await this.append({
        type: 'verifier/requested',
        actor: { kind: 'agent', id: by },
        payload: { target: 'colony', by },
      })
      const result = await this._verifier.verifyColony()
      if (result.pass) {
        await this.append({ type: 'colony/completed', actor: SYSTEM, payload: { verdicts: result.verdicts } })
        void this._end()
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

  /** A chat round's final answer verifies itself: no judge completes it outright, otherwise the judge runs. */
  private async _verifyFinalAnswer(by: string) {
    if (this.spec.acceptance.length === 0 || this.spec.review === 'off' || this.spec.review === 'auto') {
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
      await this.append({ type: 'colony/completed', actor: SYSTEM, payload: { verdicts: [verdict.id] } })
      return void this._end()
    }
    const report = await this.requestFinalVerification(by, 'final answer sent to the person')
    if (this._state.status !== 'running') return
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
        else if (p.final && this.spec.chat) void this._verifyFinalAnswer(p.agent)
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
        const { costUsd, tokens } = this.spec.budget
        const spent = this.spent()
        if (costUsd !== undefined && spent.cost >= costUsd)
          void this.stop(prompts.colony.spendLimit(spent.cost, costUsd))
        else if (tokens !== undefined && spent.tokens >= tokens)
          void this.stop(prompts.colony.tokenLimit(spent.tokens, tokens))
        break
      }
    }
    if (e.type === 'artifact/versioned' || e.type === 'note/appended' || e.type === 'board/posted')
      this._scheduleMirror()
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
      if (!m.delivered || !this._agents.has(m.from) || this._state.agents[m.from]?.dismissed) return false
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

  private async _end() {
    // The round's Stop hooks (notify, archive, …) see how it ended; they cannot change it.
    await this._hooks('Stop', undefined, undefined, {
      status: this._state.status,
      ...(this._state.statusReason ? { reason: this._state.statusReason } : {}),
    }).catch((err) => console.error('Stop hooks failed:', err))
    for (const name of [...this._servers.keys()])
      await this.stopServer(name, 'the round ended').catch(() => {})
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
    for (const a of this._agents.values()) a.stop()
    await this.options.browser?.closeColony(this.id).catch(() => {})
    await Bun.sleep(50)
    await this.workspace.writeMirror(this._state, this.blobs).catch(() => {})
    this._offLog?.()
    this._finish(this._state)
  }
}
