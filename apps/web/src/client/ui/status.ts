import type { AgentView, ColonyState } from '@myrmidon/protocol'

/** The colour families a status can take; Badge and Dot map each to its tokens. */
export type Tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'work' | 'accent'

/**
 * One meaning per colour, everywhere: amber accent asks for the person, the work tone is moving, green is done, red is
 * a real failure. A stop is not a failure, so stopped, idle and resting stay neutral. A channel's connection states
 * (on, connecting, linking, retrying, error, off) follow the same rules.
 */
export function toneFor(status: string): Tone {
  if (['completed', 'done', 'verified', 'ready', 'on'].includes(status)) return 'ok'
  if (['failed', 'rejected', 'error'].includes(status)) return 'bad'
  if (['submitted', 'retrying'].includes(status)) return 'warn'
  if (['running', 'created', 'working', 'in_progress', 'connecting', 'linking'].includes(status))
    return 'work'
  if (['waiting', 'awaiting'].includes(status)) return 'accent'
  return 'neutral'
}

/**
 * How a status dot is drawn, as Claude Code's sidebar draws them: only work in progress moves (a spinner); a filled
 * dot wants a look (yellow: the person must act; green: finished and not seen yet), a grey hollow ring has been seen
 * or is resting. Its words always sit beside it.
 *   spinner  working: running, connecting
 *   alert    needs the person: an answer, an approval (yellow fill)
 *   unread   finished while the person was elsewhere, not opened yet (green fill)
 *   live     on and healthy: a connection, a ready provider (filled, its tone's colour)
 *   done     finished and seen: completed, verified (grey hollow ring)
 *   idle     resting, nothing to do (hollow muted ring)
 *   queued   waiting its turn: pending, provisioning (dashed ring)
 *   stopped  stopped by someone (small square)
 *   failed   failed or refused (×)
 */
export type DotShape =
  | 'spinner'
  | 'alert'
  | 'unread'
  | 'live'
  | 'done'
  | 'idle'
  | 'queued'
  | 'stopped'
  | 'failed'

export function dotShape(status: string): DotShape {
  if (status === 'unread') return 'unread'
  if (['waiting', 'awaiting'].includes(status)) return 'alert'
  if (['pending', 'queued', 'provisioning'].includes(status)) return 'queued'
  if (status === 'stopped') return 'stopped'
  if (['completed', 'done', 'verified'].includes(status)) return 'done'
  if (['idle', 'resting', 'off'].includes(status)) return 'idle'
  const tone = toneFor(status)
  if (tone === 'work') return 'spinner'
  if (tone === 'bad') return 'failed'
  if (tone === 'accent') return 'alert'
  return tone === 'neutral' ? 'idle' : 'live'
}

/**
 * A chat's or crew run's state for its dot and pill. A round that stopped to ask the person waits for them, and one a
 * model failure stopped has failed (`stopCause` in the protocol tells these from an ordinary stop).
 */
export type RunPhase = 'working' | 'awaiting' | 'completed' | 'stopped' | 'failed'

export function runPhase(run: { status: string; awaiting?: boolean; failed?: boolean }): RunPhase {
  if (run.status === 'running' || run.status === 'created') return 'working'
  if (run.failed) return 'failed'
  if (run.awaiting) return 'awaiting'
  if (run.status === 'completed' || run.status === 'failed') return run.status
  return 'stopped'
}

/** A chat waiting on the person's answer or approval: it heads the sidebar and is counted in the window title. */
export const needsYou = (run: Parameters<typeof runPhase>[0]) => runPhase(run) === 'awaiting'

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
 * an interrupted runner) stays stopped with that reason. The agent whose model failed has failed: it leaves the round
 * without a status of its own, so it would otherwise still read as working.
 */
export function agentPhase(
  agent: Pick<AgentView, 'status' | 'detail'> & { info: { name: string } },
  run?: Pick<ColonyState, 'modelError'>,
): { phase: AgentPhase; detail?: string } {
  const { status, detail } = agent
  if (run?.modelError?.agent === agent.info.name) return { phase: 'failed' }
  if (status === 'stopped' && detail !== undefined && ROUND_ENDS.has(detail))
    return { phase: detail === 'completed' ? 'done' : 'resting' }
  if (status === 'completed') return { phase: 'done', ...(detail ? { detail } : {}) }
  return { phase: status, ...(detail ? { detail } : {}) }
}
