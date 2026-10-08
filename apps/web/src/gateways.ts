import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { DeviceScope } from './devices.ts'
import { writePrivateJson } from './devices.ts'

/**
 * Other Myrmidon gateways this one reaches on the person's behalf (it is their hub): the page switches between them,
 * and the hub forwards its requests with each gateway's device token, which the page never sees.
 */

export interface Gateway {
  readonly id: string
  readonly name: string
  /** The gateway's origin, e.g. `https://box.tail1234.ts.net`; the only place requests for it go. */
  readonly url: string
  /** This hub's device token there. */
  readonly token: string
  readonly scope: DeviceScope
  /** This hub's device id there, so removing the gateway can unpair it. */
  readonly deviceId: string
  readonly addedAt: string
}

/** What the page sees of a gateway: everything but its token. */
export type GatewayInfo = Omit<Gateway, 'token'>

/** Whether a gateway answers over HTTP and over a socket (many failures, e.g. a proxy, break only sockets). */
export interface GatewayHealth {
  readonly ok: boolean
  readonly error?: string
  readonly checkedAt: string
}

const HEALTH_MS = 5000
/** Requests through the hub give up eventually rather than hang the page. */
export const FORWARD_MS = 120_000

/** `<home>/gateways.json`, readable only by this user (it holds device tokens). */
export class GatewayStore {
  private readonly _file: string

  constructor(home: string) {
    this._file = join(home, 'gateways.json')
  }

  list(): Gateway[] {
    if (!existsSync(this._file)) return []
    try {
      const raw = JSON.parse(readFileSync(this._file, 'utf8')) as unknown
      return Array.isArray(raw) ? (raw as Gateway[]).filter((g) => g && typeof g.token === 'string') : []
    } catch {
      return []
    }
  }

  get(id: string): Gateway | undefined {
    return this.list().find((g) => g.id === id)
  }

  add(gateway: Omit<Gateway, 'id' | 'addedAt'>): Gateway {
    const added: Gateway = {
      ...gateway,
      id: `gw-${randomBytes(4).toString('hex')}`,
      addedAt: new Date().toISOString(),
    }
    writePrivateJson(this._file, [...this.list(), added])
    return added
  }

  remove(id: string): boolean {
    const all = this.list()
    const rest = all.filter((g) => g.id !== id)
    if (rest.length === all.length) return false
    writePrivateJson(this._file, rest)
    return true
  }
}

export const shown = ({ token: _token, ...info }: Gateway): GatewayInfo => info

/** A pairing link (`https://box/#pair=CODE`), or an address plus a code typed separately. */
export function parsePairing(link: string, code?: string): { origin: string; code: string } {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    throw new Error('paste the whole pairing link, starting with https:// (or http://)')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('a gateway address is http(s)')
  const given = code?.trim() || new URLSearchParams(url.hash.slice(1)).get('pair') || ''
  if (!given) throw new Error('that link has no pairing code; make one with `myrmidon pair` on the gateway')
  return { origin: url.origin, code: given }
}

/** Authorization for a request this hub makes to a gateway as its paired device. */
export const asDevice = (g: Gateway) => ({ authorization: `Device ${g.token}` })

