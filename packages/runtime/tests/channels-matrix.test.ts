import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { type AdapterIO, type AdapterStatus, type Inbound, MatrixAdapter } from '../src/channels/index.ts'

const TOKEN = 'syt_secret_token'
const ME = '@myr:example.org'
const ALICE = '@alice:example.org'
const DM = '!dm:example.org'
const ROOM = '!crew:example.org'

type Call = { method: string; path: string; query: URLSearchParams; body: unknown; auth: string | null }
type Handler = (call: Call, n: number) => unknown

/** A stand-in for a homeserver: each `METHOD /path` (a trailing `*` matches the rest) answers from a handler. */
function homeserver(handlers: Record<string, Handler>) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const auth = req.headers.get('authorization')
      const type = req.headers.get('content-type') ?? ''
      const body = type.includes('json')
        ? await req.json().catch(() => undefined)
        : req.method === 'GET'
          ? undefined
          : new Uint8Array(await req.arrayBuffer())
      const path = decodeURIComponent(url.pathname)
      const call = { method: req.method, path, query: url.searchParams, body, auth }
      calls.push(call)
      const route = `${req.method} ${path}`
      const key =
        handlers[route] !== undefined
          ? route
          : Object.keys(handlers).find((k) => k.endsWith('*') && route.startsWith(k.slice(0, -1)))
      const n = (counts.get(key ?? route) ?? 0) + 1
      counts.set(key ?? route, n)
      if (auth !== `Bearer ${TOKEN}`)
        return Response.json({ errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token' }, { status: 401 })
      const answer = key ? await handlers[key]?.(call, n) : { errcode: 'M_NOT_FOUND', error: 'not here' }
      if (answer instanceof Response) return answer
      return Response.json(answer ?? {}, { status: key ? 200 : 404 })
    },
  })
  return { server, calls, url: `http://127.0.0.1:${server.port}` }
}

const msgEvent = (id: string, content: Record<string, unknown>, sender = ALICE) => ({
  type: 'm.room.message',
  event_id: id,
  sender,
  origin_server_ts: Date.now(),
  content,
})

