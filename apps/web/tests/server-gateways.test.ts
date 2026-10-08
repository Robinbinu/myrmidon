import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlobStore, colonyId, SqliteLogStore } from '@myrmidon/core'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop().catch(() => {})
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'myr-gw-'))
  homes.push(dir)
  return dir
}

const COLONY = 'calc-muwf7asm-25d13a'

/** A remote gateway with one agent-built page in it, reached on loopback the way a hub on the same box would. */
async function remoteGateway() {
  const dir = home()
  const store = new SqliteLogStore(dir)
  const id = colonyId(COLONY)
  const blobs = new BlobStore(join(store.colonyDir(id), 'blobs'))
  const page = await blobs.put('<!doctype html><title>Calc</title><script src="calc.js"></script>')
  await store.append(id, [
    {
      colonyId: id,
      id: 'evt-artifact-1' as never,
      time: new Date().toISOString(),
      type: 'artifact/versioned',
      actor: { kind: 'agent', id: 'ui' },
      trace: { traceId: 't1', spanId: 's1' },
      schema: 1,
      payload: {
        name: 'index.html',
        version: 1,
        blob: page.hash,
        size: page.size,
        author: 'ui',
        mediaType: 'text/html',
      },
    } as never,
  ])
  store.close()
  const server = startServer({ home: dir, port: 0, publicUrl: 'https://box.example.ts.net' })
  servers.push(server)
  const origin = new URL(server.url).origin
  const pairLink = (scope: 'full' | 'chat' = 'full') => `${origin}/#pair=${server.pairingLink(scope).code}`
  return { server, home: dir, origin, pairLink }
}

function hub() {
  const dir = home()
  const server = startServer({ home: dir, port: 0 })
  servers.push(server)
  const origin = new URL(server.url).origin
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${origin}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${server.token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    })
  return { server, home: dir, origin, call }
}

type Listed = {
  id: string
  name: string
  url: string
  scope: string
  token?: string
  health: { ok: boolean; error?: string }
}

test('a hub pairs with a gateway, keeps its token to itself, and reaches it over HTTP and sockets', async () => {
  const remote = await remoteGateway()
  const h = hub()

  const added = await h.call('/api/gateways', {
    method: 'POST',
    body: JSON.stringify({ link: remote.pairLink(), name: 'box' }),
  })
  expect(added.status).toBe(200)
  const { gateway } = (await added.json()) as { gateway: Listed }
  expect(gateway).toMatchObject({ name: 'box', url: remote.origin, scope: 'full', health: { ok: true } })
  expect(gateway.token).toBeUndefined()

  // The token lives only in the hub's own file, readable by this user alone.
  const file = join(h.home, 'gateways.json')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readFileSync(file, 'utf8')).toContain('"token"')
  const listed = (await (await h.call('/api/gateways')).json()) as { gateways: Listed[] }
  expect(JSON.stringify(listed)).not.toContain('"token"')

  // Requests go through as the hub's device on the gateway.
  const me = (await (await h.call(`/gw/${gateway.id}/api/whoami`)).json()) as {
    remote: boolean
    device: { name: string }
  }
  expect(me.remote).toBe(true)
  expect(me.device.name).toStartWith('Myrmidon on ')

  // Only the gateway's API: no escaping it, and no gateway the hub does not know.
  expect((await h.call(`/gw/${gateway.id}/index.html`)).status).toBe(404)
  expect((await h.call(`/gw/${gateway.id}/api/../index.html`)).status).toBe(404)
  expect((await h.call('/gw/gw-unknown/api/whoami')).status).toBe(404)

  // A socket is carried through, frame for frame.
  const ws = new WebSocket(
    `${h.origin.replace('http', 'ws')}/gw/${gateway.id}/api/health/socket?token=${h.server.token}`,
    {
      headers: { origin: h.origin },
    } as never,
  )
  const first = await new Promise<string>((resolve, reject) => {
    ws.onmessage = (e) => resolve(String(e.data))
    ws.onerror = () => reject(new Error('socket failed'))
  })
  expect(first).toBe('ok')
})

test("a gateway's pages open on the hub's preview origin, with the hub's own preview key", async () => {
  const remote = await remoteGateway()
  const h = hub()
  const { gateway } = (await (
    await h.call('/api/gateways', { method: 'POST', body: JSON.stringify({ link: remote.pairLink() }) })
  ).json()) as { gateway: Listed }

  const config = (await (await h.call(`/gw/${gateway.id}/api/config`)).json()) as {
    previewOrigin: string
    previewToken: string
  }
  expect(config.previewOrigin).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/gw/${gateway.id}$`))
  const page = await fetch(`${config.previewOrigin}/${COLONY}/${config.previewToken}/index.html`)
  expect(page.status).toBe(200)
  expect(page.headers.get('content-type')).toStartWith('text/html')
  expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'")
  expect(await page.text()).toContain('<title>Calc</title>')
  expect((await fetch(`${config.previewOrigin}/${COLONY}/local.forged/index.html`)).status).toBe(401)

  // On the gateway's own origin the same artifact is inert text, never a page.
  const raw = await h.call(`/gw/${gateway.id}/api/colonies/${COLONY}/artifacts/index.html`)
  expect(raw.headers.get('content-type')).toStartWith('text/plain')
  expect(raw.headers.get('content-security-policy')).toContain('sandbox')
})

test('removing a gateway unpairs the hub there; an unreachable one says so', async () => {
  const remote = await remoteGateway()
  const h = hub()
  const { gateway } = (await (
    await h.call('/api/gateways', { method: 'POST', body: JSON.stringify({ link: remote.pairLink('chat') }) })
  ).json()) as { gateway: Listed }
  expect(gateway.scope).toBe('chat')
  // Pairing the same gateway twice is refused.
  const again = await h.call('/api/gateways', {
    method: 'POST',
    body: JSON.stringify({ link: remote.pairLink() }),
  })
  expect(again.status).toBe(409)

  expect((await h.call(`/api/gateways/${gateway.id}`, { method: 'DELETE' })).status).toBe(200)
  const devices = (await (
    await fetch(`${remote.origin}/api/devices`, {
      headers: { authorization: `Bearer ${remote.server.token}` },
    })
  ).json()) as { devices: unknown[] }
  expect(devices.devices).toEqual([])
  expect((await h.call(`/gw/${gateway.id}/api/whoami`)).status).toBe(404)

  // A gateway that goes away keeps its place, with the reason.
  const other = await remoteGateway()
  const { gateway: second } = (await (
    await h.call('/api/gateways', { method: 'POST', body: JSON.stringify({ link: other.pairLink() }) })
  ).json()) as { gateway: Listed }
  await other.server.stop()
  expect((await h.call(`/gw/${second.id}/api/whoami`)).status).toBe(502)
})

test('a wrong pairing link or code is refused with a reason', async () => {
  const remote = await remoteGateway()
  const h = hub()
  const bad = async (link: string) =>
    (
      (await (await h.call('/api/gateways', { method: 'POST', body: JSON.stringify({ link }) })).json()) as {
        error: string
      }
    ).error
  expect(await bad('not a link')).toContain('pairing link')
  expect(await bad(remote.origin)).toContain('no pairing code')
  expect(await bad(`${remote.origin}/#pair=WRONGCODE1`)).toContain('wrong, used or expired')
})
