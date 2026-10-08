import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { type AdapterIO, type AdapterStatus, IMessageAdapter, type Inbound } from '../src/channels/index.ts'

const PASSWORD = 'hunter2'
const DM = 'iMessage;-;+15550000002'
const GROUP = 'iMessage;+;chat123'

type Call = { method: string; path: string; body: unknown; form?: FormData; password: string | null }
type Handler = (call: Call, n: number) => unknown

/** A stand-in for a BlueBubbles server: each `METHOD /path` answers from a handler; every call is recorded. */
function blueBubbles(handlers: Record<string, Handler>) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const password = url.searchParams.get('password')
      if (password !== PASSWORD)
        return Response.json({ status: 401, message: 'Unauthorized' }, { status: 401 })
      const type = req.headers.get('content-type') ?? ''
      const form = type.startsWith('multipart/') ? await req.formData() : undefined
      const body = form ? undefined : await req.json().catch(() => undefined)
      const route = `${req.method} ${url.pathname}`
      const call = { method: req.method, path: url.pathname, body, ...(form ? { form } : {}), password }
      calls.push(call)
      const n = (counts.get(route) ?? 0) + 1
      counts.set(route, n)
      const handler =
        handlers[route] ??
        Object.entries(handlers).find(([k]) => k.endsWith('*') && route.startsWith(k.slice(0, -1)))?.[1]
      const answer = handler ? handler(call, n) : { status: 200, data: {} }
      if (answer instanceof Response) return answer
      if (answer instanceof Promise) return Response.json(await answer)
      return Response.json(answer)
    },
  })
  return { server, calls, url: `http://127.0.0.1:${server.port}` }
}

