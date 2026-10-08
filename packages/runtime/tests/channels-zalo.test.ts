import { afterEach, expect, test } from 'bun:test'
import { ZaloAdapter } from '../src/channels/zalo.ts'
import { fakeIO, until } from './fixtures/channel-io.ts'

type Call = { method: string; body: Record<string, unknown> }

/** A stand-in for the Zalo Bot API: each method answers from a handler; every call is recorded. */
function zaloApi(handlers: Record<string, (body: Record<string, unknown>, n: number) => unknown>) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/photo.jpg') return new Response(new Uint8Array([1, 2, 3]))
      const method = url.pathname.split('/').pop() ?? ''
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      calls.push({ method, body })
      const n = (counts.get(method) ?? 0) + 1
      counts.set(method, n)
      const answer = handlers[method] ? handlers[method](body, n) : { ok: true, result: true }
      return Response.json(answer instanceof Promise ? await answer : answer)
    },
  })
  servers.push(server)
  return { calls, api: `http://127.0.0.1:${server.port}` }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: ZaloAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

const TOKEN = '12345:secret-part'
const ME = {
  ok: true,
  result: { id: '12345', account_name: 'MyrBot', account_type: 'BASIC', can_join_groups: true },
}
const IDLE = () => Bun.sleep(30).then(() => ({ ok: false, error_code: 408, description: 'Request timeout' }))
const update = (event: string, message: Record<string, unknown>) => ({
  ok: true,
  result: {
    event_name: event,
    message: {
      from: { id: 'u1', display_name: 'An' },
      chat: { id: 'u1', chat_type: 'PRIVATE' },
      date: 1774086023728,
      ...message,
    },
  },
})

test('check says which bot; a refused or malformed token says why', async () => {
  const { api } = zaloApi({ getMe: () => ME })
  expect(await new ZaloAdapter(TOKEN, api).check()).toBe('MyrBot')
  await expect(new ZaloAdapter('not-a-token', api).check()).rejects.toThrow('looks like')
  const refused = zaloApi({ getMe: () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) })
  await expect(new ZaloAdapter(TOKEN, refused.api).check()).rejects.toThrow('Zalo refused this bot token')
})

test('polled updates become messages: DMs, groups only when @mentioned, photos; bots ignored', async () => {
  const { api } = zaloApi({ getMe: () => ME })
  const queue = [
    update('message.text.received', { message_id: 'm1', text: 'xin chào' }),
    update('message.text.received', {
      message_id: 'm2',
      chat: { id: 'g1', chat_type: 'GROUP' },
      text: '@MyrBot làm việc này',
    }),
    update('message.text.received', {
      message_id: 'm3',
      chat: { id: 'g1', chat_type: 'GROUP' },
      text: 'nói chuyện',
    }),
    update('message.text.received', { message_id: 'm4', from: { id: 'b', is_bot: true }, text: 'bot' }),
    update('message.image.received', {
      message_id: 'm5',
      photo_url: `${api}/photo.jpg`,
      caption: 'look',
      date: 1774086023,
    }),
    update('message.sticker.received', { message_id: 'm6', sticker: 's1' }),
  ]
  const polling = zaloApi({ getMe: () => ME, getUpdates: () => queue.shift() ?? IDLE() })
  const adapter = new ZaloAdapter(TOKEN, polling.api)
  adapters.push(adapter)
  const { handle, received, statuses } = fakeIO()
  await adapter.start(handle)
  await until(() => received.length === 5)
  expect(statuses).toContainEqual({ state: 'on', account: 'MyrBot' })
  expect(polling.calls.some((c) => c.method === 'deleteWebhook')).toBe(true)
  expect(received[0]).toMatchObject({
    messageId: 'm1',
    chat: { id: 'u1', kind: 'dm' },
    sender: { id: 'u1', name: 'An' },
    text: 'xin chào',
    mentioned: true,
    time: new Date(1774086023728).toISOString(),
  })
  expect(received[1]).toMatchObject({
    chat: { id: 'g1', kind: 'group' },
    text: 'làm việc này',
    mentioned: true,
  })
  expect(received[2]).toMatchObject({ mentioned: false })
  expect(received[3]).toMatchObject({
    messageId: 'm5',
    text: 'look',
    time: new Date(1774086023000).toISOString(),
  })
  expect(await received[3]?.files?.[0]?.read()).toEqual(new Uint8Array([1, 2, 3]))
  expect(received[4]).toMatchObject({ messageId: 'm6', unsupported: true })
  expect(statuses.some((s) => s.state === 'retrying')).toBe(false)
})

