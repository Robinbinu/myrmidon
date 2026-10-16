import type { EventId, MyrEvent } from './event.ts'
import type {
  AgentInfo,
  AgentStatus,
  Budget,
  ChatGrant,
  ColonyStatus,
  ComputerApp,
  EventPayloads,
  NoteSection,
  QuestionAnswers,
  QuestionChoice,
  RoundGoal,
  SignalKind,
  TaskSnapshot,
} from './payloads.ts'
import { type PermissionLevel, type RoundAccess, rulesFromGrants } from './permissions.ts'

export interface AgentView {
  info: AgentInfo
  status: AgentStatus
  detail?: string
  turns: number
  tokens: number
  /** Sum of reported costs; `costKnown` is false once any response lacked cost. */
  cost: number
  costKnown: boolean
  toolCalls: number
  lastSeq: number
  /** The lead dismissed this worker; later rounds of the chat leave it out. */
  dismissed?: boolean
  /**
   * The model this agent was set up with, while it works on a fallback after that one failed: a later round, or a
   * resume, starts it on this one again.
   */
  fellBackFrom?: string
}

/** One round of a chat colony: a request and the work that answered it, as a range of the log. */
export interface RoundInfo {
  readonly round: number
  readonly request: string
  readonly tier?: EventPayloads['colony/created']['tier']
  readonly swarm: boolean
  /** Goal mode: the condition the round's work is checked against until it holds. */
  readonly goal?: RoundGoal
  /** The round's first event (colony/created or round/started). */
  readonly startSeq: number
  readonly startedAt: string
  /** The event that ended the round, once it ended. */
  endSeq?: number
  endedAt?: string
  status: ColonyStatus
  statusReason?: string
  escalated?: EventPayloads['colony/escalated']
  /** The round's project snapshots: its changes are start → end. */
  checkpoints: { start?: string; end?: string }
  /** USD its models and tools reported while it was the colony's latest round; unpriced responses add nothing. */
  cost: number
}

export interface Entry {
  readonly seq: number
  readonly id: EventId
  readonly time: string
}

export interface BoardEntry extends Entry {
  readonly agent: string
  readonly text: string
  readonly mentions: string[]
  readonly replyTo?: number
}

export interface NoteEntry extends Entry {
  readonly agent: string
  readonly text: string
  readonly corrects?: EventId
  readonly section?: NoteSection
}

export interface MailEntry extends Entry {
  readonly from: string
  readonly to: string
  readonly subject: string
  readonly body: string
  /** The number (seq) of the mail this answers. */
  readonly replyTo?: number
  /** Set on a group message: who it reached (`to` is the group's name). */
  readonly members?: readonly string[]
  /** Recipients who have had it in front of them, each on their own (a group's members read at different times). */
  readBy: string[]
  /** Every recipient has read it: the two ticks. */
  delivered: boolean
}

/** Who a message is for: a group's members other than the sender, or the one person it was sent to. */
export const recipientsOf = (m: Pick<MailEntry, 'from' | 'to' | 'members'>): string[] =>
  m.members?.length ? m.members.filter((n) => n !== m.from) : [m.to]

export interface GroupView {
  readonly name: string
  members: string[]
  readonly by: string
  readonly seq: number
}

export interface ArtifactVersion extends Entry {
  readonly version: number
  readonly blob: string
  readonly size: number
  readonly author: string
  readonly mediaType: string
  readonly parentVersion?: number
}

/**
 * The verifier of a round nobody reviews: completion must cite a passing verdict, so its final answer records that it
 * was delivered. It checks nothing, so it is never shown as a review, an approval, or a judge's pass.
 */
export const DELIVERED_VERIFIER = 'delivered'

/** The verdicts of checks that actually ran, leaving out an unreviewed round's record of delivery. */
export function reviewVerdicts(state: Pick<ColonyState, 'verdicts'>): VerdictEntry[] {
  return state.verdicts.filter((v) => v.verifierId !== DELIVERED_VERIFIER)
}

export interface VerdictEntry extends Entry {
  readonly target: string
  readonly verifierId: string
  readonly pass: boolean
  readonly score?: number
  readonly evidence: string
}

