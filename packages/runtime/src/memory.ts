import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_MEMORIES,
  MEMORY_MAX_TEXT,
  MEMORY_PROMPT_COUNT,
  MEMORY_PROMPT_PREFERENCES,
  RECALL_CHARS,
  RECALL_MMR_LAMBDA,
  RECALL_QUERY_CHARS,
  RECALL_RECENCY_WEIGHT,
} from './config.ts'
import { redactMemorySecrets } from './omp/memory.ts'

/**
 * What the person wants Myrmidon to keep across chats: preferences, decisions, and lessons learned, each either for
 * every chat or for one project. Agents and the memory reviewer (memory-review.ts) only propose memories; the person
 * keeps or discards each one, so nothing becomes standing instructions without their say (a web page cannot plant
 * one). A round's prompt carries the kept memories that fit, by relevance once there are too many to carry all; agents
 * search the rest with `recall`. Stored in `<home>/memory.json`.
 */

export type MemoryKind = 'preference' | 'decision' | 'lesson' | 'fact'
export const MEMORY_KINDS: readonly MemoryKind[] = ['preference', 'decision', 'lesson', 'fact']

export interface MemorySource {
  /**
   * Who wrote it: the person in Settings, an agent with `remember`, or the memory reviewer from what the person said
   * in a chat (`extract`) or from tidying kept memories up (`reflect`). All but the person's are kept by the person.
   */
  readonly by: 'person' | 'agent' | 'extract' | 'reflect'
  readonly agent?: string
  readonly chatId?: string
  readonly colonyId?: string
  /** The agent's or reviewer's reason for proposing it; for `extract`, the person's own words it rests on. */
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
  /** A proposal that merges, corrects or supersedes kept memories: keeping it removes these. */
  readonly replaces?: readonly string[]
  readonly source: MemorySource
  readonly createdAt: string
  readonly updatedAt: string
}

/** A memory's text as kept: one line, a few words to MEMORY_MAX_TEXT characters. */
export function normalizeMemoryText(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length < 3) throw new Error('a memory needs a few words')
  if (t.length > MEMORY_MAX_TEXT)
    throw new Error(`keep a memory under ${MEMORY_MAX_TEXT} characters: one fact per memory`)
  return t
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/
/** A run of nine or more digits, spaces and dashes allowed: a phone, card, account or ID number. */
const LONG_NUMBER = /\d(?:[ -]?\d){8,}/

/**
 * Whether a text holds what must never become a memory unasked, which reaches every later prompt: a credential (omp's
 * memory redaction catches it), a secret placeholder (provider-secrets.ts), an email address or a long number. The
 * person may still write one in Settings themselves.
 */
export function sensitive(text: string): boolean {
  return (
    redactMemorySecrets(text) !== text ||
    text.includes('[[secret:') ||
    EMAIL.test(text) ||
    LONG_NUMBER.test(text)
  )
}

/**
 * What stops being true once the setup is fixed, after Hermes's do-not-capture list (agent/background_review.py): a
 * claim that a tool is broken or unusable, or a failure from how one machine is set up. Saved, these "harden into
 * refusals the agent cites against itself for months after the actual problem was fixed". Narrow on purpose: a
 * lasting lesson ("the API tests need the local database") reads differently.
 */
