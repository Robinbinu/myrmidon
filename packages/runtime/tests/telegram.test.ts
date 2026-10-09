import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { type AdapterIO, type AdapterStatus, type Inbound, TelegramAdapter } from '../src/channels/index.ts'

type Call = { method: string; body: Record<string, unknown> }

/** A stand-in for the Bot API: each method answers from a handler; every call is recorded. */
function botApi(handlers: Record<string, (body: Record<string, unknown>, n: number) => unknown>) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop() ?? ''
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      calls.push({ method, body })
      const n = (counts.get(method) ?? 0) + 1
      counts.set(method, n)
      const handler = handlers[method]
      const answer = handler ? handler(body, n) : { ok: true, result: true }
      if (answer instanceof Promise) return Response.json(await answer)
      return Response.json(answer)
    },
  })
  return { server, calls, api: `http://127.0.0.1:${server.port}` }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: TelegramAdapter[] = []
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

const ME = { ok: true, result: { id: 9, is_bot: true, first_name: 'Myr', username: 'myrbot' } }
const user = (id: number, first: string, extra: Record<string, unknown> = {}) => ({
  id,
  is_bot: false,
  first_name: first,
  ...extra,
})

test('updates become messages: mentions in groups, commands, bots ignored, the offset saved after each', async () => {
  const updates = [
    {
      update_id: 10,
      message: {
        message_id: 1,
        date: 1,
        from: user(1, 'Alice', { username: 'alice' }),
        chat: { id: 1, type: 'private' },
        text: 'hello',
      },
    },
    {
      update_id: 11,
      message: {
        message_id: 2,
        date: 1,
        from: user(1, 'Alice'),
        chat: { id: -7, type: 'supergroup', title: 'Team' },
        text: '@myrbot please look',
        entities: [{ type: 'mention', offset: 0, length: 7 }],
      },
    },
    {
      update_id: 12,
      message: {
        message_id: 3,
        date: 1,
        from: user(1, 'Alice'),
        chat: { id: -7, type: 'supergroup', title: 'Team' },
        text: 'chatting among ourselves',
      },
    },
    {
      update_id: 13,
      message: {
        message_id: 4,
        date: 1,
        from: user(1, 'Alice'),
        chat: { id: -7, type: 'supergroup' },
        text: '/status@myrbot',
      },
    },
    {
      update_id: 14,
      message: {
        message_id: 5,
        date: 1,
        from: { id: 5, is_bot: true, first_name: 'Other' },
        chat: { id: 1, type: 'private' },
        text: 'bot talk',
      },
    },
    {
      update_id: 15,
      message: {
        message_id: 6,
        date: 1,
        from: user(1, 'Alice'),
        chat: { id: 1, type: 'private' },
        photo: [{}],
      },
    },
    {
      update_id: 16,
      message: {
        message_id: 7,
        date: 1,
        from: user(1, 'Alice'),
        chat: { id: 1, type: 'private' },
        sticker: { file_id: 's1', emoji: '👍', is_animated: false, is_video: false },
      },
    },
    {
      update_id: 17,
      message: {
        message_id: 8,
        date: 1,
        from: user(1, 'Alice'),
        chat: { id: 1, type: 'private' },
        sticker: { file_id: 's2', emoji: '🎉', is_animated: true, is_video: false },
      },
    },
  ]
  const { server, calls, api } = botApi({
    getMe: () => ME,
    getUpdates: (_b, n) =>
      n === 1 ? { ok: true, result: updates } : Bun.sleep(50).then(() => ({ ok: true, result: [] })),
  })
  servers.push(server)
  const adapter = new TelegramAdapter('TOKEN', api)
  adapters.push(adapter)
  const { handle, received, statuses, kv } = io()
  await adapter.start(handle)
  await until(() => received.length === 7)

  expect(statuses).toContainEqual({ state: 'on', account: '@myrbot' })
  expect(calls.some((c) => c.method === 'setMyCommands')).toBe(true)
  expect(received[0]).toMatchObject({
    chat: { id: '1', kind: 'dm' },
    sender: { id: '1', name: 'Alice', handle: 'alice' },
    text: 'hello',
    mentioned: true,
  })
  expect(received[1]).toMatchObject({
    chat: { id: '-7', kind: 'group', title: 'Team' },
    text: 'please look',
    mentioned: true,
  })
  expect(received[2]).toMatchObject({ mentioned: false })
  expect(received[3]).toMatchObject({ text: '/status', mentioned: true })
  expect(received[4]?.files?.[0]).toMatchObject({ kind: 'image', mimeType: 'image/jpeg' })
  // A still sticker comes as its image with its emoji; an animated one (not an image) as its emoji alone.
  expect(received[5]).toMatchObject({ text: '(sent a 👍 sticker)' })
  expect(received[5]?.files?.[0]).toMatchObject({
    kind: 'image',
    mimeType: 'image/webp',
    name: 'sticker-7.webp',
  })
  expect(received[6]).toMatchObject({ text: '(sent a 🎉 sticker)' })
  expect(received[6]?.files).toBeUndefined()
  expect(received[6]?.unsupported).toBeUndefined()
  // The bot's own kind is never delivered, and the offset moves past everything handled.
  expect(received.some((m) => m.text === 'bot talk')).toBe(false)
  await until(() => kv.get('offset') === '18')
  expect(calls.filter((c) => c.method === 'getUpdates').at(1)?.body.offset).toBe(18)
})

