import type { Socket } from 'bun'
import { plainText, splitBytes } from './format.ts'
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
 * IRC over a TCP (or TLS) socket with no library, ported from OpenClaw's and Hermes's IRC adapters: RFC 1459 lines,
 * PING/PONG, the 001 welcome, joining channels, nick collisions (`nick_`), a password by SASL PLAIN when the server
 * offers it (else as a server password), direct messages as DMs and channel messages as groups that answer only
 * when addressed (`nick: …`), lines cut to the byte limit, flood control, and reconnecting with backoff.
 */

const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30_000
/** Registration (welcome) must finish within this. */
const REGISTER_MS = 30_000
/** How long to wait for the server's capability list before sending the password as a server password. */
const CAP_WAIT_MS = 5000
/** Quiet this long, we PING; quiet this long, the connection is taken for dead. */
const IDLE_PING_MS = 120_000
const IDLE_DEAD_MS = 300_000
/** Lines in a burst, then one a second (Hermes paces 0.3 s a line; networks kill clients for "Excess Flood"). */
const FLOOD_BURST = 4
const FLOOD_MS = 1000
/** A message line's text at most, in bytes (a line is 512 with the prefix the server adds when relaying it). */
const LINE_BYTES = 400
/** `user@host` before the server shows ours: a long ident and host, so relayed lines never overflow. */
const SELF_PREFIX_GUESS = 75
/** A line from the server longer than this (an IRCv3 maximum with tags, doubled) ends the connection. */
const MAX_INBOUND_LINE = 16 * 1024
const MAX_NICK_FALLBACKS = 3

/** A parsed line: its IRCv3 tags, the prefix, the command, and its parameters (the trailing one last). */
export interface IrcLine {
  readonly tags: Readonly<Record<string, string>>
  readonly prefix?: string
  readonly command: string
  readonly params: readonly string[]
}

const TAG_ESCAPES: Record<string, string> = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' }

/** Parses one line (without its CRLF); undefined for a malformed one. */
export function parseIrcLine(raw: string): IrcLine | undefined {
  let rest = raw.replace(/[\r\n]+$/, '')
  const tags: Record<string, string> = {}
  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ')
    if (space < 0) return undefined
    for (const pair of rest.slice(1, space).split(';')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      tags[eq < 0 ? pair : pair.slice(0, eq)] =
        eq < 0 ? '' : pair.slice(eq + 1).replace(/\\(.?)/g, (_m, c: string) => TAG_ESCAPES[c] ?? c)
    }
    rest = rest.slice(space + 1).trimStart()
  }
  let prefix: string | undefined
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ')
    if (space <= 1) return undefined
    prefix = rest.slice(1, space)
    rest = rest.slice(space + 1).trimStart()
  }
  let command = ''
  const params: string[] = []
  while (rest) {
    if (command && rest.startsWith(':')) {
      params.push(rest.slice(1))
      break
    }
    const space = rest.indexOf(' ')
    const word = space < 0 ? rest : rest.slice(0, space)
    if (command) params.push(word)
    else command = word.toUpperCase()
    rest = space < 0 ? '' : rest.slice(space + 1).replace(/^ +/, '')
  }
  if (!command) return undefined
  return { tags, ...(prefix ? { prefix } : {}), command, params }
}

/** `nick!user@host` in its parts. */
export function parsePrefix(prefix = '') {
  const m = /^([^!@]+)(?:!([^@]+))?(?:@(.+))?$/.exec(prefix)
  return { nick: m?.[1] ?? prefix, user: m?.[2], host: m?.[3] }
}

const isControl = (code: number) => code < 32 || code === 127
const CTCP = String.fromCharCode(1)
const COLOUR = 3

/** Inbound text without mIRC colours and formatting (bold, italics, reverse…) or any other control character. */
function cleanInbound(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === COLOUR) {
      i += /^(?:\d{1,2}(?:,\d{1,2})?)?/.exec(text.slice(i + 1))?.[0].length ?? 0
      continue
    }
    if (!isControl(code)) out += text[i]
  }
  return out
}

/** Outbound text with nothing that could end the line early or inject a command (CR, LF, NUL…). */
function withoutControls(text: string): string {
  let out = ''
  for (const char of text.replace(/\t/g, '  ')) if (!isControl(char.charCodeAt(0))) out += char
  return out
}

/** A channel or nick to send to: one word, no control characters. */
export function ircTarget(raw: string): string {
  if (!raw || /[\s,]/.test(raw) || [...raw].some((c) => isControl(c.charCodeAt(0))) || raw.startsWith(':'))
    throw new Error(`not an IRC channel or nick: ${raw}`)
  return raw
}

