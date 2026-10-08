import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { channelCopy } from './copy.ts'
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
 * Mattermost through its REST API v4 and WebSocket (no library), ported from Hermes's adapter and OpenClaw's
 * extension: `posted` events over the WebSocket after an `authentication_challenge`, direct channels as direct
 * chats and the rest as groups (mentioned by the `mentions` list or @username), replies to a post as a thread of
 * their own; posts created and patched; typing through the WebSocket; files uploaded and attached by id. Buttons
 * are message-attachment actions, which Mattermost posts to an integration URL, so they exist only when the gateway
 * has a public address; each carries an HMAC of its data so a forged press is refused.
 */

const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
/** An application-level ping this often keeps the socket honest; silence for `DEAD_MS` reconnects it. */
const PING_MS = 30_000
const DEAD_MS = 75_000
/** Mattermost accepts 16383 characters, but much shorter posts stay readable (Hermes uses 4000). */
const POST_MAX = 4000
const REQUEST_MS = 30_000

class MattermostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface MmUser {
  id: string
  username: string
  first_name?: string
  last_name?: string
  is_bot?: boolean
}
interface MmFileInfo {
  id: string
  name: string
  mime_type?: string
  size?: number
}
interface MmPost {
  id: string
  create_at: number
  user_id: string
  channel_id: string
  root_id?: string
  message: string
  type?: string
  props?: Record<string, unknown>
  file_ids?: string[]
  metadata?: { files?: MmFileInfo[] }
}
/** A `posted` event's data: the post itself is JSON inside JSON. */
interface MmPostedData {
  channel_type?: string
  channel_display_name?: string
  sender_name?: string
  post?: string
  mentions?: string
}
interface MmAction {
  user_id: string
  user_name?: string
  channel_id: string
  post_id: string
  trigger_id?: string
  context?: { data?: unknown; sig?: unknown }
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

const kindOf = (mime: string): InboundFile['kind'] =>
  mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('audio/')
      ? 'audio'
      : mime.startsWith('video/')
        ? 'video'
        : 'document'

/** The server's address as typed (`chat.example.com`, with or without a trailing slash) as a base URL. */
export function mattermostBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export class MattermostAdapter implements ChannelAdapter {
  readonly id = 'mattermost'
  readonly label = 'Mattermost'
  readonly limits = { text: POST_MAX, editMs: 1000, file: 50 * 1024 * 1024 }
  private readonly _base: string
  private _me?: MmUser
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _io?: AdapterIO
  private _ws?: WebSocket
  private _seq = 1
  /** Where Mattermost posts button presses, and the key their data is signed with; set only when public. */
  private _actions?: { url: string; secret: string }
  /** Posted events are handled one at a time, in order. */
  private _queue: Promise<void> = Promise.resolve()
  /** What a channel is, learned from its posts, for button presses (which only carry its id). */
  private readonly _channels = new Map<string, Pick<ChannelChat, 'kind' | 'title'>>()

  constructor(
    url: string,
    private readonly token: string,
  ) {
    this._base = mattermostBase(url)
  }

  get can() {
    return { buttons: Boolean(this._actions), files: true, edit: true }
  }

  /** Never logs or throws anything carrying the token. */
  private async _api<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this._base}/api/v4/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body instanceof FormData || body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_MS),
      })
    } catch (err) {
      throw new MattermostError(
        0,
        channelCopy.errors.mattermostUnreachable(err instanceof Error ? err.name : 'network error'),
      )
    }
    const data = (await res.json().catch(() => ({}))) as T & { message?: string }
    if (!res.ok) throw new MattermostError(res.status, data.message ?? `Mattermost answered ${res.status}`)
    return data
  }

  async check(): Promise<string> {
    try {
      const me = await this._api<MmUser>('GET', 'users/me')
      this._me = me
      return `@${me.username}`
    } catch (err) {
      if (err instanceof MattermostError && (err.status === 401 || err.status === 403))
        throw new Error(channelCopy.errors.mattermostToken)
      throw err
    }
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    if (io.webhookUrl) {
      const secret = io.get('action-secret') ?? randomBytes(24).toString('base64url')
      io.set('action-secret', secret)
      this._actions = { url: io.webhookUrl, secret }
    }
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      while (!signal.aborted) {
        try {
          // Who the bot is first, each time: mentions are recognized by its id and username.
          const account = await this.check()
          const outcome = await this._listen(io, account, signal, () => {
            backoff = BACKOFF_MIN_MS
          })
          if (outcome === 'refused') {
            io.status({ state: 'error', error: channelCopy.errors.mattermostToken })
            return
          }
          if (signal.aborted) return
          io.status({ state: 'retrying', error: 'the connection to Mattermost closed' })
        } catch (err) {
          if (signal.aborted) return
          const message = err instanceof Error ? err.message : String(err)
          if (message === channelCopy.errors.mattermostToken)
            return io.status({ state: 'error', error: message })
          io.status({ state: 'retrying', error: message })
        }
        // Jitter, so many gateways recovering together do not hit the server at the same moment.
        await sleep(backoff * (0.75 + Math.random() * 0.5), signal)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    })()
  }

  /** One WebSocket session: authenticate, then hand `posted` events over until it closes. */
  private _listen(
    io: AdapterIO,
    account: string,
    signal: AbortSignal,
    connected: () => void,
  ): Promise<'closed' | 'refused'> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${this._base.replace(/^http/i, 'ws')}/api/v4/websocket`)
      this._ws = ws
      let heard = Date.now()
      let outcome: 'closed' | 'refused' = 'closed'
      const authSeq = this._seq++
      const ping = setInterval(() => {
        if (Date.now() - heard > DEAD_MS) return ws.close()
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ seq: this._seq++, action: 'ping' }))
      }, PING_MS)
      const onAbort = () => ws.close()
      signal.addEventListener('abort', onAbort, { once: true })
      ws.onopen = () => {
        ws.send(
          JSON.stringify({ seq: authSeq, action: 'authentication_challenge', data: { token: this.token } }),
        )
      }
      ws.onmessage = (ev) => {
        heard = Date.now()
        let msg: { event?: string; data?: unknown; seq_reply?: number; status?: string }
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (msg.seq_reply === authSeq) {
          if (msg.status === 'OK') {
            connected()
            io.status({ state: 'on', account })
          } else {
            outcome = 'refused'
            ws.close()
          }
          return
        }
        if (msg.event === 'posted') {
          const data = (msg.data ?? {}) as MmPostedData
          this._queue = this._queue
            .then(async () => {
              const message = await this._inbound(data)
              if (message) await io.receive(message)
            })
            .catch((err) => io.log(err instanceof Error ? err.message : String(err)))
        }
      }
      ws.onclose = () => {
        clearInterval(ping)
        signal.removeEventListener('abort', onAbort)
        if (this._ws === ws) this._ws = undefined
        resolve(outcome)
      }
    })
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    this._ws?.close()
    await this._loop?.catch(() => {})
    await this._queue.catch(() => {})
  }

  private _sign(channel: string, data: string): string {
    return createHmac('sha256', this._actions?.secret ?? '')
      .update(`${channel}\n${data}`)
      .digest('base64url')
  }

  /** A button press Mattermost posted to the integration URL, accepted only with a valid signature. */
  async webhook(req: Request): Promise<Response> {
    const action = (await req.json().catch(() => undefined)) as MmAction | undefined
    const data = action?.context?.data
    const sig = action?.context?.sig
    if (!this._actions || !action || typeof data !== 'string' || typeof sig !== 'string')
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    const given = Buffer.from(sig)
    const expected = Buffer.from(this._sign(action.channel_id, data))
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (action.user_id === this._me?.id) return Response.json({})
    const known = this._channels.get(action.channel_id) ?? (await this._channel(action.channel_id))
    const name =
      action.user_name ??
      (await this._api<MmUser>('GET', `users/${action.user_id}`).then(
        (u) => u.username,
        () => action.user_id,
      ))
    await this._io?.receive({
      messageId: `press:${action.trigger_id ?? randomBytes(8).toString('hex')}`,
      chat: { id: action.channel_id, ...known },
      sender: { id: action.user_id, name, handle: name },
      text: '',
      mentioned: true,
      press: {
        id: `${action.channel_id}:${action.user_id}`,
        data,
        message: { chat: action.channel_id, id: action.post_id },
      },
      time: new Date().toISOString(),
    })
    // An empty answer leaves the post as it is; the hub edits it once the press is handled.
    return Response.json({})
  }

  private async _channel(id: string): Promise<Pick<ChannelChat, 'kind' | 'title'>> {
    const c = await this._api<{ type?: string; display_name?: string }>('GET', `channels/${id}`).catch(
      () => ({}) as { type?: string; display_name?: string },
    )
    const known = {
      kind: c.type === 'D' ? 'dm' : 'group',
      ...(c.type !== 'D' && c.display_name ? { title: c.display_name } : {}),
    } as const
    this._channels.set(id, known)
    return known
  }

  private _file(info: MmFileInfo): InboundFile {
    const mimeType = info.mime_type || 'application/octet-stream'
    return {
      kind: kindOf(mimeType),
      name: info.name || `file-${info.id}`,
      mimeType,
      ...(info.size ? { size: info.size } : {}),
      read: async () => {
        const res = await fetch(`${this._base}/api/v4/files/${encodeURIComponent(info.id)}`, {
          headers: { authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(REQUEST_MS * 2),
        })
        if (!res.ok) throw new Error(`Mattermost answered ${res.status} for the file`)
        return new Uint8Array(await res.arrayBuffer())
      },
    }
  }

  /** A `posted` event as the hub's message; undefined for what channels ignore (its own posts, bots, system). */
  private async _inbound(data: MmPostedData): Promise<Inbound | undefined> {
    let post: MmPost
    try {
      post = JSON.parse(data.post ?? '')
    } catch {
      return undefined
    }
    const me = this._me
    if (!me || !post.id || post.user_id === me.id || post.type || post.props?.from_bot === 'true')
      return undefined
    const dm = data.channel_type === 'D'
    const known = {
      kind: dm ? 'dm' : 'group',
      ...(!dm && data.channel_display_name ? { title: data.channel_display_name } : {}),
    } as const
    this._channels.set(post.channel_id, known)
    let mentions: unknown = []
    try {
      mentions = JSON.parse(data.mentions ?? '[]')
    } catch {}
    const raw = post.message ?? ''
    const at = new RegExp(`@${me.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    const mentioned =
      dm || (Array.isArray(mentions) && mentions.includes(me.id)) || new RegExp(at.source, 'i').test(raw)
    // The event usually carries the files' details; older servers send only their ids.
    let infos: MmFileInfo[] = post.metadata?.files ?? []
    if (!infos.length && post.file_ids?.length) {
      const fetched = await Promise.all(
        post.file_ids.map((id) =>
          this._api<MmFileInfo>('GET', `files/${encodeURIComponent(id)}/info`).catch(() => undefined),
        ),
      )
      infos = fetched.filter((f): f is MmFileInfo => Boolean(f))
    }
    const files = infos.map((f) => this._file(f))
    const sender = (data.sender_name ?? '').replace(/^@/, '') || post.user_id
    return {
      messageId: post.id,
      chat: { id: post.channel_id, ...known, ...(post.root_id ? { thread: post.root_id } : {}) },
      sender: { id: post.user_id, name: sender, handle: sender },
      text: raw.replace(at, '').trim(),
      mentioned,
      ...(files.length ? { files } : {}),
      time: new Date(post.create_at || Date.now()).toISOString(),
    }
  }

  /** Mattermost renders Markdown itself; an image is shown from its bare link (Hermes's `format_message`). */
  private _props(chat: string, message: OutMessage) {
    const buttons = message.buttons?.flat() ?? []
    if (!this._actions || !buttons.length) return { attachments: [] }
    const url = this._actions.url
    return {
      attachments: [
        {
          text: '',
          actions: buttons.map((b, i) => ({
            // Mattermost routes presses by action id, which must be letters and digits only.
            id: `b${i}`,
            type: 'button',
            name: b.label,
            integration: { url, context: { data: b.data, sig: this._sign(chat, b.data) } },
          })),
        },
      ],
    }
  }

  private _text(text: string) {
    return text.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, '$1')
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const channel = chatIdOf(chat)
    const thread = threadOf(chat)
    const post = await this._api<MmPost>('POST', 'posts', {
      channel_id: channel,
      message: this._text(message.text),
      ...(thread ? { root_id: thread } : {}),
      ...(message.buttons?.length && this._actions ? { props: this._props(channel, message) } : {}),
    })
    return { chat: channel, id: post.id }
  }

  async edit(ref: SentRef, message: OutMessage): Promise<void> {
    // Props are always sent, so a post whose buttons were pressed loses them.
    await this._api('PUT', `posts/${encodeURIComponent(ref.id)}/patch`, {
      message: this._text(message.text),
      props: this._props(ref.chat, message),
    })
  }

  async typing(chat: ChannelChat | string): Promise<void> {
    const data = { channel_id: chatIdOf(chat), parent_id: threadOf(chat) ?? '' }
    const ws = this._ws
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ seq: this._seq++, action: 'user_typing', data }))
      return
    }
    if (this._me) await this._api('POST', `users/${this._me.id}/typing`, data)
  }

  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const channel = chatIdOf(chat)
    const thread = threadOf(chat)
    const form = new FormData()
    form.set('channel_id', channel)
    form.set('files', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.name)
    const uploaded = await this._api<{ file_infos?: MmFileInfo[] }>('POST', 'files', form)
    const id = uploaded.file_infos?.[0]?.id
    if (!id) throw new Error('Mattermost did not take the file')
    const post = await this._api<MmPost>('POST', 'posts', {
      channel_id: channel,
      message: file.caption ?? '',
      file_ids: [id],
      ...(thread ? { root_id: thread } : {}),
    })
    return { chat: channel, id: post.id }
  }

  /** A note only the person who pressed sees (an ephemeral post). */
  async answerPress(press: ButtonPress, note?: string): Promise<void> {
    const [channel, user] = press.id.split(':')
    if (!note || !channel || !user) return
    await this._api('POST', 'posts/ephemeral', {
      user_id: user,
      post: { channel_id: channel, message: note },
    })
  }
}
