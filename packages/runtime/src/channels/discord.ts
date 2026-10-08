import { channelCopy } from './copy.ts'
import { discordMarkdown } from './format.ts'
import {
  type AdapterIO,
  type Button,
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
 * Discord through its Gateway (a WebSocket, JSON, v10) and REST API with no library, ported from OpenClaw's own
 * gateway client and Hermes's adapter: heartbeats with jitter and a check for a silent connection, RESUME after a
 * drop (a fresh IDENTIFY when the session is gone), close codes that cannot be fixed by reconnecting reported, 429s
 * and the global limit waited out; direct messages and server channels (a thread as `chat.thread`), mentions,
 * attachments, buttons (message components) and their presses (interactions). Nothing on this machine needs to be
 * reachable from the internet.
 */

export const DISCORD_API = 'https://discord.com/api/v10'
const DISCORD_GATEWAY = 'wss://gateway.discord.gg'
const USER_AGENT = 'DiscordBot (https://github.com/Robinbinu/myrmidon, 0.0.0)'
/** GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES and MESSAGE_CONTENT (privileged: switched on in the Developer Portal). */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 60_000
/** A `retry_after` longer than this fails the request rather than holding the chat up. */
const RETRY_MAX_S = 30
const RETRIES = 3
/** Typing shows for about 10 s; the hub renews it more often than that, so the extra calls are skipped. */
const TYPING_MS = 8000
/** Discord wants a press answered within 3 s; one the hub has not answered by then is acknowledged silently. */
const PRESS_ACK_MS = 2000
/** A press's token takes follow-ups for 15 minutes. */
const PRESS_KEEP_MS = 14 * 60_000
/** Bots may upload 10 MB to a server without boosts. */
const FILE_MAX = 10 * 1024 * 1024
/** Five rows of five buttons a message, labels up to 80 characters, data up to 100. */
const ROWS = 5
const PER_ROW = 5
const LABEL_MAX = 80
const DATA_MAX = 100
/** Threads remembered as ones the bot takes part in (no mention needed there). */
const THREADS_KEPT = 500
/** Close codes that reconnecting cannot fix (OpenClaw's `fatalGatewayCloseCodes`). */
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014])
/** Close codes after which the session cannot be resumed (OpenClaw's `nonResumableGatewayCloseCodes`). */
const FRESH = new Set([4003, 4005, 4007, 4009])
/** Message types that are someone writing: a message and a reply (not joins, pins, thread notices). */
const SPOKEN = new Set([0, 19])
const THREAD_TYPES = new Set([10, 11, 12])
const EPHEMERAL = 64
const SUPPRESS_EMBEDS = 4
const VOICE_MESSAGE = 8192
/**
 * Notes the hub sends that the edited message already says; shown as a message only the presser sees, they would
 * repeat it.
 */
const ECHOES = new Set([
  channelCopy.approval.pressAllowed,
  channelCopy.approval.pressDenied,
  channelCopy.question.pressNoted,
])
/** Nothing an agent writes may ping @everyone, a role or a person. */
const NO_PINGS = { parse: [] }

class DiscordError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}

interface DcUser {
  id: string
  username: string
  global_name?: string | null
  bot?: boolean
}
interface DcAttachment {
  id: string
  filename: string
  content_type?: string
  size?: number
  url: string
}
interface DcMessage {
  id: string
  channel_id: string
  guild_id?: string
  author: DcUser
  member?: { nick?: string | null }
  content: string
  timestamp: string
  type: number
  flags?: number
  webhook_id?: string
  mentions?: DcUser[]
  attachments?: DcAttachment[]
  sticker_items?: unknown[]
  referenced_message?: { author?: DcUser } | null
}
interface DcChannel {
  id: string
  type: number
  name?: string
  parent_id?: string | null
}
interface DcInteraction {
  id: string
  application_id: string
  type: number
  token: string
  channel_id?: string
  guild_id?: string
  member?: { user: DcUser; nick?: string | null }
  user?: DcUser
  data?: { custom_id?: string }
  message?: { id: string; channel_id: string }
}
interface Payload {
  op: number
  d: unknown
  s?: number | null
  t?: string | null
}
/** How one gateway connection ended. */
interface End {
  /** It got as far as READY or RESUMED. */
  ready: boolean
  resumable: boolean
  fatal?: string
  error?: string
  wait?: number
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

const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5)
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const kindOf = (mime: string): InboundFile['kind'] =>
  mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('audio/')
      ? 'audio'
      : mime.startsWith('video/')
        ? 'video'
        : 'document'

