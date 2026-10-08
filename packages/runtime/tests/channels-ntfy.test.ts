import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { channelCopy } from '../src/channels/copy.ts'
import { type AdapterIO, type AdapterStatus, type Inbound, NtfyAdapter } from '../src/channels/index.ts'

const TOPIC = 'myr-7f3k9q2x8w1z'

type Call = { method: string; path: string; headers: Headers; body: Uint8Array }

/** A stand-in for an ntfy server: a JSON stream per subscriber, publishing by POST and PUT, one stored file. */
function ntfy(options: { token?: string } = {}) {
  const calls: Call[] = []
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  const subscriptions: URL[] = []
  const encoder = new TextEncoder()
  const push = (event: Record<string, unknown>) => {
    for (const c of streams) c.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
  }
  // Bound to the address the adapter is given, so no other test's server on the same port can answer instead.
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = new Uint8Array(await req.arrayBuffer())
      calls.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body })
      if (options.token && req.headers.get('authorization') !== `Bearer ${options.token}`)
        return Response.json({ code: 40301, error: 'forbidden' }, { status: 403 })
      if (url.pathname === `/${TOPIC}/json` && url.searchParams.get('poll') === '1') return new Response('')
      if (url.pathname === `/${TOPIC}/json`) {
        subscriptions.push(url)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push(controller)
              controller.enqueue(
                encoder.encode(`${JSON.stringify({ id: 'o1', event: 'open', topic: TOPIC })}\n`),
              )
            },
          }),
          { headers: { 'content-type': 'application/x-ndjson' } },
        )
      }
      if (url.pathname === `/${TOPIC}` && (req.method === 'POST' || req.method === 'PUT')) {
        const id = `pub${calls.length}`
        // Whatever is published comes back to every subscriber, tags and all.
        const tags = (req.headers.get('tags') ?? url.searchParams.get('tags') ?? '')
          .split(',')
          .filter(Boolean)
        push({ id, event: 'message', topic: TOPIC, time: 1, message: new TextDecoder().decode(body), tags })
        return Response.json({ id, event: 'message', topic: TOPIC })
      }
      if (url.pathname === '/file/abc.png') return new Response(new Uint8Array([9, 8, 7]))
      return new Response('not found', { status: 404 })
    },
  })
  return { server, calls, push, subscriptions, url: `http://127.0.0.1:${server.port}` }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: NtfyAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function io(kv = new Map<string, string>()) {
  const received: Inbound[] = []
  const statuses: AdapterStatus[] = []
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

test('check() names the server; bad topics, guessable ones and a refused token are errors', async () => {
  const open = ntfy()
  const locked = ntfy({ token: 'tk_right' })
  servers.push(open.server, locked.server)
  expect(await new NtfyAdapter(open.url, TOPIC).check()).toBe(new URL(open.url).host)
  await expect(new NtfyAdapter(open.url, 'has spaces').check()).rejects.toThrow(channelCopy.errors.ntfyTopic)
  await expect(new NtfyAdapter(open.url, 'alerts').check()).rejects.toThrow(channelCopy.errors.ntfyGuessable)
  expect(await new NtfyAdapter(locked.url, TOPIC, 'tk_right').check()).toBe(new URL(locked.url).host)
  await expect(new NtfyAdapter(locked.url, TOPIC, 'tk_wrong').check()).rejects.toThrow(
    channelCopy.errors.ntfyRefused,
  )

  const a = new NtfyAdapter(locked.url, TOPIC, 'tk_wrong')
  adapters.push(a)
  const { handle, statuses } = io()
  await a.start(handle)
  await until(() => statuses.some((s) => s.state === 'error'))
  expect(statuses.at(-1)).toEqual({ state: 'error', error: channelCopy.errors.ntfyRefused })
})

test('messages on the topic come in as one conversation; our own are skipped; `since` is kept', async () => {
  const fake = ntfy()
  servers.push(fake.server)
  const adapter = new NtfyAdapter(fake.url, TOPIC)
  adapters.push(adapter)
  const { handle, received, statuses, kv } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(fake.subscriptions[0]?.searchParams.has('since')).toBe(false)

  fake.push({
    id: 'm1',
    event: 'message',
    topic: TOPIC,
    time: 1700000000,
    message: 'deploy the site',
    title: 'Boss',
  })
  fake.push({ id: 'k1', event: 'keepalive', topic: TOPIC })
  fake.push({
    id: 'm2',
    event: 'message',
    topic: TOPIC,
    time: 1700000001,
    message: 'shot.png',
    attachment: { name: 'shot.png', type: 'image/png', size: 3, url: `${fake.url}/file/abc.png` },
  })
  fake.push({
    id: 'm3',
    event: 'message',
    topic: TOPIC,
    time: 1700000002,
    message: 'look',
    attachment: { name: 'x', type: 'image/png', url: 'http://169.254.169.254/x' },
  })
  await until(() => received.length === 3)
  expect(received[0]).toMatchObject({
    messageId: 'm1',
    chat: { id: 'topic', kind: 'dm' },
    sender: { id: 'topic', name: channelCopy.ntfySender },
    text: 'deploy the site',
    mentioned: true,
    time: new Date(1700000000 * 1000).toISOString(),
  })
  // An attachment's default message (its name) is not text; files elsewhere are not fetched.
  expect(received[1]?.text).toBe('')
  expect(received[1]?.files?.[0]).toMatchObject({
    kind: 'image',
    name: 'shot.png',
    mimeType: 'image/png',
    size: 3,
  })
  expect([...((await received[1]?.files?.[0]?.read()) ?? [])]).toEqual([9, 8, 7])
  expect(received[2]).toMatchObject({ text: 'look' })
  expect(received[2]?.files).toBeUndefined()
  expect(kv.get('since')).toBe('m3')

  // What we publish comes back on the stream, tagged, and is not read as a message.
  const ref = await adapter.send({ id: 'topic', kind: 'dm' }, { text: '**Done**' })
  expect(ref.chat).toBe('topic')
  const published = fake.calls.find((c) => c.method === 'POST')
  expect(new TextDecoder().decode(published?.body)).toBe('**Done**')
  expect(published?.headers.get('markdown')).toBe('yes')
  expect(published?.headers.get('tags')).toBe('myrmidon')
  await until(() => kv.get('since') === ref.id)
  expect(received).toHaveLength(3)

  // After a restart it resumes after the last message it recorded.
  await adapter.stop()
  const again = new NtfyAdapter(fake.url, TOPIC)
  adapters.push(again)
  const second = io(kv)
  await again.start(second.handle)
  await until(() => fake.subscriptions.length === 2)
  expect(fake.subscriptions[1]?.searchParams.get('since')).toBe(ref.id)
})

test('files go out as attachments with name and caption; edits send nothing; tokens are Bearer or Basic', async () => {
  const fake = ntfy()
  servers.push(fake.server)
  const adapter = new NtfyAdapter(fake.url, TOPIC, 'alice:secret')
  await adapter.sendFile('topic', {
    name: 'report.pdf',
    mimeType: 'application/pdf',
    data: new Uint8Array([1, 2]),
    caption: 'the report',
  })
  const put = fake.calls.at(-1)
  expect(put?.method).toBe('PUT')
  const query = new URL(`http://x${put?.path}`).searchParams
  expect(query.get('filename')).toBe('report.pdf')
  expect(query.get('message')).toBe('the report')
  expect(query.get('tags')).toBe('myrmidon')
  expect([...(put?.body ?? [])]).toEqual([1, 2])
  expect(put?.headers.get('authorization')).toBe(`Basic ${Buffer.from('alice:secret').toString('base64')}`)

  const before = fake.calls.length
  await adapter.edit({ chat: 'topic', id: 'x' }, { text: 'changed' })
  expect(fake.calls.length).toBe(before)
  expect(adapter.can).toEqual({ buttons: false, files: true, edit: false })
})
