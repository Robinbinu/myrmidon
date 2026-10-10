import { AsyncLocalStorage } from 'node:async_hooks'
import { lookup as dnsLookup } from 'node:dns/promises'
import { FETCH_MAX_REDIRECTS } from './config.ts'
import type { OmpRuntime, ReadResult } from './omp/runtime.ts'
import { prompts } from './prompts.ts'

/** Web access for agents, backed by omp's search providers and URL reader. */
export interface WebTools {
  search(
    query: string,
    options?: { limit?: number; recency?: 'day' | 'week' | 'month' | 'year' },
  ): Promise<string>
  /** Reads a URL; `localPorts` are the loopback ports the caller's run may reach besides the public internet. */
  read(url: string, localPorts?: LocalPorts): Promise<ReadResult>
}

// Agents must not reach the dashboard or other local and private services.
const PRIVATE_NAME = /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i
// mDNS and cloud-internal names; checked by name too, since what they resolve to depends on the network.
const PRIVATE_SUFFIX = /\.(local|internal)$/i

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

function isLiteral(host: string): boolean {
  return v4(host) !== undefined || v6(host) !== undefined
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

/** 127.0.0.0/8 or ::1, where a run's own dev servers listen. (IPv4-mapped forms are not accepted as loopback.) */
function isLoopbackAddress(ip: string): boolean {
  const n = v4(ip)
  if (n !== undefined) return n >>> 24 === 127
  const g = v6(ip)
  return g?.every((x, k) => x === (k === 7 ? 1 : 0)) ?? false
}

/** `localhost` and its subdomains, which RFC 6761 reserves for loopback; they are never looked up. */
function isLoopbackName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost')
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
  if (PRIVATE_NAME.test(host) || (isLiteral(host) && !isPublicAddress(host)))
    throw new Error('local and private network addresses cannot be fetched')
  return url.href
}

export type Lookup = (host: string) => Promise<string[]>

const systemLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address)

/**
 * The loopback ports a run may reach: the ones its own dev servers opened (start_server). `all` is full access: every
 * address, local and private ones included.
 */
export type LocalPorts = () => ReadonlySet<number> | 'all'

const NO_LOCAL_PORTS: LocalPorts = () => new Set()

/** An agent asked for an address it may not reach; the message says why, for the agent to read. */
export class UnreachableError extends Error {
  override readonly name = 'UnreachableError'
}

/**
 * The addresses `host:port` may be reached at, every one of them checked: public, or a loopback port in `localPorts`
 * named by `localhost` or a loopback literal (with full access, `all`, any address). Connect only to what this returns, so a second lookup (DNS rebinding)
 * cannot swap in another address. Throws `UnreachableError`, saying why, when any address is off limits.
 */
export async function reachableAddresses(
  host: string,
  port: number,
  localPorts: LocalPorts = NO_LOCAL_PORTS,
  lookup: Lookup = systemLookup,
): Promise<string[]> {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase()
  const literal = isLiteral(name)
  const loopbackName = !literal && isLoopbackName(name)
  const allowed = localPorts()
  if (allowed !== 'all' && !literal && !loopbackName && PRIVATE_SUFFIX.test(name))
    throw new UnreachableError(prompts.toolResults.privateAddress(name))
  const addresses = literal ? [name] : loopbackName ? ['127.0.0.1', '::1'] : await lookup(name)
  if (addresses.length === 0) throw new Error(`${name} did not resolve to any address`)
  if (allowed === 'all') return addresses
  for (const address of addresses) {
    if (isPublicAddress(address)) continue
    // Only a name that is plainly loopback reaches a dev server: a public name resolving to 127.0.0.1 does not.
    const ownServer = (literal || loopbackName) && isLoopbackAddress(address)
    if (ownServer && allowed.has(port)) continue
    throw new UnreachableError(
      ownServer ? prompts.toolResults.notYourServer(port) : prompts.toolResults.privateAddress(name, address),
    )
  }
  return addresses
}

/**
 * The refusal `reachableAddresses` would give a URL without looking its name up: a private literal, a local name,
 * or a loopback port the run did not open. Undefined for anything else, including names (they need the lookup).
 */