/** IRC compares nicks with `[]\~` equal to `{}|^` (RFC 1459 case mapping). */
const casefold = (s: string) =>
  s.toLowerCase().replace(/[[\]\\~]/g, (c) => ({ '[': '{', ']': '}', '\\': '|', '~': '^' })[c] ?? c)

const NICK_CHAR = String.raw`[A-Za-z0-9_\-[\]\\\x60^{}|~]`
const EQUIVALENT: Record<string, string> = {
  '[': '{',
  '{': '[',
  ']': '}',
  '}': ']',
  '\\': '|',
  '|': '\\',
  '^': '~',
  '~': '^',
}
const escapeRegex = (c: string) => c.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
const nickPattern = (nick: string) =>
  [...nick]
    .map((c) => (EQUIVALENT[c] ? `[${escapeRegex(c)}${escapeRegex(EQUIVALENT[c])}]` : escapeRegex(c)))
    .join('')

/**
 * Whether a channel line addresses the bot (`nick: …`, `nick, …`, or the nick anywhere as a word, as OpenClaw
 * matches it), and the text without it.
 */
export function addressed(text: string, nick: string): { mentioned: boolean; text: string } {
  const word = `(?<!${NICK_CHAR})@?${nickPattern(nick)}(?!${NICK_CHAR})[:,]?`
  if (!new RegExp(word, 'i').test(text)) return { mentioned: false, text }
  return {
    mentioned: true,
    text: text
      .replace(new RegExp(word, 'gi'), ' ')
      .replace(/\s{2,}/g, ' ')
      .trim(),
  }
}

/**
 * `!approve KEY` as `/approve KEY`: IRC and Twitch clients take a leading `/` as their own command, so the channel
 * commands are typed with `!` there (only those, so other `!` lines stay text).
 */
export const bangCommands = (text: string) =>
  text.replace(/^!(?=(?:new|stop|status|help|start|approve|deny)\b)/i, '/')

/** The settings, checked. */
export interface IrcSettings {
  readonly host: string
  readonly port: number
  readonly tls: boolean
  readonly nick: string
  readonly password?: string
  readonly channels: readonly string[]
}

const NICK = /^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]{0,29}$/

