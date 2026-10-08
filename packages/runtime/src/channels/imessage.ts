import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { channelCopy } from './copy.ts'
import { plainText } from './format.ts'
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
} from './types.ts'

/**
 * iMessage through a BlueBubbles server's REST API (a Mac signed in to the Apple ID, with BlueBubbles running),
 * ported from Hermes's adapter: a webhook registered with the server when the gateway has a public address (with a
 * secret of its own in the URL, since BlueBubbles cannot send headers), otherwise polling its message query from
 * the last message seen; chats by GUID (`iMessage;-;…` direct, `iMessage;+;…` group); tapbacks and own messages
 * skipped; attachments in and out; typing when the server's private API is on. iMessage has no bot identity, so in
 * groups a message is for it when it starts with or @mentions its name (Hermes's wake words), or replies to it.
 * Messages are plain text; no buttons or edits (neither project edits through BlueBubbles).
 */

const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
/** How often the server is asked for new messages when it cannot push them (it is usually on the same network). */
const POLL_MS = 2000
const API_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 120_000
/** iMessage's practical attachment limit. */
const FILE_MAX = 100 * 1024 * 1024
/** Message GUIDs remembered, to know a reply to the bot's own message. */
const SENT_KEPT = 500
const DEFAULT_NAME = 'Myrmidon'

