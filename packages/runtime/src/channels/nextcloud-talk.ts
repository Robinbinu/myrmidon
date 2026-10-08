import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { channelCopy } from './copy.ts'
import {
  type AdapterIO,
  type ChannelAdapter,
  type ChannelChat,
  chatIdOf,
  type Inbound,
  type OutMessage,
  type SentRef,
} from './types.ts'

/**
 * Nextcloud Talk through its bot API, ported from OpenClaw's `nextcloud-talk` extension: Talk posts each message in
 * a conversation the bot is enabled in to this gateway, signed `HMAC-SHA256(random + body)` with the bot's secret
 * (`X-Nextcloud-Talk-Signature`, `X-Nextcloud-Talk-Random`); replies go to the bot API, signed the same way over the
 * message text. The webhook does not say whether a conversation is one to one, so like OpenClaw every conversation
 * is a group unless a Nextcloud user and app password are given to look the room's type up.
 */

const SEND_TIMEOUT_MS = 30_000
/** Talk's message limit. */
const TEXT_LIMIT = 32_000
/** A room's type is looked up at most this often. */
const ROOM_TTL_MS = 5 * 60_000
/** Talk's room types for one-to-one, former one-to-one and note-to-self conversations. */
const DIRECT_ROOMS = new Set([1, 5, 6])
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000

/** A failure only the person can fix (a wrong address or password), as opposed to an unreachable server. */
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

interface TalkWebhook {
  type?: string
  actor?: { type?: string; id?: string; name?: string }
  object?: { type?: string; id?: string | number; name?: string; content?: string; mediaType?: string }
  target?: { type?: string; id?: string; name?: string }
}

interface RichParameter {
  type?: string
  id?: string
  name?: string
}

const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex')

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given.toLowerCase())
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Talk's message text: `object.content` is JSON with the message and its rich parameters (`{mention-user1}`,
 * `{file}`); parameters become readable text, mentions `@name`.
 */
function talkText(content: string): { text: string; files: string[] } {
  let parsed: { message?: unknown; parameters?: Record<string, RichParameter> } | undefined
  try {
    parsed = content.trimStart().startsWith('{') ? JSON.parse(content) : undefined
  } catch {
    parsed = undefined
  }
  if (typeof parsed?.message !== 'string') return { text: content, files: [] }
  const params = parsed.parameters ?? {}
  const files: string[] = []
  const text = parsed.message.replace(/\{([\w-]+)\}/g, (whole, key: string) => {
    const p = params[key]
    if (!p) return whole
    if (p.type === 'file') {
      files.push(p.name ?? 'file')
      return ''
    }
    return key.startsWith('mention') ? `@${p.name ?? p.id ?? ''}` : (p.name ?? whole)
  })
  return { text: text.trim(), files }
}

export class NextcloudTalkAdapter implements ChannelAdapter {
  readonly id = 'nextcloud-talk'
  readonly label = 'Nextcloud Talk'
  readonly limits = { text: TEXT_LIMIT, editMs: 1500 }
  readonly can = { buttons: false, files: false, edit: false }
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  private readonly _base: string
  private readonly _rooms = new Map<string, { kind: ChannelChat['kind']; until: number }>()

  constructor(
    url: string,
    private readonly secret: string,
    /** A Nextcloud user and app password, to look up whether a room is one to one (optional). */
    private readonly user = '',
    private readonly password = '',
    /** The name the bot was installed with, which people @mention in group conversations. */
    private readonly name = 'Myrmidon',
  ) {
    this._base = url.trim().replace(/\/+$/, '')
  }

  private _auth() {
    return `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}`
  }

