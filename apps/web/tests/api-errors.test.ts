import { afterAll, beforeAll, expect, test } from 'bun:test'

// api.ts reads the page's address and storage when it loads; a bare stand-in is enough for its request helpers.
const page = globalThis as unknown as Record<string, unknown>
const realFetch = globalThis.fetch
const events: string[] = []
let api: typeof import('../src/client/api.ts')

beforeAll(async () => {
  const target = new EventTarget()
  page.window = Object.assign(target, {
    dispatchEvent: (e: Event) => {
      events.push(e.type)
      return EventTarget.prototype.dispatchEvent.call(target, e)
    },
  })
  page.location = { hash: '', pathname: '/', host: 'localhost', protocol: 'http:' }
  api = await import('../src/client/api.ts')
})

afterAll(() => {
  globalThis.fetch = realFetch
  delete page.window
  delete page.location
})

const answer = (status: number, body: unknown = {}) => {
  globalThis.fetch = (async () => Response.json(body, { status })) as unknown as typeof fetch
}

test('a server that does not answer fails in plain words, and the page hears it went and came back', async () => {
  const { copy } = await import('../src/client/copy.ts')
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch')
  }) as unknown as typeof fetch
  await expect(api.api('/api/chats')).rejects.toThrow(copy.api.unreachable)
  expect(api.reachable()).toBe(false)
  expect(events).toContain(api.CONNECTION_CHANGED)

  events.length = 0
  answer(200, [])
  expect(await api.api<unknown[]>('/api/chats')).toEqual([])
  expect(api.reachable()).toBe(true)
  expect(events).toEqual([api.CONNECTION_CHANGED])
})

test('one request cut short fails on its own; the page stays online while the server still answers', async () => {
  const { copy } = await import('../src/client/copy.ts')
  events.length = 0
  globalThis.fetch = (async (url: string) => {
    if (url === '/api/whoami') return Response.json({ scope: 'full', remote: false })
    throw new TypeError('network connection was lost')
  }) as unknown as typeof fetch
  await expect(api.post('/api/chats/c1/learn', {})).rejects.toThrow(copy.api.interrupted)
  expect(api.reachable()).toBe(true)
  expect(events).not.toContain(api.CONNECTION_CHANGED)
})

test('a failed response says what went wrong, never the status and path', async () => {
  const { copy } = await import('../src/client/copy.ts')
  answer(500)
  await expect(api.api('/api/settings')).rejects.toThrow(copy.api.status(500))
  await expect(api.post('/api/chats', {})).rejects.toThrow(copy.api.status(500))
  expect(copy.api.status(500)).not.toContain('500 /api')
  // The server's own words win when it gives some.
  answer(403, { error: 'this device can use chats only' })
  await expect(api.api('/api/devices')).rejects.toThrow('this device can use chats only')
  events.length = 0
  answer(401, { error: 'unauthorized' })
  await expect(api.send('PUT', '/api/settings', {})).rejects.toThrow(copy.auth.notAuthorized)
  expect(events).toEqual([api.SIGNED_OUT])
})

test("the server's technical words become plain ones", async () => {
  const { copy } = await import('../src/client/copy.ts')
  const warn = console.warn
  console.warn = () => {}
  try {
    answer(500, { error: 'internal error' })
    await expect(api.api('/api/settings')).rejects.toThrow(copy.api.serverProblem)
    answer(404, { error: 'not found' })
    await expect(api.api('/api/nowhere')).rejects.toThrow(copy.api.status(404))
    answer(404, { error: 'no such colony' })
    await expect(api.post('/api/tools', {})).rejects.toThrow(copy.api.chatGone)
    answer(404, { error: 'no such colony: c-123' })
    await expect(api.api('/api/colonies/c-123')).rejects.toThrow(copy.api.chatGone)
    answer(400, { error: 'invalid request: Expected string, received number at "text"' })
    await expect(api.post('/api/chats', {})).rejects.toThrow(copy.api.badRequest)
    answer(503, { error: 'skills need the chat runtime' })
    await expect(api.api('/api/skills')).rejects.toThrow(copy.api.noChats('skills'))
    answer(503, { error: 'memory needs the chat runtime' })
    await expect(api.api('/api/memory')).rejects.toThrow(copy.api.noChats('memory'))
    answer(503, { error: 'this server was started without the chat runtime' })
    await expect(api.post('/api/chats', {})).rejects.toThrow(copy.api.noChats('chats'))
    answer(418)
    await expect(api.api('/api/teapot')).rejects.toThrow(copy.api.status(418))
    expect(copy.api.status(418)).not.toContain('418')
  } finally {
    console.warn = warn
  }
})

test('the composer choices survive a reload, including always bringing helpers in', () => {
  const saved = { mode: 'orchestrated', leadModel: 'a/flash', roster: [], extraWorkers: 0, helpers: 'always' }
  expect(api.normalizeConfig(saved, 'a/pro')).toMatchObject({
    leadModel: 'a/flash',
    roster: [],
    extraWorkers: 0,
    helpers: 'always',
  })
  expect(api.normalizeConfig({ leadModel: 'a/flash' }, 'a/pro')).not.toHaveProperty('helpers')
})
