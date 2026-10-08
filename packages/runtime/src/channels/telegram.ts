import { channelCopy } from './copy.ts'
import { telegramHtml } from './format.ts'
import type { AdapterIO, ChannelAdapter, Inbound, OutMessage, SentRef } from './types.ts'

/**
 * Telegram through its Bot API over plain HTTP (no library): long polling, so nothing on this machine needs to be
 * reachable from the internet. As Hermes and OpenClaw do: the polling offset is saved only after a message is
 * recorded, a 409 means another program polls the same bot, and `retry_after` is honoured.
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
interface TgMessage {
  message_id: number
  date: number
  from?: TgUser
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string }
  text?: string
  caption?: string
  entities?: { type: string; offset: number; length: number }[]
  caption_entities?: { type: string; offset: number; length: number }[]
  reply_to_message?: { from?: TgUser }
  photo?: unknown
  voice?: unknown
  audio?: unknown
  video?: unknown
  document?: unknown
  sticker?: unknown
}
interface TgUpdate {
  update_id: number
  message?: TgMessage
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

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram'
  readonly label = 'Telegram'
  /** Telegram's message limit, and about one edit a second per chat. */
  readonly limits = { text: 4096, editMs: 1500 }
  private _me?: { id: number; username: string }
  private _abort?: AbortController
  private _loop?: Promise<void>

  constructor(
    private readonly token: string,
    private readonly api = TELEGRAM_API,
  ) {}

  /** Never logs or throws the URL: it carries the token. */
  private async _call<T>(
    method: string,
    body: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.api}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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
      io.status({ state: 'on', account: `@${this._me?.username}` })
      let offset = Number(io.get('offset') ?? 0)
      backoff = BACKOFF_MIN_MS
      while (!signal.aborted) {
        try {
          const updates = await this._call<TgUpdate[]>(
            'getUpdates',
            { offset, timeout: POLL_S, allowed_updates: ['message'] },
            AbortSignal.any([signal, AbortSignal.timeout((POLL_S + 15) * 1000)]),
          )
          if (backoff !== BACKOFF_MIN_MS) io.status({ state: 'on', account: `@${this._me?.username}` })
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

  /** A Telegram update as the hub's message; undefined for what channels ignore (bots, channels, edits). */
  private _inbound(update: TgUpdate): Inbound | undefined {
    const msg = update.message
    if (!msg?.from || msg.from.is_bot) return undefined
    const kind = msg.chat.type === 'private' ? 'dm' : msg.chat.type === 'channel' ? undefined : 'group'
    if (!kind) return undefined
    const raw = msg.text ?? msg.caption ?? ''
    const username = this._me?.username.toLowerCase() ?? ''
    const entities = msg.entities ?? msg.caption_entities ?? []
    const command = /^\/[a-z_]+(?:@(\w+))?/i.exec(raw)
    const mentioned =
      kind === 'dm' ||
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
    return {
      messageId: String(msg.message_id),
      chat: { id: String(msg.chat.id), kind, ...(msg.chat.title ? { title: msg.chat.title } : {}) },
      sender: {
        id: String(msg.from.id),
        name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Someone',
        ...(msg.from.username ? { handle: msg.from.username } : {}),
      },
      text,
      mentioned,
      ...(!msg.text && (msg.photo || msg.voice || msg.audio || msg.video || msg.document || msg.sticker)
        ? { unsupported: true }
        : {}),
      time: new Date(msg.date * 1000).toISOString(),
    }
  }

  /** Sends as HTML, waiting out a short `retry_after` once; plain text when Telegram cannot parse the HTML. */
  private async _send<T>(method: string, body: Record<string, unknown>, message: OutMessage): Promise<T> {
    const html = { ...body, text: telegramHtml(message.text), parse_mode: 'HTML' }
    try {
      return await this._call<T>(method, html)
    } catch (err) {
      if (!(err instanceof TelegramError)) throw err
      if (err.retryAfter && err.retryAfter <= RETRY_MAX_S) {
        await sleep(err.retryAfter * 1000)
        return this._call<T>(method, html)
      }
      if (err.code === 400 && /parse entities|can't find end/i.test(err.message))
        return this._call<T>(method, { ...body, text: message.text })
      throw err
    }
  }

  async send(chat: string, message: OutMessage): Promise<SentRef> {
    const sent = await this._send<{ message_id: number }>(
      'sendMessage',
      { chat_id: chat, link_preview_options: { is_disabled: true } },
      message,
    )
    return { chat, id: String(sent.message_id) }
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

  async typing(chat: string): Promise<void> {
    await this._call('sendChatAction', { chat_id: chat, action: 'typing' })
  }
}