const BASE: Record<string, Handler> = {
  'GET /_matrix/client/v3/account/whoami': () => ({ user_id: ME }),
  'GET /_matrix/client/v3/profile/@myr:example.org/displayname': () => ({ displayname: 'Myr Bot' }),
  'GET /_matrix/client/v3/profile/@alice:example.org/displayname': () => ({ displayname: 'Alice' }),
  'GET /_matrix/client/v3/rooms/!crew:example.org/state/m.room.name': () => ({ name: 'Crew' }),
  'GET /_matrix/client/v3/rooms/!crew:example.org/joined_members': () => ({
    joined: { [ME]: {}, [ALICE]: {}, '@bob:example.org': {} },
  }),
  'POST /_matrix/client/v3/join/*': () => ({ room_id: '!new:example.org' }),
  'PUT /_matrix/client/v3/rooms/*': (c, n) => (c.path.includes('/send/') ? { event_id: `$sent${n}` } : {}),
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: MatrixAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function io() {
  const received: Inbound[] = []
  const statuses: AdapterStatus[] = []
  const kv = new Map<string, string>()
  const handle: AdapterIO = {
    receive: async (m) => {
      received.push(m)
    },
    get: (k) => kv.get(k),
    set: (k, v) => kv.set(k, v),
    status: (s) => statuses.push(s),
    log: () => {},
    dir: tmpdir(),
  }
  return { handle, received, statuses, kv }
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

/** The first sync (no `since`) answers at once; then `batch` once; later ones wait a little and bring nothing. */
const syncing =
  (batch: () => Record<string, unknown>, first: Record<string, unknown> = {}): Handler =>
  async (c) => {
    const since = c.query.get('since')
    if (!since) return { next_batch: 's1', ...first }
    if (since === 's1') return { next_batch: 's2', ...batch() }
    await Bun.sleep(50)
    return { next_batch: since }
  }

test('sync: invites joined, direct chats, mentions in rooms (stripped), threads, media; its own and edits ignored', async () => {
  const hs = homeserver({
    ...BASE,
    'GET /_matrix/client/v3/sync': syncing(
      () => ({
        rooms: {
          join: {
            [DM]: {
              summary: { 'm.joined_member_count': 2 },
              timeline: { events: [msgEvent('$1', { msgtype: 'm.text', body: 'hello there' })] },
            },
            [ROOM]: {
              timeline: {
                events: [
                  msgEvent('$2', {
                    msgtype: 'm.text',
                    body: 'Myr Bot: please look',
                    'm.mentions': { user_ids: [ME] },
                  }),
                  msgEvent('$3', { msgtype: 'm.text', body: 'chatting among ourselves' }),
                  msgEvent('$4', {
                    msgtype: 'm.text',
                    body: 'in the thread @myr',
                    'm.relates_to': { rel_type: 'm.thread', event_id: '$root', is_falling_back: true },
                  }),
                  msgEvent('$5', {
                    msgtype: 'm.image',
                    body: 'look at this',
                    filename: 'shot.png',
                    url: 'mxc://example.org/abc123',
                    info: { mimetype: 'image/png', size: 3 },
                    'm.mentions': { user_ids: [ME] },
                  }),
                  msgEvent('$6', { msgtype: 'm.text', body: 'my own' }, ME),
                  msgEvent('$7', {
                    msgtype: 'm.text',
                    body: '* fixed',
                    'm.relates_to': { rel_type: 'm.replace', event_id: '$3' },
                  }),
                  msgEvent('$8', { msgtype: 'm.notice', body: 'another bot' }),
                  {
                    type: 'm.room.encrypted',
                    event_id: '$9',
                    sender: ALICE,
                    origin_server_ts: Date.now(),
                    content: {},
                  },
                ],
              },
            },
          },
        },
      }),
      {
        rooms: {
          invite: {
            '!new:example.org': {
              invite_state: {
                events: [
                  {
                    type: 'm.room.member',
                    state_key: ME,
                    sender: ALICE,
                    content: { membership: 'invite', is_direct: true },
                  },
                ],
              },
            },
          },
        },
      },
    ),
    'GET /_matrix/client/v1/media/download/example.org/abc123': () => new Response(new Uint8Array([4, 5, 6])),
  })
  servers.push(hs.server)
  const adapter = new MatrixAdapter(hs.url, TOKEN)
  adapters.push(adapter)
  expect(await adapter.check()).toBe(ME)
  const { handle, received, statuses, kv } = io()
  await adapter.start(handle)
  await until(() => received.length === 5)
  await until(() => kv.get('since') === 's2')
  expect(statuses).toContainEqual({ state: 'on', account: ME })
  // The first sync only finds where "now" is; its invite is joined.
  expect(hs.calls.find((c) => c.path === '/_matrix/client/v3/sync')?.query.get('timeout')).toBe('0')
  expect(
    hs.calls.some((c) => c.method === 'POST' && c.path === '/_matrix/client/v3/join/!new:example.org'),
  ).toBe(true)

  expect(received[0]).toMatchObject({
    messageId: '$1',
    chat: { id: DM, kind: 'dm' },
    sender: { id: ALICE, name: 'Alice', handle: ALICE },
    text: 'hello there',
    mentioned: true,
  })
  expect(received[1]).toMatchObject({
    chat: { id: ROOM, kind: 'group', title: 'Crew' },
    text: 'please look',
    mentioned: true,
  })
  expect(received[2]).toMatchObject({ text: 'chatting among ourselves', mentioned: false })
  expect(received[3]).toMatchObject({
    chat: { id: ROOM, kind: 'group', thread: '$root' },
    text: 'in the thread',
    mentioned: true,
  })
  const file = received[4]?.files?.[0]
  expect(received[4]?.text).toBe('look at this')
  expect(file).toMatchObject({ kind: 'image', name: 'shot.png', mimeType: 'image/png', size: 3 })
  expect(await file?.read()).toEqual(new Uint8Array([4, 5, 6]))
  expect(hs.calls.find((c) => c.path.startsWith('/_matrix/client/v1/media/download'))?.auth).toBe(
    `Bearer ${TOKEN}`,
  )

  // The encrypted room is told once that it cannot be read.
  await until(() => kv.has(`encrypted:${ROOM}`))
  await until(() =>
    hs.calls.some((c) => c.method === 'PUT' && c.path.startsWith(`/_matrix/client/v3/rooms/${ROOM}/send`)),
  )
  const note = hs.calls.find((c) => c.method === 'PUT' && c.path.includes('/send/'))?.body as { body: string }
  expect(note.body).toContain('encrypted')
})

test('sending: Markdown with HTML, threads kept, edits as m.replace, typing, files through the media repository', async () => {
  const hs = homeserver({
    ...BASE,
    'POST /_matrix/media/v3/upload': () => ({ content_uri: 'mxc://example.org/up1' }),
  })
  servers.push(hs.server)
  const adapter = new MatrixAdapter(hs.url, TOKEN)
  await adapter.check()

  const ref = await adapter.send({ id: ROOM, kind: 'group', thread: '$root' }, { text: '**Done** in `2m`' })
  expect(ref).toEqual({ chat: ROOM, id: '$sent1' })
  const sent = hs.calls.at(-1)
  expect(sent?.path).toStartWith(`/_matrix/client/v3/rooms/${ROOM}/send/m.room.message/`)
  expect(sent?.body).toEqual({
    msgtype: 'm.text',
    body: '**Done** in `2m`',
    format: 'org.matrix.custom.html',
    formatted_body: '<b>Done</b> in <code>2m</code>',
    'm.mentions': {},
    'm.relates_to': {
      rel_type: 'm.thread',
      event_id: '$root',
      is_falling_back: true,
      'm.in_reply_to': { event_id: '$root' },
    },
  })

  await adapter.edit(ref, { text: 'Done · 2m 10s' })
  expect(hs.calls.at(-1)?.body).toMatchObject({
    body: '* Done · 2m 10s',
    'm.new_content': { msgtype: 'm.text', body: 'Done · 2m 10s' },
    'm.relates_to': { rel_type: 'm.replace', event_id: '$sent1' },
  })

  await adapter.typing(DM)
  expect(hs.calls.at(-1)).toMatchObject({
    method: 'PUT',
    path: `/_matrix/client/v3/rooms/${DM}/typing/${ME}`,
    body: { typing: true },
  })

  const fileRef = await adapter.sendFile(DM, {
    name: 'chart.png',
    mimeType: 'image/png',
    data: new Uint8Array([1, 2]),
  })
  const upload = hs.calls.find((c) => c.path === '/_matrix/media/v3/upload')
  expect(upload?.query.get('filename')).toBe('chart.png')
  expect(upload?.body).toEqual(new Uint8Array([1, 2]))
  expect(hs.calls.at(-1)?.body).toMatchObject({
    msgtype: 'm.image',
    body: 'chart.png',
    url: 'mxc://example.org/up1',
    info: { mimetype: 'image/png', size: 2 },
  })
  expect(fileRef.chat).toBe(DM)
  expect(adapter.can).toEqual({ buttons: false, files: true, edit: true })
})

test('a refused token stops it with the reason; a token for another account is refused too', async () => {
  const hs = homeserver(BASE)
  servers.push(hs.server)
  await expect(new MatrixAdapter(hs.url, 'wrong').check()).rejects.toThrow('refused this access token')
  await expect(new MatrixAdapter(hs.url, TOKEN, '@other:example.org').check()).rejects.toThrow(
    '@myr:example.org',
  )
  const refused = new MatrixAdapter(hs.url, 'wrong')
  adapters.push(refused)
  const { handle, statuses } = io()
  await refused.start(handle)
  await until(() => statuses.some((s) => s.state === 'error'))
  expect(statuses.at(-1)).toMatchObject({ state: 'error', error: expect.stringContaining('refused') })
  expect(JSON.stringify(statuses)).not.toContain('wrong')
})

test('rate limits: a send waits out retry_after_ms, a limited sync is retried, an expired token stops the loop', async () => {
  let expired = false
  const hs = homeserver({
    ...BASE,
    'PUT /_matrix/client/v3/rooms/*': (_c, n) =>
      n === 1
        ? Response.json(
            { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: 20 },
            { status: 429 },
          )
        : { event_id: '$ok' },
    'GET /_matrix/client/v3/sync': (c, n) => {
      if (expired)
        return Response.json({ errcode: 'M_UNKNOWN_TOKEN', error: 'Token expired' }, { status: 401 })
      if (n === 2)
        return Response.json(
          { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: 30 },
          { status: 429 },
        )
      return Bun.sleep(c.query.get('since') ? 30 : 0).then(() => ({ next_batch: `s${n}` }))
    },
  })
  servers.push(hs.server)
  const adapter = new MatrixAdapter(hs.url, TOKEN)
  adapters.push(adapter)
  expect(await adapter.send(DM, { text: 'hi' })).toEqual({ chat: DM, id: '$ok' })
  expect(hs.calls.filter((c) => c.method === 'PUT')).toHaveLength(2)

  const { handle, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'retrying'))
  expect(statuses.find((s) => s.state === 'retrying')).toMatchObject({ error: 'Too many requests' })
  await until(() => statuses.at(-1)?.state === 'on')
  expired = true
  await until(() => statuses.at(-1)?.state === 'error')
  expect(statuses.at(-1)).toMatchObject({ error: expect.stringContaining('refused this access token') })
})
