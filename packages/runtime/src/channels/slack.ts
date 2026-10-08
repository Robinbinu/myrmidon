import { channelCopy } from './copy.ts'
import { slackMrkdwn } from './format.ts'
import {
  type AdapterIO,
  type ButtonPress,
  type ChannelAdapter,
  type ChannelChat,
  type ChannelSender,
  chatIdOf,
  type Inbound,
  type InboundFile,
  type OutFile,
  type OutMessage,
  type SentRef,
  threadOf,
} from './types.ts'

/**
 * Slack through Socket Mode and the Web API with no library, ported from OpenClaw's and Hermes's adapters: a
 * WebSocket from `apps.connections.open` (so nothing on this machine needs to be reachable from the internet), every
 * envelope acknowledged at once, a fresh connection when Slack asks for one; messages and mentions (a thread per
 * conversation in channels), files with the bot token, Block Kit buttons and their presses; mrkdwn out, files up
 * through `files.getUploadURLExternal`, and `Retry-After` honoured.
 */

export const SLACK_API = 'https://slack.com/api'
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
/** A `Retry-After` longer than this fails the call rather than holding the chat up. */
const RETRY_MAX_S = 30
const RETRIES = 3
/** A section's text may be 3,000 characters; a message 50 blocks. */
const SECTION_MAX = 3000
const BLOCKS_MAX = 50
/**
 * chat.update refuses text over 4,000 bytes (OpenClaw's `SLACK_EDIT_TEXT_MAX_BYTES`); the notification text stays
 * under that.
 */
const FALLBACK_BYTES = 3500
/** A button's label may be 75 characters; an actions block 25 elements. */
const LABEL_MAX = 75
const ACTIONS_MAX = 25
/** Threads remembered as ones the bot takes part in (no mention needed there). */
const THREADS_KEPT = 500
/** A press's `response_url` takes replies for 30 minutes. */
const PRESS_KEEP_MS = 25 * 60_000
/** Message subtypes that are someone writing; the rest (edits, deletions, joins, bot posts) are ignored. */
const SPOKEN = new Set(['file_share', 'thread_broadcast'])
/** Slack keeps `/` for its own slash commands, so the hub's are typed with `!` (Hermes's bang commands). */
const COMMANDS = new Set(['new', 'stop', 'status', 'help', 'approve', 'deny'])
/** Errors that mean a token was refused rather than a passing failure. */
const REFUSED = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'not_allowed_token_type',
])
/**
 * Notes the hub sends that the edited message already says; shown as a message only the presser sees, they would
 * repeat it.
 */
const ECHOES = new Set([
  channelCopy.approval.pressAllowed,
  channelCopy.approval.pressDenied,
  channelCopy.question.pressNoted,
])

class SlackError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}

interface SlackFile {
  id: string
  name?: string
  mimetype?: string
  subtype?: string
  size?: number
  mode?: string
  url_private?: string
  url_private_download?: string
}
interface SlackEvent {
  type: string
  subtype?: string
  channel: string
  channel_type?: string
  user?: string
  bot_id?: string
  text?: string
  ts: string
  thread_ts?: string
  parent_user_id?: string
  files?: SlackFile[]
}
interface SlackAction {
  value?: string
  action_ts?: string
}
interface SlackInteraction {
  type: string
  trigger_id?: string
  response_url?: string
  user?: { id: string }
  channel?: { id: string }
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string }
  message?: { ts?: string; thread_ts?: string }
  actions?: SlackAction[]
}
interface Envelope {
  type: string
  envelope_id?: string
  reason?: string
  payload?: { event?: SlackEvent } & Partial<SlackInteraction>
}
/** How one socket connection ended. */
interface End {
  /** Slack said hello: the connection was up. */
  hello: boolean
  /** Slack asked for a new connection (it refreshes them every few hours). */
  refresh?: boolean
  fatal?: string
  error?: string
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

/** Text cut to a number of UTF-8 bytes, never inside a character. */
function clipBytes(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= max) return text
  return `${new TextDecoder().decode(bytes.slice(0, max - 3)).replace(/�+$/, '')}…`
}

