import { lookup as dnsLookup } from 'node:dns/promises'
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
const PRIVATE_NAME = /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i

/** IPv4 ranges that are not the public internet (RFC 6890 special-purpose registry, plus multicast and reserved). */
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

function v4(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return undefined
  return parts.reduce((n, p) => n * 256 + Number(p), 0)
}

/** The eight 16-bit groups of an IPv6 address, an embedded dotted IPv4 tail included. */
function v6(ip: string): number[] | undefined {
  let text = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1]
  if (tail) {
    const n = v4(tail)
    if (n === undefined) return undefined
    text = `${text.slice(0, -tail.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((g) =>
    /^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : Number.NaN,
  )
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : undefined
}

/** Whether an IP address is on the public internet: not loopback, private, link-local, reserved or multicast. */
export function isPublicAddress(ip: string): boolean {
  const n = v4(ip)
  if (n !== undefined)
    return !V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      return (n & mask) >>> 0 === ((v4(base) ?? 0) & mask) >>> 0
    })
  const g = v6(ip)
  if (!g) return false
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, h = 0, i = 0] = g
  // An IPv4 address carried in IPv6 (mapped ::ffff:a.b.c.d, or NAT64 64:ff9b::/96) is as public as that address.
  const embedded = `${h >>> 8}.${h & 255}.${i >>> 8}.${i & 255}`
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return isPublicAddress(embedded)
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return isPublicAddress(embedded)
  if (g.every((x, k) => x === (k === 7 ? 1 : 0)) || g.every((x) => x === 0)) return false // ::1, ::
  if ((a & 0xfe00) === 0xfc00) return false // unique local fc00::/7
  if ((a & 0xffc0) === 0xfe80) return false // link-local fe80::/10
  if ((a & 0xff00) === 0xff00) return false // multicast ff00::/8
  if (a === 0x2001 && b === 0x0db8) return false // documentation 2001:db8::/32
  return true
}

/** The checks that need no network: http(s) only, no credentials, and no host that is plainly local or private. */
export function assertPublicUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`not a URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('only http(s) URLs can be fetched')
  if (url.username || url.password) throw new Error('URLs with credentials in them cannot be fetched')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const literal = v4(host) !== undefined || v6(host) !== undefined
  if (PRIVATE_NAME.test(host) || (literal && !isPublicAddress(host)))
    throw new Error('local and private network addresses cannot be fetched')
  return url.href
}

export type Lookup = (host: string) => Promise<string[]>

const systemLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address)

/**
 * `assertPublicUrl`, and the host must resolve only to public addresses: a public name pointed at 127.0.0.1 or a
 * cloud metadata address is refused. (A server that answers differently on the next lookup can still slip past;
 * only a fetch pinned to the checked address would close that.)
 */
export async function assertPublicTarget(raw: string, lookup: Lookup = systemLookup): Promise<string> {
  const href = assertPublicUrl(raw)
  const host = new URL(href).hostname.replace(/^\[|\]$/g, '')
  if (v4(host) !== undefined || v6(host) !== undefined) return href
  for (const address of await lookup(host))
    if (!isPublicAddress(address)) throw new Error(`${host} resolves to ${address}, a private address`)
  return href
}

/**
 * Walks a URL's redirects one hop at a time, checking each target before anything is sent to it, and returns where
 * the chain ends. The reader then fetches that URL; its own redirects would otherwise go unchecked until the end.
 */
export async function followPublicRedirects(
  raw: string,
  options: { lookup?: Lookup; fetch?: typeof fetch; maxHops?: number } = {},
): Promise<string> {
  const fetcher = options.fetch ?? fetch
  let current = raw
  for (let hop = 0; hop <= (options.maxHops ?? 10); hop++) {
    current = await assertPublicTarget(current, options.lookup)
    const res = await fetcher(current, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    await res.body?.cancel().catch(() => {})
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) return current
    current = new URL(location, current).href
  }
  throw new Error('too many redirects')
}

export function ompWebTools(omp: OmpRuntime, provider: () => string): WebTools {
  return {
    search: (query, options = {}) => omp.search(query, { ...options, provider: provider() }),
    async read(url) {
      const result = await omp.read(await followPublicRedirects(url))
      // The reader follows redirects itself; refuse content that still ended up somewhere private.
      await assertPublicTarget(result.url)
      return result
    },
  }
}

/** For runs without the omp runtime (tests): every call explains why it is unavailable. */
export const noWebTools: WebTools = {
  search: () => Promise.reject(new Error('web search is not available in this run')),
  read: () => Promise.reject(new Error('web fetch is not available in this run')),
}
