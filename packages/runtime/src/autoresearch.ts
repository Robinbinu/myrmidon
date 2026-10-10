import type { EventPayloads, MyrEvent } from '@myrmidon/protocol'
import { parseMetricLines } from '@oh-my-pi/pi-coding-agent/autoresearch/helpers'

/**
 * Autoresearch, after omp's (pi-coding-agent/src/autoresearch): an agent improves one measured number on its own branch
 * of the project, a trial at a time. It changes the code and asks for a trial; the harness runs the measure command,
 * keeps the change (a commit on the branch) only when the number got better, and otherwise puts the files back, logging
 * every trial. Unlike omp, where the agent logs each run and chooses keep or discard itself, the harness decides from
 * the number, so a trial cannot be kept by saying so. The measure prints omp's `METRIC <name>=<value>` lines, read with
 * omp's own parser. Trials and time are bounded (config.ts AUTORESEARCH), never past the round's wall.
 *
 * The loop's state is the log: `experiment/started`, one `experiment/trial` per run (the baseline is trial 0) and
 * `experiment/finished`, so a resumed round carries on where it was.
 */

export type Direction = 'lower' | 'higher'

export interface Experiment {
  readonly agent: string
  readonly measure: string
  readonly metric: string
  readonly direction: Direction
  /** Trials allowed after the baseline. */
  readonly trials: number
  /** When the loop must stop, in epoch ms. */
  readonly until: number
  readonly branch: string
  baseline?: number
  best?: number
  /** Trials run after the baseline. */
  runs: number
  kept: number
  finished: boolean
  /** Each run as logged, the baseline first. */
  readonly log: EventPayloads['experiment/trial'][]
}

/**
 * The metric a measure run printed: the one named, or the only one when none is named. Undefined when it printed none
 * (or several, and none was named).
 */
export function metricOf(output: string, name?: string): { name: string; value: number } | undefined {
  const metrics = parseMetricLines(output)
  if (name) {
    const value = metrics.get(name)
    return value === undefined ? undefined : { name, value }
  }
  if (metrics.size !== 1) return undefined
  const [only] = [...metrics]
  return only ? { name: only[0], value: only[1] } : undefined
}

/** Whether `value` beats `best` in the experiment's direction; a tie is no better. */
export function better(value: number, best: number, direction: Direction): boolean {
  return direction === 'lower' ? value < best : value > best
}

/** An agent's latest experiment as its log tells it, or undefined when it never started one. */
export function experimentFrom(events: readonly MyrEvent[], agent: string): Experiment | undefined {
  let exp: Experiment | undefined
  for (const e of events) {
    const p = e.payload as { agent?: string }
    if (p.agent !== agent) continue
    if (e.type === 'experiment/started') {
      const s = e.payload as EventPayloads['experiment/started']
      exp = {
        agent,
        measure: s.measure,
        metric: s.metric,
        direction: s.direction,
        trials: s.trials,
        until: Date.parse(s.until),
        branch: s.branch,
        runs: 0,
        kept: 0,
        finished: false,
        log: [],
      }
    } else if (e.type === 'experiment/trial' && exp) {
      const t = e.payload as EventPayloads['experiment/trial']
      exp.log.push(t)
      if (t.outcome === 'baseline') exp.baseline = t.metric
      else exp.runs += 1
      if (t.outcome === 'kept') exp.kept += 1
      if (t.best !== undefined) exp.best = t.best
    } else if (e.type === 'experiment/finished' && exp) exp.finished = true
  }
  return exp
}