export function ircSettings(values: ChannelValues): IrcSettings {
  const host = (values.server ?? '').trim().replace(/^ircs?:\/\//i, '')
  if (!host || /[\s/]/.test(host)) throw new Error('IRC needs a server address, e.g. irc.libera.chat')
  const tlsValue = (values.tls ?? '').trim().toLowerCase()
  if (tlsValue && !/^(on|off|yes|no|true|false|1|0)$/.test(tlsValue)) throw new Error('TLS is "on" or "off"')
  const tls = !/^(off|no|false|0)$/.test(tlsValue)
  const port = values.port?.trim() ? Number(values.port.trim()) : tls ? 6697 : 6667
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('the IRC port is a number, e.g. 6697')
  const nick = (values.nick ?? '').trim()
  if (!NICK.test(nick))
    throw new Error(
      'an IRC nick is up to 30 letters, digits and - _ [ ] { } \\ ` ^ |, not starting with a digit',
    )
  const channels = (values.channels ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((c) => ircTarget(/^[#&+!]/.test(c) ? c : `#${c}`))
  const password = values.password?.trim()
  return { host, port, tls, nick, ...(password ? { password } : {}), channels }
}

/** The server refused us for a reason a retry will not fix (the password, the nick, a ban). */
class IrcRefused extends Error {}

/** One connection: registration (SASL or PASS, nick collisions), PING, joining, and writing lines. */
class IrcConnection {
  nick: string
  /** Our own `user@host` once the server shows it, for the length of the lines it relays. */
  selfPrefix?: string
  readonly ready: Promise<void>
  /** Resolves when the connection ends, with why when it was not asked to. */
  readonly closed: Promise<Error | undefined>
  private _socket?: Socket<undefined>
  private _out: Uint8Array[] = []
  private _in: Buffer = Buffer.alloc(0)
  private _registered = false
  private _ended = false
  private _capsAnswered = false
  private _capsDone = false
  private _caps: string[] = []
  private _fallbacks = 0
  private _lastSeen = Date.now()
  private _serverError?: string
  private _timers: ReturnType<typeof setTimeout>[] = []
  private _keepalive?: ReturnType<typeof setInterval>
  private _settle!: { resolve: () => void; reject: (err: Error) => void }
  private _finish!: (err: Error | undefined) => void

  constructor(
    private readonly s: IrcSettings,
    private readonly onLine: (line: IrcLine) => void,
  ) {
    this.nick = s.nick
    this.ready = new Promise((resolve, reject) => {
      this._settle = { resolve, reject }
    })
    // Rejections are read through `ready`; this keeps one nobody awaits from being reported.
    this.ready.catch(() => {})
    this.closed = new Promise((resolve) => {
      this._finish = resolve
    })
  }

  get isReady() {
    return this._registered && !this._ended
  }

  async open(): Promise<void> {
    try {
      await Bun.connect({
        hostname: this.s.host,
        port: this.s.port,
        tls: this.s.tls,
        socket: {
          open: (socket) => {
            // Stopped while connecting.
            if (this._ended) return void socket.end()
            this._socket = socket
            this._begin()
          },
          data: (_socket, data) => this._data(data),
          drain: () => this._flush(),
          close: (_socket, err) => this._gone(err),
          error: (_socket, err) => this._gone(err),
          end: () => this._gone(),
          connectError: () => {},
        },
      })
    } catch (err) {
      const error = new Error(
        `cannot reach ${this.s.host}:${this.s.port}${err instanceof Error && err.message ? `: ${err.message}` : ''}`,
      )
      this._end(error)
      throw error
    }
    this._timers.push(
      setTimeout(() => this._fail(new Error('the IRC server did not welcome us in time')), REGISTER_MS),
    )
    this._keepalive = setInterval(() => {
      const idle = Date.now() - this._lastSeen
      if (idle > IDLE_DEAD_MS) this._fail(new Error('the IRC server stopped answering'))
      else if (idle > IDLE_PING_MS) this._write('PING :myrmidon')
    }, IDLE_PING_MS / 4)
  }

  /** Sends a line now (flood control is the sender's). */
  write(line: string) {
    if (this._ended || !this._socket) throw new Error('not connected to the IRC server')
    this._write(line)
  }

  quit() {
    if (this._ended) return
    try {
      this._write('QUIT :bye')
    } catch {}
    this._end()
  }

  close(err?: Error) {
    this._end(err)
  }

  private _write(line: string) {
    if (this._ended || !this._socket) return
    this._out.push(Buffer.from(`${line}\r\n`))
    this._flush()
  }

  private _flush() {
    while (this._socket && this._out.length) {
      const chunk = this._out[0] as Uint8Array
      const written = this._socket.write(chunk)
      if (written < chunk.byteLength) {
        // The rest goes when the socket drains.
        this._out[0] = chunk.subarray(Math.max(0, written))
        return
      }
      this._out.shift()
    }
  }

  private _end(err?: Error) {
    if (this._ended) return
    this._ended = true
    for (const timer of this._timers) clearTimeout(timer)
    clearInterval(this._keepalive)
    const reason = err ?? (this._serverError ? new Error(this._serverError) : undefined)
    if (!this._registered) this._settle.reject(reason ?? new Error('the IRC server closed the connection'))
    this._finish(reason)
    try {
      this._flush()
      this._socket?.end()
    } catch {}
  }

  /** The socket itself reported it ended: nothing more is written to it, and it is not ended a second time. */
  private _gone(err?: Error) {
    this._socket = undefined
    this._end(err)
  }

  private _fail(err: Error) {
    this._end(err)
  }

  private _data(chunk: Buffer) {
    this._lastSeen = Date.now()
    this._in = Buffer.concat([this._in, chunk])
    for (;;) {
      const nl = this._in.indexOf(10)
      if (nl < 0) break
      if (nl > MAX_INBOUND_LINE) return this._fail(new Error('the IRC server sent an overlong line'))
      const raw = this._in.subarray(0, nl).toString('utf8').replace(/\r$/, '')
      this._in = this._in.subarray(nl + 1)
      if (raw) this._line(raw)
      if (this._ended) return
    }
    if (this._in.length > MAX_INBOUND_LINE) this._fail(new Error('the IRC server sent an overlong line'))
  }

  /** With a password, capabilities first (for SASL); otherwise straight to registering. */
  private _begin() {
    if (!this.s.password) return this._register()
    this._write('CAP LS 302')
    this._timers.push(setTimeout(() => this._withoutSasl(), CAP_WAIT_MS))
  }

  private _register() {
    this._write(`NICK ${this.nick}`)
    this._write(`USER ${this.s.nick.replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'myrmidon'} 0 * :Myrmidon`)
  }

  /** No SASL on offer: the password goes as a server password, which must come before NICK. */
  private _withoutSasl() {
    if (this._capsDone || this._ended) return
    this._capsDone = true
    const password = this.s.password ?? ''
    if (password)
      this._write(
        password.includes(' ') || password.startsWith(':') ? `PASS :${password}` : `PASS ${password}`,
      )
    this._register()
    if (this._capsAnswered) this._write('CAP END')
  }

  private _cap(params: readonly string[]) {
    const sub = params[1]?.toUpperCase()
    if (sub === 'LS' && !this._capsDone) {
      this._capsAnswered = true
      this._caps.push(...(params.at(-1) ?? '').split(' ').filter(Boolean))
      // `CAP * LS * :…` says more lines follow.
      if (params.length > 3 && params[2] === '*') return
      const sasl = this._caps.find((c) => c === 'sasl' || c.startsWith('sasl='))
      const mechanisms = sasl?.split('=')[1]
      if (!sasl || (mechanisms && !mechanisms.split(',').includes('PLAIN'))) return this._withoutSasl()
      this._capsDone = true
      this._register()
      this._write('CAP REQ :sasl')
    } else if (sub === 'ACK' && /(^|\s)sasl(\s|$)/.test(params.at(-1) ?? ''))
      this._write('AUTHENTICATE PLAIN')
    else if (sub === 'NAK') this._fail(new IrcRefused('the IRC server would not take the password by SASL'))
  }

  /** SASL PLAIN: the account (the nick) and password, base64, in pieces of 400. */
  private _authenticate() {
    const encoded = Buffer.from(`${this.s.nick}\0${this.s.nick}\0${this.s.password ?? ''}`).toString('base64')
    for (let i = 0; i < encoded.length; i += 400) this._write(`AUTHENTICATE ${encoded.slice(i, i + 400)}`)
    if (encoded.length % 400 === 0) this._write('AUTHENTICATE +')
  }

  /** The nick is taken: `nick_`, then `nick__`… (Hermes and OpenClaw both fall back with underscores). */
  private _collision() {
    this._fallbacks += 1
    if (this._fallbacks > MAX_NICK_FALLBACKS)
      return this._fail(new Error(`the nick ${this.s.nick} is taken (and ${this.nick} too)`))
    this.nick = `${this.s.nick.slice(0, 30 - this._fallbacks)}${'_'.repeat(this._fallbacks)}`
    this._write(`NICK ${this.nick}`)
  }

  private _line(raw: string) {
    const line = parseIrcLine(raw)
    if (!line) return
    const p = line.params
    const trailing = p.at(-1) ?? ''
    switch (line.command) {
      case 'PING':
        return this._write(`PONG :${trailing}`)
      case 'CAP':
        return this._cap(p)
      case 'AUTHENTICATE':
        if (p[0] === '+') this._authenticate()
        return
      case '903':
        return this._write('CAP END')
      case '902':
      case '904':
      case '905':
      case '906':
        return this._fail(
          new IrcRefused('the IRC server refused the password (SASL); check the nick and password'),
        )
      case '421':
        if (p[1]?.toUpperCase() === 'CAP') this._withoutSasl()
        return
      case '432':
        if (!this._registered)
          this._fail(new IrcRefused(`the IRC server refused the nick ${this.nick}: ${trailing}`))
        return
      case '433':
      case '436':
        if (!this._registered) this._collision()
        return
      case '464':
        return this._fail(new IrcRefused('the IRC server refused the password'))
      case '465':
        return this._fail(new IrcRefused(`banned from ${this.s.host}: ${trailing}`))
      case 'ERROR':
        this._serverError = `the IRC server closed the connection: ${trailing}`
        return
      case '001':
        this._registered = true
        this.nick = p[0] || this.nick
        for (const channel of this.s.channels) this._write(`JOIN ${channel}`)
        this._settle.resolve()
        break
      case 'NICK': {
        const from = parsePrefix(line.prefix)
        if (casefold(from.nick) === casefold(this.nick)) this.nick = trailing || this.nick
        return
      }
      case 'JOIN': {
        const from = parsePrefix(line.prefix)
        if (casefold(from.nick) === casefold(this.nick) && from.user && from.host)
          this.selfPrefix = `${from.user}@${from.host}`
        break
      }
    }
    this.onLine(line)
  }
}

export class IrcAdapter implements ChannelAdapter {
  readonly id = 'irc'
  readonly label = 'IRC'
  /** The hub's pieces, each then cut into lines of at most 400 bytes; IRC has no edits, files or buttons. */
  readonly limits = { text: 2000, editMs: 1500 }
  readonly can = { buttons: false, files: false, edit: false }
  /** The app keeps `/` for its own commands, so the hub's are typed with `!` (turned into `/` on the way in). */
  readonly commandPrefix = '!'
  private _conn?: IrcConnection
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  private readonly _pacer: Pacer
  private _seq = 0

  constructor(
    private readonly values: ChannelValues,
    pacing: { readonly burst: number; readonly everyMs: number } = { burst: FLOOD_BURST, everyMs: FLOOD_MS },
  ) {
    this._pacer = new Pacer(pacing.burst, pacing.everyMs)
  }

  /** Connects, registers (with the password, if any) and leaves; says which nick on which server. */
  async check(): Promise<string> {
    const s = ircSettings(this.values)
    const conn = new IrcConnection({ ...s, channels: [] }, () => {})
    try {
      await conn.open()
      await conn.ready
      return `${conn.nick} on ${s.host}`
    } finally {
      conn.quit()
    }
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    let s: IrcSettings
    try {
      s = ircSettings(this.values)
    } catch (err) {
      return io.status({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    this._loop = (async () => {
      const backoff = new Backoff(BACKOFF_MIN_MS, BACKOFF_MAX_MS)
      while (!signal.aborted) {
        const conn = new IrcConnection(s, (line) => {
          void this._onLine(conn, line).catch((err) =>
            io.log(err instanceof Error ? err.message : String(err)),
          )
        })
        this._conn = conn
        try {
          await conn.open()
          await conn.ready
        } catch (err) {
          conn.close()
          if (signal.aborted) break
          const error = err instanceof Error ? err.message : String(err)
          if (err instanceof IrcRefused) return io.status({ state: 'error', error })
          io.status({ state: 'retrying', error })
          await sleep(backoff.next(), signal)
          continue
        }
        backoff.up()
        io.status({ state: 'on', account: `${conn.nick} on ${s.host}` })
        const err = await conn.closed
        if (signal.aborted) break
        io.status({ state: 'retrying', error: err?.message ?? 'the IRC server closed the connection' })
        await sleep(backoff.next(), signal)
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    this._conn?.quit()
    await this._loop?.catch(() => {})
  }

  private async _onLine(conn: IrcConnection, line: IrcLine) {
    if (line.command !== 'PRIVMSG') return
    const [target = '', body = ''] = line.params
    const from = parsePrefix(line.prefix)
    if (!from.nick || casefold(from.nick) === casefold(conn.nick)) return
    let raw = body
    if (raw.startsWith(CTCP)) {
      // `/me` arrives as CTCP ACTION; other CTCP requests (VERSION, PING…) are not messages.
      const ctcp = raw.slice(1, raw.endsWith(CTCP) ? -1 : undefined)
      if (!ctcp.startsWith('ACTION ')) return
      raw = `* ${from.nick} ${ctcp.slice(7)}`
    }
    const clean = cleanInbound(raw).trim()
    if (!clean) return
    const group = /^[#&+!]/.test(target)
    const { mentioned, text } = group ? addressed(clean, conn.nick) : { mentioned: true, text: clean }
    // The server vouches for user@host (not for an account), so the full mask is the person, not the nick alone.
    const id = (from.user && from.host ? `${from.nick}!${from.user}@${from.host}` : from.nick).toLowerCase()
    const chat: ChannelChat = group
      ? { id: target.toLowerCase(), kind: 'group', title: target }
      : { id: from.nick.toLowerCase(), kind: 'dm' }
    await this._io?.receive({
      messageId: line.tags.msgid ?? `${Date.now()}-${++this._seq}`,
      chat,
      // No handle: anyone can take any free nick, so only the full mask may match the allowlist.
      sender: { id, name: from.nick },
      text: bangCommands(text),
      mentioned,
      time: line.tags.time ?? new Date().toISOString(),
    })
  }

  /** As plain text, a line per line, each cut to the byte limit and paced out (flood control). */
  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const conn = this._conn
    if (!conn?.isReady) throw new Error('not connected to the IRC server')
    const target = ircTarget(chatIdOf(chat))
    const overhead = Buffer.byteLength(`:${conn.nick}! PRIVMSG ${target} :\r\n`)
    const room = Math.min(LINE_BYTES, 512 - overhead - (conn.selfPrefix?.length ?? SELF_PREFIX_GUESS))
    const lines = plainText(message.text)
      .split('\n')
      .flatMap((line) => splitBytes(withoutControls(line), room))
    for (const line of lines) {
      await this._pacer.take(this._abort?.signal)
      if (this._conn !== conn || !conn.isReady) throw new Error('the IRC connection dropped while sending')
      conn.write(`PRIVMSG ${target} :${line}`)
    }
    return { chat: target, id: `${Date.now()}-${++this._seq}` }
  }

  /** IRC cannot edit a sent line. */
  async edit(): Promise<void> {}

  /** IRC has no typing indicator. */
  async typing(): Promise<void> {}
}