export function quickRefusal(
  url: URL,
  localPorts: LocalPorts = NO_LOCAL_PORTS,
): UnreachableError | undefined {
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return undefined
  const allowed = localPorts()
  if (allowed === 'all') return undefined
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (isLoopbackName(host) || (isLiteral(host) && isLoopbackAddress(host)))
    return allowed.has(urlPort(url))
      ? undefined
      : new UnreachableError(prompts.toolResults.notYourServer(urlPort(url)))
  if ((isLiteral(host) && !isPublicAddress(host)) || PRIVATE_SUFFIX.test(host))
    return new UnreachableError(prompts.toolResults.privateAddress(host))
  return undefined
}

/** The port a URL connects to. */
export function urlPort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80
}

/**
 * `reachableAddresses` for a whole URL, plus the checks that need no network: http(s) only, no credentials. For
 * tools to refuse a URL with a clear reason before handing it to something that would only say it failed.
 */
export async function assertReachableUrl(
  raw: string,
  localPorts: LocalPorts = NO_LOCAL_PORTS,
  lookup: Lookup = systemLookup,
): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`not a URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('only http(s) URLs can be fetched')
  if (url.username || url.password) throw new Error('URLs with credentials in them cannot be fetched')
  await reachableAddresses(url.hostname, urlPort(url), localPorts, lookup)
  return url
}

export interface PinOptions {
  readonly localPorts?: LocalPorts
  readonly lookup?: Lookup
  /** The fetch that sends the pinned request; the process's own, unguarded, by default. */
  readonly fetch?: typeof fetch
  readonly maxRedirects?: number
}

const unguardedFetch = globalThis.fetch
const REDIRECTS = new Set([301, 302, 303, 307, 308])
// Errors from failing to open a connection, before anything was sent: the next checked address may answer.
export const NOT_CONNECTED: ReadonlySet<string> = new Set([
  'ConnectionRefused',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
])

/** One request to `url`, sent to an address `reachableAddresses` checked, never to a fresh lookup of the name. */
async function sendPinned(
  url: URL,
  init: RequestInit,
  headers: Headers,
  options: PinOptions,
): Promise<Response> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('only http(s) URLs can be fetched')
  if (url.username || url.password) throw new Error('URLs with credentials in them cannot be fetched')
  const addresses = await reachableAddresses(url.hostname, urlPort(url), options.localPorts, options.lookup)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  // The certificate is still checked against the name; only the connection goes to the checked address.
  const tls = url.protocol === 'https:' && !isLiteral(host) ? { tls: { serverName: host } } : {}
  headers.set('host', url.host)
  let failure: unknown
  for (const address of addresses) {
    const pinned = new URL(url)
    pinned.hostname = address.includes(':') ? `[${address}]` : address
    try {
      return await (options.fetch ?? unguardedFetch)(pinned.href, {
        ...init,
        headers,
        redirect: 'manual',
        ...tls,
      } as RequestInit)
    } catch (err) {
      if (!NOT_CONNECTED.has((err as { code?: string }).code ?? '')) throw err
      failure = err
    }
  }
  throw failure
}

/**
 * `fetch` for agent-chosen URLs. The host is resolved once, every address it resolves to is checked, and the request
 * goes to a checked address, so DNS rebinding between the check and the connection cannot reach a private address.
 * Redirects are followed one hop at a time, each target checked before anything is sent to it. The response's `url`
 * is the URL as named (not the address it was sent to).
 */
export async function pinnedFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: PinOptions = {},
): Promise<Response> {
  const request = input instanceof Request ? input : undefined
  const merged: RequestInit = {
    ...(request
      ? {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: request.signal,
          redirect: request.redirect,
        }
      : {}),
    ...init,
  }
  let url = new URL(request ? request.url : String(input))
  let method = (merged.method ?? 'GET').toUpperCase()
  let body = merged.body
  const headers = new Headers(merged.headers)
  const mode = merged.redirect ?? 'follow'
  for (let hop = 0; ; hop++) {
    const response = await sendPinned(url, { ...merged, method, body: body ?? null }, headers, options)
    const location = REDIRECTS.has(response.status) ? response.headers.get('location') : null
    if (!location || mode === 'manual') {
      Object.defineProperty(response, 'url', { value: url.href })
      Object.defineProperty(response, 'redirected', { value: hop > 0 })
      return response
    }
    await response.body?.cancel().catch(() => {})
    if (mode === 'error') throw new TypeError(`${url.href} redirected to ${location}`)
    if (hop >= (options.maxRedirects ?? FETCH_MAX_REDIRECTS)) throw new Error('too many redirects')
    const next = new URL(location, url)
    // As the Fetch standard does: a 303, or a 301/302 after a POST, becomes a GET without a body.
    if (response.status === 303 ? method !== 'HEAD' : response.status <= 302 && method === 'POST') {
      method = 'GET'
      body = undefined
      for (const h of [
        'content-type',
        'content-length',
        'content-encoding',
        'content-language',
        'content-location',
      ])
        headers.delete(h)
    }
    if (next.origin !== url.origin)
      for (const h of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(h)
    url = next
  }
}

interface ReadScope extends PinOptions {
  /** Requests refused during the read, so a failed read can say why. */
  readonly refused: UnreachableError[]
}

const readScope = new AsyncLocalStorage<ReadScope>()
let guarded = false

/**
 * omp's reader calls the global `fetch` from many places (the page, its alternates, llms.txt, documents, site
 * readers) and can run lynx or trafilatura, which fetch on their own. Inside an agent's read, `fetch` becomes
 * `pinnedFetch` and starting programs is refused; everywhere else both behave as before.
 */
function guardProcess() {
  if (guarded) return
  guarded = true
  const scoped = (input: string | URL | Request, init?: RequestInit) => {
    const scope = readScope.getStore()
    if (!scope) return unguardedFetch(input, init)
    return pinnedFetch(input, init, scope).catch((err: unknown) => {
      if (err instanceof UnreachableError) scope.refused.push(err)
      throw err
    })
  }
  globalThis.fetch = Object.assign(scoped, { preconnect: unguardedFetch.preconnect }) as typeof fetch
  const spawn = Bun.spawn
  const spawnSync = Bun.spawnSync
  const refuse = () => {
    if (readScope.getStore()) throw new Error(prompts.toolResults.readerProgram)
  }
  Object.assign(Bun, {
    spawn: (...args: Parameters<typeof spawn>) => {
      refuse()
      return spawn(...args)
    },
    spawnSync: (...args: Parameters<typeof spawnSync>) => {
      refuse()
      return spawnSync(...args)
    },
  })
}

/** Runs `read` with every fetch it makes pinned and checked (see `pinnedFetch`) and no programs started. */
export async function withPinnedNetwork<T>(
  options: PinOptions,
  read: (refused: readonly UnreachableError[]) => Promise<T>,
): Promise<T> {
  guardProcess()
  const scope: ReadScope = { ...options, refused: [] }
  return readScope.run(scope, () => read(scope.refused))
}

/** `lookup` resolves host names (the system's by default; tests give a table, so they need no DNS). */
export function ompWebTools(
  omp: OmpRuntime,
  provider: () => string,
  lookup: Lookup = systemLookup,
): WebTools {
  return {
    search: (query, options = {}) => omp.search(query, { ...options, provider: provider() }),
    async read(url, localPorts = NO_LOCAL_PORTS) {
      const href = (await assertReachableUrl(url, localPorts, lookup)).href
      return withPinnedNetwork({ localPorts, lookup }, async (refused) => {
        const result = await omp.read(href)
        // The reader turns a refused request into "Failed to fetch"; the agent should hear why instead.
        const [first] = refused
        if (result.method === 'failed' && first) throw first
        return result
      })
    },
  }
}

/** For runs without the omp runtime (tests): every call explains why it is unavailable. */
export const noWebTools: WebTools = {
  search: () => Promise.reject(new Error('web search is not available in this run')),
  read: () => Promise.reject(new Error('web fetch is not available in this run')),
}
