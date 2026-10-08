import type { AgentView } from '@myrmidon/protocol'

/** The colour families a status can take; Badge and Dot map each to its tokens. */
export type Tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'work' | 'accent'

/**
 * One meaning per colour, everywhere: amber accent asks for the person, the work tone is moving, green is done, red is
 * a real failure. A stop is not a failure, so stopped, idle and resting stay neutral.
 */
export function toneFor(status: string): Tone {
  if (['completed', 'done', 'verified', 'ready'].includes(status)) return 'ok'
  if (['failed', 'rejected'].includes(status)) return 'bad'
  if (['submitted'].includes(status)) return 'warn'
  if (['running', 'created', 'working', 'in_progress'].includes(status)) return 'work'
  if (['waiting', 'awaiting'].includes(status)) return 'accent'
  return 'neutral'
}

/** A chat's or crew run's state for its dot and pill: a round that stopped to ask the person waits for them. */
export type RunPhase = 'working' | 'awaiting' | 'completed' | 'stopped' | 'failed'

export function runPhase(run: { status: string; awaiting?: boolean }): RunPhase {
  if (run.status === 'running' || run.status === 'created') return 'working'
  if (run.awaiting) return 'awaiting'
  if (run.status === 'completed' || run.status === 'failed') return run.status
  return 'stopped'
}

export type AgentPhase =
  | 'provisioning'
  | 'ready'
  | 'working'
  | 'idle'
  | 'done'
  | 'resting'
  | 'stopped'
  | 'failed'

// The runtime stops every agent when its round ends and gives the round's status as the reason.
const ROUND_ENDS = new Set(['completed', 'stopped', 'failed'])

/**
 * What an agent's state means to a person. An agent stopped because its round ended is done (or resting), and the
 * round's status it carries as detail is dropped so it does not repeat; one stopped for its own reason (a turn limit,
 * an interrupted runner) stays stopped with that reason.
 */
export function agentPhase(agent: Pick<AgentView, 'status' | 'detail'>): {
  phase: AgentPhase
  detail?: string
} {
  const { status, detail } = agent
  if (status === 'stopped' && detail !== undefined && ROUND_ENDS.has(detail))
    return { phase: detail === 'completed' ? 'done' : 'resting' }
  if (status === 'completed') return { phase: 'done', ...(detail ? { detail } : {}) }
  return { phase: status, ...(detail ? { detail } : {}) }
}
