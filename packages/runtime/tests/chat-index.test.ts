import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteLogStore } from '@myrmidon/core'
import { type ColonyState, foldColony } from '@myrmidon/protocol'
import { ChatIndex } from '../src/chat-index.ts'

let home: string
let index: ChatIndex | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'myr-chat-index-'))
})

afterEach(() => {
  index?.close()
  index = undefined
  rmSync(home, { recursive: true, force: true })
})

/** A chat round's state holding just these messages, which is all the index reads from it, one a day from `day`. */
function round(
  colonyId: string,
  chatId: string,
  texts: readonly [from: string, text: string][],
  day = 1,
): ColonyState {
  return {
    ...foldColony(colonyId, []),
    chat: { chatId, round: 1, request: texts[0]?.[1] ?? '' },
    chatMessages: texts.map(([from, text], i) => ({
      seq: i + 1,
      id: `${colonyId}-${i}` as never,
      time: new Date(Date.UTC(2026, 9, day + i)).toISOString(),
      from,
      text,
      final: false,
    })),
  }
}

const open = () => {
  index = new ChatIndex(home, new SqliteLogStore(home))
  return index
}

/** A second connection to the index file, to look at or tamper with what the index keeps. */
const raw = () => new Database(join(home, 'chat-index.sqlite'))

/** Throws unless the trigram index holds exactly the messages table's text. */
function consistent() {
  const db = raw()
  db.run("insert into chat_messages_fts (chat_messages_fts, rank) values ('integrity-check', 1)")
  db.close()
}

test('bun:sqlite has FTS5 with the trigram tokenizer', () => {
  const db = new Database(':memory:')
  db.run("create virtual table t using fts5(x, tokenize='trigram case_sensitive 1')")
  db.run("insert into t values ('the total is 391 units')")
  expect(db.query('select count(*) n from t where t match ?').get('"391 u"')).toEqual({ n: 1 })
  db.close()
})

test('a needle of three or more characters is found through the trigram index', () => {
  const chats = open()
  chats.noteMessages(
    'col-a',
    round('col-a', 'chat-a', [
      ['user', 'Add up the INVOICES'],
      ['lead', 'Total: 391 units'],
    ]),
  )
  expect(chats.search('391', [])).toEqual([
    { chatId: 'chat-a', from: 'lead', snippet: 'Total: 391 units', match: { start: 7, end: 10 } },
  ])
  // With the message's index entry gone, a long needle no longer finds it: the search used the index, not a scan.
  const db = raw()
  const row = db.query("select rowid, folded from chat_messages where sender = 'lead'").get() as {
    rowid: number
    folded: string
  }
  db.query("insert into chat_messages_fts (chat_messages_fts, rowid, folded) values ('delete', ?, ?)").run(
    row.rowid,
    row.folded,
  )
  db.close()
  expect(chats.search('391', [])).toEqual([])
  expect(chats.search('invoices', [])[0]).toMatchObject({ chatId: 'chat-a', from: 'user' })
})

test('a needle under three characters is found by scanning the messages', () => {
  const chats = open()
  chats.noteMessages('col-a', round('col-a', 'chat-a', [['lead', 'Total: 391 units']]))
  chats.noteMessages('col-b', round('col-b', 'chat-b', [['lead', 'Nothing here']]))
  // Trigrams cannot match these; emptying the index shows they never needed it.
  const db = raw()
  db.run("insert into chat_messages_fts (chat_messages_fts) values ('delete-all')")
  db.close()
  expect(chats.search('39', []).map((h) => h.chatId)).toEqual(['chat-a'])
  expect(chats.search('9', []).map((h) => h.chatId)).toEqual(['chat-a'])
  // Two code points that are three UTF-16 units still count as two characters.
  chats.noteMessages('col-c', round('col-c', 'chat-c', [['lead', 'ok 😀!']]))
  expect(chats.search('😀!', []).map((h) => h.chatId)).toEqual(['chat-c'])
})

test('messages indexed after startup are searchable, and deleted ones are not', () => {
  const chats = open()
  expect(chats.search('ledger', [])).toEqual([])
  chats.noteMessages('col-a', round('col-a', 'chat-a', [['lead', 'Checked the ledger']]))
  expect(chats.search('ledger', []).map((h) => h.chatId)).toEqual(['chat-a'])
  // Re-indexing a round replaces its messages in the trigram index too.
  chats.noteMessages('col-a', round('col-a', 'chat-a', [['lead', 'Checked the books']]))
  expect(chats.search('ledger', [])).toEqual([])
  expect(chats.search('books', []).map((h) => h.chatId)).toEqual(['chat-a'])
  chats.forget('col-a')
  expect(chats.search('books', [])).toEqual([])
  consistent()
})

test('an index from before the trigram index existed is filled from its messages when opened', () => {
  // The index file as an older version left it: messages, and no trigram index.
  const db = raw()
  db.run(
    'create table chat_messages (colony_id text not null, chat_id text not null, sender text not null, at text not null, text text not null, folded text not null)',
  )
  const add = db.query(
    'insert into chat_messages (colony_id, chat_id, sender, at, text, folded) values (?, ?, ?, ?, ?, ?)',
  )
  add.run('col-a', 'chat-a', 'user', '2026-10-01T00:00:00.000Z', 'Book the École trip', 'book the école trip')
  add.run('col-b', 'chat-b', 'lead', '2026-10-02T00:00:00.000Z', 'Booked it', 'booked it')
  db.close()

  const chats = open()
  // Most recent first, as the scan ordered them.
  expect(chats.search('book', []).map((h) => h.chatId)).toEqual(['chat-b', 'chat-a'])
  expect(chats.search('ÉCOLE', [])[0]).toMatchObject({ chatId: 'chat-a', from: 'user' })
  const check = raw()
  expect(
    check.query('select count(*) n from chat_messages_fts where chat_messages_fts match \'"book"\'').get(),
  ).toEqual({ n: 2 })
  check.close()
  chats.close()
  index = undefined
  const again = open()
  again.noteMessages('col-c', round('col-c', 'chat-c', [['lead', 'Booking confirmed']], 3))
  expect(again.search('book', []).map((h) => h.chatId)).toEqual(['chat-c', 'chat-b', 'chat-a'])
  consistent()
})
