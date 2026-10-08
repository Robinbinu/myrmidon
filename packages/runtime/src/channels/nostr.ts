import { randomBytes } from 'node:crypto'
import { decrypt, encrypt } from 'nostr-tools/nip04'
import { decode, npubEncode } from 'nostr-tools/nip19'
import { type Event, finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { plainText } from './format.ts'
import { Backoff, sleep } from './pace.ts'
import {
  type AdapterIO,
  type ChannelAdapter,
  type ChannelChat,
  type ChannelValues,
  chatIdOf,
  type OutMessage,
  type SentRef,
} from './types.ts'

/**
 * Nostr encrypted direct messages (NIP-04, kind 4), ported from OpenClaw's Nostr plugin with nostr-tools for the
 * cryptography and Bun's WebSocket for the relays: the bot's key subscribes on every relay to kind-4 events tagged
 * with its public key, checks each one (signature, size, clock, a per-sender rate) before decrypting it, drops the
 * same event arriving from several relays, and answers with a kind-4 event signed by the bot and published to every
 * relay. Gift-wrapped DMs (NIP-17) are not read: OpenClaw lists them as planned, not supported.
 */

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol']
const DM_KIND = 4
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 60_000
/** On (re)subscribing, look this far behind the last message handled, for relays that lag or clocks that drift. */
const LOOKBACK_S = 120
/** Events dated further ahead than this are refused (a wrong clock, or someone gaming `since`). */
const FUTURE_SKEW_S = 300
/** Ciphertext larger than this is dropped before decrypting. */
const MAX_CIPHERTEXT = 64 * 1024
/** Events from one sender in a minute beyond this are dropped before decrypting. */
const PER_SENDER_PER_MINUTE = 30
/** Event ids remembered to drop the copies other relays deliver. */
const SEEN_MAX = 5000
/** How long a relay has to accept a published event. */
const PUBLISH_MS = 10_000
const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')

/** The private key, from `nsec1…` or 64 hex characters, checked to be a valid secp256k1 scalar (as OpenClaw does). */
export function nostrSecretKey(raw: string): Uint8Array {
  const key = raw.trim()
  let bytes: Uint8Array
  if (/^nsec1/i.test(key)) {
    let decoded: ReturnType<typeof decode>
    try {
      decoded = decode(key.toLowerCase())
    } catch {
      throw new Error('that nsec key is not valid')
    }
    if (decoded.type !== 'nsec') throw new Error('that is not an nsec private key')
    bytes = decoded.data
  } else if (/^[0-9a-f]{64}$/i.test(key)) bytes = Uint8Array.from(Buffer.from(key, 'hex'))
  else throw new Error('the private key is an nsec1… key or 64 hex characters')
  const scalar = bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n)
  if (bytes.length !== 32 || scalar === 0n || scalar >= SECP256K1_ORDER)
    throw new Error('that private key is not valid')
  return bytes
}

export function nostrRelays(values: ChannelValues): string[] {
  const listed = (values.relays ?? '').split(/[\s,]+/).filter(Boolean)
  for (const url of listed)
    if (!/^wss?:\/\/[^\s/]+/i.test(url)) throw new Error(`a relay is a wss:// address, not ${url}`)
  return listed.length ? [...new Set(listed)] : DEFAULT_RELAYS
}

const short = (npub: string) => `${npub.slice(0, 12)}…${npub.slice(-4)}`

type RelayAnswer = { ok: boolean; message: string }

/** One relay: kept connected with backoff, re-subscribing each time, and publishing events with their OK. */
class Relay {
  up = false
  lastError?: string
  private _ws?: WebSocket
  private readonly _waiting = new Map<string, (answer: RelayAnswer) => void>()
  private readonly _sub = `myr-${randomBytes(4).toString('hex')}`

  constructor(
    readonly url: string,
    private readonly filter: () => Record<string, unknown>,
    private readonly onEvent: (event: unknown) => void,
    private readonly changed: () => void,
    private readonly log: (message: string) => void,
  ) {}

