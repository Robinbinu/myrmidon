import { afterEach, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { decrypt, encrypt } from 'nostr-tools/nip04'
import { npubEncode, nsecEncode } from 'nostr-tools/nip19'
import { type Event, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { NostrAdapter } from '../src/channels/nostr.ts'
import { fakeIO, until } from './fixtures/channel-io.ts'

type Filter = { kinds?: number[]; '#p'?: string[]; since?: number }

/** A stand-in relay: stores events, answers OK (or refuses), and sends subscribers what matches their filter. */
function relay(options: { refuse?: boolean } = {}) {
  const events: Event[] = []
  const subs = new Map<ServerWebSocket<unknown>, { id: string; filter: Filter }>()
  const filters: Filter[] = []
  const matches = (f: Filter, e: Event) =>
    (!f.kinds || f.kinds.includes(e.kind)) &&
    (!f['#p'] || e.tags.some((t) => t[0] === 'p' && f['#p']?.includes(t[1] ?? ''))) &&
    (f.since === undefined || e.created_at >= f.since)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('relay', { status: 400 })),
    websocket: {
      message(ws, data) {
        const msg = JSON.parse(String(data)) as [string, ...unknown[]]
        if (msg[0] === 'REQ') {
          const sub = { id: String(msg[1]), filter: msg[2] as Filter }
          filters.push(sub.filter)
          subs.set(ws, sub)
          for (const e of events) if (matches(sub.filter, e)) ws.send(JSON.stringify(['EVENT', sub.id, e]))
          ws.send(JSON.stringify(['EOSE', sub.id]))
        } else if (msg[0] === 'EVENT') {
          const e = msg[1] as Event
          ws.send(JSON.stringify(['OK', e.id, !options.refuse, options.refuse ? 'blocked: no' : '']))
          if (options.refuse) return
          events.push(e)
          for (const [other, sub] of subs)
            if (matches(sub.filter, e)) other.send(JSON.stringify(['EVENT', sub.id, e]))
        }
      },
      close(ws) {
        subs.delete(ws)
      },
    },
  })
  servers.push(server)
  /** Delivers an event to subscribers as if someone published it. */
  const inject = (e: unknown) => {
    for (const [ws, sub] of subs) ws.send(JSON.stringify(['EVENT', sub.id, e]))
  }
  return { url: `ws://127.0.0.1:${server.port}`, events, filters, subs, inject }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: NostrAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

const bot = generateSecretKey()
const botPk = getPublicKey(bot)
const alice = generateSecretKey()
const alicePk = getPublicKey(alice)

const dm = (from: Uint8Array, to: string, text: string, extra: Partial<Event> = {}) =>
  finalizeEvent(
    {
      kind: 4,
      created_at: extra.created_at ?? Math.floor(Date.now() / 1000),
      tags: [['p', to]],
      content: encrypt(from, to, text),
    },
    from,
  )

test('check derives the npub from an nsec or hex key; bad keys and relays are refused', async () => {
  const npub = npubEncode(botPk)
  expect(await new NostrAdapter({ privateKey: nsecEncode(bot) }).check()).toBe(npub)
  expect(await new NostrAdapter({ privateKey: Buffer.from(bot).toString('hex') }).check()).toBe(npub)
  await expect(new NostrAdapter({ privateKey: 'nsec1nonsense' }).check()).rejects.toThrow(
    'nsec key is not valid',
  )
  await expect(new NostrAdapter({ privateKey: 'f'.repeat(64) }).check()).rejects.toThrow('not valid')
  await expect(new NostrAdapter({ privateKey: npub }).check()).rejects.toThrow('64 hex')
  await expect(
    new NostrAdapter({ privateKey: nsecEncode(bot), relays: 'https://relay.example' }).check(),
  ).rejects.toThrow('wss://')
})

