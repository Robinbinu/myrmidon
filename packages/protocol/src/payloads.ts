import type { EventId } from './event.ts'

export type AgentStatus = 'provisioning' | 'ready' | 'working' | 'idle' | 'completed' | 'stopped' | 'failed'
export type ColonyStatus = 'created' | 'running' | 'completed' | 'stopped' | 'failed'
export type TaskStatus = 'pending' | 'in_progress' | 'submitted' | 'verified' | 'rejected' | 'deleted'
export interface MadeToolInput {
  name: string
  type: 'string' | 'number' | 'boolean'
  description: string
  optional?: boolean
}

export type SignalKind = 'deadline' | 'budget' | 'stall' | 'unclaimed' | 'blocked' | 'conflict'

export interface AgentInfo {
  readonly name: string
  readonly role: string
  readonly model: string
  readonly tools: readonly string[]
  /** What a specialist worker is for, e.g. `researcher` or `coder`. */
  readonly specialty?: string
  /** A spawned worker's brief from the lead, kept so the worker can join later rounds as it was. */
  readonly focus?: string
}

/**
 * How a chat colony's team works. `orchestrated`: a lead plans and assigns tasks to specialists;
 * `swarm`: equal peers coordinate through shared notes and tasks. `auto`/`manual` are older names
 * for lead-run teams, kept so earlier logs still read.
 */
export type TeamMode = 'orchestrated' | 'swarm' | 'auto' | 'manual'

/** What kind of shared note this is; one live `plan` per colony. */
export type NoteSection = 'plan' | 'decision' | 'finding' | 'status' | 'user'

export interface TaskSnapshot {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TaskStatus
  readonly owner?: string
  readonly blockedBy: readonly string[]
  readonly artifacts: readonly string[]
  /** The agent this task is meant for; only it is woken when the task appears. */
  readonly assignee?: string
  /** Artifact names this task will produce; nobody else may publish them while it is in progress. */
  readonly outputs?: readonly string[]
}

export interface UsageInfo {
  readonly input: number
  readonly output: number
  readonly totalTokens: number
  /** USD; undefined when the provider did not report cost. */
  readonly cost?: number
}

/** Payload shape for every event type the core and runtime register. */
export interface EventPayloads {
  'colony/created': {
    name: string
    mission: string
    pattern: string
    agents: AgentInfo[]
    acceptance: unknown[]
    /** `tokens` counts every token the models process, cached input included (what the run card shows). */
    budget: { wallMs: number; costUsd?: number; tokens?: number; maxTurns?: number }
    unsafeNoSandbox: boolean
    chat?: {
      chatId: string
      round: number
      request: string
      history?: string
      project?: { id: string; name: string; path: string }
    }
    team?: { mode: TeamMode; maxWorkers: number; workerModels: string[] }
    /** How much machinery this round uses: a direct answer, one agent, or the full team. */
    tier?: 'answer' | 'solo' | 'team'
    /** The rest of the spec, so an interrupted colony can be resumed exactly as it was created. */
    observerMs?: number
    thinking?: 'low' | 'medium' | 'high'
    taskJudge?: string
    disabledTools?: string[]
  }
  /**
   * `pid`/`hostname` identify the runner process so orphaned colonies can be detected. `resumed` marks a
   * stopped or interrupted colony picking up where it left off.
   */
  'colony/started': {
    pid?: number
    hostname?: string
    resumed?: boolean
    /** Agents switched to another model on resume (agent → model). */
    models?: Record<string, string>
  }
  'colony/stopped': { reason: string }
  'agent/joined': { agent: AgentInfo; by: string; focus: string }
  /**
   * A frame of an agent's browser after one action, for replaying what it did: a JPEG screenshot (blob), where its
   * cursor was, and the element it acted on, in CSS pixels of a `width` x `height` viewport.
   */
  'browser/keyframe': {
    agent: string
    blob: string
    url: string
    title: string
    action: 'open' | 'click' | 'type' | 'press'
    label?: string
    cursor?: { x: number; y: number }
    box?: { x: number; y: number; width: number; height: number }
    width: number
    height: number
  }
  /** An agent's model refused or failed; the round pauses so the person can continue with another model. */
  'agent/error': { agent: string; model: string; kind: 'refusal' | 'error'; message: string }
  /** The lead let a worker go: it stops now and is not brought into later rounds of the chat. */
  'agent/dismissed': { agent: string; by: string; reason: string }
  /**
   * An agent made a tool the colony can call: a script that reads its inputs as JSON from `MYR_INPUT` and prints
   * its result. `library` marks one loaded from the person's tool library rather than made in this colony.
   */
  'tool/created': {
    agent: string
    name: string
    description: string
    inputs: MadeToolInput[]
    language: 'typescript' | 'python' | 'bash'
    source: string
    library?: boolean
  }
  /**
   * `steer` (the default) is read at the agent's next step; `queue` waits until it finishes what it is
   * doing. Only meaningful for messages sent while a round is running.
   */
  'chat/user': { text: string; mode?: 'steer' | 'queue'; attachments?: string[] }
  /** `question` marks a reply that waits on the user before the colony can continue. */
  'chat/reply': { agent: string; text: string; final: boolean; question?: boolean }
  /** The user renamed the conversation; the newest rename across its rounds wins. */
  'chat/renamed': { title: string }
  'colony/failed': { reason: string }
  'colony/completed': { verdicts: EventId[] }
  'agent/status': { agent: string; status: AgentStatus; detail?: string }
  'agent/turn': { agent: string; phase: 'start' | 'end'; turn: number; trigger: string }
  'llm/response': {
    agent: string
    model: string
    text: string
    thinking?: string
    toolCalls: { id: string; name: string; arguments: unknown }[]
    usage?: UsageInfo
    stopReason: string
    error?: string
  }
  'tool/call': { agent: string; callId: string; tool: string; args: unknown }
  'tool/result': { agent: string; callId: string; tool: string; ok: boolean; output: string }
  'board/posted': { agent: string; text: string; mentions: string[] }
  'note/appended': { agent: string; text: string; corrects?: EventId; section?: NoteSection }
  'mail/sent': { from: string; to: string; subject: string; body: string }
  /** `mail` is a mail/sent event, or a chat/user message the agent has now read. */
  'mail/delivered': { mail: EventId; to: string }
  'task/changed': { task: TaskSnapshot; by: string }
  'artifact/versioned': {
    name: string
    version: number
    blob: string
    size: number
    parentVersion?: number
    author: string
    mediaType: string
  }
  'observer/signal': {
    kind: SignalKind
    severity: 'info' | 'warn' | 'critical'
    facts: string
    targets: string[]
  }
  'verifier/requested': { target: string; by: string }
  'verifier/verdict': {
    target: string
    verifierId: string
    pass: boolean
    score?: number
    evidence: string
  }
}

export type EventType = keyof EventPayloads
