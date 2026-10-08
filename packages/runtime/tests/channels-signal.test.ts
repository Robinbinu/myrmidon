import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { type AdapterIO, type AdapterStatus, type Inbound, SignalAdapter } from '../src/channels/index.ts'

const BOT = '+15550000001'
const BOT_UUID = 'b0b0b0b0-0000-4000-8000-000000000001'
const ALICE = '+15550000002'
const ALICE_UUID = 'a11ce000-0000-4000-8000-000000000002'

type Rpc = { method: string; params: Record<string, unknown> }
type Handler = (params: Record<string, unknown>, n: number) => unknown

/**
 * A stand-in for signal-cli's HTTP daemon: `/api/v1/check`, JSON-RPC on `/api/v1/rpc` (each method answering from a
 * handler, every call recorded), and an event stream the test writes to.
 */
function daemon(handlers: Record<string, Handler> = {}, options: { up?: boolean } = {}) {
  const calls: Rpc[] = []
  const counts = new Map<string, number>()
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/api/v1/check') return new Response(null, { status: options.up === false ? 503 : 200 })
      if (path === '/api/v1/events')
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              streams.push(controller)
              // A keepalive comment first, so the response (and its headers) goes out at once.
              controller.enqueue(new TextEncoder().encode(':\n\n'))
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      const body = (await req.json()) as { id: string; method: string; params: Record<string, unknown> }
      calls.push({ method: body.method, params: body.params })
      const n = (counts.get(body.method) ?? 0) + 1
      counts.set(body.method, n)
      const handler = handlers[body.method]
      const answer = handler ? handler(body.params, n) : { result: {} }
      return Response.json({ jsonrpc: '2.0', id: body.id, ...(answer as object) })
    },
  })
  const push = (envelope: Record<string, unknown>, stream = streams.length - 1) =>
    streams[stream]?.enqueue(
      new TextEncoder().encode(`event:receive\ndata:${JSON.stringify({ envelope, account: BOT })}\n\n`),
    )
  return { server, calls, streams, push, url: `http://127.0.0.1:${server.port}` }
}

const STATUS: Handler = () => ({
  result: [{ recipient: BOT, number: BOT, uuid: BOT_UUID, isRegistered: true }],
})
const SENT: Handler = () => ({ result: { timestamp: 1700000000999, results: [{ type: 'SUCCESS' }] } })

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: SignalAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

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

const from = (extra: Record<string, unknown>) => ({
  sourceNumber: ALICE,
  sourceUuid: ALICE_UUID,
  sourceName: 'Alice',
  timestamp: 1700000000000,
  ...extra,
})