test('a DM through two relays arrives once, decrypted; the answer is encrypted to the sender on every relay', async () => {
  const one = relay()
  const two = relay()
  const adapter = new NostrAdapter({ privateKey: nsecEncode(bot), relays: `${one.url}, ${two.url}` })
  adapters.push(adapter)
  const { handle, received, statuses, kv } = fakeIO()
  await adapter.start(handle)
  await until(() => one.subs.size === 1 && two.subs.size === 1)
  expect(statuses).toContainEqual({ state: 'on', account: npubEncode(botPk) })
  expect(one.filters[0]).toMatchObject({ kinds: [4], '#p': [botPk] })

  const hello = dm(alice, botPk, 'hello from alice')
  one.inject(hello)
  two.inject(hello)
  await until(() => received.length === 1)
  await Bun.sleep(50)
  expect(received.length).toBe(1)
  expect(received[0]).toMatchObject({
    messageId: hello.id,
    chat: { id: alicePk, kind: 'dm' },
    sender: { id: alicePk, handle: npubEncode(alicePk) },
    text: 'hello from alice',
    mentioned: true,
  })
  expect(kv.get('since')).toBe(String(hello.created_at))

  const ref = await adapter.send(alicePk, { text: '**Done**: all good' })
  await until(() => one.events.length === 1 && two.events.length === 1)
  const answer = one.events[0] as Event
  expect(ref).toEqual({ chat: alicePk, id: answer.id })
  expect(answer.kind).toBe(4)
  expect(answer.pubkey).toBe(botPk)
  expect(answer.tags).toContainEqual(['p', alicePk])
  expect(answer.tags).toContainEqual(['e', hello.id])
  expect(decrypt(alice, botPk, answer.content)).toBe('Done: all good')
})

test('forged, misaddressed, own, oversized and future events are dropped before anything is decrypted', async () => {
  const r = relay()
  const adapter = new NostrAdapter({ privateKey: nsecEncode(bot), relays: r.url })
  adapters.push(adapter)
  const { handle, received } = fakeIO()
  await adapter.start(handle)
  await until(() => r.subs.size === 1)

  const real = dm(alice, botPk, 'the real one')
  r.inject({ ...real, content: encrypt(alice, botPk, 'forged') })
  r.inject(dm(alice, getPublicKey(generateSecretKey()), 'not for the bot'))
  r.inject(dm(bot, botPk, 'my own'))
  r.inject(dm(alice, botPk, 'x'.repeat(70_000)))
  r.inject(dm(alice, botPk, 'from the future', { created_at: Math.floor(Date.now() / 1000) + 3600 }))
  r.inject(real)
  await until(() => received.length === 1)
  await Bun.sleep(50)
  expect(received.map((m) => m.text)).toEqual(['the real one'])
})

test('it resumes from the last message handled, and says so when no relay takes an answer', async () => {
  const refusing = relay({ refuse: true })
  const adapter = new NostrAdapter({ privateKey: nsecEncode(bot), relays: refusing.url })
  adapters.push(adapter)
  const { handle } = fakeIO()
  handle.set('since', '1700000000')
  await adapter.start(handle)
  await until(() => refusing.subs.size === 1)
  expect(refusing.filters[0]?.since).toBe(1700000000 - 120)
  await expect(adapter.send(alicePk, { text: 'hi' })).rejects.toThrow(
    'no relay took the message: blocked: no',
  )
  await expect(adapter.send('npub-not-hex', { text: 'hi' })).rejects.toThrow('not a Nostr public key')
})

test('a bad key is an error; relays that cannot be reached are retried', async () => {
  const a = new NostrAdapter({ privateKey: 'nope' })
  adapters.push(a)
  const first = fakeIO()
  await a.start(first.handle)
  expect(first.statuses.at(-1)).toMatchObject({ state: 'error' })

  const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const url = `ws://127.0.0.1:${dead.port}`
  dead.stop(true)
  const b = new NostrAdapter({ privateKey: nsecEncode(bot), relays: url })
  adapters.push(b)
  const second = fakeIO()
  await b.start(second.handle)
  await until(() => second.statuses.some((s) => s.state === 'retrying'))
})
