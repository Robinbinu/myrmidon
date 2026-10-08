import { randomBytes, timingSafeEqual } from 'node:crypto'
import { channelCopy } from './copy.ts'
import { telegramHtml } from './format.ts'
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
  type SentRef,
  threadOf,
} from './types.ts'

/**
 * Telegram through its Bot API over plain HTTP (no library), ported from OpenClaw's and Hermes's adapters: long
 * polling by default (nothing on this machine needs to be reachable), or a webhook with a secret header when the
 * gateway has a public address; the polling offset saved only after a message is recorded; 409 and `retry_after`
 * handled; inline buttons and their presses; photos, files and voice notes in and out; forum topics as threads.
 */

export const TELEGRAM_API = 'https://api.telegram.org'
/** How long one getUpdates call waits for messages. */
const POLL_S = 30
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
/** After a 409, wait this long before polling again; the other poller may stop. */
const CONFLICT_WAIT_MS = 10_000
/** A `retry_after` longer than this fails the send rather than holding the chat up. */
const RETRY_MAX_S = 30
/** Bots may download files up to 20 MB and upload up to 50 MB; photos up to 10 MB. */
const DOWNLOAD_MAX = 20 * 1024 * 1024
const PHOTO_MAX = 10 * 1024 * 1024
const UPDATES = ['message', 'callback_query']

class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}

interface TgUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
}
interface TgFile {
  file_id: string
  file_size?: number
  file_name?: string
  mime_type?: string
}
interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  is_forum?: boolean
}
interface TgMessage {
  message_id: number
  date: number
  from?: TgUser
  chat: TgChat
  message_thread_id?: number
  is_topic_message?: boolean
  text?: string
  caption?: string
  entities?: { type: string; offset: number; length: number }[]
  caption_entities?: { type: string; offset: number; length: number }[]
  reply_to_message?: { from?: TgUser }
  photo?: TgFile[]
  voice?: TgFile
  audio?: TgFile
  video?: TgFile
  document?: TgFile
  sticker?: unknown
  location?: unknown
}
interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage }
}

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

