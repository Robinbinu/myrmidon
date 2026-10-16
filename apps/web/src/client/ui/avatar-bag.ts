import { createContext, useContext, useMemo } from 'react'
import { AVATARS } from '../ui-config.ts'
import { PERSONA_IDS, type Persona, personaById } from './personas.ts'

/*
 * Which persona each worker wears. A crew (a colony, or any other scope) draws from a shuffled bag: nobody in a crew
 * shares a persona while the cast lasts, and when the bag is refilled the personas the last crews wore go to the back,
 * so a new round meets new faces. Once drawn, an agent keeps its persona for as long as its crew is remembered, so it
 * never changes mid-conversation, across reloads included.
 */

export interface BagState {
  bag: string[]
  recent: string[]
  scopes: [string, [string, string][]][]
}

/** A small seeded random (mulberry32), so tests can replay a run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class AvatarBag {
  private readonly ids: readonly string[]
  private readonly random: () => number
  private readonly history: number
  private readonly keepScopes: number
  private bag: string[]
  private recent: string[]
  private scopes: Map<string, Map<string, string>>
  /** Called after every new draw, with what to keep. */
  onChange?: (state: BagState) => void

  constructor(
    opts: {
      ids?: readonly string[]
      seed?: number
      history?: number
      keepScopes?: number
      state?: BagState
    } = {},
  ) {
    this.ids = opts.ids ?? PERSONA_IDS
    this.random = seeded(opts.seed ?? Math.floor(Math.random() * 2 ** 32))
    // The history must leave something to draw: never more than all but one crew's worth.
    this.history = Math.min(opts.history ?? AVATARS.history, Math.max(0, this.ids.length - 1))
    this.keepScopes = opts.keepScopes ?? AVATARS.keepScopes
    const known = new Set(this.ids)
    const s = opts.state
    this.bag = (s?.bag ?? []).filter((id) => known.has(id))
    this.recent = (s?.recent ?? []).filter((id) => known.has(id)).slice(0, this.history)
    this.scopes = new Map(
      (s?.scopes ?? []).map(([scope, rows]) => [scope, new Map(rows.filter(([, id]) => known.has(id)))]),
    )
  }

  /** The persona `name` wears in `scope`, drawing one the first time. */
  assign(scope: string, name: string): string {
    const crew = this.scopes.get(scope) ?? new Map<string, string>()
    const had = crew.get(name)
    // Remembered scopes are kept most recently used last, so the oldest are the ones let go.
    this.scopes.delete(scope)
    this.scopes.set(scope, crew)
    if (had) return had
    const id = this.draw(new Set(crew.values()))
    crew.set(name, id)
    this.recent = [id, ...this.recent.filter((r) => r !== id)].slice(0, this.history)
    while (this.scopes.size > this.keepScopes) {
      const oldest = this.scopes.keys().next().value
      if (oldest === undefined) break
      this.scopes.delete(oldest)
    }
    this.onChange?.(this.snapshot())
    return id
  }

  /** The persona already drawn for `name` in `scope`, without drawing one. */
  peek(scope: string, name: string): string | undefined {
    return this.scopes.get(scope)?.get(name)
  }

  snapshot(): BagState {
    return {
      bag: [...this.bag],
      recent: [...this.recent],
      scopes: [...this.scopes].map(([scope, crew]) => [scope, [...crew]]),
    }
  }

  private draw(used: ReadonlySet<string>): string {
    for (let round = 0; round < 2; round++) {
      const at = this.bag.findIndex((id) => !used.has(id))
      if (at >= 0) return this.bag.splice(at, 1)[0] as string
      this.refill()
    }
    // A crew bigger than the whole cast: someone has to share.
    return this.ids[Math.floor(this.random() * this.ids.length)] as string
  }

  /** Every persona not already waiting, shuffled, with the recently worn ones last (the oldest of them first). */
  private refill() {
    const waiting = new Set(this.bag)
    const pool = this.ids.filter((id) => !waiting.has(id))
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j] as string, pool[i] as string]
    }
    const recent = new Set(this.recent)
    const stale = [...this.recent].reverse().filter((id) => pool.includes(id))
    this.bag.push(...pool.filter((id) => !recent.has(id)), ...stale)
  }
}

const STORAGE_KEY = 'myr-avatars'

function stored(): BagState | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as BagState) : undefined
  } catch {
    return undefined
  }
}

let shared: AvatarBag | undefined

/** The page's one bag, kept in this browser so personas survive a reload. */
export function avatarBag(): AvatarBag {
  if (shared) return shared
  const state = stored()
  const bag = new AvatarBag(state ? { state } : {})
  bag.onChange = (s) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    } catch {
      // Without storage the personas still hold for this visit.
    }
  }
  shared = bag
  return bag
}

/** Puts a bag of the caller's own in place of the page's, such as a seeded one in tests. */
export function setAvatarBag(bag: AvatarBag | undefined) {
  shared = bag
}

/** The crew the avatars below belong to: a colony's id, or another name for a group drawn together. */
const ScopeContext = createContext('default')
export const AvatarScope = ScopeContext.Provider

/** The persona the worker `name` wears in the surrounding crew. */
export function usePersona(name: string, override?: string): Persona {
  const scope = useContext(ScopeContext)
  // Drawing is idempotent per scope and name, so doing it while rendering is safe.
  return useMemo(
    () => personaById(override ?? avatarBag().assign(scope, name.toLowerCase())),
    [scope, name, override],
  )
}
