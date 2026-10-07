import type { SqliteLogStore } from '@myrmidon/core'
import {
  type AgentInfo,
  type ColonyId,
  type ColonyState,
  type ColonyStatus,
  type EventPayloads,
  foldColony,
  type MyrEvent,
  type ProjectPermissions,
  type RoundInfo,
} from '@myrmidon/protocol'
import { completeSimple } from '@oh-my-pi/pi-ai'
import type { BrowserHub } from './browser.ts'
import { ChatIndex, type IndexedRound } from './chat-index.ts'
import type { Checkpoints } from './checkpoints.ts'
import { type Attachment, ColonyRun, type Runtime } from './colony.ts'
import type { ToolLibrary } from './made-tools.ts'
import type { McpHub } from './mcp.ts'
import { type MemoryStore, memoryLines } from './memory.ts'
import type { ModelResolver } from './models.ts'
import { pickName } from './names.ts'
import { speaksForColony } from './patterns.ts'
import type { ProjectStore } from './projects.ts'
import { type SettingsStore, TOOL_GROUPS, type ToolGroup } from './settings.ts'
import type { AcceptanceCheck, AgentSpec, ColonySpec, Tier } from './spec.ts'
import type { WebTools } from './web.ts'

const MAX_WORKERS = 8

/** One round of a chat: the colony it ran in, its place in that colony's log, and the colony's state. */
interface RoundRef {
  readonly id: string
  readonly round: RoundInfo
  readonly state: ColonyState
}

/** The team a chat's next round inherits: the latest team round in the same mode, minus dismissed workers. */
function keptTeam(previous: readonly RoundRef[], mode: TeamConfig['mode']): AgentInfo[] {
  const swarm = mode === 'swarm'
  const last = [...previous].reverse().find((r) => r.round.tier === 'team' && r.round.swarm === swarm)
  if (!last) return []
  // A colony that served several rounds holds every agent it ever had: keep the ones of this kind of team.
  const role = swarm ? 'peer' : 'worker'
  return Object.values(last.state.agents)
    .filter((a) => a.info.role === role && !a.dismissed && a.status !== 'failed')
    .map((a) => a.info)
}

/** A round's messages: those logged from its start up to its end. */
function messagesOf(r: RoundRef) {
  const end = r.round.endSeq ?? Number.POSITIVE_INFINITY
  return r.state.chatMessages.filter((m) => m.seq >= r.round.startSeq && m.seq <= end)
}

export interface RosterEntry {
  /** What this teammate is for, e.g. `researcher`, `coder`, `writer`; `peer` for an unspecialised swarm peer. */
  readonly role: string
  readonly model: string
}

export interface TeamConfig {
  /** `orchestrated`: a lead assigns tasks to specialists; `swarm`: equal peers share notes and tasks. */
  readonly mode: 'orchestrated' | 'swarm'
  /** The lead's model, also used for direct answers and one-agent rounds. */
  readonly leadModel: string
  /** Specialists (orchestrated) or peers (swarm), up to 8. */
  readonly roster: readonly RosterEntry[]
  /** Orchestrated only: how many more specialists the lead may add. */
  readonly extraWorkers?: number
  readonly judgeModel: string
  readonly wallMinutes?: number
  /** Overrides how hard reasoning models think in work rounds (direct answers stay quick). */
  readonly thinking?: Thinking
}

export type Thinking = 'low' | 'medium' | 'high'

export interface SendOptions {
  /** For a round already running: steer its next step (default) or queue until the agent finishes. */
  readonly delivery?: 'steer' | 'queue'
  /** Files to put in the round's workspace as `uploads/…` artifacts. */
  readonly attachments?: readonly Attachment[]
  /** Plan mode: the round presents its plan for approval before doing any work. */
  readonly planFirst?: boolean
  /** A new chat's project; later rounds stay in the chat's project. */
  readonly project?: string
  /** Skips triage: an escalated round reruns its request at the tier its agent asked for. */
  readonly tier?: Tier
}