const NEVER_SAVE = [
  /\b(?:is|are|was|were|seems?|looks?)\s+(?:broken|unusable|not working)\b/i,
  /\b(?:does(?:n['’]t| not)|do(?:n['’]t| not)|did(?:n['’]t| not))\s+work\b/i,
  /\b(?:can(?:not|['’]t)|could(?:n['’]t| not))\s+be used\b/i,
  /\bcommand not found\b|\bnot installed\b|\bisn['’]t installed\b|\bis not available\b|\bisn['’]t available\b/i,
]

/** Whether a text is the kind of claim memory never keeps (see NEVER_SAVE); the person may still write one. */
export function neverSave(text: string): boolean {
  return NEVER_SAVE.some((re) => re.test(text))
}

/**
 * Whether a memory says what the project's own instructions (AGENTS.md…) already say, which agents read every round:
 * nearly all its words are in one sentence of them (omp's sharpshooter "exclude anything the project's docs state").
 */
export function inInstructions(text: string, instructions: string, overlap: number): boolean {
  const mine = new Set(terms(text))
  if (mine.size < 3) return false
  return instructions.split(/\n+|(?<=[.!?;:])\s+/).some((piece) => {
    const theirs = new Set(terms(piece))
    if (theirs.size < 3) return false
    let both = 0
    for (const w of mine) if (theirs.has(w)) both++
    return both / mine.size >= overlap
  })
}

function kindOf(kind: string): MemoryKind {
  if (!(MEMORY_KINDS as readonly string[]).includes(kind))
    throw new Error(`kind is ${MEMORY_KINDS.join(', ')}`)
  return kind as MemoryKind
}

// Relevance: lexical, so recall needs no embedding model and works offline on every platform. Recall by meaning
// (memory-vectors.ts) is added on top only once the person picks an embedding model, and falls back to this.

const STOP = new Set(
  (
    'a an and are as at be been but by can could do does for from had has have he her his how i if in into is it its ' +
    'me my no not of on or our she so than that the their them then there these they this to too us was we were what ' +
    'when where which who why will with would you your'
  ).split(' '),
)

/** A text's words for matching: lower case, letters and digits, no common or one-letter words, plurals' s dropped. */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
}

/** Word overlap of two texts, 0 to 1 (after omp's mnemopi `jaccardSimilarity`, over `terms`). */
export function similarity(a: string, b: string): number {
  const x = new Set(terms(a))
  const y = new Set(terms(b))
  if (!x.size || !y.size) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / (x.size + y.size - both)
}

/**
 * How fresh a memory still is, 0 to 1, by kind: a Weibull decay after omp's mnemopi (`weibullBoost`), with its
 * parameters for the nearest of its types (shape k, scale eta in hours). A preference holds for months; a fact or a
 * decision about a project goes stale sooner.
 */
const DECAY: Record<MemoryKind, { k: number; eta: number }> = {
  preference: { k: 0.4, eta: 4380 },
  decision: { k: 0.85, eta: 1080 },
  lesson: { k: 0.7, eta: 1440 },
  fact: { k: 0.8, eta: 720 },
}
export function freshness(m: Memory, now: number): number {
  const hours = (now - Date.parse(m.updatedAt)) / 3_600_000
  if (!Number.isFinite(hours) || hours <= 0) return 1
  const { k, eta } = DECAY[m.kind]
  return Math.exp(-((hours / eta) ** k))
}

/** Each memory's BM25 score for the words of `query`, in order; empty when the query or the list has none. */
export function wordScores(memories: readonly Memory[], query: string): number[] {
  const q = [...new Set(terms(query.slice(0, RECALL_QUERY_CHARS)))]
  if (!q.length || !memories.length) return []
  const docs = memories.map((m) => terms(m.text))
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1
  const df = new Map(q.map((w) => [w, docs.filter((d) => d.includes(w)).length]))
  const k1 = 1.2
  const b = 0.75
  return docs.map((d) =>
    q.reduce((score, w) => {
      const tf = d.filter((x) => x === w).length
      if (!tf) return score
      const n = df.get(w) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      return score + (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg))
    }, 0),
  )
}

/**
 * Memories ranked by how well they match `query`: BM25 over their words, nudged by freshness, then reordered so
 * near-duplicates do not crowd the top (after omp's mnemopi `mmrRerank`). Only memories sharing a word with the query
 * are returned.
 */
export function rankMemories(
  memories: readonly Memory[],
  query: string,
  limit: number,
  now = Date.now(),
): Memory[] {
  const raw = wordScores(memories, query)
  if (!raw.length) return []
  const top = Math.max(...raw)
  if (top <= 0) return []
  const scored = memories
    .map((m, i) => ({
      m,
      score: ((raw[i] ?? 0) / top) * (1 - RECALL_RECENCY_WEIGHT) + freshness(m, now) * RECALL_RECENCY_WEIGHT,
      hit: (raw[i] ?? 0) > 0,
    }))
    .filter((s) => s.hit)
    .sort((x, y) => y.score - x.score)
  const picked: typeof scored = []
  while (scored.length && picked.length < limit) {
    let best = 0
    let bestScore = Number.NEGATIVE_INFINITY
    scored.forEach((s, i) => {
      const overlap = Math.max(0, ...picked.map((p) => similarity(p.m.text, s.m.text)))
      const mmr = RECALL_MMR_LAMBDA * s.score - (1 - RECALL_MMR_LAMBDA) * overlap
      if (mmr > bestScore) {
        bestScore = mmr
        best = i
      }
    })
    picked.push(...scored.splice(best, 1))
  }
  return picked.map((p) => p.m)
}

/** Ranking by meaning (memory-vectors.ts), used by the async recall methods when the person picked an embedding model. */
export interface MemoryMeaning {
  /** The best `limit` of `memories` for `query`; undefined while no embedding model is picked. Throws when it fails. */
  rank(
    memories: readonly Memory[],
    query: string,
    limit: number,
    known: ReadonlySet<string>,
  ): Promise<Memory[] | undefined>
  /** Whether two memories of one scope look alike by the vectors already kept, without calling the model. */
  lookAlike(memories: readonly Memory[]): boolean
}

export class MemoryStore {
  private readonly _file: string

  constructor(
    home: string,
    private readonly _meaning?: MemoryMeaning,
  ) {
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

  /** Kept memories a chat in `project` (or in none) may use: every-chat ones plus that project's, oldest first. */
  kept(project?: string): Memory[] {
    return this.list()
      .filter((m) => m.status === 'active' && (!m.project || m.project === project))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  }

  /** Adds a memory; the same text in the same scope returns the existing one instead of a duplicate. */
  add(input: {
    text: string
    kind: string
    project?: string
    status: Memory['status']
    source: MemorySource
    replaces?: readonly string[]
  }): Memory {
    const text = normalizeMemoryText(input.text)
    const list = this.list()
    const same = list.find(
      (m) => m.text.toLowerCase() === text.toLowerCase() && (m.project ?? '') === (input.project ?? ''),
    )
    if (same) return same
    if (list.length >= MAX_MEMORIES)
      throw new Error(`memory is full (${MAX_MEMORIES}); remove some in Settings`)
    const now = new Date().toISOString()
    const replaces = input.status === 'proposed' ? [...new Set(input.replaces ?? [])] : []
    const memory: Memory = {
      id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      kind: kindOf(input.kind),
      ...(input.project ? { project: input.project } : {}),
      status: input.status,
      ...(replaces.length ? { replaces } : {}),
      source: input.source,
      createdAt: now,
      updatedAt: now,
    }
    this._write([...list, memory])
    return memory
  }

  /** Edits a memory; `project: null` makes it apply to every chat. */
  update(id: string, patch: { text?: string; kind?: string; project?: string | null }): Memory {
    const list = this.list()
    const current = list.find((m) => m.id === id)
    if (!current) throw new Error('no such memory')
    const { project: _project, ...rest } = current
    const project = patch.project === null ? undefined : (patch.project ?? current.project)
    const next: Memory = {
      ...rest,
      ...(project ? { project } : {}),
      ...(patch.text !== undefined ? { text: normalizeMemoryText(patch.text) } : {}),
      ...(patch.kind !== undefined ? { kind: kindOf(patch.kind) } : {}),
      updatedAt: new Date().toISOString(),
    }
    this._write(list.map((m) => (m.id === id ? next : m)))
    return next
  }

  /**
   * The person keeps a proposed memory: it applies from the next round, and the kept memories it replaces are gone
   * in the same write. Returns the ids it removed.
   */
  keep(id: string): string[] {
    const list = this.list()
    const current = list.find((m) => m.id === id)
    if (!current) throw new Error('no such memory')
    const gone = new Set((current.replaces ?? []).filter((r) => r !== id))
    const { replaces: _replaces, ...rest } = current
    const kept: Memory = { ...rest, status: 'active', updatedAt: new Date().toISOString() }
    this._write(list.filter((m) => !gone.has(m.id)).map((m) => (m.id === id ? kept : m)))
    return list.filter((m) => gone.has(m.id)).map((m) => m.id)
  }

  remove(id: string): boolean {
    const list = this.list()
    const next = list.filter((m) => m.id !== id)
    if (next.length === list.length) return false
    this._write(next)
    return true
  }

  /**
   * The kept memories a round's prompt carries. While they all fit (MEMORY_PROMPT_COUNT, RECALL_CHARS), all of them;
   * past that, the newest preferences (they apply to any request) and then those most relevant to `request`, the
   * rest left for the agents' `recall`. Oldest first, as kept.
   */
  recall(project?: string, request = ''): Memory[] {
    const plan = carryPlan(this.kept(project))
    return 'all' in plan
      ? plan.all
      : carry(plan, rankMemories(plan.others, request, MEMORY_PROMPT_COUNT - plan.preferences.length))
  }

  /** `recall`, ranked by meaning as well when the person picked an embedding model; by words if that fails. */
  async recallFor(project?: string, request = ''): Promise<Memory[]> {
    const plan = carryPlan(this.kept(project))
    if ('all' in plan) return plan.all
    const room = MEMORY_PROMPT_COUNT - plan.preferences.length
    return carry(
      plan,
      (await this._byMeaning(plan.others, request, room)) ?? rankMemories(plan.others, request, room),
    )
  }

  /** The `recall` tool: kept memories matching `query`, best first; with no words to match, the newest. */
  search(query: string, limit: number, project?: string): Memory[] {
    const kept = this.kept(project)
    return terms(query).length ? rankMemories(kept, query, limit) : kept.slice(-limit).reverse()
  }

  /** `search`, ranked by meaning as well when the person picked an embedding model; by words if that fails. */
  async searchFor(query: string, limit: number, project?: string): Promise<Memory[]> {
    if (!terms(query).length) return this.search(query, limit, project)
    return (await this._byMeaning(this.kept(project), query, limit)) ?? this.search(query, limit, project)
  }

  /** Whether two kept memories of one scope look alike in meaning (only with an embedding model picked). */
  lookAlike(memories: readonly Memory[]): boolean {
    return this._meaning?.lookAlike(memories) ?? false
  }

  private async _byMeaning(memories: readonly Memory[], query: string, limit: number) {
    if (!this._meaning || !memories.length) return undefined
    try {
      return await this._meaning.rank(memories, query, limit, new Set(this.list().map((m) => m.id)))
    } catch (err) {
      console.warn(
        `memory recall by meaning failed, matching words: ${err instanceof Error ? err.message : err}`,
      )
      return undefined
    }
  }

  private _write(list: Memory[]) {
    const tmp = `${this._file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`)
    renameSync(tmp, this._file)
  }
}

/**
 * What a round's prompt carries of `kept`: all of it while it fits (MEMORY_PROMPT_COUNT, RECALL_CHARS); else the
 * newest preferences, and the others to rank for the rest of the room.
 */
function carryPlan(
  kept: Memory[],
): { all: Memory[] } | { kept: Memory[]; preferences: Memory[]; others: Memory[] } {
  const size = kept.reduce((n, m) => n + m.text.length + 20, 0)
  if (kept.length <= MEMORY_PROMPT_COUNT && size <= RECALL_CHARS) return { all: kept }
  const preferences = kept
    .filter((m) => m.kind === 'preference')
    .reverse()
    .slice(0, MEMORY_PROMPT_PREFERENCES)
  return { kept, preferences, others: kept.filter((m) => !preferences.includes(m)) }
}

/** The preferences, then the relevant ones while RECALL_CHARS holds; oldest first, as kept. */
function carry(plan: { kept: Memory[]; preferences: Memory[] }, relevant: readonly Memory[]): Memory[] {
  const out: Memory[] = []
  let chars = 0
  for (const m of [...plan.preferences, ...relevant]) {
    chars += m.text.length + 20
    if (chars > RECALL_CHARS) break
    out.push(m)
  }
  return plan.kept.filter((m) => out.includes(m))
}

/** One line per memory for the prompt, e.g. `- [preference] Use British spelling`. */
export function memoryLines(memories: readonly Memory[]): string[] {
  return memories.map((m) => `- [${m.kind}${m.project ? ', this project' : ''}] ${m.text}`)
}
