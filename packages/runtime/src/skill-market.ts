import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  ANTHROPIC_SKILLS_REPO,
  CLAWHUB_MAX_FILES,
  CLAWHUB_URL,
  INSTALL_MAX_BYTES,
  MARKET_AUDITS,
  MARKET_CACHE_MS,
  MARKET_CATALOG_MAX_AGE_MS,
  MARKET_FETCH_TIMEOUT_MS,
  MARKET_RESULTS,
  OPENAI_SKILLS_REPO,
  SKILLS_SH_URL,
} from './config.ts'
import { type FetchFn, fetchGit, type InstallOrigin, type InstallPin, isWithin } from './install-sources.ts'
import type { SkillAudit, SkillInstaller, SkillPreview, StageOptions } from './skill-installs.ts'
import type { SkillSearchHit } from './skill-registry.ts'
import { parseSkillFile } from './skills.ts'

/**
 * The skill marketplace: one place to browse and search the public skill catalogs and install from them. omp's skills
 * registry, OpenAI's and Anthropic's skill repositories, skills.sh and ClawHub each answer through an adapter; a
 * source that fails or is slow is reported beside the others' results instead of failing them. Installing goes
 * through SkillInstaller like any other skill install (staged, scanned, reviewed, confirmed), and records where it
 * came from so it can be updated.
 *
 * ClawHub is off until the person turns it on: in February 2026 hundreds of malicious skills were found there. Its
 * own trust verdict is shown, and a skill it flags as suspicious installs only through the scan's block and the
 * person's "Install anyway".
 */

export type SkillView = 'popular' | 'trending' | 'recent' | 'all'

export interface SkillSourceInfo {
  readonly id: string
  readonly name: string
  /** Its website. */
  readonly url: string
  readonly enabled: boolean
  /** Off until the person turns it on, for a risk the UI states. */
  readonly optIn: boolean
  /** The lists it offers without a search; none when it only searches. */
  readonly views: readonly SkillView[]
}

export interface MarketHit {
  readonly source: string
  /** The skill's id in its source: `@scope/name`, a repository path, `owner/repo/skill`, `owner/slug`. */
  readonly id: string
  readonly name: string
  readonly description: string
  readonly author?: string
  readonly license?: string
  readonly version?: string
  readonly installs?: number
  readonly weeklyDownloads?: number
  readonly stars?: number
  /** Its page on the source's website. */
  readonly url?: string
  readonly audit?: SkillAudit
  /** The source flags it as suspicious: it installs only through the scan's block and "Install anyway". */
  readonly flagged?: boolean
  /** `source:id`, what `prepare` takes. */
  readonly installRef: string
}

export interface MarketResults {
  readonly hits: MarketHit[]
  /** Sources that could not answer, and why; the hits are the others'. */
  readonly errors: { source: string; error: string }[]
}

/** Where the person's choice of sources is kept (the settings file's `skillMarket.sources`). */
export interface SourceToggles {
  get(): Readonly<Record<string, boolean>>
  set(sources: Record<string, boolean>): void
}

export interface MarketOptions {
  readonly toggles?: SourceToggles
  /** For tests: a stubbed fetch, so nothing reaches the network. */
  readonly fetchFn?: FetchFn
  readonly skillsShUrl?: string
  readonly clawhubUrl?: string
  readonly openaiRepo?: string
  readonly anthropicRepo?: string
  /** Where skills.sh's `owner/repo` repositories are cloned from. */
  readonly gitHost?: string
}

interface Resolved {
  origin: InstallOrigin
  opts?: StageOptions
}

interface Adapter {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly optIn?: boolean
  readonly views: readonly SkillView[]
  browse(view: SkillView): Promise<MarketHit[]>
  search(q: string): Promise<MarketHit[]>
  resolve(id: string): Promise<Resolved>
}

const STATUS_RANK = { pass: 0, unknown: 1, warn: 2, fail: 3 } as const

