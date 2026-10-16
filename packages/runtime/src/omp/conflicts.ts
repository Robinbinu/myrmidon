/**
 * omp's merge-conflict pieces behind its `conflict://` paths (tools/conflict-detect.ts): finding marker blocks in read
 * lines, the per-session registry that numbers them, parsing `conflict://N[/side]`, the @ours/@theirs/@base/@both
 * tokens, the splice that replaces one block, and the footer a read shows.
 */

/** Loaded on first use, like the github pieces: most reads never meet a conflict. */
export function loadConflicts() {
  return import('@oh-my-pi/pi-coding-agent/tools/conflict-detect')
}
export type Conflicts = Awaited<ReturnType<typeof loadConflicts>>
export type ConflictHistory = InstanceType<Conflicts['ConflictHistory']>
export type ConflictEntry = ReturnType<ConflictHistory['register']>
