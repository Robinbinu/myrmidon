import type { ColonyId, EventId, MyrEvent } from '@myrmidon/protocol'

/** An event after validation and redaction, before the store assigns `seq`. */
export type PreparedEvent = Omit<MyrEvent, 'seq'>

export interface ReadRange {
  /** First seq to include (default 1). */
  readonly from?: number
  /** Last seq to include. */
  readonly to?: number
  readonly limit?: number
}

/** Persistence seam (`ctx.logStore`). Async so remote stores can implement it later. */
export interface LogStore {
  /**
   * Appends atomically and assigns consecutive seq values after the current head.
   * With `expectedHead`, rejects with HEAD_MISMATCH unless the head still equals it.
   */
  append(colonyId: ColonyId, events: readonly PreparedEvent[], expectedHead?: number): Promise<MyrEvent[]>
  read(colonyId: ColonyId, range?: ReadRange): Promise<MyrEvent[]>
  get(colonyId: ColonyId, id: EventId): Promise<MyrEvent | undefined>
  head(colonyId: ColonyId): Promise<number>
  exists(colonyId: ColonyId): Promise<boolean>
  colonies(): Promise<ColonyId[]>
  close(): void
}
