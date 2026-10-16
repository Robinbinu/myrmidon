import { colonyWallMs } from '@myrmidon/protocol'
import { useEffect, useState } from 'react'
import { COLONY_CLOCK_MS } from './ui-config.ts'

/**
 * A run's elapsed time that keeps moving between events. The log only changes when something happens, so a time
 * worked out at render stands still while a model thinks; while the run has started and not ended this ticks on its
 * own, re-rendering only the component that reads it, and stops when the run ends.
 */
export function useRunClock(run: { createdAt?: string; endedAt?: string }): number {
  const running = run.createdAt !== undefined && run.endedAt === undefined
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), COLONY_CLOCK_MS)
    return () => clearInterval(timer)
  }, [running])
  return colonyWallMs(run, now)
}
