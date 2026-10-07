import { hostname } from 'node:os'
import { colonyId, type EventLog } from '@myrmidon/core'
import { type EventPayloads, foldColony, SYSTEM } from '@myrmidon/protocol'
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
    const open = Object.values(state.agents).filter(
      (a) => a.status !== 'stopped' && a.status !== 'failed' && a.status !== 'completed',
    )
    await log.append(colonyId(id), [
      ...open.map((a) => ({
        type: 'agent/status',
        actor: SYSTEM,
        payload: { agent: a.info.name, status: 'stopped', detail: 'interrupted: runner process exited' },
      })),
      { type: 'colony/stopped', actor: SYSTEM, payload: { reason: 'interrupted: runner process exited' } },
    ])
    recovered.push(id)
  }
  return recovered
}