export interface ChatEntry extends Entry {
  /** `user` for the human; otherwise the replying agent's name. */
  readonly from: string
  readonly text: string
  readonly final: boolean
  /** The colony is waiting on the user to answer this. */
  readonly question?: boolean
  /** A check-in: the work goes on assuming this until the user answers. */
  readonly assumption?: string
  /** Options the user can click to answer (ask_user). */
  readonly choices?: readonly QuestionChoice[]
  /** The plan the question asks the user to approve, in markdown. */
  readonly plan?: string
  /** A message sent mid-run: steered into the current step, or queued until the agent finishes it. */
  readonly mode?: 'steer' | 'queue'
  /** The person's message was addressed to these crew members (@name). */
  readonly to?: readonly string[]
  /** The person said it aloud on a voice call. */
  readonly voice?: boolean
  /** Agents that have read this message (mid-run user messages only). */
  readBy?: string[]
  /** Artifact names of files the person attached. */
  readonly attachments?: readonly string[]
  /** The person answered a question card: the card shows it, so the chat does not repeat it as a message. */
  readonly answers?: QuestionAnswers
}

export interface SignalEntry extends Entry {
  readonly kind: SignalKind
  readonly severity: string
  readonly facts: string
  readonly targets: string[]
}

export interface ColonyState {
  id: string
  name: string
  mission: string
  pattern: string
  status: ColonyStatus
  statusReason?: string
  /** The round handed its request to a bigger tier (it then ends as stopped). */
  escalated?: EventPayloads['colony/escalated']
  createdAt?: string
  endedAt?: string
  budget: EventPayloads['colony/created']['budget']
  unsafeNoSandbox: boolean
  agents: Record<string, AgentView>
  board: BoardEntry[]
  notes: NoteEntry[]
  mail: MailEntry[]
  /** Group chats by name; the team chat (the board) is not one of them. */
  groups: Record<string, GroupView>
  tasks: Record<string, TaskSnapshot>
  artifacts: Record<string, ArtifactVersion[]>
  /** Sign-ins agents asked the person for, by agent; `finished` is set once handed back or given up. */
  logins: Record<
    string,
    EventPayloads['login/requested'] & { time: string; finished?: EventPayloads['login/finished']['outcome'] }
  >
  /** Dev servers agents started, by name; `stopped` is set once one ends. */
  servers: Record<string, EventPayloads['server/started'] & { time: string; stopped?: string }>
  /** Memories agents proposed in this round, by id, and whether the person kept them. */
  memories: Record<string, EventPayloads['memory/proposed'] & { time: string; kept?: boolean }>
  /** Workers' git worktrees, by agent: how many merges landed, an open conflict, and whether it was kept at the end. */
  worktrees: Record<
    string,
    EventPayloads['worktree/created'] & { time: string; merges: number; conflict?: string[]; kept?: boolean }
  >
  /** Tool calls waiting for the person, and how earlier ones were decided. */
  approvals: Record<
    string,
    EventPayloads['approval/requested'] & { time: string; decided?: EventPayloads['approval/decided'] }
  >
  /** Results of approved calls that ran, by receipt key. */
  receipts: Record<string, string>
  /** Skills proposed from this colony's work, and whether the person kept them (unset while undecided). */
  skillProposals: Record<string, EventPayloads['skill/proposed'] & { seq: number; kept?: boolean }>
  /** Project folder snapshots of this round, and the latest rewind (if any). */
  checkpoints: {
    start?: string
    end?: string
    restored?: EventPayloads['checkpoint/restored'] & { time: string }
  }
  /** Tools made by agents (or loaded from the library), latest definition per name. */
  madeTools: Record<string, EventPayloads['tool/created'] & { seq: number; time: string }>
  verdicts: VerdictEntry[]
  signals: SignalEntry[]
  chatMessages: ChatEntry[]
  chat?: EventPayloads['colony/created']['chat']
  /** A chat colony's rounds, oldest first; `chat.round` is the current one. */
  rounds: RoundInfo[]
  /** A title the user gave the conversation in this round, with when. */
  chatTitle?: { title: string; at: string; by?: 'auto' }
  /** Where the chat left off after one of its rounds (chat/handoff), the latest note. */
  handoff?: { round: number; text: string; at: string }
  /** How many times the person reset the provider's stream state for this chat (chat/fresh, the /fresh command). */
  freshes?: number
  /** Old logs: kinds of step the person allowed for the rest of the chat (see `chatLevel`). */
  chatGrants?: ChatGrant[]
  /** The chat's level of the permission model; absent until the person first sets something for the chat. */
  chatPermissions?: PermissionLevel
  /** The chat's own spend caps; absent until the person first sets one for the chat. */
  chatBudget?: Budget
  /** Folders the person let sandboxed agents read for the rest of the chat; absent until they allow one. */
  chatReads?: string[]
  /** Apps on the person's Mac they let agents use in this chat (computer use); absent until they allow one. */
  computerApps?: ComputerApp[]
  /**
   * Someone other than the person (a channel member, a share's guest) started or wrote into one of this colony's
   * rounds; never cleared. Their chats stay out of what agents search in past chats.
   */
  othersWrote?: boolean
  /** The current round runs with full access (no sandbox); absent when it is confined. */
  fullAccess?: boolean
  /** What the current round's agents were last told they may do; absent in logs from before it was kept. */
  access?: RoundAccess
  /** The model failure that paused the round, until it resumes. */
  modelError?: EventPayloads['agent/error'] & { time: string }
  team?: EventPayloads['colony/created']['team']
  tier?: EventPayloads['colony/created']['tier']
  /** Communication counts keyed `from→to`; drives the colony map edges. */
  links: Record<string, number>
  lastSeq: number
}

