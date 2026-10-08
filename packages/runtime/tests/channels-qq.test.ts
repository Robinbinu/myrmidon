import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import type { ServerWebSocket } from 'bun'
import { type AdapterIO, type AdapterStatus, type Inbound, QQAdapter } from '../src/channels/index.ts'

type Call = { method: string; path: string; body: Record<string, unknown>; auth?: string }
type Payload = { op: number; d?: unknown }

/** A stand-in for the QQ Bot API, its token endpoint and its gateway (`/ws`). */
function qqApi(
  handlers: Record<string, (call: Call, n: number) => unknown>,
  gateway?: {
    open?: (ws: ServerWebSocket<unknown>) => void
    message?: (ws: ServerWebSocket<unknown>, p: Payload) => void
  },
) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const sent: Payload[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/ws') return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
      const call: Call = {
        method: req.method,
        path: url.pathname,
        body: (await req.json().catch(() => ({}))) as Record<string, unknown>,
        auth: req.headers.get('authorization') ?? undefined,
      }
      calls.push(call)
      const key = `${req.method} ${url.pathname}`
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      const handler = handlers[key]
      const answer = handler ? handler(call, n) : { id: `m-${calls.length}` }
      return answer instanceof Response ? answer : Response.json(answer)
    },
    websocket: {
      open: (ws) => gateway?.open?.(ws),
      message: (ws, data) => {
        const p = JSON.parse(String(data)) as Payload
        sent.push(p)
        gateway?.message?.(ws, p)
      },
    },
  })
  const api = `http://127.0.0.1:${server.port}`
  return { server, calls, sent, endpoints: { api, token: `${api}/app/getAppAccessToken` } }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: QQAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function io() {
  const received: Inbound[] = []
  const statuses: AdapterStatus[] = []
  const handle: AdapterIO = {
    receive: async (m) => {
      received.push(m)
    },
    get: () => undefined,
    set: () => {},
    status: (s) => statuses.push(s),
    log: () => {},
    dir: tmpdir(),
  }
  return { handle, received, statuses }
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

const config = { appId: '102000', secret: 'qq-secret' }
const base = {
  'POST /app/getAppAccessToken': (c: Call) =>
    c.body.clientSecret === 'qq-secret'
      ? { access_token: 'qq-t', expires_in: '7200' }
      : { code: 100016, message: 'invalid appid or secret' },
  'GET /users/@me': () => ({ id: 'bot-1', username: 'MyrBot' }),
}

test('check() names the bot; refused credentials say so', async () => {
  const q = qqApi(base)
  servers.push(q.server)
  expect(await new QQAdapter(config, q.endpoints).check()).toBe('MyrBot')
  expect(q.calls.find((c) => c.path === '/users/@me')?.auth).toBe('QQBot qq-t')
  await expect(new QQAdapter({ ...config, secret: 'bad' }, q.endpoints).check()).rejects.toThrow(
    'refused this App ID',
  )
  const a = new QQAdapter({ ...config, secret: 'bad' }, q.endpoints)
  adapters.push(a)
  const { handle, statuses } = io()
  await a.start(handle)
  await until(() => statuses.some((s) => s.state === 'error'))
})

test('the gateway: identify, heartbeats, direct and group @-messages, clicks acknowledged, then resume after a drop', async () => {
  let connections = 0
  const q = qqApi(
    { ...base, 'GET /gateway': () => ({ url: `ws://127.0.0.1:${q.server.port}/ws` }) },
    {
      open: (ws) => {
        connections++
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }))
      },
      message: (ws, p) => {
        if (p.op === 2) {
          ws.send(
            JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess-1', user: { id: 'bot-1' } } }),
          )
          ws.send(
            JSON.stringify({
              op: 0,
              t: 'C2C_MESSAGE_CREATE',
              s: 2,
              d: {
                id: 'msg-c2c',
                author: { user_openid: 'U1' },
                content: 'hello',
                timestamp: '2026-10-08T10:00:00+08:00',
              },
            }),
          )
          ws.send(
            JSON.stringify({
              op: 0,
              t: 'GROUP_AT_MESSAGE_CREATE',
              s: 3,
              d: {
                id: 'msg-grp',
                group_openid: 'G1',
                author: { member_openid: 'M1' },
                content: '@MyrBot look at this',
                attachments: [{ content_type: 'image/png', url: '//127.0.0.1/x.png', filename: 'x.png' }],
              },
            }),
          )
          ws.send(
            JSON.stringify({
              op: 0,
              t: 'INTERACTION_CREATE',
              s: 4,
              d: {
                id: 'int-1',
                chat_type: 2,
                user_openid: 'U1',
                data: { resolved: { button_data: 'a:o:k1' } },
              },
            }),
          )
        }
        // After a few heartbeats, drop the connection the way QQ does when it times a session out.
        if (p.op === 1 && connections === 1 && q.sent.filter((s) => s.op === 1).length === 3)
          ws.close(4009, 'timeout')
        if (p.op === 6) ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: 5, d: {} }))
      },
    },
  )
  servers.push(q.server)
  const adapter = new QQAdapter(config, q.endpoints)
  adapters.push(adapter)
  const { handle, received, statuses } = io()
  await adapter.start(handle)
  await until(() => received.length === 3)
  expect(statuses).toContainEqual({ state: 'on', account: 'MyrBot' })
  const identify = q.sent.find((s) => s.op === 2)
  expect(identify?.d).toMatchObject({ token: 'QQBot qq-t', intents: (1 << 25) | (1 << 26), shard: [0, 1] })
  expect(received[0]).toMatchObject({
    messageId: 'msg-c2c',
    chat: { id: 'c2c:U1', kind: 'dm' },
    sender: { id: 'U1' },
    text: 'hello',
    mentioned: true,
  })
  expect(received[1]).toMatchObject({
    chat: { id: 'group:G1', kind: 'group' },
    text: 'look at this',
    mentioned: true,
  })
  expect(received[1]?.files?.[0]).toMatchObject({ kind: 'image', mimeType: 'image/png', name: 'x.png' })
  expect(received[2]).toMatchObject({
    chat: { id: 'c2c:U1', kind: 'dm' },
    press: { id: 'int-1', data: 'a:o:k1' },
  })
  await until(() => q.calls.some((c) => c.method === 'PUT' && c.path === '/interactions/int-1'))
  expect(q.calls.find((c) => c.path === '/interactions/int-1')?.body).toEqual({ code: 0 })
  // Heartbeats carry the last sequence number seen.
  await until(() => q.sent.some((s) => s.op === 1 && s.d === 4))

  // The drop is resumed (not identified again) with the session and the last sequence.
  await until(() => q.sent.some((s) => s.op === 6), 8000)
  expect(q.sent.find((s) => s.op === 6)?.d).toEqual({ token: 'QQBot qq-t', session_id: 'sess-1', seq: 4 })
  expect(q.sent.filter((s) => s.op === 2)).toHaveLength(1)
}, 15_000)

