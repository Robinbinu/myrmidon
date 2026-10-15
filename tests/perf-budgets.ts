/**
 * Time budgets for the `perf` test group (docs/verification.md, tier 5), in one place so a change to one is a reviewed
 * diff. Each is several times what the work takes on an M-series Mac with the whole suite running beside it, so a
 * budget fails on a change in how the work grows (a fold that turned quadratic, a read without its index), not on a
 * busy machine. `bun run test:perf` prints the measured time next to each budget.
 *
 * Measured on 2026-10-15 (M-series, alone): fold 12 ms, stream 400 ms, append 4.1 s, read 0.4 s, concurrent 1.8 s,
 * long session 0.1 s.
 *
 * Raise one only with the reason in the commit (new work the path must do), never to make a slow run pass.
 */

/** Events in a long chat's log: a day of work by a crew of five, about what the client loads at once (limit=20000). */
export const LONG_HISTORY_EVENTS = 20_000

export const PERF_BUDGETS_MS = {
  /** protocol: fold a LONG_HISTORY_EVENTS log into the colony's state once (the client's first render). */
  foldLongHistory: 250,
  /**
   * protocol: the client refolds the whole log on every streamed batch (use-colony.ts); 200 batches of 10 events
   * landing on a LONG_HISTORY_EVENTS log.
   */
  streamOntoLongHistory: 5_000,
  /** core: append LONG_HISTORY_EVENTS events to one colony's SQLite log in batches of 50, as rounds do. */
  appendLongHistory: 20_000,
  /** core: read a LONG_HISTORY_EVENTS log back whole, then its last page (a reconnecting client). */
  readLongHistory: 3_000,
  /** core: 20 agents' colonies appending 500 events each at the same time (one log, many writers). */
  concurrentAppends: 12_000,
  /** runtime: read and compact a 2,000-turn agent transcript (a resumed long session). */
  longSession: 1_500,
} as const

/** Runs `work` and fails the test when it took longer than `budgetMs`; logs the time under `bun run test:perf`. */
export async function withinBudget<T>(
  name: keyof typeof PERF_BUDGETS_MS,
  work: () => T | Promise<T>,
): Promise<{ result: T; ms: number; budgetMs: number }> {
  const budgetMs = PERF_BUDGETS_MS[name]
  const started = performance.now()
  const result = await work()
  const ms = Math.round(performance.now() - started)
  if (process.env.MYR_PERF_REPORT) console.log(`perf ${name}: ${ms} ms (budget ${budgetMs} ms)`)
  if (ms > budgetMs) throw new Error(`perf budget ${name}: took ${ms} ms, budget ${budgetMs} ms`)
  return { result, ms, budgetMs }
}
