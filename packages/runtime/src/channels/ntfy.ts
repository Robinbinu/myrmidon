import { channelCopy } from './copy.ts'
import type {
  AdapterIO,
  ChannelAdapter,
  ChannelChat,
  Inbound,
  InboundFile,
  OutFile,
  OutMessage,
  SentRef,
} from './types.ts'

/**
 * ntfy (a publish/subscribe push service) over plain HTTP, ported from Hermes's adapter: the topic's JSON stream
 * (`/<topic>/json`) read with reconnects, resuming after the last message seen (`since`), and messages published by
 * POST with Markdown on. ntfy has no senders, so a topic is one conversation with one "person"; whoever knows the
 * topic can read and write it, so it must be unguessable (or protected by a token), and the hub's access rules
 * still apply. Our own messages come back on the stream and are recognized by their tag.
 */

export const NTFY_SERVER = 'https://ntfy.sh'
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
/** ntfy sends a keepalive every 45 s by default; this much silence means the stream is dead. */
const IDLE_MS = 90_000
/** ntfy's message limit is 4096 bytes (longer ones become attachments), so characters leave room for UTF-8. */
const MESSAGE_MAX = 3500
/** ntfy.sh takes attachments up to 15 MB. */
const FILE_MAX = 15 * 1024 * 1024
const REQUEST_MS = 30_000
/** Marks what Myrmidon published, so it is not read back as a message. */
const ECHO_TAG = 'myrmidon'
/** The one conversation a topic is; a fixed id, since the topic itself is secret. */
const CHAT = 'topic'

class NtfyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface NtfyEvent {
  id?: string
  time?: number
  event?: string
  topic?: string
  message?: string
  title?: string
  tags?: string[]
  attachment?: { name?: string; type?: string; size?: number; url?: string }
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

export class NtfyAdapter implements ChannelAdapter {
  readonly id = 'ntfy'
  readonly label = 'ntfy'
  readonly limits = { text: MESSAGE_MAX, editMs: 60_000, file: FILE_MAX }
  readonly can = { buttons: false, files: true, edit: false }
  private readonly _server: string
  private _abort?: AbortController
  private _loop?: Promise<void>

  constructor(
    server: string,
    private readonly topic: string,
    private readonly token = '',
  ) {
    const s = (server.trim() || NTFY_SERVER).replace(/\/+$/, '')
    this._server = /^https?:\/\//i.test(s) ? s : `https://${s}`
  }

  /** A token as `user:password` is Basic auth, anything else a Bearer token (Hermes). */
  private get _auth(): Record<string, string> {
    const t = this.token.trim()
    if (!t) return {}
    return {
      authorization: t.includes(':') ? `Basic ${Buffer.from(t).toString('base64')}` : `Bearer ${t}`,
    }
  }

  private get _topicUrl() {
    return `${this._server}/${encodeURIComponent(this.topic)}`
  }

  /** Never logs or throws the topic or the token. */
  private async _fetch(url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response
    try {
      res = await fetch(url, { ...init, headers: { ...this._auth, ...(init.headers as object) } })
    } catch (err) {
      if (init.signal?.aborted) throw err
      throw new NtfyError(0, `cannot reach ntfy: ${err instanceof Error ? err.name : 'network error'}`)
    }
    if (res.status === 401 || res.status === 403)
      throw new NtfyError(res.status, channelCopy.errors.ntfyRefused)
    if (!res.ok) throw new NtfyError(res.status, `ntfy answered ${res.status}`)
    return res
  }

  async check(): Promise<string> {
    if (!/^[-_A-Za-z0-9]{1,64}$/.test(this.topic)) throw new Error(channelCopy.errors.ntfyTopic)
    if (this.topic.length < 12 && !this.token.trim()) throw new Error(channelCopy.errors.ntfyGuessable)
    // Messages from now on: none, so this only checks the topic can be read with these credentials.
    const res = await this._fetch(`${this._topicUrl}/json?poll=1&since=${Math.floor(Date.now() / 1000)}`, {
      signal: AbortSignal.timeout(REQUEST_MS),
    })
    await res.body?.cancel()
    return new URL(this._server).host
  }

  async start(io: AdapterIO): Promise<void> {
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      let account: string | undefined
      while (!signal.aborted) {
        try {
          account ??= await this.check()
          await this._stream(io, account, signal, () => {
            backoff = BACKOFF_MIN_MS
          })
          if (signal.aborted) return
          io.status({ state: 'retrying', error: 'the ntfy stream closed' })
        } catch (err) {
          if (signal.aborted) return
          const message = err instanceof Error ? err.message : String(err)
          if (
            message === channelCopy.errors.ntfyRefused ||
            message === channelCopy.errors.ntfyTopic ||
            message === channelCopy.errors.ntfyGuessable ||
            (err instanceof NtfyError && err.status === 404)
          )
            return io.status({ state: 'error', error: message })
          io.status({ state: 'retrying', error: message })
        }
        await sleep(backoff * (0.75 + Math.random() * 0.5), signal)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    })()
  }

