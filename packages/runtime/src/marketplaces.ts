import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  download,
  type FetchFn,
  fetchGit,
  gitSource,
  type InstallOrigin,
  isWithin,
} from './install-sources.ts'
import {
  classifySource,
  isValidNameSegment,
  type MarketplaceCatalog,
  type MarketplacePluginEntry,
  parseMarketplaceCatalog,
} from './omp/plugins.ts'
import { expandHome } from './read-access.ts'

/**
 * Claude Code plugin marketplaces: a git repository (or a folder, or a URL to the JSON) with a
 * `.claude-plugin/marketplace.json` listing plugins and where each comes from. Adding one only reads its catalog;
 * installing a plugin from it goes through the same review as any other install (plugins.ts).
 *
 * The catalog is parsed and checked by omp's parser (`extensibility/plugins/marketplace/fetcher`), and sources are
 * classified as omp does (`owner/repo` is GitHub); resolving a plugin's source follows omp's
 * `marketplace/source-resolver.ts`, with npm sources added.
 */

export type MarketplaceKind = 'github' | 'git' | 'url' | 'local'

/** A marketplace as `marketplaces.json` remembers it. */
interface Entry {
  name: string
  /** What the person typed: `owner/repo`, a git URL, a URL to the JSON, or a folder. */
  source: string
  kind: MarketplaceKind
  /** The commit its catalog was read at (git and GitHub). */
  commit?: string
  addedAt: string
  updatedAt: string
}

export interface MarketplacePlugin {
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly author?: string
  readonly category?: string
  /** Where it would be fetched from, as one line. */
  readonly source: string
}

export interface Marketplace {
  readonly name: string
  readonly source: string
  readonly kind: MarketplaceKind
  readonly commit?: string
  readonly addedAt: string
  readonly updatedAt: string
  readonly owner?: string
  readonly description?: string
  readonly plugins: readonly MarketplacePlugin[]
  /** Set when its catalog could not be read. */
  readonly error?: string
}

/** A marketplace plugin, resolved to a source to fetch. */
export interface MarketplaceResolution {
  readonly entry: MarketplacePluginEntry
  /** What to fetch now. */
  readonly fetch: Exclude<InstallOrigin, { kind: 'marketplace' } | { kind: 'registry' }>
  /** The marketplace's commit, for a plugin that lives inside its repository. */
  readonly commit?: string
}

/** omp tries its own catalog path first, then Claude Code's. */
const CATALOG_PATHS = [
  ['.omp-plugin', 'marketplace.json'],
  ['.claude-plugin', 'marketplace.json'],
]

/** A plugin entry's source as one line, for the browse list. */
function sourceLine(source: MarketplacePluginEntry['source']): string {
  if (typeof source === 'string') return source
  switch (source.source) {
    case 'github':
      return `github:${source.repo}${source.ref ? `#${source.ref}` : ''}`
    case 'url':
      return source.url
    case 'git-subdir':
      return `${source.url} (${source.path})`
    case 'npm':
      return `npm:${source.package}${source.version ? `@${source.version}` : ''}`
  }
}

export class MarketplaceStore {
  readonly dir: string
  private readonly _file: string

  constructor(
    home: string,
    private readonly fetchFn: FetchFn = (...a) => fetch(...a),
  ) {
    this.dir = join(home, 'marketplaces')
    this._file = join(home, 'marketplaces.json')
  }

