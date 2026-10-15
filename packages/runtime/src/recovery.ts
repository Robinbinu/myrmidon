import { hostname } from 'node:os'
import { colonyId, type EventLog } from '@myrmidon/core'
import { type EventDraft, type EventPayloads, foldColony, SYSTEM } from '@myrmidon/protocol'
import { RECOVERY_GRACE_MS } from './config.ts'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Ends a run whose runner process is gone, the way its own shutdown would have: nothing of it may still look under
 * way. What it asked the person is closed as stopped (no card offers buttons that do nothing), a sign-in it waited on
 * is given up, its dev servers (stopped with the process that ran them) are logged as stopped, its agents as stopped,
 * and the run as stopped with `reason`, which offers Resume. Calls that were running stay unanswered in the log, so
 * the person and a resume can see what may have run (`unfinishedCalls`). One batch: a reader never sees half of it.
 */
export async function closeOrphan(log: EventLog, id: string, reason: string): Promise<void> {
  const state = foldColony(id, await log.read(colonyId(id)))
  const drafts: EventDraft[] = [
    ...Object.values(state.approvals)
      .filter((a) => !a.decided)
      .map((a) => ({
        type: 'approval/decided',
        actor: SYSTEM,
        payload: { id: a.id, approved: false, by: 'stopped' } satisfies EventPayloads['approval/decided'],
      })),
    ...Object.values(state.logins)
      .filter((l) => !l.finished)
      .map((l) => ({
        type: 'login/finished',
        actor: SYSTEM,
        payload: { agent: l.agent, outcome: 'stopped' } satisfies EventPayloads['login/finished'],
      })),
    ...Object.values(state.servers)
      .filter((s) => s.stopped === undefined)
      .map((s) => ({
        type: 'server/stopped',
        actor: SYSTEM,
        payload: { name: s.name, reason } satisfies EventPayloads['server/stopped'],
      })),
    ...Object.values(state.agents)
      .filter((a) => a.status !== 'stopped' && a.status !== 'failed' && a.status !== 'completed')
      .map((a) => ({
        type: 'agent/status',
        actor: SYSTEM,
        payload: {
          agent: a.info.name,
          status: 'stopped',
          detail: reason,
        } satisfies EventPayloads['agent/status'],
      })),
    { type: 'colony/stopped', actor: SYSTEM, payload: { reason } },
  ]
  await log.append(colonyId(id), drafts)
}

/** Why `recoverOrphans` stopped a run. */
export const ORPHANED = 'interrupted: runner process exited'

/**
 * Marks colonies whose runner process is gone as stopped, so they never stay "running" forever.
 * Colonies started on another host are left alone.
 */
export async function recoverOrphans(log: EventLog, now = Date.now()): Promise<string[]> {
  const recovered: string[] = []
  for (const id of await log.colonies()) {
    const events = await log.read(id)
    const state = foldColony(id, events)
    if (state.status !== 'running' && state.status !== 'created') continue
    // A resumed colony has several starts; the latest names the process running it now.
    const started = events.findLast((e) => e.type === 'colony/started')?.payload as
      | EventPayloads['colony/started']
      | undefined
    let orphaned: boolean
    if (started?.pid !== undefined && started.hostname !== undefined) {
      if (started.hostname !== hostname()) continue
      orphaned = !alive(started.pid)
    } else {
      // Runs recorded before pids were logged: orphaned once well past their wall budget.
      const created = state.createdAt ? Date.parse(state.createdAt) : 0
      orphaned = now > created + state.budget.wallMs + RECOVERY_GRACE_MS
    }
    if (!orphaned) continue
    await closeOrphan(log, id, ORPHANED)
    recovered.push(id)
  }
  return recovered
}
