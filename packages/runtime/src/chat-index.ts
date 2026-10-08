import { Database } from 'bun:sqlite'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { SqliteLogStore } from '@myrmidon/core'
import { type ColonyState, type ColonyStatus, foldColony, stopCause } from '@myrmidon/protocol'
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
  /** On a chat's latest round: whether it stopped because a model failed. */
  readonly failed?: boolean
  readonly title?: { readonly title: string; readonly at: string; readonly by?: 'auto' }
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
  /** Where the match is in `snippet` (UTF-16 offsets, end exclusive), for highlighting it. */
  readonly match?: { readonly start: number; readonly end: number }
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
    // Every chat message, so chats can be found by what was said in them, not only by their titles. `folded` is the
    // text lower-cased the way JavaScript does it (SQLite's lower() and like fold ASCII only), so stored and running
    // rounds match alike.
    this._db.run(
      'create table if not exists chat_messages (colony_id text not null, chat_id text not null, sender text not null, at text not null, text text not null, folded text not null)',
    )
    this._db.run('create index if not exists chat_messages_by_colony on chat_messages (colony_id)')
    // The log stamp each colony's messages were indexed at.
    this._db.run(
      'create table if not exists chat_message_stamps (colony_id text primary key, stamp text not null)',
    )
  }

  /** Every chat round, oldest colony first. `live` gives the current state of rounds that are running. */
  async rounds(live: (id: string) => ColonyState | undefined): Promise<IndexedRound[]> {
    const ids = await this.store.colonies()
    const get = this._db.query('select stamp, data from rounds where colony_id = ?')
    const put = this._db.query(
      'insert or replace into rounds (colony_id, stamp, chat_id, data) values (?, ?, ?, ?)',
    )
    const texts = this._db.query('select stamp from chat_message_stamps where colony_id = ?')
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
        // Rows from before the crew and model failures were indexed are read again once.
        if (list.length === 0 || (list.at(-1)?.crew && list.at(-1)?.failed !== undefined)) {
          out.push(...list)
          continue
        }
      }
      const state = foldColony(id, await this.store.read(id))
      const rounds = summarize(id, state)
      this._db.transaction(() => {
        put.run(id, stamp, rounds[0]?.chatId ?? null, rounds.length ? JSON.stringify(rounds) : null)
        this._putMessages(id, state)
        this._db
          .query('insert or replace into chat_message_stamps (colony_id, stamp) values (?, ?)')
          .run(id, stamp)
      })()
      out.push(...rounds)
    }
    this._prune(new Set<string>(ids))
    return out
  }

  /**
   * Chats with a message containing `text`, ignoring case, with the latest such message of each; running rounds
   * (`live`) as they are now, then the rest most recent first. Reads the index as the last listing left it: a round
   * leaves it current when it ends (see `noteMessages`), so nothing is re-read here.
   */
  search(text: string, live: readonly ColonyState[]): MessageHit[] {
    const needle = text.trim().toLowerCase()
    if (!needle) return []
    const hits: MessageHit[] = []
    for (const s of live) {
      const m = s.chatMessages.findLast((x) => x.text.toLowerCase().includes(needle))
      if (s.chat && m) hits.push({ chatId: s.chat.chatId, from: m.from, ...snippet(m.text, needle) })
    }
    // A running round's rows are as old as its last indexing; its live state was searched above.
    const rows = this._db
      .query(
        `select chat_id, sender, text from chat_messages where rowid in (
          select max(rowid) from chat_messages
          where instr(folded, ?) > 0
            and colony_id not in (select value from json_each(?)) and chat_id not in (select value from json_each(?))
          group by chat_id
        ) order by at desc limit ?`,
      )
      .all(
        needle,
        JSON.stringify(live.map((s) => s.id)),
        JSON.stringify(hits.map((h) => h.chatId)),
        CHAT_SEARCH_LIMIT,
      ) as {
      chat_id: string
      sender: string
      text: string
    }[]
    for (const r of rows) hits.push({ chatId: r.chat_id, from: r.sender, ...snippet(r.text, needle) })
    return hits.slice(0, CHAT_SEARCH_LIMIT)
  }

  /** Indexes a round's messages as it ended, so search finds them before the next listing reads its log. */
  noteMessages(id: string, state: ColonyState) {
    this._db.transaction(() => this._putMessages(id, state))()
  }

  /** Drops a colony's rows, e.g. after the colony is deleted. */
  forget(id: string) {
    this._db.transaction(() => {
      this._db.query('delete from rounds where colony_id = ?').run(id)
      this._db.query('delete from chat_messages where colony_id = ?').run(id)
      this._db.query('delete from chat_message_stamps where colony_id = ?').run(id)
    })()
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

  private _putMessages(id: string, s: ColonyState) {
    this._db.query('delete from chat_messages where colony_id = ?').run(id)
    const chatId = s.chat?.chatId
    if (!chatId) return
    const add = this._db.query(
      'insert into chat_messages (colony_id, chat_id, sender, at, text, folded) values (?, ?, ?, ?, ?, ?)',
    )
    for (const m of s.chatMessages) add.run(id, chatId, m.from, m.time, m.text, m.text.toLowerCase())
  }

  private _prune(present: Set<string>) {
    const rows = this._db
      .query('select colony_id from rounds union select colony_id from chat_messages')
      .all() as { colony_id: string }[]
    for (const r of rows) if (!present.has(r.colony_id)) this.forget(r.colony_id)
  }
}

/**
 * The match and the words around it, on one line, and where the match is in it. Works on code points, lower-casing
 * each on its own, so a character whose lower case is longer (İ) or a surrogate pair is never cut.
 */
function snippet(text: string, needle: string): Pick<MessageHit, 'snippet' | 'match'> {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  // Where each character's lower case starts in the lower-cased text.
  const starts: number[] = []
  let folded = ''
  for (const c of chars) {
    starts.push(folded.length)
    folded += c.toLowerCase()
  }
  const at = folded.indexOf(needle)
  // The needle can span a line break the flattening turned into a space.
  if (at < 0) return { snippet: chars.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER).join('') }
  const first = starts.findLastIndex((n) => n <= at)
  const after = starts.findIndex((n) => n >= at + needle.length)
  const last = after < 0 ? chars.length : after
  const from = Math.max(0, first - SNIPPET_BEFORE)
  const to = Math.min(chars.length, last + SNIPPET_AFTER)
  const lead = `${from > 0 ? '…' : ''}${chars.slice(from, first).join('')}`
  const hit = chars.slice(first, last).join('')
  return {
    snippet: `${lead}${hit}${chars.slice(last, to).join('')}${to < chars.length ? '…' : ''}`,
    match: { start: lead.length, end: lead.length + hit.length },
  }
}

function summarize(colonyId: string, s: ColonyState): IndexedRound[] {
  const chat = s.chat
  if (!chat) return []
  const title = s.chatTitle
  const last = s.rounds.at(-1)
  const cause = stopCause(s)
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
    ...(r === last && cause.awaiting ? { awaiting: true } : {}),
    ...(title ? { title: { title: title.title, at: title.at, ...(title.by ? { by: title.by } : {}) } } : {}),
    ...(r === last
      ? {
          failed: !!cause.failed,
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
