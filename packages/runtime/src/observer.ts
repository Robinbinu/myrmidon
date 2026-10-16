import type { EventPayloads, SignalKind } from '@myrmidon/protocol'
import type { ColonyHost } from './host.ts'
import { prompts } from './prompts.ts'

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
          facts: prompts.observer.deadline(
            Math.round(left / 1000),
            Math.round(total / 1000),
            this._taskFacts(),
          ),
        })
      }
    }
    if (s.budget.costUsd !== undefined) {
      const spent = this.host.spent().cost
      if (spent >= 0.8 * s.budget.costUsd && this._once('budget-0.8')) {
        out.push({
          kind: 'budget',
          severity: 'warn',
          facts: prompts.observer.cost(spent.toFixed(3), s.budget.costUsd),
        })
      }
    }
    if (s.budget.tokens !== undefined) {
      const used = this.host.spent().tokens
      if (used >= 0.8 * s.budget.tokens && this._once('tokens-0.8')) {
        out.push({
          kind: 'budget',
          severity: 'warn',
          facts: prompts.observer.tokens(
            used.toLocaleString('en-US'),
            s.budget.tokens.toLocaleString('en-US'),
          ),
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
    // A task meant for someone nudges only them: waking the rest (a company's later stages) costs turns for nothing.
    const open = unclaimed.some((t) => !t.assignee)
    const meant = new Set(unclaimed.flatMap((t) => (t.assignee ? [t.assignee] : [])))
    const idle = Object.values(s.agents).filter(
      (a) => a.status === 'idle' && (open || meant.has(a.info.name)),
    )
    if (unclaimed.length > 0 && idle.length > 0) {
      out.push(
        this._signal(
          'unclaimed',
          'info',
          prompts.observer.unclaimed(unclaimed.map((t) => `${t.id} (${t.subject})`).join(', ')),
          idle.map((a) => a.info.name),
        ),
      )
    }
    if (this._quietTicks >= 2) {
      this._quietTicks = 0
      out.push(this._signal('stall', 'warn', prompts.observer.stall(this._taskFacts())))
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
    return prompts.observer.tasks({
      verified: by('verified'),
      submitted: by('submitted'),
      inProgress: by('in_progress'),
      pending: by('pending'),
      rejected: by('rejected'),
    })
  }
}
