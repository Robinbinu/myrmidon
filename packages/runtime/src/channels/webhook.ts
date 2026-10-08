import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { channelCopy } from './copy.ts'
import {
  type AdapterIO,
  type ChannelAdapter,
  type ChannelChat,
  chatIdOf,
  type Inbound,
  type InboundFile,
  type OutFile,
  type OutMessage,
  type SentRef,
  threadOf,
} from './types.ts'

/**
 * A generic webhook channel, after Hermes's `gateway/platforms/webhook.py`: anything that can POST JSON (a script,
 * home automation, another service) talks to the crew, and the answers are POSTed back to a callback URL. Both
 * directions are signed with one shared secret using Hermes's generic HMAC V2 scheme, which binds a timestamp into
 * the signature so a captured request cannot be replayed later (or with a fresh timestamp):
 *
 *   X-Timestamp: <unix seconds>
 *   X-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
 *
 * Hermes's route filters, scripts and event coalescing are for many routes fed by third-party services; one
 * channel per gateway receiving chat-shaped messages has no use for them (the hub already drops redeliveries by id).
 */

/** Requests signed longer ago than this are refused (Hermes's replay window). */
const REPLAY_WINDOW_S = 300
/** Shorter secrets are refused at setup: a guessable secret is no signature at all. */
const SECRET_MIN = 16
const CALLBACK_TIMEOUT_MS = 30_000

interface WebhookFile {
  name?: unknown
  mimeType?: unknown
  /** Base64. */
  data?: unknown
}

interface WebhookBody {
  id?: unknown
  chat?: unknown
  sender?: { id?: unknown; name?: unknown; handle?: unknown }
  text?: unknown
  mentioned?: unknown
  time?: unknown
  files?: unknown
}

const sign = (secret: string, timestamp: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

const kindOf = (mimeType: string): InboundFile['kind'] =>
  mimeType.startsWith('image/')
    ? 'image'
    : mimeType.startsWith('audio/')
      ? 'audio'
      : mimeType.startsWith('video/')
        ? 'video'
        : 'document'

export class WebhookAdapter implements ChannelAdapter {
  readonly id = 'webhook'
  readonly label: string
  /** No platform limit; long answers still arrive in parts a receiver can show. Edits are POSTs, so not too many. */
  readonly limits = { text: 16_000, editMs: 3000, file: 10 * 1024 * 1024 }
  readonly can = { buttons: false, files: true, edit: true }
  private _io?: AdapterIO

  constructor(
    private readonly secret: string,
    private readonly callback: string,
    name?: string,
  ) {
    this.label = name?.trim() || 'Webhook'
  }

  async check(): Promise<string> {
    if (this.secret.length < SECRET_MIN)
      throw new Error(`use a shared secret of at least ${SECRET_MIN} characters (e.g. openssl rand -hex 32)`)
    let url: URL
    try {
      url = new URL(this.callback)
    } catch {
      throw new Error('the callback URL is not a URL')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('the callback URL must start with https:// or http://')
    return this.label === 'Webhook' ? url.host : this.label
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    if (!io.webhookUrl) return io.status({ state: 'error', error: channelCopy.needsPublicUrl(this.label) })
    io.status({ state: 'on', account: await this.check() })
  }

  async stop(): Promise<void> {
    this._io = undefined
  }

  /** A signed POST: checked (signature, then age) before anything in it is read. */
  async webhook(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
    const raw = await req.text()
    const timestamp = req.headers.get('x-timestamp') ?? ''
    const given = req.headers.get('x-signature') ?? ''
    if (!timestamp || !given || !sameSecret(given, sign(this.secret, timestamp, raw)))
      return new Response('invalid signature', { status: 401 })
    const age = Math.abs(Date.now() / 1000 - Number(timestamp))
    if (!Number.isFinite(age) || age > REPLAY_WINDOW_S)
      return new Response('stale timestamp', { status: 401 })
    let body: WebhookBody
    try {
      body = JSON.parse(raw) as WebhookBody
    } catch {
      return new Response('the body must be JSON', { status: 400 })
    }
    const message = this._inbound(body)
    if (!message) return new Response('id, chat, sender.id and text (or files) are required', { status: 400 })
    if (!this._io) return new Response('not running', { status: 503 })
    await this._io.receive(message)
    return Response.json({ ok: true })
  }

  private _inbound(body: WebhookBody): Inbound | undefined {
    const id = text(body.id)
    const raw = body.chat
    const chatObj = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : undefined
    const chatId = chatObj ? text(chatObj.id) : text(raw)
    const senderId = text(body.sender?.id)
    const files = Array.isArray(body.files) ? body.files.flatMap((f) => this._file(f as WebhookFile)) : []
    if (!id || !chatId || !senderId || (typeof body.text !== 'string' && !files.length)) return undefined
    const kind = chatObj?.kind === 'group' ? 'group' : 'dm'
    const title = text(chatObj?.title)
    const thread = text(chatObj?.thread)
    const handle = text(body.sender?.handle)
    const time = text(body.time)
    return {
      messageId: id,
      chat: { id: chatId, kind, ...(title ? { title } : {}), ...(thread ? { thread } : {}) },
      sender: { id: senderId, name: text(body.sender?.name) || senderId, ...(handle ? { handle } : {}) },
      text: text(body.text),
      // Whatever posts here means the crew; a group sender may say otherwise.
      mentioned: kind === 'dm' || body.mentioned !== false,
      ...(files.length ? { files } : {}),
      time: time && !Number.isNaN(Date.parse(time)) ? new Date(time).toISOString() : new Date().toISOString(),
    }
  }

  private _file(f: WebhookFile): InboundFile[] {
    const data = text(f.data)
    if (!data) return []
    const mimeType = text(f.mimeType) || 'application/octet-stream'
    const bytes = Buffer.from(data, 'base64')
    return [
      {
        kind: kindOf(mimeType),
        name: text(f.name) || 'file',
        mimeType,
        size: bytes.byteLength,
        read: async () => new Uint8Array(bytes),
      },
    ]
  }

  /** POSTs to the callback, signed like the webhooks it takes; never logs or throws the URL (it may carry a key). */
  private async _post(payload: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(payload)
    const timestamp = String(Math.floor(Date.now() / 1000))
    let res: Response
    try {
      res = await fetch(this.callback, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-timestamp': timestamp,
          'x-signature': sign(this.secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(`cannot reach the callback URL: ${err instanceof Error ? err.name : 'network error'}`)
    }
    if (!res.ok) throw new Error(`the callback URL answered ${res.status}`)
  }

  private _where(chat: ChannelChat | string) {
    const thread = threadOf(chat)
    return { chat: chatIdOf(chat), ...(thread ? { thread } : {}) }
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const id = randomBytes(9).toString('base64url')
    await this._post({ type: 'message', id, ...this._where(chat), text: message.text })
    return { chat: chatIdOf(chat), id }
  }

  async edit(ref: SentRef, message: OutMessage): Promise<void> {
    await this._post({ type: 'edit', id: ref.id, chat: ref.chat, text: message.text })
  }

  /** Not sent: a POST every few seconds while the crew works would only be noise for most receivers. */
  async typing(): Promise<void> {}

  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const id = randomBytes(9).toString('base64url')
    await this._post({
      type: 'file',
      id,
      ...this._where(chat),
      name: file.name,
      mimeType: file.mimeType,
      ...(file.caption ? { caption: file.caption } : {}),
      data: Buffer.from(file.data).toString('base64'),
    })
    return { chat: chatIdOf(chat), id }
  }
}
