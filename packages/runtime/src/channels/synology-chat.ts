import { randomBytes, timingSafeEqual } from 'node:crypto'
import { channelCopy } from './copy.ts'
import {
  type AdapterIO,
  type ChannelAdapter,
  type ChannelChat,
  chatIdOf,
  type Inbound,
  type OutFile,
  type OutMessage,
  type SentRef,
} from './types.ts'

/**
 * Synology Chat through a bot integration, ported from OpenClaw's `synology-chat` extension: the bot's outgoing
 * webhook posts each message to this gateway with a token (checked in constant time), and replies go to the bot's
 * incoming URL with the person's numeric `user_ids`. Like OpenClaw, direct messages only (a bot is talked to one to
 * one). Files go out as a link the NAS fetches from this gateway: a random, short-lived address on the channel's own
 * webhook route (OpenClaw's hosted capability), so no file is ever public for long or guessable.
 */

/** Synology Chat's message length (OpenClaw chunks at this). */
const TEXT_LIMIT = 2000
/** Synology rate-limits bots; OpenClaw keeps sends this far apart. */
const SEND_GAP_MS = 500
const POST_TIMEOUT_MS = 30_000
/** How long a hosted file's address works, and the largest file (OpenClaw's limits). */
const FILE_TTL_MS = 10 * 60_000
const FILE_MAX = 32 * 1024 * 1024
/** Files a browser would run rather than download are never hosted. */
const ACTIVE = /^(text\/html|image\/svg\+xml|application\/xhtml\+xml|application\/xml|text\/xml)\b/
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000

interface HostedFile {
  readonly file: OutFile
  readonly expires: number
}

/** A failure only the person can fix (a wrong URL or token), as opposed to an unreachable NAS. */
class SettingsError extends Error {}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

/** The fields of an outgoing-webhook post: form-encoded (Synology's own) or JSON. */
function fieldsOf(req: Request, raw: string): Record<string, string> {
  const type = req.headers.get('content-type') ?? ''
  const out: Record<string, string> = {}
  let parsed: Record<string, unknown> | undefined
  if (type.includes('application/json') || raw.trimStart().startsWith('{')) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      parsed = undefined
    }
  }
  if (parsed) {
    for (const [k, v] of Object.entries(parsed))
      if (typeof v === 'string' || typeof v === 'number') out[k] = String(v)
  } else for (const [k, v] of new URLSearchParams(raw)) out[k] = v
  return out
}

/** Token precedence is body, query, then headers (as OpenClaw takes it). */
function tokenOf(req: Request, fields: Record<string, string>): string {
  const auth = req.headers.get('authorization') ?? ''
  return (
    fields.token ||
    new URL(req.url).searchParams.get('token') ||
    req.headers.get('x-synology-token') ||
    req.headers.get('x-webhook-token') ||
    auth.replace(/^Bearer\s+/i, '')
  )
}

export class SynologyChatAdapter implements ChannelAdapter {
  readonly id = 'synology-chat'
  readonly label = 'Synology Chat'
  readonly limits = { text: TEXT_LIMIT, editMs: 1500, file: FILE_MAX }
  readonly can = { buttons: false, files: true, edit: false }
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _queue: Promise<void> = Promise.resolve()
  private _lastSend = 0
  private readonly _hosted = new Map<string, HostedFile>()

  constructor(
    /** The bot's incoming URL; it carries the bot's token, so it is never logged or shown. */
    private readonly incomingUrl: string,
    /** The outgoing webhook's token, which every post to this gateway must carry. */
    private readonly token: string,
  ) {}

  private _url(method: string): string {
    return this.incomingUrl.replace(/method=\w+/, `method=${method}`)
  }

