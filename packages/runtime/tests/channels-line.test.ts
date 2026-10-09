import { afterEach, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LineAdapter } from '../src/channels/index.ts'
import { type Call, fakeServer, testIO, until } from './fixtures/channel-server.ts'

const SECRET = 'channel-secret'
const HOOK = 'https://box.example/hooks/channels/line'

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: LineAdapter[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** The Messaging API (and its content host) on one fake server; a reply token named `used` is refused. */
function line() {
  let n = 0
  const fake = fakeServer({
    'GET /v2/bot/info': () => ({ userId: 'Ubot', basicId: '@myr', displayName: 'Myr' }),
    'PUT /v2/bot/channel/webhook/endpoint': () => ({}),
    'GET /v2/bot/profile/U1': () => ({ displayName: 'Alice' }),
    'GET /v2/bot/group/G1/member/U1': () => ({ displayName: 'Alice' }),
    'GET /v2/bot/group/G1/summary': () => ({ groupName: 'Research' }),
    'POST /v2/bot/message/reply': (c: Call) =>
      (c.body as { replyToken?: string }).replyToken === 'used'
        ? Response.json({ message: 'Invalid reply token' }, { status: 400 })
        : { sentMessages: [{ id: `r${++n}` }] },
    'POST /v2/bot/message/push': () => ({ sentMessages: [{ id: `p${++n}` }] }),
    'POST /v2/bot/chat/loading/start': () => ({}),
    'GET /v2/bot/message/M3/content': () => new Response(new Uint8Array([1, 2, 3])),
  })
  servers.push(fake.server)
  return fake
}

function make(base: string, token = 'ACCESS-TOKEN') {
  const adapter = new LineAdapter(token, SECRET, { api: base, dataApi: base })
  adapters.push(adapter)
  return adapter
}

const sign = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body).digest('base64')

const post = (adapter: LineAdapter, events: unknown[], signature?: string) => {
  const body = JSON.stringify({ destination: 'Ubot', events })
  return adapter.webhook(
    new Request(HOOK, {
      method: 'POST',
      headers: { 'x-line-signature': signature ?? sign(body) },
      body,
    }),
  )
}

const dm = { type: 'user', userId: 'U1' }
const group = { type: 'group', groupId: 'G1', userId: 'U1' }
const text = (id: string, source: unknown, body: string, extra: Record<string, unknown> = {}) => ({
  type: 'message',
  mode: 'active',
  timestamp: 1_760_000_000_000,
  webhookEventId: `E${id}`,
  replyToken: `reply-${id}`,
  source,
  message: { id, type: 'text', text: body, ...extra },
})

test('without a public address it says so instead of starting', async () => {
  const { base } = line()
  const { handle, statuses } = testIO()
  await make(base).start(handle)
  expect(statuses).toEqual([{ state: 'error', error: expect.stringContaining('public HTTPS address') }])
})

test('starts by checking the token and pointing the webhook here; a refused token is an error', async () => {
  const fake = line()
  const { handle, statuses } = testIO(HOOK)
  await make(fake.base).start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(statuses.at(-1)).toEqual({ state: 'on', account: 'Myr (@myr)' })
  expect(fake.calls.find((c) => c.method === 'PUT')?.body).toEqual({ endpoint: HOOK })
  expect(fake.calls[0]?.headers.get('authorization')).toBe('Bearer ACCESS-TOKEN')

  const refusing = fakeServer({
    'GET /v2/bot/info': () => Response.json({ message: 'Authentication failed' }, { status: 401 }),
  })
  servers.push(refusing.server)
  const io = testIO(HOOK)
  await make(refusing.base, 'BAD').start(io.handle)
  await until(() => io.statuses.some((s) => s.state === 'error'))
  expect(io.statuses.at(-1)).toEqual({
    state: 'error',
    error: expect.stringContaining('refused this channel access token'),
  })
})

test('webhooks need the signature of the exact body with the channel secret', async () => {
  const { base } = line()
  const adapter = make(base)
  const { handle, received } = testIO(HOOK)
  await adapter.start(handle)
  const events = [text('M1', dm, 'hello')]
  expect((await post(adapter, events, '')).status).toBe(401)
  expect((await post(adapter, events, sign('{}'))).status).toBe(401)
  expect(
    (await post(adapter, events, sign(JSON.stringify({ destination: 'Ubot', events }), 'other'))).status,
  ).toBe(401)
  expect(received).toEqual([])
  // LINE's Verify button: no events, just a 200.
  expect((await post(adapter, [])).status).toBe(200)
  expect((await post(adapter, events)).status).toBe(200)
  expect(received).toHaveLength(1)
})

