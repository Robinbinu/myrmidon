import { plainText, splitChars } from './format.ts'
import { bangCommands, type IrcLine, parseIrcLine, parsePrefix } from './irc.ts'
import { Backoff, Pacer, sleep } from './pace.ts'
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
 * Twitch chat over its IRC interface on a WebSocket (no library), ported from OpenClaw's Twitch plugin: the bot
 * account signs in with an OAuth token, joins the channels listed, and answers in a channel's chat only when
 * @mentioned or replied to (chat is public, so channels are groups). Whispers are not used: Twitch restricts them
 * for bots (Helix only, verified accounts, heavy limits). Messages are plain text up to 500 characters, paced under
 * Twitch's 20 messages per 30 seconds; the token is validated when connecting and hourly, as Twitch requires.
 */

export const TWITCH_IRC = 'wss://irc-ws.chat.twitch.tv:443'
export const TWITCH_ID = 'https://id.twitch.tv'
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 60_000
const REGISTER_MS = 15_000
/** Twitch asks apps to validate their token every hour, and to stop using one that no longer validates. */
const VALIDATE_EVERY_MS = 60 * 60_000
/** A bot that is not a moderator may send 20 messages per 30 seconds: 2 at once, then one per 1.7 s stays under. */
const FLOOD_BURST = 2
const FLOOD_MS = 1700
const MESSAGE_CHARS = 500
/** Chat scopes for IRC: reading and sending. */
const SCOPES = ['chat:read', 'chat:edit']
const REFUSED = 'Twitch refused this token; make a new one with the chat:read and chat:edit scopes'

/** Twitch refused the token or login: retrying will not help. */
class TwitchRefused extends Error {}

/** A token without its `oauth:` prefix (people paste both forms). */
const bare = (token: string) => token.trim().replace(/^oauth:/i, '')

const LOGIN = /^[a-z0-9_]{1,25}$/

