import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import type { ServerWebSocket } from 'bun'
import {
  type AdapterIO,
  type AdapterStatus,
  DiscordAdapter,
  discordMarkdown,
  type Inbound,
} from '../src/channels/index.ts'

type Rest = { method: string; path: string; body: unknown; headers: Headers }
type Frame = { path: string; op: number; d: Record<string, unknown> | number | null }
type Route = (call: Rest, n: number) => Response | undefined

const BOT = { id: '100', username: 'myrbot', bot: true }
const ALICE = { id: '1', username: 'alice', global_name: 'Alice' }

/**
 * A stand-in for Discord: REST under `/api/v10` (answers from `routes`, else sensible defaults; every call recorded)
 * and a gateway at `/gateway` (and `/resume`) that says HELLO, answers IDENTIFY with READY and RESUME with RESUMED,
 * and ACKs heartbeats while `ack` is on.
 */
function fakeDiscord(
  options: { routes?: Record<string, Route>; heartbeat?: number; onIdentify?: (ws: Sock) => void } = {},
) {
  const rest: Rest[] = []
  const frames: Frame[] = []
  const sockets: Sock[] = []
  const counts = new Map<string, number>()
  const state = { ack: true, seq: 0 }
  const server = Bun.serve<{ path: string }>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv): Promise<Response | undefined> {
      const url = new URL(req.url)
      if (
        (url.pathname === '/gateway' || url.pathname === '/resume') &&
        srv.upgrade(req, { data: { path: url.pathname } })
      )
        return undefined
      if (url.pathname.startsWith('/cdn/'))
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      const path = url.pathname.replace(/^\/api\/v10/, '')
      const type = req.headers.get('content-type') ?? ''
      const body = type.includes('json')
        ? await req.json()
        : type.includes('multipart')
          ? await req.formData()
          : undefined
      const call = { method: req.method, path, body, headers: req.headers }
      rest.push(call)
      const key = `${req.method} ${path}`
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      const custom = options.routes?.[key]?.(call, n)
      if (custom) return custom
      if (key === 'GET /users/@me') return Response.json(BOT)
      if (key === 'GET /gateway/bot') return Response.json({ url: `ws://127.0.0.1:${server.port}/gateway` })
      if (req.method === 'POST' && /^\/channels\/\d+\/messages$/.test(path))
        return Response.json({ id: `9${rest.length}` })
      if (req.method === 'PATCH') return Response.json({})
      return new Response(null, { status: 204 })
    },
    websocket: {
      open(ws) {
        sockets.push(ws)
        ws.send(
          JSON.stringify({
            op: 10,
            d: { heartbeat_interval: options.heartbeat ?? 45_000 },
            s: null,
            t: null,
          }),
        )
      },
      message(ws, raw) {
        const p = JSON.parse(String(raw)) as { op: number; d: Frame['d'] }
        frames.push({ path: ws.data.path, op: p.op, d: p.d })
        if (p.op === 1 && state.ack) ws.send(JSON.stringify({ op: 11 }))
        if (p.op === 2) {
          if (options.onIdentify) return options.onIdentify(ws)
          ws.send(
            JSON.stringify({
              op: 0,
              t: 'READY',
              s: ++state.seq,
              d: {
                session_id: 'sess-1',
                resume_gateway_url: `ws://127.0.0.1:${server.port}/resume`,
                user: BOT,
              },
            }),
          )
        }
        if (p.op === 6) ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: ++state.seq, d: {} }))
      },
    },
  })
  const dispatch = (t: string, d: unknown) =>
    sockets.at(-1)?.send(JSON.stringify({ op: 0, t, s: ++state.seq, d }))
  return {
    server,
    rest,
    frames,
    sockets,
    state,
    dispatch,
    base: `http://127.0.0.1:${server.port}`,
    api: `http://127.0.0.1:${server.port}/api/v10`,
  }
}
type Sock = ServerWebSocket<{ path: string }>

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: DiscordAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function setup(options: Parameters<typeof fakeDiscord>[0] = {}, token = 'TOKEN') {
  const fake = fakeDiscord(options)
  servers.push(fake.server)
  const adapter = new DiscordAdapter(token, fake.api)
  adapters.push(adapter)
  return { fake, adapter }
}

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

