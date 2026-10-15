import type { ChatIndex, RecallChat, RecallMessage } from './chat-index.ts'
import { CHAT_RECALL } from './config.ts'
import { terms } from './memory.ts'
import { prompts } from './prompts.ts'

/**
 * Agents' search of past chats (the `search_chats` tool), after Hermes's session_search: the actual messages from the
 * chat index, no model call, so it costs nothing but the tokens it returns. Four shapes, picked by what is asked: a
 * query finds the best chats (the best one with the messages either side of its hits), a chat and a message number
 * scroll around that message, a chat alone reads its head and tail, and nothing at all lists recent chats.
 *
 * Who may be read is fixed by the asking round, never by the agent: a chat in a project reads only that project's
 * chats, a chat in none only chats in none, never the asking chat itself, and never a chat someone other than the
 * person wrote in (a channel member, a share's guest). Every message and the whole result are capped.
 */

export interface ChatRecallScope {
  /** The asking chat's project; undefined for a chat in none. */
  readonly project: string | undefined
  /** The asking chat, whose own messages the agent already has. */
  readonly chatId: string
}

export interface ChatRecallRequest {
  readonly query?: string
  /** A chat id from an earlier search. */
  readonly chat?: string
  /** A message number in `chat`, to read the messages around it. */
  readonly around?: number
  readonly limit?: number
}

const clip = (text: string, max: number) => {
  const flat = text.trim()
  return flat.length > max ? `${flat.slice(0, max)}… [${flat.length - max} more chars]` : flat
}

const line = (m: RecallMessage, max: number) =>
  prompts.chatRecall.message(m.n, m.from, m.at.slice(0, 10), clip(m.text, max))

/**
 * Searches, scrolls, reads or lists the chats `scope` may read, never one in `barred` (running chats someone else
 * wrote into); the text an agent gets back.
 */
export function recallChats(
  index: ChatIndex,
  scope: ChatRecallScope,
  request: ChatRecallRequest,
  barred: ReadonlySet<string> = new Set(),
): string {
  const chats = index.recallChats(scope.project, new Set([scope.chatId, ...barred]))
  const byId = new Map(chats.map((c) => [c.chatId, c]))
  const out = request.chat
    ? readChat(index, byId.get(request.chat), request.around)
    : request.query?.trim()
      ? discover(index, chats, request.query, request.limit)
      : browse(chats)
  return out.length > CHAT_RECALL.totalChars
    ? `${out.slice(0, CHAT_RECALL.totalChars)}\n${prompts.chatRecall.cut(out.length - CHAT_RECALL.totalChars)}`
    : out
}

function browse(chats: readonly RecallChat[]): string {
  if (!chats.length) return prompts.chatRecall.none
  return prompts.chatRecall.recent(
    chats
      .slice(0, CHAT_RECALL.browse)
      .map((c) => prompts.chatRecall.chat(c.chatId, c.title, c.updatedAt.slice(0, 10), c.rounds)),
  )
}

function readChat(index: ChatIndex, chat: RecallChat | undefined, around?: number): string {
  // A chat out of scope reads exactly as one that does not exist, so a search cannot tell them apart.
  if (!chat) return prompts.chatRecall.noChat
  const thread = index.recallThread(chat.chatId)
  const head = prompts.chatRecall.chat(chat.chatId, chat.title, chat.updatedAt.slice(0, 10), chat.rounds)
  if (around !== undefined) {
    const from = Math.max(1, around - CHAT_RECALL.window)
    const shown = thread.filter((m) => m.n >= from && m.n <= around + CHAT_RECALL.window)
    if (!shown.length) return prompts.chatRecall.noMessage(around, thread.length)
    return [head, ...shown.map((m) => line(m, CHAT_RECALL.messageChars))].join('\n')
  }
  const ends =
    thread.length <= CHAT_RECALL.head + CHAT_RECALL.tail
      ? thread
      : [...thread.slice(0, CHAT_RECALL.head), ...thread.slice(-CHAT_RECALL.tail)]
  const skipped = thread.length - ends.length
  const lines = ends.map((m) => line(m, CHAT_RECALL.messageChars))
  if (skipped > 0) lines.splice(CHAT_RECALL.head, 0, prompts.chatRecall.skipped(skipped))
  return [head, ...lines].join('\n')
}

/**
 * The chats whose messages best match `query`: each message scores the rarity of the query words it holds (an
 * inverse document frequency over the matching messages), and a chat its best message plus a little for every other.
 */
function discover(index: ChatIndex, chats: readonly RecallChat[], query: string, limit?: number): string {
  const words = [...new Set(terms(query))]
  if (!words.length) return browse(chats)
  const byId = new Map(chats.map((c) => [c.chatId, c]))
  const found = index.recallMatches(
    chats.map((c) => c.chatId),
    words,
    CHAT_RECALL.scan,
  )
  if (!found.length) return prompts.chatRecall.noMatch
  const folded = found.map((m) => m.text.toLowerCase())
  const idf = new Map(
    words.map((w) => [w, Math.log(1 + found.length / (folded.filter((t) => t.includes(w)).length || 1))]),
  )
  const scored = found.map((m, i) => ({
    m,
    score: words.reduce((n, w) => n + ((folded[i] ?? '').includes(w) ? (idf.get(w) ?? 0) : 0), 0),
  }))
  const perChat = new Map<string, { score: number; hits: typeof scored }>()
  for (const s of scored) {
    const c = perChat.get(s.m.chatId) ?? { score: 0, hits: [] }
    c.hits.push(s)
    perChat.set(s.m.chatId, c)
  }
  for (const c of perChat.values()) {
    c.hits.sort((a, b) => b.score - a.score || b.m.n - a.m.n)
    c.score = (c.hits[0]?.score ?? 0) + 0.1 * (c.hits.length - 1)
  }
  const want = Math.min(CHAT_RECALL.maxChats, Math.max(1, Math.floor(limit ?? CHAT_RECALL.chats)))
  const ranked = [...perChat.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, want)
  const parts = ranked.map(([chatId, c], rank) => {
    const chat = byId.get(chatId) as RecallChat
    const head = prompts.chatRecall.chat(chat.chatId, chat.title, chat.updatedAt.slice(0, 10), chat.rounds)
    const hits = c.hits.slice(0, CHAT_RECALL.hitsPerChat).map((h) => h.m.n)
    // The best chat comes with the messages either side of its hits; the others with their best hit only.
    if (rank === 0) {
      const near = new Set(hits.flatMap((n) => [n - 1, n, n + 1]))
      const thread = index.recallThread(chatId).filter((m) => near.has(m.n))
      return [head, ...thread.map((m) => line(m, CHAT_RECALL.hitChars))].join('\n')
    }
    const best = c.hits[0]?.m
    return best ? [head, line(best, CHAT_RECALL.hitChars)].join('\n') : head
  })
  return prompts.chatRecall.found(parts)
}
