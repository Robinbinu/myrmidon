import { afterEach, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import type { ServerWebSocket } from 'bun'
import { type AdapterIO, type AdapterStatus, DingTalkAdapter, type Inbound } from '../src/channels/index.ts'

type Call = { method: string; path: string; body: Record<string, unknown>; token?: string }

/** A stand-in for DingTalk's API and Stream gateway (`/stream`). */
function dingtalk(
  handlers: Record<string, (call: Call) => unknown>,
  onOpen?: (ws: ServerWebSocket<unknown>) => void,
) {
  const calls: Call[] = []
  const frames: Record<string, unknown>[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/stream')
        return url.searchParams.get('ticket') === 'tk' && srv.upgrade(req)
          ? undefined
          : new Response('no', { status: 403 })
      const call: Call = {
        method: req.method,
        path: url.pathname,
        body: (await req.json().catch(() => ({}))) as Record<string, unknown>,
        token: req.headers.get('x-acs-dingtalk-access-token') ?? undefined,
      }
      calls.push(call)
      const handler = handlers[`${req.method} ${url.pathname}`]
      const answer = handler ? handler(call) : {}
      return answer instanceof Response ? answer : Response.json(answer)
    },
    websocket: {
      open: (ws) => onOpen?.(ws),
      message: (_ws, data) => {
        frames.push(JSON.parse(String(data)))
      },
    },
  })
  return { server, calls, frames, api: `http://127.0.0.1:${server.port}` }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: DingTalkAdapter[] = []
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

const config = { clientId: 'dingid', clientSecret: 'dingsecret' }
const TOKEN = { 'POST /v1.0/oauth2/accessToken': () => ({ accessToken: 'at-1', expireIn: 7200 }) }

const robotMessage = (api: string, extra: Record<string, unknown>) => ({
  msgId: 'msg1',
  msgtype: 'text',
  text: { content: ' hello ' },
  conversationId: 'cid-dm',
  conversationType: '1',
  senderId: '$:LWCP:abc',
  senderStaffId: 'staff-1',
  senderNick: 'Alice',
  sessionWebhook: `${api}/robot/sendBySession?session=s1`,
  sessionWebhookExpiredTime: Date.now() + 3_600_000,
  createAt: 1_700_000_000_000,
  ...extra,
})

const callback = (id: string, data: unknown) =>
  JSON.stringify({
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: { topic: '/v1.0/im/bot/messages/get', messageId: id, contentType: 'application/json' },
    data: JSON.stringify(data),
  })

test('check() takes the Client ID and secret; refused ones say so', async () => {
  const ok = dingtalk(TOKEN)
  servers.push(ok.server)
  expect(await new DingTalkAdapter(config, ok.api).check()).toBe('dingid')
  expect(ok.calls[0]?.body).toEqual({ appKey: 'dingid', appSecret: 'dingsecret' })

  const refused = dingtalk({
    'POST /v1.0/oauth2/accessToken': () =>
      Response.json({ code: 'invalidClientIdOrSecret', message: 'bad' }, { status: 400 }),
  })
  servers.push(refused.server)
  await expect(new DingTalkAdapter(config, refused.api).check()).rejects.toThrow('refused this Client ID')
  const a = new DingTalkAdapter(config, refused.api)
  adapters.push(a)
  const { handle, statuses } = io()
  await a.start(handle)
  await until(() => statuses.some((s) => s.state === 'error'))
})