/** Accepts the current team config or the older `{ mode: 'auto' | 'manual', workers, workerModel }` shape. */
export function normalizeTeamConfig(raw: Record<string, unknown>): TeamConfig {
  const str = (v: unknown, fallback = '') => (typeof v === 'string' && v ? v : fallback)
  const leadModel = str(raw.leadModel)
  const judgeModel = str(raw.judgeModel, leadModel)
  const thinking = ['low', 'medium', 'high'].includes(raw.thinking as string)
    ? (raw.thinking as Thinking)
    : undefined
  const wall = {
    ...(typeof raw.wallMinutes === 'number' ? { wallMinutes: raw.wallMinutes } : {}),
    ...(thinking ? { thinking } : {}),
  }
  if (raw.mode === 'orchestrated' || raw.mode === 'swarm') {
    const roster = (Array.isArray(raw.roster) ? raw.roster : [])
      .filter(
        (r): r is RosterEntry => typeof r?.role === 'string' && typeof r?.model === 'string' && !!r.model,
      )
      .slice(0, MAX_WORKERS)
      .map((r) => ({ role: r.role.trim().slice(0, 40) || 'worker', model: r.model }))
    const extra = typeof raw.extraWorkers === 'number' ? Math.max(0, Math.floor(raw.extraWorkers)) : 0
    return { mode: raw.mode, leadModel, roster, extraWorkers: extra, judgeModel, ...wall }
  }
  const workers = Math.min(Math.max(0, Math.floor(Number(raw.workers) || 0)), MAX_WORKERS)
  const workerModel = str(raw.workerModel, leadModel)
  return raw.mode === 'manual'
    ? {
        mode: 'orchestrated',
        leadModel,
        roster: Array.from({ length: workers }, () => ({ role: 'worker', model: workerModel })),
        extraWorkers: 0,
        judgeModel,
        ...wall,
      }
    : { mode: 'orchestrated', leadModel, roster: [], extraWorkers: workers, judgeModel, ...wall }
}

/** Decides how much machinery a request needs before any agent starts. */
export type Classify = (request: string, history: string) => Promise<Tier>

const TRIAGE = `You route requests for Myrmidon, a system that runs teams of AI agents. Classify the person's newest
message into exactly one tier and reply with JSON only: {"tier":"answer"} or {"tier":"solo"} or {"tier":"team"}.
- answer: conversation, greetings, opinions, explanations, definitions, quick facts, short how-to answers,
  questions about Myrmidon or what it can do, and a quick look at one web page ("open X and tell me Y"). One agent
  replies directly, maybe after a quick web search or opening the page.
- solo: one concrete deliverable a single capable agent can finish in a few steps: a small script or page, a short
  document, a focused research summary, a fix to an earlier file.
- team: large or multi-part work that benefits from several specialists in parallel: an app with several parts,
  broad research across many sources, a document plus code plus tests. Also short follow-ups like "go" or
  "continue" when the earlier conversation was team work.
When unsure between two tiers, pick the smaller one.`