/** Pairs this hub with a gateway and returns what to store. */
export async function pairWith(
  link: string,
  options: { code?: string; name?: string },
): Promise<Omit<Gateway, 'id' | 'addedAt'>> {
  const { origin, code } = parsePairing(link, options.code)
  let res: Response
  try {
    res = await fetch(`${origin}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: `Myrmidon on ${hostname()}`, hub: true }),
      signal: AbortSignal.timeout(HEALTH_MS * 3),
    })
  } catch (err) {
    throw new Error(`cannot reach ${origin}: ${reason(err)}`)
  }
  const data = (await res.json().catch(() => ({}))) as {
    error?: string
    token?: string
    device?: { id: string; scope: DeviceScope }
  }
  if (!res.ok || !data.token || !data.device)
    throw new Error(data.error ?? `${origin} did not pair (${res.status}); is it a Myrmidon gateway?`)
  const host = new URL(origin).hostname
  return {
    // `box` from box.tail1234.ts.net; an address stays whole.
    name: options.name?.trim() || (/^[\d.]+$|:/.test(host) ? host : (host.split('.')[0] ?? host)),
    url: origin,
    token: data.token,
    scope: data.device.scope,
    deviceId: data.device.id,
  }
}

/** Unpairs this hub on the gateway, when it can be reached; forgetting it locally does not wait on this. */
export async function unpair(g: Gateway): Promise<void> {
  await fetch(`${g.url}/api/pair/self`, {
    method: 'DELETE',
    headers: asDevice(g),
    signal: AbortSignal.timeout(HEALTH_MS),
  }).catch(() => {})
}

const reason = (err: unknown) => {
  if (!(err instanceof Error)) return String(err)
  if (err.name === 'TimeoutError') return 'no answer'
  // Bun's wording for a refused or unroutable connection.
  if (/unable to connect/i.test(err.message))
    return 'nothing answers at that address (is it running, and reachable from here?)'
  return err.message
}

export const socketUrl = (g: Gateway, path: string) => `${g.url.replace(/^http/, 'ws')}${path}`

/** Checks a gateway over HTTP, then over a socket. */
export async function checkHealth(g: Gateway): Promise<GatewayHealth> {
  const checkedAt = new Date().toISOString()
  try {
    const res = await fetch(`${g.url}/api/whoami`, {
      headers: asDevice(g),
      signal: AbortSignal.timeout(HEALTH_MS),
    })
    if (res.status === 401) return { ok: false, error: 'this hub is no longer paired there', checkedAt }
    if (!res.ok) return { ok: false, error: `it answered ${res.status}`, checkedAt }
  } catch (err) {
    return { ok: false, error: `unreachable: ${reason(err)}`, checkedAt }
  }
  const socket = await new Promise<string | undefined>((resolve) => {
    const ws = new WebSocket(socketUrl(g, '/api/health/socket'), {
      headers: { ...asDevice(g), origin: g.url },
    } as never)
    const timer = setTimeout(() => done('no answer'), HEALTH_MS)
    const done = (error?: string) => {
      clearTimeout(timer)
      ws.onclose = null
      ws.close()
      resolve(error)
    }
    ws.onmessage = () => done()
    ws.onerror = () => done('refused')
    ws.onclose = (e) => done(`closed (${e.code})`)
  })
  return socket
    ? { ok: false, error: `its address answers, but sockets do not get through: ${socket}`, checkedAt }
    : { ok: true, checkedAt }
}

/**
 * Where a request through the hub goes on the gateway: only its own `/api/` paths (no other host, and no escaping
 * the API with `..`). Undefined for anything else.
 */
export function forwardTarget(g: Gateway, rest: string, search: string): URL | undefined {
  const target = new URL(`${rest}${search}`, g.url)
  if (target.origin !== g.url || !target.pathname.startsWith('/api/')) return undefined
  // The page's own credentials for the hub are not the gateway's business.
  target.searchParams.delete('token')
  return target
}

/** Request headers worth passing on; cookies, the hub's authorization and hop-by-hop headers stay behind. */
export function forwardHeaders(req: Request, g: Gateway): Headers {
  const out = new Headers(asDevice(g))
  for (const name of ['content-type', 'accept', 'if-none-match', 'range']) {
    const value = req.headers.get(name)
    if (value) out.set(name, value)
  }
  return out
}

/** Response headers passed back; the body is re-streamed, so encodings and lengths are the hub's to set. */
export function responseHeaders(res: Response): Headers {
  const out = new Headers()
  for (const [name, value] of res.headers) {
    if (
      ['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)
    )
      continue
    out.set(name, value)
  }
  return out
}

/** A socket close code the hub may pass on to the page (some are reserved for the browser itself). */
export function passableCode(code: number): number {
  return code === 1000 || code === 1001 || code === 1008 || code === 1011 || (code >= 3000 && code <= 4999)
    ? code
    : 1011
}
