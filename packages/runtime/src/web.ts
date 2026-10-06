import type { OmpRuntime, ReadResult } from './omp/runtime.ts'

/** Web access for agents, backed by omp's search providers and URL reader. */
export interface WebTools {
  search(
    query: string,
    options?: { limit?: number; recency?: 'day' | 'week' | 'month' | 'year' },
  ): Promise<string>
  read(url: string): Promise<ReadResult>
}

// Agents must not reach the dashboard or other local and private services.
const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.local|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i

export function assertPublicUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`not a URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('only http(s) URLs can be fetched')
  if (PRIVATE_HOST.test(url.hostname))
    throw new Error('local and private network addresses cannot be fetched')
  return url.href
}

export function ompWebTools(omp: OmpRuntime, provider: () => string): WebTools {
  return {
    search: (query, options = {}) => omp.search(query, { ...options, provider: provider() }),
    async read(url) {
      const result = await omp.read(assertPublicUrl(url))
      // A public URL may redirect; refuse content that ended up on a private host.
      assertPublicUrl(result.url)
      return result
    },
  }
}

/** For runs without the omp runtime (tests): every call explains why it is unavailable. */
export const noWebTools: WebTools = {
  search: () => Promise.reject(new Error('web search is not available in this run')),
  read: () => Promise.reject(new Error('web fetch is not available in this run')),
}