function roundOf(p: EventPayloads['colony/created'], event: MyrEvent): RoundInfo {
  return {
    round: p.chat?.round ?? 1,
    request: p.chat?.request ?? p.mission,
    ...(p.tier ? { tier: p.tier } : {}),
    swarm: p.team?.mode === 'swarm' && p.tier === 'team',
    ...(p.goal ? { goal: p.goal } : {}),
    startSeq: event.seq,
    startedAt: event.time,
    status: 'created',
    checkpoints: {},
    cost: 0,
  }
}

/** Counts spend toward the latest round: what agents spend while a round winds down is still that round's. */
function spend(state: ColonyState, cost: number) {
  const round = state.rounds.at(-1)
  if (round) round.cost += cost
}

/** Closes the current round with the colony's status as the event left it. */
function endRound(state: ColonyState, event: MyrEvent) {
  const round = state.rounds.at(-1)
  if (!round) return
  round.status = state.status
  round.endSeq = event.seq
  round.endedAt = event.time
  if (state.statusReason) round.statusReason = state.statusReason
  if (state.escalated) round.escalated = state.escalated
}

export function emptyColonyState(id: string): ColonyState {
  return {
    id,
    name: id,
    mission: '',
    pattern: '',
    status: 'created',
    budget: { wallMs: 0 },
    unsafeNoSandbox: false,
    agents: {},
    board: [],
    notes: [],
    mail: [],
    groups: {},
    tasks: {},
    artifacts: {},
    madeTools: {},
    checkpoints: {},
    approvals: {},
    receipts: {},
    skillProposals: {},
    servers: {},
    worktrees: {},
    memories: {},
    logins: {},
    verdicts: [],
    signals: [],
    chatMessages: [],
    rounds: [],
    links: {},
    lastSeq: 0,
  }
}

function link(state: ColonyState, from: string, to: string) {
  const key = `${from}→${to}`
  state.links[key] = (state.links[key] ?? 0) + 1
}

function touch(state: ColonyState, agent: string, seq: number) {
  const view = state.agents[agent]
  if (view) view.lastSeq = seq
}

/**
 * A chat's level of the permission model as its latest round knows it: what the person set for the chat, or, in a
 * chat from before the model, its approval cards' grants as rules. Absent when nothing was set for the chat.
 */
