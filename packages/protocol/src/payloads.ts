import type { EventId } from './event.ts'

export type AgentStatus = 'provisioning' | 'ready' | 'working' | 'idle' | 'completed' | 'stopped' | 'failed'
export type ColonyStatus = 'created' | 'running' | 'completed' | 'stopped' | 'failed'
export type TaskStatus = 'pending' | 'in_progress' | 'submitted' | 'verified' | 'rejected' | 'deleted'
export type SignalKind = 'deadline' | 'budget' | 'stall' | 'unclaimed' | 'blocked' | 'conflict'

export interface AgentInfo {
  readonly name: string
  readonly role: string
  readonly model: string
  readonly tools: readonly string[]
}

export interface TaskSnapshot {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TaskStatus
  readonly owner?: string
  readonly blockedBy: readonly string[]
  readonly artifacts: readonly string[]
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
    budget: { wallMs: number; costUsd?: number; maxTurns?: number }
    unsafeNoSandbox: boolean
  }
  /** `pid`/`hostname` identify the runner process so orphaned colonies can be detected. */
  'colony/started': { pid?: number; hostname?: string }
  'colony/stopped': { reason: string }
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
  'note/appended': { agent: string; text: string; corrects?: EventId }
  'mail/sent': { from: string; to: string; subject: string; body: string }
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