async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

const message = (fields: Record<string, unknown>) => ({
  type: 0,
  author: ALICE,
  content: '',
  timestamp: '2026-10-08T10:00:00.000Z',
  ...fields,
})

test('check names the bot; a refused token says so', async () => {
  const { fake, adapter } = setup({
    routes: {
      'GET /users/@me': (call) =>
        call.headers.get('authorization') === 'Bot BAD'
          ? Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 })
          : undefined,
    },
  })
  expect(await adapter.check()).toBe('@myrbot')
  expect(fake.rest[0]?.headers.get('authorization')).toBe('Bot TOKEN')
  await expect(new DiscordAdapter('BAD', fake.api).check()).rejects.toThrow('refused this token')
})

test('gateway messages become the hub’s: direct chats, mentions, threads, replies, attachments; bots ignored', async () => {
  const { fake, adapter } = setup({
    routes: {
      'GET /channels/909': () => Response.json({ id: '909', type: 0, name: 'random' }),
    },
  })
  const { handle, received, statuses, kv } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(statuses).toContainEqual({ state: 'on', account: '@myrbot' })
  const identify = fake.frames.find((f) => f.op === 2)?.d as Record<string, unknown>
  // GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES, MESSAGE_CONTENT.
  expect(identify).toMatchObject({ token: 'TOKEN', intents: 1 + 512 + 4096 + 32768 })

  fake.dispatch('GUILD_CREATE', {
    id: '1000',
    name: 'Crew',
    channels: [{ id: '600', type: 0, name: 'general' }],
    threads: [{ id: '700', type: 11, name: 'plan', parent_id: '600' }],
  })
  const cdn = `${fake.base}/cdn/pic.png`
  for (const m of [
    message({ id: '1', channel_id: '500', content: 'hello' }),
    message({
      id: '2',
      channel_id: '600',
      guild_id: '1000',
      content: '<@100> please look at <@!200>',
      mentions: [BOT, { id: '200', username: 'bob', global_name: 'Bob' }],
    }),
    message({ id: '3', channel_id: '600', guild_id: '1000', content: 'just chatting' }),
    message({
      id: '4',
      channel_id: '700',
      guild_id: '1000',
      content: '<@100> in the thread',
      mentions: [BOT],
    }),
    message({ id: '5', channel_id: '700', guild_id: '1000', content: 'and a follow-up' }),
    message({
      id: '6',
      channel_id: '600',
      guild_id: '1000',
      type: 19,
      content: 'ok',
      referenced_message: { author: BOT },
    }),
    message({
      id: '7',
      channel_id: '500',
      attachments: [{ id: 'a', filename: 'pic.png', content_type: 'image/png', size: 3, url: cdn }],
    }),
    message({
      id: '8',
      channel_id: '500',
      author: { id: '300', username: 'other', bot: true },
      content: 'bot talk',
    }),
    message({ id: '9', channel_id: '500', type: 7, content: '' }),
    message({ id: '10', channel_id: '909', guild_id: '1000', content: '<@100> hi', mentions: [BOT] }),
  ])
    fake.dispatch('MESSAGE_CREATE', m)
  await until(() => received.length === 8)

  expect(received[0]).toMatchObject({
    messageId: '1',
    chat: { id: '500', kind: 'dm' },
    sender: { id: '1', name: 'Alice', handle: 'alice' },
    text: 'hello',
    mentioned: true,
  })
  expect(received[1]).toMatchObject({
    chat: { id: '600', kind: 'group', title: 'Crew #general' },
    text: 'please look at @Bob',
    mentioned: true,
  })
  expect(received[1]?.chat.thread).toBeUndefined()
  expect(received[2]).toMatchObject({ text: 'just chatting', mentioned: false })
  expect(received[3]).toMatchObject({
    chat: { id: '600', kind: 'group', thread: '700', title: 'Crew #general › plan' },
    text: 'in the thread',
    mentioned: true,
  })
  // A thread the bot was mentioned in needs no mention after that, across restarts too.
  expect(received[4]).toMatchObject({ chat: { thread: '700' }, mentioned: true })
  expect(JSON.parse(kv.get('threads') ?? '[]')).toContain('700')
  expect(received[5]).toMatchObject({ text: 'ok', mentioned: true })
  const file = received[6]?.files?.[0]
  expect(file).toMatchObject({ kind: 'image', name: 'pic.png', mimeType: 'image/png', size: 3 })
  expect([...((await file?.read()) ?? [])]).toEqual([1, 2, 3])
  // An unknown channel is looked up once.
  expect(received[7]).toMatchObject({ chat: { id: '909', title: 'Crew #random' }, text: 'hi' })
  expect(fake.rest.filter((c) => c.path === '/channels/909')).toHaveLength(1)
  expect(received.some((m) => m.text === 'bot talk')).toBe(false)
})

