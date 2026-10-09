/**
 * Holds an action back for `ms` so it can be taken back, as a mail app's Undo Send: it runs only once the time is up,
 * so a window closed meanwhile never runs it. Returns the undo, which says whether it was still in time.
 */
export function holdBack(run: () => void, ms: number): () => boolean {
  let ran = false
  const timer = setTimeout(() => {
    ran = true
    run()
  }, ms)
  return () => {
    if (ran) return false
    clearTimeout(timer)
    ran = true
    return true
  }
}
