import { Database } from 'bun:sqlite'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { SqliteLogStore } from '@myrmidon/core'
import { type ColonyState, type ColonyStatus, foldColony } from '@myrmidon/protocol'

/** What the chat list needs from one round, without the round's full log. */
export interface IndexedRound {
  readonly colonyId: string
  readonly chatId: string
  readonly round: number
  readonly request: string
  readonly status: ColonyStatus
  readonly name: string
  readonly createdAt?: string
  readonly endedAt?: string
  readonly swarm: boolean
  readonly title?: { readonly title: string; readonly at: string }
  readonly project?: { readonly id: string; readonly name: string }
}

/**
 * The chat list's index at `<home>/chat-index.sqlite`: one row per colony, holding its chat summary (or nothing,
 * for colonies that are not chat rounds). A row is reused while the colony's log files are unchanged, so listing
 * chats folds only the logs that grew since the last look instead of every log every time.
 */
export class ChatIndex {
  private readonly _db: Database

  constructor(
    home: string,
    private readonly store: SqliteLogStore,
  ) {
    this._db = new Database(join(home, 'chat-index.sqlite'), { create: true })
    this._db.run('pragma journal_mode = wal')
    this._db.run(
      'create table if not exists rounds (colony_id text primary key, stamp text not null, chat_id text, data text)',
    )
  }

  /** Every chat round, oldest colony first. `live` gives the current state of rounds that are running. */
  async rounds(live: (id: string) => ColonyState | undefined): Promise<IndexedRound[]> {
    const ids = await this.store.colonies()
    const get = this._db.query('select stamp, data from rounds where colony_id = ?')
    const put = this._db.query(
      'insert or replace into rounds (colony_id, stamp, chat_id, data) values (?, ?, ?, ?)',
    )
    const out: IndexedRound[] = []
    for (const id of ids) {
      const running = live(id)
      if (running) {
        const entry = summarize(id, running)
        if (entry) out.push(entry)
        continue
      }
      const stamp = this._stamp(id)
      const row = get.get(id) as { stamp: string; data: string | null } | null
      if (row && row.stamp === stamp) {
        if (row.data) out.push(JSON.parse(row.data) as IndexedRound)
        continue
      }
      const entry = summarize(id, foldColony(id, await this.store.read(id)))
      put.run(id, stamp, entry?.chatId ?? null, entry ? JSON.stringify(entry) : null)
      if (entry) out.push(entry)
    }
    this._prune(new Set<string>(ids))
    return out
  }

  /** Drops a colony's row, e.g. after the colony is deleted. */
  forget(id: string) {
    this._db.query('delete from rounds where colony_id = ?').run(id)
  }

  close() {
    this._db.close()
  }

  /** Changes whenever the colony's log is written: WAL appends grow or touch `-wal`, checkpoints touch the db. */
  private _stamp(id: string): string {
    const base = join(this.store.colonyDir(id as never), 'events.sqlite')
    return [base, `${base}-wal`]
      .map((p) => {
        try {
          const s = statSync(p)
          return `${s.size}:${s.mtimeMs}`
        } catch {
          return '-'
        }
      })
      .join('|')
  }

  private _prune(present: Set<string>) {
    const rows = this._db.query('select colony_id from rounds').all() as { colony_id: string }[]
    for (const r of rows) if (!present.has(r.colony_id)) this.forget(r.colony_id)
  }
}

function summarize(colonyId: string, s: ColonyState): IndexedRound | undefined {
  if (!s.chat) return undefined
  const title = s.chatTitle
  return {
    colonyId,
    chatId: s.chat.chatId,
    round: s.chat.round,
    request: s.chat.request,
    status: s.status,
    name: s.name,
    ...(s.createdAt ? { createdAt: s.createdAt } : {}),
    ...(s.endedAt ? { endedAt: s.endedAt } : {}),
    swarm: s.team?.mode === 'swarm',
    ...(title ? { title: { title: title.title, at: title.at } } : {}),
    ...(s.chat.project ? { project: { id: s.chat.project.id, name: s.chat.project.name } } : {}),
  }
}