test('events become messages: a direct chat, a group mention, a quote of the bot, a postback, an image', async () => {
  const { base } = line()
  const adapter = make(base)
  const { handle, received } = testIO(HOOK)
  await adapter.start(handle)

  await post(adapter, [text('M1', dm, 'hello')])
  expect(received[0]).toMatchObject({
    messageId: 'M1',
    chat: { id: 'U1', kind: 'dm' },
    sender: { id: 'U1', name: 'Alice' },
    text: 'hello',
    mentioned: true,
    time: new Date(1_760_000_000_000).toISOString(),
  })

  await post(adapter, [
    text('M2', group, '@Myr summarise @Bob please', {
      mention: {
        mentionees: [
          { index: 0, length: 4, isSelf: true, type: 'user' },
          { index: 15, length: 4, isSelf: false, type: 'user', userId: 'U2' },
        ],
      },
    }),
    text('M4', group, 'just chatting'),
  ])
  expect(received[1]).toMatchObject({
    chat: { id: 'G1', kind: 'group', title: 'Research' },
    text: 'summarise @Bob please',
    mentioned: true,
  })
  expect(received[2]).toMatchObject({ chat: { id: 'G1', kind: 'group' }, mentioned: false })

  // A reply quoting one of the bot's own messages is meant for it.
  const sent = await adapter.send('G1', { text: 'Done' })
  await post(adapter, [text('M5', group, 'thanks, and one more', { quotedMessageId: sent.id })])
  expect(received[3]).toMatchObject({ mentioned: true })

  await post(adapter, [
    {
      type: 'postback',
      timestamp: 1_760_000_000_000,
      webhookEventId: 'E-press',
      replyToken: 'press-token',
      source: dm,
      postback: { data: 'a:o:k1' },
    },
    {
      type: 'message',
      timestamp: 1_760_000_000_000,
      replyToken: 'reply-M3',
      source: dm,
      message: { id: 'M3', type: 'image', contentProvider: { type: 'line' } },
    },
    { type: 'message', timestamp: 1, replyToken: 'x', source: dm, message: { id: 'M6', type: 'sticker' } },
    { type: 'follow', timestamp: 1, replyToken: 'y', source: dm },
  ])
  expect(received[4]).toMatchObject({
    messageId: 'press:E-press',
    mentioned: true,
    press: { id: 'press-token', data: 'a:o:k1' },
  })
  expect(received[5]?.files?.map((f) => [f.kind, f.name, f.mimeType])).toEqual([
    ['image', 'image-M3.jpg', 'image/jpeg'],
  ])
  expect(await received[5]?.files?.[0]?.read()).toEqual(new Uint8Array([1, 2, 3]))
  expect(received[6]).toMatchObject({ messageId: 'M6', unsupported: true })
  expect(received).toHaveLength(7)
})

test('replies by the fresh reply token, then by push; quick replies for buttons within LINE limits', async () => {
  const fake = line()
  const adapter = make(fake.base)
  const { handle } = testIO(HOOK)
  await adapter.start(handle)
  await post(adapter, [text('M1', dm, 'hello')])

  const buttons = Array.from({ length: 15 }, (_, i) => [
    { label: `Option number ${i} is long`, data: `q:k:0:${i}` },
  ])
  const first = await adapter.send('U1', { text: '**Pick** one', buttons })
  const reply = fake.calls.at(-1)
  expect(reply?.path).toBe('/v2/bot/message/reply')
  const body = reply?.body as {
    replyToken: string
    messages: { text: string; quickReply: { items: { action: Record<string, string> }[] } }[]
  }
  expect(body.replyToken).toBe('reply-M1')
  expect(body.messages[0]?.text).toBe('Pick one')
  const items = body.messages[0]?.quickReply.items ?? []
  expect(items).toHaveLength(13)
  expect(items[0]?.action).toEqual({
    type: 'postback',
    label: 'Option number 0 is …',
    data: 'q:k:0:0',
    displayText: 'Option number 0 is long',
  })
  expect(first).toEqual({ chat: 'U1', id: 'r1' })

  // The token is spent: the next message goes by push, with a retry key.
  await adapter.send('U1', { text: 'Done' })
  expect(fake.calls.at(-1)?.path).toBe('/v2/bot/message/push')
  expect(fake.calls.at(-1)?.body).toMatchObject({ to: 'U1', messages: [{ type: 'text', text: 'Done' }] })
  expect(fake.calls.at(-1)?.headers.get('x-line-retry-key')).toMatch(/^[0-9a-f-]{36}$/)

  // A token LINE refuses (used elsewhere, expired) falls back to push.
  await post(adapter, [{ ...text('M7', dm, 'again'), replyToken: 'used' }])
  await adapter.send('U1', { text: 'Still here' })
  expect(fake.calls.slice(-2).map((c) => c.path)).toEqual(['/v2/bot/message/reply', '/v2/bot/message/push'])

  await expect(adapter.edit()).rejects.toThrow(/cannot edit/)
  await adapter.typing('U1')
  expect(fake.calls.at(-1)).toMatchObject({
    path: '/v2/bot/chat/loading/start',
    body: { chatId: 'U1', loadingSeconds: 10 },
  })
  const before = fake.calls.length
  await adapter.typing('G1')
  expect(fake.calls.length).toBe(before)
})