export function chatLevel(
  state: Pick<ColonyState, 'chatPermissions' | 'chatGrants'>,
): PermissionLevel | undefined {
  if (state.chatPermissions) return state.chatPermissions
  return state.chatGrants?.length ? { rules: rulesFromGrants(state.chatGrants) } : undefined
}

/**
 * Mutating fold step. Pure with respect to everything except `state`. Unknown types are ignored, and so is an event at
 * or before the state's position: `seq` is the log's only order, so one delivered twice (a replay, a subscriber that
 * read the log and then heard it appended) or late counts once, whoever folds it.
 */
export function applyEvent(state: ColonyState, event: MyrEvent): ColonyState {
  if (event.seq > 0 && event.seq <= state.lastSeq) return state
  const base = { seq: event.seq, id: event.id, time: event.time }
  state.lastSeq = event.seq
  switch (event.type) {
    case 'colony/created': {
      const p = event.payload as EventPayloads['colony/created']
      state.name = p.name
      state.mission = p.mission
      state.pattern = p.pattern
      state.budget = p.budget
      state.unsafeNoSandbox = p.unsafeNoSandbox
      state.createdAt = event.time
      state.chat = p.chat
      state.team = p.team
      state.tier = p.tier
      if (p.fullAccess) state.fullAccess = true
      if (p.askAll) state.othersWrote = true
      if (p.access) state.access = p.access
      if (p.chat) state.rounds = [roundOf(p, event)]
      for (const info of p.agents) {
        state.agents[info.name] = {
          info,
          status: 'provisioning',
          turns: 0,
          tokens: 0,
          cost: 0,
          costKnown: true,
          toolCalls: 0,
          lastSeq: event.seq,
        }
      }
      break
    }
    case 'agent/joined': {
      const p = event.payload as EventPayloads['agent/joined']
      state.agents[p.agent.name] = {
        info: p.agent,
        status: 'provisioning',
        detail: p.focus,
        turns: 0,
        tokens: 0,
        cost: 0,
        costKnown: true,
        toolCalls: 0,
        lastSeq: event.seq,
      }
      link(state, p.by, p.agent.name)
      break
    }
    case 'login/requested': {
      const p = event.payload as EventPayloads['login/requested']
      state.logins[p.agent] = { ...p, time: event.time }
      break
    }
    case 'login/finished': {
      const p = event.payload as EventPayloads['login/finished']
      const login = state.logins[p.agent]
      if (login) login.finished = p.outcome
      break
    }
    case 'server/started': {
      const p = event.payload as EventPayloads['server/started']
      state.servers[p.name] = { ...p, time: event.time }
      break
    }
    case 'server/stopped': {
      const p = event.payload as EventPayloads['server/stopped']
      const server = state.servers[p.name]
      if (server) server.stopped = p.reason
      break
    }
    case 'memory/proposed': {
      const p = event.payload as EventPayloads['memory/proposed']
      state.memories[p.id] = { ...p, time: event.time }
      break
    }
    case 'memory/decided': {
      const p = event.payload as EventPayloads['memory/decided']
      const memory = state.memories[p.id]
      if (memory) memory.kept = p.kept
      break
    }
    case 'worktree/created': {
      const p = event.payload as EventPayloads['worktree/created']
      state.worktrees[p.agent] = { ...p, time: event.time, merges: 0 }
      break
    }
    case 'worktree/merged': {
      const tree = state.worktrees[(event.payload as EventPayloads['worktree/merged']).agent]
      if (tree) {
        tree.merges += 1
        delete tree.conflict
      }
      break
    }
    case 'worktree/conflict': {
      const p = event.payload as EventPayloads['worktree/conflict']
      const tree = state.worktrees[p.agent]
      if (tree) tree.conflict = p.files
      break
    }
    case 'worktree/closed': {
      const p = event.payload as EventPayloads['worktree/closed']
      const tree = state.worktrees[p.agent]
      if (tree) tree.kept = p.kept
      break
    }
    case 'approval/requested': {
      const p = event.payload as EventPayloads['approval/requested']
      state.approvals[p.id] = { ...p, time: event.time }
      break
    }
    case 'approval/decided': {
      const p = event.payload as EventPayloads['approval/decided']
      const request = state.approvals[p.id]
      if (request) request.decided = p
      break
    }
    case 'skill/proposed': {
      const p = event.payload as EventPayloads['skill/proposed']
      state.skillProposals[p.id] = { ...p, seq: event.seq }
      break
    }
    case 'skill/decided': {
      const p = event.payload as EventPayloads['skill/decided']
      const proposal = state.skillProposals[p.id]
      if (proposal) proposal.kept = p.kept
      break
    }
    case 'review/done': {
      const p = event.payload as EventPayloads['review/done']
      state.receipts[p.key] = p.output
      break
    }
    case 'checkpoint/created': {
      const p = event.payload as EventPayloads['checkpoint/created']
      const round =
        p.round === undefined ? state.rounds.at(-1) : state.rounds.find((r) => r.round === p.round)
      if (round) round.checkpoints[p.phase] = p.commit
      if (!round || round === state.rounds.at(-1)) state.checkpoints[p.phase] = p.commit
      break
    }
    case 'checkpoint/restored': {
      const p = event.payload as EventPayloads['checkpoint/restored']
      state.checkpoints.restored = { ...p, time: event.time }
      break
    }
    case 'tool/created': {
      const p = event.payload as EventPayloads['tool/created']
      state.madeTools[p.name] = { ...p, seq: event.seq, time: event.time }
      if (!p.library) touch(state, p.agent, event.seq)
      break
    }
    case 'agent/model': {
      const p = event.payload as EventPayloads['agent/model']
      const view = state.agents[p.agent]
      if (view) {
        view.info = { ...view.info, model: p.model }
        // The person's choice is the agent's model now, not a stand-in for the one it fell back from.
        delete view.fellBackFrom
      }
      break
    }
    case 'agent/handoff': {
      const p = event.payload as EventPayloads['agent/handoff']
      const view = state.agents[p.agent]
      // The carry-out model is the agent's own now, as a model the person picked would be.
      if (view) {
        view.info = { ...view.info, model: p.model }
        delete view.fellBackFrom
      }
      break
    }
    case 'agent/fallback': {
      const p = event.payload as EventPayloads['agent/fallback']
      const view = state.agents[p.agent]
      if (view) {
        view.fellBackFrom ??= p.previous
        view.info = { ...view.info, model: p.model }
      }
      break
    }
    case 'agent/dismissed': {
      const p = event.payload as EventPayloads['agent/dismissed']
      const view = state.agents[p.agent]
      if (view) {
        view.dismissed = true
        view.status = 'stopped'
        view.detail = `dismissed by ${p.by}: ${p.reason}`
      }
      break
    }
    case 'chat/user': {
      const p = event.payload as EventPayloads['chat/user']
      state.chatMessages.push({
        ...base,
        from: 'user',
        text: p.text,
        final: false,
        ...(p.mode ? { mode: p.mode } : {}),
        ...(p.attachments?.length ? { attachments: p.attachments } : {}),
        ...(p.voice ? { voice: true } : {}),
        ...(p.to?.length ? { to: p.to } : {}),
        ...(p.answers ? { answers: p.answers } : {}),
      })
      break
    }
    case 'chat/reply': {
      const p = event.payload as EventPayloads['chat/reply']
      state.chatMessages.push({
        ...base,
        from: p.agent,
        text: p.text,
        final: p.final,
        ...(p.question ? { question: true } : {}),
        ...(p.assumption ? { assumption: p.assumption } : {}),
        ...(p.choices?.length ? { choices: p.choices } : {}),
        ...(p.plan ? { plan: p.plan } : {}),
      })
      touch(state, p.agent, event.seq)
      break
    }
    case 'chat/renamed': {
      const p = event.payload as EventPayloads['chat/renamed']
      state.chatTitle = { title: p.title, at: event.time, ...(p.by ? { by: p.by } : {}) }
      break
    }
    case 'chat/fresh':
      state.freshes = (state.freshes ?? 0) + 1
      break
    case 'chat/handoff': {
      const p = event.payload as EventPayloads['chat/handoff']
      state.handoff = { round: p.round, text: p.text, at: event.time }
      break
    }
    case 'chat/allowed': {
      const p = event.payload as EventPayloads['chat/allowed']
      state.chatGrants = [...p.grants]
      if (p.reads) state.chatReads = [...p.reads]
      // A folder allowed for the chat answers an agent's own request, so it knows; one taken back it is told of later.
      if (p.reads && state.access)
        state.access = {
          ...state.access,
          reads: [...new Set([...(state.access.reads ?? []), ...p.reads])].sort(),
        }
      break
    }
    case 'chat/budget': {
      state.chatBudget = { ...(event.payload as EventPayloads['chat/budget']) }
      break
    }
    case 'chat/permissions': {
      state.chatPermissions = structuredClone(event.payload as EventPayloads['chat/permissions'])
      break
    }
    case 'computer/apps': {
      state.computerApps = (event.payload as EventPayloads['computer/apps']).apps.map((a) => ({ ...a }))
      break
    }
    case 'permissions/changed': {
      const p = event.payload as EventPayloads['permissions/changed']
      // A round someone else wrote into is confined from then on, whatever it started with.
      if (p.askAll) state.othersWrote = true
      if (p.fullAccess === false || p.askAll) delete state.fullAccess
      else if (p.fullAccess) state.fullAccess = true
      if (p.access) state.access = p.access
      break
    }
    case 'colony/started': {
      const p = event.payload as EventPayloads['colony/started']
      state.status = 'running'
      delete state.statusReason
      delete state.endedAt
      delete state.modelError
      const round = state.rounds.at(-1)
      if (round) {
        round.status = 'running'
        delete round.statusReason
        delete round.endSeq
        delete round.endedAt
      }
      // A resumed round starts its agents on the models they were set up with, or the ones it was resumed on.
      for (const view of Object.values(state.agents)) {
        if (view.fellBackFrom) view.info = { ...view.info, model: view.fellBackFrom }
        delete view.fellBackFrom
      }
      for (const [name, model] of Object.entries(p.models ?? {})) {
        const view = state.agents[name]
        if (view) view.info = { ...view.info, model }
      }
      break
    }
    case 'agent/error': {
      const p = event.payload as EventPayloads['agent/error']
      state.modelError = { ...p, time: event.time }
      break
    }
    case 'round/started': {
      const p = event.payload as EventPayloads['round/started']
      state.mission = p.mission
      state.pattern = p.pattern
      state.budget = p.budget
      state.chat = p.chat
      state.team = p.team
      state.tier = p.tier
      if (p.fullAccess) state.fullAccess = true
      else delete state.fullAccess
      if (p.askAll) state.othersWrote = true
      if (p.access) state.access = p.access
      else delete state.access
      state.status = 'created'
      delete state.statusReason
      delete state.endedAt
      delete state.escalated
      delete state.modelError
      // Tasks and snapshots belong to a round; files, notes, tools and the agents themselves carry on.
      state.tasks = {}
      state.checkpoints = {}
      for (const info of p.agents) {
        const view = state.agents[info.name]
        if (view) {
          view.info = info
          delete view.fellBackFrom
        } else
          state.agents[info.name] = {
            info,
            status: 'provisioning',
            turns: 0,
            tokens: 0,
            cost: 0,
            costKnown: true,
            toolCalls: 0,
            lastSeq: event.seq,
          }
      }
      state.rounds.push(roundOf(p, event))
      break
    }
    case 'colony/escalated': {
      const p = event.payload as EventPayloads['colony/escalated']
      state.escalated = p
      state.status = 'stopped'
      state.statusReason = `moved to ${p.to === 'team' ? 'a team' : 'one agent'}: ${p.reason}`
      state.endedAt = event.time
      endRound(state, event)
      break
    }
    case 'colony/stopped':
    case 'colony/failed': {
      const p = event.payload as { reason: string }
      state.status = event.type === 'colony/stopped' ? 'stopped' : 'failed'
      state.statusReason = p.reason
      state.endedAt = event.time
      endRound(state, event)
      break
    }
    case 'colony/completed':
      state.status = 'completed'
      state.endedAt = event.time
      endRound(state, event)
      break
    case 'agent/status': {
      const p = event.payload as EventPayloads['agent/status']
      const view = state.agents[p.agent]
      if (view) {
        view.status = p.status
        view.detail = p.detail
        view.lastSeq = event.seq
      }
      break
    }
    case 'agent/turn': {
      const p = event.payload as EventPayloads['agent/turn']
      const view = state.agents[p.agent]
      if (view && p.phase === 'start') view.turns = Math.max(view.turns, p.turn)
      touch(state, p.agent, event.seq)
      break
    }
    case 'llm/response': {
      const p = event.payload as EventPayloads['llm/response']
      const view = state.agents[p.agent]
      if (view) {
        view.tokens += p.usage?.totalTokens ?? 0
        if (p.usage?.cost === undefined) view.costKnown = false
        else {
          view.cost += p.usage.cost
          spend(state, p.usage.cost)
        }
        view.lastSeq = event.seq
      }
      break
    }
    case 'tool/result': {
      const p = event.payload as EventPayloads['tool/result']
      const view = state.agents[p.agent]
      // A tool's own spend is added when known; one that reports none leaves the agent's cost as it was.
      if (view && p.usage) {
        view.tokens += p.usage.totalTokens
        if (p.usage.cost !== undefined) {
          view.cost += p.usage.cost
          spend(state, p.usage.cost)
        }
      }
      break
    }
    case 'tool/call': {
      const p = event.payload as EventPayloads['tool/call']
      const view = state.agents[p.agent]
      if (view) view.toolCalls += 1
      touch(state, p.agent, event.seq)
      break
    }
    case 'board/posted': {
      const p = event.payload as EventPayloads['board/posted']
      state.board.push({
        ...base,
        agent: p.agent,
        text: p.text,
        mentions: p.mentions,
        ...(p.replyTo !== undefined ? { replyTo: p.replyTo } : {}),
      })
      const targets =
        p.mentions.length > 0 ? p.mentions : Object.keys(state.agents).filter((a) => a !== p.agent)
      for (const to of targets) link(state, p.agent, to)
      touch(state, p.agent, event.seq)
      break
    }
    case 'note/appended': {
      const p = event.payload as EventPayloads['note/appended']
      state.notes.push({ ...base, agent: p.agent, text: p.text, corrects: p.corrects, section: p.section })
      touch(state, p.agent, event.seq)
      break
    }
    case 'mail/sent': {
      const p = event.payload as EventPayloads['mail/sent']
      state.mail.push({
        ...base,
        from: p.from,
        to: p.to,
        subject: p.subject,
        body: p.body,
        ...(p.replyTo !== undefined ? { replyTo: p.replyTo } : {}),
        // The log's schema fills a missing list with [], so a group message is one that names its members.
        ...(p.members?.length ? { members: p.members } : {}),
        readBy: [],
        delivered: false,
      })
      for (const to of p.members?.length ? p.members : [p.to]) if (to !== p.from) link(state, p.from, to)
      touch(state, p.from, event.seq)
      break
    }
    case 'group/created': {
      const p = event.payload as EventPayloads['group/created']
      state.groups[p.name] = { name: p.name, members: [...new Set(p.members)], by: p.by, seq: event.seq }
      break
    }
    case 'group/changed': {
      const p = event.payload as EventPayloads['group/changed']
      const group = state.groups[p.name]
      if (group)
        group.members = [...new Set([...group.members, ...p.add])].filter((m) => !p.remove.includes(m))
      break
    }
    case 'mail/delivered': {
      const p = event.payload as EventPayloads['mail/delivered']
      const mail = state.mail.find((m) => m.id === p.mail)
      if (mail) {
        if (!mail.readBy.includes(p.to)) mail.readBy.push(p.to)
        mail.delivered = recipientsOf(mail).every((r) => mail.readBy.includes(r))
      }
      const message = mail ? undefined : state.chatMessages.find((m) => m.id === p.mail)
      if (message && !message.readBy?.includes(p.to)) message.readBy = [...(message.readBy ?? []), p.to]
      break
    }
    case 'task/changed': {
      const p = event.payload as EventPayloads['task/changed']
      // Handing a task to someone is one message to them; later revisions of the same task are not.
      const to = p.task.assignee
      if (to && to !== p.by && state.tasks[p.task.id]?.assignee !== to) link(state, p.by, to)
      state.tasks[p.task.id] = p.task
      touch(state, p.by, event.seq)
      break
    }
    case 'artifact/versioned': {
      const p = event.payload as EventPayloads['artifact/versioned']
      const versions = state.artifacts[p.name] ?? []
      versions.push({
        ...base,
        version: p.version,
        blob: p.blob,
        size: p.size,
        author: p.author,
        mediaType: p.mediaType,
        parentVersion: p.parentVersion,
      })
      state.artifacts[p.name] = versions
      touch(state, p.author, event.seq)
      break
    }
    case 'observer/signal': {
      const p = event.payload as EventPayloads['observer/signal']
      state.signals.push({ ...base, kind: p.kind, severity: p.severity, facts: p.facts, targets: p.targets })
      break
    }
    case 'verifier/verdict': {
      const p = event.payload as EventPayloads['verifier/verdict']
      state.verdicts.push({
        ...base,
        target: p.target,
        verifierId: p.verifierId,
        pass: p.pass,
        score: p.score,
        evidence: p.evidence,
      })
      break
    }
  }
  return state
}