  list(): Marketplace[] {
    return this._entries().map((e) => {
      try {
        const catalog = this.catalog(e.name).catalog
        return {
          ...e,
          owner: catalog.owner.name,
          ...(catalog.metadata?.description ? { description: catalog.metadata.description } : {}),
          plugins: catalog.plugins.map((p) => ({
            name: p.name,
            source: sourceLine(p.source),
            ...(p.description ? { description: p.description } : {}),
            ...(p.version ? { version: p.version } : {}),
            ...(p.author?.name ? { author: p.author.name } : {}),
            ...(p.category ? { category: p.category } : {}),
          })),
        }
      } catch (err) {
        return { ...e, plugins: [], error: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  /**
   * Adds a marketplace from GitHub (`owner/repo`), a git URL, a URL to its JSON, or a folder, named by its catalog.
   * Only the catalog is read; nothing in it runs.
   */
  async add(source: string): Promise<Marketplace> {
    const from = source.trim()
    if (!from) throw new Error('give a GitHub owner/repo, a git URL or a folder')
    const fetched = await this._fetch(from)
    try {
      const name = fetched.catalog.name
      if (this._entries().some((e) => e.name.toLowerCase() === name.toLowerCase()))
        throw new Error(`a marketplace called ${name} is already added`)
      if (fetched.staged) {
        rmSync(join(this.dir, name), { recursive: true, force: true })
        renameSync(fetched.staged, join(this.dir, name))
      }
      const now = new Date().toISOString()
      this._save([
        ...this._entries(),
        {
          name,
          source: fetched.source,
          kind: fetched.kind,
          ...(fetched.commit ? { commit: fetched.commit } : {}),
          addedAt: now,
          updatedAt: now,
        },
      ])
      return this._get(name)
    } finally {
      if (fetched.staged) rmSync(fetched.staged, { recursive: true, force: true })
    }
  }

  /** Reads a marketplace's catalog again from its source. */
  async update(name: string): Promise<Marketplace> {
    const entry = this._entry(name)
    const fetched = await this._fetch(entry.source)
    try {
      if (fetched.catalog.name !== entry.name)
        throw new Error(
          `the catalog is now called ${fetched.catalog.name}, not ${entry.name}: remove and add it`,
        )
      if (fetched.staged) {
        rmSync(join(this.dir, name), { recursive: true, force: true })
        renameSync(fetched.staged, join(this.dir, name))
      }
      this._save(
        this._entries().map((e) => {
          if (e.name !== name) return e
          const { commit: _old, ...rest } = e
          return {
            ...rest,
            ...(fetched.commit ? { commit: fetched.commit } : {}),
            updatedAt: new Date().toISOString(),
          }
        }),
      )
      return this._get(name)
    } finally {
      if (fetched.staged) rmSync(fetched.staged, { recursive: true, force: true })
    }
  }

  /** Forgets a marketplace; plugins installed from it stay. */
  remove(name: string) {
    this._entry(name)
    rmSync(join(this.dir, name), { recursive: true, force: true })
    this._save(this._entries().filter((e) => e.name !== name))
  }

  /** A marketplace's catalog, and the folder its relative plugin paths are under (none for a URL catalog). */
  catalog(name: string): { catalog: MarketplaceCatalog; root?: string } {
    const entry = this._entry(name)
    const root = entry.kind === 'local' ? entry.source : join(this.dir, entry.name)
    const catalog = readCatalog(root)
    return { catalog, ...(entry.kind === 'url' ? {} : { root }) }
  }

  /** Where a plugin of a marketplace is fetched from. */
  resolve(marketplace: string, plugin: string): MarketplaceResolution {
    const entry = this._entry(marketplace)
    const { catalog, root } = this.catalog(marketplace)
    const p = catalog.plugins.find((x) => x.name.toLowerCase() === plugin.toLowerCase())
    if (!p) throw new Error(`${marketplace} has no plugin called ${plugin}`)
    const src = p.source
    if (typeof src === 'string') {
      if (!root) throw new Error(`${p.name} is a path inside ${marketplace}, which was added from a URL`)
      const rel = catalog.metadata?.pluginRoot ? join(catalog.metadata.pluginRoot, src) : src
      const path = resolve(root, rel)
      if (!isWithin(root, path)) throw new Error(`${p.name}'s path leaves the marketplace`)
      return { entry: p, fetch: { kind: 'folder', path }, ...(entry.commit ? { commit: entry.commit } : {}) }
    }
    const ref = (s: { ref?: string; sha?: string }) => ((s.sha ?? s.ref) ? { ref: s.sha ?? s.ref } : {})
    switch (src.source) {
      case 'github':
        return { entry: p, fetch: { kind: 'git', url: `https://github.com/${src.repo}.git`, ...ref(src) } }
      case 'url':
        return { entry: p, fetch: { kind: 'git', url: src.url, ...ref(src) } }
      case 'git-subdir': {
        const url =
          src.url.includes('://') || src.url.startsWith('git@')
            ? src.url
            : `https://github.com/${src.url}.git`
        return { entry: p, fetch: { kind: 'git', url, subdir: src.path, ...ref(src) } }
      }
      case 'npm':
        return {
          entry: p,
          fetch: {
            kind: 'npm',
            spec: src.version ? `${src.package}@${src.version}` : src.package,
            ...(src.registry ? { registry: src.registry } : {}),
          },
        }
    }
  }

  private async _fetch(source: string): Promise<{
    catalog: MarketplaceCatalog
    source: string
    kind: MarketplaceKind
    commit?: string
    staged?: string
  }> {
    const kind = classify(source)
    if (kind === 'local') {
      const path = resolve(expandHome(source))
      return { catalog: readCatalog(path), source: path, kind }
    }
    mkdirSync(this.dir, { recursive: true })
    const staged = join(this.dir, `.adding-${Date.now()}`)
    try {
      if (kind === 'url') {
        const bytes = await download(this.fetchFn, source, 'the marketplace catalog')
        const text = new TextDecoder().decode(bytes)
        const catalog = parseMarketplaceCatalog(text, source)
        mkdirSync(join(staged, '.claude-plugin'), { recursive: true })
        writeFileSync(join(staged, '.claude-plugin', 'marketplace.json'), text)
        return { catalog: checkedName(catalog), source, kind, staged }
      }
      const repo =
        kind === 'github'
          ? { url: `https://github.com/${source}.git` }
          : (gitSource(source) ?? { url: source })
      const { commit } = await fetchGit(repo, staged)
      return {
        catalog: checkedName(readCatalog(staged)),
        source,
        kind,
        staged,
        ...(commit ? { commit } : {}),
      }
    } catch (err) {
      rmSync(staged, { recursive: true, force: true })
      throw err
    }
  }

  private _get(name: string): Marketplace {
    const m = this.list().find((x) => x.name === name)
    if (!m) throw new Error(`no marketplace called ${name}`)
    return m
  }

  private _entry(name: string): Entry {
    const e = this._entries().find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!e) throw new Error(`no marketplace called ${name}`)
    return e
  }

  private _entries(): Entry[] {
    try {
      const raw = JSON.parse(readFileSync(this._file, 'utf8')) as { marketplaces?: unknown }
      return Array.isArray(raw.marketplaces)
        ? (raw.marketplaces as Entry[]).filter(
            (e) => e && typeof e.name === 'string' && isValidNameSegment(e.name),
          )
        : []
    } catch {
      return []
    }
  }

  private _save(entries: Entry[]) {
    writeFileSync(`${this._file}.tmp`, `${JSON.stringify({ marketplaces: entries }, null, 2)}\n`)
    renameSync(`${this._file}.tmp`, this._file)
  }
}

/** Git for `file://` URLs and paths ending `.git` (omp's classifier calls those folders); omp's rules for the rest. */
function classify(source: string): MarketplaceKind {
  if (/^file:\/\//i.test(source) || /\.git\/?$/.test(source)) return 'git'
  return classifySource(source)
}

/** The catalog's name becomes a folder name: omp's parser checked it is a plain name segment. */
function checkedName(catalog: MarketplaceCatalog): MarketplaceCatalog {
  if (!isValidNameSegment(catalog.name)) throw new Error(`"${catalog.name}" is not a usable marketplace name`)
  return catalog
}

function readCatalog(root: string): MarketplaceCatalog {
  for (const parts of CATALOG_PATHS) {
    const file = join(root, ...parts)
    if (existsSync(file)) return parseMarketplaceCatalog(readFileSync(file, 'utf8'), parts.join('/'))
  }
  throw new Error(`no ${CATALOG_PATHS.map((p) => p.join('/')).join(' or ')} in ${root}`)
}
