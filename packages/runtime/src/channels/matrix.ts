import { randomBytes } from 'node:crypto'
import { channelCopy } from './copy.ts'
import { matrixHtml } from './format.ts'
import {
  type AdapterIO,
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
 * Matrix through the client-server API over plain HTTP (no SDK), ported from Hermes's adapter: a `/sync` long-poll
 * loop whose position is saved only after a batch is recorded; invites joined (the hub's access rules then decide
 * who is answered); a room is direct when `m.direct` or the invite says so, or it has two members; threads
 * (`m.thread`) are conversations of their own; in rooms a message is for the bot when `m.mentions` names it, its
 * ID or name is in the text, or it replies in a thread or to a message of the bot's. Replies go as Markdown with
 * HTML, edits as `m.replace`, files through the media repository. End-to-end encryption needs libolm or vodozemac,
 * which this does not have: encrypted rooms get a one-time note saying so.
 */

const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
/** How long one sync waits for events; the request itself gives up a little later. */
const SYNC_MS = 30_000
const SYNC_TIMEOUT_MS = SYNC_MS + 15_000
const API_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 120_000
/** A `retry_after_ms` longer than this fails the send rather than holding the chat up. */
const RETRY_MAX_MS = 30_000
/** Typing shown this long; the hub renews it every few seconds while a run works, so it lapses soon after. */
const TYPING_MS = 6000
/** Synapse's default upload limit. */
const FILE_MAX = 50 * 1024 * 1024
/** In a room just joined, messages from this long before the join are still answered. */
const JOIN_GRACE_MS = 60_000
/** Sent event IDs remembered, to know a reply to one of the bot's messages. */
const SENT_KEPT = 500
/** Errors that mean the token is no good, as opposed to a homeserver having a bad moment (Hermes's list). */
const REFUSED = new Set(['M_UNKNOWN_TOKEN', 'M_MISSING_TOKEN'])

/** Only what this adapter reads: messages, member and name changes, and encrypted events to say it cannot read. */
const SYNC_FILTER = JSON.stringify({
  presence: { not_types: ['*'] },
  account_data: { types: ['m.direct'] },
  room: {
    timeline: { types: ['m.room.message', 'm.room.encrypted', 'm.room.member', 'm.room.name'], limit: 50 },
    state: { types: ['m.room.member', 'm.room.name'], lazy_load_members: true },
    ephemeral: { not_types: ['*'] },
    account_data: { not_types: ['*'] },
  },
})
/** The first sync only learns where "now" is: history from before the channel started is not answered. */
const FIRST_FILTER = JSON.stringify({
  presence: { not_types: ['*'] },
  account_data: { types: ['m.direct'] },
  room: {
    timeline: { limit: 0 },
    state: { types: ['m.room.name'] },
    ephemeral: { not_types: ['*'] },
    account_data: { not_types: ['*'] },
  },
})

class MatrixError extends Error {
  constructor(
    /** 0 when the homeserver could not be reached. */
    readonly status: number,
    readonly errcode: string | undefined,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

/** The token is refused, or belongs to another account: retrying will not help. */
class MatrixRefused extends Error {}

interface MxEvent {
  type: string
  event_id?: string
  sender?: string
  state_key?: string
  origin_server_ts?: number
  content?: Record<string, unknown>
}
interface MxRelation {
  rel_type?: string
  event_id?: string
  is_falling_back?: boolean
  'm.in_reply_to'?: { event_id?: string }
}
interface MxSync {
  next_batch: string
  account_data?: { events?: MxEvent[] }
  rooms?: {
    join?: Record<
      string,
      {
        summary?: { 'm.joined_member_count'?: number }
        state?: { events?: MxEvent[] }
        timeline?: { events?: MxEvent[] }
      }
    >
    invite?: Record<string, { invite_state?: { events?: MxEvent[] } }>
  }
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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const enc = encodeURIComponent
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** A reply's body starts with the quoted message (`> <@a:b> text`) and a blank line; the reply is what follows. */
function stripReplyFallback(body: string): string {
  if (!body.startsWith('> ')) return body
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length && lines[i]?.startsWith('>')) i++
  return lines
    .slice(i)
    .join('\n')
    .replace(/^\s*\n/, '')
}

const MEDIA: Record<string, InboundFile['kind']> = {
  'm.image': 'image',
  'm.audio': 'audio',
  'm.video': 'video',
  'm.file': 'document',
}

export class MatrixAdapter implements ChannelAdapter {
  readonly id = 'matrix'
  readonly label = 'Matrix'
  /** Well under Matrix's 64 KB event once the HTML copy is added; edits a little slower than Telegram's. */
  readonly limits = { text: 8000, editMs: 2000, file: FILE_MAX }
  readonly can = { buttons: false, files: true, edit: true }
  private readonly homeserver: string
  private _me?: string
  private _displayName?: string
  private _abort?: AbortController
  private _loop?: Promise<void>
  /** Rooms known to be direct chats: from `m.direct`, and invites that said so. */
  private readonly _direct = new Set<string>()
  private readonly _members = new Map<string, number>()
  private readonly _titles = new Map<string, string | undefined>()
  private readonly _names = new Map<string, string>()
  private readonly _sent = new Set<string>()
  /** Threads the bot has written in: answering there needs no mention, as in a reply to it. */
  private readonly _threads = new Set<string>()
  private readonly _joining = new Set<string>()
  /** When it joined a room this run: that room's history from well before is not answered. */
  private readonly _joinedAt = new Map<string, number>()

  constructor(
    homeserver: string,
    private readonly token: string,
    private readonly userId?: string,
  ) {
    const trimmed = homeserver.trim().replace(/\/+$/, '')
    this.homeserver = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  }

  /** Never logs or throws the token (it travels in a header). */
  private async _call<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number; upload?: { data: Uint8Array; type: string } } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`${this.homeserver}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(options.upload
            ? { 'content-type': options.upload.type }
            : body !== undefined
              ? { 'content-type': 'application/json' }
              : {}),
        },
        ...(options.upload
          ? { body: new Uint8Array(options.upload.data) }
          : body !== undefined
            ? { body: JSON.stringify(body) }
            : {}),
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      })
    } catch (err) {
      if (options.signal?.aborted) throw err
      throw new MatrixError(
        0,
        undefined,
        `cannot reach the homeserver: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
    const data = (await res.json().catch(() => ({}))) as {
      errcode?: string
      error?: string
      retry_after_ms?: number
    }
    if (!res.ok) {
      const header = Number(res.headers.get('retry-after'))
      const retryAfterMs = data.retry_after_ms ?? (header > 0 ? header * 1000 : undefined)
      throw new MatrixError(
        res.status,
        data.errcode,
        data.error ?? `the homeserver answered ${res.status}`,
        res.status === 429 ? (retryAfterMs ?? 1000) : undefined,
      )
    }
    return data as T
  }

  /** Waits out a short rate limit (`M_LIMIT_EXCEEDED`) a couple of times before giving up. */
  private async _retrying<T>(attempt: () => Promise<T>): Promise<T> {
    for (let tries = 0; ; tries++) {
      try {
        return await attempt()
      } catch (err) {
        if (
          !(err instanceof MatrixError && err.retryAfterMs && err.retryAfterMs <= RETRY_MAX_MS && tries < 2)
        )
          throw err
        await sleep(err.retryAfterMs)
      }
    }
  }

  async check(): Promise<string> {
    let me: { user_id: string }
    try {
      me = await this._call<{ user_id: string }>('GET', '/_matrix/client/v3/account/whoami')
    } catch (err) {
      if (err instanceof MatrixError && (err.status === 401 || REFUSED.has(err.errcode ?? '')))
        throw new MatrixRefused(channelCopy.matrix.refused)
      throw err
    }
    if (this.userId?.trim() && this.userId.trim().toLowerCase() !== me.user_id.toLowerCase())
      throw new MatrixRefused(channelCopy.matrix.otherUser(this.userId.trim(), me.user_id))
    this._me = me.user_id
    return me.user_id
  }

  async start(io: AdapterIO): Promise<void> {
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      const wait = async (ms = backoff) => {
        // Jitter, so gateways recovering together do not hit the homeserver at the same moment.
        await sleep(ms * (0.75 + Math.random() * 0.5), signal)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
      const refused = (err: unknown) =>
        err instanceof MatrixRefused ||
        (err instanceof MatrixError && (err.status === 401 || REFUSED.has(err.errcode ?? '')))
      let account = ''
      for (;;) {
        if (signal.aborted) return
        try {
          account = await this.check()
          break
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (refused(err)) return io.status({ state: 'error', error: message })
          io.status({ state: 'retrying', error: message })
          await wait()
        }
      }
      const me = enc(account)
      this._displayName = await this._call<{ displayname?: string }>(
        'GET',
        `/_matrix/client/v3/profile/${me}/displayname`,
      ).then(
        (p) => p.displayname,
        () => undefined,
      )
      // No m.direct yet (a 404) just means no direct chats so far.
      await this._call<Record<string, string[]>>(
        'GET',
        `/_matrix/client/v3/user/${me}/account_data/m.direct`,
      ).then(
        (direct) => this._noteDirect(direct),
        () => {},
      )
      backoff = BACKOFF_MIN_MS
      let since = io.get('since')
      let online = false
      while (!signal.aborted) {
        try {
          const query = since
            ? `since=${enc(since)}&timeout=${SYNC_MS}&filter=${enc(SYNC_FILTER)}`
            : `timeout=0&filter=${enc(FIRST_FILTER)}`
          const sync = await this._call<MxSync>('GET', `/_matrix/client/v3/sync?${query}`, undefined, {
            signal,
            timeoutMs: SYNC_TIMEOUT_MS,
          })
          if (!online) io.status({ state: 'on', account })
          online = true
          backoff = BACKOFF_MIN_MS
          await this._absorb(io, sync, Boolean(since))
          // Saved only once the batch is recorded, so a crash re-delivers rather than loses it.
          since = sync.next_batch
          io.set('since', since)
        } catch (err) {
          if (signal.aborted) break
          if (refused(err)) {
            io.status({ state: 'error', error: channelCopy.matrix.refused })
            break
          }
          online = false
          io.status({ state: 'retrying', error: err instanceof Error ? err.message : String(err) })
          await wait(err instanceof MatrixError && err.retryAfterMs ? err.retryAfterMs : backoff)
        }
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
  }

  private _noteDirect(direct: unknown) {
    if (!direct || typeof direct !== 'object') return
    for (const rooms of Object.values(direct as Record<string, unknown>))
      if (Array.isArray(rooms)) for (const room of rooms) if (typeof room === 'string') this._direct.add(room)
  }

  /** One sync: what it says about rooms and people, invites joined, and (after the first) its messages handed on. */
  private async _absorb(io: AdapterIO, sync: MxSync, deliver: boolean) {
    for (const e of sync.account_data?.events ?? []) if (e.type === 'm.direct') this._noteDirect(e.content)
    for (const [room, invited] of Object.entries(sync.rooms?.invite ?? {})) {
      const mine = invited.invite_state?.events?.find(
        (e) => e.type === 'm.room.member' && e.state_key === this._me,
      )
      void this._join(io, room, mine?.content?.is_direct === true)
    }
    for (const [room, joined] of Object.entries(sync.rooms?.join ?? {})) {
      const count = joined.summary?.['m.joined_member_count']
      if (typeof count === 'number') this._members.set(room, count)
      const events = [...(joined.state?.events ?? []), ...(joined.timeline?.events ?? [])]
      for (const e of events) {
        if (e.type === 'm.room.name') this._titles.set(room, str(e.content?.name) || undefined)
        if (e.type === 'm.room.member' && e.state_key) {
          const name = str(e.content?.displayname)
          if (name) this._names.set(e.state_key, name)
          // Someone joined or left: counted again when next needed, unless the summary already said.
          if (typeof count !== 'number') this._members.delete(room)
        }
      }
      if (!deliver) continue
      const joinedAt = this._joinedAt.get(room)
      for (const e of joined.timeline?.events ?? []) {
        // A room just joined comes with its recent history; only what was written about when the bot was invited
        // (the inviter's first message) is answered.
        if (joinedAt && (e.origin_server_ts ?? 0) < joinedAt - JOIN_GRACE_MS) continue
        if (e.type === 'm.room.encrypted') await this._encrypted(io, room, e)
        if (e.type !== 'm.room.message') continue
        const message = await this._inbound(room, e).catch((err) => {
          io.log(`could not read a message: ${err instanceof Error ? err.message : String(err)}`)
          return undefined
        })
        if (message) await io.receive(message)
      }
    }
  }

  /** Joins a room it was invited to; a dead invite (the room is gone) is declined so it is not tried every start. */
  private async _join(io: AdapterIO, room: string, direct: boolean) {
    if (this._joining.has(room)) return
    this._joining.add(room)
    try {
      // Noted before joining: the sync already waiting may bring the room back before this call returns.
      this._joinedAt.set(room, Date.now())
      await this._call('POST', `/_matrix/client/v3/join/${enc(room)}`, {})
      if (direct) this._direct.add(room)
    } catch (err) {
      this._joinedAt.delete(room)
      const message = err instanceof Error ? err.message : String(err)
      io.log(`could not join ${room}: ${message}`)
      if (/no servers|not found|unknown room/i.test(message))
        await this._call('POST', `/_matrix/client/v3/rooms/${enc(room)}/leave`, {}).catch(() => {})
    } finally {
      this._joining.delete(room)
    }
  }

  /** Once per room, it says it cannot read encrypted messages; otherwise the bot would just seem deaf there. */
  private async _encrypted(io: AdapterIO, room: string, e: MxEvent) {
    if (!e.sender || this._isMe(e.sender) || io.get(`encrypted:${room}`)) return
    io.set(`encrypted:${room}`, new Date().toISOString())
    io.log(`${room} is encrypted, which this channel cannot read`)
    await this.send(room, { text: channelCopy.matrix.encrypted }).catch(() => {})
  }

  private _isMe(user: string) {
    return Boolean(this._me) && user.trim().toLowerCase() === this._me?.toLowerCase()
  }

  private async _memberCount(room: string): Promise<number | undefined> {
    const known = this._members.get(room)
    if (known !== undefined) return known
    const got = await this._call<{ joined?: Record<string, unknown> }>(
      'GET',
      `/_matrix/client/v3/rooms/${enc(room)}/joined_members`,
    ).catch(() => undefined)
    const count = got?.joined ? Object.keys(got.joined).length : undefined
    if (count !== undefined) this._members.set(room, count)
    return count
  }

  private async _title(room: string): Promise<string | undefined> {
    if (this._titles.has(room)) return this._titles.get(room)
    const got = await this._call<{ name?: string }>(
      'GET',
      `/_matrix/client/v3/rooms/${enc(room)}/state/m.room.name`,
    )
      .then((s) => s.name || undefined)
      .catch(() => undefined)
    this._titles.set(room, got)
    return got
  }

  private async _name(user: string): Promise<string> {
    const known = this._names.get(user)
    if (known) return known
    const got = await this._call<{ displayname?: string }>(
      'GET',
      `/_matrix/client/v3/profile/${enc(user)}/displayname`,
    )
      .then((p) => p.displayname)
      .catch(() => undefined)
    const name = got || user.replace(/^@/, '').split(':')[0] || user
    this._names.set(user, name)
    return name
  }

  /** A room message as the hub's; undefined for what channels ignore (its own, bridges, notices, edits). */
  private async _inbound(room: string, e: MxEvent): Promise<Inbound | undefined> {
    const sender = e.sender ?? ''
    const content = e.content ?? {}
    // Bridge and appservice users (`@_telegram_123:server`) would loop the bot's own messages back (Hermes).
    const localpartOf = (user: string) => user.replace(/^@/, '').split(':')[0] ?? ''
    if (!e.event_id || !sender || this._isMe(sender) || localpartOf(sender).startsWith('_')) return undefined
    const relation = (content['m.relates_to'] ?? {}) as MxRelation
    // Edits are not new messages, and notices are what bots send (answering them is how bots loop).
    if (relation.rel_type === 'm.replace') return undefined
    const msgtype = str(content.msgtype) ?? ''
    if (msgtype === 'm.notice') return undefined
    const thread = relation.rel_type === 'm.thread' ? relation.event_id : undefined
    const replyTo = relation.is_falling_back ? undefined : relation['m.in_reply_to']?.event_id
    let body = str(content.body) ?? ''
    if (relation['m.in_reply_to']) body = stripReplyFallback(body)
    const direct = this._direct.has(room) || ((await this._memberCount(room)) ?? 3) <= 2
    const me = this._me ?? ''
    const localpart = localpartOf(me)
    const userIds = (content['m.mentions'] as { user_ids?: unknown } | undefined)?.user_ids
    const word = (w: string) => new RegExp(`(?<!\\w)${escapeRegExp(w)}\\b`, 'i')
    const leadingName = this._displayName
      ? new RegExp(`^\\s*${escapeRegExp(this._displayName)}\\s*[:,]`, 'i')
      : undefined
    const mentioned =
      direct ||
      (Array.isArray(userIds) && userIds.some((u) => typeof u === 'string' && this._isMe(u))) ||
      (Boolean(me) && body.toLowerCase().includes(me.toLowerCase())) ||
      (Boolean(localpart) && word(localpart).test(body)) ||
      Boolean(leadingName?.test(body)) ||
      Boolean(me && str(content.formatted_body)?.includes(`matrix.to/#/${me}`)) ||
      Boolean(replyTo && this._sent.has(replyTo)) ||
      Boolean(thread && (this._threads.has(thread) || this._sent.has(thread)))
    const strip = (text: string) => {
      let out = text
      if (me) out = out.replace(new RegExp(escapeRegExp(me), 'gi'), '')
      if (localpart) out = out.replace(new RegExp(`(?<![\\w])@${escapeRegExp(localpart)}\\b`, 'gi'), '')
      if (leadingName) out = out.replace(leadingName, '')
      return out
        .replace(/^\s*[:,]\s*/, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    }
    const kind = MEDIA[msgtype]
    const files: InboundFile[] = []
    let text = strip(body)
    let unsupported = false
    if (kind) {
      const url = str(content.url)
      const filename = str(content.filename)
      // A caption is the body when a file name is given separately (MSC2530); otherwise the body is the name.
      text = filename && filename !== body ? strip(body) : ''
      const info = (content.info ?? {}) as { mimetype?: string; size?: number }
      const voice = kind === 'audio' && 'org.matrix.msc3245.voice' in content
      if (url?.startsWith('mxc://'))
        files.push({
          kind: voice ? 'voice' : kind,
          name: filename || body || `matrix-${e.event_id.slice(1, 9)}`,
          mimeType: info.mimetype || 'application/octet-stream',
          ...(info.size ? { size: info.size } : {}),
          read: () => this._download(url, info.size),
        })
      // Encrypted media (content.file) cannot be decrypted here.
      else unsupported = true
    }
    if (!text && !files.length && !unsupported) return undefined
    const title = direct ? undefined : await this._title(room)
    const chat: ChannelChat = {
      id: room,
      kind: direct ? 'dm' : 'group',
      ...(title ? { title } : {}),
      ...(thread ? { thread } : {}),
    }
    return {
      messageId: e.event_id,
      chat,
      sender: { id: sender, name: await this._name(sender), handle: sender },
      text,
      mentioned,
      ...(files.length ? { files } : {}),
      ...(unsupported && !text && !files.length ? { unsupported: true } : {}),
      time: new Date(e.origin_server_ts ?? Date.now()).toISOString(),
    }
  }

  /** Authenticated media (Matrix 1.11), falling back to the older unauthenticated path on servers without it. */
  private async _download(mxc: string, size?: number): Promise<Uint8Array> {
    if (size && size > FILE_MAX) throw new Error('Matrix media is at most 50 MB here')
    const [server, media] = mxc.slice('mxc://'.length).split('/')
    if (!server || !media) throw new Error('not a Matrix media address')
    const where = `${enc(server)}/${enc(media)}`
    for (const path of [
      `/_matrix/client/v1/media/download/${where}`,
      `/_matrix/media/v3/download/${where}`,
    ]) {
      const res = await fetch(`${this.homeserver}${path}`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      }).catch(() => undefined)
      if (res?.ok) return new Uint8Array(await res.arrayBuffer())
      if (res && res.status !== 404 && res.status !== 400 && res.status !== 405)
        throw new Error(`the homeserver answered ${res.status} for the file`)
    }
    throw new Error('the homeserver did not have the file')
  }

  private async _event(room: string, content: Record<string, unknown>): Promise<string> {
    const txn = randomBytes(12).toString('hex')
    const sent = await this._retrying(() =>
      this._call<{ event_id: string }>(
        'PUT',
        `/_matrix/client/v3/rooms/${enc(room)}/send/m.room.message/${txn}`,
        content,
      ),
    )
    this._sent.add(sent.event_id)
    for (const old of this._sent) {
      if (this._sent.size <= SENT_KEPT) break
      this._sent.delete(old)
    }
    return sent.event_id
  }

  /** In a thread, replies stay in it; clients without threads see them as replies to its first message. */
  private _relation(chat: ChannelChat | string) {
    const thread = threadOf(chat)
    if (!thread) return {}
    this._threads.add(thread)
    return {
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: thread,
        is_falling_back: true,
        'm.in_reply_to': { event_id: thread },
      },
    }
  }

  /** Markdown as the body (readable as is) with HTML alongside; `m.mentions` empty, so a reply pings no one. */
  private _text(markdown: string) {
    return {
      msgtype: 'm.text',
      body: markdown,
      format: 'org.matrix.custom.html',
      formatted_body: matrixHtml(markdown),
      'm.mentions': {},
    }
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const room = chatIdOf(chat)
    const id = await this._event(room, { ...this._text(message.text), ...this._relation(chat) })
    return { chat: room, id }
  }

  /** An `m.replace` event: clients show the new content in place; ones without edits show the `* ` copy. */
  async edit(ref: SentRef, message: OutMessage): Promise<void> {
    const content = this._text(message.text)
    await this._event(ref.chat, {
      ...content,
      body: `* ${content.body}`,
      formatted_body: `* ${content.formatted_body}`,
      'm.new_content': content,
      'm.relates_to': { rel_type: 'm.replace', event_id: ref.id },
    })
  }

  async typing(chat: ChannelChat | string): Promise<void> {
    if (!this._me) return
    await this._call('PUT', `/_matrix/client/v3/rooms/${enc(chatIdOf(chat))}/typing/${enc(this._me)}`, {
      typing: true,
      timeout: TYPING_MS,
    })
  }

  /** Uploaded to the media repository, then sent as an image, video, audio or file message pointing at it. */
  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    if (file.data.byteLength > FILE_MAX) throw new Error('Matrix media is at most 50 MB here')
    const room = chatIdOf(chat)
    const uploaded = await this._retrying(() =>
      this._call<{ content_uri: string }>(
        'POST',
        `/_matrix/media/v3/upload?filename=${enc(file.name)}`,
        undefined,
        { upload: { data: file.data, type: file.mimeType }, timeoutMs: UPLOAD_TIMEOUT_MS },
      ),
    )
    const msgtype = file.mimeType.startsWith('image/')
      ? 'm.image'
      : file.mimeType.startsWith('video/')
        ? 'm.video'
        : file.mimeType.startsWith('audio/')
          ? 'm.audio'
          : 'm.file'
    const id = await this._event(room, {
      msgtype,
      body: file.caption || file.name,
      filename: file.name,
      url: uploaded.content_uri,
      info: { mimetype: file.mimeType, size: file.data.byteLength },
      'm.mentions': {},
      ...this._relation(chat),
    })
    return { chat: room, id }
  }
}