/** mrkdwn split into section-sized pieces at line breaks; a code block cut in two is closed and reopened. */
function sections(mrkdwn: string): string[] {
  // Room for the closing fence.
  const room = SECTION_MAX - 4
  const out: string[] = []
  let lines: string[] = []
  let size = 0
  let fenced = false
  for (const whole of mrkdwn.split('\n')) {
    // A line longer than a section is cut.
    const pieces: string[] = []
    for (let i = 0; i < whole.length; i += room) pieces.push(whole.slice(i, i + room))
    for (const line of pieces.length ? pieces : ['']) {
      if (lines.length && size + line.length + 1 > room) {
        out.push(fenced ? `${lines.join('\n')}\n\`\`\`` : lines.join('\n'))
        lines = fenced ? ['```'] : []
        size = lines.length * 4
      }
      lines.push(line)
      size += line.length + 1
    }
    // slackMrkdwn puts every fence on a line of its own.
    if (whole === '```') fenced = !fenced
  }
  const last = lines.join('\n')
  if (last.trim()) out.push(last)
  return out
}

const kindOf = (f: SlackFile, mime: string): InboundFile['kind'] =>
  f.subtype === 'slack_audio'
    ? 'voice'
    : mime.startsWith('image/')
      ? 'image'
      : mime.startsWith('audio/')
        ? 'audio'
        : mime.startsWith('video/')
          ? 'video'
          : 'document'

export class SlackAdapter implements ChannelAdapter {
  readonly id = 'slack'
  readonly label = 'Slack'
  /** One section per message, about one edit a second, and files as large as Telegram's. */
  readonly limits = { text: SECTION_MAX, editMs: 1500, file: 50 * 1024 * 1024 }
  readonly can = { buttons: true, files: true, edit: true }
  /** The app keeps `/` for its own commands, so the hub's are typed with `!` (turned into `/` on the way in). */
  readonly commandPrefix = '!'
  private _me?: { id: string; name: string; team: string }
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  /** Envelopes are handled one at a time, in the order they came. */
  private _queue = Promise.resolve()
  private _threads: string[] = []
  private readonly _users = new Map<string, ChannelSender>()
  private readonly _titles = new Map<string, string | undefined>()
  private readonly _presses = new Map<string, { url: string; timer: ReturnType<typeof setTimeout> }>()

  constructor(
    private readonly botToken: string,
    private readonly appToken: string,
    private readonly api = SLACK_API,
  ) {}