/** The default classifier: one short call to the lead's model. Scripted test models skip it. */
export function llmClassifier(resolver: ModelResolver, model: () => string): Classify {
  return async (request, history) => {
    const resolved = resolver.resolve(model())
    if (resolved.streamFn || resolved.model.api === 'mock') return 'team'
    const reply = await Promise.race([
      completeSimple(
        resolved.model,
        {
          systemPrompt: [TRIAGE],
          messages: [
            {
              role: 'user',
              content: `${history ? `Earlier in the conversation:\n${history.slice(-3000)}\n\n` : ''}Newest message: ${request.slice(0, 4000)}`,
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey: await resolver.requireApiKey(resolved.model) },
      ),
      Bun.sleep(25_000).then(() => undefined),
    ])
    if (!reply) throw new Error('triage timed out')
    if (reply.stopReason === 'error') throw new Error(reply.errorMessage ?? 'triage call failed')
    const text = reply.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')
    const tier = /"tier"\s*:\s*"(answer|solo|team)"/.exec(text)?.[1]
    if (!tier) throw new Error(`triage gave no tier: ${text.slice(0, 120)}`)
    return tier as Tier
  }
}

export interface ChatRound {
  readonly colonyId: string
  readonly round: number
  readonly status: ColonyStatus
  readonly request: string
  /** Swarm rounds have no lead to address. */
  readonly swarm: boolean
}

export interface ChatSummary {
  readonly chatId: string
  readonly title: string
  readonly updatedAt: string
  readonly status: ColonyStatus
  readonly rounds: ChatRound[]
  /** The project folder the chat works in, if any. */
  readonly project?: { readonly id: string; readonly name: string }
}

const RUBRIC = `Judge whether the colony did what the person asked, completely and correctly.
- Every part of the request is addressed; nothing is silently skipped.
- Claims are accurate; when the request asks for research or sources, they are cited. Code is correct and complete
  (no placeholders).
- The final answer and any delivered files are consistent with each other and usable as described.
- The response fits the request: a simple question deserves a direct answer, not a report.
Score 1.0 only for work you would hand to the person as-is.`

/** The earlier rounds of a chat as `User:` / `Colony:` pairs, for agents that were not in them. */
function conversation(previous: readonly RoundRef[]): string {
  return (
    previous
      // An escalated round's request was rerun by the next round; listing it would repeat it.
      .filter((r) => !r.round.escalated)
      .map((r) => {
        const replies = messagesOf(r).filter((m) => m.from !== 'user')
        const final = replies.filter((m) => m.final).at(-1) ?? replies.at(-1)
        return `User: ${r.round.request}\nColony (${r.round.status}): ${final?.text ?? '(no reply)'}`
      })
      .join('\n\n')
  )
}

function newChatId() {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function title(text: string) {
  const line = text.trim().split('\n')[0] ?? 'Chat'
  return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

/** Conversations as sequences of colony rounds. Follow-ups after a round ends start a new round on its files. */
export class ChatService {
  private readonly _live = new Map<string, ColonyRun>()
  private readonly _sending = new Map<string, Promise<unknown>>()

  constructor(
    private readonly runtime: Runtime,
    private readonly options: {
      resolver: ModelResolver
      unsafeNoSandbox?: boolean
      settings?: SettingsStore
      web?: WebTools
      /** Defaults to one short call to the lead's model; see `llmClassifier`. */
      classify?: Classify
      /** MCP servers whose tools colonies may use. */
      mcp?: McpHub
      /** Snapshots of project folders, for each round's changes and rewinding. */
      checkpoints?: Checkpoints
      /** The person's kept tools (made by agents), loaded into every round. */
      library?: ToolLibrary
      /** Shared headless Chrome for the browser_* tools. */
      browser?: BrowserHub
      /** What the person keeps across chats: recalled into every round, added to by agents' proposals. */
      memory?: MemoryStore
      /** Project folders chats can work in. */
      projects?: ProjectStore
    },
  ) {}

  private get store() {
    return this.runtime.ctx.logStore as SqliteLogStore
  }

  private _index?: ChatIndex
  private get index() {
    this._index ??= new ChatIndex(this.store.home, this.store)
    return this._index
  }

  private readonly _liveState = (id: string) => [...this._live.values()].find((r) => r.id === id)?.state()

  /**
   * One chat's rounds in order, each with its colony's state. A chat runs in one colony; chats from before that
   * have a colony per round, and their next round continues the latest one.
   */
  private async rounds(chatId: string): Promise<RoundRef[]> {
    const mine = (await this.index.rounds(this._liveState))
      .filter((r) => r.chatId === chatId)
      .sort((a, b) => a.round - b.round)
    const states = new Map<string, ColonyState>()
    const out: RoundRef[] = []
    for (const r of mine) {
      let state = states.get(r.colonyId)
      if (!state) {
        state =
          this._liveState(r.colonyId) ?? foldColony(r.colonyId, await this.store.read(r.colonyId as never))
        states.set(r.colonyId, state)
      }
      const round = state.rounds.find((x) => x.round === r.round) ?? state.rounds.at(-1)
      if (round) out.push({ id: r.colonyId, round, state })
    }
    return out
  }

  async list(): Promise<ChatSummary[]> {
    const byChat = new Map<string, IndexedRound[]>()
    for (const r of await this.index.rounds(this._liveState))
      byChat.set(r.chatId, [...(byChat.get(r.chatId) ?? []), r])
    const out: ChatSummary[] = []
    for (const [chatId, list] of byChat) {
      list.sort((a, b) => a.round - b.round)
      const last = list.at(-1)
      const first = list[0]
      if (!last || !first) continue
      const renamed = list
        .map((r) => r.title)
        .filter((t) => t !== undefined)
        .sort((a, b) => a.at.localeCompare(b.at))
        .at(-1)
      out.push({
        chatId,
        title: renamed?.title ?? title(first.request || first.name),
        ...(first.project ? { project: first.project } : {}),
        updatedAt: last.endedAt ?? last.createdAt ?? '',
        status: last.status,
        rounds: list.map((r) => ({
          colonyId: r.colonyId,
          round: r.round,
          status: r.status,
          request: r.request,
          swarm: r.swarm,
        })),
      })
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * Delivers to the running round if there is one; otherwise starts a new round. Sends to one chat are
   * serialized: a second request that arrives while a round is still starting (a double-clicked retry)
   * waits for it and goes to its lead, instead of starting a second colony that nothing can stop.
   */
  async send(
    text: string,
    config: TeamConfig,
    chatId?: string,
    options: SendOptions = {},
  ): Promise<{ chatId: string; colonyId: string; started: boolean; round?: number }> {
    const message = text.trim()
    if (!message) throw new Error('message is empty')
    const id = chatId ?? newChatId()
    const turn = (this._sending.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.deliver(id, message, config, options))
    this._sending.set(id, turn)
    try {
      return await turn
    } finally {
      if (this._sending.get(id) === turn) this._sending.delete(id)
    }
  }

  private async deliver(
    id: string,
    message: string,
    config: TeamConfig,
    options: SendOptions,
  ): Promise<{ chatId: string; colonyId: string; started: boolean; round?: number }> {
    const { delivery = 'steer', attachments = [], planFirst = false } = options
    const live = this._live.get(id)
    if (live && live.state().status === 'running') {
      await live.postUserMessage(message, delivery, attachments)
      return { chatId: id, colonyId: live.id, started: false }
    }
    const previous = await this.rounds(id)
    const history = conversation(previous)
    const classify = this.options.classify ?? llmClassifier(this.options.resolver, () => config.leadModel)
    // One retry, then one agent with every tool: it can do anything a single agent can without waking a team.
    const tier =
      options.tier ??
      (await classify(message, history)
        .catch(() => classify(message, history))
        .catch((err) => {
          console.warn(`triage failed, running solo: ${err instanceof Error ? err.message : String(err)}`)
          return 'solo' as const
        }))
    const spec = this.buildSpec(id, message, config, previous, history, tier)
    // A chat keeps the project it started in; only a new chat can pick one.
    // A chat keeps its folder, but permissions are re-read each round so a change applies from the next message.
    const latest = previous.at(-1)
    const earlier = latest?.state.chat?.project
    const project = earlier ? (this._project(earlier.id, false) ?? earlier) : this._project(options.project)
    if (project && spec.chat) spec.chat.project = project
    const memory = this.options.memory?.recall(project?.id) ?? []
    if (memory.length && spec.chat) spec.chat.memory = memoryLines(memory)
    if (planFirst && spec.tier !== 'answer') spec.planFirst = true
    const run: ColonyRun = new ColonyRun(this.runtime, spec, {
      resolver: this.options.resolver,
      ...(this.options.web ? { web: this.options.web } : {}),
      ...(this.options.unsafeNoSandbox ? { unsafeNoSandbox: true } : {}),
      ...(this.options.mcp ? { mcp: this.options.mcp } : {}),
      ...(this.options.library ? { library: this.options.library } : {}),
      ...(this.options.browser ? { browser: this.options.browser } : {}),
      ...(this.options.memory ? { memory: this.options.memory } : {}),
      // A chat's follow-ups continue its colony: same log, files, notes and agents' conversations.
      ...(latest ? { resumeId: latest.id as ColonyId } : {}),
      projectDiff: () => this._roundDiff(run, project),
    })
    // The opening message is logged before any agent works, so it reaches the lead once, via kickoff.
    run.beforeStart(async () => {
      await this._checkpoint(run.id, project, 'start', `before: ${message}`, spec.chat?.round)
      const escalated = latest?.round.escalated
      if (escalated)
        await run.append({
          type: 'note/appended',
          actor: { kind: 'system', id: 'myrmidon' },
          payload: {
            agent: 'myrmidon',
            text: `This request started in a smaller round; ${escalated.by} moved it here because: ${escalated.reason.replace(/[.\s]+$/, '')}. Its files and notes are here.`,
            section: 'decision',
          },
        })
      // A rerun after escalation repeats what the person said in the escalated round, attachments included.
      const said = escalated && latest ? messagesOf(latest).filter((m) => m.from === 'user') : []
      const names = [...(said[0]?.attachments ?? []), ...(await run.attach(attachments))]
      await run.append({
        type: 'chat/user',
        actor: { kind: 'user', id: 'user' },
        payload: { text: message, ...(names.length ? { attachments: names } : {}) },
      })
      for (const later of said.slice(1))
        await run.append({
          type: 'chat/user',
          actor: { kind: 'user', id: 'user' },
          payload: {
            text: later.text,
            ...(later.attachments?.length ? { attachments: later.attachments } : {}),
          },
        })
    })
    this._live.set(id, run)
    try {
      await (latest ? run.continueRound() : run.start())
    } catch (err) {
      this._live.delete(id)
      throw err
    }
    void run.done.finally(() => {
      if (this._live.get(id) === run) this._live.delete(id)
      void this._checkpoint(run.id, project, 'end', `after: ${message}`, spec.chat?.round)
    })
    void run.done.then((final) => {
      if (final.escalated)
        this._rerun(id, message, config, { ...options, attachments: [], tier: final.escalated.to })
    })
    return { chatId: id, colonyId: run.id, started: true, ...(spec.chat ? { round: spec.chat.round } : {}) }
  }

  /** Starts the round that takes over an escalated request, after anything already being sent to this chat. */
  private _rerun(id: string, message: string, config: TeamConfig, options: SendOptions) {
    const turn = (this._sending.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.deliver(id, message, config, options))
    this._sending.set(id, turn)
    turn
      .catch((err) => console.error(`rerunning an escalated request in ${id} failed:`, err))
      .finally(() => {
        if (this._sending.get(id) === turn) this._sending.delete(id)
      })
  }

  /**
   * Keeps or discards a memory an agent proposed. Recorded in the proposing round's log as well, so its card shows
   * the decision.
   */
  async decideMemory(id: string, keep: boolean): Promise<void> {
    const store = this.options.memory
    if (!store) throw new Error('memory is not available')
    const memory = store.get(id)
    if (!memory) throw new Error('no such memory')
    if (keep) store.update(id, { status: 'active' })
    else store.remove(id)
    const colony = memory.source.colonyId
    if (!colony || memory.status !== 'proposed') return
    const draft = {
      type: 'memory/decided',
      actor: { kind: 'user', id: 'user' },
      payload: { id, kept: keep },
    } as const
    const live = [...this._live.values()].find((r) => r.id === colony)
    if (live && live.state().status === 'running') await live.append(draft)
    else await this.runtime.ctx.log.appendOne(colony as never, draft)
  }

  /** Renames a conversation; recorded in its latest round's log, so the name survives restarts. */
  async rename(chatId: string, name: string): Promise<string> {
    const clean = name.replace(/\s+/g, ' ').trim()
    if (!clean) throw new Error('title is empty')
    if (clean.length > 120) throw new Error('title is longer than 120 characters')
    const latest = (await this.rounds(chatId)).at(-1)
    if (!latest) throw new Error('no such chat')
    const draft = {
      type: 'chat/renamed',
      actor: { kind: 'user', id: 'user' },
      payload: { title: clean },
    } as const
    const live = this._live.get(chatId)
    if (live?.id === latest.id) await live.append(draft)
    else await this.runtime.ctx.log.appendOne(latest.id as never, draft)
    return clean
  }

  private _project(
    id: string | undefined,
    required = true,
  ): { id: string; name: string; path: string; permissions?: ProjectPermissions } | undefined {
    if (!id) return undefined
    const project = this.options.projects?.get(id)
    if (!project) {
      if (required) throw new Error(`no such project: ${id}`)
      return undefined
    }
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      ...(project.permissions ? { permissions: project.permissions } : {}),
    }
  }

  /** Wakes an agent of a running round, if that round is live in this process. */
  wakeAgent(colonyId: string, agent: string, text: string): void {
    for (const run of this._live.values()) if (run.id === colonyId) run.nudge(agent, text)
  }

  /**
   * The person handed an agent's browser back. If the agent was waiting for a sign-in, that wait ends; otherwise
   * the agent is told its page may have changed.
   */
  async handBack(colonyId: string, agent: string): Promise<void> {
    const run = [...this._live.values()].find((r) => r.id === colonyId)
    if (!run) return
    if (await run.finishLogin(agent, 'handed-back')) return
    run.nudge(
      agent,
      'The person handed your browser back. They may have navigated or filled things in: take a fresh browser_snapshot and continue.',
    )
  }

  async stop(chatId: string): Promise<void> {
    await this._live.get(chatId)?.stop('stopped by user')
  }

  /** Snapshots a project round's folder; a failure is reported but never stops the round. */
  private async _checkpoint(
    colonyId: string,
    project: { id: string; path: string } | undefined,
    phase: 'start' | 'end',
    label: string,
    round?: number,
  ) {
    if (!project || !this.options.checkpoints) return
    try {
      const commit = await this.options.checkpoints.snapshot(project, label)
      await this.runtime.ctx.log.appendOne(colonyId as never, {
        type: 'checkpoint/created',
        actor: { kind: 'system', id: 'myrmidon' },
        payload: { commit, phase, ...(round !== undefined ? { round } : {}) },
      })
    } catch (err) {
      console.warn(
        `checkpoint (${phase}) of ${project.path} failed: ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  /** The person's answer to a tool call waiting for approval in a running round. */
  async decideApproval(colonyId: string, id: string, approved: boolean): Promise<void> {
    const run = [...this._live.values()].find((r) => r.id === colonyId)
    if (!run) throw new Error('that round is not running')
    await run.decideApproval(id, approved)
  }

  /** The round's changes to its project since its start checkpoint, for the judge. */
  private async _roundDiff(run: ColonyRun, project: { id: string; path: string } | undefined) {
    const start = run.state().checkpoints.start
    if (!project || !start || !this.options.checkpoints) return undefined
    return (await this.options.checkpoints.changes(project, start)).patch
  }

  /** A round of a chat colony (the latest without `round`) with its project and start snapshot. */
  private async _projectRound(colonyId: string, round?: number) {
    if (!this.options.checkpoints) throw new Error('checkpoints need the chat runtime')
    const state = foldColony(colonyId, await this.store.read(colonyId as never))
    const project = state.chat?.project
    if (!project) throw new Error('this round has no project folder')
    const info = round === undefined ? state.rounds.at(-1) : state.rounds.find((r) => r.round === round)
    const start = info?.checkpoints.start
    if (!info || !start) throw new Error('this round has no checkpoint')
    return { state, info, project, checkpoints: this.options.checkpoints, start }
  }

  /** What a round changed in its project: from its start to its end, or to now while it runs. */
  async changes(colonyId: string, round?: number) {
    const { info, project, checkpoints, start } = await this._projectRound(colonyId, round)
    return checkpoints.changes(project, start, info.checkpoints.end)
  }

  /**
   * Puts a round's project folder back as it was when the round started (`undo`: reverts the latest rewind).
   * Refused while the chat has a round running, since its agents would be editing the same files.
   */
  async rewind(colonyId: string, undo = false, round?: number): Promise<{ changed: number }> {
    const { state, project, checkpoints, start } = await this._projectRound(colonyId, round)
    const chatId = state.chat?.chatId ?? ''
    if (this._live.get(chatId)?.state().status === 'running')
      throw new Error('stop the running round before rewinding its files')
    const target = undo ? state.checkpoints.restored?.undo : start
    if (!target) throw new Error('there is no rewind to undo')
    const { undo: before, changed } = await checkpoints.restore(project, target)
    await this.runtime.ctx.log.appendOne(colonyId as never, {
      type: 'checkpoint/restored',
      actor: { kind: 'user', id: 'user' },
      payload: { commit: target, undo: before, changed },
    })
    return { changed }
  }

  /**
   * Switches agents of a running round to another model, from their next step on. Without `agent` it switches
   * the agent that speaks for the round (the lead, or the single agent), or every peer of a swarm team.
   */
  async switchModel(chatId: string, model: string, agent?: string): Promise<{ switched: string[] }> {
    const run = this._live.get(chatId)
    if (run?.state().status !== 'running') throw new Error('no round is running in this chat')
    const state = run.state()
    // Workers added mid-round are in the state, not the spec it started with.
    const live = Object.values(state.agents)
      .filter((a) => !a.dismissed && a.status !== 'failed')
      .map((a) => a.info)
    const names = agent
      ? [agent]
      : run.spec.team?.mode === 'swarm' && run.spec.tier === 'team'
        ? live.map((a) => a.name)
        : live.filter((a) => speaksForColony(run.spec, a as AgentSpec)).map((a) => a.name)
    await run.switchModels(Object.fromEntries(names.map((n) => [n, model])))
    return { switched: names }
  }

  /**
   * Picks a chat's latest round back up where it stopped (a stop, a server restart, a time limit) instead of
   * starting over. Its agents restart with a summary of everything recorded so far.
   */
  /**
   * `model` continues on another model: the agent whose model failed (and any other agent on that same model)
   * switches to it. Without a failure, it switches the lead (or the one agent).
   */
  async resume(chatId: string, model?: string): Promise<{ chatId: string; colonyId: string }> {
    if (this._live.get(chatId)?.state().status === 'running') throw new Error('this chat is already running')
    const last = (await this.rounds(chatId)).at(-1)
    if (!last) throw new Error('no such chat')
    if (last.round.status === 'completed')
      throw new Error('the latest round already completed; send a follow-up instead')
    if (last.round.escalated)
      throw new Error('this round handed its request to a bigger one; wait for it or send a follow-up')
    const spec = this.specFromLog(await this.store.read(last.id as never))
    const models: Record<string, string> = {}
    if (model) {
      this.options.resolver.resolve(model)
      const failed = last.state.modelError
      const target = failed
        ? failed.model
        : (spec.agents.find((a) => a.role === 'lead')?.model ?? spec.agents[0]?.model)
      for (const agent of spec.agents) {
        if (agent.model !== target && agent.name !== failed?.agent) continue
        agent.model = model
        models[agent.name] = model
      }
    }
    const run: ColonyRun = new ColonyRun(this.runtime, spec, {
      projectDiff: () => this._roundDiff(run, last.state.chat?.project),
      resolver: this.options.resolver,
      resumeId: last.id as ColonyId,
      ...(this.options.web ? { web: this.options.web } : {}),
      ...(this.options.unsafeNoSandbox ? { unsafeNoSandbox: true } : {}),
      ...(this.options.mcp ? { mcp: this.options.mcp } : {}),
      ...(this.options.library ? { library: this.options.library } : {}),
      ...(this.options.browser ? { browser: this.options.browser } : {}),
    })
    this._live.set(chatId, run)
    try {
      await run.resume(
        model
          ? `${last.state.statusReason ?? 'stopped'}; continuing on ${model}`
          : (last.state.statusReason ?? 'the server stopped'),
        models,
      )
    } catch (err) {
      this._live.delete(chatId)
      throw err
    }
    void run.done.finally(() => {
      if (this._live.get(chatId) === run) this._live.delete(chatId)
      void this._checkpoint(
        run.id,
        last.state.chat?.project,
        'end',
        `after resumed round ${last.round.round}`,
        last.round.round,
      )
    })
    return { chatId, colonyId: run.id }
  }

  /**
   * The spec the current round started with (colony/created, or round/started for a later round of the chat),
   * with the workers it added since.
   */
  private specFromLog(events: readonly MyrEvent[]): ColonySpec {
    const start = events.findLast((e) => e.type === 'colony/created' || e.type === 'round/started')
    if (!start) throw new Error('the colony has no colony/created event')
    const created = start.payload as EventPayloads['colony/created']
    const joined = events
      .filter((e) => e.type === 'agent/joined' && e.seq > start.seq)
      .map((e) => (e.payload as EventPayloads['agent/joined']).agent)
    const notes = this.options.settings?.get().instructions
    const agents = [...created.agents, ...joined].map((info) => {
      const note = (info.role === 'lead' ? notes?.lead : notes?.worker)?.trim()
      return {
        name: info.name,
        role: info.role,
        model: info.model,
        ...(info.specialty ? { specialty: info.specialty } : {}),
        ...(note ? { instructions: note } : {}),
      }
    })
    return {
      name: created.name,
      mission: created.mission,
      pattern: created.pattern as ColonySpec['pattern'],
      agents,
      acceptance: created.acceptance as AcceptanceCheck[],
      budget: { maxTurns: 40, ...created.budget },
      observer: { intervalMs: created.observerMs ?? 45_000 },
      ...(created.thinking ? { thinking: created.thinking } : {}),
      ...(created.taskJudge ? { taskJudge: created.taskJudge } : {}),
      ...(created.chat ? { chat: { ...created.chat, history: created.chat.history ?? '' } } : {}),
      ...(created.team
        ? {
            team: {
              mode: created.team.mode === 'swarm' ? 'swarm' : 'orchestrated',
              maxWorkers: created.team.maxWorkers,
              workerModels: created.team.workerModels,
            },
          }
        : {}),
      ...(created.disabledTools?.length ? { disabledTools: created.disabledTools } : {}),
      ...(created.tier ? { tier: created.tier } : {}),
    }
  }

  /** Permanently deletes every round of a chat, stopping a running round first. Returns the deleted colony ids. */
  async delete(chatId: string): Promise<string[]> {
    const live = this._live.get(chatId)
    if (live) {
      await live.stop('chat deleted')
      await live.done
      this._live.delete(chatId)
    }
    const ids = [...new Set((await this.rounds(chatId)).map((r) => r.id))]
    for (const id of ids) {
      this.store.deleteColony(id as never)
      this.index.forget(id)
    }
    return ids
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this._live.values()].map((r) => r.stop('server shutting down')))
  }

  private buildSpec(
    chatId: string,
    request: string,
    config: TeamConfig,
    previous: readonly RoundRef[],
    history: string,
    requested: Tier,
  ): ColonySpec {
    const s = this.options.settings?.get()
    const leadNote = s?.instructions.lead?.trim()
    const workerNote = s?.instructions.worker?.trim()
    const roster = config.roster.slice(0, MAX_WORKERS)
    const extra = config.mode === 'orchestrated' ? Math.max(0, config.extraWorkers ?? 0) : 0
    // A team with nobody to delegate to is one agent working alone. A swarm the person set up works together
    // on anything bigger than a direct answer.
    const tier: Tier =
      requested === 'team' && config.mode === 'orchestrated' && roster.length === 0 && extra === 0
        ? 'solo'
        : requested === 'solo' && config.mode === 'swarm' && roster.length > 1
          ? 'team'
          : requested
    const taken = new Set(['lead'])
    // A chat keeps its team: the workers (or peers) of its latest team round come back, minus any the lead
    // dismissed, with their memory. The team picker shapes only a chat's first team.
    const kept = keptTeam(previous, config.mode).map((info): AgentSpec => {
      taken.add(info.name)
      const note = info.focus ? `Your focus: ${info.focus}` : workerNote
      return {
        name: info.name,
        role: info.role,
        model: info.model,
        ...(info.specialty ? { specialty: info.specialty } : {}),
        ...(info.focus ? { focus: info.focus } : {}),
        ...(note ? { instructions: note } : {}),
      }
    })
    const crew = (role: 'worker' | 'peer'): AgentSpec[] =>
      kept.length > 0
        ? kept
        : roster.map((r) => {
            const name = pickName(taken)
            taken.add(name)
            return {
              name,
              role,
              model: r.model,
              ...(r.role && r.role !== 'peer' && r.role !== 'worker' ? { specialty: r.role } : {}),
              ...(workerNote ? { instructions: workerNote } : {}),
            }
          })
    const lead: AgentSpec = {
      name: 'lead',
      role: 'lead',
      model: config.leadModel,
      ...(leadNote ? { instructions: leadNote } : {}),
    }
    const swarm = tier === 'team' && config.mode === 'swarm'
    // An answer or solo round may hand its request up: to one agent with every tool, or to a team if one exists.
    const teamSize =
      config.mode === 'swarm' ? kept.length || roster.length || 2 : 1 + (kept.length || roster.length) + extra
    const escalate: ('solo' | 'team')[] = [
      ...(tier === 'answer' ? (['solo'] as const) : []),
      ...(tier !== 'team' && teamSize > 1 ? (['team'] as const) : []),
    ]
    // A swarm has no lead, even when triage gives the request to one agent: that agent is a peer.
    const alone: AgentSpec =
      config.mode === 'swarm'
        ? (kept[0] ?? {
            name: pickName(taken),
            role: 'peer',
            model: roster[0]?.model ?? config.leadModel,
            ...(workerNote ? { instructions: workerNote } : {}),
          })
        : lead
    const agents: AgentSpec[] =
      tier !== 'team'
        ? [alone]
        : swarm
          ? roster.length > 0 || kept.length > 0
            ? crew('peer')
            : [0, 1].map(() => {
                const name = pickName(taken)
                taken.add(name)
                return { name, role: 'peer', model: config.leadModel }
              })
          : [lead, ...crew('worker')]
    const disabledTools = s
      ? (Object.keys(TOOL_GROUPS) as ToolGroup[])
          .filter((g) => !s.tools[g])
          .flatMap((g) => [...TOOL_GROUPS[g]])
      : []
    const wallMs = Math.round((config.wallMinutes ?? s?.team.wallMinutes ?? 30) * 60_000)
    const limits = {
      ...(s?.team.costUsd ? { costUsd: s.team.costUsd } : {}),
      ...(s?.team.tokens ? { tokens: s.team.tokens } : {}),
    }
    const models = [...new Set([...roster.map((r) => r.model), config.leadModel])]
    return {
      name: title(request),
      mission: history
        ? `${request}\n\n(Context from earlier rounds of this conversation)\n${history}`
        : request,
      pattern: swarm ? 'blackboard' : 'lead-workers',
      agents,
      acceptance:
        tier === 'answer'
          ? []
          : [
              {
                verifier: 'llm-judge',
                model: config.judgeModel,
                rubric: s?.verification.rubric?.trim() || RUBRIC,
                threshold: s?.verification.threshold ?? 0.7,
              },
            ],
      budget:
        tier === 'answer'
          ? { wallMs: Math.min(wallMs, 4 * 60_000), maxTurns: 4, ...limits }
          : { wallMs, maxTurns: s?.team.maxTurns ?? 40, ...limits },
      observer: { intervalMs: (s?.observer.intervalSeconds ?? 45) * 1000 },
      ...(disabledTools.length ? { disabledTools } : {}),
      chat: {
        chatId,
        round: previous.length + 1,
        request,
        history,
        ...(escalate.length ? { escalate } : {}),
      },
      tier,
      ...(config.thinking ? { thinking: config.thinking } : {}),
      team: {
        mode: config.mode,
        maxWorkers: tier === 'team' && !swarm ? (kept.length || roster.length) + extra : 0,
        workerModels: models,
      },
    }
  }
}
