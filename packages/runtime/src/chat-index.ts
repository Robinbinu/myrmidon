import { Database } from 'bun:sqlite'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { SqliteLogStore } from '@myrmidon/core'
import { type ColonyState, type ColonyStatus, foldColony } from '@myrmidon/protocol'
import { AWAITING_USER } from './colony.ts'
import { CHAT_SEARCH_LIMIT, SNIPPET_AFTER, SNIPPET_BEFORE } from './config.ts'

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
  /** The round stopped to wait for the person's answer. */
  readonly awaiting?: boolean
  readonly title?: { readonly title: string; readonly at: string }
  readonly project?: { readonly id: string; readonly name: string }
  /** On a chat's latest round: who is on its crew now, so the person can write to them (@name). */
  readonly crew?: readonly CrewMember[]
}

/** A chat with a message that matches a search, and the words around the match. */
export interface MessageHit {
  readonly chatId: string
  /** `user` for the person; otherwise the agent who wrote it. */
  readonly from: string
  readonly snippet: string
}

export interface CrewMember {
  readonly name: string
  readonly role: string
  readonly specialty?: string
}

/**
 * The chat list's index at `<home>/chat-index.sqlite`: one row per colony, holding the summaries of the chat
 * rounds it ran (or nothing, for colonies that are not chats). A row is reused while the colony's log files are unchanged, so listing
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
    // Every chat message, so chats can be found by what was said in them, not only by their titles.
    this._db.run(
      'create table if not exists messages (colony_id text not null, chat_id text not null, sender text not null, text text not null)',
    )
    this._db.run('create index if not exists messages_by_colony on messages (colony_id)')
    // The log stamp each colony's messages were indexed at.
    this._db.run(
      'create table if not exists message_stamps (colony_id text primary key, stamp text not null)',
    )
  }

  /** Every chat round, oldest colony first. `live` gives the current state of rounds that are running. */
  async rounds(live: (id: string) => ColonyState | undefined): Promise<IndexedRound[]> {
    const ids = await this.store.colonies()
    const get = this._db.query('select stamp, data from rounds where colony_id = ?')
    const put = this._db.query(
      'insert or replace into rounds (colony_id, stamp, chat_id, data) values (?, ?, ?, ?)',
    )
    const texts = this._db.query('select stamp from message_stamps where colony_id = ?')
    const out: IndexedRound[] = []
    for (const id of ids) {
      const running = live(id)
      if (running) {
        out.push(...summarize(id, running))
        continue
      }
      const stamp = this._stamp(id)
      const row = get.get(id) as { stamp: string; data: string | null } | null
      // Rows from before messages were indexed are read again once.
      const indexed = (texts.get(id) as { stamp: string } | null)?.stamp === stamp
      if (row && row.stamp === stamp && indexed) {
        // Rows written before chats ran in one colony hold a single round.
        const data = row.data ? (JSON.parse(row.data) as IndexedRound | IndexedRound[]) : []
        const list = Array.isArray(data) ? data : [data]
        // Rows from before the crew was indexed are read again once.
        if (list.length === 0 || list.at(-1)?.crew) {
          out.push(...list)
          continue
        }
      }
      const state = foldColony(id, await this.store.read(id))
      const rounds = summarize(id, state)
      this._db.transaction(() => {
        put.run(id, stamp, rounds[0]?.chatId ?? null, rounds.length ? JSON.stringify(rounds) : null)
        this._putMessages(id, stamp, state)
      })()
      out.push(...rounds)
    }
    this._prune(new Set<string>(ids))
    return out
  }

  /**
   * Chats with a message containing `text`, ignoring case (of ASCII letters, as SQLite's `like` does), with the
   * first such message of each; the most recently active chats first. Running rounds are searched as they are now.
   */
  async search(text: string, live: (id: string) => ColonyState | undefined): Promise<MessageHit[]> {
    const needle = text.trim()
    if (!needle) return []
    const rounds = await this.rounds(live)
    const active = new Map<string, string>()
    for (const r of rounds)
      if ((r.createdAt ?? '') > (active.get(r.chatId) ?? '')) active.set(r.chatId, r.createdAt ?? '')
    const hits = new Map<string, MessageHit>()
    const lower = needle.toLowerCase()
    const running = new Set(rounds.map((r) => r.colonyId).filter((id) => live(id)))
    for (const id of running) {
      const s = live(id)
      const chatId = s?.chat?.chatId
      const m = s?.chatMessages.find((x) => x.text.toLowerCase().includes(lower))
      if (chatId && m && !hits.has(chatId))
        hits.set(chatId, { chatId, from: m.from, snippet: snippet(m.text, needle) })
    }
    const rows = this._db
      .query(
        "select colony_id, chat_id, sender, text from messages where text like ? escape '\\' order by rowid",
      )
      .all(`%${needle.replace(/[\\%_]/g, '\\$&')}%`) as {
      colony_id: string
      chat_id: string
      sender: string
      text: string
    }[]
    for (const r of rows) {
      // A running round's rows are as old as its last listing before it started; its live state was searched above.
      if (running.has(r.colony_id) || hits.has(r.chat_id) || !active.has(r.chat_id)) continue
      hits.set(r.chat_id, { chatId: r.chat_id, from: r.sender, snippet: snippet(r.text, needle) })
    }
    return [...hits.values()]
      .sort((a, b) => (active.get(b.chatId) ?? '').localeCompare(active.get(a.chatId) ?? ''))
      .slice(0, CHAT_SEARCH_LIMIT)
  }

  /** Drops a colony's rows, e.g. after the colony is deleted. */
  forget(id: string) {
    this._db.query('delete from rounds where colony_id = ?').run(id)
    this._db.query('delete from messages where colony_id = ?').run(id)
    this._db.query('delete from message_stamps where colony_id = ?').run(id)
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

  private _putMessages(id: string, stamp: string, s: ColonyState) {
    this._db.query('delete from messages where colony_id = ?').run(id)
    const chatId = s.chat?.chatId
    if (chatId) {
      const add = this._db.query(
        'insert into messages (colony_id, chat_id, sender, text) values (?, ?, ?, ?)',
      )
      for (const m of s.chatMessages) add.run(id, chatId, m.from, m.text)
    }
    this._db.query('insert or replace into message_stamps (colony_id, stamp) values (?, ?)').run(id, stamp)
  }

  private _prune(present: Set<string>) {
    const rows = this._db.query('select colony_id from rounds').all() as { colony_id: string }[]
    for (const r of rows) if (!present.has(r.colony_id)) this.forget(r.colony_id)
  }
}

