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