test('sending renders HTML, falls back to plain text when Telegram cannot parse it, and edits ignore "not modified"', async () => {
  const { server, calls, api } = botApi({
    getMe: () => ME,
    sendMessage: (body) =>
      body.parse_mode === 'HTML' && String(body.text).includes('<b>bad</b>')
        ? { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }
        : { ok: true, result: { message_id: 42 } },
    editMessageText: () => ({
      ok: false,
      error_code: 400,
      description: 'Bad Request: message is not modified',
    }),
  })
  servers.push(server)
  const adapter = new TelegramAdapter('TOKEN', api)
  const ref = await adapter.send('1', { text: '**hi** there' })
  expect(ref).toEqual({ chat: '1', id: '42' })
  expect(calls.at(-1)?.body).toMatchObject({ chat_id: '1', text: '<b>hi</b> there', parse_mode: 'HTML' })

  await adapter.send('1', { text: '**bad**' })
  expect(calls.at(-1)?.body.parse_mode).toBeUndefined()
  expect(calls.at(-1)?.body.text).toBe('**bad**')

  await adapter.edit(ref, { text: 'same' })
})

test('a refused token stops it with the reason; another poller is reported and retried', async () => {
  const refused = botApi({ getMe: () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) })
  servers.push(refused.server)
  await expect(new TelegramAdapter('BAD', refused.api).check()).rejects.toThrow('refused this token')
  const a = new TelegramAdapter('BAD', refused.api)
  adapters.push(a)
  const first = io()
  await a.start(first.handle)
  await until(() => first.statuses.some((s) => s.state === 'error'))

  const busy = botApi({
    getMe: () => ME,
    getUpdates: () => ({
      ok: false,
      error_code: 409,
      description: 'Conflict: terminated by other getUpdates request',
    }),
  })
  servers.push(busy.server)
  const b = new TelegramAdapter('TOKEN', busy.api)
  adapters.push(b)
  const second = io()
  await b.start(second.handle)
  await until(() => second.statuses.some((s) => s.state === 'retrying'))
  expect(second.statuses.at(-1)).toMatchObject({
    state: 'retrying',
    error: expect.stringContaining('another program'),
  })
})