  async run(signal: AbortSignal) {
    const backoff = new Backoff(BACKOFF_MIN_MS, BACKOFF_MAX_MS)
    while (!signal.aborted) {
      const why = await this._connect(signal, backoff)
      this.up = false
      this.lastError = why
      for (const answer of this._waiting.values()) answer({ ok: false, message: why })
      this._waiting.clear()
      if (signal.aborted) break
      this.changed()
      await sleep(backoff.next(), signal)
    }
  }

  /** Resolves with why the connection ended. */
  private _connect(signal: AbortSignal, backoff: Backoff): Promise<string> {
    return new Promise((resolve) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(this.url)
      } catch {
        return resolve(`cannot open ${this.url}`)
      }
      this._ws = ws
      let over = false
      const end = (why: string) => {
        if (over) return
        over = true
        signal.removeEventListener('abort', onAbort)
        ws.close()
        resolve(why)
      }
      const onAbort = () => end('stopped')
      signal.addEventListener('abort', onAbort, { once: true })
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(['REQ', this._sub, this.filter()]))
        this.up = true
        this.lastError = undefined
        backoff.up()
        this.changed()
      })
      ws.addEventListener('message', (event) => {
        let msg: unknown
        try {
          msg = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (!Array.isArray(msg)) return
        const [type, a, b, c] = msg as [unknown, unknown, unknown, unknown]
        if (type === 'EVENT' && a === this._sub) this.onEvent(b)
        else if (type === 'OK' && typeof a === 'string')
          this._waiting.get(a)?.({ ok: b === true, message: typeof c === 'string' ? c : '' })
        else if (type === 'NOTICE' || type === 'CLOSED')
          this.log(`${this.url}: ${String(type === 'CLOSED' ? b : a)}`)
      })
      ws.addEventListener('close', (event) => end(`${this.url} closed (${event.code})`))
      ws.addEventListener('error', () => end(`cannot reach ${this.url}`))
    })
  }

  /** Sends an event; resolves with the relay's OK (or why not). */
  publish(event: Event): Promise<RelayAnswer> {
    const ws = this._ws
    if (!this.up || !ws || ws.readyState !== WebSocket.OPEN)
      return Promise.resolve({ ok: false, message: `${this.url} is not connected` })
    return new Promise((resolve) => {
      const timer = setTimeout(() => done({ ok: false, message: `${this.url} did not answer` }), PUBLISH_MS)
      const done = (answer: RelayAnswer) => {
        clearTimeout(timer)
        this._waiting.delete(event.id)
        resolve(answer)
      }
      this._waiting.set(event.id, done)
      ws.send(JSON.stringify(['EVENT', event]))
    })
  }
}

export class NostrAdapter implements ChannelAdapter {
  readonly id = 'nostr'
  readonly label = 'Nostr'
  /** Clients show long DMs fine; no edits, files or buttons in NIP-04. */
  readonly limits = { text: 4000, editMs: 1500 }
  readonly can = { buttons: false, files: false, edit: false }
  private _sk?: Uint8Array
  private _pk = ''
  private _relays: Relay[] = []
  private _io?: AdapterIO
  private _abort?: AbortController
  private _running: Promise<void>[] = []
  private _on = false
  private readonly _seen = new Set<string>()
  private readonly _recent = new Map<string, number[]>()
  /** The last message from each person, which a reply points at (NIP-04's `e` tag, as OpenClaw sets it). */
  private readonly _lastFrom = new Map<string, string>()
  private _since = 0

  constructor(private readonly values: ChannelValues) {}

