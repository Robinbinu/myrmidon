import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SqliteLogStore } from '@myrmidon/core'
import {
  type AgentInfo,
  type ChatGrant,
  type ColonyId,
  type ColonyState,
  type ColonyStatus,
  type ComputerApp,
  type EventPayloads,
  foldColony,
  type MyrEvent,
  mentionsIn,
  type ProjectPermissions,
  type RoundInfo,
  STOPPED_BY_USER,
} from '@myrmidon/protocol'
import type { BrowserHub } from './browser.ts'
import { namingModel } from './catalog.ts'
import { ChatIndex, type CrewMember, type IndexedRound, type MessageHit } from './chat-index.ts'
import { nameChat } from './chat-titles.ts'
import type { Checkpoints } from './checkpoints.ts'
import { type Attachment, ColonyRun, type Runtime } from './colony.ts'
import type { ComputerHub } from './computer/driver.ts'
import { CHAT_TITLE_ROUNDS, MAX_READ_FOLDERS, MAX_WORKERS, SKILL_REVIEW_CALLS } from './config.ts'
import type { HookStore } from './hooks.ts'
import type { ToolLibrary } from './made-tools.ts'
import type { McpHub } from './mcp.ts'
import { type MemoryStore, memoryLines } from './memory.ts'
import type { ModelResolver } from './models.ts'
import { pickName } from './names.ts'
import { speaksForColony } from './patterns.ts'
import type { PluginHost } from './plugin-host.ts'
import type { ProjectStore } from './projects.ts'
import { prompts } from './prompts.ts'
import { readFolder, realPath, secretAt, within } from './read-access.ts'
import { type MyrSettings, type SettingsStore, TOOL_GROUPS, type ToolGroup } from './settings.ts'
import {
  reviewRound,
  roundDigest,
  type SkillProposal,
  type SkillProposalStore,
  toolCallsSince,
} from './skill-learning.ts'
import type { SkillLibrary } from './skills.ts'
import type { AcceptanceCheck, AgentSpec, ColonySpec, Tier } from './spec.ts'
import { type SpecialistStore, specialistAgent } from './specialists.ts'
import type { WebTools } from './web.ts'

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

/**
 * The crew members a message is written to (@name), among those still on the crew; @lead is just a message to the
 * lead, which the lead hears anyway.
 */
function addressedIn(message: string, state: ColonyState): string[] {
  const crew = Object.values(state.agents)
    .filter((a) => !a.dismissed && a.status !== 'failed' && a.info.role !== 'lead')
    .map((a) => a.info.name)
  return mentionsIn(message, crew)
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
  /** One of the person's saved specialists, by name: it joins as they set it up. */
  readonly specialist?: string
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
  /**
   * With helpers set up: `always` starts every round as the team; otherwise (auto) the lead starts alone and brings
   * them in only when the work needs it. A roster with nobody in it means no helpers at all.
   */
  readonly helpers?: 'auto' | 'always'
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
  /** Fixes the size: an escalated round reruns its request at the tier its agent asked for. */
  readonly tier?: Tier
  /** Said aloud on a voice call: the answer will be read aloud, so it should be short and plain. */
  readonly voice?: boolean
  /** What the agents should know that the chat does not show, e.g. a voice call's transcript. */
  readonly context?: string
  /**
   * Someone other than the person wrote it (a channel member): the round asks before every call that changes
   * something outside it, whatever the person allowed (`ColonySpec.askAll`).
   */
  readonly askAll?: boolean
}

