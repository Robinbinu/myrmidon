import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { type AdapterIO, type AdapterStatus, type Inbound, TlonAdapter } from '../src/channels/index.ts'

const CODE = 'lidlut-tabwed-pillex-ridrup'

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: TlonAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

type Action = {
  id: number
  action: string
  app?: string
  path?: string
  mark?: string
  json?: unknown
  'event-id'?: number
}

/** A stand-in for a ship's Eyre: login, /~/name, a channel taking PUTs and streaming the events a test pushes. */
function ship() {
  const actions: Action[] = []
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  let eventId = 0
  const cookie = 'urbauth-~zod=0v1.abc'
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname === '/~/login') {
        const form = new URLSearchParams(await req.text())
        return form.get('password') === CODE
          ? new Response(null, {
              status: 204,
              headers: { 'set-cookie': `${cookie}; Path=/; Max-Age=604800` },
            })
          : new Response('bad code', { status: 400 })
      }
      if (req.headers.get('cookie') !== cookie) return new Response('', { status: 403 })
      if (pathname === '/~/name') return new Response('~zod')
      if (pathname.startsWith('/~/channel/')) {
        if (req.method === 'PUT') {
          actions.push(...((await req.json()) as Action[]))
          return new Response(null, { status: 204 })
        }
        if (req.method === 'DELETE') return new Response(null, { status: 204 })
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (c) => {
              streams.push(c)
              // Bun sends a streamed response's headers with its first bytes; an SSE comment is ignored.
              c.enqueue(new TextEncoder().encode(': open\n\n'))
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  const push = (sub: number, json: unknown) => {
    const frame = `id: ${++eventId}\ndata: ${JSON.stringify({ id: sub, response: 'diff', json })}\n\n`
    for (const c of streams) c.enqueue(new TextEncoder().encode(frame))
  }
  return { actions, push, streams, url: `http://127.0.0.1:${server.port}` }
}

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

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

async function running() {
  const s = ship()
  const adapter = new TlonAdapter(s.url, CODE)
  adapters.push(adapter)
  const { handle, received, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.some((st) => st.state === 'on') && s.streams.length > 0)
  const sub = (path: string) => s.actions.find((a) => a.action === 'subscribe' && a.path === path)?.id ?? 0
  return { ...s, adapter, received, statuses, channels: sub('/v2'), chat: sub('/v3') }
}

const essay = (author: string, text: string, extra: unknown[] = []) => ({
  author,
  sent: 1_700_000_000_000,
  content: [{ inline: [text] }, ...extra],
})

test('the check logs in with the access code; a wrong code is an error, also when running', async () => {
  const s = ship()
  expect(await new TlonAdapter(s.url, CODE).check()).toBe('~zod')
  await expect(new TlonAdapter(s.url, 'wrong-code').check()).rejects.toThrow('refused this access code')
  const adapter = new TlonAdapter(s.url, 'wrong-code')
  adapters.push(adapter)
  const { handle, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.some((st) => st.state === 'error'))
})

test('it subscribes to the chat and channels firehoses and wakes the channel', async () => {
  const { actions, statuses } = await running()
  expect(statuses.find((st) => st.state === 'on')).toEqual({ state: 'on', account: '~zod' })
  expect(actions.filter((a) => a.action === 'subscribe').map((a) => [a.app, a.path])).toEqual([
    ['channels', '/v2'],
    ['chat', '/v3'],
  ])
  expect(actions.find((a) => a.action === 'poke')).toMatchObject({ app: 'hood', mark: 'helm-hi' })
})

test('DMs and group posts become messages: mentions, threads, our own ignored, images as files', async () => {
  const { push, received, chat, channels } = await running()
  push(chat, { whom: '~bus', id: '~bus/170.1', response: { add: { essay: essay('~bus', 'hello there') } } })
  const post = (id: string, author: string, text: string) => ({
    nest: 'chat/~host/general',
    response: { post: { id, 'r-post': { set: { essay: essay(author, text) } } } },
  })
  push(channels, post('170.2', '~bus', 'hey ~zod, summarise this'))
  push(channels, post('170.3', '~bus', 'just talking'))
  push(channels, post('170.4', '~zod', 'my own post'))
  push(channels, {
    nest: 'chat/~host/general',
    response: {
      post: {
        id: '170.2',
        'r-post': {
          reply: {
            id: '170.5',
            'r-reply': { set: { memo: essay('~bus', '~zod and this'), seal: { 'parent-id': '170.2' } } },
          },
        },
      },
    },
  })
  push(chat, {
    whom: '~bus',
    id: '~bus/170.6',
    response: {
      add: {
        essay: essay('~bus', 'a picture', [{ block: { image: { src: 'https://x.test/cat.png', alt: '' } } }]),
      },
    },
  })
  await until(() => received.length === 5)
  expect(received[0]).toMatchObject({
    messageId: '~bus/170.1',
    chat: { id: '~bus', kind: 'dm' },
    sender: { id: '~bus', name: '~bus', handle: '~bus' },
    text: 'hello there',
    mentioned: true,
  })
  expect(received[1]).toMatchObject({
    chat: { id: 'chat/~host/general', kind: 'group' },
    text: 'hey , summarise this',
    mentioned: true,
  })
  expect(received[2]).toMatchObject({ text: 'just talking', mentioned: false })
  expect(received[3]).toMatchObject({ messageId: '170.5', chat: { thread: '170.2' }, mentioned: true })
  expect(received[4]?.files?.[0]).toMatchObject({ kind: 'image', name: 'cat.png', mimeType: 'image/png' })
})

test('DM invitations are accepted once', async () => {
  const { push, actions, chat } = await running()
  push(chat, [{ ship: '~bus' }])
  push(chat, [{ ship: '~bus' }])
  await until(() => actions.some((a) => a.mark === 'chat-dm-rsvp'))
  await Bun.sleep(50)
  expect(actions.filter((a) => a.mark === 'chat-dm-rsvp').map((a) => a.json)).toEqual([
    { ship: '~bus', ok: true },
  ])
})

test('sending pokes a DM or a group post (a thread is answered in the thread), as a story', async () => {
  const { adapter, actions } = await running()
  const ref = await adapter.send({ id: '~bus', kind: 'dm' }, { text: '**Done** in 2m' })
  const dm = actions.find((a) => a.mark === 'chat-dm-action')?.json as {
    ship: string
    diff: { id: string; delta: { add: { memo: { content: unknown; author: string } } } }
  }
  expect(dm.ship).toBe('~bus')
  expect(dm.diff.id).toBe(ref.id)
  // An @da: 170.141.184.5… (2^127 and up, in dotted groups).
  expect(dm.diff.id).toMatch(/^~zod\/170\.141\.18\d(\.\d{3})+$/)
  expect(dm.diff.delta.add.memo).toMatchObject({
    author: '~zod',
    content: [{ inline: [{ bold: ['Done'] }, ' in 2m'] }],
  })
  await adapter.send({ id: 'chat/~host/general', kind: 'group', thread: '170.2' }, { text: 'see above' })
  await adapter.send('chat/~host/general', { text: '```\ncode\n```' })
  const posts = actions.filter((a) => a.mark === 'channel-action-1').map((a) => a.json) as {
    channel: { nest: string; action: { post: Record<string, unknown> } }
  }[]
  expect(posts[0]?.channel.nest).toBe('chat/~host/general')
  expect(posts[0]?.channel.action.post.reply).toMatchObject({
    id: '170.2',
    action: { add: { author: '~zod' } },
  })
  expect(posts[1]?.channel.action.post.add).toMatchObject({
    kind: '/chat',
    content: [{ block: { code: { code: 'code', lang: 'plaintext' } } }],
  })
})

test('events are acknowledged in batches, so the ship can drop them', async () => {
  const { push, actions, chat, received } = await running()
  for (let i = 0; i < 25; i++)
    push(chat, { whom: '~bus', id: `~bus/1.${i}`, response: { add: { essay: essay('~bus', `m${i}`) } } })
  await until(() => received.length === 25)
  await until(() => actions.some((a) => a.action === 'ack'))
  expect(actions.find((a) => a.action === 'ack')?.['event-id']).toBe(20)
})