export function foldColony(
  id: string,
  events: Iterable<MyrEvent>,
  uptoSeq = Number.POSITIVE_INFINITY,
): ColonyState {
  const state = emptyColonyState(id)
  for (const event of events) {
    if (event.seq > uptoSeq) break
    applyEvent(state, event)
  }
  return state
}

export interface ColonyMetrics {
  wallMs: number
  tokens: number
  cost?: number
  turns: number
  toolCalls: number
  messages: number
  artifactVersions: number
  rejections: number
  bestScore?: number
}

/** Stop reason for a chat round that ended with a question or update for the human. */
export const AWAITING_USER = 'awaiting your reply'

/** Stop reason for a chat round the person stopped themselves. */
export const STOPPED_BY_USER = 'stopped by user'

/**
 * What a stopped run is waiting on, beyond its status: the person's answer, or a model that failed. A model failure
 * stops the run rather than failing it so it can be resumed, so the status alone reads like any other stop.
 */
export function stopCause(state: Pick<ColonyState, 'status' | 'statusReason' | 'modelError'>): {
  awaiting?: true
  failed?: true
} {
  if (state.status !== 'stopped') return {}
  if (state.modelError) return { failed: true }
  return state.statusReason === AWAITING_USER ? { awaiting: true } : {}
}