const senderOf = (u: TgUser) => ({
  id: String(u.id),
  name: [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Someone',
  ...(u.username ? { handle: u.username } : {}),
})

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram'
  readonly label = 'Telegram'
  /** Telegram's message limit, about one edit a second per chat, and the upload limit. */
  readonly limits = { text: 4096, editMs: 1500, file: 50 * 1024 * 1024 }
  readonly can = { buttons: true, files: true, edit: true }
  private _me?: { id: number; username: string }
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _io?: AdapterIO
  private _secret?: string

  constructor(
    private readonly token: string,
    private readonly api = TELEGRAM_API,
  ) {}

  /** Never logs or throws the URL: it carries the token. */
  private async _call<T>(
    method: string,
    body: Record<string, unknown> | FormData = {},
    signal?: AbortSignal,
  ): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.api}/bot${this.token}/${method}`, {
        method: 'POST',
        ...(body instanceof FormData
          ? { body }
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw new TelegramError(
        0,
        `cannot reach Telegram: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      result?: T
      error_code?: number
      description?: string
      parameters?: { retry_after?: number }
    }
    if (!data.ok)
      throw new TelegramError(
        data.error_code ?? res.status,
        data.description ?? `Telegram answered ${res.status}`,
        data.parameters?.retry_after,
      )
    return data.result as T
  }

  async check(): Promise<string> {
    try {
      const me = await this._call<TgUser>('getMe')
      this._me = { id: me.id, username: me.username ?? '' }
      return `@${me.username}`
    } catch (err) {
      if (err instanceof TelegramError && (err.code === 401 || err.code === 404))
        throw new Error('Telegram refused this token; copy it again from @BotFather')
      throw err
    }
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      // Who the bot is, before anything else: mentions in groups are recognized by its username.
      while (!signal.aborted && !this._me) {
        try {
          await this.check()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (/refused this token/.test(message)) return io.status({ state: 'error', error: message })
          io.status({ state: 'retrying', error: message })
          await sleep(backoff, signal)
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        }
      }
      if (signal.aborted) return
      await this._call('setMyCommands', { commands: channelCopy.commands.menu }).catch(() => {})
      const account = `@${this._me?.username}`
      if (io.webhookUrl) {
        // Telegram pushes updates, each carrying this secret, which the webhook checks.
        this._secret = io.get('webhook-secret') ?? randomBytes(24).toString('base64url')
        io.set('webhook-secret', this._secret)
        try {
          await this._call('setWebhook', {
            url: io.webhookUrl,
            secret_token: this._secret,
            allowed_updates: UPDATES,
          })
          io.status({ state: 'on', account })
        } catch (err) {
          io.status({ state: 'error', error: err instanceof Error ? err.message : String(err) })
        }
        return
      }
      // Polling only works with no webhook set (one left from a webhook setup would make every poll fail).
      await this._call('deleteWebhook', {}).catch(() => {})
      io.status({ state: 'on', account })
      let offset = Number(io.get('offset') ?? 0)
      backoff = BACKOFF_MIN_MS
      while (!signal.aborted) {
        try {
          const updates = await this._call<TgUpdate[]>(
            'getUpdates',
            { offset, timeout: POLL_S, allowed_updates: UPDATES },
            AbortSignal.any([signal, AbortSignal.timeout((POLL_S + 15) * 1000)]),
          )
          if (backoff !== BACKOFF_MIN_MS) io.status({ state: 'on', account })
          backoff = BACKOFF_MIN_MS
          for (const update of updates) {
            const message = this._inbound(update)
            if (message) await io.receive(message)
            // Saved only once the message is recorded, so a crash re-delivers rather than loses it.
            offset = update.update_id + 1
            io.set('offset', String(offset))
          }
        } catch (err) {
          if (signal.aborted) break
          if (err instanceof TelegramError && err.code === 401) {
            io.status({ state: 'error', error: 'Telegram refused this token; copy it again from @BotFather' })
            break
          }
          if (err instanceof TelegramError && err.code === 409) {
            io.status({
              state: 'retrying',
              error: 'another program is reading this bot (only one may); stop it or use another bot',
            })
            await sleep(CONFLICT_WAIT_MS, signal)
            continue
          }
          const wait = err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : backoff
          io.status({ state: 'retrying', error: err instanceof Error ? err.message : String(err) })
          // Jitter, so many gateways recovering together do not hit Telegram at the same moment.
          await sleep(wait * (0.75 + Math.random() * 0.5), signal)
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        }
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
  }

  /** An update Telegram pushed, accepted only with the secret it was given when the webhook was set. */
  async webhook(req: Request): Promise<Response> {
    const given = Buffer.from(req.headers.get('x-telegram-bot-api-secret-token') ?? '')
    const secret = Buffer.from(this._secret ?? '')
    if (!secret.length || given.length !== secret.length || !timingSafeEqual(given, secret))
      return new Response('unauthorized', { status: 401 })
    const update = (await req.json().catch(() => undefined)) as TgUpdate | undefined
    const message = update && this._inbound(update)
    if (message) await this._io?.receive(message)
    return new Response('ok')
  }

  private _chat(chat: TgChat, msg?: TgMessage): ChannelChat | undefined {
    const kind = chat.type === 'private' ? 'dm' : chat.type === 'channel' ? undefined : 'group'
    if (!kind) return undefined
    // A forum topic is a conversation of its own.
    const thread = msg?.is_topic_message && msg.message_thread_id ? String(msg.message_thread_id) : undefined
    return {
      id: String(chat.id),
      kind,
      ...(chat.title ? { title: chat.title } : {}),
      ...(thread ? { thread } : {}),
    }
  }

  private _file(kind: InboundFile['kind'], f: TgFile, fallback: string, mime: string): InboundFile {
    return {
      kind,
      name: f.file_name ?? fallback,
      mimeType: f.mime_type ?? mime,
      ...(f.file_size ? { size: f.file_size } : {}),
      read: async () => {
        if (f.file_size && f.file_size > DOWNLOAD_MAX)
          throw new Error('Telegram lets bots download up to 20 MB')
        const { file_path } = await this._call<{ file_path: string }>('getFile', { file_id: f.file_id })
        const res = await fetch(`${this.api}/file/bot${this.token}/${file_path}`)
        if (!res.ok) throw new Error(`Telegram answered ${res.status} for the file`)
        return new Uint8Array(await res.arrayBuffer())
      },
    }
  }

  /** A Telegram update as the hub's message; undefined for what channels ignore (bots, channel posts, edits). */
  private _inbound(update: TgUpdate): Inbound | undefined {
    const press = update.callback_query
    if (press?.message && !press.from.is_bot) {
      const chat = this._chat(press.message.chat, press.message)
      if (!chat) return undefined
      return {
        messageId: `press:${press.id}`,
        chat,
        sender: senderOf(press.from),
        text: '',
        mentioned: true,
        press: {
          id: press.id,
          data: press.data ?? '',
          message: { chat: chat.id, id: String(press.message.message_id) },
        },
        time: new Date().toISOString(),
      }
    }
    const msg = update.message
    if (!msg?.from || msg.from.is_bot) return undefined
    const chat = this._chat(msg.chat, msg)
    if (!chat) return undefined
    const raw = msg.text ?? msg.caption ?? ''
    const username = this._me?.username.toLowerCase() ?? ''
    const entities = msg.entities ?? msg.caption_entities ?? []
    const command = /^\/[a-z_]+(?:@(\w+))?/i.exec(raw)
    const mentioned =
      chat.kind === 'dm' ||
      msg.reply_to_message?.from?.id === this._me?.id ||
      entities.some(
        (e) =>
          e.type === 'mention' && raw.slice(e.offset, e.offset + e.length).toLowerCase() === `@${username}`,
      ) ||
      (command !== null && (!command[1] || command[1].toLowerCase() === username))
    const text = raw
      .replace(new RegExp(`@${username}\\b`, 'gi'), '')
      .replace(/^(\/[a-z_]+)@\w+/i, '$1')
      .trim()
    const files: InboundFile[] = []
    const largest = msg.photo?.at(-1)
    if (largest) files.push(this._file('image', largest, `photo-${msg.message_id}.jpg`, 'image/jpeg'))
    if (msg.voice) files.push(this._file('voice', msg.voice, `voice-${msg.message_id}.ogg`, 'audio/ogg'))
    if (msg.audio) files.push(this._file('audio', msg.audio, `audio-${msg.message_id}.mp3`, 'audio/mpeg'))
    if (msg.video) files.push(this._file('video', msg.video, `video-${msg.message_id}.mp4`, 'video/mp4'))
    if (msg.document)
      files.push(this._file('document', msg.document, `file-${msg.message_id}`, 'application/octet-stream'))
    return {
      messageId: String(msg.message_id),
      chat,
      sender: senderOf(msg.from),
      text,
      mentioned,
      ...(files.length ? { files } : {}),
      ...(!raw && !files.length && (msg.sticker || msg.location) ? { unsupported: true } : {}),
      time: new Date(msg.date * 1000).toISOString(),
    }
  }

  private _where(chat: ChannelChat | string) {
    const thread = threadOf(chat)
    return { chat_id: chatIdOf(chat), ...(thread ? { message_thread_id: Number(thread) } : {}) }
  }

  private _markup(message: OutMessage) {
    return message.buttons?.length
      ? {
          reply_markup: {
            inline_keyboard: message.buttons.map((row) =>
              row.map((b) => ({ text: b.label, callback_data: b.data })),
            ),
          },
        }
      : {}
  }

  /** Sends as HTML, waiting out a short `retry_after` once; plain text when Telegram cannot parse the HTML. */
  private async _send<T>(method: string, body: Record<string, unknown>, message: OutMessage): Promise<T> {
    const html = { ...body, ...this._markup(message), text: telegramHtml(message.text), parse_mode: 'HTML' }
    try {
      return await this._call<T>(method, html)
    } catch (err) {
      if (!(err instanceof TelegramError)) throw err
      if (err.retryAfter && err.retryAfter <= RETRY_MAX_S) {
        await sleep(err.retryAfter * 1000)
        return this._call<T>(method, html)
      }
      if (err.code === 400 && /parse entities|can't find end/i.test(err.message))
        return this._call<T>(method, { ...body, ...this._markup(message), text: message.text })
      throw err
    }
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const sent = await this._send<{ message_id: number }>(
      'sendMessage',
      { ...this._where(chat), link_preview_options: { is_disabled: true } },
      message,
    )
    return { chat: chatIdOf(chat), id: String(sent.message_id) }
  }

  async edit(ref: SentRef, message: OutMessage): Promise<void> {
    try {
      await this._send(
        'editMessageText',
        { chat_id: ref.chat, message_id: Number(ref.id), link_preview_options: { is_disabled: true } },
        message,
      )
    } catch (err) {
      // Editing to the same text is not a failure.
      if (!(err instanceof TelegramError && /not modified/i.test(err.message))) throw err
    }
  }

  async typing(chat: ChannelChat | string): Promise<void> {
    await this._call('sendChatAction', { ...this._where(chat), action: 'typing' })
  }

  /** Images small enough go as photos (shown inline); everything else as a document, uncompressed. */
  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const photo = /^image\/(png|jpeg|gif|webp)$/.test(file.mimeType) && file.data.byteLength <= PHOTO_MAX
    const form = new FormData()
    for (const [k, v] of Object.entries(this._where(chat))) form.set(k, String(v))
    if (file.caption) form.set('caption', file.caption)
    form.set(
      photo ? 'photo' : 'document',
      new Blob([new Uint8Array(file.data)], { type: file.mimeType }),
      file.name,
    )
    const sent = await this._call<{ message_id: number }>(photo ? 'sendPhoto' : 'sendDocument', form)
    return { chat: chatIdOf(chat), id: String(sent.message_id) }
  }

  async answerPress(press: ButtonPress, note?: string): Promise<void> {
    await this._call('answerCallbackQuery', { callback_query_id: press.id, ...(note ? { text: note } : {}) })
  }
}
