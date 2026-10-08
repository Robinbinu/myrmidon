import { afterEach, expect, test } from 'bun:test'
import { createHmac, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  type AdapterIO,
  type AdapterStatus,
  type Inbound,
  NextcloudTalkAdapter,
} from '../src/channels/index.ts'

const SECRET = 'talk-bot-secret-0123456789abcdef'
const PUBLIC = 'https://box.example.ts.net/hooks/channels/nextcloud-talk'

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: NextcloudTalkAdapter[] = []
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

const hmac = (data: string, secret = SECRET) => createHmac('sha256', secret).update(data).digest('hex')

/** A stand-in for Nextcloud: status, the user check, room lookups and the bot API (which checks signatures). */
function nextcloud(rooms: Record<string, number> = {}) {
  const sent: { room: string; message: string }[] = []
  const auth = `Basic ${Buffer.from('alice:app-pass').toString('base64')}`
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/status.php') return Response.json({ installed: true, productname: 'Nextcloud' })
      if (path === '/ocs/v2.php/cloud/user')
        return req.headers.get('authorization') === auth
          ? Response.json({ ocs: { data: { id: 'alice' } } })
          : new Response('', { status: 401 })
      const room = /\/api\/v4\/room\/(.+)$/.exec(path)
      if (room) return Response.json({ ocs: { data: { type: rooms[room[1] ?? ''] ?? 2 } } })
      const bot = /\/api\/v1\/bot\/(.+)\/message$/.exec(path)
      if (bot && req.method === 'POST') {
        const body = (await req.json()) as { message: string }
        const random = req.headers.get('x-nextcloud-talk-bot-random') ?? ''
        if (req.headers.get('x-nextcloud-talk-bot-signature') !== hmac(random + body.message))
          return new Response('', { status: 401 })
        sent.push({ room: bot[1] ?? '', message: body.message })
        return Response.json({ ocs: { data: { id: 42 } } }, { status: 201 })
      }
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return { sent, url: `http://127.0.0.1:${server.port}`, host: `127.0.0.1:${server.port}` }
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

const event = (room: string, content: string, actor = { type: 'Person', id: 'users/bob', name: 'Bob' }) => ({
  type: 'Create',
  actor,
  object: {
    type: 'Note',
    id: String(Math.floor(Math.random() * 1e6)),
    name: 'message',
    content,
    mediaType: 'text/markdown',
  },
  target: { type: 'Collection', id: room, name: 'Ops' },
})

function signed(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body)
  const random = randomBytes(32).toString('hex')
  return new Request(PUBLIC, {
    method: 'POST',
    headers: {
      'x-nextcloud-talk-signature': hmac(random + raw, secret),
      'x-nextcloud-talk-random': random,
      'x-nextcloud-talk-backend': 'https://cloud.example.com',
    },
    body: raw,
  })
}

const rich = (message: string, parameters: Record<string, unknown> = {}) =>
  JSON.stringify({ message, parameters })

test('the check finds the server, and refuses a wrong user and app password', async () => {
  const { url, host } = nextcloud()
  expect(await new NextcloudTalkAdapter(url, SECRET).check()).toBe(host)
  expect(await new NextcloudTalkAdapter(url, SECRET, 'alice', 'app-pass').check()).toBe(host)
  await expect(new NextcloudTalkAdapter(url, SECRET, 'alice', 'wrong').check()).rejects.toThrow(
    'refused that user',
  )
  await expect(new NextcloudTalkAdapter('http://127.0.0.1:1', SECRET).check()).rejects.toThrow('cannot reach')
})

test('signed webhooks become messages: mentions decoded, bots ignored; unsigned ones are refused', async () => {
  const { url } = nextcloud()
  const adapter = new NextcloudTalkAdapter(url, SECRET)
  adapters.push(adapter)
  const { handle, received, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.at(-1)?.state === 'on')
  const mention = rich('hi {mention-bot1} what is up', {
    'mention-bot1': { type: 'user', id: 'x', name: 'Myrmidon' },
  })
  const unsigned = new Request(PUBLIC, { method: 'POST', body: JSON.stringify(event('room1', mention)) })
  expect((await adapter.webhook(unsigned)).status).toBe(401)
  expect((await adapter.webhook(signed(event('room1', mention), 'some-other-secret'))).status).toBe(401)
  expect((await adapter.webhook(signed(event('room1', mention)))).status).toBe(200)
  expect((await adapter.webhook(signed(event('room1', rich('just chatting'))))).status).toBe(200)
  const fromBot = event('room1', rich('echo'), { type: 'Application', id: 'bots/abc', name: 'Myrmidon' })
  expect((await adapter.webhook(signed(fromBot))).status).toBe(200)
  expect(received.map((m) => [m.text, m.mentioned])).toEqual([
    ['hi what is up', true],
    ['just chatting', false],
  ])
  // Without credentials to look the room up, every conversation is a group (as OpenClaw has it).
  expect(received[0]?.chat).toEqual({ id: 'room1', kind: 'group', title: 'Ops' })
  expect(received[0]?.sender).toEqual({ id: 'users/bob', name: 'Bob' })
})

test('with a user and app password, one-to-one rooms are direct chats', async () => {
  const { url } = nextcloud({ dmroom: 1 })
  const adapter = new NextcloudTalkAdapter(url, SECRET, 'alice', 'app-pass')
  adapters.push(adapter)
  const { handle, received } = io()
  await adapter.start(handle)
  await adapter.webhook(signed(event('dmroom', rich('hello'))))
  await adapter.webhook(signed(event('room2', rich('hello all'))))
  expect(received.map((m) => [m.chat.kind, m.mentioned])).toEqual([
    ['dm', true],
    ['group', false],
  ])
})

test('replies go to the bot API signed over the message; a refused secret fails the send', async () => {
  const { url, sent } = nextcloud()
  const ref = await new NextcloudTalkAdapter(url, SECRET).send(
    { id: 'room1', kind: 'group' },
    { text: '**done**' },
  )
  expect(ref).toEqual({ chat: 'room1', id: '42' })
  expect(sent).toEqual([{ room: 'room1', message: '**done**' }])
  await expect(new NextcloudTalkAdapter(url, 'wrong-secret').send('room1', { text: 'x' })).rejects.toThrow(
    'refused the bot secret',
  )
})

test('without a public address it cannot receive, and says so', async () => {
  const { url } = nextcloud()
  const adapter = new NextcloudTalkAdapter(url, SECRET)
  const { handle, statuses } = io(null)
  await adapter.start(handle)
  expect(statuses.at(-1)?.state).toBe('error')
  expect(JSON.stringify(statuses.at(-1))).toContain('public HTTPS address')
})

test('an unreachable server is retried; a wrong app password is an error until changed', async () => {
  const away = new NextcloudTalkAdapter('http://127.0.0.1:1', SECRET)
  adapters.push(away)
  const a = io()
  await away.start(a.handle)
  await until(() => a.statuses.some((s) => s.state === 'retrying'))
  const { url } = nextcloud()
  const wrong = new NextcloudTalkAdapter(url, SECRET, 'alice', 'wrong')
  adapters.push(wrong)
  const b = io()
  await wrong.start(b.handle)
  await until(() => b.statuses.at(-1)?.state === 'error')
  expect(JSON.stringify(b.statuses.at(-1))).toContain('refused that user')
})