  /** One subscription: reads newline-delimited JSON until the stream ends, goes quiet or is stopped. */
  private async _stream(io: AdapterIO, account: string, stop: AbortSignal, connected: () => void) {
    const idle = new AbortController()
    let timer = setTimeout(() => idle.abort(), IDLE_MS)
    const alive = () => {
      clearTimeout(timer)
      timer = setTimeout(() => idle.abort(), IDLE_MS)
    }
    try {
      const since = io.get('since')
      const res = await this._fetch(
        `${this._topicUrl}/json${since ? `?since=${encodeURIComponent(since)}` : ''}`,
        {
          signal: AbortSignal.any([stop, idle.signal]),
        },
      )
      const reader = res.body?.getReader()
      if (!reader) return
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        alive()
        buffer += decoder.decode(value, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
          if (!line) continue
          let event: NtfyEvent
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          if (event.event === 'open') {
            connected()
            io.status({ state: 'on', account })
          }
          if (event.event !== 'message' || !event.id) continue
          const message = this._inbound(event)
          if (message) await io.receive(message)
          // Saved only once the message is recorded, so a restart resumes after it rather than losing it.
          io.set('since', event.id)
        }
      }
    } catch (err) {
      // Silence or a stop ends the stream quietly; the loop reconnects (or not).
      if (idle.signal.aborted || stop.aborted) return
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
  }

  private _attachment(a: NonNullable<NtfyEvent['attachment']>, id: string): InboundFile | undefined {
    // Only files kept by this server: an attachment can be any URL the publisher chose.
    if (!a.url || !URL.canParse(a.url) || new URL(a.url).origin !== new URL(this._server).origin)
      return undefined
    const url = a.url
    const mimeType = a.type || 'application/octet-stream'
    return {
      kind: kindOf(mimeType),
      name: a.name || `file-${id}`,
      mimeType,
      ...(a.size ? { size: a.size } : {}),
      read: async () => {
        const res = await this._fetch(url, { signal: AbortSignal.timeout(REQUEST_MS * 2) })
        return new Uint8Array(await res.arrayBuffer())
      },
    }
  }

  private _inbound(e: NtfyEvent): Inbound | undefined {
    if (!e.id || e.tags?.includes(ECHO_TAG)) return undefined
    const file = e.attachment && this._attachment(e.attachment, e.id)
    // ntfy fills an attachment's message with its name when none was given.
    const text = (e.message ?? '').trim()
    const body = file && text === e.attachment?.name ? '' : text
    if (!body && !file) return undefined
    return {
      messageId: e.id,
      chat: { id: CHAT, kind: 'dm' },
      // The title is the publisher's to choose, so it never stands for who is writing.
      sender: { id: CHAT, name: channelCopy.ntfySender },
      text: body,
      mentioned: true,
      ...(file ? { files: [file] } : {}),
      time: new Date((e.time ?? Date.now() / 1000) * 1000).toISOString(),
    }
  }

  async send(_chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const res = await this._fetch(this._topicUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8', markdown: 'yes', tags: ECHO_TAG },
      body: message.text,
      signal: AbortSignal.timeout(REQUEST_MS),
    })
    const sent = (await res.json().catch(() => ({}))) as { id?: string }
    return { chat: CHAT, id: sent.id ?? '' }
  }

  /** A published notification cannot be changed; an edit sends nothing rather than a second one. */
  async edit(_ref: SentRef, _message: OutMessage): Promise<void> {}

  async typing(_chat: ChannelChat | string): Promise<void> {}

  /** A file as an ntfy attachment (PUT with the file as the body); name and caption go in the query. */
  async sendFile(_chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const query = new URLSearchParams({ filename: file.name, tags: ECHO_TAG })
    if (file.caption) query.set('message', file.caption)
    const res = await this._fetch(`${this._topicUrl}?${query}`, {
      method: 'PUT',
      headers: { 'content-type': file.mimeType },
      body: new Uint8Array(file.data),
      signal: AbortSignal.timeout(REQUEST_MS * 4),
    })
    const sent = (await res.json().catch(() => ({}))) as { id?: string }
    return { chat: CHAT, id: sent.id ?? '' }
  }
}
