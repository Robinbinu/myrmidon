import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Model } from '@oh-my-pi/pi-ai'

/**
 * How many tokens each model can take in, layered the way opencode, Goose and Crush do it: the person's own number,
 * then what omp knows (its catalog and the provider's model list), then models.dev, then a hint in the model's name.
 * omp falls back to 128k for a model nobody described, which is wrong for an 8k or 32k model and wastes a 1M one,
 * so that one value counts as unknown.
 */

/** Where a model's window came from: `set` by the person, the `provider` (via omp), the `catalog` (models.dev), its `name`. */
export type WindowSource = 'set' | 'provider' | 'catalog' | 'name'

export interface ModelWindow {
  readonly tokens?: number
  readonly source?: WindowSource
}

/** omp's window for a model it found but knows nothing about. */
const OMP_UNKNOWN = 128_000
const MODELS_DEV = 'https://models.dev/api.json'
const REFRESH_MS = 24 * 60 * 60_000

/** omp provider ids whose models.dev entry goes by another name. */
const PROVIDER_ALIASES: Record<string, string> = {
  ark: 'volcengine',
  'openai-codex': 'openai',
  'google-antigravity': 'google',
  'google-gemini-cli': 'google',
}

/** models.dev reduced to what is needed here: provider → model id → context window. */
type Index = Record<string, Record<string, number>>

/** The same model under different hosts' spellings: no vendor prefix, tag, or date stamp, dots as dashes. */
export function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/[:@].*$/, '')
    .replace(/\./g, '-')
    .replace(/-\d{4,8}$/, '')
}

/** A size written into the name, like `-32k` or `-8k-`, as a lower bound in tokens. */
export function windowFromName(id: string): number | undefined {
  const m = /(?:^|[-_.])(\d{1,4})k(?=$|[-_.])/i.exec(id)
  return m ? Number(m[1]) * 1000 : undefined
}

export class ContextWindows {
  private _byProvider = new Map<string, Map<string, number>>()
  /** Every host's window for a normalized id, to pick from when the model's own host is not listed. */
  private _byName = new Map<string, number[]>()

  constructor(
    private readonly options: {
      /** Where the reduced models.dev index is kept between runs. */
      cacheFile?: string
      /** The person's own windows, by `provider/id`. */
      overrides?(): Record<string, number>
      fetch?: typeof fetch
    } = {},
  ) {}

  /** Reads the cached index, and refreshes it from models.dev when it is missing or a day old. */
  async load(): Promise<void> {
    const cached = this._readCache()
    if (cached) this._index(cached.index)
    if (cached && Date.now() - cached.mtime < REFRESH_MS) return
    try {
      const res = await (this.options.fetch ?? fetch)(MODELS_DEV, { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`models.dev answered ${res.status}`)
      const index = reduce(await res.json())
      this._index(index)
      this._writeCache(index)
    } catch (err) {
      // Offline or blocked: omp's own windows and name hints still apply, and the next start tries again.
      console.error(
        'could not refresh model windows from models.dev:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  of(model: { provider: string; id: string; contextWindow?: number | null }): ModelWindow {
    const set = this.options.overrides?.()[`${model.provider}/${model.id}`]
    if (set) return { tokens: set, source: 'set' }
    const known = model.contextWindow ?? undefined
    if (known && known !== OMP_UNKNOWN) return { tokens: known, source: 'provider' }
    const host = this._byProvider.get(PROVIDER_ALIASES[model.provider] ?? model.provider)?.get(model.id)
    if (host) return { tokens: host, source: 'catalog' }
    const named = windowFromName(model.id)
    if (named) return { tokens: named, source: 'name' }
    const elsewhere = this._byName.get(normalizeModelId(model.id))
    if (elsewhere?.length) return { tokens: mostCommon(elsewhere), source: 'catalog' }
    return known ? { tokens: known } : {}
  }

  /** The model with the window to use, for the compactor and the request. */
  apply<M extends Model>(model: M): M {
    const { tokens } = this.of(model)
    return tokens && tokens !== model.contextWindow ? { ...model, contextWindow: tokens } : model
  }

  private _index(index: Index) {
    this._byProvider = new Map()
    this._byName = new Map()
    for (const [provider, models] of Object.entries(index)) {
      this._byProvider.set(provider, new Map(Object.entries(models)))
      for (const [id, tokens] of Object.entries(models)) {
        const key = normalizeModelId(id)
        const list = this._byName.get(key)
        if (list) list.push(tokens)
        else this._byName.set(key, [tokens])
      }
    }
  }

  private _readCache(): { index: Index; mtime: number } | undefined {
    const file = this.options.cacheFile
    if (!file) return undefined
    try {
      return { index: JSON.parse(readFileSync(file, 'utf8')) as Index, mtime: statSync(file).mtimeMs }
    } catch {
      return undefined
    }
  }

  private _writeCache(index: Index) {
    const file = this.options.cacheFile
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(index))
    } catch (err) {
      console.error('could not cache model windows:', err)
    }
  }
}

/** Keeps each model's input window from models.dev's `api.json`, skipping anything malformed. */
function reduce(raw: unknown): Index {
  const out: Index = {}
  if (!raw || typeof raw !== 'object') throw new Error('models.dev returned no providers')
  for (const [provider, entry] of Object.entries(raw as Record<string, unknown>)) {
    const models = (entry as { models?: unknown })?.models
    if (!models || typeof models !== 'object') continue
    const windows: Record<string, number> = {}
    for (const [id, m] of Object.entries(models as Record<string, unknown>)) {
      const limit = (m as { limit?: { context?: unknown; input?: unknown } })?.limit
      const tokens = typeof limit?.input === 'number' ? limit.input : limit?.context
      if (typeof tokens === 'number' && tokens >= 1024) windows[id] = tokens
    }
    if (Object.keys(windows).length) out[provider] = windows
  }
  return out
}

/** The value most hosts agree on; on a tie the smaller, which never overfills the model. */
function mostCommon(values: readonly number[]): number {
  const counts = new Map<number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? Math.min(...values)
}