test('sending: passive replies cite the message with rising sequence numbers; keyboards; plain text without Markdown', async () => {
  let markdownOk = true
  const q = qqApi({
    ...base,
    'POST /v2/users/U1/messages': (c) =>
      c.body.msg_type === 2 && !markdownOk
        ? Response.json({ code: 304003, message: 'markdown not allowed' }, { status: 400 })
        : { id: `out-${c.body.msg_seq}` },
    'POST /v2/users/U1/files': () => ({ file_info: 'fi-1' }),
  })
  servers.push(q.server)
  const adapter = new QQAdapter(config, q.endpoints)
  // A message arrives (as the gateway would deliver it), so replies may cite it.
  ;(adapter as unknown as { _inbound(t: string, d: unknown): unknown })._inbound('C2C_MESSAGE_CREATE', {
    id: 'msg-1',
    author: { user_openid: 'U1' },
    content: 'hi',
  })
  await adapter.send('c2c:U1', { text: '**one**' })
  await adapter.send('c2c:U1', {
    text: 'Allow?',
    buttons: [[{ label: 'Allow once', data: 'a:o:k' }], [{ label: 'Deny', data: 'a:d:k' }]],
  })
  const posts = q.calls.filter((c) => c.path === '/v2/users/U1/messages')
  expect(posts[0]?.body).toMatchObject({
    msg_type: 2,
    markdown: { content: '**one**' },
    msg_id: 'msg-1',
    msg_seq: 1,
  })
  expect(posts[1]?.body).toMatchObject({ msg_id: 'msg-1', msg_seq: 2 })
  const keys = posts[1]?.body.keyboard as { content: { rows: { buttons: unknown[] }[] } } | undefined
  const rows = keys?.content.rows ?? []
  expect(rows).toHaveLength(2)
  expect(rows[0]?.buttons[0]).toMatchObject({
    render_data: { label: 'Allow once' },
    action: { type: 1, data: 'a:o:k', permission: { type: 2 } },
  })
  expect(adapter.can.buttons).toBe(true)

  markdownOk = false
  await adapter.send('c2c:U1', { text: '**plain** now' })
  expect(q.calls.at(-1)?.body).toMatchObject({ msg_type: 0, content: 'plain now' })
  expect(adapter.can.buttons).toBe(false)

  await adapter.sendFile('c2c:U1', { name: 'p.png', mimeType: 'image/png', data: new Uint8Array([1, 2]) })
  const upload = q.calls.find((c) => c.path === '/v2/users/U1/files')
  expect(upload?.body).toMatchObject({ file_type: 1, file_data: 'AQI=', srv_send_msg: false })
  expect(q.calls.at(-1)?.body).toMatchObject({ msg_type: 7, media: { file_info: 'fi-1' } })
  await expect(adapter.edit()).rejects.toThrow('cannot edit')
})

test('a fatal close code stops it with the reason', async () => {
  const q = qqApi(
    { ...base, 'GET /gateway': () => ({ url: `ws://127.0.0.1:${q.server.port}/ws` }) },
    { open: (ws) => ws.close(4914, 'sandbox only') },
  )
  servers.push(q.server)
  const adapter = new QQAdapter(config, q.endpoints)
  adapters.push(adapter)
  const { handle, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'error'))
  expect(statuses.at(-1)).toMatchObject({ error: expect.stringContaining('offline or sandbox-only') })
})
