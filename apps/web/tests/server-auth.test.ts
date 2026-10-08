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
})