/** How long the colony has run: until it ended, or until `now` while it still runs. */
export function colonyWallMs(state: Pick<ColonyState, 'createdAt' | 'endedAt'>, now = Date.now()): number {
  const start = state.createdAt ? Date.parse(state.createdAt) : now
  const end = state.endedAt ? Date.parse(state.endedAt) : now
  return Math.max(0, end - start)
}

export function colonyMetrics(state: ColonyState, now = Date.now()): ColonyMetrics {
  const agents = Object.values(state.agents)
  const scores = state.verdicts.map((v) => v.score).filter((s): s is number => s !== undefined)
  return {
    wallMs: colonyWallMs(state, now),
    tokens: agents.reduce((n, a) => n + a.tokens, 0),
    cost: agents.every((a) => a.costKnown) ? agents.reduce((n, a) => n + a.cost, 0) : undefined,
    turns: agents.reduce((n, a) => n + a.turns, 0),
    toolCalls: agents.reduce((n, a) => n + a.toolCalls, 0),
    messages: state.mail.length + state.board.length,
    artifactVersions: Object.values(state.artifacts).reduce((n, v) => n + v.length, 0),
    rejections: state.verdicts.filter((v) => !v.pass).length,
    bestScore: scores.length > 0 ? Math.max(...scores) : undefined,
  }
}
