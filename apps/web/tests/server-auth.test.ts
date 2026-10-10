import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { needsFull, PairingCodes } from '../src/devices.ts'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function serve(extra: Parameters<typeof startServer>[0] extends infer O ? Partial<O> : never = {}) {
  const home = mkdtempSync(join(tmpdir(), 'myr-auth-'))
  homes.push(home)
  const server = startServer({ home, port: 0, ...extra })
  servers.push(server)
  const base = new URL(server.url.replace(/#.*$/, ''))
  /** A request as a browser at `host` would send it (Host and Origin), with optional headers. */
  const call = (path: string, init: RequestInit & { host?: string; origin?: string } = {}) => {
    const host = init.host ?? base.host
    const headers = new Headers(init.headers)
    headers.set('host', host)
    if (init.origin !== undefined) headers.set('origin', init.origin)
    return fetch(new URL(path, base), { ...init, headers })
  }
  return { server, home, call, base }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

test('a local server answers its own token on loopback, and nothing that only resolves to it', async () => {
  const { server, call, base } = serve()
  expect(server.remote).toBe(false)
  expect((await call('/api/whoami', { headers: bearer(server.token) })).status).toBe(200)
  expect((await call('/api/whoami')).status).toBe(401)
  // DNS rebinding: a foreign name pointing at 127.0.0.1 is refused, token or not.
  expect(
    (await call('/api/whoami', { host: `evil.example:${base.port}`, headers: bearer(server.token) })).status,
  ).toBe(401)
  // A page on another origin cannot use the API either.
  expect(
    (await call('/api/whoami', { origin: 'https://evil.example', headers: bearer(server.token) })).status,
  ).toBe(401)
})

test('shutdown: only this server’s own token on loopback stops it, and only when it was given a way to stop', async () => {
  let stops = 0
  const { server, call, base } = serve({ onShutdown: () => stops++ })
  const post = { method: 'POST' }
  expect((await call('/api/shutdown', post)).status).toBe(401)
  expect((await call('/api/shutdown', { ...post, headers: bearer('wrong') })).status).toBe(401)
  expect(
    (
      await call('/api/shutdown', {
        ...post,
        host: `evil.example:${base.port}`,
        headers: bearer(server.token),
      })
    ).status,
  ).toBe(401)
  expect(
    (await call('/api/shutdown', { ...post, origin: 'https://evil.example', headers: bearer(server.token) }))
      .status,
  ).toBe(401)
  await Bun.sleep(10)
  expect(stops).toBe(0)
  expect((await call('/api/shutdown', { ...post, headers: bearer(server.token) })).status).toBe(202)
  await Bun.sleep(10)
  expect(stops).toBe(1)

  const plain = serve()
  expect((await plain.call('/api/shutdown', { ...post, headers: bearer(plain.server.token) })).status).toBe(
    401,
  )
  // Dev mode has no token to prove who is asking.
  const dev = serve({ noAuth: true, onShutdown: () => stops++ })
  expect((await dev.call('/api/shutdown', post)).status).toBe(401)
  await Bun.sleep(10)
  expect(stops).toBe(1)
})

test('a remote gateway refuses to run without auth', () => {
  expect(() => serve({ publicUrl: 'https://box.example.ts.net', noAuth: true })).toThrow('--dev')
})

test('pairing: a single-use code makes a device with its own cookie and scope; revoking it locks it out', async () => {
  const { server, call, home } = serve({ publicUrl: 'https://box.example.ts.net' })
  expect(server.remote).toBe(true)
  const publicHost = { host: 'box.example.ts.net', origin: 'https://box.example.ts.net' }
  // Remotely the CLI's token is not accepted: only a paired device gets in.
  expect((await call('/api/whoami', { ...publicHost, headers: bearer(server.token) })).status).toBe(401)

  const { code, link } = server.pairingLink('chat')
  expect(link).toBe(`https://box.example.ts.net/#pair=${code}`)
  const paired = await call('/api/pair', {
    ...publicHost,
    method: 'POST',
    body: JSON.stringify({ code, name: 'Phone' }),
  })
  expect(paired.status).toBe(200)
  const setCookie = paired.headers.get('set-cookie') ?? ''
  // Over HTTPS: `__Host-` prefixed, HttpOnly, Secure, SameSite=Strict, so the page can never read the token.
  expect(setCookie).toMatch(
    /^__Host-myr_device=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/,
  )
  const device = { cookie: setCookie.split(';')[0] ?? '' }

  // The code works once.
  const again = await call('/api/pair', {
    ...publicHost,
    method: 'POST',
    body: JSON.stringify({ code, name: 'X' }),
  })
  expect(again.status).toBe(401)

  const me = (await (await call('/api/whoami', { ...publicHost, headers: device })).json()) as {
    scope: string
    device: { id: string; name: string }
  }
  expect(me).toMatchObject({ scope: 'chat', device: { name: 'Phone' } })
  // A chat device reads chats but cannot reach the terminal, keys or Settings writes.
  expect((await call('/api/chats', { ...publicHost, headers: device })).status).not.toBe(401)
  expect((await call('/api/terminal', { ...publicHost, headers: device })).status).toBe(403)
  expect(
    (await call('/api/settings', { ...publicHost, method: 'PUT', headers: device, body: '{}' })).status,
  ).toBe(403)
  expect((await call('/api/devices', { ...publicHost, headers: device })).status).toBe(403)
  // Computer use: whether an agent controls the Mac (for the banner and its Stop), never the driver or macOS's grants.
  const computer = await call('/api/computer', { ...publicHost, headers: device })
  expect(computer.status).toBe(200)
  expect(Object.keys(await computer.json()).sort()).toEqual(['controls', 'enabled', 'supported'])
  const stopped = await call('/api/computer/stop', {
    ...publicHost,
    method: 'POST',
    headers: device,
    body: '{}',
  })
  expect(Object.keys(await stopped.json()).sort()).toEqual(['controls', 'enabled', 'stopped', 'supported'])
  const whole = await call('/api/computer', { headers: bearer(server.token) })
  expect(await whole.json()).toMatchObject({ grants: null, version: '', downloadBytes: 0 })

  // Only a hash of the token is kept on disk.
  const stored = readFileSync(join(home, 'devices.json'), 'utf8')
  expect(stored).not.toContain(device.cookie.split('=')[1] ?? '')
  // Pairings and failed codes are audited, without the code itself.
  const log = readFileSync(join(home, 'logs', 'device-auth.log'), 'utf8')
  expect(log).toContain('"event":"paired"')
  expect(log).toContain('"event":"pair-failed"')
  expect(log).not.toContain(code)

  // The person revokes it (from this machine): it is out at once.
  const local = { headers: bearer(server.token) }
  expect((await call(`/api/devices/${me.device.id}`, { ...local, method: 'DELETE' })).status).toBe(200)
  expect((await call('/api/whoami', { ...publicHost, headers: device })).status).toBe(401)
})

test('pairing codes expire after enough wrong guesses, and chat devices are kept from admin routes', () => {
  const codes = new PairingCodes()
  const code = codes.create('full')
  for (let i = 0; i < 10; i++) expect(codes.take(`WRONG${i}`)).toBeUndefined()
  // Ten wrong guesses withdraw every open code, the right one included.
  expect(codes.take(code)).toBeUndefined()

  expect(needsFull('GET', '/api/terminal')).toBe(true)
  expect(needsFull('PUT', '/api/settings')).toBe(true)
  expect(needsFull('GET', '/api/settings')).toBe(false)
  expect(needsFull('POST', '/api/projects/p1/git/commit')).toBe(true)
  expect(needsFull('GET', '/api/projects/p1/git/diff')).toBe(false)
  expect(needsFull('POST', '/api/chats')).toBe(false)
  expect(needsFull('POST', '/api/projects')).toBe(true)
  expect(needsFull('DELETE', '/api/projects/p1')).toBe(true)
  expect(needsFull('GET', '/api/projects')).toBe(false)
  // Keeping or restoring a learned skill, and schedules (which can deliver to a channel), are Settings only.
  expect(needsFull('PUT', '/api/skills/tidy-notes')).toBe(true)
  expect(needsFull('POST', '/api/skills/tidy-notes/restore')).toBe(true)
  expect(needsFull('GET', '/api/skills')).toBe(false)
  expect(needsFull('POST', '/api/schedules')).toBe(true)
  expect(needsFull('PATCH', '/api/schedules/s1')).toBe(true)
  expect(needsFull('DELETE', '/api/schedules/s1')).toBe(true)
  expect(needsFull('POST', '/api/schedules/s1/run')).toBe(true)
  expect(needsFull('GET', '/api/schedules')).toBe(false)
})

/** A port that was free a moment ago, for a fixed preview port. */
function freePort() {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
  const port = probe.port
  probe.stop(true)
  return port
}

type PreviewConfig = { previewOrigin: string | null; previewToken?: string }

test('previews: each device gets its own key on the preview origin, which a foreign name or a revoke ends', async () => {
  const previewPort = freePort()
  const { server, call } = serve({
    publicUrl: 'https://box.example.ts.net',
    previewPort,
    previewUrl: 'https://box.example.ts.net:8443',
  })
  expect(server.previewUrl).toBe('https://box.example.ts.net:8443')
  const publicHost = { host: 'box.example.ts.net', origin: 'https://box.example.ts.net' }
  const { code } = server.pairingLink('chat')
  const paired = await call('/api/pair', {
    ...publicHost,
    method: 'POST',
    body: JSON.stringify({ code, name: 'Phone' }),
  })
  const device = { cookie: (paired.headers.get('set-cookie') ?? '').split(';')[0] ?? '' }
  const me = (await (await call('/api/whoami', { ...publicHost, headers: device })).json()) as {
    device: { id: string }
  }

  const config = (await (
    await call('/api/config', { ...publicHost, headers: device })
  ).json()) as PreviewConfig
  expect(config.previewOrigin).toBe('https://box.example.ts.net:8443')
  expect(config.previewToken?.startsWith(`${me.device.id}.`)).toBe(true)

  /** The preview server as Tailscale Serve would reach it: on its port, with the preview URL's host. */
  const preview = (key: string, host = 'box.example.ts.net:8443') =>
    fetch(`http://127.0.0.1:${previewPort}/c-missing/${key}/index.html`, { headers: { host } })
  // Past the key check: the colony is simply not there.
  expect((await preview(config.previewToken ?? '')).status).toBe(404)
  expect((await preview(`${me.device.id}.forged`)).status).toBe(401)
  expect((await preview(config.previewToken ?? '', `evil.example:${previewPort}`)).status).toBe(401)

  await call(`/api/devices/${me.device.id}`, { method: 'DELETE', headers: bearer(server.token) })
  expect((await preview(config.previewToken ?? '')).status).toBe(401)
})

test('previews: a remote gateway without a preview address says so; on loopback the preview port is beside it', async () => {
  const { server, call } = serve({ publicUrl: 'https://box.example.ts.net' })
  const { code } = server.pairingLink('full')
  const publicHost = { host: 'box.example.ts.net', origin: 'https://box.example.ts.net' }
  const paired = await call('/api/pair', {
    ...publicHost,
    method: 'POST',
    body: JSON.stringify({ code, name: 'Mac' }),
  })
  const device = { cookie: (paired.headers.get('set-cookie') ?? '').split(';')[0] ?? '' }
  const remote = (await (
    await call('/api/config', { ...publicHost, headers: device })
  ).json()) as PreviewConfig
  expect(remote).toEqual({ previewOrigin: null })

  // Over an SSH tunnel the request is local: previews open on this machine's preview port.
  const local = (await (await call('/api/config', { headers: bearer(server.token) })).json()) as PreviewConfig
  expect(local.previewOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(local.previewToken?.startsWith('local.')).toBe(true)
})

test('a preview URL needs a fixed port and its own origin', () => {
  expect(() => serve({ previewUrl: 'https://box.example.ts.net:8443' })).toThrow('--preview-port')
  expect(() =>
    serve({
      publicUrl: 'https://box.example.ts.net',
      previewPort: freePort(),
      previewUrl: 'https://box.example.ts.net',
    }),
  ).toThrow('own origin')
})

test('revoking a device closes every socket it has open, not only event streams', async () => {
  const { server, call, base } = serve({ publicUrl: 'https://box.example.ts.net' })
  const publicHost = { host: 'box.example.ts.net', origin: 'https://box.example.ts.net' }
  const { code } = server.pairingLink('full')
  const paired = await call('/api/pair', {
    ...publicHost,
    method: 'POST',
    body: JSON.stringify({ code, name: 'Mac' }),
  })
  const cookie = (paired.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const me = (await (await call('/api/whoami', { ...publicHost, headers: { cookie } })).json()) as {
    device: { id: string }
  }
  const ws = new WebSocket(`ws://${base.host}/api/health/socket`, {
    headers: { cookie, host: 'box.example.ts.net', origin: 'https://box.example.ts.net' },
  } as never)
  await new Promise((resolve) => {
    ws.onmessage = resolve
  })
  const closed = new Promise<number>((resolve) => {
    ws.onclose = (e) => resolve(e.code)
  })
  await call(`/api/devices/${me.device.id}`, { method: 'DELETE', headers: bearer(server.token) })
  expect(await closed).toBe(4401)
})
