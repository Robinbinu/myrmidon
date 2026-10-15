import { LONG_FRAME_MS, PERF_LOG_KEY, PERF_LOG_TAG } from './ui-config.ts'

/**
 * A responsiveness log for chasing a slow or frozen screen, off unless turned on in the web inspector's console with
 * `localStorage.setItem('myr-perf', '1')`: how long folding the log and showing a batch of events took, how big the
 * batch and the log were, the page's memory where the engine tells it, and frames that came late.
 */
export function perfOn(): boolean {
  try {
    return localStorage.getItem(PERF_LOG_KEY) === '1'
  } catch {
    return false
  }
}

export function perfReport(what: string, data: Record<string, number>) {
  // Chromium's measure of the page's memory; WebKit has none, and the log's size stands in for it there.
  const heap = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize
  console.debug(PERF_LOG_TAG, what, heap === undefined ? data : { ...data, heapMb: Math.round(heap / 1e6) })
}

let watchers = 0
let frame = 0

/** Reports frames that came more than `LONG_FRAME_MS` after the one before, while anything watches; returns a stop. */
export function watchFrames(): () => void {
  if (watchers++ === 0) {
    let last = performance.now()
    const step = (now: number) => {
      if (now - last > LONG_FRAME_MS) perfReport('long frame', { ms: now - last })
      last = now
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    if (--watchers === 0) cancelAnimationFrame(frame)
  }
}
