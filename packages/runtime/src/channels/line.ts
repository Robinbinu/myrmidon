import { createHmac, randomUUID } from 'node:crypto'
import { channelCopy } from './copy.ts'
import { plainText } from './format.ts'
import {
  clip,
  connectPushed,
  download,
  HOSTED_DAYS,
  hostFile,
  mimeOf,
  RefusedError,
  sameSecret,
  serveHosted,
} from './push.ts'
import {
  type AdapterIO,
  type ButtonPress,
  type ChannelAdapter,
  type ChannelChat,
  chatIdOf,
  type Inbound,
  type InboundFile,
  type OutFile,
  type OutMessage,
  type PressNote,
  type SentRef,
} from './types.ts'

/**
 * LINE through its Messaging API over plain HTTP (no SDK), ported from OpenClaw's and Hermes's adapters: LINE posts
 * events to the gateway signed with the channel secret (HMAC-SHA256, checked in constant time); replies use the
 * event's reply token while it is fresh (free) and the push API after (counted against the plan's monthly
 * messages). Buttons are quick replies whose presses come back as postbacks; LINE cannot edit a sent message, and
 * shows no formatting.
 */

export const LINE_API = 'https://api.line.me'
export const LINE_DATA_API = 'https://api-data.line.me'
/** A reply token works once, for about a minute; past this it goes by push instead. */
const REPLY_MS = 50_000
/** LINE's limits: 13 quick replies, labels of 20 characters, postback data of 300. */
const QUICK_MAX = 13
const LABEL_MAX = 20
const DATA_MAX = 300
/** How many of its own messages it remembers, to know a reply to one (a quote) is meant for it. */
const SENT_KEPT = 500
/** Lookups of a name or a group's title give up after this, rather than holding the webhook. */
const LOOKUP_MS = 3000
/** LINE's largest preview image; a JPEG or PNG up to this size is its own preview. */
const PREVIEW_MAX = 1024 * 1024

export class LineError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface LineSource {
  type?: 'user' | 'group' | 'room'
  userId?: string
  groupId?: string
  roomId?: string
}
interface LineMessage {
  id: string
  type: string
  text?: string
  fileName?: string
  fileSize?: number
  quotedMessageId?: string
  mention?: { mentionees?: { index: number; length: number; isSelf?: boolean }[] }
  contentProvider?: { type?: string; originalContentUrl?: string }
}
interface LineEvent {
  type?: string
  mode?: string
  timestamp?: number
  webhookEventId?: string
  replyToken?: string
  source?: LineSource
  message?: LineMessage
  postback?: { data?: string }
}

export interface LineOptions {
  readonly api?: string
  readonly dataApi?: string
}

export class LineAdapter implements ChannelAdapter {
  readonly id = 'line'
  readonly label = 'LINE'
  readonly limits = { text: 5000, editMs: 1000 }
  /** LINE takes no file's bytes from a bot, only HTTPS addresses to fetch it from, which the gateway serves. */
  readonly can = { buttons: true, files: true, edit: false }
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  private readonly _api: string
  private readonly _dataApi: string
  /** The newest unused reply token of each chat. */
  private readonly _replies = new Map<string, { token: string; at: number }>()
  /** The chat each button press came from, by its reply token. */
  private readonly _pressChats = new Map<string, string>()
  private readonly _sent = new Set<string>()
  private readonly _names = new Map<string, string>()
  private readonly _titles = new Map<string, string>()

  constructor(
    private readonly token: string,
    private readonly secret: string,
    options: LineOptions = {},
  ) {
    this._api = options.api ?? LINE_API
    this._dataApi = options.dataApi ?? LINE_DATA_API
  }