test('envelopes become messages: direct, a group mention stripped, quotes of the bot, attachments; the rest ignored', async () => {
  const d = daemon({
    getUserStatus: STATUS,
    getAttachment: () => ({ result: { data: Buffer.from([1, 2, 3]).toString('base64') } }),
  })
  servers.push(d.server)
  const adapter = new SignalAdapter(d.url, BOT)
  adapters.push(adapter)
  expect(await adapter.check()).toBe(BOT)
  const { handle, received, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(statuses).toContainEqual({ state: 'on', account: BOT })

  d.push(from({ dataMessage: { timestamp: 1, message: 'hello there' } }))
  // The bot mentioned by its account UUID (Signal writes U+FFFC where the mention sits).
  d.push(
    from({
      timestamp: 1700000000001,
      dataMessage: {
        message: '￼ please look',
        groupInfo: { groupId: 'R1JPVVA=', groupName: 'Crew' },
        mentions: [{ start: 0, length: 1, uuid: BOT_UUID }],
      },
    }),
  )
  d.push(
    from({
      timestamp: 1700000000002,
      dataMessage: { message: 'chatting among ourselves', groupInfo: { groupId: 'R1JPVVA=' } },
    }),
  )
  d.push(
    from({
      timestamp: 1700000000003,
      dataMessage: {
        message: 'about that',
        groupInfo: { groupId: 'R1JPVVA=' },
        quote: { id: 5, authorNumber: BOT, authorUuid: BOT_UUID },
      },
    }),
  )
  d.push(
    from({
      timestamp: 1700000000004,
      dataMessage: {
        message: '',
        attachments: [{ id: 'att1', contentType: 'image/png', filename: 'shot.png', size: 3 }],
      },
    }),
  )
  // Ignored: the bot's own sends from a linked device, its own number, a reaction, a receipt-only envelope.
  d.push(from({ syncMessage: { sentMessage: { message: 'mine' } } }))
  d.push({ sourceNumber: BOT, timestamp: 9, dataMessage: { message: 'echo' } })
  d.push(from({ timestamp: 10, dataMessage: { reaction: { emoji: '👍' } } }))
  d.push(from({ timestamp: 11, receiptMessage: { isRead: true } }))
  await until(() => received.length === 5)
  await Bun.sleep(30)
  expect(received).toHaveLength(5)

  expect(received[0]).toMatchObject({
    messageId: `${ALICE}:1700000000000`,
    chat: { id: ALICE, kind: 'dm' },
    sender: { id: ALICE_UUID, name: 'Alice', handle: ALICE },
    text: 'hello there',
    mentioned: true,
  })
  expect(received[1]).toMatchObject({
    chat: { id: 'group:R1JPVVA=', kind: 'group', title: 'Crew' },
    text: 'please look',
    mentioned: true,
  })
  expect(received[2]).toMatchObject({ text: 'chatting among ourselves', mentioned: false })
  expect(received[3]).toMatchObject({ text: 'about that', mentioned: true })
  const file = received[4]?.files?.[0]
  expect(file).toMatchObject({ kind: 'image', name: 'shot.png', mimeType: 'image/png', size: 3 })
  expect(await file?.read()).toEqual(new Uint8Array([1, 2, 3]))
  expect(d.calls.find((c) => c.method === 'getAttachment')?.params).toMatchObject({
    account: BOT,
    id: 'att1',
    recipient: ALICE,
  })
})

test('sending: Markdown as text styles, groups by id, files as data URIs, typing, and a rate limit waited out', async () => {
  const d = daemon({
    getUserStatus: STATUS,
    send: (params, n) =>
      // The first text send is rate-limited (signal-cli 0.14.3's typed error), then goes through.
      n === 1 && !params.attachments
        ? {
            error: {
              code: -5,
              message: 'Rate limit exceeded',
              data: { response: { results: [{ retryAfterSeconds: 0.05 }] } },
            },
          }
        : SENT(params, n),
  })
  servers.push(d.server)
  const adapter = new SignalAdapter(d.url, BOT)

  const ref = await adapter.send(ALICE, { text: '**Done** in `2m`' })
  expect(ref).toEqual({ chat: ALICE, id: '1700000000999' })
  const sends = d.calls.filter((c) => c.method === 'send')
  expect(sends).toHaveLength(2)
  expect(sends[1]?.params).toMatchObject({
    account: BOT,
    recipient: [ALICE],
    message: 'Done in 2m',
    textStyle: ['0:4:BOLD', '8:2:MONOSPACE'],
  })

  await adapter.send({ id: 'group:R1JPVVA=', kind: 'group' }, { text: 'hi all' })
  expect(d.calls.at(-1)?.params).toMatchObject({ groupId: 'R1JPVVA=', message: 'hi all' })
  expect(d.calls.at(-1)?.params.recipient).toBeUndefined()

  await adapter.sendFile(ALICE, {
    name: 'report.pdf',
    mimeType: 'application/pdf',
    data: new Uint8Array([1, 2]),
    caption: 'the report',
  })
  expect(d.calls.at(-1)?.params).toMatchObject({
    recipient: [ALICE],
    message: 'the report',
    attachments: [
      `data:application/pdf;filename=report.pdf;base64,${Buffer.from([1, 2]).toString('base64')}`,
    ],
  })

  await adapter.typing(ALICE)
  expect(d.calls.at(-1)).toEqual({ method: 'sendTyping', params: { account: BOT, recipient: [ALICE] } })
  // Signal is not edited: the hub is told so and edits do nothing.
  expect(adapter.can).toEqual({ buttons: false, files: true, edit: false })
  await adapter.edit(ref, { text: 'changed' })
  expect(d.calls.at(-1)?.method).toBe('sendTyping')
})

test('a send no one received fails; a long rate limit is not waited out', async () => {
  const d = daemon({
    send: (_p, n) =>
      n === 1
        ? { result: { timestamp: 1, results: [{ type: 'UNREGISTERED_FAILURE' }] } }
        : { error: { code: -5, message: '[429] Rate limit exceeded: Retry after 600 seconds' } },
  })
  servers.push(d.server)
  const adapter = new SignalAdapter(d.url, BOT)
  await expect(adapter.send(ALICE, { text: 'hi' })).rejects.toThrow('UNREGISTERED_FAILURE')
  await expect(adapter.send(ALICE, { text: 'hi' })).rejects.toThrow('Rate limit')
  expect(d.calls.filter((c) => c.method === 'send')).toHaveLength(2)
})

test('an account the daemon does not have stops it with the reason; an unreachable daemon is retried', async () => {
  const d = daemon({
    getUserStatus: () => ({ error: { code: -32602, message: 'Specified account does not exist' } }),
  })
  servers.push(d.server)
  await expect(new SignalAdapter(d.url, BOT).check()).rejects.toThrow('has no account')
  const refused = new SignalAdapter(d.url, BOT)
  adapters.push(refused)
  const first = io()
  await refused.start(first.handle)
  await until(() => first.statuses.some((s) => s.state === 'error'))
  expect(first.statuses.at(-1)).toMatchObject({ state: 'error', error: expect.stringContaining(BOT) })

  const down = daemon({}, { up: false })
  servers.push(down.server)
  const gone = new SignalAdapter(down.url, BOT)
  adapters.push(gone)
  const second = io()
  await gone.start(second.handle)
  await until(() => second.statuses.some((s) => s.state === 'retrying'))
  expect(second.statuses.at(-1)).toMatchObject({
    state: 'retrying',
    error: expect.stringContaining('signal-cli'),
  })
})

test('the event stream reconnects after the daemon closes it', async () => {
  const d = daemon({ getUserStatus: STATUS })
  servers.push(d.server)
  const adapter = new SignalAdapter(d.url, BOT)
  adapters.push(adapter)
  const { handle, received, statuses } = io()
  await adapter.start(handle)
  await until(() => d.streams.length === 1)
  d.push(from({ dataMessage: { message: 'first' } }))
  await until(() => received.length === 1)
  d.streams[0]?.close()
  await until(() => statuses.some((s) => s.state === 'retrying'))
  // Reconnected after the backoff (2 s, with jitter).
  await until(() => d.streams.length === 2, 6000)
  await until(() => statuses.at(-1)?.state === 'on')
  d.push(from({ timestamp: 1700000000005, dataMessage: { message: 'second' } }))
  await until(() => received.length === 2)
  expect(received.map((m) => m.text)).toEqual(['first', 'second'])
})
