import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What the person wants Myrmidon to keep across chats: preferences, decisions, and lessons learned, each either for
 * every chat or for one project. Agents only propose memories; the person keeps or discards each one, so nothing
 * becomes standing instructions without their say (a web page cannot plant one). Kept memories reach every new
 * round's prompt. Stored in `<home>/memory.json`.
 */

export type MemoryKind = 'preference' | 'decision' | 'lesson' | 'fact'
export const MEMORY_KINDS: readonly MemoryKind[] = ['preference', 'decision', 'lesson', 'fact']

export interface MemorySource {
  /** Who wrote it: the person in Settings, or an agent (then kept by the person). */
  readonly by: 'person' | 'agent'
  readonly agent?: string
  readonly chatId?: string
  readonly colonyId?: string
  /** The agent's reason for proposing it. */
  readonly why?: string
}

export interface Memory {
  readonly id: string
  readonly text: string
  readonly kind: MemoryKind
  /** Set: only for chats in this project. Unset: for every chat. */
  readonly project?: string
  /** `proposed` waits for the person to keep or discard it. */
  readonly status: 'active' | 'proposed'
  readonly source: MemorySource
  readonly createdAt: string
  readonly updatedAt: string
}

const MAX_TEXT = 400
const MAX_MEMORIES = 300
/** How much memory a round's prompt carries at most. */
const RECALL_COUNT = 40
const RECALL_CHARS = 6_000

function clean(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length < 3) throw new Error('a memory needs a few words')
  if (t.length > MAX_TEXT) throw new Error(`keep a memory under ${MAX_TEXT} characters: one fact per memory`)
  return t
}

function kindOf(kind: string): MemoryKind {
  if (!(MEMORY_KINDS as readonly string[]).includes(kind))
    throw new Error(`kind is ${MEMORY_KINDS.join(', ')}`)
  return kind as MemoryKind
}

export class MemoryStore {
  private readonly _file: string

  constructor(home: string) {
    this._file = join(home, 'memory.json')
  }

  list(): Memory[] {
    if (!existsSync(this._file)) return []
    try {
      const raw = JSON.parse(readFileSync(this._file, 'utf8')) as unknown
      return Array.isArray(raw) ? (raw as Memory[]).filter((m) => m && typeof m.text === 'string') : []
    } catch {
      return []
    }
  }

  get(id: string): Memory | undefined {
    return this.list().find((m) => m.id === id)
  }

  /** Adds a memory; the same text in the same scope returns the existing one instead of a duplicate. */
  add(input: {
    text: string
    kind: string
    project?: string
    status: Memory['status']
    source: MemorySource
  }): Memory {
    const text = clean(input.text)
    const list = this.list()
    const same = list.find(
      (m) => m.text.toLowerCase() === text.toLowerCase() && (m.project ?? '') === (input.project ?? ''),
    )
    if (same) return same
    if (list.length >= MAX_MEMORIES)
      throw new Error(`memory is full (${MAX_MEMORIES}); remove some in Settings`)
    const now = new Date().toISOString()
    const memory: Memory = {
      id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      kind: kindOf(input.kind),
      ...(input.project ? { project: input.project } : {}),
      status: input.status,
      source: input.source,
      createdAt: now,
      updatedAt: now,
    }
    this._write([...list, memory])
    return memory
  }

  /** Edits a memory; `project: null` makes it apply to every chat. */
  update(
    id: string,
    patch: { text?: string; kind?: string; project?: string | null; status?: Memory['status'] },
  ): Memory {
    const list = this.list()
    const current = list.find((m) => m.id === id)
    if (!current) throw new Error('no such memory')
    const { project: _project, ...rest } = current
    const project = patch.project === null ? undefined : (patch.project ?? current.project)
    const next: Memory = {
      ...rest,
      ...(project ? { project } : {}),
      ...(patch.text !== undefined ? { text: clean(patch.text) } : {}),
      ...(patch.kind !== undefined ? { kind: kindOf(patch.kind) } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      updatedAt: new Date().toISOString(),
    }
    this._write(list.map((m) => (m.id === id ? next : m)))
    return next
  }

  remove(id: string): boolean {
    const list = this.list()
    const next = list.filter((m) => m.id !== id)
    if (next.length === list.length) return false
    this._write(next)
    return true
  }

  /** The kept memories a chat's round should know: every-chat ones plus its project's, newest last. */
  recall(project?: string): Memory[] {
    const kept = this.list()
      .filter((m) => m.status === 'active' && (!m.project || m.project === project))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(-RECALL_COUNT)
    // Newest memories win when the prompt budget runs out.
    const out: Memory[] = []
    let chars = 0
    for (const m of [...kept].reverse()) {
      chars += m.text.length + 20
      if (chars > RECALL_CHARS) break
      out.unshift(m)
    }
    return out
  }

  private _write(list: Memory[]) {
    writeFileSync(`${this._file}.tmp`, `${JSON.stringify(list, null, 2)}\n`)
    renameSync(`${this._file}.tmp`, this._file)
  }
}

/** One line per memory for the prompt, e.g. `- [preference] Use British spelling`. */
export function memoryLines(memories: readonly Memory[]): string[] {
  return memories.map((m) => `- [${m.kind}${m.project ? ', this project' : ''}] ${m.text}`)
}