test('Stream mode: pings echoed, robot messages acked and mapped (direct, group with and without @)', async () => {
  const d = dingtalk(
    {
      ...TOKEN,
      'POST /v1.0/gateway/connections/open': (c) =>
        c.body.clientSecret === 'dingsecret'
          ? { endpoint: `ws://127.0.0.1:${d.server.port}/stream`, ticket: 'tk' }
          : Response.json({ message: 'no' }, { status: 401 }),
    },
    (ws) => {
      ws.send(
        JSON.stringify({ type: 'SYSTEM', headers: { topic: 'ping', messageId: 'p1' }, data: '{"opaque":1}' }),
      )
      ws.send(callback('c1', robotMessage(d.api, {})))
      ws.send(
        callback(
          'c2',
          robotMessage(d.api, {
            msgId: 'msg2',
            conversationId: 'cid-group',
            conversationType: '2',
            conversationTitle: 'Ops',
            isInAtList: true,
            text: { content: 'look at this' },
          }),
        ),
      )
      ws.send(
        callback(
          'c3',
          robotMessage(d.api, {
            msgId: 'msg3',
            conversationId: 'cid-group',
            conversationType: '2',
            isInAtList: false,
          }),
        ),
      )
      ws.send(
        callback(
          'c4',
          robotMessage(d.api, {
            msgId: 'msg4',
            msgtype: 'picture',
            text: undefined,
            content: { downloadCode: 'dc1' },
          }),
        ),
      )
    },
  )
  servers.push(d.server)
  const adapter = new DingTalkAdapter(config, d.api)
  adapters.push(adapter)
  const { handle, received, statuses, kv } = io()
  await adapter.start(handle)
  await until(() => received.length === 4)
  expect(statuses).toContainEqual({ state: 'on', account: 'dingid' })
  expect(received[0]).toMatchObject({
    messageId: 'msg1',
    chat: { id: 'cid-dm', kind: 'dm' },
    sender: { id: 'staff-1', name: 'Alice' },
    text: 'hello',
    mentioned: true,
  })
  expect(received[1]).toMatchObject({
    chat: { id: 'cid-group', kind: 'group', title: 'Ops' },
    mentioned: true,
  })
  expect(received[2]).toMatchObject({ mentioned: false })
  expect(received[3]?.files?.[0]).toMatchObject({ kind: 'image' })
  expect(kv.get('staff:cid-dm')).toBe('staff-1')
  await until(() => d.frames.length === 5)
  expect(d.frames[0]).toMatchObject({ code: 200, data: '{"opaque":1}' })
  expect(d.frames.slice(1).map((f) => (f.headers as { messageId: string }).messageId)).toEqual([
    'c1',
    'c2',
    'c3',
    'c4',
  ])
})

test('sending: through the session webhook while valid, else the robot API; files read by download code', async () => {
  const d = dingtalk({
    ...TOKEN,
    'POST /robot/sendBySession': () => ({ errcode: 0, errmsg: 'ok' }),
    'POST /v1.0/robot/oToMessages/batchSend': () => ({ processQueryKey: 'pq-1' }),
    'POST /v1.0/robot/groupMessages/send': () => ({ processQueryKey: 'pq-2' }),
    'POST /v1.0/robot/messageFiles/download': (c) => ({
      downloadUrl: `http://127.0.0.1:${d.server.port}/f/${c.body.downloadCode}`,
    }),
    'GET /f/dc1': () => new Response(new Uint8Array([4, 2])),
  })
  servers.push(d.server)
  const adapter = new DingTalkAdapter(config, d.api)
  adapters.push(adapter)
  const { handle, received, kv } = io()
  await adapter.start({ ...handle })
  // A message by the HTTP callback (signed) leaves its session webhook behind.
  const ts = String(Date.now())
  const sign = createHmac('sha256', 'dingsecret').update(`${ts}\ndingsecret`).digest('base64')
  const hook = (body: unknown, headers: Record<string, string>) =>
    adapter.webhook(new Request('https://box/hooks', { method: 'POST', headers, body: JSON.stringify(body) }))
  expect((await hook(robotMessage(d.api, {}), { timestamp: ts, sign })).status).toBe(200)
  expect((await hook(robotMessage(d.api, {}), { timestamp: ts, sign: 'nope' })).status).toBe(401)
  const old = String(Date.now() - 2 * 3_600_000)
  const oldSign = createHmac('sha256', 'dingsecret').update(`${old}\ndingsecret`).digest('base64')
  expect((await hook(robotMessage(d.api, {}), { timestamp: old, sign: oldSign })).status).toBe(401)
  expect(received).toHaveLength(1)

  await adapter.send(received[0]?.chat ?? 'cid-dm', { text: '# Done\n1. one' })
  expect(d.calls.at(-1)).toMatchObject({
    path: '/robot/sendBySession',
    body: { msgtype: 'markdown', markdown: { title: 'Done', text: '# Done\n\n1. one' } },
  })

  // Expired: the robot API, by staff id for a direct chat.
  kv.set('hook:cid-dm', JSON.stringify({ url: `${d.api}/robot/sendBySession`, until: Date.now() - 1 }))
  const ref = await adapter.send('cid-dm', { text: 'later' })
  expect(ref.id).toBe('pq-1')
  expect(d.calls.at(-1)).toMatchObject({
    path: '/v1.0/robot/oToMessages/batchSend',
    token: 'at-1',
    body: { robotCode: 'dingid', userIds: ['staff-1'], msgKey: 'sampleMarkdown' },
  })
  kv.set('kind:cid-g', 'group')
  await adapter.send('cid-g', { text: 'to the group' })
  expect(d.calls.at(-1)?.body).toMatchObject({ openConversationId: 'cid-g' })
  await expect(adapter.edit()).rejects.toThrow('cannot edit')

  await hook(robotMessage(d.api, { msgId: 'pic', msgtype: 'picture', content: { downloadCode: 'dc1' } }), {
    timestamp: ts,
    sign,
  })
  expect([...((await received.at(-1)?.files?.[0]?.read()) ?? [])]).toEqual([4, 2])
})