test('sending is plain text to the chat; typing is a chat action', async () => {
  const { calls, api } = zaloApi({ sendMessage: () => ({ ok: true, result: { message_id: 'z1' } }) })
  const adapter = new ZaloAdapter(TOKEN, api)
  expect(await adapter.send('u1', { text: '**Xong** rồi' })).toEqual({ chat: 'u1', id: 'z1' })
  expect(calls.at(-1)).toEqual({ method: 'sendMessage', body: { chat_id: 'u1', text: 'Xong rồi' } })
  // What the hub sends unsplit (an approval with a long preview) goes as several messages.
  const before = calls.length
  await adapter.send('u1', { text: Array.from({ length: 900 }, (_, i) => `từ${i}`).join(' ') })
  const pieces = calls.slice(before).map((c) => String(c.body.text))
  expect(pieces.length).toBe(3)
  for (const piece of pieces) expect([...piece].length).toBeLessThanOrEqual(2000)
  expect(pieces.join(' ')).toBe(Array.from({ length: 900 }, (_, i) => `từ${i}`).join(' '))
  await adapter.typing('u1')
  expect(calls.at(-1)).toEqual({ method: 'sendChatAction', body: { chat_id: 'u1', action: 'typing' } })
})

test('webhook mode: Zalo is told where to post, and only JSON posts carrying the secret are taken', async () => {
  const { calls, api } = zaloApi({ getMe: () => ME })
  const adapter = new ZaloAdapter(TOKEN, api)
  adapters.push(adapter)
  const { handle, received, statuses } = fakeIO()
  await adapter.start({ ...handle, webhookUrl: 'https://box.example.ts.net/hooks/channels/zalo' })
  await until(() => statuses.some((s) => s.state === 'on'))
  const set = calls.find((c) => c.method === 'setWebhook')
  expect(set?.body.url).toBe('https://box.example.ts.net/hooks/channels/zalo')
  const secret = String(set?.body.secret_token ?? '')
  expect(secret.length).toBeGreaterThanOrEqual(8)
  expect(calls.some((c) => c.method === 'getUpdates')).toBe(false)

  const post = (token: string | undefined, body: unknown, type = 'application/json') =>
    adapter.webhook(
      new Request('https://box/hooks', {
        method: 'POST',
        headers: { 'content-type': type, ...(token ? { 'x-bot-api-secret-token': token } : {}) },
        body: JSON.stringify(body),
      }),
    )
  const hook = update('message.text.received', { message_id: 'w1', text: 'qua webhook' }).result
  expect((await post(undefined, hook)).status).toBe(401)
  expect((await post('x'.repeat(secret.length), hook)).status).toBe(401)
  expect((await post(secret, hook, 'text/plain')).status).toBe(415)
  expect((await post(secret, hook)).status).toBe(200)
  // The `{ ok, result }` envelope is taken too.
  expect(
    (await post(secret, { ok: true, result: { ...hook, message: { ...hook.message, message_id: 'w2' } } }))
      .status,
  ).toBe(200)
  expect(received.map((m) => m.messageId)).toEqual(['w1', 'w2'])
})

test('a token refused while polling stops it with the reason; network errors are retried', async () => {
  const { api } = zaloApi({
    getMe: () => ME,
    getUpdates: () => ({ ok: false, error_code: 401, description: 'Unauthorized' }),
  })
  const adapter = new ZaloAdapter(TOKEN, api)
  adapters.push(adapter)
  const { handle, statuses } = fakeIO()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'error'))
  expect(statuses.at(-1)).toMatchObject({ error: expect.stringContaining('refused this bot token') })

  const down = Bun.serve({ port: 0, fetch: () => new Response('') })
  const url = `http://127.0.0.1:${down.port}`
  down.stop(true)
  const b = new ZaloAdapter(TOKEN, url)
  adapters.push(b)
  const second = fakeIO()
  await b.start(second.handle)
  await until(() => second.statuses.some((s) => s.state === 'retrying'))
  expect(second.statuses.at(-1)).toMatchObject({ error: expect.stringContaining('cannot reach Zalo') })
})
