import { afterEach, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { type AdapterIO, type AdapterStatus, type Inbound, WebhookAdapter } from '../src/channels/index.ts'

const SECRET = 'a-shared-secret-of-enough-length'
const URL_ = 'https://box.example.ts.net/hooks/channels/webhook'

const servers: { stop(force?: boolean): unknown }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

function io(webhookUrl: string | null = URL_) {
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
    ...(webhookUrl ? { webhookUrl } : {}),
  }
  return { handle, received, statuses }
}

const sign = (body: string, timestamp: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`

const now = () => String(Math.floor(Date.now() / 1000))

function post(adapter: WebhookAdapter, payload: unknown, headers: Record<string, string> = {}) {
  return adapter.webhook(
    new Request(URL_, {
      method: 'POST',
      headers,
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    }),
  )
}

const signed = (payload: unknown, timestamp = now()) => {
  const body = JSON.stringify(payload)
  return { body, headers: { 'x-timestamp': timestamp, 'x-signature': sign(body, timestamp) } }
}

/** A callback receiver recording each POST's headers and body. */
function callback(status = 200) {
  const posts: { headers: Headers; body: string }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      posts.push({ headers: req.headers, body: await req.text() })
      return new Response('ok', { status })
    },
  })
  servers.push(server)
  return { posts, url: `http://127.0.0.1:${server.port}/replies` }
}

const message = {
  id: 'evt-1',
  chat: { id: 'kitchen', kind: 'group', title: 'Kitchen', thread: 'dishwasher' },
  sender: { id: 'ha', name: 'Home Assistant' },
  text: 'the dishwasher is done',
  files: [{ name: 'note.txt', mimeType: 'text/plain', data: Buffer.from('hello').toString('base64') }],
}

test('a signed post becomes a message: chat, thread, sender and files mapped', async () => {
  const adapter = new WebhookAdapter(SECRET, 'https://example.com/cb', 'Home')
  const { handle, received, statuses } = io()
  await adapter.start(handle)
  expect(statuses.at(-1)).toEqual({ state: 'on', account: 'Home' })
  const { body, headers } = signed(message)
  const res = await post(adapter, body, headers)
  expect(res.status).toBe(200)
  const m = received[0]
  expect(m?.messageId).toBe('evt-1')
  expect(m?.chat).toEqual({ id: 'kitchen', kind: 'group', title: 'Kitchen', thread: 'dishwasher' })
  expect(m?.sender).toEqual({ id: 'ha', name: 'Home Assistant' })
  expect(m?.text).toBe('the dishwasher is done')
  expect(m?.mentioned).toBe(true)
  expect(m?.files?.[0]?.kind).toBe('document')
  expect(new TextDecoder().decode(await m?.files?.[0]?.read())).toBe('hello')

  // A plain chat id is a direct chat.
  const dm = signed({ id: 2, chat: 'me', sender: { id: 'script' }, text: 'hi' })
  await post(adapter, dm.body, dm.headers)
  expect(received[1]?.chat).toEqual({ id: 'me', kind: 'dm' })
  expect(received[1]?.sender.name).toBe('script')
})

test('posts without a valid signature are refused before they are read', async () => {
  const adapter = new WebhookAdapter(SECRET, 'https://example.com/cb')
  const { handle, received } = io()
  await adapter.start(handle)
  const { body } = signed(message)
  expect((await post(adapter, body)).status).toBe(401)
  const ts = now()
  expect(
    (
      await post(adapter, body, {
        'x-timestamp': ts,
        'x-signature': sign(body, ts, 'another-secret-entirely'),
      })
    ).status,
  ).toBe(401)
  // The body changed after signing.
  const { headers } = signed(message)
  expect((await post(adapter, JSON.stringify({ ...message, text: 'rm -rf' }), headers)).status).toBe(401)
  expect(received).toHaveLength(0)
})

test('replays are refused: an old signature, or a fresh timestamp on an old signature', async () => {
  const adapter = new WebhookAdapter(SECRET, 'https://example.com/cb')
  const { handle, received } = io()
  await adapter.start(handle)
  const old = String(Math.floor(Date.now() / 1000) - 6 * 60)
  const stale = signed(message, old)
  expect((await post(adapter, stale.body, stale.headers)).status).toBe(401)
  // The timestamp is inside the signature, so swapping in a fresh one breaks it.
  expect((await post(adapter, stale.body, { ...stale.headers, 'x-timestamp': now() })).status).toBe(401)
  expect(received).toHaveLength(0)
})

test('a signed post that is not a message is a bad request', async () => {
  const adapter = new WebhookAdapter(SECRET, 'https://example.com/cb')
  const { handle } = io()
  await adapter.start(handle)
  const missing = signed({ id: '1', chat: 'c', text: 'no sender' })
  expect((await post(adapter, missing.body, missing.headers)).status).toBe(400)
  const ts = now()
  expect(
    (await post(adapter, 'not json', { 'x-timestamp': ts, 'x-signature': sign('not json', ts) })).status,
  ).toBe(400)
})

test('replies, edits and files are POSTed to the callback, signed the same way', async () => {
  const { posts, url } = callback()
  const adapter = new WebhookAdapter(SECRET, url)
  const ref = await adapter.send({ id: 'kitchen', kind: 'group', thread: 'dishwasher' }, { text: '**Done**' })
  await adapter.edit(ref, { text: 'Done!' })
  await adapter.sendFile('kitchen', {
    name: 'a.txt',
    mimeType: 'text/plain',
    data: new Uint8Array([104, 105]),
  })
  expect(posts).toHaveLength(3)
  for (const p of posts) {
    const ts = p.headers.get('x-timestamp') ?? ''
    expect(p.headers.get('x-signature')).toBe(sign(p.body, ts))
    expect(Math.abs(Date.now() / 1000 - Number(ts))).toBeLessThan(5)
  }
  const [sent, edited, file] = posts.map((p) => JSON.parse(p.body))
  expect(sent).toEqual({
    type: 'message',
    id: ref.id,
    chat: 'kitchen',
    thread: 'dishwasher',
    text: '**Done**',
  })
  expect(edited).toEqual({ type: 'edit', id: ref.id, chat: 'kitchen', text: 'Done!' })
  expect(file.type).toBe('file')
  expect(Buffer.from(file.data, 'base64').toString()).toBe('hi')
})

test('a refusing callback fails the send; a weak secret or bad URL fails the check', async () => {
  const { url } = callback(401)
  await expect(new WebhookAdapter(SECRET, url).send('c', { text: 'x' })).rejects.toThrow('answered 401')
  await expect(new WebhookAdapter('short', url).check()).rejects.toThrow('at least 16')
  await expect(new WebhookAdapter(SECRET, 'ftp://x').check()).rejects.toThrow('https://')
})

test('without a public address it cannot receive, and says so', async () => {
  const adapter = new WebhookAdapter(SECRET, 'https://example.com/cb')
  const { handle, statuses } = io(null)
  await adapter.start(handle)
  expect(statuses.at(-1)?.state).toBe('error')
  expect(JSON.stringify(statuses.at(-1))).toContain('public HTTPS address')
})