  /** Talk's bot secret can only be proven by a send; this checks the server (and the user, when given). */
  async check(): Promise<string> {
    let host: string
    try {
      host = new URL(this._base).host
    } catch {
      throw new SettingsError('the server address is not a URL (e.g. https://cloud.example.com)')
    }
    let res: Response
    try {
      res = await fetch(`${this._base}/status.php`, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
    } catch (err) {
      throw new Error(
        `cannot reach Nextcloud at ${host}: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
    const status = (await res.json().catch(() => ({}))) as { installed?: boolean }
    if (!res.ok || status.installed !== true)
      throw new SettingsError(`no Nextcloud server answers at ${this._base}`)
    if (this.user && this.password) {
      const me = await fetch(`${this._base}/ocs/v2.php/cloud/user?format=json`, {
        headers: { authorization: this._auth(), 'ocs-apirequest': 'true', accept: 'application/json' },
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      }).catch(() => undefined)
      if (me?.status === 401) throw new SettingsError('Nextcloud refused that user and app password')
    }
    return host
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    if (!io.webhookUrl) return io.status({ state: 'error', error: channelCopy.needsPublicUrl(this.label) })
    io.status({ state: 'connecting' })
    this._abort = new AbortController()
    const signal = this._abort.signal
    // Messages arrive by webhook regardless; this says whether replies can get out, retrying while it is away.
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
  }

  /** A message Talk posted, accepted only with a valid signature over the random value and the body. */
  async webhook(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
    const signature = req.headers.get('x-nextcloud-talk-signature') ?? ''
    const random = req.headers.get('x-nextcloud-talk-random') ?? ''
    const raw = await req.text()
    if (!signature || !random || !sameSecret(signature, hmac(this.secret, random + raw)))
      return new Response('invalid signature', { status: 401 })
    let event: TalkWebhook
    try {
      event = JSON.parse(raw) as TalkWebhook
    } catch {
      return new Response('invalid payload', { status: 400 })
    }
    const message = await this._inbound(event)
    if (message && this._io) await this._io.receive(message)
    return new Response('ok')
  }

  /** Whether a room is one to one, when there are credentials to ask; otherwise every room is a group. */
  private async _kind(room: string): Promise<ChannelChat['kind']> {
    if (!this.user || !this.password) return 'group'
    const known = this._rooms.get(room)
    if (known && known.until > Date.now()) return known.kind
    let kind: ChannelChat['kind'] = 'group'
    try {
      const res = await fetch(
        `${this._base}/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(room)}`,
        {
          headers: { authorization: this._auth(), 'ocs-apirequest': 'true', accept: 'application/json' },
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        },
      )
      const data = (await res.json().catch(() => ({}))) as { ocs?: { data?: { type?: number } } }
      if (DIRECT_ROOMS.has(Number(data.ocs?.data?.type))) kind = 'dm'
    } catch (err) {
      this._io?.log(`room lookup failed: ${err instanceof Error ? err.name : 'network error'}`)
    }
    this._rooms.set(room, { kind, until: Date.now() + ROOM_TTL_MS })
    return kind
  }

  /** A Talk event as the hub's message; undefined for what is not a person's chat message (bots, system events). */
  private async _inbound(event: TalkWebhook): Promise<Inbound | undefined> {
    const { actor, object, target } = event
    if (event.type !== 'Create' || (object?.type && object.type !== 'Note')) return undefined
    if (!actor?.id || !target?.id || object?.id === undefined) return undefined
    if (actor.type === 'Application' || actor.id.startsWith('bots/')) return undefined
    const parsed = talkText(object.content || object.name || '')
    const kind = await this._kind(target.id)
    const mention = `@${escapeRe(this.name)}\\b`
    const mentioned =
      kind === 'dm' || new RegExp(mention, 'i').test(parsed.text) || parsed.text.startsWith('/')
    const text = parsed.text
      .replace(new RegExp(mention, 'gi'), '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
    return {
      messageId: String(object.id),
      chat: { id: target.id, kind, ...(target.name ? { title: target.name } : {}) },
      sender: { id: actor.id, name: actor.name || actor.id },
      text,
      mentioned,
      // A shared file needs the person's own Nextcloud access to read; the bot API gives none.
      ...(!text && parsed.files.length ? { unsupported: true } : {}),
      time: new Date().toISOString(),
    }
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const room = chatIdOf(chat)
    const text = message.text.trim()
    // Talk checks the signature over the message text, not the JSON body (ChecksumVerificationService).
    const random = randomBytes(32).toString('hex')
    let res: Response
    try {
      res = await fetch(
        `${this._base}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(room)}/message`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'ocs-apirequest': 'true',
            'x-nextcloud-talk-bot-random': random,
            'x-nextcloud-talk-bot-signature': hmac(this.secret, random + text),
          },
          body: JSON.stringify({ message: text }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        },
      )
    } catch (err) {
      throw new Error(`cannot reach Nextcloud: ${err instanceof Error ? err.name : 'network error'}`)
    }
    if (res.status === 401)
      throw new Error(
        'Nextcloud refused the bot secret; check it, and that the bot was installed with --feature response',
      )
    if (res.status === 403) throw new Error('the bot is not enabled in this conversation')
    if (res.status === 404) throw new Error('Nextcloud has no such conversation')
    if (!res.ok) throw new Error(`Nextcloud answered ${res.status}`)
    const data = (await res.json().catch(() => ({}))) as { ocs?: { data?: { id?: number | string } } }
    return { chat: room, id: String(data.ocs?.data?.id ?? randomBytes(6).toString('hex')) }
  }

  /** The bot API cannot edit (OpenClaw does not either); the hub only sends new messages (`can.edit` is false). */
  async edit(): Promise<void> {}

  /** Talk has no typing indicator for bots. */
  async typing(): Promise<void> {}
}