  /** Derives the bot's public key from its private key, and checks the relay addresses. */
  async check(): Promise<string> {
    const sk = nostrSecretKey(this.values.privateKey ?? '')
    nostrRelays(this.values)
    return npubEncode(getPublicKey(sk))
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    let relays: string[]
    try {
      this._sk = nostrSecretKey(this.values.privateKey ?? '')
      relays = nostrRelays(this.values)
    } catch (err) {
      return io.status({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    this._pk = getPublicKey(this._sk)
    const saved = Number(io.get('since'))
    this._since = Number.isFinite(saved) && saved > 0 ? saved : Math.floor(Date.now() / 1000)
    this._relays = relays.map(
      (url) =>
        new Relay(
          url,
          () => ({ kinds: [DM_KIND], '#p': [this._pk], since: Math.max(0, this._since - LOOKBACK_S) }),
          (event) => void this._onEvent(event).catch((err) => io.log(String(err))),
          () => this._changed(),
          (message) => io.log(message),
        ),
    )
    this._running = this._relays.map((relay) => relay.run(signal))
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await Promise.all(this._running)
  }

  /** On while any relay is connected. */
  private _changed() {
    const io = this._io
    if (!io || this._abort?.signal.aborted) return
    const up = this._relays.some((r) => r.up)
    if (up && !this._on) io.status({ state: 'on', account: npubEncode(this._pk) })
    if (!up)
      io.status({
        state: 'retrying',
        error: this._relays.map((r) => r.lastError ?? `${r.url} is connecting`).join('; '),
      })
    this._on = up
  }

  /** Per-sender rate, before any decrypting. */
  private _flooding(pubkey: string) {
    const now = Date.now()
    const recent = (this._recent.get(pubkey) ?? []).filter((at) => now - at < 60_000)
    recent.push(now)
    this._recent.set(pubkey, recent)
    return recent.length > PER_SENDER_PER_MINUTE
  }

  private async _onEvent(raw: unknown) {
    const e = raw as Event
    if (!e || typeof e !== 'object' || e.kind !== DM_KIND || typeof e.content !== 'string') return
    if (typeof e.pubkey !== 'string' || e.pubkey === this._pk || !Array.isArray(e.tags)) return
    if (!e.tags.some((t) => t[0] === 'p' && t[1] === this._pk)) return
    if (Buffer.byteLength(e.content) > MAX_CIPHERTEXT) return
    if (e.created_at > Math.floor(Date.now() / 1000) + FUTURE_SKEW_S) return
    if (this._seen.has(e.id) || this._flooding(e.pubkey)) return
    // Only a valid signature may claim an id: otherwise a forged copy could hide the real message.
    if (!verifyEvent(e)) return
    this._seen.add(e.id)
    if (this._seen.size > SEEN_MAX) this._seen.delete(this._seen.values().next().value ?? '')
    let text: string
    try {
      text = decrypt(this._sk ?? new Uint8Array(), e.pubkey, e.content)
    } catch {
      this._io?.log(`could not decrypt a message from ${npubEncode(e.pubkey)}`)
      return
    }
    this._lastFrom.set(e.pubkey, e.id)
    const npub = npubEncode(e.pubkey)
    await this._io?.receive({
      messageId: e.id,
      chat: { id: e.pubkey, kind: 'dm' },
      sender: { id: e.pubkey, name: short(npub), handle: npub },
      text: text.trim(),
      mentioned: true,
      time: new Date(e.created_at * 1000).toISOString(),
    })
    // Where to resume after a restart: the newest message handled.
    if (e.created_at >= this._since) {
      this._since = e.created_at
      this._io?.set('since', String(e.created_at))
    }
  }

  /** Encrypted to the person, signed by the bot, published to every relay; sent when any relay accepts it. */
  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const to = chatIdOf(chat).toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(to)) throw new Error(`not a Nostr public key: ${to}`)
    const sk = this._sk ?? nostrSecretKey(this.values.privateKey ?? '')
    const reply = this._lastFrom.get(to)
    const event = finalizeEvent(
      {
        kind: DM_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', to], ...(reply ? [['e', reply]] : [])],
        content: encrypt(sk, to, plainText(message.text)),
      },
      sk,
    )
    const answers = await Promise.all(this._relays.map((relay) => relay.publish(event)))
    if (!answers.some((a) => a.ok))
      throw new Error(`no relay took the message: ${answers.map((a) => a.message).join('; ') || 'no relays'}`)
    return { chat: to, id: event.id }
  }

  /** NIP-04 messages cannot be edited. */
  async edit(): Promise<void> {}

  /** NIP-04 has no typing indicator. */
  async typing(): Promise<void> {}
}