test('heartbeats are ACKed; RECONNECT and a silent connection both RESUME the session where it left off', async () => {
  const { fake, adapter } = setup({ heartbeat: 30 })
  const { handle, received, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  fake.dispatch('MESSAGE_CREATE', message({ id: '1', channel_id: '500', content: 'hi' }))
  await until(() => received.length === 1)
  await until(() => fake.frames.filter((f) => f.op === 1).length >= 2)
  // A heartbeat carries the last sequence number seen.
  expect(fake.frames.filter((f) => f.op === 1).at(-1)?.d).toBe(2)

  fake.sockets.at(-1)?.send(JSON.stringify({ op: 7, d: null }))
  await until(() => fake.frames.some((f) => f.op === 6))
  expect(fake.frames.find((f) => f.op === 6)).toMatchObject({
    path: '/resume',
    d: { token: 'TOKEN', session_id: 'sess-1', seq: 2 },
  })
  // A reconnect Discord asked for is not trouble worth showing.
  expect(statuses.some((s) => s.state === 'retrying')).toBe(false)

  // Heartbeats go unanswered: the connection is dropped and resumed.
  await until(() => fake.sockets.length === 2)
  fake.state.ack = false
  await until(() => fake.frames.filter((f) => f.op === 6).length === 2, 3000)
  expect(fake.sockets).toHaveLength(3)
})

test('a refused token or a missing Message Content intent stops it with the reason', async () => {
  const refused = setup({ onIdentify: (ws) => ws.close(4004, 'Authentication failed') })
  const first = io()
  await refused.adapter.start(first.handle)
  await until(() => first.statuses.some((s) => s.state === 'error'))
  expect(first.statuses.at(-1)).toMatchObject({
    state: 'error',
    error: expect.stringContaining('refused this token'),
  })

  const intents = setup({ onIdentify: (ws) => ws.close(4014, 'Disallowed intent(s)') })
  const second = io()
  await intents.adapter.start(second.handle)
  await until(() => second.statuses.some((s) => s.state === 'error'))
  expect(second.statuses.at(-1)).toMatchObject({
    state: 'error',
    error: expect.stringContaining('Message Content intent'),
  })
})

test('sends Markdown with buttons as components, in threads too; edits drop answered buttons; typing and files', async () => {
  const { fake, adapter } = setup()
  const ref = await adapter.send('500', {
    text: '**Allow?**\n#### Details',
    buttons: [[{ label: 'Allow once', data: 'a:o:k1' }], [{ label: 'Deny', data: 'a:d:k1' }]],
  })
  const sent = fake.rest.at(-1)
  expect(sent?.path).toBe('/channels/500/messages')
  expect(sent?.body).toEqual({
    content: '**Allow?**\n**Details**',
    flags: 4,
    allowed_mentions: { parse: [] },
    components: [
      { type: 1, components: [{ type: 2, style: 2, label: 'Allow once', custom_id: 'a:o:k1' }] },
      { type: 1, components: [{ type: 2, style: 2, label: 'Deny', custom_id: 'a:d:k1' }] },
    ],
  })
  expect(ref.chat).toBe('500')

  await adapter.edit(ref, { text: 'Allowed' })
  expect(fake.rest.at(-1)).toMatchObject({
    method: 'PATCH',
    path: `/channels/500/messages/${ref.id}`,
    body: { content: 'Allowed', components: [] },
  })

  // A thread is its own channel; more rows than Discord takes are packed five to a row.
  const rows = Array.from({ length: 7 }, (_, i) => [{ label: `Option ${i}`, data: `q:k:0:${i}` }])
  const inThread = await adapter.send(
    { id: '600', kind: 'group', thread: '700' },
    { text: 'Pick', buttons: rows },
  )
  expect(inThread.chat).toBe('700')
  const packed = fake.rest.at(-1)?.body as { components: { components: unknown[] }[] } | undefined
  expect(packed?.components.map((r) => r.components.length)).toEqual([5, 2])

  await adapter.typing('500')
  await adapter.typing('500')
  expect(fake.rest.filter((c) => c.path === '/channels/500/typing')).toHaveLength(1)

  await adapter.sendFile('500', {
    name: 'report.txt',
    mimeType: 'text/plain',
    data: new TextEncoder().encode('hi'),
  })
  const form = fake.rest.at(-1)?.body as FormData
  expect(JSON.parse(String(form.get('payload_json')))).toMatchObject({
    attachments: [{ id: 0, filename: 'report.txt' }],
  })
  expect(await (form.get('files[0]') as File).text()).toBe('hi')
})

test('a 429 is waited out and the request tried again', async () => {
  const { fake, adapter } = setup({
    routes: {
      'POST /channels/500/messages': (_call, n) =>
        n === 1
          ? Response.json(
              { message: 'You are being rate limited.', retry_after: 0.1, global: false },
              { status: 429 },
            )
          : undefined,
    },
  })
  const started = Date.now()
  await adapter.send('500', { text: 'hello' })
  expect(Date.now() - started).toBeGreaterThanOrEqual(90)
  expect(fake.rest.filter((c) => c.path === '/channels/500/messages')).toHaveLength(2)
})

test('button presses become presses, answered with a note only the presser sees, or silently in time', async () => {
  const { fake, adapter } = setup()
  const { handle, received, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  const press = (id: string, data: string) => ({
    id,
    application_id: '100',
    type: 3,
    token: `tok-${id}`,
    channel_id: '500',
    user: ALICE,
    data: { custom_id: data },
    message: { id: '900', channel_id: '500' },
  })
  fake.dispatch('INTERACTION_CREATE', press('800', 'a:o:k1'))
  await until(() => received.length === 1)
  expect(received[0]).toMatchObject({
    messageId: 'press:800',
    chat: { id: '500', kind: 'dm' },
    sender: { id: '1', name: 'Alice' },
    mentioned: true,
    press: { id: '800', data: 'a:o:k1', message: { chat: '500', id: '900' } },
  })
  const p = received[0]?.press
  if (!p) throw new Error('no press')
  await adapter.answerPress(p, 'Only the owner can approve this.')
  expect(fake.rest.at(-1)).toMatchObject({
    path: '/interactions/800/tok-800/callback',
    body: { type: 4, data: { content: 'Only the owner can approve this.', flags: 64 } },
  })

  // A note the edited message already shows is not repeated.
  fake.dispatch('INTERACTION_CREATE', press('801', 'a:o:k2'))
  await until(() => received.length === 2)
  const second = received[1]?.press
  if (!second) throw new Error('no press')
  await adapter.answerPress(second, 'Allowed')
  expect(fake.rest.at(-1)).toMatchObject({ path: '/interactions/801/tok-801/callback', body: { type: 6 } })

  // Unanswered, it is acknowledged before Discord's 3 s run out; a late note follows up on its token.
  fake.dispatch('INTERACTION_CREATE', press('802', 'q:k:0:1'))
  await until(() => fake.rest.some((c) => c.path === '/interactions/802/tok-802/callback'), 3000)
  expect(fake.rest.find((c) => c.path === '/interactions/802/tok-802/callback')?.body).toEqual({ type: 6 })
  const third = received[2]?.press
  if (!third) throw new Error('no press')
  await adapter.answerPress(third, 'This request is no longer open.')
  expect(fake.rest.at(-1)).toMatchObject({
    path: '/webhooks/100/tok-802',
    body: { content: 'This request is no longer open.', flags: 64 },
  })
})

test('Discord Markdown: only headings it cannot show change, and never inside code', () => {
  expect(discordMarkdown('# Title\n#### Deep\n```\n#### kept\n```')).toBe(
    '# Title\n**Deep**\n```\n#### kept\n```',
  )
})
