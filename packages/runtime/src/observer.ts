import type { EventPayloads, SignalKind } from '@myrmidon/protocol'
import type { ColonyHost } from './host.ts'

type Signal = Omit<EventPayloads['observer/signal'], 'targets'> & { targets?: string[] }

/**
 * Factual observer: states time, budget, and coordination facts. It has no authority — it cannot
 * stop, complete, or grant anything; hard limits are enforced by the colony runner.
 */
export class FactualObserver {
  private readonly _fired = new Set<string>()
  private _lastProgressSeq = 0
  private _lastToolCalls = 0
  private _quietTicks = 0

  constructor(private readonly host: ColonyHost) {}

  /** Returns the signals worth sending now. Each threshold fires once. */
  tick(now = Date.now()): Signal[] {
    const s = this.host.state()
    if (s.status !== 'running') return []
    const out: Signal[] = []
    const total = s.budget.wallMs
    const left = Math.max(0, this.host.deadline() - now)
    const elapsedFraction = total > 0 ? 1 - left / total : 0
    for (const [mark, severity] of [
      [0.5, 'info'],
      [0.8, 'warn'],
      [0.95, 'critical'],
    ] as const) {
      if (elapsedFraction >= mark && this._once(`deadline-${mark}`)) {
        out.push({
          kind: 'deadline',
          severity,
          facts: `${Math.round(left / 1000)}s of ${Math.round(total / 1000)}s remain. ${this._taskFacts()}`,
        })
      }
    }
    if (s.budget.costUsd !== undefined) {
      const spent = Object.values(s.agents).reduce((n, a) => n + a.cost, 0)
      if (spent >= 0.8 * s.budget.costUsd && this._once('budget-0.8')) {
        out.push({
          kind: 'budget',
          severity: 'warn',
          facts: `$${spent.toFixed(3)} of $${s.budget.costUsd} spent.`,
        })
      }
    }
    const progress = Math.max(
      0,
      ...s.board.map((b) => b.seq),
      ...s.verdicts.map((v) => v.seq),
      ...Object.values(s.artifacts).flatMap((v) => v.map((x) => x.seq)),
    )
    // An agent deep in research or a long build is working even before it posts or publishes anything.
    const toolCalls = Object.values(s.agents).reduce((n, a) => n + a.toolCalls, 0)
    if (progress === this._lastProgressSeq && toolCalls === this._lastToolCalls) this._quietTicks += 1
    else {
      this._quietTicks = 0
      this._lastProgressSeq = progress
      this._lastToolCalls = toolCalls
    }
    const unclaimed = Object.values(s.tasks).filter(
      (t) =>
        (t.status === 'pending' || t.status === 'rejected') &&
        t.blockedBy.every((b) => s.tasks[b]?.status === 'verified'),
    )
    const idle = Object.values(s.agents).filter((a) => a.status === 'idle')
    if (unclaimed.length > 0 && idle.length > 0) {
      out.push(
        this._signal(
          'unclaimed',
          'info',
          `Ready but unclaimed: ${unclaimed.map((t) => `${t.id} (${t.subject})`).join(', ')}.`,
          idle.map((a) => a.info.name),
        ),
      )
    }
    if (this._quietTicks >= 2) {
      this._quietTicks = 0
      out.push(
        this._signal(
          'stall',
          'warn',
          `No tool calls, board posts, artifact versions, or verdicts for two observer intervals. ${this._taskFacts()}`,
        ),
      )
    }
    return out
  }

  private _signal(kind: SignalKind, severity: Signal['severity'], facts: string, targets?: string[]): Signal {
    return { kind, severity, facts, ...(targets ? { targets } : {}) }
  }

  private _once(key: string) {
    if (this._fired.has(key)) return false
    this._fired.add(key)
    return true
  }

  private _taskFacts() {
    const tasks = Object.values(this.host.state().tasks)
    const by = (st: string) => tasks.filter((t) => t.status === st).length
    return `Tasks: ${by('verified')} verified, ${by('submitted')} submitted, ${by('in_progress')} in progress, ${by('pending')} pending, ${by('rejected')} rejected.`
  }
}
