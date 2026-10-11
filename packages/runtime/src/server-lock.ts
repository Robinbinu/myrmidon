import { join } from 'node:path'
import { FileLock } from './omp/natives.ts'

/** Kept for the life of the process, by home: a lock is let go when its handle is collected. */
const held = new Map<string, FileLock>()

/**
 * Claims `home` for this process's server until it exits (crashes and kills included: the OS lets go of the lock).
 * False when another process has it. Two servers on one home would share its stores and chat logs, each with its own
 * copy in memory, and the first to stop would remove the server.json the other wrote, leaving it unfindable.
 */
export function claimServerHome(home: string): boolean {
  const path = join(home, 'server.lock')
  if (held.get(path)?.acquired) return true
  const lock = FileLock.tryAcquire(path)
  if (!lock.acquired) return false
  held.set(path, lock)
  return true
}