test('button presses, files in and out, and forum topics', async () => {
  const { server, calls, api } = botApi({
    getMe: () => ME,
    getUpdates: (_b, n) =>
      n === 1
        ? {
            ok: true,
            result: [
              {
                update_id: 20,
                callback_query: {
                  id: 'cbq-1',
                  from: user(1, 'Alice'),
                  data: 'a:o:abc123',
                  message: { message_id: 50, date: 1, chat: { id: 1, type: 'private' } },
                },
              },
              {
                update_id: 21,
                message: {
                  message_id: 51,
                  date: 1,
                  from: user(1, 'Alice'),
                  chat: { id: -9, type: 'supergroup', title: 'Ops', is_forum: true },
                  message_thread_id: 77,
                  is_topic_message: true,
                  text: '@myrbot look',
                  entities: [{ type: 'mention', offset: 0, length: 7 }],
                  voice: { file_id: 'v1', file_size: 3, mime_type: 'audio/ogg' },
                },
              },
            ],
          }
        : Bun.sleep(50).then(() => ({ ok: true, result: [] })),
    getFile: () => ({ ok: true, result: { file_path: 'voice/v1.ogg' } }),
    sendDocument: () => ({ ok: true, result: { message_id: 90 } }),
    sendMessage: () => ({ ok: true, result: { message_id: 91 } }),
  })
  servers.push(server)
  // The file download is a plain GET on /file/bot<token>/<path>.
  const files = Bun.serve({ port: 0, fetch: () => new Response(new Uint8Array([7, 7, 7])) })
  servers.push(files)
  const adapter = new TelegramAdapter('TOKEN', api)
  adapters.push(adapter)
  const { handle, received } = io()
  await adapter.start(handle)
  await until(() => received.length === 2)
  expect(received[0]).toMatchObject({
    press: { id: 'cbq-1', data: 'a:o:abc123', message: { chat: '1', id: '50' } },
  })
  expect(received[1]).toMatchObject({
    chat: { id: '-9', kind: 'group', thread: '77' },
    text: 'look',
    mentioned: true,
  })
  const voice = received[1]?.files?.[0]
  expect(voice).toMatchObject({ kind: 'voice', mimeType: 'audio/ogg', size: 3 })
  // Reading it asks Telegram where the file is first.
  await voice?.read().catch(() => {})
  expect(calls.some((c) => c.method === 'getFile' && c.body.file_id === 'v1')).toBe(true)

  await adapter.answerPress({ id: 'cbq-1', data: '' }, { text: 'Allowed', echo: true })
  expect(calls.at(-1)).toMatchObject({
    method: 'answerCallbackQuery',
    body: { callback_query_id: 'cbq-1', text: 'Allowed' },
  })

  // Replies in a topic stay in it, and buttons become an inline keyboard.
  await adapter.send(received[1]?.chat ?? '', { text: 'ok', buttons: [[{ label: 'Yes', data: 'q:k:0:0' }]] })
  expect(calls.at(-1)?.body).toMatchObject({
    chat_id: '-9',
    message_thread_id: 77,
    reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: 'q:k:0:0' }]] },
  })
  const ref = await adapter.sendFile('1', {
    name: 'report.pdf',
    mimeType: 'application/pdf',
    data: new Uint8Array([1, 2]),
  })
  expect(ref).toEqual({ chat: '1', id: '90' })
  expect(calls.at(-1)?.method).toBe('sendDocument')
})

test('webhook mode: Telegram is told where to post, and only posts carrying the secret are taken', async () => {
  const { server, calls, api } = botApi({ getMe: () => ME })
  servers.push(server)
  const adapter = new TelegramAdapter('TOKEN', api)
  adapters.push(adapter)
  const { handle, received, statuses } = io()
  await adapter.start({ ...handle, webhookUrl: 'https://box.example.ts.net/hooks/channels/telegram' })
  await until(() => statuses.some((s) => s.state === 'on'))
  const set = calls.find((c) => c.method === 'setWebhook')
  expect(set?.body.url).toBe('https://box.example.ts.net/hooks/channels/telegram')
  const secret = String(set?.body.secret_token ?? '')
  expect(secret.length).toBeGreaterThan(20)

  const update = {
    update_id: 1,
    message: { message_id: 1, date: 1, from: user(1, 'Alice'), chat: { id: 1, type: 'private' }, text: 'hi' },
  }
  const post = (token?: string) =>
    adapter.webhook(
      new Request('https://box/hooks', {
        method: 'POST',
        headers: token ? { 'x-telegram-bot-api-secret-token': token } : {},
        body: JSON.stringify(update),
      }),
    )
  expect((await post()).status).toBe(401)
  expect((await post('wrong-secret-of-the-same-length-xx')).status).toBe(401)
  expect((await post(secret)).status).toBe(200)
  expect(received.map((m) => m.text)).toEqual(['hi'])
})