  /** One Web API call, form-encoded (which every method takes); never logs or throws the token. */
  private async _call<T>(
    method: string,
    params: Record<string, unknown> = {},
    token = this.botToken,
    tries = 0,
  ): Promise<T> {
    const form = new URLSearchParams()
    for (const [k, v] of Object.entries(params))
      if (v !== undefined) form.set(k, typeof v === 'string' ? v : JSON.stringify(v))
    let res: Response
    try {
      res = await fetch(`${this.api}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      })
    } catch (err) {
      throw new SlackError(
        'network',
        `cannot reach Slack: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after') ?? 1)
      if (tries < RETRIES && after <= RETRY_MAX_S) {
        await sleep(after * 1000)
        return this._call<T>(method, params, token, tries + 1)
      }
      throw new SlackError('ratelimited', 'Slack is rate limiting this app', after)
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!data.ok) {
      const code = data.error ?? String(res.status)
      throw new SlackError(code, `Slack: ${code}`)
    }
    return data as T
  }

  /** A Socket Mode address, which also proves the app-level token. */
  private async _open(): Promise<string> {
    try {
      return (await this._call<{ url: string }>('apps.connections.open', {}, this.appToken)).url
    } catch (err) {
      if (err instanceof SlackError && REFUSED.has(err.code)) throw new Error(channelCopy.slack.appRefused)
      throw err
    }
  }

  async check(): Promise<string> {
    let auth: { user: string; user_id: string; team: string }
    try {
      auth = await this._call('auth.test')
    } catch (err) {
      if (err instanceof SlackError && REFUSED.has(err.code)) throw new Error(channelCopy.slack.refused)
      throw err
    }
    if (!this.appToken.startsWith('xapp-')) throw new Error(channelCopy.slack.notAppToken)
    await this._open()
    this._me = { id: auth.user_id, name: auth.user, team: auth.team }
    return this._account()
  }

  private _account() {
    return `@${this._me?.name} in ${this._me?.team}`
  }

  private _refused(message: string) {
    const t = channelCopy.slack
    return message === t.refused || message === t.appRefused || message === t.notAppToken
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
      // Who the bot is, before anything else: mentions are recognized by its user id.
      while (!signal.aborted && !this._me) {
        try {
          await this.check()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (this._refused(message)) return io.status({ state: 'error', error: message })
          io.status({ state: 'retrying', error: message })
          await sleep(jitter(backoff), signal)
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        }
      }
      backoff = BACKOFF_MIN_MS
      while (!signal.aborted) {
        let end: End
        try {
          end = await this._socket(await this._open(), io, signal)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (this._refused(message)) return io.status({ state: 'error', error: message })
          end = { hello: false, error: message }
        }
        if (signal.aborted) break
        if (end.fatal) {
          io.status({ state: 'error', error: end.fatal })
          break
        }
        // A refresh Slack asked for reconnects at once; a drop waits a little, longer each time it fails.
        if (end.hello) backoff = BACKOFF_MIN_MS
        else io.status({ state: 'retrying', error: end.error ?? 'cannot reach Slack' })
        if (!end.refresh) await sleep(jitter(backoff), signal)
        if (!end.hello) backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
    for (const press of this._presses.values()) clearTimeout(press.timer)
    this._presses.clear()
  }

  /** One Socket Mode connection, until it closes. */
  private _socket(url: string, io: AdapterIO, signal: AbortSignal): Promise<End> {
    return new Promise<End>((resolve) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch (err) {
        resolve({ hello: false, error: err instanceof Error ? err.message : String(err) })
        return
      }
      let hello = false
      let ending: Omit<End, 'hello'> | undefined
      const onAbort = () => ws.close(1000)
      signal.addEventListener('abort', onAbort, { once: true })
      ws.onmessage = (event) => {
        let msg: Envelope
        try {
          msg = JSON.parse(String(event.data)) as Envelope
        } catch {
          return
        }
        // Acknowledged first and at once: Slack sends again what is not acknowledged within 3 s.
        if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }))
        if (msg.type === 'hello') {
          hello = true
          io.status({ state: 'on', account: this._account() })
          return
        }
        if (msg.type === 'disconnect') {
          ending = msg.reason === 'link_disabled' ? { fatal: channelCopy.slack.socketOff } : { refresh: true }
          ws.close(1000)
          return
        }
        if (msg.type !== 'events_api' && msg.type !== 'interactive') return
        this._queue = this._queue
          .then(() => this._envelope(msg))
          .catch((err) => io.log(err instanceof Error ? err.message : String(err)))
      }
      ws.onclose = (event) => {
        signal.removeEventListener('abort', onAbort)
        resolve({ hello, ...(ending ?? { error: `the Slack connection closed (${event.code})` }) })
      }
    })
  }

  private async _envelope(msg: Envelope) {
    const payload = msg.payload ?? {}
    let message: Inbound | undefined
    // An events_api envelope may carry no event at all (`app_rate_limited`); it is acknowledged and left.
    if (
      msg.type === 'events_api' &&
      (payload.event?.type === 'message' || payload.event?.type === 'app_mention')
    )
      message = await this._inbound(payload.event)
    else if (msg.type === 'interactive' && payload.type === 'block_actions')
      message = await this._press(payload as SlackInteraction)
    if (message) await this._io?.receive(message)
  }

  /** Who someone is, by `users.info` (needs `users:read`; their id otherwise), remembered. */
  private async _user(id: string): Promise<ChannelSender> {
    const known = this._users.get(id)
    if (known) return known
    const info = await this._call<{
      user: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } }
    }>('users.info', { user: id }).catch(() => undefined)
    const u = info?.user
    const sender: ChannelSender = {
      id,
      name: u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || id,
      ...(u?.name ? { handle: u.name } : {}),
    }
    this._users.set(id, sender)
    return sender
  }

  /** A channel's `#name` (needs `channels:read` / `groups:read`), remembered. */
  private async _title(channel: string): Promise<string | undefined> {
    if (this._titles.has(channel)) return this._titles.get(channel)
    const info = await this._call<{ channel: { name?: string } }>('conversations.info', { channel }).catch(
      () => undefined,
    )
    const title = info?.channel.name ? `#${info.channel.name}` : undefined
    this._titles.set(channel, title)
    return title
  }

  /** A thread the bot speaks in or was mentioned in, where it then answers without a mention (as Hermes does). */
  private _remember(key: string) {
    if (this._threads.includes(key)) return
    this._threads = [...this._threads, key].slice(-THREADS_KEPT)
    this._io?.set('threads', JSON.stringify(this._threads))
  }

  /** Slack's markup as plain text: the bot's own mention removed; people, channels and links readable. */
  private async _plain(text: string): Promise<string> {
    const me = this._me?.id ?? ''
    let out = text.replace(new RegExp(`<@${me}(?:\\|[^>]*)?>`, 'g'), '')
    for (const [, id] of out.matchAll(/<@([UW][A-Z0-9]+)>/g))
      if (id) out = out.replaceAll(`<@${id}>`, `@${(await this._user(id)).name}`)
    out = out
      .replace(/<@[UW][A-Z0-9]+\|([^>]+)>/g, '@$1')
      .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
      .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '$1')
      .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2 ($1)')
      .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/ {2,}/g, ' ')
      .trim()
    return out.replace(/^!([a-z_]+)\b/i, (all, name: string) =>
      COMMANDS.has(name.toLowerCase()) ? `/${name}` : all,
    )
  }

  private _file(f: SlackFile): InboundFile {
    const mimeType = f.mimetype || 'application/octet-stream'
    const url = f.url_private_download ?? f.url_private ?? ''
    return {
      kind: kindOf(f, mimeType),
      name: f.name || `file-${f.id}`,
      mimeType,
      ...(f.size ? { size: f.size } : {}),
      read: async () => {
        // The bot token goes only to Slack's own hosts.
        const host = new URL(url).hostname
        if (!(host === 'slack.com' || host.endsWith('.slack.com') || host === new URL(this.api).hostname))
          throw new Error('not a Slack file address')
        const res = await fetch(url, { headers: { authorization: `Bearer ${this.botToken}` } })
        if (!res.ok) throw new Error(`Slack answered ${res.status} for the file`)
        // Without files:read Slack answers with its sign-in page rather than the file.
        if (res.headers.get('content-type')?.startsWith('text/html') && !mimeType.startsWith('text/html'))
          throw new Error(channelCopy.slack.fileHtml)
        return new Uint8Array(await res.arrayBuffer())
      },
    }
  }

  /** A message event as the hub's; undefined for what channels ignore (bots, itself, edits, joins). */
  private async _inbound(e: SlackEvent): Promise<Inbound | undefined> {
    if (!e.user || e.bot_id || e.user === this._me?.id || (e.subtype && !SPOKEN.has(e.subtype)))
      return undefined
    const dm = (e.channel_type ?? (e.channel.startsWith('D') ? 'im' : 'channel')) === 'im'
    const me = this._me?.id ?? ''
    const inThread = e.thread_ts && e.thread_ts !== e.ts ? e.thread_ts : undefined
    // In a channel, each message outside a thread starts one, which the answer goes into (Hermes's
    // `reply_in_thread`): a channel holds several conversations at once, and stays readable.
    const thread = inThread ?? (dm ? undefined : e.ts)
    const raw = e.text ?? ''
    const mentioned =
      dm ||
      e.type === 'app_mention' ||
      new RegExp(`<@${me}(?:\\|[^>]*)?>`).test(raw) ||
      (inThread !== undefined &&
        (e.parent_user_id === me || this._threads.includes(`${e.channel}:${inThread}`)))
    if (mentioned && thread) this._remember(`${e.channel}:${thread}`)
    const title = dm ? undefined : await this._title(e.channel)
    const files = (e.files ?? [])
      .filter((f) => (f.url_private_download || f.url_private) && f.mode !== 'tombstone')
      .map((f) => this._file(f))
    return {
      messageId: e.ts,
      chat: {
        id: e.channel,
        kind: dm ? 'dm' : 'group',
        ...(title ? { title } : {}),
        ...(thread ? { thread } : {}),
      },
      sender: await this._user(e.user),
      text: await this._plain(raw),
      mentioned,
      ...(files.length ? { files } : {}),
      time: new Date(Number(e.ts) * 1000).toISOString(),
    }
  }

  private async _press(p: SlackInteraction): Promise<Inbound | undefined> {
    const action = p.actions?.[0]
    const channel = p.channel?.id ?? p.container?.channel_id
    const id = action?.action_ts ?? p.trigger_id
    if (!action || !channel || !p.user?.id || !id) return undefined
    if (p.response_url)
      this._presses.set(id, {
        url: p.response_url,
        timer: setTimeout(() => this._presses.delete(id), PRESS_KEEP_MS),
      })
    const thread = p.container?.thread_ts ?? p.message?.thread_ts
    const ts = p.container?.message_ts ?? p.message?.ts
    return {
      messageId: `press:${id}`,
      chat: { id: channel, kind: channel.startsWith('D') ? 'dm' : 'group', ...(thread ? { thread } : {}) },
      sender: await this._user(p.user.id),
      text: '',
      mentioned: true,
      press: { id, data: action.value ?? '', ...(ts ? { message: { chat: channel, id: ts } } : {}) },
      time: new Date().toISOString(),
    }
  }

  /**
   * Slack has no toast for a button: a note becomes a reply only the presser sees, through the press's
   * `response_url`.
   */
  async answerPress(press: ButtonPress, note?: string): Promise<void> {
    const held = this._presses.get(press.id)
    this._presses.delete(press.id)
    if (held) clearTimeout(held.timer)
    if (!held || !note || ECHOES.has(note)) return
    const res = await fetch(held.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text: note }),
    })
    if (!res.ok) throw new Error(`Slack answered ${res.status} to the press`)
  }

  /**
   * The message as Block Kit: its text in sections, each row of buttons an actions block, and plain text for
   * notifications.
   */
  private _blocks(message: OutMessage) {
    const mrkdwn = slackMrkdwn(message.text)
    const blocks: unknown[] = sections(mrkdwn).map((text) => ({
      type: 'section',
      text: { type: 'mrkdwn', text },
    }))
    for (const [r, row] of (message.buttons ?? []).entries())
      if (row.length)
        blocks.push({
          type: 'actions',
          elements: row.slice(0, ACTIONS_MAX).map((b, c) => ({
            type: 'button',
            action_id: `myr_${r}_${c}`,
            text: { type: 'plain_text', text: clip(b.label, LABEL_MAX), emoji: true },
            value: b.data,
          })),
        })
    return { text: clipBytes(mrkdwn, FALLBACK_BYTES), blocks: blocks.slice(0, BLOCKS_MAX) }
  }

  /** A write to a channel, with Slack's "not in channel" explained. */
  private async _write<T>(method: string, params: Record<string, unknown>): Promise<T> {
    try {
      return await this._call<T>(method, params)
    } catch (err) {
      if (err instanceof SlackError && (err.code === 'not_in_channel' || err.code === 'channel_not_found'))
        throw new Error(channelCopy.slack.notInChannel)
      throw err
    }
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const channel = chatIdOf(chat)
    const thread = threadOf(chat)
    const sent = await this._write<{ channel?: string; ts: string }>('chat.postMessage', {
      channel,
      ...(thread ? { thread_ts: thread } : {}),
      ...this._blocks(message),
      unfurl_links: false,
      unfurl_media: false,
    })
    if (thread) this._remember(`${channel}:${thread}`)
    return { chat: sent.channel ?? channel, id: sent.ts }
  }

  async edit(ref: SentRef, message: OutMessage): Promise<void> {
    // Blocks are always sent: without them Slack keeps the old ones, buttons included.
    await this._write('chat.update', { channel: ref.chat, ts: ref.id, ...this._blocks(message) })
  }

  /** Slack has no typing indicator for bots outside its assistant threads. */
  async typing(_chat: ChannelChat | string): Promise<void> {}

  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const channel = chatIdOf(chat)
    const thread = threadOf(chat)
    const { upload_url, file_id } = await this._call<{ upload_url: string; file_id: string }>(
      'files.getUploadURLExternal',
      { filename: file.name, length: String(file.data.byteLength) },
    )
    // The upload address carries its own authorization; it is never logged.
    let up: Response
    try {
      up = await fetch(upload_url, {
        method: 'POST',
        headers: { 'content-type': file.mimeType },
        body: new Blob([new Uint8Array(file.data)]),
      })
    } catch (err) {
      throw new Error(`cannot reach Slack: ${err instanceof Error ? err.name : 'network error'}`)
    }
    await up.body?.cancel().catch(() => {})
    if (!up.ok) throw new Error(`Slack answered ${up.status} to the upload`)
    await this._write('files.completeUploadExternal', {
      files: [{ id: file_id, title: file.name }],
      channel_id: channel,
      ...(thread ? { thread_ts: thread } : {}),
      ...(file.caption ? { initial_comment: file.caption } : {}),
    })
    if (thread) this._remember(`${channel}:${thread}`)
    // Slack does not say which message the file became; the file's id stands in (files are not edited).
    return { chat: channel, id: file_id }
  }
}