export function twitchChannels(values: ChannelValues, login: string): string[] {
  const listed = (values.channels ?? '')
    .split(/[\s,]+/)
    .map((c) => c.replace(/^#/, '').toLowerCase())
    .filter(Boolean)
  for (const c of listed) if (!LOGIN.test(c)) throw new Error(`not a Twitch channel name: ${c}`)
  // With none listed, the bot's own channel.
  return (listed.length ? listed : [login]).map((c) => `#${c}`)
}

export class TwitchAdapter implements ChannelAdapter {
  readonly id = 'twitch'
  readonly label = 'Twitch'
  /** Twitch's message limit; no edits, files or buttons in chat. */
  readonly limits = { text: MESSAGE_CHARS, editMs: 1500 }
  readonly can = { buttons: false, files: false, edit: false }
  /** The app keeps `/` for its own commands, so the hub's are typed with `!` (turned into `/` on the way in). */
  readonly commandPrefix = '!'
  private _login?: string
  private _ws?: WebSocket
  private _ready = false
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  private readonly _pacer: Pacer
  /** The last message that mentioned the bot in each channel, so the answer shows as a reply to it. */
  private readonly _replyTo = new Map<string, string>()

  constructor(
    private readonly values: ChannelValues,
    private readonly endpoints: { readonly irc: string; readonly id: string } = {
      irc: TWITCH_IRC,
      id: TWITCH_ID,
    },
    pacing: { readonly burst: number; readonly everyMs: number } = { burst: FLOOD_BURST, everyMs: FLOOD_MS },
  ) {
    this._pacer = new Pacer(pacing.burst, pacing.everyMs)
  }

  /** Validates the token with Twitch; never logs or throws it. */
  async check(): Promise<string> {
    const token = bare(this.values.token ?? '')
    const username = (this.values.username ?? '').trim().replace(/^@/, '').toLowerCase()
    if (!LOGIN.test(username)) throw new Error("the bot's Twitch username is letters, digits and _")
    if (!token) throw new Error('Twitch needs an OAuth token')
    let res: Response
    try {
      res = await fetch(`${this.endpoints.id}/oauth2/validate`, {
        headers: { authorization: `OAuth ${token}` },
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      throw new Error(`cannot reach Twitch: ${err instanceof Error ? err.name : 'network error'}`)
    }
    if (res.status === 401) throw new TwitchRefused(REFUSED)
    if (!res.ok) throw new Error(`Twitch answered ${res.status} when validating the token`)
    const info = (await res.json().catch(() => ({}))) as { login?: string; scopes?: string[] }
    const login = info.login?.toLowerCase() ?? ''
    if (login !== username) throw new TwitchRefused(`this token is for @${login || '?'}, not @${username}`)
    const missing = SCOPES.filter((s) => !info.scopes?.includes(s))
    if (missing.length) throw new TwitchRefused(`the token lacks the ${missing.join(' and ')} scope`)
    twitchChannels(this.values, login)
    this._login = login
    return `@${login}`
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      const backoff = new Backoff(BACKOFF_MIN_MS, BACKOFF_MAX_MS)
      while (!signal.aborted) {
        let account: string
        let channels: string[]
        try {
          account = await this.check()
          channels = twitchChannels(this.values, this._login ?? '')
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          if (err instanceof TwitchRefused || !/cannot reach|answered (429|5)/.test(error))
            return io.status({ state: 'error', error })
          io.status({ state: 'retrying', error })
          await sleep(backoff.next(), signal)
          continue
        }
        const why = await this._connection(channels, signal, () => {
          backoff.up()
          io.status({ state: 'on', account })
        })
        if (signal.aborted) break
        if (why instanceof TwitchRefused) return io.status({ state: 'error', error: why.message })
        io.status({ state: 'retrying', error: why.message })
        await sleep(backoff.next(), signal)
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
  }

  /**
   * One connection: signs in, joins the channels (calling `up` once Twitch welcomes the bot), revalidates the
   * token hourly, and resolves with why it ended.
   */
  private _connection(channels: string[], signal: AbortSignal, up: () => void): Promise<Error> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.endpoints.irc)
      this._ws = ws
      this._ready = false
      let over = false
      const end = (why: Error) => {
        if (over) return
        over = true
        this._ready = false
        clearTimeout(timer)
        clearInterval(validate)
        signal.removeEventListener('abort', onAbort)
        ws.close()
        resolve(why)
      }
      const onAbort = () => end(new Error('stopped'))
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(
        () => end(new Error('Twitch chat did not welcome the bot in time')),
        REGISTER_MS,
      )
      const validate = setInterval(() => {
        void this.check().catch((err) => {
          if (err instanceof TwitchRefused) end(err)
        })
      }, VALIDATE_EVERY_MS)
      ws.addEventListener('open', () => {
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands')
        ws.send(`PASS oauth:${bare(this.values.token ?? '')}`)
        ws.send(`NICK ${this._login}`)
      })
      ws.addEventListener('message', (event) => {
        for (const raw of String(event.data).split('\r\n')) {
          const line = raw ? parseIrcLine(raw) : undefined
          if (!line) continue
          if (line.command === 'PING') ws.send(`PONG :${line.params.at(-1) ?? ''}`)
          else if (line.command === '001') {
            clearTimeout(timer)
            this._ready = true
            for (const channel of channels) ws.send(`JOIN ${channel}`)
            up()
          } else if (line.command === 'NOTICE' && line.params[0] === '*' && !this._ready)
            // Sign-in refused: "Login authentication failed", "Improperly formatted auth".
            end(new TwitchRefused(`${REFUSED} (${line.params.at(-1) ?? ''})`))
          // Twitch is restarting this server: connect again.
          else if (line.command === 'RECONNECT') end(new Error('Twitch asked the bot to reconnect'))
          else void this._onLine(line).catch((err) => this._io?.log(String(err)))
        }
      })
      ws.addEventListener('close', (event) =>
        end(new Error(`Twitch closed the chat connection (${event.code})`)),
      )
      ws.addEventListener('error', () => end(new Error('the Twitch chat connection failed')))
    })
  }

  private async _onLine(line: IrcLine) {
    if (line.command === 'NOTICE') {
      // Refusals of what the bot sent (msg_ratelimit, msg_duplicate, msg_banned…), for the log.
      const reason = line.tags['msg-id']
      if (reason) this._io?.log(`${line.params[0] ?? ''}: ${reason}: ${line.params.at(-1) ?? ''}`)
      return
    }
    if (line.command !== 'PRIVMSG') return
    const [channel = '', raw = ''] = line.params
    const login = this._login ?? ''
    const from = parsePrefix(line.prefix)
    const author = (line.tags.login ?? from.nick).toLowerCase()
    if (!author || author === login) return
    const tag = new RegExp(`(?<![\\w@])@${login}\\b[:,]?`, 'gi')
    const repliedTo = line.tags['reply-parent-user-login']?.toLowerCase() === login
    const mentioned = repliedTo || new RegExp(tag.source, 'i').test(raw)
    const text = bangCommands(
      raw
        .replace(tag, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    const chat: ChannelChat = { id: channel.toLowerCase(), kind: 'group', title: channel }
    const id = line.tags.id ?? `${Date.now()}-${author}`
    if (mentioned && line.tags.id) this._replyTo.set(chat.id, line.tags.id)
    const sent = Number(line.tags['tmi-sent-ts'])
    await this._io?.receive({
      messageId: id,
      chat,
      sender: {
        // Twitch's numeric user id is stable; a login can be renamed and reused.
        id: line.tags['user-id'] || author,
        name: line.tags['display-name'] || author,
        handle: author,
      },
      text,
      mentioned,
      time: Number.isFinite(sent) && sent > 0 ? new Date(sent).toISOString() : new Date().toISOString(),
    })
  }

  /** Plain text on one line, in pieces of 500 characters, paced under Twitch's limit. */
  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const channel = chatIdOf(chat).toLowerCase()
    if (!/^#[a-z0-9_]{1,25}$/.test(channel)) throw new Error(`not a Twitch channel: ${channel}`)
    const text = plainText(message.text)
      .replace(/\s*\n\s*/g, ' ')
      .split('')
      .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
      .join('')
    const parent = this._replyTo.get(channel)
    for (const piece of splitChars(text, MESSAGE_CHARS)) {
      await this._pacer.take(this._abort?.signal)
      const ws = this._ws
      if (!ws || !this._ready || ws.readyState !== WebSocket.OPEN)
        throw new Error('not connected to Twitch chat')
      ws.send(`${parent ? `@reply-parent-msg-id=${parent} ` : ''}PRIVMSG ${channel} :${piece}`)
    }
    return { chat: channel, id: `${Date.now()}` }
  }

  /** Twitch chat cannot edit a message. */
  async edit(): Promise<void> {}

  /** Twitch has no typing indicator. */
  async typing(): Promise<void> {}
}
