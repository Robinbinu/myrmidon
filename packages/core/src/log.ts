import { type Context, Service } from '@deepseek-ai/cordis'
import type { ColonyId, EventDraft, EventId, MyrEvent } from '@myrmidon/protocol'
import { completionGuard, CORE_EVENT_TYPES, type Guard } from './guards.ts'
import { newEventId, newSpanId, newTraceId } from './ids.ts'
import { Redactor } from './redact.ts'
import { type EventTypeDefinition, EventTypeRegistry } from './registry.ts'
import type { LogStore, PreparedEvent, ReadRange } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    log: EventLog
    logStore: LogStore
  }
  interface Events {
    'log/appended'(colonyId: ColonyId, events: readonly MyrEvent[]): void
  }
}

export interface AppendOptions {
  readonly expectedHead?: number
}

/**
 * `ctx.log`: the append-only event log. Validation, redaction, and invariant guards live here so
 * they apply to every store provider; there is deliberately no update or delete operation.
 */
export class EventLog extends Service {
  static inject = ['logStore']

  readonly registry = new EventTypeRegistry()
  readonly redactor = new Redactor()
  private readonly _guards = new Set<Guard>()
  private readonly _queues = new Map<ColonyId, Promise<unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'log')
    for (const def of CORE_EVENT_TYPES) this.registry.register(def)
  }

  get store(): LogStore {
    return this.ctx.logStore
  }

  /** Returns a disposer; call inside `ctx.effect()` so it unwinds with the caller. */
  registerType(def: EventTypeDefinition): () => void {
    return this.registry.register(def)
  }

  /** Extra guards may add checks; the built-in guards always run first. */
  registerGuard(guard: Guard): () => void {
    this._guards.add(guard)
    return () => this._guards.delete(guard)
  }

  registerSecret(value: string): () => void {
    return this.redactor.addSecret(value)
  }

  append(colonyId: ColonyId, drafts: readonly EventDraft[], options: AppendOptions = {}): Promise<MyrEvent[]> {
    return this._serialize(colonyId, async () => {
      const prepared: PreparedEvent[] = []
      for (const draft of drafts) {
        const { version, payload } = await this.registry.validate(draft.type, draft.actor, draft.payload)
        const event: PreparedEvent = {
          colonyId,
          id: newEventId(),
          time: new Date().toISOString(),
          type: draft.type,
          actor: draft.actor,
          ...(draft.causedBy ? { causedBy: draft.causedBy } : {}),
          trace: {
            traceId: draft.trace?.traceId ?? newTraceId(),
            spanId: draft.trace?.spanId ?? newSpanId(),
            ...(draft.trace?.parentSpanId ? { parentSpanId: draft.trace.parentSpanId } : {}),
          },
          schema: version,
          payload: this.redactor.redact(payload),
        }
        const guardCtx = { colonyId, event, pending: prepared, store: this.store }
        await completionGuard(guardCtx)
        for (const guard of this._guards) await guard(guardCtx)
        prepared.push(event)
      }
      if (prepared.length === 0) return []
      const committed = await this.store.append(colonyId, prepared, options.expectedHead)
      this.ctx.emit('log/appended', colonyId, committed)
      return committed
    })
  }

  async appendOne(colonyId: ColonyId, draft: EventDraft): Promise<MyrEvent> {
    const [event] = await this.append(colonyId, [draft])
    return event as MyrEvent
  }

  async read(colonyId: ColonyId, range?: ReadRange): Promise<MyrEvent[]> {
    const events = await this.store.read(colonyId, range)
    return events.map((e) => this.registry.upgrade(e))
  }

  async get(colonyId: ColonyId, id: EventId): Promise<MyrEvent | undefined> {
    const event = await this.store.get(colonyId, id)
    return event && this.registry.upgrade(event)
  }

  head(colonyId: ColonyId) {
    return this.store.head(colonyId)
  }

  colonies() {
    return this.store.colonies()
  }

  _serialize<T>(colonyId: ColonyId, task: () => Promise<T>): Promise<T> {
    const previous = this._queues.get(colonyId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this._queues.set(
      colonyId,
      next.catch(() => {}),
    )
    return next
  }
}