class BlueBubblesError extends Error {
  constructor(
    /** 0 when the server could not be reached. */
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

interface BbHandle {
  address?: string
}
interface BbChat {
  guid?: string
  displayName?: string | null
  chatIdentifier?: string
  participants?: BbHandle[]
}
interface BbAttachment {
  guid?: string
  mimeType?: string | null
  transferName?: string | null
  totalBytes?: number | null
  uti?: string | null
}
interface BbMessage {
  guid?: string
  text?: string | null
  isFromMe?: boolean
  dateCreated?: number
  handle?: BbHandle | null
  chats?: BbChat[]
  attachments?: BbAttachment[]
  associatedMessageType?: string | number | null
  threadOriginatorGuid?: string | null
  isAudioMessage?: boolean
  itemType?: number
  balloonBundleId?: string | null
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

function fileKind(a: BbAttachment, audioMessage: boolean): InboundFile['kind'] {
  const mime = a.mimeType ?? ''
  if (mime.startsWith('image/')) return 'image'
  if (audioMessage || mime.startsWith('audio/') || a.uti?.endsWith('caf')) return 'voice'
  if (mime.startsWith('video/')) return 'video'
  return 'document'
}

export class IMessageAdapter implements ChannelAdapter {
  readonly id = 'imessage'
  readonly label = 'iMessage'
  readonly limits = { text: 4000, editMs: 1500, file: FILE_MAX }
  readonly can = { buttons: false, files: true, edit: false }
  private readonly url: string
  private readonly name: string
  private readonly _wake: RegExp
  private _me?: string
  /** BlueBubbles' private API (with its helper connected) is what shows typing. */
  private _privateApi = false
  private _secret?: string
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  private readonly _sent = new Set<string>()

  constructor(
    url: string,
    private readonly password: string,
    name?: string,
  ) {
    const trimmed = url.trim().replace(/\/+$/, '')
    this.url = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
    this.name = name?.trim() || DEFAULT_NAME
    this._wake = new RegExp(`(?<![\\w@])@?${escapeRegExp(this.name)}\\b[,:\\-]?`, 'i')
  }

  /** Never logs or throws the URL: it carries the password, which BlueBubbles takes only as a query parameter. */
  private async _api<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown> | FormData,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = `${this.url}${path}${path.includes('?') ? '&' : '?'}password=${encodeURIComponent(this.password)}`
    const timeout = AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, {
        method,
        ...(body instanceof FormData
          ? { body }
          : body
            ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      })
    } catch (err) {
      if (options.signal?.aborted) throw err
      throw new BlueBubblesError(
        0,
        `cannot reach the BlueBubbles server: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
    const data = (await res.json().catch(() => undefined)) as
      | { status?: number; message?: string; error?: { message?: string }; data?: T }
      | undefined
    if (res.status === 401 || data?.status === 401)
      throw new BlueBubblesError(401, channelCopy.imessage.refused)
    if (!res.ok || (data?.status !== undefined && data.status >= 400))
      throw new BlueBubblesError(
        data?.status ?? res.status,
        data?.error?.message ?? data?.message ?? `BlueBubbles answered ${res.status}`,
      )
    return data?.data as T
  }

  /** Reaches the server with the password and says which Apple ID it is signed in to. */
  async check(): Promise<string> {
    const info = await this._api<{
      private_api?: boolean
      helper_connected?: boolean
      detected_imessage?: string | null
      detected_icloud?: string | null
    }>('GET', '/api/v1/server/info')
    this._privateApi = Boolean(info?.private_api && info.helper_connected)
    this._me = info?.detected_imessage || info?.detected_icloud || undefined
    return this._me ?? 'BlueBubbles'
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      const wait = async () => {
        await sleep(backoff * (0.75 + Math.random() * 0.5), signal)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
      let account = ''
      for (;;) {
        if (signal.aborted) return
        try {
          account = await this.check()
          break
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (err instanceof BlueBubblesError && err.code === 401)
            return io.status({ state: 'error', error: message })
          io.status({ state: 'retrying', error: message })
          await wait()
        }
      }
      if (io.webhookUrl) {
        try {
          await this._register(io, io.webhookUrl)
          io.status({ state: 'on', account })
        } catch (err) {
          io.status({ state: 'error', error: err instanceof Error ? err.message : String(err) })
        }
        return
      }
      io.status({ state: 'on', account })
      await this._poll(io, account, signal)
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
  }

  /**
   * Registers this gateway's webhook with the server, carrying a secret of its own (BlueBubbles posts to the exact
   * URL and cannot set headers); a registration left from before with another secret is removed, so one gateway
   * gets each message once.
   */
  private async _register(io: AdapterIO, base: string) {
    this._secret = io.get('webhook-secret') ?? randomBytes(24).toString('base64url')
    io.set('webhook-secret', this._secret)
    const target = `${base}?token=${this._secret}`
    const hooks = (await this._api<{ id: number; url: string }[]>('GET', '/api/v1/webhook')) ?? []
    for (const hook of hooks)
      if (hook.url.startsWith(base) && hook.url !== target)
        await this._api('DELETE', `/api/v1/webhook/${hook.id}`).catch(() => {})
    if (!hooks.some((h) => h.url === target))
      await this._api('POST', '/api/v1/webhook', { url: target, events: ['new-message'] })
  }

  /**
   * Asks for messages newer than the last one seen (saved, so a restart misses nothing; the first start begins
   * now). The query includes that last moment again, which the hub drops as a redelivery.
   */
  private async _poll(io: AdapterIO, account: string, signal: AbortSignal) {
    let after = Number(io.get('after') ?? 0) || Date.now()
    io.set('after', String(after))
    let backoff = BACKOFF_MIN_MS
    while (!signal.aborted) {
      try {
        const messages = await this._api<BbMessage[]>(
          'POST',
          '/api/v1/message/query',
          {
            limit: 100,
            offset: 0,
            after,
            sort: 'ASC',
            with: ['chat', 'chat.participants', 'attachment', 'handle'],
          },
          { signal },
        )
        if (backoff !== BACKOFF_MIN_MS) io.status({ state: 'on', account })
        backoff = BACKOFF_MIN_MS
        for (const m of messages ?? []) {
          const message = this._inbound(m)
          if (message) await io.receive(message)
          // Saved only once the message is recorded, so a crash re-delivers rather than loses it.
          if (m.dateCreated && m.dateCreated > after) {
            after = m.dateCreated
            io.set('after', String(after))
          }
        }
        await sleep(POLL_MS, signal)
      } catch (err) {
        if (signal.aborted) break
        const message = err instanceof Error ? err.message : String(err)
        if (err instanceof BlueBubblesError && err.code === 401) {
          io.status({ state: 'error', error: message })
          break
        }
        io.status({ state: 'retrying', error: message })
        await sleep(backoff * (0.75 + Math.random() * 0.5), signal)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    }
  }

  /** A message the server pushed, accepted only with the secret registered with it. */
  async webhook(req: Request): Promise<Response> {
    const given = Buffer.from(new URL(req.url).searchParams.get('token') ?? '')
    const secret = Buffer.from(this._secret ?? '')
    if (!secret.length || given.length !== secret.length || !timingSafeEqual(given, secret))
      return new Response('unauthorized', { status: 401 })
    const raw = await req.text()
    let payload: { type?: string; event?: string; data?: unknown } | undefined
    try {
      payload = JSON.parse(raw)
    } catch {
      // Some versions post a form with the JSON in one field (Hermes reads both).
      const form = new URLSearchParams(raw)
      const field = form.get('payload') ?? form.get('data')
      try {
        payload = field ? JSON.parse(field) : undefined
      } catch {
        return new Response('bad payload', { status: 400 })
      }
    }
    if ((payload?.type ?? payload?.event) !== 'new-message') return new Response('ok')
    const record = Array.isArray(payload?.data) ? payload.data[0] : payload?.data
    const message = record && typeof record === 'object' ? this._inbound(record as BbMessage) : undefined
    if (message) await this._io?.receive(message)
    return new Response('ok')
  }

  /** A BlueBubbles message as the hub's; undefined for what channels ignore (own messages, tapbacks, group events). */
  private _inbound(m: BbMessage): Inbound | undefined {
    if (!m.guid || m.isFromMe) return undefined
    // Tapbacks arrive as messages pointing at another (2000–2005 added, 3000–3005 removed); group renames and
    // member changes have an item type of their own.
    if (m.associatedMessageType && String(m.associatedMessageType) !== '0') return undefined
    if (m.itemType) return undefined
    const c = m.chats?.[0]
    const sender = m.handle?.address
    if (!c?.guid || !sender) return undefined
    const group = c.guid.includes(';+;') || (c.participants?.length ?? 0) > 1
    const chat: ChannelChat = {
      id: c.guid,
      kind: group ? 'group' : 'dm',
      ...(group && c.displayName ? { title: c.displayName } : {}),
    }
    // Attachments sit in the text as U+FFFC placeholders.
    const raw = (m.text ?? '').replace(/￼/g, '').trim()
    const me = this._me?.toLowerCase()
    const mentioned =
      !group ||
      this._wake.test(raw) ||
      Boolean(me && raw.toLowerCase().includes(me)) ||
      Boolean(m.threadOriginatorGuid && this._sent.has(m.threadOriginatorGuid))
    const text = group
      ? raw
          .replace(new RegExp(`^\\s*${this._wake.source}\\s*`, 'i'), '')
          .replace(new RegExp(`(?<![\\w@])@${escapeRegExp(this.name)}\\b`, 'gi'), '')
          .replace(/[ \t]{2,}/g, ' ')
          .trim()
      : raw
    const files: InboundFile[] = (m.attachments ?? [])
      .filter((a): a is BbAttachment & { guid: string } => Boolean(a.guid))
      .map((a) => ({
        kind: fileKind(a, Boolean(m.isAudioMessage)),
        name: a.transferName || `imessage-${a.guid.slice(0, 8)}`,
        mimeType: a.mimeType || 'application/octet-stream',
        ...(a.totalBytes ? { size: a.totalBytes } : {}),
        read: async () => {
          if (a.totalBytes && a.totalBytes > FILE_MAX)
            throw new Error('iMessage attachments are at most 100 MB')
          const res = await fetch(
            `${this.url}/api/v1/attachment/${encodeURIComponent(a.guid)}/download?password=${encodeURIComponent(this.password)}`,
            { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) },
          ).catch(() => undefined)
          if (!res?.ok) throw new Error(`BlueBubbles answered ${res?.status ?? 'nothing'} for the attachment`)
          return new Uint8Array(await res.arrayBuffer())
        },
      }))
    // Stickers, Apple Pay and app messages come with a balloon bundle and no text the crew could use.
    const unsupported = !text && !files.length && Boolean(m.balloonBundleId)
    if (!text && !files.length && !unsupported) return undefined
    return {
      messageId: m.guid,
      chat,
      sender: { id: sender, name: sender, handle: sender },
      text,
      mentioned,
      ...(files.length ? { files } : {}),
      ...(unsupported ? { unsupported: true } : {}),
      time: new Date(m.dateCreated ?? Date.now()).toISOString(),
    }
  }

  private _remember(guid?: string) {
    if (!guid) return
    this._sent.add(guid)
    for (const old of this._sent) {
      if (this._sent.size <= SENT_KEPT) break
      this._sent.delete(old)
    }
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const chatGuid = chatIdOf(chat)
    const tempGuid = randomUUID()
    const sent = await this._api<{ guid?: string } | undefined>('POST', '/api/v1/message/text', {
      chatGuid,
      tempGuid,
      message: plainText(message.text),
    })
    this._remember(sent?.guid)
    return { chat: chatGuid, id: sent?.guid ?? tempGuid }
  }

  /**
   * BlueBubbles can edit (macOS 13 and its private API), but neither project does, so `can.edit` is false: the hub
   * keeps no status line, and the notes it adds to a sent message (an approval decided) are left out.
   */
  async edit(_ref: SentRef, _message: OutMessage): Promise<void> {}

  /** Only BlueBubbles' private API can show typing; without it there is nothing to do. */
  async typing(chat: ChannelChat | string): Promise<void> {
    if (!this._privateApi) return
    await this._api('POST', `/api/v1/chat/${encodeURIComponent(chatIdOf(chat))}/typing`)
  }

  /** Uploaded as a multipart form; a caption follows as its own message, as iMessage shows them. */
  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const chatGuid = chatIdOf(chat)
    if (file.data.byteLength > FILE_MAX) throw new Error('iMessage attachments are at most 100 MB')
    const tempGuid = randomUUID()
    const form = new FormData()
    form.set('chatGuid', chatGuid)
    form.set('tempGuid', tempGuid)
    form.set('name', file.name)
    form.set('attachment', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.name)
    const sent = await this._api<{ guid?: string } | undefined>('POST', '/api/v1/message/attachment', form, {
      timeoutMs: UPLOAD_TIMEOUT_MS,
    })
    this._remember(sent?.guid)
    if (file.caption) await this.send(chatGuid, { text: file.caption })
    return { chat: chatGuid, id: sent?.guid ?? tempGuid }
  }
}
