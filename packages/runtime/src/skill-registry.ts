import { INSTALL_FETCH_TIMEOUT_MS, INSTALL_MAX_BYTES, SKILLS_REGISTRY_URL } from './config.ts'
import type { FetchFn } from './install-sources.ts'

/**
 * A read-only client for omp's skills registry (skills.omp.sh, "Skillshare"): search it, read a package's versions,
 * download one version's tarball. Ported from omp 18.8.7 (`pi-coding-agent/src/skillshare/client.ts` and
 * `installer.ts`, wire types from `pi-wire/src/skillshare.ts`): omp's client signs in through its own credential
 * store and settings, which Myrmidon does not use, and reading needs no sign-in.
 */

/** `@scope/name`, optionally `@version-or-range-or-tag` (omp's SKILL_SPEC_RE). */
const SPEC = /^@([a-z0-9][a-z0-9_]{2,31})\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:@(.+))?$/
const NAME_MAX = 64
/** `1.2.3`, `v1.2.3`, `1.2.3-beta.1+build`: an exact version rather than a range or tag. */
const EXACT = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/

export interface SkillSpec {
  scope: string
  name: string
  range?: string
}

/** Parses `@scope/name[@range]`; undefined when it is not a registry package. */
export function parseSkillSpec(spec: string): SkillSpec | undefined {
  const m = SPEC.exec(spec.trim())
  if (!m) return undefined
  const [, scope = '', name = '', range] = m
  if (name.length > NAME_MAX) return undefined
  return range === undefined ? { scope, name } : { scope, name, range }
}

export interface SkillUser {
  username: string
  avatar: string
}

export interface SkillSearchHit {
  scope: string
  name: string
  description: string
  keywords: string[]
  version: string
  publisher: SkillUser
  updatedAt: number
  weeklyDownloads: number
  deprecated?: string
}

export interface SkillSearchResponse {
  total: number
  page: number
  perPage: number
  hits: SkillSearchHit[]
}

export interface SkillVersionSummary {
  version: string
  publishedAt: number
  integrity: string
  size: number
  unpackedSize: number
  fileCount: number
  /** Ships executables or anything under `scripts/`. */
  hasScripts: boolean
  yanked: boolean
  deprecated?: string
}

export interface SkillPackument {
  scope: string
  name: string
  description: string
  distTags: Record<string, string>
  versions: Record<string, SkillVersionSummary>
}

export interface SkillHome {
  recent: SkillSearchHit[]
  popular: SkillSearchHit[]
  trending: SkillSearchHit[]
}

export interface SkillResolution {
  version: string
  summary: SkillVersionSummary
  /** Yanked or deprecated notices for the chosen version. */
  warnings: string[]
}

/**
 * Picks a version: an exact version (even yanked), a dist-tag's version, or the highest non-yanked version a range
 * allows. omp's `resolveSkillVersion`.
 */
export function resolveSkillVersion(packument: SkillPackument, request = 'latest'): SkillResolution {
  const id = `@${packument.scope}/${packument.name}`
  const exact = EXACT.exec(request)?.[1]
  let version: string | undefined
  if (exact !== undefined) {
    if (!Object.hasOwn(packument.versions, exact)) throw new Error(`${id}@${exact} does not exist`)
    version = exact
  } else if (Object.hasOwn(packument.distTags, request)) {
    version = packument.distTags[request]
  } else {
    for (const candidate in packument.versions) {
      if (packument.versions[candidate]?.yanked || !Bun.semver.satisfies(candidate, request)) continue
      if (version === undefined || Bun.semver.order(candidate, version) > 0) version = candidate
    }
    if (version === undefined) throw new Error(`no version of ${id} that is not yanked matches "${request}"`)
  }
  const summary = version ? packument.versions[version] : undefined
  if (!version || !summary) throw new Error(`${id}: "${request}" points at a version that does not exist`)
  const warnings: string[] = []
  if (summary.yanked) warnings.push(`${id}@${version} is yanked`)
  if (summary.deprecated) warnings.push(`${id}@${version} is deprecated: ${summary.deprecated}`)
  return { version, summary, warnings }
}

const pkg = (scope: string, name: string) => `/api/v1/skills/@${scope}/${name}`

export class SkillRegistryClient {
  readonly url: string

  constructor(
    url = SKILLS_REGISTRY_URL,
    private readonly fetchFn: FetchFn = (...a) => fetch(...a),
  ) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`not a skills registry URL: ${url}`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      throw new Error(`a skills registry URL must use http or https: ${url}`)
    this.url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  }

  /** `q` accepts `owner:<scope>` and `keyword:<kw>` filters. */
  search(q: string, page?: number): Promise<SkillSearchResponse> {
    return this._json('/api/v1/search', { q, ...(page !== undefined ? { page: String(page) } : {}) })
  }

  /** The registry's front page: recent, popular and trending skills. */
  home(): Promise<SkillHome> {
    return this._json('/api/v1/home')
  }

  packument(scope: string, name: string): Promise<SkillPackument> {
    return this._json(pkg(scope, name))
  }

  /** One version's `.tgz`, following the redirect to storage. Checking it against its integrity is the caller's job. */
  async tarball(scope: string, name: string, version: string): Promise<Uint8Array> {
    const res = await this._fetch(`${pkg(scope, name)}/versions/${encodeURIComponent(version)}/tarball`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length > INSTALL_MAX_BYTES) throw new Error(`@${scope}/${name}@${version} is too large`)
    return bytes
  }

  /** A package's page on the registry's website. */
  page(scope: string, name: string): string {
    return `${this.url}/@${scope}/${name}`
  }

  private async _json<T>(route: string, query?: Record<string, string>): Promise<T> {
    const res = await this._fetch(route, query)
    try {
      return (await res.json()) as T
    } catch {
      throw new Error(`the skills registry ${this.url} answered with something that is not JSON`)
    }
  }

  private async _fetch(route: string, query?: Record<string, string>): Promise<Response> {
    const url = new URL(`${this.url}${route}`)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
    let res: Response
    try {
      res = await this.fetchFn(url, {
        headers: { Accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(INSTALL_FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(
        `cannot reach the skills registry ${this.url}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null
      throw new Error(
        typeof body?.error === 'string'
          ? body.error
          : `the skills registry answered ${res.status} ${res.statusText || 'failed'}`,
      )
    }
    return res
  }
}
