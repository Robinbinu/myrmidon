import { randomBytes, timingSafeEqual } from 'node:crypto'
import { plainText, splitChars } from './format.ts'
import { Backoff, sleep } from './pace.ts'
import {
  type AdapterIO,
  type ChannelAdapter,
  type ChannelChat,
  chatIdOf,
  type Inbound,
  type InboundFile,
  type OutMessage,
  type SentRef,
} from './types.ts'

/**
 * Zalo through the official Zalo Bot Platform API (bot.zaloplatforms.com) over plain HTTP, ported from OpenClaw's
 * `zalo` plugin: a bot token from Zalo's Bot Creator, long polling by default, or a webhook carrying a secret header
 * when the gateway has a public address (Zalo allows one or the other); direct chats and groups (answered only when
 * the bot is @mentioned), text replies up to 2000 characters, photos in. The token does not expire, so there is
 * nothing to refresh. Not the personal-account route (OpenClaw's `zalouser`, which drives a logged-in Zalo account
 * and can get it banned): this is a bot Zalo knows is a bot.
 */

export const ZALO_API = 'https://bot-api.zaloplatforms.com'
/** How long one getUpdates call waits for an update. */
const POLL_S = 30
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
/** Zalo's message limit. */
const TEXT_MAX = 2000
/** Photos larger than this are not downloaded (OpenClaw's default media cap). */
const PHOTO_MAX = 5 * 1024 * 1024
/** A webhook body larger than this is refused. */
const WEBHOOK_MAX = 1024 * 1024
/** `date` above this is already milliseconds. */
const MS_THRESHOLD = 1e12
const REFUSED = 'Zalo refused this bot token; copy it again from Zalo Bot Creator'

class ZaloError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

interface ZaloMessage {
  message_id?: string
  from?: { id?: string; name?: string; display_name?: string; is_bot?: boolean }
  chat?: { id?: string; chat_type?: 'PRIVATE' | 'GROUP' }
  date?: number
  text?: string
  photo_url?: string
  caption?: string
  sticker?: string
}
interface ZaloUpdate {
  event_name?: string
  message?: ZaloMessage
}

export class ZaloAdapter implements ChannelAdapter {
  readonly id = 'zalo'
  readonly label = 'Zalo'
  /** Zalo's text limit; photos go out only by public URL, so no files out; no edits or buttons. */
  readonly limits = { text: TEXT_MAX, editMs: 1500 }
  readonly can = { buttons: false, files: false, edit: false }
  private _name?: string
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _secret?: string

  constructor(
    private readonly token: string,
    private readonly api = ZALO_API,
  ) {}

