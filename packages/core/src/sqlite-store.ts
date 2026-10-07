import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ActorKind, ColonyId, EventId, MyrEvent } from '@myrmidon/protocol'
import { MyrError } from './errors.ts'
import { colonyId as toColonyId } from './ids.ts'
import type { LogStore, PreparedEvent, ReadRange } from './store.ts'

const SCHEMA = `
create table if not exists events (
  seq integer primary key,
  id text not null unique,
  time text not null,
  type text not null,
  actor_kind text not null,
  actor_id text not null,
  caused_by text,
  trace_id text not null,
  span_id text not null,
  parent_span_id text,
  schema integer not null,
  payload text not null
);
create index if not exists events_type on events(type);
create trigger if not exists events_no_update before update on events
  begin select raise(abort, 'events are append-only'); end;
create trigger if not exists events_no_delete before delete on events
  begin select raise(abort, 'events are append-only'); end;
`

interface Row {
  seq: number
  id: string
  time: string
  type: string
  actor_kind: string
  actor_id: string
  caused_by: string | null
  trace_id: string
  span_id: string
  parent_span_id: string | null
  schema: number
  payload: string
}

/** One SQLite database per colony at `<home>/colonies/<id>/events.sqlite`. */
export class SqliteLogStore implements LogStore {
  private readonly _dbs = new Map<ColonyId, Database>()

  constructor(readonly home: string) {
    mkdirSync(join(home, 'colonies'), { recursive: true })
  }

  colonyDir(id: ColonyId): string {
    return join(this.home, 'colonies', id)
  }

  private _dbPath(id: ColonyId) {
    return join(this.colonyDir(id), 'events.sqlite')
  }

  private _open(id: ColonyId, create: boolean): Database {
    const cached = this._dbs.get(id)
    if (cached) return cached
    const path = this._dbPath(id)
    if (!create && !existsSync(path)) throw new MyrError('COLONY_NOT_FOUND', `no such colony: ${id}`)
    mkdirSync(this.colonyDir(id), { recursive: true })
    const db = new Database(path, { create: true })
    db.run('pragma journal_mode = wal')
    db.run('pragma busy_timeout = 5000')
    db.run('pragma synchronous = normal')
    db.run(SCHEMA)
    this._dbs.set(id, db)
    return db
  }

  async append(
    colonyId: ColonyId,
    events: readonly PreparedEvent[],
    expectedHead?: number,
  ): Promise<MyrEvent[]> {
    const db = this._open(colonyId, true)
    const insert = db.prepare(
      `insert into events (seq, id, time, type, actor_kind, actor_id, caused_by, trace_id, span_id, parent_span_id, schema, payload)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const run = db.transaction(() => {
      const head = (db.query('select coalesce(max(seq), 0) as head from events').get() as { head: number })
        .head
      if (expectedHead !== undefined && head !== expectedHead) {
        throw new MyrError('HEAD_MISMATCH', `expected head ${expectedHead}, found ${head}`)
      }
      return events.map((e, i) => {
        const seq = head + i + 1
        insert.run(
          seq,
          e.id,
          e.time,
          e.type,
          e.actor.kind,
          e.actor.id,
          e.causedBy ?? null,
          e.trace.traceId,
          e.trace.spanId,
          e.trace.parentSpanId ?? null,
          e.schema,
          JSON.stringify(e.payload),
        )
        return { ...e, colonyId, seq } as MyrEvent
      })
    })
    return run.immediate()
  }

  async read(colonyId: ColonyId, range: ReadRange = {}): Promise<MyrEvent[]> {
    const db = this._open(colonyId, false)
    const rows = db
      .query('select * from events where seq >= ? and seq <= ? order by seq limit ?')
      .all(range.from ?? 1, range.to ?? Number.MAX_SAFE_INTEGER, range.limit ?? -1) as Row[]
    return rows.map((r) => toEvent(colonyId, r))
  }

  async get(colonyId: ColonyId, id: EventId): Promise<MyrEvent | undefined> {
    const row = this._open(colonyId, false).query('select * from events where id = ?').get(id) as Row | null
    return row ? toEvent(colonyId, row) : undefined
  }

  async head(colonyId: ColonyId): Promise<number> {
    if (!(await this.exists(colonyId))) return 0
    const db = this._open(colonyId, false)
    return (db.query('select coalesce(max(seq), 0) as head from events').get() as { head: number }).head
  }

  async exists(colonyId: ColonyId): Promise<boolean> {
    return this._dbs.has(colonyId) || existsSync(this._dbPath(colonyId))
  }

  async colonies(): Promise<ColonyId[]> {
    const dir = join(this.home, 'colonies')
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'events.sqlite')))
      .map((d) => toColonyId(d.name))
      .sort()
  }

  /** Closes this store's handle on a colony so another process or call can remove it. */
  forget(colonyId: ColonyId) {
    this._dbs.get(colonyId)?.close()
    this._dbs.delete(colonyId)
  }

  /**
   * Removes a whole colony: its log, blobs, and scratch files. Events are never edited individually;
   * this is the user discarding an entire run.
   */
  deleteColony(colonyId: ColonyId) {
    this.forget(colonyId)
    rmSync(this.colonyDir(colonyId), { recursive: true, force: true })
  }

  close() {
    for (const db of this._dbs.values()) db.close()
    this._dbs.clear()
  }
}

function toEvent(colonyId: ColonyId, r: Row): MyrEvent {
  return {
    colonyId,
    seq: r.seq,
    id: r.id as EventId,
    time: r.time,
    type: r.type,
    actor: { kind: r.actor_kind as ActorKind, id: r.actor_id },
    ...(r.caused_by ? { causedBy: r.caused_by as EventId } : {}),
    trace: {
      traceId: r.trace_id,
      spanId: r.span_id,
      ...(r.parent_span_id ? { parentSpanId: r.parent_span_id } : {}),
    },
    schema: r.schema,
    payload: JSON.parse(r.payload),
  }
}