/** The match and the words around it, on one line. */
function snippet(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = flat.toLowerCase().indexOf(needle.toLowerCase())
  // The needle can span a line break the flattening turned into a space.
  if (at < 0) return flat.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER)
  const start = Math.max(0, at - SNIPPET_BEFORE)
  const end = Math.min(flat.length, at + needle.length + SNIPPET_AFTER)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

function summarize(colonyId: string, s: ColonyState): IndexedRound[] {
  const chat = s.chat
  if (!chat) return []
  const title = s.chatTitle
  const last = s.rounds.at(-1)
  return s.rounds.map((r) => ({
    colonyId,
    chatId: chat.chatId,
    round: r.round,
    request: r.request,
    status: r.status,
    name: s.name,
    createdAt: r.startedAt,
    ...(r.endedAt ? { endedAt: r.endedAt } : {}),
    swarm: r.swarm,
    ...(r === last && s.status === 'stopped' && s.statusReason === AWAITING_USER ? { awaiting: true } : {}),
    ...(title ? { title: { title: title.title, at: title.at } } : {}),
    ...(r === last
      ? {
          crew: Object.values(s.agents)
            .filter((a) => !a.dismissed && a.status !== 'failed')
            .map((a) => ({
              name: a.info.name,
              role: a.info.role,
              ...(a.info.specialty ? { specialty: a.info.specialty } : {}),
            })),
        }
      : {}),
    ...(chat.project ? { project: { id: chat.project.id, name: chat.project.name } } : {}),
  }))
}
