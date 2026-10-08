import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import {
  type AdapterIO,
  type AdapterStatus,
  type Inbound,
  SynologyChatAdapter,
} from '../src/channels/index.ts'

const PUBLIC = 'https://box.example.ts.net/hooks/channels/synology-chat'
const TOKEN = 'outgoing-token-from-synology'

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: SynologyChatAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

/** A stand-in for the NAS's chat API: user_list answers by token; posts are recorded. */
function nas(goodToken = 'bot-token') {
  const posts: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const ok = url.searchParams.get('token') === `"${goodToken}"`
      if (url.searchParams.get('method') === 'user_list')
        return Response.json(
          ok ? { success: true, data: { users: [] } } : { success: false, error: { code: 105 } },
        )
      const form = new URLSearchParams(await req.text())
      posts.push(JSON.parse(form.get('payload') ?? '{}'))
      return Response.json(ok ? { success: true } : { success: false, error: { code: 404 } })
    },
  })
  servers.push(server)
  const incoming = (token = goodToken) =>
    `http://127.0.0.1:${server.port}/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22${token}%22`
  return { posts, incoming, host: `127.0.0.1:${server.port}` }
}

function io(webhookUrl: string | null = PUBLIC) {
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

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(PUBLIC, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  })

test('the check asks the NAS for its users: a refused incoming URL is an error', async () => {
  const { incoming, host } = nas()
  expect(await new SynologyChatAdapter(incoming(), TOKEN).check()).toBe(host)
  await expect(new SynologyChatAdapter(incoming('wrong'), TOKEN).check()).rejects.toThrow(
    'refused the incoming URL',
  )
})

test('posts carrying the outgoing token become direct messages; others are refused', async () => {
  const { incoming } = nas()
  const adapter = new SynologyChatAdapter(incoming(), TOKEN)
  adapters.push(adapter)
  const { handle, received, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.at(-1)?.state === 'on')
  const fields = { user_id: '5', username: 'alice', post_id: '77', timestamp: '1700000000', text: 'hi there' }
  expect((await adapter.webhook(form(fields))).status).toBe(401)
  expect((await adapter.webhook(form({ ...fields, token: 'outgoing-token-from-synologx' }))).status).toBe(401)
  expect((await adapter.webhook(form({ ...fields, token: TOKEN }))).status).toBe(204)
  // In a header, and with a channel webhook's trigger word.
  expect(
    (
      await adapter.webhook(
        form(
          { ...fields, post_id: '78', trigger_word: '!myr', text: '!myr do it' },
          { 'x-synology-token': TOKEN },
        ),
      )
    ).status,
  ).toBe(204)
  expect(received).toHaveLength(2)
  expect(received[0]).toMatchObject({
    messageId: '77',
    chat: { id: '5', kind: 'dm' },
    sender: { id: '5', name: 'alice' },
    text: 'hi there',
    mentioned: true,
    time: new Date(1700000000 * 1000).toISOString(),
  })
  expect(received[1]?.text).toBe('do it')
  expect((await adapter.webhook(form({ token: TOKEN, user_id: '5' }))).status).toBe(400)
})

test('replies go to the incoming URL with the numeric user id; a refusal fails the send', async () => {
  const { incoming, posts } = nas()
  const adapter = new SynologyChatAdapter(incoming(), TOKEN)
  await adapter.send({ id: '5', kind: 'dm' }, { text: 'hello' })
  expect(posts).toEqual([{ text: 'hello', user_ids: [5] }])
  await expect(adapter.send('alice', { text: 'x' })).rejects.toThrow('numeric user id')
  await expect(new SynologyChatAdapter(incoming('wrong'), TOKEN).send('5', { text: 'x' })).rejects.toThrow(
    'refused the message',
  )
})

test('files are hosted on the webhook route for the NAS to fetch, briefly and unguessably', async () => {
  const { incoming, posts } = nas()
  const adapter = new SynologyChatAdapter(incoming(), TOKEN)
  adapters.push(adapter)
  const { handle } = io()
  await adapter.start(handle)
  await adapter.sendFile('5', {
    name: 'report.pdf',
    mimeType: 'application/pdf',
    data: new Uint8Array([1, 2, 3]),
    caption: 'here',
  })
  expect(posts[0]).toEqual({ text: 'here', user_ids: [5] })
  const fileUrl = String(posts[1]?.file_url)
  expect(fileUrl.startsWith(`${PUBLIC}?file=`)).toBe(true)
  const res = await adapter.webhook(new Request(fileUrl))
  expect(res.status).toBe(200)
  expect(res.headers.get('content-disposition')).toContain('attachment')
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3])
  expect((await adapter.webhook(new Request(`${PUBLIC}?file=guess`))).status).toBe(404)
  await expect(
    adapter.sendFile('5', { name: 'page.html', mimeType: 'text/html', data: new Uint8Array([60]) }),
  ).rejects.toThrow('not sent as a file')
})

test('without a public address it cannot receive, and says so', async () => {
  const { incoming } = nas()
  const adapter = new SynologyChatAdapter(incoming(), TOKEN)
  const { handle, statuses } = io(null)
  await adapter.start(handle)
  expect(statuses.at(-1)).toMatchObject({ state: 'error' })
  expect(JSON.stringify(statuses.at(-1))).toContain('public HTTPS address')
})

test('a refused incoming URL is an error until changed', async () => {
  const { incoming } = nas()
  const adapter = new SynologyChatAdapter(incoming('wrong'), TOKEN)
  adapters.push(adapter)
  const { handle, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.at(-1)?.state === 'error')
  expect(JSON.stringify(statuses.at(-1))).toContain('refused the incoming URL')
})