export class DiscordAdapter implements ChannelAdapter {
  readonly id = 'discord'
  readonly label = 'Discord'
  /** Discord's message limit, about one edit a second per channel, and the upload limit. */
  readonly limits = { text: 2000, editMs: 1500, file: FILE_MAX }
  readonly can = { buttons: true, files: true, edit: true }
  private _me?: { id: string; username: string }
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _session?: { id: string; resumeUrl: string }
  private _seq: number | null = null
  /** Dispatches are handled one at a time, in the order they came. */
  private _queue = Promise.resolve()
  private readonly _channels = new Map<string, DcChannel>()
  private readonly _guilds = new Map<string, string>()
  private _threads: string[] = []
  private readonly _presses = new Map<
    string,
    { token: string; app: string; acked: boolean; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly _typed = new Map<string, number>()
  private _globalUntil = 0
  private readonly _buckets = new Map<string, number>()

  constructor(
    private readonly token: string,
    private readonly api = DISCORD_API,
  ) {}

  /** One REST call, waiting out rate limits; never logs or throws its headers (they carry the token). */
  private async _rest<T>(method: string, path: string, body?: unknown, tries = 0): Promise<T> {
    // Discord limits per route (by channel), and across the bot; a message id or press token is not part of it.
    const bucket = path
      .replace(/\/messages\/\d+/, '/messages/:id')
      .replace(/^\/(interactions|webhooks)\/.*/, '/$1')
    const route = `${method} ${bucket}`
    const wait = Math.max(this._globalUntil, this._buckets.get(route) ?? 0) - Date.now()
    if (wait > 0) await sleep(wait)
    let res: Response
    try {
      res = await fetch(`${this.api}${path}`, {
        method,
        headers: {
          authorization: `Bot ${this.token}`,
          'user-agent': USER_AGENT,
          ...(body !== undefined && !(body instanceof FormData)
            ? { 'content-type': 'application/json' }
            : {}),
        },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      })
    } catch (err) {
      throw new DiscordError(0, `cannot reach Discord: ${err instanceof Error ? err.name : 'network error'}`)
    }
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const after = Number(res.headers.get('x-ratelimit-reset-after'))
      if (after > 0) this._buckets.set(route, Date.now() + after * 1000)
    }
    if (res.status === 204) return undefined as T
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 429) {
      const after = Number(data.retry_after ?? res.headers.get('retry-after') ?? 1)
      const until = Date.now() + after * 1000
      if (data.global || res.headers.get('x-ratelimit-global')) this._globalUntil = until
      else this._buckets.set(route, until)
      // The wait itself happens at the top of the next try.
      if (tries < RETRIES && after <= RETRY_MAX_S) return this._rest<T>(method, path, body, tries + 1)
      throw new DiscordError(429, 'Discord is rate limiting this bot', after)
    }
    if (!res.ok)
      throw new DiscordError(
        res.status,
        typeof data.message === 'string' ? `Discord: ${data.message}` : `Discord answered ${res.status}`,
      )
    return data as T
  }

  async check(): Promise<string> {
    try {
      const me = await this._rest<DcUser>('GET', '/users/@me')
      this._me = { id: me.id, username: me.username }
      return `@${me.username}`
    } catch (err) {
      if (err instanceof DiscordError && err.code === 401) throw new Error(channelCopy.discord.refused)
      throw err
    }
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    try {
      const kept = JSON.parse(io.get('threads') ?? '[]')
      this._threads = Array.isArray(kept) ? kept.filter((t) => typeof t === 'string') : []
    } catch {
      this._threads = []
    }
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      // Who the bot is, before anything else: mentions are recognized by its id.
      while (!signal.aborted && !this._me) {
        try {
          await this.check()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (message === channelCopy.discord.refused) return io.status({ state: 'error', error: message })
          io.status({ state: 'retrying', error: message })
          await sleep(jitter(backoff), signal)
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        }
      }
      if (signal.aborted) return
      const gateway = await this._rest<{ url?: string }>('GET', '/gateway/bot')
        .then((g) => g.url || DISCORD_GATEWAY)
        .catch(() => DISCORD_GATEWAY)
      backoff = BACKOFF_MIN_MS
      while (!signal.aborted) {
        const resume = this._seq !== null ? this._session : undefined
        const end = await this._connect(resume?.resumeUrl ?? gateway, Boolean(resume), io, signal)
        if (signal.aborted) break
        if (end.fatal) {
          io.status({ state: 'error', error: end.fatal })
          break
        }
        if (!end.resumable) {
          this._session = undefined
          this._seq = null
        }
        // A connection that was up reconnects at once (Discord asks for that now and then); one that never came
        // up is reported, and tried again later and later.
        if (end.ready) backoff = BACKOFF_MIN_MS
        else io.status({ state: 'retrying', error: end.error ?? 'cannot reach the Discord gateway' })
        await sleep(jitter(end.wait ?? backoff), signal)
        if (!end.ready) backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
    for (const press of this._presses.values()) clearTimeout(press.timer)
    this._presses.clear()
  }

  /** One gateway connection, from HELLO until it closes. */
  private _connect(url: string, resume: boolean, io: AdapterIO, signal: AbortSignal): Promise<End> {
    return new Promise<End>((resolve) => {
      const where = new URL(url)
      where.searchParams.set('v', '10')
      where.searchParams.set('encoding', 'json')
      let ws: WebSocket
      try {
        ws = new WebSocket(where.toString())
      } catch (err) {
        resolve({ ready: false, resumable: true, error: err instanceof Error ? err.message : String(err) })
        return
      }
      let ready = false
      let acked = true
      let beat: ReturnType<typeof setTimeout> | undefined
      let ending: Omit<End, 'ready'> | undefined
      const send = (op: number, d: unknown) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d }))
      }
      const heartbeat = () => {
        acked = false
        send(1, this._seq)
      }
      // Closed from this side with a code other than 1000, so Discord keeps the session for a RESUME.
      const end = (how: Omit<End, 'ready'>) => {
        ending ??= how
        clearTimeout(beat)
        ws.close(4000)
      }
      const onAbort = () => {
        ending = { resumable: false }
        ws.close(1000)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      ws.onmessage = (event) => {
        let p: Payload
        try {
          p = JSON.parse(String(event.data)) as Payload
        } catch {
          return
        }
        if (typeof p.s === 'number') this._seq = p.s
        switch (p.op) {
          case 10: {
            const interval = Number((p.d as { heartbeat_interval?: number })?.heartbeat_interval) || 41_250
            const cycle = (delay: number) => {
              beat = setTimeout(() => {
                // No ACK since the last beat: the connection has gone quiet; drop it and resume.
                if (!acked) return end({ resumable: true, error: 'the Discord gateway stopped answering' })
                heartbeat()
                cycle(interval)
              }, delay)
            }
            // The first beat at a random point of the interval, so clients restarted together do not beat together.
            cycle(interval * Math.random())
            if (resume && this._session)
              send(6, { token: this.token, session_id: this._session.id, seq: this._seq })
            else
              send(2, {
                token: this.token,
                intents: INTENTS,
                properties: { os: process.platform, browser: 'myrmidon', device: 'myrmidon' },
              })
            break
          }
          case 11:
            acked = true
            break
          case 1:
            heartbeat()
            break
          case 7:
            end({ resumable: true })
            break
          case 9:
            // An invalid session: resumable when `d` is true; either way Discord asks for a short random wait.
            end({ resumable: p.d === true, wait: 1000 + Math.random() * 4000 })
            break
          case 0: {
            if (p.t === 'READY') {
              const d = p.d as { session_id: string; resume_gateway_url: string; user: DcUser }
              this._session = { id: d.session_id, resumeUrl: d.resume_gateway_url }
              this._me = { id: d.user.id, username: d.user.username }
            }
            if (p.t === 'READY' || p.t === 'RESUMED') {
              ready = true
              io.status({ state: 'on', account: `@${this._me?.username}` })
            }
            // Held at once, so the 3 s Discord gives an answer starts counting here, not after the queue.
            if (p.t === 'INTERACTION_CREATE') this._hold(p.d as DcInteraction)
            const { t, d } = p
            this._queue = this._queue
              .then(() => this._dispatch(t, d))
              .catch((err) => io.log(err instanceof Error ? err.message : String(err)))
          }
        }
      }
      ws.onclose = (event) => {
        clearTimeout(beat)
        signal.removeEventListener('abort', onAbort)
        if (ending) return resolve({ ready, ...ending })
        if (FATAL.has(event.code))
          return resolve({
            ready,
            resumable: false,
            fatal:
              event.code === 4004
                ? channelCopy.discord.refused
                : event.code === 4014
                  ? channelCopy.discord.intents
                  : channelCopy.discord.gateway(event.code),
          })
        resolve({
          ready,
          resumable: !FRESH.has(event.code),
          error: `the Discord gateway closed the connection (${event.code})`,
        })
      }
    })
  }

  private async _dispatch(t: string | null | undefined, d: unknown) {
    switch (t) {
      case 'GUILD_CREATE': {
        const g = d as { id: string; name?: string; channels?: DcChannel[]; threads?: DcChannel[] }
        if (g.name) this._guilds.set(g.id, g.name)
        for (const c of [...(g.channels ?? []), ...(g.threads ?? [])]) this._channels.set(c.id, c)
        return
      }
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE': {
        const c = d as DcChannel
        this._channels.set(c.id, c)
        return
      }
      case 'MESSAGE_CREATE': {
        const message = await this._inbound(d as DcMessage)
        if (message) await this._io?.receive(message)
        return
      }
      case 'INTERACTION_CREATE': {
        const press = await this._press(d as DcInteraction)
        if (press) await this._io?.receive(press)
        return
      }
    }
  }

  private async _channel(id: string): Promise<DcChannel | undefined> {
    const known = this._channels.get(id)
    if (known) return known
    const fetched = await this._rest<DcChannel>('GET', `/channels/${id}`).catch(() => undefined)
    if (fetched) this._channels.set(id, fetched)
    return fetched
  }

  /** Where something was written: a direct chat, or a server channel (and the thread in it, if any). */
  private async _chat(channelId: string, guildId?: string): Promise<ChannelChat> {
    if (!guildId) return { id: channelId, kind: 'dm' }
    const here = await this._channel(channelId)
    const parentId = here && THREAD_TYPES.has(here.type) ? here.parent_id : undefined
    const parent = parentId ? await this._channel(parentId) : here
    const title = [
      this._guilds.get(guildId),
      parent?.name ? `#${parent.name}` : undefined,
      parentId && here?.name ? `› ${here.name}` : undefined,
    ]
      .filter(Boolean)
      .join(' ')
    return {
      id: parentId ?? channelId,
      kind: 'group',
      ...(title ? { title } : {}),
      ...(parentId ? { thread: channelId } : {}),
    }
  }

  /** A thread the bot speaks in, where it then answers without being mentioned (as Hermes does). */
  private _remember(thread: string) {
    if (this._threads.includes(thread)) return
    this._threads = [...this._threads, thread].slice(-THREADS_KEPT)
    this._io?.set('threads', JSON.stringify(this._threads))
  }

  private _file(a: DcAttachment, voice: boolean): InboundFile {
    const mimeType = a.content_type?.split(';')[0]?.trim() || 'application/octet-stream'
    return {
      kind: voice ? 'voice' : kindOf(mimeType),
      name: a.filename,
      mimeType,
      ...(a.size ? { size: a.size } : {}),
      read: async () => {
        // Attachment links are signed by Discord's CDN; they need no token.
        const res = await fetch(a.url)
        if (!res.ok) throw new Error(`Discord answered ${res.status} for the file`)
        return new Uint8Array(await res.arrayBuffer())
      },
    }
  }

  /** A message as the hub's; undefined for what channels ignore (bots, webhooks, system notices, itself). */
  private async _inbound(m: DcMessage): Promise<Inbound | undefined> {
    if (m.author.bot || m.webhook_id || m.author.id === this._me?.id || !SPOKEN.has(m.type)) return undefined
    const chat = await this._chat(m.channel_id, m.guild_id)
    const me = this._me?.id ?? ''
    const mentioned =
      chat.kind === 'dm' ||
      (m.mentions ?? []).some((u) => u.id === me) ||
      m.referenced_message?.author?.id === me ||
      (chat.thread !== undefined && this._threads.includes(chat.thread))
    if (mentioned && chat.thread) this._remember(chat.thread)
    const names = new Map((m.mentions ?? []).map((u) => [u.id, u.global_name || u.username]))
    const text = m.content
      .replace(/<@!?(\d+)>/g, (all, id: string) =>
        id === me ? '' : names.has(id) ? `@${names.get(id)}` : all,
      )
      .replace(/ {2,}/g, ' ')
      .trim()
    const voice = Boolean((m.flags ?? 0) & VOICE_MESSAGE)
    const files = (m.attachments ?? []).map((a) => this._file(a, voice))
    return {
      messageId: m.id,
      chat,
      sender: {
        id: m.author.id,
        name: m.member?.nick || m.author.global_name || m.author.username,
        handle: m.author.username,
      },
      text,
      mentioned,
      ...(files.length ? { files } : {}),
      ...(!text && !files.length && m.sticker_items?.length ? { unsupported: true } : {}),
      time: m.timestamp,
    }
  }

  /** Starts the clock on a button press: acknowledged silently unless the hub answers it first. */
  private _hold(i: DcInteraction) {
    if (i.type !== 3 || this._presses.has(i.id)) return
    this._presses.set(i.id, {
      token: i.token,
      app: i.application_id,
      acked: false,
      timer: setTimeout(() => void this._ack(i.id, undefined, false).catch(() => {}), PRESS_ACK_MS),
    })
  }

  /**
   * Answers a press: the first answer is the interaction's callback (a deferred update, or a note only the presser
   * sees); a note after that is a follow-up on the press's token.
   */
  private async _ack(id: string, note: string | undefined, final: boolean) {
    const press = this._presses.get(id)
    if (!press) return
    clearTimeout(press.timer)
    if (final) this._presses.delete(id)
    else press.timer = setTimeout(() => this._presses.delete(id), PRESS_KEEP_MS)
    if (!press.acked) {
      press.acked = true
      await this._rest(
        'POST',
        `/interactions/${id}/${press.token}/callback`,
        note
          ? { type: 4, data: { content: note, flags: EPHEMERAL, allowed_mentions: NO_PINGS } }
          : { type: 6 },
      )
    } else if (note)
      await this._rest('POST', `/webhooks/${press.app}/${press.token}`, {
        content: note,
        flags: EPHEMERAL,
        allowed_mentions: NO_PINGS,
      })
  }

  private async _press(i: DcInteraction): Promise<Inbound | undefined> {
    const user = i.member?.user ?? i.user
    const channelId = i.channel_id ?? i.message?.channel_id
    if (i.type !== 3 || !i.data?.custom_id || !i.message || !channelId || !user || user.bot) return undefined
    const chat = await this._chat(channelId, i.guild_id)
    return {
      messageId: `press:${i.id}`,
      chat,
      sender: {
        id: user.id,
        name: i.member?.nick || user.global_name || user.username,
        handle: user.username,
      },
      text: '',
      mentioned: true,
      press: { id: i.id, data: i.data.custom_id, message: { chat: channelId, id: i.message.id } },
      time: new Date().toISOString(),
    }
  }

  async answerPress(press: ButtonPress, note?: string): Promise<void> {
    await this._ack(press.id, note && !ECHOES.has(note) ? note : undefined, true)
  }

  /** Rows of buttons as action rows; more than Discord takes are packed five to a row, and the rest left out. */
  private _components(message: OutMessage) {
    const rows = message.buttons ?? []
    let packed: readonly (readonly Button[])[] = rows
    if (rows.length > ROWS || rows.some((r) => r.length > PER_ROW)) {
      const all = rows.flat()
      const fitted: Button[][] = []
      for (let i = 0; i < all.length && fitted.length < ROWS; i += PER_ROW)
        fitted.push(all.slice(i, i + PER_ROW))
      packed = fitted
    }
    return packed
      .filter((row) => row.length)
      .map((row) => ({
        type: 1,
        components: row.map((b) => ({
          type: 2,
          style: 2,
          label: clip(b.label, LABEL_MAX),
          custom_id: b.data.slice(0, DATA_MAX),
        })),
      }))
  }

  private _body(message: OutMessage) {
    return {
      content: discordMarkdown(message.text),
      // No link previews, as on Telegram; the status line and answers stay compact.
      flags: SUPPRESS_EMBEDS,
      allowed_mentions: NO_PINGS,
      components: this._components(message),
    }
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    // A thread is a channel of its own on Discord.
    const thread = threadOf(chat)
    const channel = thread ?? chatIdOf(chat)
    const sent = await this._rest<{ id: string }>(
      'POST',
      `/channels/${channel}/messages`,
      this._body(message),
    )
    if (thread) this._remember(thread)
    return { chat: channel, id: sent.id }
  }

  async edit(ref: SentRef, message: OutMessage): Promise<void> {
    // Components are always sent, so a message whose buttons were answered loses them.
    await this._rest('PATCH', `/channels/${ref.chat}/messages/${ref.id}`, this._body(message))
  }

  async typing(chat: ChannelChat | string): Promise<void> {
    const channel = threadOf(chat) ?? chatIdOf(chat)
    if (Date.now() - (this._typed.get(channel) ?? 0) < TYPING_MS) return
    this._typed.set(channel, Date.now())
    await this._rest('POST', `/channels/${channel}/typing`)
  }

  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const thread = threadOf(chat)
    const channel = thread ?? chatIdOf(chat)
    const form = new FormData()
    form.set(
      'payload_json',
      JSON.stringify({
        ...(file.caption ? { content: discordMarkdown(file.caption) } : {}),
        attachments: [{ id: 0, filename: file.name }],
        allowed_mentions: NO_PINGS,
      }),
    )
    form.set('files[0]', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.name)
    const sent = await this._rest<{ id: string }>('POST', `/channels/${channel}/messages`, form)
    if (thread) this._remember(thread)
    return { chat: channel, id: sent.id }
  }
}
