import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserHub, findChrome } from '@myrmidon/runtime'
import { needsFull } from '../src/devices.ts'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
const hubs: BrowserHub[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of hubs.splice(0)) await h.close()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function serve(extra: { publicUrl?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'myr-person-browser-server-'))
  homes.push(home)
  const browser = new BrowserHub(join(home, 'browser'))
  hubs.push(browser)
  const server = startServer({ home, port: 0, browser, ...extra })
  servers.push(server)
  const base = new URL(server.url.replace(/#.*$/, ''))
  return { server, base }
}

/** Opens a socket and says how it ended, or that it opened. */
function attempt(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers } as never)
  return new Promise<{ open: true; ws: WebSocket } | { open: false; code: number }>((resolve) => {
    ws.onopen = () => resolve({ open: true, ws })
    ws.onclose = (e) => resolve({ open: false, code: e.code })
    ws.onerror = () => {}
  })
}

test("only full-access devices reach the person's browser; the agents' live view keeps its own rule", () => {
  for (const path of ['/api/browser', '/api/browser/tabs', '/api/browser/tabs/t1/live', '/api/browser/clear'])
    expect(needsFull('GET', path)).toBe(true)
  expect(needsFull('POST', '/api/browser/tabs/t1/go')).toBe(true)
  expect(needsFull('GET', '/api/colonies/c1/browser/wren')).toBe(false)
})

test("a chats-only device and a page of another site cannot drive the person's browser", async () => {
  const { server, base } = serve({ publicUrl: 'https://box.example.ts.net' })
  const publicHost = { host: 'box.example.ts.net', origin: 'https://box.example.ts.net' }
  const { code } = server.pairingLink('chat')
  const paired = await fetch(new URL('/api/pair', base), {
    method: 'POST',
    headers: publicHost,
    body: JSON.stringify({ code, name: 'Phone' }),
  })
  const cookie = (paired.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const asPhone = { ...publicHost, cookie }
  expect((await fetch(new URL('/api/browser', base), { headers: asPhone })).status).toBe(403)
  const opened = await fetch(new URL('/api/browser/tabs', base), {
    method: 'POST',
    headers: asPhone,
    body: JSON.stringify({ url: 'about:blank' }),
  })
  expect(opened.status).toBe(403)
  const live = `ws://${base.host}/api/browser/tabs/t1/live`
  expect(await attempt(live, asPhone)).toMatchObject({ open: false })
})

test.skipIf(!findChrome())(
  'the Browser view opens tabs, refuses file: and ports not allowed, streams a tab, saves a screenshot, and clears',
  async () => {
    const { server, base } = serve()
    const auth = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }
    const call = (method: string, path: string, body?: unknown) =>
      fetch(new URL(path, base), { method, headers: auth, ...(body ? { body: JSON.stringify(body) } : {}) })

    expect(await (await call('GET', '/api/browser')).json()).toMatchObject({
      tabs: [],
      settings: { cookies: 'quit', allowedSites: [], viewport: 'responsive' },
    })
    // This dashboard itself is always allowed.
    const own = await call('POST', '/api/browser/tabs', { url: `${base.host}/` })
    expect(own.status).toBe(200)
    const { tab } = (await own.json()) as { tab: { id: string; url: string } }
    expect(tab.url).toBe(`http://${base.host}/`)

    const file = await call('POST', `/api/browser/tabs/${tab.id}/go`, { url: 'file:///etc/passwd' })
    expect(file.status).toBe(400)
    expect(await file.json()).toMatchObject({ code: 'scheme' })
    const other = await call('POST', `/api/browser/tabs/${tab.id}/go`, { url: 'localhost:1' })
    expect(other.status).toBe(403)
    expect(await other.json()).toMatchObject({ code: 'blocked', site: 'localhost:1' })

    // A socket without an Origin is refused, like the terminal's; the dashboard's own page gets the stream.
    const live = `ws://${base.host}/api/browser/tabs/${tab.id}/live`
    expect(await attempt(live, { authorization: auth.authorization })).toMatchObject({ open: false })
    const watched = await attempt(live, { authorization: auth.authorization, origin: base.origin })
    if (!watched.open) throw new Error('the live socket did not open')
    const seen = new Set<string>()
    watched.ws.onmessage = (m) => seen.add((JSON.parse(String(m.data)) as { type: string }).type)
    watched.ws.send(JSON.stringify({ type: 'resize', width: 640, height: 480, scale: 1 }))
    for (let i = 0; i < 80 && !(seen.has('frame') && seen.has('tabs')); i++) await Bun.sleep(50)
    expect([...seen].sort()).toEqual(['frame', 'tabs'])
    watched.ws.close()

    const shot = await call('POST', `/api/browser/tabs/${tab.id}/screenshot`, {})
    expect(shot.headers.get('content-type')).toBe('image/png')
    expect(shot.headers.get('content-disposition')).toContain('attachment')

    const settings = await call('PUT', '/api/browser/settings', {
      cookies: 'never',
      allowedSites: ['localhost:3000', 'example.com'],
      viewport: 'phone',
    })
    expect(await settings.json()).toMatchObject({
      settings: { cookies: 'never', allowedSites: ['localhost:3000'], viewport: 'phone' },
    })
    expect((await call('POST', '/api/browser/clear', {})).status).toBe(200)
    expect(await (await call('DELETE', `/api/browser/tabs/${tab.id}`)).json()).toMatchObject({ tabs: [] })
  },
  60_000,
)