/** A third party's word for its verdict, as pass, warn or fail. */
function statusOf(word: unknown): SkillAudit['status'] {
  const w = typeof word === 'string' ? word.toLowerCase() : ''
  if (['pass', 'clean', 'benign', 'safe', 'ok', 'none', 'low'].includes(w)) return 'pass'
  if (['warn', 'warning', 'suspicious', 'medium', 'note'].includes(w)) return 'warn'
  if (['fail', 'malicious', 'high', 'critical', 'blocked'].includes(w)) return 'fail'
  return 'unknown'
}

const worst = (checks: readonly { status: SkillAudit['status'] }[]): SkillAudit['status'] =>
  checks.reduce<SkillAudit['status']>(
    (w, c) => (STATUS_RANK[c.status] > STATUS_RANK[w] ? c.status : w),
    checks.length ? 'pass' : 'unknown',
  )

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Lowercase words of a query, all of which a hit's name or description must hold. */
const matches = (q: string, ...fields: (string | undefined)[]) => {
  const text = fields.join(' ').toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.includes(w))
}

class Http {
  constructor(private readonly fetchFn: FetchFn) {}

  async get(url: string, what: string): Promise<Response> {
    let res: Response
    try {
      res = await this.fetchFn(url, {
        headers: { Accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(MARKET_FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(`cannot reach ${what}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).trim()
      let message = body
      try {
        const parsed = obj(JSON.parse(body))
        message = str(parsed.message) ?? str(parsed.error) ?? body
      } catch {}
      throw new Error(`${what} answered ${res.status}${message ? `: ${message.slice(0, 200)}` : ''}`)
    }
    return res
  }

  async json(url: string, what: string): Promise<unknown> {
    const res = await this.get(url, what)
    try {
      return await res.json()
    } catch {
      throw new Error(`${what} answered with something that is not JSON`)
    }
  }
}

// ── omp's skills registry ────────────────────────────────────────────

function ompSource(installer: SkillInstaller): Adapter {
  const client = installer.registry
  const hit = (h: SkillSearchHit): MarketHit => {
    const id = `@${h.scope}/${h.name}`
    return {
      source: 'omp',
      id,
      name: h.name,
      description: h.description,
      author: h.publisher?.username,
      version: h.version,
      weeklyDownloads: h.weeklyDownloads,
      url: client.page(h.scope, h.name),
      installRef: `omp:${id}`,
    }
  }
  return {
    id: 'omp',
    name: 'Skillshare',
    url: client.url,
    views: ['popular', 'trending', 'recent'],
    async browse(view) {
      const home = await client.home()
      const list = view === 'trending' ? home.trending : view === 'recent' ? home.recent : home.popular
      return list.map(hit)
    },
    async search(q) {
      return (await client.search(q)).hits.map(hit)
    },
    async resolve(id) {
      return { origin: { kind: 'registry', spec: id } }
    },
  }
}

// ── git catalogs: OpenAI's and Anthropic's skill repositories ─────────

interface CatalogEntry {
  name: string
  description: string
  path: string
  license?: string
}

/**
 * A skill's license as a short label: its front matter's `license`, or the first line of the LICENSE file beside its
 * SKILL.md (Apache's names itself there). Front matter that only points at that file ("Complete terms in
 * LICENSE.txt") gives way to the file; one that names a kind first ("Proprietary. LICENSE.txt has complete terms")
 * keeps the kind, and a proprietary skill whose files anyone can read is labelled source-available.
 */
function licenseOf(dir: string, skillMd: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1] ?? ''
  const declared = /^license:\s*["']?(.+?)["']?\s*$/m.exec(front)?.[1]?.trim()
  const file = readdirSync(dir).find((f) => /^licen[cs]e(\.(txt|md))?$/i.test(f))
  const fileLine = file
    ? readFileSync(join(dir, file), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean)
    : undefined
  let label = declared
  if (declared && /licen[cs]e\.(txt|md)/i.test(declared)) {
    const kind = declared.split('.')[0]?.trim() ?? ''
    label = /terms|licen[cs]e/i.test(kind) ? (fileLine ?? declared) : kind
  }
  label ??= fileLine
  if (label && /^proprietary$/i.test(label)) label = 'Proprietary, source-available'
  return label?.slice(0, 120)
}

/**
 * A git repository of skills, kept as a shallow copy under `<home>/marketplaces/.skills/<id>` and fetched again when
 * it is older than MARKET_CATALOG_MAX_AGE_MS. A fetch that fails keeps the copy it had.
 */
class GitCatalog implements Adapter {
  readonly views = ['all'] as const
  private _loading?: Promise<CatalogEntry[]>
  private _entries?: { at: number; list: CatalogEntry[] }

  constructor(
    readonly id: string,
    readonly name: string,
    /** Its page, under which `/tree/HEAD/<path>` shows a skill. */
    readonly url: string,
    private readonly repo: string,
    /** Folders whose subfolders are skills. */
    private readonly roots: readonly string[],
    private readonly cache: string,
  ) {}

  async browse() {
    return (await this._list()).map((e) => this._hit(e))
  }

  async search(q: string) {
    return (await this._list()).filter((e) => matches(q, e.name, e.description)).map((e) => this._hit(e))
  }

  async resolve(id: string): Promise<Resolved> {
    const list = await this._list()
    const entry = list.find((e) => e.path === id) ?? list.find((e) => e.name === id)
    if (!entry) throw new Error(`${this.name} has no skill ${id}`)
    return { origin: { kind: 'git', url: this.repo, subdir: entry.path } }
  }

  private _hit(e: CatalogEntry): MarketHit {
    return {
      source: this.id,
      id: e.path,
      name: e.name,
      description: e.description,
      author: this.name,
      ...(e.license ? { license: e.license } : {}),
      url: `${this.url}/tree/HEAD/${e.path}`,
      installRef: `${this.id}:${e.path}`,
    }
  }

  private _list(now = Date.now()): Promise<CatalogEntry[]> {
    if (this._entries && now - this._entries.at < MARKET_CATALOG_MAX_AGE_MS)
      return Promise.resolve(this._entries.list)
    this._loading ??= this._load(now).finally(() => {
      this._loading = undefined
    })
    return this._loading
  }

  private async _load(now: number): Promise<CatalogEntry[]> {
    const dir = join(this.cache, this.id)
    const stamp = join(this.cache, `${this.id}.json`)
    let fetchedAt = 0
    try {
      fetchedAt = Number((JSON.parse(readFileSync(stamp, 'utf8')) as { fetchedAt?: unknown }).fetchedAt) || 0
    } catch {}
    if (!existsSync(dir) || now - fetchedAt >= MARKET_CATALOG_MAX_AGE_MS) {
      mkdirSync(this.cache, { recursive: true })
      const staged = join(this.cache, `.${this.id}-${randomUUID()}`)
      try {
        const { commit } = await fetchGit({ url: this.repo }, staged)
        rmSync(dir, { recursive: true, force: true })
        renameSync(staged, dir)
        writeFileSync(stamp, `${JSON.stringify({ commit, fetchedAt: now })}\n`)
      } catch (err) {
        rmSync(staged, { recursive: true, force: true })
        if (!existsSync(dir)) throw err
      }
    }
    const list = this._read(dir)
    this._entries = { at: now, list }
    return list
  }

  /** The skills under each root, and any a `.claude-plugin/marketplace.json` names elsewhere. */
  private _read(dir: string): CatalogEntry[] {
    const paths = new Set<string>()
    for (const root of this.roots) {
      const base = join(dir, root)
      if (!existsSync(base)) continue
      for (const e of readdirSync(base, { withFileTypes: true }))
        if (e.isDirectory()) paths.add(`${root}/${e.name}`)
    }
    try {
      const catalog = obj(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'marketplace.json'), 'utf8')))
      for (const plugin of arr(catalog.plugins))
        for (const p of arr(obj(plugin).skills))
          if (typeof p === 'string') paths.add(p.replace(/^\.\//, '').replace(/\/+$/, ''))
    } catch {}
    const out: CatalogEntry[] = []
    for (const path of paths) {
      const skillDir = resolve(dir, path)
      const file = join(skillDir, 'SKILL.md')
      if (!isWithin(dir, skillDir) || !existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      const parsed = parseSkillFile(text)
      if (!parsed) continue
      const license = licenseOf(skillDir, text)
      out.push({ name: parsed.name, description: parsed.description, path, ...(license ? { license } : {}) })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  }
}

// ── skills.sh ────────────────────────────────────────────────────────

/** `owner/repo/skill`, as skills.sh names a skill. */
const SKILLS_SH_ID = /^(\w[\w.-]*)\/(\w[\w.-]*)\/(\w[\w.:-]*)$/

/**
 * skills.sh (Vercel). Its v1 lists and search need a Vercel OIDC token, so it is searched through the endpoint its
 * own `skills find` uses, which needs none; its audits (Gen Agent Trust Hub, Socket, Snyk and others) are public.
 * Its skills live in GitHub repositories, cloned to install.
 */
function skillsShSource(http: Http, cached: Cached, base: string, gitHost: string): Adapter {
  const audit = (id: string): Promise<SkillAudit | undefined> =>
    cached(`skills.sh:audit:${id}`, async () => {
      let body: unknown
      try {
        body = await http.json(`${base}/api/v1/skills/audit/${id}`, 'skills.sh')
      } catch (err) {
        // No audit yet: skills.sh audits a skill after its first install.
        if (err instanceof Error && / 404\b/.test(err.message)) return undefined
        throw err
      }
      const checks = arr(obj(body).audits).map((a) => {
        const x = obj(a)
        return {
          name: str(x.provider) ?? str(x.slug) ?? '?',
          status: statusOf(x.status),
          ...(str(x.summary) ? { summary: str(x.summary) } : {}),
        }
      })
      if (!checks.length) return undefined
      return { by: 'skills.sh', status: worst(checks), url: `${base}/${id}`, checks }
    })
  return {
    id: 'skills.sh',
    name: 'skills.sh',
    url: base,
    views: [],
    async browse() {
      throw new Error('skills.sh lists need a skills.sh account: search it instead')
    },
    async search(q) {
      if (q.trim().length < 2) return []
      const url = new URL(`${base}/api/search`)
      url.searchParams.set('q', q)
      url.searchParams.set('limit', String(MARKET_RESULTS))
      const skills = arr(obj(await http.json(url.href, 'skills.sh')).skills)
      const hits = skills.flatMap((s): MarketHit[] => {
        const x = obj(s)
        const id = str(x.id)
        const m = id ? SKILLS_SH_ID.exec(id) : null
        if (!id || !m) return []
        return [
          {
            source: 'skills.sh',
            id,
            name: str(x.name) ?? m[3] ?? id,
            description: '',
            author: m[1],
            ...(num(x.installs) !== undefined ? { installs: num(x.installs) } : {}),
            url: `${base}/${id}`,
            installRef: `skills.sh:${id}`,
          },
        ]
      })
      // Audits are one request each: the top results carry theirs, and one that fails leaves its hit without.
      return Promise.all(
        hits.map(async (h, i) => {
          if (i >= MARKET_AUDITS) return h
          const a = await audit(h.id).catch(() => undefined)
          return a ? { ...h, audit: a } : h
        }),
      )
    },
    async resolve(id) {
      const m = SKILLS_SH_ID.exec(id)
      if (!m) throw new Error(`not a skills.sh skill: ${id} (owner/repo/skill)`)
      const found = await audit(id).catch(() => undefined)
      return {
        origin: { kind: 'git', url: `${gitHost}/${m[1]}/${m[2]}.git` },
        opts: { pick: m[3] ?? '', ...(found ? { audit: found } : {}) },
      }
    },
  }
}

// ── ClawHub ──────────────────────────────────────────────────────────

/** `owner/slug`: ClawHub's slugs are unique only per owner. */
const CLAWHUB_ID = /^(\w[\w.-]*)\/([a-z0-9][a-z0-9_.-]*)$/i

/** ClawHub's trust block on a search result: its own verdict, the upstream scanners', and its suspicious flag. */
function clawhubTrust(trust: Record<string, unknown>, suspicious: boolean, url: string): SkillAudit {
  const checks = Object.entries(obj(trust.upstreamScanners)).map(([name, v]) => ({
    name,
    status: statusOf(obj(v).status),
  }))
  const verdict = str(trust.clawHubVerdict)
  if (verdict) checks.unshift({ name: 'ClawHub', status: statusOf(verdict) })
  const status = suspicious ? 'fail' : worst(checks)
  return { by: 'ClawHub', status, url, checks, ...(suspicious ? { summary: 'flagged as suspicious' } : {}) }
}

/**
 * ClawHub (OpenClaw's registry). Skills are fetched file by file from the version ClawHub lists, each checked against
 * its sha256, after reading ClawHub's moderation state and security scans: a skill it blocks as malware is refused,
 * one it flags as suspicious is staged with that flag, which blocks it until the person installs it anyway.
 */
function clawhubSource(http: Http, base: string, installer: SkillInstaller): Adapter {
  const api = (path: string, query: Record<string, string>) => {
    const url = new URL(`${base}/api/v1${path}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    return url.href
  }
  const page = (owner: string, slug: string) => `${base}/${owner}/skills/${slug}`
  const parse = (id: string) => {
    const m = CLAWHUB_ID.exec(id)
    if (!m) throw new Error(`not a ClawHub skill: ${id} (owner/slug)`)
    return { owner: m[1] ?? '', slug: m[2] ?? '' }
  }

  installer.markets.set('clawhub', async (id, dest) => {
    const { owner, slug } = parse(id)
    const detail = obj(await http.json(api(`/skills/${slug}`, { owner }), 'ClawHub'))
    const moderation = obj(detail.moderation)
    if (moderation.isMalwareBlocked === true) throw new Error(`ClawHub blocks ${id} as malware`)
    const version = str(obj(detail.latestVersion).version)
    if (!version) throw new Error(`${id} has no published version on ClawHub`)
    const meta = obj(
      obj(await http.json(api(`/skills/${slug}/versions/${version}`, { owner }), 'ClawHub')).version,
    )
    const files = arr(meta.files).map((f) => obj(f))
    if (!files.length) throw new Error(`${id}@${version} lists no files`)
    if (files.length > CLAWHUB_MAX_FILES) throw new Error(`${id} has more than ${CLAWHUB_MAX_FILES} files`)
    if (files.reduce((n, f) => n + (num(f.size) ?? 0), 0) > INSTALL_MAX_BYTES)
      throw new Error(`${id} is larger than ${INSTALL_MAX_BYTES} bytes`)
    mkdirSync(dest, { recursive: true })
    for (const f of files) {
      const path = str(f.path)
      const sha = str(f.sha256)?.toLowerCase()
      const target = path ? resolve(dest, path) : dest
      if (!path || !sha || target === dest || !isWithin(dest, target))
        throw new Error(`${id} lists a file it cannot have: ${path ?? '?'}`)
      const res = await http.get(api(`/skills/${slug}/file`, { owner, path, version }), 'ClawHub')
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (createHash('sha256').update(bytes).digest('hex') !== sha)
        throw new Error(`${path} does not match the hash ClawHub lists for it; nothing was installed`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes, { flag: 'wx' })
    }
    const security = obj(meta.security)
    const scanners = Object.entries(obj(security.scanners)).map(([name, v]) => {
      const x = obj(v)
      const summary = str(x.summary)
      return {
        name,
        status: statusOf(x.normalizedStatus ?? x.status ?? x.verdict),
        ...(summary ? { summary } : {}),
      }
    })
    const verdict = str(moderation.verdict) ?? str(security.status)
    const suspicious =
      moderation.isSuspicious === true || ['suspicious', 'malicious'].includes(str(security.status) ?? '')
    const checks = verdict ? [{ name: 'ClawHub', status: statusOf(verdict) }, ...scanners] : scanners
    const summary = str(moderation.summary)
    const audit: SkillAudit = {
      by: 'ClawHub',
      status: suspicious ? 'fail' : worst(checks),
      url: page(owner, slug),
      checks,
      ...(summary ? { summary } : {}),
    }
    const pin: InstallPin = { version }
    return suspicious
      ? { pin, audit, flagged: summary ?? `ClawHub: ${verdict ?? 'suspicious'}` }
      : { pin, audit }
  })

  const fromList = (item: unknown): MarketHit[] => {
    const x = obj(item)
    const owner = str(x.ownerHandle)
    const slug = str(x.slug)
    if (!owner || !slug) return []
    const latest = obj(x.latestVersion)
    const stats = obj(x.stats)
    return [
      {
        source: 'clawhub',
        id: `${owner}/${slug}`,
        name: slug,
        description: str(x.summary) ?? '',
        author: owner,
        ...(str(latest.version) ? { version: str(latest.version) } : {}),
        ...(str(latest.license) ? { license: str(latest.license) } : {}),
        ...(num(stats.installs) !== undefined ? { installs: num(stats.installs) } : {}),
        ...(num(stats.stars) !== undefined ? { stars: num(stats.stars) } : {}),
        url: page(owner, slug),
        installRef: `clawhub:${owner}/${slug}`,
      },
    ]
  }

  return {
    id: 'clawhub',
    name: 'ClawHub',
    url: base,
    optIn: true,
    views: ['trending', 'popular', 'recent'],
    async browse(view) {
      const sort = view === 'popular' ? 'downloads' : view === 'recent' ? 'newest' : 'trending'
      const body = obj(await http.json(api('/skills', { sort, limit: String(MARKET_RESULTS) }), 'ClawHub'))
      return arr(body.items).flatMap(fromList)
    },
    async search(q) {
      const body = obj(await http.json(api('/search', { q, limit: String(MARKET_RESULTS) }), 'ClawHub'))
      return arr(body.results).flatMap((r): MarketHit[] => {
        const x = obj(r)
        // Results mirrored from other registries (skills.sh) are installed from there, not here.
        if (obj(x.install).kind !== 'clawhub') return []
        const native = obj(obj(x.native).skill)
        const owner = str(x.ownerHandle) ?? str(obj(x.owner).handle)
        const slug = str(x.slug)
        if (!owner || !slug) return []
        const stats = obj(native.stats)
        const flagged = native.isSuspicious === true
        return [
          {
            source: 'clawhub',
            id: `${owner}/${slug}`,
            name: slug,
            description: str(x.summary) ?? '',
            author: owner,
            ...(num(stats.installs) !== undefined ? { installs: num(stats.installs) } : {}),
            ...(num(stats.stars) !== undefined ? { stars: num(stats.stars) } : {}),
            url: page(owner, slug),
            audit: clawhubTrust(obj(x.trust), flagged, page(owner, slug)),
            ...(flagged ? { flagged } : {}),
            installRef: `clawhub:${owner}/${slug}`,
          },
        ]
      })
    },
    async resolve(id) {
      parse(id)
      return { origin: { kind: 'market', source: 'clawhub', id } }
    },
  }
}

// ── the marketplace ──────────────────────────────────────────────────

type Cached = <T>(key: string, load: () => Promise<T>) => Promise<T>

export class SkillMarketplace {
  private readonly _sources: Adapter[]
  private readonly _cache = new Map<string, { until: number; value: Promise<unknown> }>()
  private readonly _toggles: SourceToggles

  constructor(
    home: string,
    private readonly installer: SkillInstaller,
    opts: MarketOptions = {},
  ) {
    const http = new Http(opts.fetchFn ?? ((...a) => fetch(...a)))
    let mine: Record<string, boolean> = {}
    this._toggles = opts.toggles ?? {
      get: () => mine,
      set: (next) => {
        mine = next
      },
    }
    const cached: Cached = (key, load) => this._cached(key, load)
    const catalogs = join(home, 'marketplaces', '.skills')
    this._sources = [
      ompSource(installer),
      new GitCatalog(
        'openai',
        'OpenAI',
        'https://github.com/openai/skills',
        opts.openaiRepo ?? OPENAI_SKILLS_REPO,
        ['skills/.curated', 'skills/.system'],
        catalogs,
      ),
      new GitCatalog(
        'anthropic',
        'Anthropic',
        'https://github.com/anthropics/skills',
        opts.anthropicRepo ?? ANTHROPIC_SKILLS_REPO,
        ['skills'],
        catalogs,
      ),
      skillsShSource(http, cached, opts.skillsShUrl ?? SKILLS_SH_URL, opts.gitHost ?? 'https://github.com'),
      clawhubSource(http, opts.clawhubUrl ?? CLAWHUB_URL, installer),
    ]
  }

  sources(): SkillSourceInfo[] {
    const chosen = this._toggles.get()
    return this._sources.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      enabled: chosen[s.id] ?? !s.optIn,
      optIn: !!s.optIn,
      views: s.views,
    }))
  }

  setEnabled(id: string, enabled: boolean): SkillSourceInfo[] {
    this._source(id)
    this._toggles.set({ ...this._toggles.get(), [id]: enabled })
    return this.sources()
  }

  /** One source's list (popular, trending, recent, or everything a catalog holds). */
  async browse(source: string, view: SkillView): Promise<MarketResults> {
    const s = this._enabled(source)
    if (!s.views.includes(view)) throw new Error(`${s.name} has no ${view} list`)
    try {
      return { hits: await this._cached(`${s.id}:browse:${view}`, () => s.browse(view)), errors: [] }
    } catch (err) {
      return { hits: [], errors: [{ source: s.id, error: err instanceof Error ? err.message : String(err) }] }
    }
  }

  /** Searches the enabled sources (or those named), each on its own: one failing is listed with the others' hits. */
  async search(q: string, only?: readonly string[]): Promise<MarketResults> {
    const query = q.trim()
    if (!query) return { hits: [], errors: [] }
    for (const id of only ?? []) this._source(id)
    const enabled = new Set(
      this.sources()
        .filter((s) => s.enabled)
        .map((s) => s.id),
    )
    const asked = this._sources.filter((s) => enabled.has(s.id) && (!only?.length || only.includes(s.id)))
    const answers = await Promise.allSettled(
      asked.map((s) => this._cached(`${s.id}:search:${query.toLowerCase()}`, () => s.search(query))),
    )
    const hits: MarketHit[] = []
    const errors: MarketResults['errors'] = []
    answers.forEach((a, i) => {
      const id = asked[i]?.id ?? '?'
      if (a.status === 'fulfilled') hits.push(...a.value)
      else errors.push({ source: id, error: a.reason instanceof Error ? a.reason.message : String(a.reason) })
    })
    return { hits, errors }
  }

  /**
   * Fetches a skill a source lists (`source:id`) for the person to review: staged, scanned and shown as any install
   * is, with the source's audit beside the scan.
   */
  async prepare(ref: string): Promise<SkillPreview> {
    const { source, id } = parseMarketRef(
      ref,
      this._sources.map((s) => s.id),
    )
    const s = this._enabled(source)
    const { origin, opts } = await s.resolve(id)
    return this.installer.prepareFrom(origin, opts)
  }

  private _source(id: string): Adapter {
    const s = this._sources.find((x) => x.id === id)
    if (!s) throw new Error(`no skill source ${id}: ${this._sources.map((x) => x.id).join(', ')}`)
    return s
  }

  private _enabled(id: string): Adapter {
    const s = this._source(id)
    if (!this.sources().find((x) => x.id === id)?.enabled)
      throw new Error(`${s.name} is off: turn it on in Settings → Skills first`)
    return s
  }

  private _cached<T>(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
    const hit = this._cache.get(key)
    if (hit && hit.until > now) return hit.value as Promise<T>
    for (const [k, v] of this._cache) if (v.until <= now) this._cache.delete(k)
    const value = load()
    this._cache.set(key, { until: now + MARKET_CACHE_MS, value })
    value.catch(() => this._cache.delete(key))
    return value
  }
}

/** `source:id` → its parts, for the sources given. */
export function parseMarketRef(ref: string, sources: readonly string[]): { source: string; id: string } {
  const s = ref.trim()
  const at = s.indexOf(':')
  const source = at > 0 ? s.slice(0, at) : ''
  const id = s.slice(at + 1).trim()
  if (!sources.includes(source) || !id)
    throw new Error(`give <source>:<id>, the source one of ${sources.join(', ')}`)
  return { source, id }
}
