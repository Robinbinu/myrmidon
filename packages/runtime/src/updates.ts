import { MYRMIDON_REPO, MYRMIDON_VERSION, UPDATE_CHECK_TIMEOUT_MS, UPDATE_CHECK_TTL_MS } from './config.ts'
import type { FetchFn } from './install-sources.ts'

export { MYRMIDON_VERSION }

/**
 * Whether a newer Myrmidon has been released: the latest GitHub release of the repository, compared with this build.
 * It only reads; installing stays the person's choice (the release page has the download and its notes).
 */
export type UpdateCheck =
  | { status: 'current'; current: string; latest: string; checkedAt: number }
  | {
      status: 'available'
      current: string
      latest: string
      url: string
      publishedAt?: string
      checkedAt: number
    }
  /** GitHub has no release to compare with yet (none published, or the repository is not public). */
  | { status: 'none'; current: string; checkedAt: number }
  | { status: 'unreachable'; current: string; error: string; checkedAt: number }

interface Release {
  tag_name?: unknown
  html_url?: unknown
  published_at?: unknown
}

export class UpdateChecker {
  private _last: UpdateCheck | undefined

  constructor(
    private readonly o: {
      fetch?: FetchFn
      now?: () => number
      repo?: string
      current?: string
    } = {},
  ) {}

  /** The last answer while it is fresh, unless `force`; a failed check is never reused. */
  async check(force = false): Promise<UpdateCheck> {
    const now = (this.o.now ?? Date.now)()
    const last = this._last
    if (!force && last && last.status !== 'unreachable' && now - last.checkedAt < UPDATE_CHECK_TTL_MS)
      return last
    this._last = await this._ask(now)
    return this._last
  }

  private async _ask(checkedAt: number): Promise<UpdateCheck> {
    const current = this.o.current ?? MYRMIDON_VERSION
    const repo = this.o.repo ?? MYRMIDON_REPO
    const fetch = this.o.fetch ?? globalThis.fetch
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `myrmidon/${current}` },
        signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
      })
      if (res.status === 404) return { status: 'none', current, checkedAt }
      if (!res.ok)
        return { status: 'unreachable', current, error: `GitHub answered ${res.status}`, checkedAt }
      const release = (await res.json()) as Release
      const latest = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : ''
      // GitHub's latest release is never a draft or a pre-release; a tag that is not a version cannot be compared.
      if (!/^\d+\.\d+\.\d+/.test(latest)) return { status: 'none', current, checkedAt }
      if (Bun.semver.order(latest, current) <= 0) return { status: 'current', current, latest, checkedAt }
      return {
        status: 'available',
        current,
        latest,
        url:
          typeof release.html_url === 'string'
            ? release.html_url
            : `https://github.com/${repo}/releases/latest`,
        ...(typeof release.published_at === 'string' ? { publishedAt: release.published_at } : {}),
        checkedAt,
      }
    } catch (err) {
      return {
        status: 'unreachable',
        current,
        error: err instanceof Error ? err.message : String(err),
        checkedAt,
      }
    }
  }
}
