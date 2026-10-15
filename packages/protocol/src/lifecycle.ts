import type { ColonyState } from './colony-state.ts'
import type { MyrEvent } from './event.ts'
import type { EventPayloads, TaskSnapshot } from './payloads.ts'

/** One tool call as the log records it: what was asked and, once it ended, its result. */
export interface CallRecord {
  readonly agent: string
  readonly callId: string
  readonly tool: string
  readonly args: unknown
  /** The tool/call event's position in the log. */
  readonly seq: number
  result?: { readonly ok: boolean; readonly output: string }
}

/** The key `callRecords` files a call under: call ids are the model's, so they are only unique per agent. */
export const callKey = (agent: string, callId: string) => `${agent}\u0000${callId}`

/** Every tool call in `events`, by `callKey`; a call id used again (scripted models) keeps its latest call. */
export function callRecords(events: readonly MyrEvent[]): Map<string, CallRecord> {
  const calls = new Map<string, CallRecord>()
  for (const e of events) {
    if (e.type === 'tool/call') {
      const p = e.payload as EventPayloads['tool/call']
      calls.set(callKey(p.agent, p.callId), {
        agent: p.agent,
        callId: p.callId,
        tool: p.tool,
        args: p.args,
        seq: e.seq,
      })
    } else if (e.type === 'tool/result') {
      const p = e.payload as EventPayloads['tool/result']
      const call = calls.get(callKey(p.agent, p.callId))
      if (call && !call.result) call.result = { ok: p.ok, output: p.output }
    }
  }
  return calls
}

/**
 * Calls the latest start of the run began that never recorded a result: still running, or running when the process
 * running the round died. Calls an earlier, since resumed, start left unfinished are that start's, not this one's.
 */
export function unfinishedCalls(events: readonly MyrEvent[]): CallRecord[] {
  const start = events.findLast((e) => e.type === 'colony/started' || e.type === 'round/started')?.seq ?? 0
  return [...callRecords(events).values()].filter((c) => c.seq > start && !c.result)
}

/** Task states that still need someone: not done, not dropped. */
const OPEN_TASK = new Set<TaskSnapshot['status']>(['pending', 'in_progress', 'submitted', 'rejected'])

/** What a run still has to do before it may complete: tasks nobody finished, and calls waiting for the person. */
export interface OpenWork {
  readonly tasks: readonly TaskSnapshot[]
  readonly approvals: readonly EventPayloads['approval/requested'][]
}

/**
 * The work still open in a run. The speaker's closing task (`task-final`, a swarm's answer) is the completion itself,
 * so it never holds completion back.
 */
export function openWork(state: Pick<ColonyState, 'tasks' | 'approvals'>): OpenWork {
  return {
    tasks: Object.values(state.tasks).filter((t) => t.id !== 'task-final' && OPEN_TASK.has(t.status)),
    approvals: Object.values(state.approvals).filter((a) => !a.decided),
  }
}

export const hasOpenWork = (work: OpenWork) => work.tasks.length > 0 || work.approvals.length > 0