/** The person's tool settings as a round's rules: switched-off groups and tools, and per-tool ask and allow. */
export function toolRules(s: MyrSettings | undefined): {
  disabledTools: string[]
  askTools: string[]
  allowTools: string[]
} {
  const rules = Object.entries(s?.permissions ?? {})
  return {
    disabledTools: [
      ...(s
        ? (Object.keys(TOOL_GROUPS) as ToolGroup[])
            .filter((g) => !s.tools[g])
            .flatMap((g) => [...TOOL_GROUPS[g]])
        : []),
      ...rules.filter(([, rule]) => rule === 'off').map(([tool]) => tool),
    ],
    askTools: rules.filter(([, rule]) => rule === 'ask').map(([tool]) => tool),
    allowTools: rules.filter(([, rule]) => rule === 'allow').map(([tool]) => tool),
  }
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
    ...(raw.helpers === 'always' ? { helpers: 'always' as const } : {}),
  }
  if (raw.mode === 'orchestrated' || raw.mode === 'swarm') {
    const roster = (Array.isArray(raw.roster) ? raw.roster : [])
      .filter(
        (r): r is RosterEntry => typeof r?.role === 'string' && typeof r?.model === 'string' && !!r.model,
      )
      .slice(0, MAX_WORKERS)
      .map((r) => ({
        role: r.role.trim().slice(0, 40) || 'worker',
        model: r.model,
        ...(typeof r.specialist === 'string' && r.specialist ? { specialist: r.specialist } : {}),
      }))
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

/** Sizes a round before it starts; by default the lead does this itself, so new rounds start solo. */
export type Classify = (request: string, history: string) => Promise<Tier>

/** Every new round starts with one lead that has every tool and escalates big work itself. */
const leadFirst: Classify = async () => 'solo'

export interface ChatRound {
  readonly colonyId: string
  readonly round: number
  readonly status: ColonyStatus
  readonly request: string
  /** Swarm rounds have no lead to address. */
  readonly swarm: boolean
  /** When the round began, so the chat can place other things (voice calls) among rounds by time. */
  readonly startedAt?: string
}

export interface ChatSummary {
  readonly chatId: string
  readonly title: string
  readonly updatedAt: string
  readonly status: ColonyStatus
  /** The latest round stopped to wait for the person's answer. */
  readonly awaiting?: boolean
  /** The latest round stopped because a model failed. */
  readonly failed?: boolean
  readonly rounds: ChatRound[]
  /** The project folder the chat works in, if any. */
  readonly project?: { readonly id: string; readonly name: string }
  /** Crew members the person can write to directly (@name): everyone on the chat's crew but the lead. */
  readonly crew?: readonly CrewMember[]
  /** Kinds of step the person allowed for the rest of the chat ("Approve all for this chat"). */
  readonly grants?: readonly ChatGrant[]
  /** Folders the person let sandboxed agents read for the rest of the chat ("Allow reading … in this chat"). */
  readonly reads?: readonly string[]
  /** The latest round runs (or ran) with full access: no sandbox. */
  readonly fullAccess?: boolean
  /** Apps on the person's Mac they let agents use in this chat (computer use). */
  readonly computerApps?: readonly ComputerApp[]
}

/** The earlier rounds of a chat as `User:` / `Colony:` pairs, for agents that were not in them. */
function conversation(previous: readonly RoundRef[]): string {
  return (
    previous
      // An escalated round's request was rerun by the next round; listing it would repeat it.
      .filter((r) => !r.round.escalated)
      .map((r) => {
        const replies = messagesOf(r).filter((m) => m.from !== 'user')
        const final = replies.filter((m) => m.final).at(-1) ?? replies.at(-1)
        const plan = final?.plan ? `\n\n${final.plan}` : ''
        return `User: ${r.round.request}\nColony (${r.round.status}): ${final?.text ?? '(no reply)'}${plan}`
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

/** A chat has a name once any of its rounds was renamed: older chats ran each round in a colony of its own. */
const named = (rounds: readonly RoundRef[]) => rounds.some((r) => r.state.chatTitle)

/** Conversations as sequences of colony rounds. Follow-ups after a round ends start a new round on its files. */
export class ChatService {
  private readonly _live = new Map<string, ColonyRun>()
  private readonly _sending = new Map<string, Promise<unknown>>()
  /** Chats being deleted: a name arriving meanwhile must not write to (and so recreate) their logs. */
  private readonly _deleting = new Set<string>()
  /** A chat's name on its way into the log, which deleting the chat waits for. */
  private readonly _naming = new Map<string, Promise<unknown>>()
  /** What each round does once it ends (its owner file, its end checkpoint); shutting down waits for it. */
  private readonly _wrapUps = new Set<Promise<unknown>>()

  constructor(
    private readonly runtime: Runtime,
    private readonly options: {
      resolver: ModelResolver
      unsafeNoSandbox?: boolean
      settings?: SettingsStore
      web?: WebTools
      /** Fixes a new round's size; by default every round starts with the lead alone (see `leadFirst`). */
      classify?: Classify
      /** MCP servers whose tools colonies may use. */
      mcp?: McpHub
      /** The person's plugins with code, whose tools and prompt sections reach agents. */
      plugins?: PluginHost
      /** Snapshots of project folders, for each round's changes and rewinding. */
      checkpoints?: Checkpoints
      /** The person's kept tools (made by agents), loaded into every round. */
      library?: ToolLibrary
      /** Shared headless Chrome for the browser_* tools. */
      browser?: BrowserHub
      /** Computer use: agents drive the person's Mac through Cua Driver when Settings → Computer use is on. */
      computer?: ComputerHub
      /** What the person keeps across chats: recalled into every round, added to by agents' proposals. */
      memory?: MemoryStore
      /** Skills agents load by name when a task matches. */
      skills?: SkillLibrary
      /** The person's hooks around tools and round ends. */
      hooks?: HookStore
      /** Project folders chats can work in. */
      projects?: ProjectStore
      /** Agents the person defined once and brings back. */
      specialists?: SpecialistStore
      /** Skills a reviewer proposed from finished work, waiting for the person or decided. */
      skillProposals?: SkillProposalStore
      /** How long a round's crew sits quiet before it is nudged, or a wound-down round closes (see RunOptions). */
      quietMs?: number
    },
  ) {}

  /**
   * Reads a colony's latest round for a skill worth keeping and proposes it. Unless the person asked (/learn), only a
   * round that took real work is read. Returns the proposal, or undefined when there is nothing worth keeping.
   */
  private async _reviewForSkill(
    colonyId: string,
    model: string,
    asked: boolean,
  ): Promise<SkillProposal | undefined> {
    const { skills, skillProposals } = this.options
    if (!skills || !skillProposals) throw new Error('learning skills needs the skill library')
    const events = await this.store.read(colonyId as never)
    const state = foldColony(colonyId, events)
    const from = state.rounds.at(-1)?.startSeq ?? 0
    if (!asked && toolCallsSince(events, from) < SKILL_REVIEW_CALLS) return undefined
    const review = await reviewRound({
      resolver: this.options.resolver,
      model,
      skills,
      digest: roundDigest(events, from),
      asked,
    })
    if (!review) return undefined
    const proposal = skillProposals.add({
      ...review,
      colonyId,
      ...(state.chat ? { chatId: state.chat.chatId } : {}),
    })
    await this._appendTo(colonyId, {
      type: 'skill/proposed',
      actor: { kind: 'system', id: 'myrmidon' },
      payload: {
        id: proposal.id,
        name: proposal.name,
        description: proposal.description,
        body: proposal.body,
        why: proposal.why,
        ...(proposal.update ? { update: proposal.update } : {}),
      },
    })
    return proposal
  }

  /** Logs to a colony whether or not one of its rounds is running. */
  private async _appendTo(colonyId: string, draft: Parameters<ColonyRun['append']>[0]) {
    const live = [...this._live.values()].find((r) => r.id === colonyId)
    if (live && live.state().status === 'running') await live.append(draft)
    else await this.runtime.ctx.log.appendOne(colonyId as never, draft)
  }

  /** The person asked to learn a skill from a chat (/learn): its latest round is read now, whatever its size. */
  async learnNow(chatId: string): Promise<SkillProposal | undefined> {
    const latest = (await this.rounds(chatId)).at(-1)
    if (!latest) throw new Error('no such chat')
    const agents = Object.values(latest.state.agents)
    const model = (agents.find((a) => a.info.role === 'lead') ?? agents[0])?.info.model
    if (!model) throw new Error('this chat has no agents to learn from')
    return this._reviewForSkill(latest.id, model, true)
  }

  /** Keeps (in Myrmidon's skills, for every chat) or discards a proposed skill, with any edits the person made. */
  async decideSkill(
    id: string,
    keep: boolean,
    edits: { description?: string; body?: string } = {},
  ): Promise<void> {
    const { skills, skillProposals } = this.options
    if (!skills || !skillProposals) throw new Error('learning skills needs the skill library')
    const proposal = skillProposals.get(id)
    if (!proposal) throw new Error('no such skill proposal')
    if (proposal.status !== 'proposed') throw new Error(`this proposal was already ${proposal.status}`)
    if (keep)
      skills.write(
        proposal.name,
        edits.description?.trim() || proposal.description,
        edits.body?.trim() || proposal.body,
      )
    skillProposals.setStatus(id, keep ? 'kept' : 'discarded')
    await this._appendTo(proposal.colonyId, {
      type: 'skill/decided',
      actor: { kind: 'user', id: 'user' },
      payload: { id, kept: keep },
    })
  }

  /**
   * A crew member who is one of the person's specialists works as they set it up now: its specialty, instructions and
   * tools (its model and its memory of the chat stay as they are).
   */
  private _asSpecialist(agent: AgentSpec): AgentSpec {
    const saved = agent.role === 'lead' ? undefined : this.options.specialists?.byName(agent.name)
    if (!saved) return agent
    const as = specialistAgent(saved, agent.role === 'peer' ? 'peer' : 'worker', agent.model)
    return {
      ...agent,
      ...(as.specialty ? { specialty: as.specialty } : {}),
      ...(as.instructions ? { instructions: as.instructions } : {}),
      ...(as.withoutTools ? { withoutTools: as.withoutTools } : {}),
    }
  }

  /** The person's specialists a lead may still bring in: those not already on the team. */
  private _bringable(agents: readonly AgentSpec[], workerModel: string): AgentSpec[] {
    const here = new Set(agents.map((a) => a.name))
    return (this.options.specialists?.list() ?? [])
      .filter((s) => !here.has(s.name))
      .map((s) => specialistAgent(s, 'worker', workerModel))
  }

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

  /**
   * A running round notes which process runs it, so that after a restart or crash a round the log still calls running
   * can be told apart from one another Myrmidon process (a second server on the same home) is running right now.
   */
  private _ownerFile(colonyId: string) {
    return join(this.store.home, 'runs', colonyId)
  }

  private _own(run: ColonyRun) {
    mkdirSync(join(this.store.home, 'runs'), { recursive: true })
    writeFileSync(this._ownerFile(run.id), String(process.pid))
  }

  private _release(run: ColonyRun) {
    rmSync(this._ownerFile(run.id), { force: true })
  }

  private _settling?: Promise<void>

  /**
   * Ends rounds left running by a Myrmidon that is gone (restarted, quit or crashed): logged as stopped, they offer
   * Resume, and the chat takes new messages again. Runs once, before this process first reads or starts a round.
   */
  private _settle(): Promise<void> {
    this._settling ??= (async () => {
      for (const r of await this.index.rounds(this._liveState)) {
        if (r.status !== 'running' && r.status !== 'created') continue
        if (this._liveState(r.colonyId)) continue
        const file = this._ownerFile(r.colonyId)
        const pid = existsSync(file) ? Number(readFileSync(file, 'utf8')) : undefined
        if (pid && pid !== process.pid && alive(pid)) continue
        // What it was still asking the person can no longer be answered: closed as stopped, as a stop closes them.
        const past = await this.runtime.ctx.log.read(r.colonyId as never)
        const decided = new Set(
          past.filter((e) => e.type === 'approval/decided').map((e) => (e.payload as { id: string }).id),
        )
        for (const e of past)
          if (e.type === 'approval/requested' && !decided.has((e.payload as { id: string }).id))
            await this.runtime.ctx.log.appendOne(r.colonyId as never, {
              type: 'approval/decided',
              actor: { kind: 'system', id: 'myrmidon' },
              payload: { id: (e.payload as { id: string }).id, approved: false, by: 'stopped' },
            })
        await this.runtime.ctx.log.appendOne(r.colonyId as never, {
          type: 'colony/stopped',
          actor: { kind: 'system', id: 'myrmidon' },
          payload: { reason: prompts.chat.interrupted },
        })
        rmSync(file, { force: true })
      }
    })()
    return this._settling
  }

  async list(): Promise<ChatSummary[]> {
    await this._settle()
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
        ...(last.crew?.some((c) => c.role !== 'lead')
          ? { crew: last.crew.filter((c) => c.role !== 'lead') }
          : {}),
        ...(last.awaiting ? { awaiting: true } : {}),
        ...(last.failed ? { failed: true } : {}),
        ...(last.grants?.length ? { grants: last.grants } : {}),
        ...(last.reads?.length ? { reads: last.reads } : {}),
        ...(last.fullAccess ? { fullAccess: true } : {}),
        ...(last.computerApps?.length ? { computerApps: last.computerApps } : {}),
        rounds: list.map((r) => ({
          colonyId: r.colonyId,
          round: r.round,
          status: r.status,
          request: r.request,
          swarm: r.swarm,
          ...(r.createdAt ? { startedAt: r.createdAt } : {}),
        })),
      })
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** Chats with a message (the person's or a reply) containing `text`, each with the words around the match. */
  async search(text: string): Promise<MessageHit[]> {
    await this._settle()
    return this.index.search(
      text,
      [...this._live.values()].map((r) => r.state()),
    )
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
    // Files alone (a photo sent without a caption) are a message too: it says what was sent.
    const names = (options.attachments ?? []).map((a) => a.name)
    const message = text.trim() || (names.length ? prompts.chat.filesOnly(names) : '')
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
    const { delivery = 'steer', attachments = [], planFirst = false, voice = false, context } = options
    const extra = { ...(voice ? { voice: true } : {}), ...(context ? { context } : {}) }
    await this._settle()
    const live = this._live.get(id)
    if (live && live.state().status === 'running') {
      // Their message steers a round someone else started: from now on it asks too, as if they had started it.
      if (options.askAll) await live.askForAll()
      await live.postUserMessage(message, delivery, attachments, addressedIn(message, live.state()), extra)
      return { chatId: id, colonyId: live.id, started: false }
    }
    const previous = await this.rounds(id)
    const history = conversation(previous)
    // Written to crew members directly (@name): the round starts with them, and they answer.
    const latestState = previous.at(-1)?.state
    const to = latestState ? addressedIn(message, latestState) : []
    // The lead starts at once and sizes the work itself (escalate); tests and reruns may fix the size instead.
    const tier = to.length
      ? 'team'
      : (options.tier ??
        (config.helpers === 'always' ? 'team' : await (this.options.classify ?? leadFirst)(message, history)))
    const spec = this.buildSpec(id, message, config, previous, history, tier, to)
    if (spec.chat) Object.assign(spec.chat, extra)
    if (options.askAll) spec.askAll = true
    // A chat keeps the project it started in; only a new chat can pick one.
    // A chat keeps its folder, but permissions are re-read each round so a change applies from the next message.
    const latest = previous.at(-1)
    const earlier = latest?.state.chat?.project
    const project = earlier ? (this._project(earlier.id, false) ?? earlier) : this._project(options.project)
    if (project && spec.chat) spec.chat.project = project
    if (this._fullAccess(project, spec.askAll)) spec.fullAccess = true
    const reads = this._reads(project, spec.askAll)
    if (reads.length) spec.reads = reads
    if (this._computerUse(spec.askAll)) spec.computerUse = true
    const memory = this.options.memory?.recall(project?.id) ?? []
    if (memory.length && spec.chat) spec.chat.memory = memoryLines(memory)
    if (planFirst && spec.tier !== 'answer') spec.planFirst = true
    const run: ColonyRun = new ColonyRun(this.runtime, spec, {
      resolver: this.options.resolver,
      ...(this.options.quietMs !== undefined ? { quietMs: this.options.quietMs } : {}),
      ...(this.options.web ? { web: this.options.web } : {}),
      ...(this.options.unsafeNoSandbox ? { unsafeNoSandbox: true } : {}),
      ...(this.options.mcp ? { mcp: this.options.mcp } : {}),
      ...(this.options.plugins ? { plugins: this.options.plugins } : {}),
      onStream: (agent: string, text: string, done: boolean, plain: boolean) =>
        this._streamed(run.id, agent, text, done, plain),
      ...(this.options.library ? { library: this.options.library } : {}),
      ...(this.options.browser ? { browser: this.options.browser } : {}),
      ...(this.options.computer ? { computer: this.options.computer } : {}),
      ...(this.options.skills ? { skills: this.options.skills } : {}),
      ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
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
            text: prompts.chat.escalated(escalated.by, escalated.reason.replace(/[.\s]+$/, '')),
            section: 'decision',
          },
        })
      // A rerun after escalation repeats what the person said in the escalated round, attachments included.
      const said = escalated && latest ? messagesOf(latest).filter((m) => m.from === 'user') : []
      const names = [...(said[0]?.attachments ?? []), ...(await run.attach(attachments))]
      await run.append({
        type: 'chat/user',
        actor: { kind: 'user', id: 'user' },
        payload: {
          text: message,
          ...(names.length ? { attachments: names } : {}),
          ...(to.length ? { to } : {}),
          ...extra,
        },
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
    this._own(run)
    try {
      await (latest ? run.continueRound() : run.start())
    } catch (err) {
      this._live.delete(id)
      this._release(run)
      throw err
    }
    this._wrapUp(
      run.done.finally(() => {
        this._release(run)
        this.index.noteMessages(run.id, run.state())
        if (this._live.get(id) === run) this._live.delete(id)
        return this._checkpoint(run.id, project, 'end', `after: ${message}`, spec.chat?.round)
      }),
    )
    void run.done.then((final) => {
      if (final.escalated)
        this._rerun(id, message, config, {
          ...options,
          // The rerun repeats every message of this round, a member's among them.
          ...(run.spec.askAll ? { askAll: true } : {}),
          attachments: [],
          tier: final.escalated.to,
        })
      if (final.status === 'completed')
        this._nameChat(id, config.leadModel).catch((err) =>
          console.error(`naming ${id} failed: ${err instanceof Error ? err.message : err}`),
        )
      // A finished round that took real work is read for a skill worth keeping, after the fact.
      if (final.status === 'completed' && this.options.skillProposals && this.options.skills)
        this._reviewForSkill(run.id, config.leadModel, false).catch((err) =>
          console.error(`skill review of ${run.id} failed: ${err instanceof Error ? err.message : err}`),
        )
    })
    return { chatId: id, colonyId: run.id, started: true, ...(spec.chat ? { round: spec.chat.round } : {}) }
  }

  /**
   * Names a chat from what it is about, after a round: not one anyone named (the person, a channel, a schedule), and
   * not once it has a name. "hi" has nothing to name, so the next rounds try again, up to CHAT_TITLE_ROUNDS.
   */
  private async _nameChat(chatId: string, model: string) {
    // Without a settings store (tests, bare runtimes) chats keep their first message as their name.
    if (this.options.settings?.get().profile.titles !== 'model') return
    const rounds = await this.rounds(chatId)
    const latest = rounds.at(-1)
    if (!latest || rounds.length > CHAT_TITLE_ROUNDS || named(rounds)) return
    const answer = messagesOf(latest)
      .filter((m) => m.from !== 'user' && m.final)
      .at(-1)?.text
    const input = { asked: rounds.map((r) => r.round.request), ...(answer ? { answer } : {}) }
    const cheap = this._titleModel(model)
    // The cheap model may turn out unusable (a lapsed key, a model gone); the lead's model just worked.
    const title =
      cheap === model
        ? await nameChat(this.options.resolver, model, input)
        : await nameChat(this.options.resolver, cheap, input).catch((err) => {
            console.warn(
              `naming ${chatId} on ${cheap} failed, using ${model}: ${err instanceof Error ? err.message : err}`,
            )
            return nameChat(this.options.resolver, model, input)
          })
    if (!title) return
    // Renamed meanwhile (by the person, say): theirs stands. Deleted meanwhile: it stays deleted.
    const again = await this.rounds(chatId)
    if (!again.length || named(again) || this._deleting.has(chatId)) return
    const draft = {
      type: 'chat/renamed',
      actor: { kind: 'system', id: 'myrmidon' },
      payload: { title, by: 'auto' },
    } as const
    const live = this._live.get(chatId)
    const write =
      live?.id === latest.id ? live.append(draft) : this.runtime.ctx.log.appendOne(latest.id as never, draft)
    this._naming.set(chatId, write)
    try {
      await write
    } finally {
      if (this._naming.get(chatId) === write) this._naming.delete(chatId)
    }
  }

  /** The cheapest fast model the person can use and has not hidden, for naming chats; the lead's otherwise. */
  private _titleModel(lead: string): string {
    const omp = this.options.resolver.omp
    return omp ? namingModel(omp, this.options.settings, lead) : lead
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

  /**
   * Allows one kind of step (project file changes, or shell commands) for the rest of a chat, across its runs, or
   * takes that back. Allowing also approves the steps of that kind already waiting. Recorded in the chat's latest
   * round's log, so it survives restarts and holds for runs started from a channel. Returns what is allowed now.
   */
  async allowInChat(chatId: string, grant: ChatGrant, allowed: boolean): Promise<ChatGrant[]> {
    if (grant !== 'file' && grant !== 'command') throw new Error('grant is file or command')
    const latest = (await this.rounds(chatId)).at(-1)
    if (!latest) throw new Error('no such chat')
    const live = this._live.get(chatId)
    const here = live?.id === latest.id ? live : undefined
    const now = (here?.state() ?? latest.state).chatGrants ?? []
    const grants = allowed ? [...new Set([...now, grant])] : now.filter((g) => g !== grant)
    if (grants.length !== now.length) {
      const draft = {
        type: 'chat/allowed',
        actor: { kind: 'user', id: 'user' },
        payload: { grants },
      } as const
      if (here) await here.append(draft)
      else await this.runtime.ctx.log.appendOne(latest.id as never, draft)
    }
    if (allowed && here)
      for (const a of Object.values(here.state().approvals))
        if (!a.decided && a.grant === grant)
          // Decided meanwhile (the person on another device, a timeout): nothing left to approve.
          await here.decideApproval(a.id, true).catch(() => {})
    return grants
  }

  /**
   * Lets sandboxed agents read a folder for the rest of a chat, across its runs, or takes that back; allowing also
   * approves the requests to read it already waiting. Kept like `allowInChat`. The person's keys and other chats'
   * data cannot be allowed here (only by naming them in Settings → Tools). Returns the folders allowed now.
   */
  async allowReadInChat(chatId: string, folder: string, allowed: boolean): Promise<string[]> {
    const latest = (await this.rounds(chatId)).at(-1)
    if (!latest) throw new Error('no such chat')
    const path = realPath(readFolder(folder))
    const colonyDir = (this.runtime.ctx.logStore as SqliteLogStore).colonyDir(latest.id as never)
    if (allowed && secretAt(path, { dataDir: this.runtime.home, colonyDir }))
      throw new Error(
        `${folder} holds keys, sign-ins or other chats: only naming it in Settings → Tools opens it`,
      )
    const live = this._live.get(chatId)
    const here = live?.id === latest.id ? live : undefined
    const state = here?.state() ?? latest.state
    const now = state.chatReads ?? []
    const reads = allowed ? [...new Set([...now, path])] : now.filter((f) => f !== path)
    if (reads.length > MAX_READ_FOLDERS) throw new Error(`at most ${MAX_READ_FOLDERS} folders in one chat`)
    if (reads.length !== now.length) {
      const draft = {
        type: 'chat/allowed',
        actor: { kind: 'user', id: 'user' },
        payload: { grants: state.chatGrants ?? [], reads },
      } as const
      if (here) await here.append(draft)
      else await this.runtime.ctx.log.appendOne(latest.id as never, draft)
    }
    if (allowed && here)
      for (const a of Object.values(here.state().approvals))
        if (!a.decided && a.read && within(a.read, path))
          await here.decideApproval(a.id, true).catch(() => {})
    return reads
  }

  /**
   * The folders a round's sandboxed agents may read beyond the defaults: from Settings (everything in the home, and
   * the folders listed there, keys included when named exactly) and the project's own, which can never name keys or
   * other chats. None for a round someone else started (`askAll`).
   */
  private _reads(
    project: { permissions?: ProjectPermissions } | undefined,
    askAll: boolean | undefined,
  ): string[] {
    if (askAll) return []
    const sandbox = this.options.settings?.get().sandbox
    const folders = (list: readonly string[]) =>
      list.flatMap((f) => {
        try {
          return [readFolder(f)]
        } catch {
          // Saved before it was checked, or hand-edited: a folder that is not a full path opens nothing.
          return []
        }
      })
    const global = folders([...(sandbox?.readHome ? ['~'] : []), ...(sandbox?.read ?? [])])
    const own = folders(project?.permissions?.read ?? []).filter(
      (f) => !secretAt(f, { dataDir: this.runtime.home }),
    )
    return [...new Set([...global, ...own])]
  }

  /**
   * Takes back apps the person let agents use on their Mac in a chat (Settings → Computer use): the chat keeps only
   * `keep`. Recorded in the chat's latest round, so the next round asks again for the rest.
   */
  async setComputerApps(chatId: string, keep: readonly string[]): Promise<ComputerApp[]> {
    const latest = (await this.rounds(chatId)).at(-1)
    if (!latest) throw new Error('no such chat')
    const live = this._live.get(chatId)
    const here = live?.id === latest.id ? live : undefined
    const now = (here?.state() ?? latest.state).computerApps ?? []
    const apps = now.filter((a) => keep.includes(a.bundleId))
    if (apps.length !== now.length) {
      const draft = { type: 'computer/apps', actor: { kind: 'user', id: 'user' }, payload: { apps } } as const
      if (here) await here.append(draft)
      else await this.runtime.ctx.log.appendOne(latest.id as never, draft)
    }
    return apps
  }

  /**
   * Whether a round of the person's runs with full access: its project is set to it, or the sandbox is off in Settings
   * and the project is not read-only. A round someone else started (`askAll`) never does.
   */
  private _fullAccess(
    project: { permissions?: ProjectPermissions } | undefined,
    askAll: boolean | undefined,
  ) {
    if (askAll) return false
    const mode = project?.permissions?.mode
    return mode === 'full' || (this.options.settings?.get().sandbox.enabled === false && mode !== 'read-only')
  }

  /**
   * Whether a round of the person's may use their Mac: computer use is switched on and can run here. A round someone
   * else started (`askAll`) never may; one they write into loses it from then on (ColonyRun.computer).
   */
  private _computerUse(askAll: boolean | undefined): boolean {
    const hub = this.options.computer
    return !askAll && !!hub?.enabled && hub.supported
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
    run.nudge(agent, prompts.chat.handedBack)
  }

  async stop(chatId: string): Promise<void> {
    await this._live.get(chatId)?.stop(STOPPED_BY_USER)
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
  async decideApproval(
    colonyId: string,
    id: string,
    approved: boolean,
    answer: { edits?: Record<string, string>; note?: string } = {},
  ): Promise<void> {
    const run = [...this._live.values()].find((r) => r.id === colonyId)
    if (!run) throw new Error('that round is not running')
    await run.decideApproval(id, approved, 'person', answer)
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
   * Puts the files a round changed back as they were when it started (`undo`: reverts the latest rewind). Only the
   * round's own files are touched: anything changed by anyone else since stays. A file the round changed that was
   * edited again after it ended is left alone and listed in `skipped`, unless `force`.
   * Refused while the chat has a round running, since its agents would be editing the same files.
   */
  async rewind(
    colonyId: string,
    undo = false,
    round?: number,
    force = false,
  ): Promise<{ changed: number; skipped: string[] }> {
    const { state, info, project, checkpoints, start } = await this._projectRound(colonyId, round)
    const chatId = state.chat?.chatId ?? ''
    if (this._live.get(chatId)?.state().status === 'running')
      throw new Error('stop the running round before rewinding its files')
    const now = await checkpoints.snapshot(project, 'before rewinding')
    let target: string
    let files: string[]
    let skipped: string[] = []
    if (undo) {
      const restored = state.checkpoints.restored
      if (!restored) throw new Error('there is no rewind to undo')
      target = restored.undo
      // Rewinds recorded before their files were listed undo whatever differs from the state they saved.
      files = restored.files ? [...restored.files] : await checkpoints.files(project, target, now)
    } else {
      target = start
      const ours = await checkpoints.files(project, start, info.checkpoints.end ?? now)
      const since = info.checkpoints.end
        ? new Set(await checkpoints.files(project, info.checkpoints.end, now))
        : new Set()
      skipped = force ? [] : ours.filter((f) => since.has(f))
      files = ours.filter((f) => !skipped.includes(f))
    }
    const { undo: before, changed } = await checkpoints.restore(project, target, files)
    await this.runtime.ctx.log.appendOne(colonyId as never, {
      type: 'checkpoint/restored',
      actor: { kind: 'user', id: 'user' },
      payload: { commit: target, undo: before, changed, files },
    })
    return { changed, skipped }
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
    await this._settle()
    if (this._live.get(chatId)?.state().status === 'running') throw new Error('this chat is already running')
    const last = (await this.rounds(chatId)).at(-1)
    if (!last) throw new Error('no such chat')
    if (last.round.status === 'completed')
      throw new Error('the latest round already completed; send a follow-up instead')
    if (last.round.escalated)
      throw new Error('this round handed its request to a bigger one; wait for it or send a follow-up')
    const spec = this.specFromLog(await this.store.read(last.id as never))
    // Taken from the settings now, not as the round started: the person may have turned the sandbox back on.
    const project = spec.chat?.project
    const permissions = project ? this.options.projects?.get(project.id)?.permissions : undefined
    if (this._fullAccess(permissions ? { permissions } : project, spec.askAll)) spec.fullAccess = true
    const reads = this._reads(permissions ? { permissions } : project, spec.askAll)
    if (reads.length) spec.reads = reads
    if (this._computerUse(spec.askAll)) spec.computerUse = true
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
      ...(this.options.quietMs !== undefined ? { quietMs: this.options.quietMs } : {}),
      ...(this.options.web ? { web: this.options.web } : {}),
      ...(this.options.unsafeNoSandbox ? { unsafeNoSandbox: true } : {}),
      ...(this.options.mcp ? { mcp: this.options.mcp } : {}),
      ...(this.options.plugins ? { plugins: this.options.plugins } : {}),
      onStream: (agent: string, text: string, done: boolean, plain: boolean) =>
        this._streamed(run.id, agent, text, done, plain),
      ...(this.options.library ? { library: this.options.library } : {}),
      ...(this.options.browser ? { browser: this.options.browser } : {}),
      ...(this.options.computer ? { computer: this.options.computer } : {}),
      ...(this.options.skills ? { skills: this.options.skills } : {}),
      ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
    })
    this._live.set(chatId, run)
    this._own(run)
    try {
      await run.resume(
        model
          ? `${last.state.statusReason ?? 'stopped'}; continuing on ${model}`
          : (last.state.statusReason ?? 'the server stopped'),
        models,
      )
    } catch (err) {
      this._live.delete(chatId)
      this._release(run)
      throw err
    }
    this._wrapUp(
      run.done.finally(() => {
        this._release(run)
        this.index.noteMessages(run.id, run.state())
        if (this._live.get(chatId) === run) this._live.delete(chatId)
        return this._checkpoint(
          run.id,
          last.state.chat?.project,
          'end',
          `after resumed round ${last.round.round}`,
          last.round.round,
        )
      }),
    )
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
    // A member who wrote into the round made it ask for everything from then on.
    const askAll =
      created.askAll ||
      events.some(
        (e) =>
          e.seq > start.seq &&
          e.type === 'permissions/changed' &&
          (e.payload as EventPayloads['permissions/changed']).askAll,
      )
    const joined = events
      .filter((e) => e.type === 'agent/joined' && e.seq > start.seq)
      .map((e) => (e.payload as EventPayloads['agent/joined']).agent)
    const notes = this.options.settings?.get().instructions
    const agents = [...created.agents, ...joined].map((info) => {
      const note = (info.role === 'lead' ? notes?.lead : notes?.worker)?.trim()
      return this._asSpecialist({
        name: info.name,
        role: info.role,
        model: info.model,
        ...(info.specialty ? { specialty: info.specialty } : {}),
        ...(note ? { instructions: note } : {}),
      })
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
              ...(created.team.mode !== 'swarm'
                ? { specialists: this._bringable(agents, created.team.workerModels[0] ?? '') }
                : {}),
            },
          }
        : {}),
      ...(created.disabledTools?.length ? { disabledTools: created.disabledTools } : {}),
      ...(created.askTools?.length ? { askTools: created.askTools } : {}),
      ...(created.allowTools?.length ? { allowTools: created.allowTools } : {}),
      ...(askAll ? { askAll: true } : {}),
      ...(created.review ? { review: created.review } : {}),
      ...(created.tier ? { tier: created.tier } : {}),
    }
  }

  /** Permanently deletes every round of a chat, stopping a running round first. Returns the deleted colony ids. */
  async delete(chatId: string): Promise<string[]> {
    this._deleting.add(chatId)
    try {
      const live = this._live.get(chatId)
      if (live) {
        await live.stop('chat deleted')
        await live.done
        this._live.delete(chatId)
      }
      const ids = [...new Set((await this.rounds(chatId)).map((r) => r.id))]
      // A name already on its way lands first; deleting under it would let the append recreate the log.
      await this._naming.get(chatId)?.catch(() => {})
      for (const id of ids) {
        this.store.deleteColony(id as never)
        this.index.forget(id)
      }
      return ids
    } finally {
      this._deleting.delete(chatId)
    }
  }

  /**
   * The person changed tool settings or a project's permissions: running rounds take the new rules at once, and an
   * agent mid-turn under rules that got stricter is stopped and told what changed (see ColonyRun.applyRules).
   */
  async permissionsChanged(): Promise<void> {
    const rules = toolRules(this.options.settings?.get())
    for (const run of this._live.values()) {
      if (run.state().status !== 'running') continue
      const project = run.spec.chat?.project
      const fresh = project ? this.options.projects?.get(project.id)?.permissions : undefined
      const fullAccess = this._fullAccess(fresh ? { permissions: fresh } : project, run.spec.askAll)
      const reads = this._reads(fresh ? { permissions: fresh } : project, run.spec.askAll)
      await run.applyRules({ ...rules, ...(fresh ? { project: fresh } : {}), fullAccess, reads })
    }
  }

  private readonly _streams = new Set<
    (colonyId: string, agent: string, text: string, done: boolean, plain: boolean) => void
  >()

  /** Every event as it is appended to any colony, e.g. for a channel following a round it started. */
  onEvents(listener: (colonyId: string, events: readonly MyrEvent[]) => void): () => void {
    return this.runtime.ctx.on('log/appended', listener)
  }

  /** A colony's whole log. */
  events(colonyId: string): Promise<MyrEvent[]> {
    return this.store.read(colonyId as never)
  }

  /** Listens to speaking agents' replies as they are written (live display only; nothing is logged). */
  onStream(
    listener: (colonyId: string, agent: string, text: string, done: boolean, plain: boolean) => void,
  ): () => void {
    this._streams.add(listener)
    return () => this._streams.delete(listener)
  }

  private _streamed(colonyId: string, agent: string, text: string, done: boolean, plain: boolean) {
    for (const listener of this._streams) listener(colonyId, agent, text, done, plain)
  }

  private _wrapUp(work: Promise<unknown>) {
    this._wrapUps.add(work)
    void work.finally(() => this._wrapUps.delete(work))
  }

  /** Stops every round, a crew still winding down included, and waits until nothing of theirs runs any more. */
  async stopAll(): Promise<void> {
    await Promise.all([...this._live.values()].map((r) => r.stop('server shutting down')))
    await Promise.allSettled([...this._wrapUps])
  }

  private buildSpec(
    chatId: string,
    request: string,
    config: TeamConfig,
    previous: readonly RoundRef[],
    history: string,
    requested: Tier,
    addressed: readonly string[] = [],
  ): ColonySpec {
    const s = this.options.settings?.get()
    const leadNote = s?.instructions.lead?.trim()
    const workerNote = s?.instructions.worker?.trim()
    const roster = config.roster.slice(0, MAX_WORKERS)
    const extra = config.mode === 'orchestrated' ? Math.max(0, config.extraWorkers ?? 0) : 0
    // A team with nobody to delegate to is one agent working alone. A swarm the person set up works together
    // on anything bigger than a direct answer.
    const tier: Tier =
      addressed.length > 0
        ? 'team'
        : requested === 'team' && config.mode === 'orchestrated' && roster.length === 0 && extra === 0
          ? 'solo'
          : requested === 'solo' && config.mode === 'swarm' && roster.length > 1
            ? 'team'
            : requested
    const taken = new Set(['lead'])
    // A chat keeps its team: the workers (or peers) of its latest team round come back, minus any the lead
    // dismissed, with their memory. The team picker shapes only a chat's first team.
    const kept = keptTeam(previous, config.mode).map((info): AgentSpec => {
      taken.add(info.name)
      const note = info.focus ? prompts.chat.keptFocus(info.focus) : workerNote
      return {
        name: info.name,
        role: info.role,
        model: info.model,
        ...(info.specialty ? { specialty: info.specialty } : {}),
        ...(info.focus ? { focus: info.focus } : {}),
        ...(note ? { instructions: note } : {}),
      }
    })
    // Someone the person wrote to directly comes back even if the latest team round did not have them.
    const known = previous.at(-1)?.state.agents ?? {}
    for (const name of addressed) {
      const info = known[name]?.info
      if (!info || kept.some((k) => k.name === name) || info.role === 'lead') continue
      taken.add(name)
      kept.push({
        name,
        role: info.role,
        model: info.model,
        ...(info.specialty ? { specialty: info.specialty } : {}),
        ...(info.focus ? { focus: info.focus } : {}),
      })
    }
    const crew = (role: 'worker' | 'peer'): AgentSpec[] =>
      kept.length > 0
        ? kept
        : roster.flatMap((r) => {
            // A roster place taken by a saved specialist: it joins under its own name, once.
            const saved = r.specialist ? this.options.specialists?.byName(r.specialist) : undefined
            if (saved) {
              if (taken.has(saved.name)) return []
              taken.add(saved.name)
              return [specialistAgent({ ...saved, model: r.model || saved.model }, role, r.model)]
            }
            const name = pickName(taken)
            taken.add(name)
            return [
              {
                name,
                role,
                model: r.model,
                ...(r.role && r.role !== 'peer' && r.role !== 'worker' ? { specialty: r.role } : {}),
                ...(workerNote ? { instructions: workerNote } : {}),
              },
            ]
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
    // A swarm has no lead, even when a round has one agent: that agent is a peer.
    const alone: AgentSpec =
      config.mode === 'swarm'
        ? (kept[0] ?? {
            name: pickName(taken),
            role: 'peer',
            model: roster[0]?.model ?? config.leadModel,
            ...(workerNote ? { instructions: workerNote } : {}),
          })
        : lead
    const agents: AgentSpec[] = (
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
    ).map((a) => this._asSpecialist(a))
    // A lead working alone keeps the crew on call: it asks one for a piece of work instead of calling the team.
    const crewmates =
      tier === 'solo' && config.mode === 'orchestrated'
        ? crew('worker').map((a) => this._asSpecialist(a))
        : []
    const { disabledTools, askTools, allowTools } = toolRules(s)
    // Without a settings store (tests, bare runtimes) the round keeps the rules from before the setting: direct
    // answers are not reviewed, other final answers always are.
    const review = s?.verification.reviewer
    const wallMs = Math.round((config.wallMinutes ?? s?.team.wallMinutes ?? 30) * 60_000)
    const limits = {
      ...(s?.team.costUsd ? { costUsd: s.team.costUsd } : {}),
      ...(s?.team.tokens ? { tokens: s.team.tokens } : {}),
    }
    const models = [...new Set([...roster.map((r) => r.model), config.leadModel])]
    return {
      name: title(request),
      mission: history ? prompts.chat.mission(request, history) : request,
      pattern: swarm ? 'blackboard' : 'lead-workers',
      agents,
      // A direct exchange with a crew member is not reviewed, like a direct answer.
      acceptance:
        review === 'off' || addressed.length > 0 || (tier === 'answer' && review !== 'always')
          ? []
          : [
              {
                verifier: 'llm-judge',
                model: config.judgeModel,
                rubric: s?.verification.rubric?.trim() || prompts.chat.rubric,
                threshold: s?.verification.threshold ?? 0.7,
              },
            ],
      budget:
        tier === 'answer'
          ? { wallMs: Math.min(wallMs, 4 * 60_000), maxTurns: 4, ...limits }
          : { wallMs, maxTurns: s?.team.maxTurns ?? 40, ...limits },
      observer: { intervalMs: (s?.observer.intervalSeconds ?? 45) * 1000 },
      ...(disabledTools.length ? { disabledTools } : {}),
      ...(askTools.length ? { askTools } : {}),
      ...(allowTools.length ? { allowTools } : {}),
      ...(review ? { review } : {}),
      chat: {
        chatId,
        round: previous.length + 1,
        request,
        history,
        ...(escalate.length ? { escalate } : {}),
        ...(addressed.length ? { addressed: [...addressed] } : {}),
      },
      tier,
      ...(config.thinking ? { thinking: config.thinking } : {}),
      team: {
        mode: config.mode,
        maxWorkers: tier === 'team' && !swarm ? (kept.length || roster.length) + extra : 0,
        workerModels: models,
        ...(tier === 'team' && !swarm
          ? { specialists: this._bringable(agents, roster[0]?.model ?? config.leadModel) }
          : {}),
        ...(crewmates.length ? { crewmates } : {}),
      },
    }
  }
}

/** Whether a process is still running (signal 0 checks without sending anything). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
