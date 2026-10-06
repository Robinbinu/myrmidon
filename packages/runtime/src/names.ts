import { CALL_SIGNS, colorSlot, WORKER_PALETTE } from '@myrmidon/protocol'

export { CALL_SIGNS }

/**
 * A random call sign not in `taken`, preferring one whose colour no teammate wears yet, so every worker
 * in a colony looks different. Falls back to a numeric suffix once every sign is used.
 */
export function pickName(taken: ReadonlySet<string>): string {
  const free = CALL_SIGNS.filter((n) => !taken.has(n))
  const worn = new Set([...taken].filter((n) => n !== 'lead').map(colorSlot))
  const fresh = worn.size < WORKER_PALETTE.length ? free.filter((n) => !worn.has(colorSlot(n))) : free
  const pool = fresh.length ? fresh : free
  if (pool.length) return pool[Math.floor(Math.random() * pool.length)] as string
  for (let i = 2; ; i++) {
    const n = `${CALL_SIGNS[Math.floor(Math.random() * CALL_SIGNS.length)]}-${i}`
    if (!taken.has(n)) return n
  }
}