test("a press's note is the reply to that press", async () => {
  const fake = line()
  const adapter = make(fake.base)
  const { handle, received } = testIO(HOOK)
  await adapter.start(handle)
  await post(adapter, [
    {
      type: 'postback',
      timestamp: 1,
      webhookEventId: 'E1',
      replyToken: 'press-token',
      source: dm,
      postback: { data: 'a:o:k' },
    },
  ])
  const press = received[0]?.press
  if (!press) throw new Error('no press')
  await adapter.answerPress(press, { text: 'Allowed' })
  expect(fake.calls.at(-1)).toMatchObject({
    path: '/v2/bot/message/reply',
    body: { replyToken: 'press-token', messages: [{ type: 'text', text: 'Allowed' }] },
  })
})

test('files: a small JPEG or PNG is an image LINE fetches from the gateway, anything else a link', async () => {
  const fake = line()
  const adapter = make(fake.base)
  const dir = mkdtempSync(join(tmpdir(), 'myr-line-'))
  dirs.push(dir)
  const { handle, statuses } = testIO(HOOK, dir)
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(adapter.can.files).toBe(true)

  const png = new Uint8Array([137, 80, 78, 71])
  await adapter.sendFile('U1', { name: 'chart.png', mimeType: 'image/png', data: png, caption: '**Sales**' })
  const sent = fake.calls.at(-1)?.body as { messages: Record<string, string>[] }
  expect(sent.messages[0]).toEqual({ type: 'text', text: 'Sales' })
  const image = sent.messages[1]
  expect(image).toMatchObject({ type: 'image' })
  expect(image?.originalContentUrl).toMatch(/^https:\/\/box\.example\/hooks\/channels\/line\?file=[\w-]{32}$/)
  expect(image?.previewImageUrl).toBe(image?.originalContentUrl)
  // What LINE fetches is served by the same webhook, without a signature.
  const served = await adapter.webhook(new Request(image?.originalContentUrl ?? ''))
  expect(served.headers.get('content-type')).toBe('image/png')
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(png)

  // Video needs a preview image and audio its length; they, and every other file, go as a link.
  await adapter.sendFile('U1', { name: 'talk.mp4', mimeType: 'video/mp4', data: new Uint8Array([1]) })
  const link = ((fake.calls.at(-1)?.body ?? {}) as { messages: Record<string, string>[] }).messages[0]
  expect(link?.type).toBe('text')
  expect(link?.text).toMatch(
    /^📎 talk\.mp4 \(https:\/\/box\.example\/hooks\/channels\/line\?file=[\w-]{32}\) \(the link works for 7 days\)$/,
  )
})

test('without an HTTPS public address a file is refused, so the hub lists it by name', async () => {
  const fake = line()
  const adapter = make(fake.base)
  const { handle } = testIO(
    'http://box.example/hooks/channels/line',
    mkdtempSync(join(tmpdir(), 'myr-line-')),
  )
  dirs.push(handle.dir)
  await adapter.start(handle)
  await expect(
    adapter.sendFile('U1', { name: 'a.pdf', mimeType: 'application/pdf', data: new Uint8Array([1]) }),
  ).rejects.toThrow(/public HTTPS address/)
})