  /** Never logs or throws the URL: it carries the token. */
  private async _call<T>(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.api}/bot${this.token.trim()}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ?? AbortSignal.timeout(30_000),
      })
    } catch (err) {
      if (signal?.aborted && !(err instanceof Error && err.name === 'TimeoutError')) throw err
      throw new ZaloError(0, `cannot reach Zalo: ${err instanceof Error ? err.name : 'network error'}`)
    }
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      result?: T
      error_code?: number
      description?: string
    }
    if (!data.ok)
      throw new ZaloError(data.error_code ?? res.status, data.description ?? `Zalo answered ${res.status}`)
    return data.result as T
  }

  async check(): Promise<string> {
    if (!/^\d+:\S+$/.test(this.token.trim())) throw new Error('a Zalo bot token looks like 12345689:abc-xyz')
    try {
      const me = await this._call<{ id?: string; account_name?: string }>('getMe')
      this._name = me.account_name ?? ''
      return this._name || `bot ${me.id ?? ''}`.trim()
    } catch (err) {
      if (err instanceof ZaloError && (err.code === 401 || err.code === 403 || err.code === 404))
        throw new Error(REFUSED)
      throw err
    }
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      const backoff = new Backoff(BACKOFF_MIN_MS, BACKOFF_MAX_MS, 0)
      let account: string | undefined
      while (!signal.aborted && account === undefined) {
        try {
          account = await this.check()
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          if (!(err instanceof ZaloError)) return io.status({ state: 'error', error })
          io.status({ state: 'retrying', error })
          await sleep(backoff.next(), signal)
        }
      }
      if (signal.aborted || account === undefined) return
      if (io.webhookUrl) {
        // Zalo pushes updates, each carrying this secret (8 to 256 characters), which the webhook checks.
        this._secret = io.get('webhook-secret') ?? randomBytes(24).toString('base64url')
        io.set('webhook-secret', this._secret)
        try {
          await this._call('setWebhook', { url: io.webhookUrl, secret_token: this._secret })
          io.status({ state: 'on', account })
        } catch (err) {
          io.status({ state: 'error', error: err instanceof Error ? err.message : String(err) })
        }
        return
      }
      // Polling and a webhook are exclusive: one left from a webhook setup would make every poll fail.
      await this._call('deleteWebhook').catch(() => {})
      io.status({ state: 'on', account })
      let retrying = false
      while (!signal.aborted) {
        try {
          const result = await this._call<ZaloUpdate | ZaloUpdate[] | undefined>(
            'getUpdates',
            { timeout: String(POLL_S) },
            AbortSignal.any([signal, AbortSignal.timeout((POLL_S + 15) * 1000)]),
          )
          if (retrying) io.status({ state: 'on', account })
          retrying = false
          // Zalo answers one update per call (Telegram answers a list); both are taken.
          for (const update of Array.isArray(result) ? result : result ? [result] : []) {
            const message = this._inbound(update)
            if (message) await io.receive(message)
          }
        } catch (err) {
          if (signal.aborted) break
          // 408: the long poll ended with nothing new.
          if (err instanceof ZaloError && err.code === 408) continue
          const error = err instanceof Error ? err.message : String(err)
          if (err instanceof ZaloError && (err.code === 401 || err.code === 403))
            return io.status({ state: 'error', error: REFUSED })
          io.status({ state: 'retrying', error })
          retrying = true
          await sleep(backoff.next(), signal)
        }
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
  }

  /** An update Zalo pushed, accepted only with the secret it was given when the webhook was set. */
  async webhook(req: Request): Promise<Response> {
    const given = Buffer.from(req.headers.get('x-bot-api-secret-token') ?? '')
    const secret = Buffer.from(this._secret ?? '')
    if (!secret.length || given.length !== secret.length || !timingSafeEqual(given, secret))
      return new Response('unauthorized', { status: 401 })
    if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(req.headers.get('content-type') ?? ''))
      return new Response('unsupported media type', { status: 415 })
    const raw = await req.text()
    if (raw.length > WEBHOOK_MAX) return new Response('too large', { status: 413 })
    let body: (ZaloUpdate & { ok?: boolean; result?: ZaloUpdate }) | undefined
    try {
      body = JSON.parse(raw)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    // Sometimes the update itself, sometimes wrapped as `{ ok, result }`.
    const update = body?.ok === true && body.result ? body.result : body
    const message = update && this._inbound(update)
    if (message) await this._io?.receive(message)
    return new Response('ok')
  }

  private _photo(url: string, id: string): InboundFile {
    return {
      kind: 'image',
      name: `photo-${id}.jpg`,
      mimeType: 'image/jpeg',
      read: async () => {
        if (!/^https?:\/\//i.test(url)) throw new Error('Zalo sent a photo without a web address')
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) throw new Error(`Zalo answered ${res.status} for the photo`)
        if (Number(res.headers.get('content-length') ?? 0) > PHOTO_MAX)
          throw new Error('the photo is too large')
        const data = new Uint8Array(await res.arrayBuffer())
        if (data.byteLength > PHOTO_MAX) throw new Error('the photo is too large')
        return data
      },
    }
  }

  /** An update as the hub's message; undefined for bots and what has no message. */
  private _inbound(update: ZaloUpdate): Inbound | undefined {
    const msg = update.message
    const from = msg?.from
    if (!msg?.message_id || !msg.chat?.id || !from?.id || from.is_bot) return undefined
    const group = msg.chat.chat_type === 'GROUP'
    const chat: ChannelChat = { id: msg.chat.id, kind: group ? 'group' : 'dm' }
    const raw = (msg.text ?? msg.caption ?? '').trim()
    const name = this._name ?? ''
    const tag = name
      ? new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'giu')
      : undefined
    const mentioned = !group || Boolean(tag && new RegExp(tag.source, 'iu').test(raw))
    const text = (tag ? raw.replace(tag, ' ') : raw).replace(/\s{2,}/g, ' ').trim()
    const files =
      update.event_name === 'message.image.received' && msg.photo_url
        ? [this._photo(msg.photo_url, msg.message_id)]
        : []
    const date = msg.date && msg.date < MS_THRESHOLD ? msg.date * 1000 : msg.date
    return {
      messageId: msg.message_id,
      chat,
      sender: { id: from.id, name: from.display_name || from.name || 'Someone' },
      text,
      mentioned,
      ...(files.length ? { files } : {}),
      ...(!text && !files.length && (msg.sticker || update.event_name === 'message.unsupported.received')
        ? { unsupported: true }
        : {}),
      time: new Date(date || Date.now()).toISOString(),
    }
  }

  /** Plain text; what the hub sends unsplit (an approval with a long preview) goes as several messages. */
  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    let id = ''
    for (const text of splitChars(plainText(message.text), TEXT_MAX)) {
      const sent = await this._call<{ message_id?: string }>('sendMessage', { chat_id: chatIdOf(chat), text })
      id = sent?.message_id ?? id
    }
    return { chat: chatIdOf(chat), id }
  }

  /** The Zalo Bot API cannot edit a sent message. */
  async edit(): Promise<void> {}

  async typing(chat: ChannelChat | string): Promise<void> {
    await this._call('sendChatAction', { chat_id: chatIdOf(chat), action: 'typing' })
  }
}
