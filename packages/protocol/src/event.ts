declare const brand: unique symbol

export type ColonyId = string & { readonly [brand]: 'ColonyId' }
export type EventId = string & { readonly [brand]: 'EventId' }

export type ActorKind = 'agent' | 'observer' | 'verifier' | 'user' | 'system'

export interface ActorRef {
  readonly kind: ActorKind
  readonly id: string
}

export interface TraceRef {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
}

/** One durable fact. `seq` is gap-free per colony and is the only ordering key. */
export interface MyrEvent<T extends string = string, P = unknown> {
  readonly colonyId: ColonyId
  readonly seq: number
  readonly id: EventId
  readonly time: string
  readonly type: T
  readonly actor: ActorRef
  readonly causedBy?: EventId
  readonly trace: TraceRef
  readonly schema: number
  readonly payload: P
}

/** What callers hand to the log; the log assigns id, time, schema, trace, and seq. */
export interface EventDraft<T extends string = string, P = unknown> {
  readonly type: T
  readonly actor: ActorRef
  readonly payload: P
  readonly causedBy?: EventId
  readonly trace?: Partial<TraceRef>
}

export const SYSTEM: ActorRef = { kind: 'system', id: 'myrmidon' }
