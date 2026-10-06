/** Short, distinct call signs for worker agents, so a colony reads like a crew rather than `worker-3`. */
export const CALL_SIGNS = [
  'nova',
  'kai',
  'juno',
  'orion',
  'vega',
  'atlas',
  'lyra',
  'echo',
  'sol',
  'iris',
  'rho',
  'zephyr',
  'mira',
  'onyx',
  'pax',
  'quill',
  'rune',
  'sage',
  'tess',
  'ursa',
  'wren',
  'xeno',
  'yuki',
  'zara',
  'ada',
  'bix',
  'cleo',
  'dax',
  'ember',
  'flux',
  'gaia',
  'hex',
  'ion',
  'jett',
  'koda',
  'luma',
] as const

/** A random call sign not in `taken`, with a numeric suffix once every sign is used. */
export function pickName(taken: ReadonlySet<string>): string {
  const free = CALL_SIGNS.filter((n) => !taken.has(n))
  if (free.length) return free[Math.floor(Math.random() * free.length)] as string
  for (let i = 2; ; i++) {
    const n = `${CALL_SIGNS[Math.floor(Math.random() * CALL_SIGNS.length)]}-${i}`
    if (!taken.has(n)) return n
  }
}
