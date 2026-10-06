import type { EventId, MyrEvent } from './event.ts'
import type { AgentInfo, AgentStatus, ColonyStatus, EventPayloads, SignalKind, TaskSnapshot } from './payloads.ts'

export interface AgentView {
  readonly info: AgentInfo
  status: AgentStatus
  detail?: string
  turns: number
  tokens: number
  /** Sum of reported costs; `costKnown` is false once any response lacked cost. */
  cost: number
  costKnown: boolean
  toolCalls: number
  lastSeq: number
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
}

export interface NoteEntry extends Entry {
  readonly agent: string
  readonly text: string
  readonly corrects?: EventId
}

export interface MailEntry extends Entry {
  readonly from: string
  readonly to: string
  readonly subject: string
  readonly body: string
  delivered: boolean
}

export interface ArtifactVersion extends Entry {
  readonly version: number
  readonly blob: string
  readonly size: number
  readonly author: string
  readonly mediaType: string
  readonly parentVersion?: number
}

export interface VerdictEntry extends Entry {
  readonly target: string
  readonly verifierId: string
  readonly pass: boolean
  readonly score?: number
  readonly evidence: string
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
  createdAt?: string
  endedAt?: string
  budget: EventPayloads['colony/created']['budget']
  unsafeNoSandbox: boolean
  agents: Record<string, AgentView>
  board: BoardEntry[]
  notes: NoteEntry[]
  mail: MailEntry[]
  tasks: Record<string, TaskSnapshot>
  artifacts: Record<string, ArtifactVersion[]>
  verdicts: VerdictEntry[]
  signals: SignalEntry[]
  /** Communication counts keyed `from→to`; drives the colony map edges. */
  links: Record<string, number>
  lastSeq: number
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
    tasks: {},
    artifacts: {},
    verdicts: [],
    signals: [],
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

/** Mutating fold step. Pure with respect to everything except `state`. Unknown types are ignored. */
export function applyEvent(state: ColonyState, event: MyrEvent): ColonyState {
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
    case 'colony/started':
      state.status = 'running'
      break
    case 'colony/stopped':
    case 'colony/failed': {
      const p = event.payload as { reason: string }
      state.status = event.type === 'colony/stopped' ? 'stopped' : 'failed'
      state.statusReason = p.reason
      state.endedAt = event.time
      break
    }
    case 'colony/completed':
      state.status = 'completed'
      state.endedAt = event.time
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
        else view.cost += p.usage.cost
        view.lastSeq = event.seq
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
      state.board.push({ ...base, agent: p.agent, text: p.text, mentions: p.mentions })
      const targets = p.mentions.length > 0 ? p.mentions : Object.keys(state.agents).filter((a) => a !== p.agent)
      for (const to of targets) link(state, p.agent, to)
      touch(state, p.agent, event.seq)
      break
    }
    case 'note/appended': {
      const p = event.payload as EventPayloads['note/appended']
      state.notes.push({ ...base, agent: p.agent, text: p.text, corrects: p.corrects })
      touch(state, p.agent, event.seq)
      break
    }
    case 'mail/sent': {
      const p = event.payload as EventPayloads['mail/sent']
      state.mail.push({ ...base, from: p.from, to: p.to, subject: p.subject, body: p.body, delivered: false })
      link(state, p.from, p.to)
      touch(state, p.from, event.seq)
      break
    }
    case 'mail/delivered': {
      const p = event.payload as EventPayloads['mail/delivered']
      const mail = state.mail.find((m) => m.id === p.mail)
      if (mail) mail.delivered = true
      break
    }
    case 'task/changed': {
      const p = event.payload as EventPayloads['task/changed']
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

export function foldColony(id: string, events: Iterable<MyrEvent>, uptoSeq = Number.POSITIVE_INFINITY): ColonyState {
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

export function colonyMetrics(state: ColonyState, now = Date.now()): ColonyMetrics {
  const agents = Object.values(state.agents)
  const start = state.createdAt ? Date.parse(state.createdAt) : now
  const end = state.endedAt ? Date.parse(state.endedAt) : now
  const scores = state.verdicts.map((v) => v.score).filter((s): s is number => s !== undefined)
  return {
    wallMs: Math.max(0, end - start),
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