  /** The bot's user list answers only to a valid token, so it proves the incoming URL works. */
  async check(): Promise<string> {
    let host: string
    try {
      host = new URL(this.incomingUrl).host
    } catch {
      throw new SettingsError('the incoming URL is not a URL; copy it again from the bot’s settings')
    }
    let res: Response
    try {
      res = await fetch(this._url('user_list'), { signal: AbortSignal.timeout(POST_TIMEOUT_MS) })
    } catch (err) {
      throw new Error(
        `cannot reach Synology Chat at ${host}: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
    const data = (await res.json().catch(() => ({}))) as { success?: boolean }
    if (!res.ok || data.success !== true)
      throw new SettingsError('Synology Chat refused the incoming URL; copy it again from the bot’s settings')
    return host
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    if (!io.webhookUrl) return io.status({ state: 'error', error: channelCopy.needsPublicUrl(this.label) })
    io.status({ state: 'connecting' })
    this._abort = new AbortController()
    const signal = this._abort.signal
    // Messages arrive by webhook regardless; this says whether replies can get out, retrying while the NAS is away.
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      while (!signal.aborted) {
        try {
          return io.status({ state: 'on', account: await this.check() })
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          if (err instanceof SettingsError) return io.status({ state: 'error', error })
          io.status({ state: 'retrying', error })
          await sleep(backoff * (0.75 + Math.random() * 0.5), signal)
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        }
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
    this._io = undefined
    this._hosted.clear()
  }

  /** A message from the outgoing webhook (POST), or the NAS fetching a hosted file (GET `?file=`). */
  async webhook(req: Request): Promise<Response> {
    if (req.method === 'GET' || req.method === 'HEAD') return this._serve(req)
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
    const raw = await req.text()
    const fields = fieldsOf(req, raw)
    if (!sameSecret(tokenOf(req, fields), this.token)) return new Response('invalid token', { status: 401 })
    const userId = fields.user_id ?? ''
    let text = fields.text ?? ''
    if (!userId || !text) return new Response('user_id and text are required', { status: 400 })
    // A channel webhook's trigger word starts the text; it is not part of the request.
    const trigger = fields.trigger_word
    if (trigger && text.startsWith(trigger)) text = text.slice(trigger.length).trim()
    const seconds = Number(fields.timestamp)
    const message: Inbound = {
      // Synology's post id is stable across its retries; the timestamp stands in on old servers without it.
      messageId: fields.post_id || `${userId}:${fields.timestamp ?? Date.now()}`,
      chat: { id: userId, kind: 'dm' },
      // No handle: the username is the person's own nickname, which anyone can change (OpenClaw trusts only ids).
      sender: { id: userId, name: fields.username || userId },
      text,
      mentioned: true,
      time:
        Number.isFinite(seconds) && seconds > 0
          ? new Date(seconds * 1000).toISOString()
          : new Date().toISOString(),
    }
    if (!this._io) return new Response('not running', { status: 503 })
    await this._io.receive(message)
    return new Response(null, { status: 204 })
  }

  private _serve(req: Request): Response {
    const key = new URL(req.url).searchParams.get('file') ?? ''
    const now = Date.now()
    for (const [k, h] of this._hosted) if (h.expires < now) this._hosted.delete(k)
    const hosted = key ? this._hosted.get(key) : undefined
    if (!hosted) return new Response('not found', { status: 404 })
    const { file } = hosted
    return new Response(req.method === 'HEAD' ? null : new Uint8Array(file.data), {
      headers: {
        'content-type': file.mimeType,
        'content-length': String(file.data.byteLength),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    })
  }

  /** One post to the incoming URL at a time, at most one per SEND_GAP_MS. */
  private _post(payload: Record<string, unknown>): Promise<void> {
    const run = this._queue.then(async () => {
      const wait = this._lastSend + SEND_GAP_MS - Date.now()
      if (wait > 0) await Bun.sleep(wait)
      this._lastSend = Date.now()
      let res: Response
      try {
        res = await fetch(this.incomingUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: `payload=${encodeURIComponent(JSON.stringify(payload))}`,
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        })
      } catch (err) {
        throw new Error(`cannot reach Synology Chat: ${err instanceof Error ? err.name : 'network error'}`)
      }
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { code?: number } }
      if (!res.ok || data.success === false)
        throw new Error(
          `Synology Chat refused the message (${data.error?.code ?? res.status}); check the bot's incoming URL`,
        )
    })
    this._queue = run.catch(() => {})
    return run
  }

  /** The chat API wants the numeric user id the outgoing webhook gave. */
  private _recipient(chat: ChannelChat | string) {
    const id = Number(chatIdOf(chat))
    if (!Number.isSafeInteger(id))
      throw new Error(`Synology Chat needs a numeric user id, not ${chatIdOf(chat)}`)
    return { user_ids: [id] }
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    await this._post({ text: message.text, ...this._recipient(chat) })
    // The incoming webhook does not say what it posted; a sent message cannot be edited anyway.
    return { chat: chatIdOf(chat), id: randomBytes(6).toString('hex') }
  }

  /** Synology Chat cannot edit a bot's message; the hub only sends new ones (`can.edit` is false). */
  async edit(): Promise<void> {}

  /** Synology Chat has no typing indicator for bots. */
  async typing(): Promise<void> {}

  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const base = this._io?.webhookUrl
    if (!base) throw new Error(channelCopy.needsPublicUrl(this.label))
    if (ACTIVE.test(file.mimeType) || /\.(html?|svg|xml|xhtml)$/i.test(file.name))
      throw new Error(`${file.name} is a web page or markup, which is not sent as a file`)
    if (file.data.byteLength > FILE_MAX) throw new Error(`${file.name} is larger than Synology Chat takes`)
    const key = randomBytes(24).toString('base64url')
    this._hosted.set(key, { file, expires: Date.now() + FILE_TTL_MS })
    const url = new URL(base)
    url.searchParams.set('file', key)
    if (file.caption) await this._post({ text: file.caption, ...this._recipient(chat) })
    await this._post({ file_url: url.toString(), ...this._recipient(chat) })
    return { chat: chatIdOf(chat), id: key.slice(0, 12) }
  }
}