  /** Never logs the token. */
  private async _call<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this._api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      throw new LineError(0, `cannot reach LINE: ${err instanceof Error ? err.name : 'network error'}`)
    }
    const data = (await res.json().catch(() => ({}))) as T & { message?: string }
    if (res.status === 401)
      throw new RefusedError(
        'LINE refused this channel access token; issue a new one in the LINE Developers console',
      )
    if (!res.ok) throw new LineError(res.status, data.message ?? `LINE answered ${res.status}`)
    return data
  }

  async check(): Promise<string> {
    const bot = await this._call<{ displayName?: string; basicId?: string }>('GET', '/v2/bot/info')
    return [bot.displayName, bot.basicId && `(${bot.basicId})`].filter(Boolean).join(' ') || 'LINE bot'
  }

  /** Points the channel's webhook at this gateway (the console's "Use webhook" must be on). */
  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    this._loop = connectPushed(
      this.label,
      io,
      this._abort.signal,
      () => this.check(),
      async (endpoint) => {
        try {
          await this._call('PUT', '/v2/bot/channel/webhook/endpoint', { endpoint })
        } catch (err) {
          if (err instanceof LineError && err.status >= 400 && err.status < 500)
            throw new RefusedError(`LINE would not take the webhook address ${endpoint}: ${err.message}`)
          throw err
        }
      },
    )
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
  }

  /** Events LINE posted, taken only with a valid signature of the exact body. */
  async webhook(req: Request): Promise<Response> {
    const hosted = serveHosted(this._io, req)
    if (hosted) return hosted
    const body = await req.text()
    const expected = createHmac('sha256', this.secret).update(body).digest('base64')
    if (!this.secret || !sameSecret(req.headers.get('x-line-signature') ?? '', expected))
      return new Response('unauthorized', { status: 401 })
    let events: LineEvent[]
    try {
      events = ((JSON.parse(body) as { events?: LineEvent[] }).events ?? []).filter(
        (e) => e && typeof e === 'object',
      )
    } catch {
      return new Response('bad request', { status: 400 })
    }
    // LINE's "Verify" button posts no events; it only needs the 200.
    for (const event of events) {
      const message = await this._inbound(event)
      if (message) await this._io?.receive(message)
    }
    return new Response('ok')
  }

  private _chatId(source?: LineSource) {
    return source?.type === 'group'
      ? source.groupId
      : source?.type === 'room'
        ? source.roomId
        : source?.userId
  }

  /** A short lookup, its answer kept; undefined when it fails (a name is not worth holding a message for). */
  private async _lookup(cache: Map<string, string>, key: string, path: string, field: string) {
    const known = cache.get(key)
    if (known) return known
    try {
      const res = await fetch(`${this._api}${path}`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(LOOKUP_MS),
      })
      const value = res.ok ? ((await res.json()) as Record<string, unknown>)[field] : undefined
      if (typeof value !== 'string' || !value) return undefined
      cache.set(key, value)
      return value
    } catch {
      return undefined
    }
  }

  private async _chat(source: LineSource): Promise<ChannelChat | undefined> {
    const id = this._chatId(source)
    if (!id) return undefined
    if (source.type === 'user') return { id, kind: 'dm' }
    const title =
      source.type === 'group'
        ? await this._lookup(this._titles, id, `/v2/bot/group/${id}/summary`, 'groupName')
        : undefined
    return { id, kind: 'group', ...(title ? { title } : {}) }
  }

  private async _sender(source: LineSource) {
    const user = source.userId ?? ''
    const path =
      source.type === 'group'
        ? `/v2/bot/group/${source.groupId}/member/${user}`
        : source.type === 'room'
          ? `/v2/bot/room/${source.roomId}/member/${user}`
          : `/v2/bot/profile/${user}`
    const name = user ? await this._lookup(this._names, user, path, 'displayName') : undefined
    return { id: user, name: name ?? 'Someone' }
  }

  private _file(message: LineMessage, kind: InboundFile['kind'], name: string, mime: string): InboundFile {
    const external =
      message.contentProvider?.type === 'external' ? message.contentProvider.originalContentUrl : ''
    return {
      kind,
      name,
      mimeType: mime,
      ...(message.fileSize ? { size: message.fileSize } : {}),
      read: async () => {
        if (external) {
          if (!external.startsWith('https://')) throw new Error('LINE gave a file address that is not HTTPS')
          return download('LINE', await fetch(external, { signal: AbortSignal.timeout(60_000) }))
        }
        const res = await fetch(`${this._dataApi}/v2/bot/message/${message.id}/content`, {
          headers: { authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(60_000),
        })
        return download('LINE', res)
      },
    }
  }

  /** A LINE event as the hub's message; undefined for what channels ignore (follows, joins, standby, …). */
  private async _inbound(event: LineEvent): Promise<Inbound | undefined> {
    // In standby another module answers this channel; this one only listens.
    if (event.mode === 'standby' || !event.source?.userId) return undefined
    const chat = await this._chat(event.source)
    if (!chat) return undefined
    if (event.replyToken) this._replies.set(chat.id, { token: event.replyToken, at: Date.now() })
    const sender = await this._sender(event.source)
    const time = new Date(event.timestamp ?? Date.now()).toISOString()
    if (event.type === 'postback' && event.replyToken) {
      this._pressChats.set(event.replyToken, chat.id)
      // Presses the hub never acknowledges (a stranger's) are not kept forever.
      if (this._pressChats.size > SENT_KEPT)
        this._pressChats.delete(this._pressChats.keys().next().value ?? '')
      return {
        messageId: `press:${event.webhookEventId ?? event.replyToken}`,
        chat,
        sender,
        text: '',
        mentioned: true,
        press: { id: event.replyToken, data: event.postback?.data ?? '' },
        time,
      }
    }
    const message = event.message
    if (event.type !== 'message' || !message) return undefined
    // The bot's own @mentions are cut out, from the end so the earlier positions still hold.
    const own = (message.mention?.mentionees ?? []).filter((m) => m.isSelf).sort((a, b) => b.index - a.index)
    let text = message.text ?? ''
    for (const m of own) text = text.slice(0, m.index) + text.slice(m.index + m.length)
    const files: InboundFile[] = []
    if (message.type === 'image')
      files.push(this._file(message, 'image', `image-${message.id}.jpg`, 'image/jpeg'))
    if (message.type === 'video')
      files.push(this._file(message, 'video', `video-${message.id}.mp4`, 'video/mp4'))
    // LINE's audio messages are recordings made in the app: voice notes.
    if (message.type === 'audio')
      files.push(this._file(message, 'voice', `audio-${message.id}.m4a`, 'audio/x-m4a'))
    if (message.type === 'file') {
      const name = message.fileName ?? `file-${message.id}`
      files.push(this._file(message, 'document', name, mimeOf(name)))
    }
    const quoted = message.quotedMessageId !== undefined && this._sent.has(message.quotedMessageId)
    return {
      messageId: message.id,
      chat,
      sender,
      text: text.trim(),
      mentioned: chat.kind === 'dm' || own.length > 0 || quoted,
      ...(files.length ? { files } : {}),
      ...(message.type !== 'text' && !files.length ? { unsupported: true } : {}),
      time,
    }
  }

  private _message(message: OutMessage) {
    const buttons = message.buttons?.flat().slice(0, QUICK_MAX) ?? []
    return {
      type: 'text',
      text: plainText(message.text).slice(0, this.limits.text),
      ...(buttons.length
        ? {
            quickReply: {
              items: buttons.map((b) => ({
                type: 'action',
                action: {
                  type: 'postback',
                  label: clip(b.label, LABEL_MAX),
                  data: b.data.slice(0, DATA_MAX),
                  displayText: b.label,
                },
              })),
            },
          }
        : {}),
    }
  }

  private _remember(sent: { sentMessages?: { id?: string }[] }) {
    const id = sent.sentMessages?.[0]?.id
    if (!id) return ''
    this._sent.add(id)
    if (this._sent.size > SENT_KEPT) this._sent.delete(this._sent.values().next().value ?? '')
    return id
  }

  /** By the chat's fresh reply token when there is one (free), else by push (counted in the monthly quota). */
  private async _deliver(to: string, messages: unknown[], token?: string): Promise<string> {
    if (token) {
      try {
        return this._remember(
          await this._call('POST', '/v2/bot/message/reply', { replyToken: token, messages }),
        )
      } catch (err) {
        // A token already used or expired is refused with 400; the push still gets the message there.
        if (!(err instanceof LineError && err.status === 400)) throw err
      }
    }
    // The retry key makes LINE drop a push it already delivered (a timeout that did arrive).
    return this._remember(
      await this._call(
        'POST',
        '/v2/bot/message/push',
        { to, messages },
        { 'x-line-retry-key': randomUUID() },
      ),
    )
  }

  private _token(chat: string) {
    const reply = this._replies.get(chat)
    this._replies.delete(chat)
    return reply && Date.now() - reply.at < REPLY_MS ? reply.token : undefined
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const to = chatIdOf(chat)
    return { chat: to, id: await this._deliver(to, [this._message(message)], this._token(to)) }
  }

  async edit(): Promise<void> {
    throw new Error('LINE cannot edit a sent message')
  }

  /** LINE's loading animation, which exists only in one-to-one chats. */
  async typing(chat: ChannelChat | string): Promise<void> {
    const id = chatIdOf(chat)
    if (!id.startsWith('U')) return
    await this._call('POST', '/v2/bot/chat/loading/start', { chatId: id, loadingSeconds: 10 })
  }

  /**
   * A JPEG or PNG small enough to be its own preview is an image message; anything else is a link to download it.
   * LINE's video and audio messages also need a preview image or the length in milliseconds, which only decoding
   * the file would give.
   */
  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const url = hostFile(this._io, file)
    if (!url) throw new Error(channelCopy.noFileLink)
    const to = chatIdOf(chat)
    const image =
      (file.mimeType === 'image/jpeg' || file.mimeType === 'image/png') && file.data.byteLength <= PREVIEW_MAX
    const messages = [
      ...(file.caption ? [{ type: 'text', text: plainText(file.caption).slice(0, this.limits.text) }] : []),
      image
        ? { type: 'image', originalContentUrl: url, previewImageUrl: url }
        : { type: 'text', text: plainText(channelCopy.fileLink(file.name, url, HOSTED_DAYS)) },
    ]
    return { chat: to, id: await this._deliver(to, messages, this._token(to)) }
  }

  /** LINE shows nothing for a press itself, so the note is sent as a reply (by the press's own token if unused). */
  async answerPress(press: ButtonPress, note?: PressNote): Promise<void> {
    const chat = this._pressChats.get(press.id)
    this._pressChats.delete(press.id)
    // Notes arrive as messages here, so one that only repeats the pressed message is left out.
    if (!note || note.echo || !chat) return
    const unused = this._replies.get(chat)?.token === press.id ? this._token(chat) : undefined
    await this._deliver(chat, [{ type: 'text', text: note.text }], unused)
  }
}
