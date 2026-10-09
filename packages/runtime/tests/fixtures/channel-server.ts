import { tmpdir } from 'node:os'
import type { AdapterIO, AdapterStatus, Inbound } from '../../src/channels/index.ts'

/** What tests of the webhook channels (Teams, Google Chat, LINE) share: a fake platform, keys, an AdapterIO. */

export interface Call {
  method: string
  path: string
  query: URLSearchParams
  headers: Headers
  body: unknown
  text: string
}

type Handler = (call: Call) => Response | unknown | Promise<Response | unknown>

/** A stand-in platform: routes by `METHOD /path` (a `*` matches the rest); every call is recorded. */
export function fakeServer(routes: Record<string, Handler>) {
  const calls: Call[] = []
  const server = Bun.serve({
    // The address the adapters dial. Bound to the default dual-stack wildcard, a fake can be handed a port another
    // process (a browser, say) holds on 127.0.0.1 alone, and that process answers instead of the fake.
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        if (req.headers.get('content-type')?.includes('form'))
          body = Object.fromEntries(new URLSearchParams(text))
      }
      const call: Call = {
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
        text,
      }
      calls.push(call)
      const key = `${req.method} ${url.pathname}`
      const route = Object.entries(routes).find(([pattern]) =>
        pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern,
      )
      if (!route) return new Response('no route', { status: 404 })
      const answer = await route[1](call)
      return answer instanceof Response ? answer : Response.json(answer)
    },
  })
  return { server, calls, base: `http://127.0.0.1:${server.port}` }
}

/** An RSA key pair: the public half as a JWK (with a `kid`), the private half as PKCS #8 PEM. */
export async function rsaKey(kid: string, extra: Record<string, unknown> = {}) {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, use: 'sig', ...extra }
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`
  return { jwk, pem, kid }
}

export const now = () => Math.floor(Date.now() / 1000)

/** `dir` is the channel's own folder; a test that keeps files there (hosted links) passes a fresh one. */
export function testIO(webhookUrl?: string, dir = tmpdir()) {
  const received: Inbound[] = []
  const statuses: AdapterStatus[] = []
  const logs: string[] = []
  const kv = new Map<string, string>()
  let onReceive: ((m: Inbound) => void) | undefined
  const handle: AdapterIO = {
    receive: async (m) => {
      received.push(m)
      onReceive?.(m)
    },
    get: (k) => kv.get(k),
    set: (k, v) => kv.set(k, v),
    status: (s) => statuses.push(s),
    log: (m) => logs.push(m),
    dir,
    ...(webhookUrl ? { webhookUrl } : {}),
  }
  return {
    handle,
    received,
    statuses,
    logs,
    kv,
    onReceive: (f: (m: Inbound) => void) => {
      onReceive = f
    },
  }
}

export async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}
