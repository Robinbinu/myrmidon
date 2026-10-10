import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_GROUP_NAME_MAX } from './config.ts'

/** A section of the chat list the person named and fills by moving chats into it. */
export interface ChatGroup {
  readonly id: string
  readonly name: string
}

/** How the person keeps one chat in their list; none of it touches the conversation. */
export interface ChatPlace {
  /** When it was pinned: pinned chats sit at the top of the list, the latest pinned first. */
  readonly pinnedAt?: string
  /** When it was archived: out of the list, under Archived, until taken back. */
  readonly archivedAt?: string
  /** The person's group it sits in, instead of its project or date. */
  readonly group?: string
  /** The chat this one was forked from: its first round starts from that chat's conversation. */
  readonly forkOf?: string
}

interface Shelf {
  groups: ChatGroup[]
  chats: Record<string, ChatPlace>
}

/**
 * `<home>/chat-shelf.json`: pins, archive, the person's groups and forks, for the chat list on every device. Kept
 * apart from the chats' logs, which record what happened in a conversation rather than where it is filed.
 */
export class ChatShelf {
  private readonly _file: string

  constructor(home: string) {
    this._file = join(home, 'chat-shelf.json')
  }

  groups(): ChatGroup[] {
    return this._read().groups
  }

  place(chatId: string): ChatPlace {
    return this._read().chats[chatId] ?? {}
  }

  /** Pins, archives or files a chat; `false` and `null` take each back. */
  file(
    chatId: string,
    patch: { pinned?: boolean; archived?: boolean; group?: string | null },
    now = new Date(),
  ): ChatPlace {
    const shelf = this._read()
    if (typeof patch.group === 'string' && !shelf.groups.some((g) => g.id === patch.group))
      throw new Error('no such group')
    const { pinnedAt, archivedAt, group, ...rest } = shelf.chats[chatId] ?? {}
    const at = now.toISOString()
    const pin = patch.pinned === undefined ? pinnedAt : patch.pinned ? (pinnedAt ?? at) : undefined
    const archive =
      patch.archived === undefined ? archivedAt : patch.archived ? (archivedAt ?? at) : undefined
    const into = patch.group === undefined ? group : (patch.group ?? undefined)
    const place: ChatPlace = {
      ...rest,
      ...(pin ? { pinnedAt: pin } : {}),
      ...(archive ? { archivedAt: archive } : {}),
      ...(into ? { group: into } : {}),
    }
    this._write(this._set(shelf, chatId, place))
    return place
  }

  /** Notes that a new chat continues `from`'s conversation, in the same place in the list. */
  fork(chatId: string, from: string): void {
    const shelf = this._read()
    const { group } = shelf.chats[from] ?? {}
    this._write(this._set(shelf, chatId, { forkOf: from, ...(group ? { group } : {}) }))
  }

  addGroup(name: string): ChatGroup {
    const shelf = this._read()
    const group = {
      id: `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: groupName(name),
    }
    this._write({ ...shelf, groups: [...shelf.groups, group] })
    return group
  }

  renameGroup(id: string, name: string): ChatGroup {
    const shelf = this._read()
    if (!shelf.groups.some((g) => g.id === id)) throw new Error('no such group')
    const group = { id, name: groupName(name) }
    this._write({ ...shelf, groups: shelf.groups.map((g) => (g.id === id ? group : g)) })
    return group
  }

  /** Removes a group; its chats go back to their project or date. */
  removeGroup(id: string): void {
    const shelf = this._read()
    const chats = Object.fromEntries(
      Object.entries(shelf.chats).map(([chatId, { group, ...rest }]) => [
        chatId,
        group === id ? rest : { ...rest, ...(group ? { group } : {}) },
      ]),
    )
    this._write({ groups: shelf.groups.filter((g) => g.id !== id), chats })
  }

  /** Forgets deleted chats. */
  forget(chatIds: readonly string[]): void {
    const shelf = this._read()
    if (!chatIds.some((id) => id in shelf.chats)) return
    const chats = { ...shelf.chats }
    for (const id of chatIds) delete chats[id]
    this._write({ ...shelf, chats })
  }

  private _set(shelf: Shelf, chatId: string, place: ChatPlace): Shelf {
    const chats = { ...shelf.chats }
    if (Object.keys(place).length) chats[chatId] = place
    else delete chats[chatId]
    return { ...shelf, chats }
  }

  private _read(): Shelf {
    if (!existsSync(this._file)) return { groups: [], chats: {} }
    try {
      const raw = JSON.parse(readFileSync(this._file, 'utf8')) as Partial<Shelf>
      return {
        groups: Array.isArray(raw.groups)
          ? raw.groups.filter((g) => typeof g?.id === 'string' && typeof g.name === 'string')
          : [],
        chats: raw.chats && typeof raw.chats === 'object' ? raw.chats : {},
      }
    } catch {
      // A file the person broke by hand files nothing; the chats themselves are untouched.
      return { groups: [], chats: {} }
    }
  }

  private _write(shelf: Shelf): void {
    const tmp = `${this._file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(shelf, null, 2)}\n`)
    renameSync(tmp, this._file)
  }
}

function groupName(name: string): string {
  const clean = name.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('a group needs a name')
  if (clean.length > CHAT_GROUP_NAME_MAX)
    throw new Error(`a group name is at most ${CHAT_GROUP_NAME_MAX} characters`)
  return clean
}
