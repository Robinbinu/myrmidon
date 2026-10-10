import type { ChatSummary } from '../api.ts'

/**
 * One chat in a family tree, with the chats forked from it. A chat whose parent was deleted hangs under a node for
 * the gone chat (no `chat`), so forks of the same deleted chat still show as siblings.
 */
export interface FamilyNode {
  readonly chatId: string
  readonly chat?: ChatSummary
  /** How many of the parent's runs the fork started from: it branches off after that run. */
  readonly forkedAfter?: number
  readonly children: readonly FamilyNode[]
}

/**
 * How chats relate, after omp's session tree (`/tree`): forks branch off the chat they continue, and each chat's runs
 * are its trunk. Built from the chat list alone (`forkOf`, `importOf`, the runs' start times), so every device draws
 * the same tree without asking the server. Undefined for a chat not in the list.
 */
export function chatFamily(chats: readonly ChatSummary[], chatId: string): FamilyNode | undefined {
  const byId = new Map(chats.map((c) => [c.chatId, c]))
  if (!byId.has(chatId)) return undefined
  const forks = new Map<string, ChatSummary[]>()
  for (const c of chats) if (c.forkOf) forks.set(c.forkOf, [...(forks.get(c.forkOf) ?? []), c])
  // Up to the oldest ancestor still here; a loop (a hand-edited shelf) stops where it would repeat.
  let top = chatId
  const climbed = new Set([top])
  for (let up = byId.get(top)?.forkOf; up && byId.has(up) && !climbed.has(up); up = byId.get(up)?.forkOf) {
    climbed.add(up)
    top = up
  }
  // The oldest ancestor was deleted: its forks hang under a node for it.
  const gone = byId.get(top)?.forkOf
  const rootId = gone && !byId.has(gone) ? gone : top
  const seen = new Set<string>()
  const build = (id: string, parent?: ChatSummary): FamilyNode => {
    seen.add(id)
    const chat = byId.get(id)
    const after = parent && chat ? forkPoint(parent, chat) : undefined
    const children = (forks.get(id) ?? [])
      .filter((c) => !seen.has(c.chatId))
      .sort((a, b) => started(a).localeCompare(started(b)))
      .map((c) => build(c.chatId, chat))
    return { chatId: id, ...(chat ? { chat } : {}), ...(after ? { forkedAfter: after } : {}), children }
  }
  return build(rootId)
}

const started = (c: ChatSummary) => c.rounds[0]?.startedAt ?? c.updatedAt

/** The parent's runs that had started when the fork's first run did: the conversation the fork carried on. */
function forkPoint(parent: ChatSummary, fork: ChatSummary): number | undefined {
  const at = fork.rounds[0]?.startedAt
  if (!at) return undefined
  const before = parent.rounds.filter((r) => r.startedAt && r.startedAt <= at)
  return before.at(-1)?.round
}

/** Every chat in a family, for counting it and for telling whether a chat has relatives at all. */
export function familySize(node: FamilyNode): number {
  return (node.chat ? 1 : 0) + node.children.reduce((n, c) => n + familySize(c), 0)
}