const INFO: Handler = () => ({
  status: 200,
  data: { private_api: true, helper_connected: true, detected_imessage: 'bot@icloud.com' },
})

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: IMessageAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function io(initial: Record<string, string> = {}) {
  const received: Inbound[] = []
  const statuses: AdapterStatus[] = []
  const kv = new Map(Object.entries(initial))
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

const msg = (guid: string, chat: string, text: string, extra: Record<string, unknown> = {}) => ({
  guid,
  text,
  isFromMe: false,
  dateCreated: 1700000000000,
  handle: { address: '+15550000002' },
  chats: [{ guid: chat, displayName: chat === GROUP ? 'Crew' : '' }],
  attachments: [],
  ...extra,
})

test('polling: direct chats, groups by name or reply, attachments; own messages and tapbacks skipped; the last time saved', async () => {
  const batch = [
    msg('m1', DM, 'hello there', { dateCreated: 1700000000001 }),
    msg('m2', GROUP, 'Myrmidon, please look', { dateCreated: 1700000000002 }),
    msg('m3', GROUP, 'chatting among ourselves', { dateCreated: 1700000000003 }),
    msg('m4', DM, '￼', {
      dateCreated: 1700000000004,
      attachments: [{ guid: 'att-1', mimeType: 'image/jpeg', transferName: 'IMG_1.jpg', totalBytes: 3 }],
    }),
    msg('m5', DM, 'sent by me', { isFromMe: true, dateCreated: 1700000000005 }),
    msg('m6', DM, 'Loved “hello”', { associatedMessageType: 2000, dateCreated: 1700000000006 }),
    msg('m7', GROUP, 'and @myrmidon what next', { dateCreated: 1700000000007 }),
  ]
  const bb = blueBubbles({
    'GET /api/v1/server/info': INFO,
    'POST /api/v1/message/query': (_c, n) => ({ status: 200, data: n === 1 ? batch : [] }),
    'GET /api/v1/attachment/att-1/download': () => new Response(new Uint8Array([7, 8, 9])),
  })
  servers.push(bb.server)
  const adapter = new IMessageAdapter(bb.url, PASSWORD)
  adapters.push(adapter)
  expect(await adapter.check()).toBe('bot@icloud.com')
  const { handle, received, statuses, kv } = io({ after: '1699999999999' })
  await adapter.start(handle)
  await until(() => received.length === 5)
  expect(statuses).toContainEqual({ state: 'on', account: 'bot@icloud.com' })

  expect(received[0]).toMatchObject({
    messageId: 'm1',
    chat: { id: DM, kind: 'dm' },
    sender: { id: '+15550000002', handle: '+15550000002' },
    text: 'hello there',
    mentioned: true,
  })
  expect(received[1]).toMatchObject({
    chat: { id: GROUP, kind: 'group', title: 'Crew' },
    text: 'please look',
    mentioned: true,
  })
  expect(received[2]).toMatchObject({ mentioned: false })
  const file = received[3]?.files?.[0]
  expect(received[3]?.text).toBe('')
  expect(file).toMatchObject({ kind: 'image', name: 'IMG_1.jpg', mimeType: 'image/jpeg', size: 3 })
  expect(await file?.read()).toEqual(new Uint8Array([7, 8, 9]))
  expect(received[4]).toMatchObject({ text: 'and what next', mentioned: true })

  // Asked from the saved time, then from the newest message seen (own ones included, so they are not asked again).
  const queries = () => bb.calls.filter((c) => c.path === '/api/v1/message/query')
  expect(queries()[0]?.body).toMatchObject({ after: 1699999999999, sort: 'ASC' })
  await until(() => queries().length >= 2, 4000)
  expect(queries()[1]?.body).toMatchObject({ after: 1700000000007 })
  expect(kv.get('after')).toBe('1700000000007')
})

test('sending: plain text by chat GUID, files as a form, typing with the private API; a reply to it in a group counts', async () => {
  const bb = blueBubbles({
    'GET /api/v1/server/info': INFO,
    'POST /api/v1/message/text': () => ({ status: 200, data: { guid: 'sent-1' } }),
    'POST /api/v1/message/attachment': () => ({ status: 200, data: { guid: 'sent-2' } }),
    'POST /api/v1/message/query': (_c, n) => ({
      status: 200,
      data: n === 1 ? [msg('r1', GROUP, 'yes, do that', { threadOriginatorGuid: 'sent-1' })] : [],
    }),
  })
  servers.push(bb.server)
  const adapter = new IMessageAdapter(bb.url, PASSWORD)
  adapters.push(adapter)
  await adapter.check()

  const ref = await adapter.send(GROUP, { text: '**Done** · see [the doc](https://example.com)' })
  expect(ref).toEqual({ chat: GROUP, id: 'sent-1' })
  expect(bb.calls.at(-1)?.body).toMatchObject({
    chatGuid: GROUP,
    message: 'Done · see the doc (https://example.com)',
  })

  await adapter.sendFile(DM, {
    name: 'report.pdf',
    mimeType: 'application/pdf',
    data: new Uint8Array([1, 2]),
  })
  const upload = bb.calls.find((c) => c.path === '/api/v1/message/attachment')
  expect(upload?.form?.get('chatGuid')).toBe(DM)
  expect(upload?.form?.get('name')).toBe('report.pdf')
  expect((upload?.form?.get('attachment') as File | null)?.size).toBe(2)

  await adapter.typing(DM)
  expect(bb.calls.at(-1)?.path).toBe(`/api/v1/chat/${encodeURIComponent(DM)}/typing`)
  expect(adapter.can).toEqual({ buttons: false, files: true, edit: false })

  const { handle, received } = io()
  await adapter.start(handle)
  await until(() => received.length === 1)
  expect(received[0]).toMatchObject({ text: 'yes, do that', mentioned: true })
})

test('a wrong password stops it with the reason; an unreachable server is retried', async () => {
  const bb = blueBubbles({ 'GET /api/v1/server/info': INFO })
  servers.push(bb.server)
  await expect(new IMessageAdapter(bb.url, 'wrong').check()).rejects.toThrow('refused this password')
  const refused = new IMessageAdapter(bb.url, 'wrong')
  adapters.push(refused)
  const first = io()
  await refused.start(first.handle)
  await until(() => first.statuses.some((s) => s.state === 'error'))
  // The password is never in what Settings shows.
  expect(JSON.stringify(first.statuses)).not.toContain('wrong')

  const gone = new IMessageAdapter('http://127.0.0.1:1', PASSWORD)
  adapters.push(gone)
  const second = io()
  await gone.start(second.handle)
  await until(() => second.statuses.some((s) => s.state === 'retrying'))
  expect(JSON.stringify(second.statuses)).not.toContain(PASSWORD)
})

test('webhook mode: registers a URL with a secret of its own, replaces a stale one, and takes only posts carrying it', async () => {
  const base = 'https://box.example.ts.net/hooks/channels/imessage'
  const bb = blueBubbles({
    'GET /api/v1/server/info': INFO,
    'GET /api/v1/webhook': () => ({ status: 200, data: [{ id: 4, url: `${base}?token=old` }] }),
    'POST /api/v1/webhook': () => ({ status: 200, data: { id: 5 } }),
    'DELETE /api/v1/webhook/*': () => ({ status: 200, data: {} }),
  })
  servers.push(bb.server)
  const adapter = new IMessageAdapter(bb.url, PASSWORD)
  adapters.push(adapter)
  const { handle, received, statuses } = io()
  await adapter.start({ ...handle, webhookUrl: base })
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(bb.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/webhook/4')).toBe(true)
  const registered = bb.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/webhook')?.body as {
    url: string
    events: string[]
  }
  expect(registered.events).toEqual(['new-message'])
  const secret = new URL(registered.url).searchParams.get('token') ?? ''
  expect(secret.length).toBeGreaterThan(20)
  // No polling when the server pushes.
  expect(bb.calls.some((c) => c.path === '/api/v1/message/query')).toBe(false)

  const post = (token: string, body: unknown) =>
    adapter.webhook(new Request(`${base}?token=${token}`, { method: 'POST', body: JSON.stringify(body) }))
  const event = { type: 'new-message', data: msg('w1', DM, 'pushed') }
  expect((await post('x'.repeat(secret.length), event)).status).toBe(401)
  expect((await post(secret, { type: 'updated-message', data: msg('w0', DM, 'read receipt') })).status).toBe(
    200,
  )
  expect((await post(secret, event)).status).toBe(200)
  expect(received.map((m) => m.text)).toEqual(['pushed'])
})
