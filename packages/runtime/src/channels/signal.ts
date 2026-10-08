import { randomUUID } from 'node:crypto'
import { channelCopy } from './copy.ts'
import { signalText } from './format.ts'
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
 * Signal through a signal-cli daemon's HTTP API (`signal-cli -a +NUMBER daemon --http 127.0.0.1:8080`), ported from
 * Hermes's adapter and OpenClaw's: messages arrive on the daemon's event stream (SSE), reconnected with backoff and
 * jitter and checked when it goes quiet; sending, typing and attachments go through its JSON-RPC; Markdown becomes
 * Signal's own text styles; in groups a message is for the bot when it @mentions the bot's number or account, or
 * quotes one of its messages; rate limits are waited out, and attachments paced by Hermes's model of Signal's
 * bucket. Signal has no buttons, and edits are not used (neither project does).
 */

const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
/** How often the event stream is checked, and how long it may stay silent before the daemon is asked if it lives. */
const HEALTH_EVERY_MS = 30_000
const QUIET_MS = 120_000
const RPC_TIMEOUT_MS = 30_000
/** A rate limit longer than this fails the send rather than holding the chat up. */
const RETRY_MAX_S = 30
/** Signal's attachment limit. */
const FILE_MAX = 100 * 1024 * 1024
/** No single event is this large (attachments come by id); a stream that sends one is broken. */
const EVENT_MAX_CHARS = 1024 * 1024
/** signal-cli's JSON-RPC code for a rate limit (0.14.3 and later). */
const RATE_LIMIT_CODE = -5
/** Signal's server bucket for attachments, refilled one every few seconds (Hermes's `signal_rate_limit`). */
const BUCKET_SIZE = 50
const BUCKET_REFILL_S = 4
/** Sent timestamps remembered, to know a quote of the bot's own message. */
const SENT_KEPT = 500

class SignalError extends Error {
  constructor(
    /** 0 when the daemon could not be reached. */
    readonly code: number,
    message: string,
    readonly rateLimited = false,
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}

/** The daemon has no such account: retrying will not help. */
class SignalRefused extends Error {}

interface RpcError {
  code?: number
  message?: string
  data?: { response?: { results?: { retryAfterSeconds?: number }[] } }
}
interface SendResult {
  timestamp?: number
  results?: { type?: string; retryAfterSeconds?: number }[]
}
interface SigMention {
  start?: number
  length?: number
  number?: string | null
  uuid?: string | null
}
interface SigAttachment {
  id?: string
  contentType?: string | null
  filename?: string | null
  size?: number | null
}
interface SigData {
  timestamp?: number
  message?: string | null
  groupInfo?: { groupId?: string; groupName?: string } | null
  mentions?: SigMention[] | null
  quote?: { id?: number; author?: string; authorNumber?: string; authorUuid?: string } | null
  attachments?: SigAttachment[] | null
  sticker?: unknown
  contacts?: unknown
  reaction?: unknown
  remoteDelete?: unknown
}
interface SigEnvelope {
  source?: string
  sourceNumber?: string | null
  sourceUuid?: string | null
  sourceName?: string | null
  timestamp?: number
  dataMessage?: SigData | null
  editMessage?: { dataMessage?: SigData | null } | null
  syncMessage?: unknown
  storyMessage?: unknown
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

/** A signal-cli error, recognizing its rate limits by code or by the wording older versions use. */
function rpcError(err: RpcError): SignalError {
  const message = err.message ?? 'signal-cli refused the request'
  const rateLimited =
    err.code === RATE_LIMIT_CODE || /\[429\]|ratelimit|retrylaterexception|retry after/i.test(message)
  const hinted = (err.data?.response?.results ?? [])
    .map((r) => Number(r.retryAfterSeconds))
    .filter((s) => s > 0)
  const said = /retry after (\d+(?:\.\d+)?)\s*second/i.exec(message)?.[1]
  const retryAfter = hinted.length ? Math.max(...hinted) : said ? Number(said) : undefined
  return new SignalError(err.code ?? 1, message, rateLimited, retryAfter)
}

/** Signal writes a mention as U+FFFC with its target alongside; this puts the @number (or @uuid) back in the text. */
function renderMentions(text: string, mentions: readonly SigMention[]): string {
  let out = text
  for (const m of [...mentions].sort((a, b) => (b.start ?? 0) - (a.start ?? 0))) {
    const who = m.number || m.uuid
    const start = m.start ?? -1
    const end = start + (m.length ?? 1)
    if (!who || start < 0 || end > out.length || !out.slice(start, end).includes('￼')) continue
    out = `${out.slice(0, start)}@${who}${out.slice(end)}`
  }
  return out
}

const fileKind = (mime: string): InboundFile['kind'] =>
  mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('audio/')
      ? 'voice'
      : mime.startsWith('video/')
        ? 'video'
        : 'document'

/**
 * Hermes's model of Signal's attachment rate limit: a bucket of 50, one taken per attachment, refilled one every few
 * seconds (calibrated from the server's Retry-After once a limit is hit), so a batch waits instead of failing.
 */
class AttachmentBucket {
  private _tokens = BUCKET_SIZE
  private _at = Date.now()
  private _perTokenS = BUCKET_REFILL_S

  private _refill() {
    const now = Date.now()
    this._tokens = Math.min(BUCKET_SIZE, this._tokens + (now - this._at) / 1000 / this._perTokenS)
    this._at = now
  }

  async take(n: number) {
    for (;;) {
      this._refill()
      if (this._tokens >= n) return
      await sleep((n - this._tokens) * this._perTokenS * 1000)
    }
  }

  /** Taken once the server accepted the batch; the upload time earns nothing back (Signal refills after). */
  spend(n: number) {
    this._tokens = Math.max(0, this._tokens - n)
    this._at = Date.now()
  }

  limited(retryAfterS?: number) {
    if (retryAfterS && retryAfterS > 0) this._perTokenS = retryAfterS
    this._tokens = 0
    this._at = Date.now()
  }
}

export class SignalAdapter implements ChannelAdapter {
  readonly id = 'signal'
  readonly label = 'Signal'
  /** Signal's message limit (signal-cli sends longer ones as a text attachment), and its attachment limit. */
  readonly limits = { text: 8000, editMs: 1500, file: FILE_MAX }
  readonly can = { buttons: false, files: true, edit: false }
  private readonly url: string
  private readonly account: string
  private _uuid?: string
  private _abort?: AbortController
  private _loop?: Promise<void>
  private readonly _bucket = new AttachmentBucket()
  private readonly _sent = new Set<string>()
  private readonly _typingFails = new Map<string, { count: number; until: number }>()

  constructor(url: string, account: string) {
    const trimmed = url.trim().replace(/\/+$/, '')
    this.url = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
    this.account = account.replace(/[\s()-]/g, '')
  }

  private async _rpc<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.url}/api/v1/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method,
          params: { account: this.account, ...params },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw new SignalError(
        0,
        `cannot reach signal-cli: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
    const data = (await res.json().catch(() => undefined)) as { result?: T; error?: RpcError } | undefined
    if (data?.error) throw rpcError(data.error)
    if (!res.ok || !data) throw new SignalError(res.status, `signal-cli answered ${res.status}`)
    return data.result as T
  }

  /** The daemon is up and has this account; learns the account's UUID, which mentions may use instead. */
  async check(): Promise<string> {
    const up = await fetch(`${this.url}/api/v1/check`, { signal: AbortSignal.timeout(10_000) }).then(
      (r) => r.ok,
      () => false,
    )
    if (!up) throw new Error(`cannot reach signal-cli at ${this.url}: is its daemon running with --http?`)
    try {
      const status = await this._rpc<{ number?: string; uuid?: string }[] | undefined>('getUserStatus', {
        recipient: [this.account],
      })
      const own = status?.find((s) => s.number === this.account) ?? status?.[0]
      if (own?.uuid) this._uuid = own.uuid
    } catch (err) {
      if (!(err instanceof SignalError) || err.code === 0) throw err
      if (/account/i.test(err.message) && /exist|registered|not found|unknown/i.test(err.message))
        throw new SignalRefused(channelCopy.signal.refused(this.account))
      // Anything else (Signal's servers briefly unreachable from the daemon) leaves the UUID unknown, which is fine.
    }
    return this.account
  }

  async start(io: AdapterIO): Promise<void> {
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      const wait = async () => {
        // Jitter, so gateways recovering together do not hit the daemon at the same moment.
        await sleep(backoff * (0.75 + Math.random() * 0.5), signal)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
      for (;;) {
        if (signal.aborted) return
        try {
          await this.check()
          break
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (err instanceof SignalRefused) return io.status({ state: 'error', error: message })
          io.status({ state: 'retrying', error: message })
          await wait()
        }
      }
      backoff = BACKOFF_MIN_MS
      while (!signal.aborted) {
        try {
          await this._listen(io, signal, () => {
            backoff = BACKOFF_MIN_MS
          })
          if (signal.aborted) break
          io.status({ state: 'retrying', error: 'signal-cli closed the event stream' })
        } catch (err) {
          if (signal.aborted) break
          io.status({ state: 'retrying', error: err instanceof Error ? err.message : String(err) })
        }
        await wait()
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
  }

  /** One connection to the event stream, until it ends; a stream silent too long is dropped if the daemon is gone. */
  private async _listen(io: AdapterIO, signal: AbortSignal, connected: () => void) {
    const conn = new AbortController()
    let res: Response
    try {
      res = await fetch(`${this.url}/api/v1/events?account=${encodeURIComponent(this.account)}`, {
        headers: { accept: 'text/event-stream' },
        signal: AbortSignal.any([signal, conn.signal]),
      })
    } catch (err) {
      throw new SignalError(
        0,
        `cannot reach signal-cli: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
    if (!res.ok || !res.body)
      throw new SignalError(res.status, `signal-cli refused the event stream (${res.status})`)
    connected()
    io.status({ state: 'on', account: this.account })
    let heard = Date.now()
    let quiet = false
    const watch = setInterval(async () => {
      if (Date.now() - heard < QUIET_MS) return
      const alive = await fetch(`${this.url}/api/v1/check`, { signal: AbortSignal.timeout(10_000) }).then(
        (r) => r.ok,
        () => false,
      )
      if (alive) heard = Date.now()
      else {
        quiet = true
        conn.abort()
      }
    }, HEALTH_EVERY_MS)
    try {
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      let event = { name: '', data: [] as string[] }
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        heard = Date.now()
        buffer += value
        for (;;) {
          const nl = buffer.indexOf('\n')
          if (nl < 0) break
          const line = buffer.slice(0, nl).replace(/\r$/, '')
          buffer = buffer.slice(nl + 1)
          if (!line) {
            if (event.data.length) await this._event(io, event.name, event.data.join('\n'))
            event = { name: '', data: [] }
            continue
          }
          // Lines starting with a colon are keepalive comments.
          if (line.startsWith(':')) continue
          const colon = line.indexOf(':')
          const field = colon < 0 ? line : line.slice(0, colon)
          const val = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
          if (field === 'event') event.name = val
          else if (field === 'data') event.data.push(val)
        }
        if (buffer.length > EVENT_MAX_CHARS)
          throw new SignalError(1, 'signal-cli sent an event too large to read')
      }
    } catch (err) {
      if (quiet) throw new SignalError(0, 'signal-cli stopped answering; reconnecting')
      throw err
    } finally {
      clearInterval(watch)
      conn.abort()
    }
  }

  private async _event(io: AdapterIO, name: string, data: string) {
    if (name && name !== 'receive') return
    let payload: { envelope?: SigEnvelope } | undefined
    try {
      payload = JSON.parse(data)
    } catch {
      return io.log('signal-cli sent an event that is not JSON')
    }
    const message = payload?.envelope && this._inbound(payload.envelope)
    if (message) await io.receive(message)
  }

  private _isMe(number?: string | null, uuid?: string | null) {
    return (Boolean(number) && number === this.account) || (Boolean(uuid) && uuid === this._uuid)
  }

  /** An envelope as the hub's message; undefined for what channels ignore (receipts, typing, reactions, own sends). */
  private _inbound(env: SigEnvelope): Inbound | undefined {
    // Sync messages are this account's own sends from its other linked devices (OpenClaw drops them all too).
    if ('syncMessage' in env || env.storyMessage) return undefined
    const number = env.sourceNumber ?? (env.source?.startsWith('+') ? env.source : undefined)
    const uuid = env.sourceUuid ?? undefined
    const from = number || uuid
    if (!from || this._isMe(number, uuid)) return undefined
    // An edited message carries its new text inside editMessage; it is taken as a new message (as Hermes does).
    const data = env.dataMessage ?? env.editMessage?.dataMessage
    if (!data || data.reaction || data.remoteDelete) return undefined
    const groupId = data.groupInfo?.groupId
    const chat: ChannelChat = groupId
      ? {
          id: `group:${groupId}`,
          kind: 'group',
          ...(data.groupInfo?.groupName ? { title: data.groupInfo.groupName } : {}),
        }
      : { id: from, kind: 'dm' }
    const mentions = data.mentions ?? []
    const raw = renderMentions(data.message ?? '', mentions)
    const quote = data.quote
    const mentioned =
      chat.kind === 'dm' ||
      mentions.some((m) => this._isMe(m.number, m.uuid)) ||
      Boolean(
        quote &&
          (this._isMe(quote.authorNumber ?? quote.author, quote.authorUuid ?? quote.author) ||
            (quote.id !== undefined && this._sent.has(String(quote.id)))),
      )
    // The bot's own @mention is removed, so the agents do not read "@+15551234567 say hi" as a number to contact.
    let text = raw
    for (const me of [this.account, this._uuid]) if (me) text = text.split(`@${me}`).join('')
    text = text.replace(/[ \t]{2,}/g, ' ').trim()
    const files: InboundFile[] = (data.attachments ?? [])
      .filter((a): a is SigAttachment & { id: string } => Boolean(a.id))
      .map((a) => {
        const mimeType = a.contentType || 'application/octet-stream'
        return {
          kind: fileKind(mimeType),
          name: a.filename || `signal-${a.id}`,
          mimeType,
          ...(a.size ? { size: a.size } : {}),
          read: async () => {
            if (a.size && a.size > FILE_MAX) throw new Error('Signal attachments are at most 100 MB')
            const got = await this._rpc<{ data?: string } | string>('getAttachment', {
              id: a.id,
              ...(groupId ? { groupId } : { recipient: from }),
            })
            const base64 = typeof got === 'string' ? got : got?.data
            if (!base64) throw new Error('signal-cli did not return the attachment')
            return new Uint8Array(Buffer.from(base64, 'base64'))
          },
        }
      })
    const unsupported = !text && !files.length && Boolean(data.sticker || data.contacts)
    // Profile key updates, group changes and the like carry a dataMessage with nothing in it.
    if (!text && !files.length && !unsupported) return undefined
    const sent = env.timestamp ?? data.timestamp ?? Date.now()
    return {
      messageId: `${from}:${sent}`,
      chat,
      sender: {
        id: uuid || from,
        name: env.sourceName || number || 'Someone',
        ...(number ? { handle: number } : {}),
      },
      text,
      mentioned,
      ...(files.length ? { files } : {}),
      ...(unsupported ? { unsupported: true } : {}),
      time: new Date(sent).toISOString(),
    }
  }

  private _target(chat: string) {
    return chat.startsWith('group:') ? { groupId: chat.slice(6) } : { recipient: [chat] }
  }

  private _remember(timestamp?: number) {
    if (timestamp === undefined) return
    this._sent.add(String(timestamp))
    for (const old of this._sent) {
      if (this._sent.size <= SENT_KEPT) break
      this._sent.delete(old)
    }
  }

  /**
   * One `send`, failed when no recipient got it (in a group, one member's failure is not the message's); a rate
   * limit is waited out once: attachments through the bucket, text when the wait is short.
   */
  private async _send(params: Record<string, unknown>, attachments = 0): Promise<SendResult> {
    for (let attempt = 0; ; attempt++) {
      if (attachments) await this._bucket.take(attachments)
      try {
        // signal-cli uploads attachments inside the call, so it gets longer for them (Hermes: 5 s each, 60 s at least).
        const timeout = attachments ? Math.max(60_000, 5_000 * attachments) : RPC_TIMEOUT_MS
        const result = (await this._rpc<SendResult | undefined>('send', params, timeout)) ?? {}
        const results = result.results ?? []
        const limited = results.find((r) => r.type === 'RATE_LIMIT_FAILURE')
        if (results.length && !results.some((r) => r.type === 'SUCCESS')) {
          if (limited)
            throw new SignalError(
              1,
              'Signal rate-limited this send',
              true,
              Number(limited.retryAfterSeconds) || undefined,
            )
          throw new SignalError(1, `Signal could not deliver it (${results[0]?.type ?? 'unknown'})`)
        }
        if (attachments) this._bucket.spend(attachments)
        this._remember(result.timestamp)
        return result
      } catch (err) {
        if (!(err instanceof SignalError && err.rateLimited) || attempt >= 1) throw err
        if (attachments) this._bucket.limited(err.retryAfter)
        else if (err.retryAfter && err.retryAfter <= RETRY_MAX_S) await sleep(err.retryAfter * 1000)
        else throw err
      }
    }
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const id = chatIdOf(chat)
    const { text, styles } = signalText(message.text)
    const sent = await this._send({
      ...this._target(id),
      message: text,
      ...(styles.length ? { textStyle: styles } : {}),
    })
    return { chat: id, id: String(sent.timestamp ?? Date.now()) }
  }

  /**
   * Signal can edit, but neither Hermes nor OpenClaw does it through signal-cli, so `can.edit` is false: the hub
   * keeps no status line, and the notes it adds to a sent message (an approval decided) are left out.
   */
  async edit(_ref: SentRef, _message: OutMessage): Promise<void> {}

  /**
   * Typing, renewed by the hub every few seconds; after three failures in a row it rests (16 s, 32 s, then 60 s) so
   * a daemon that cannot reach Signal is not asked again and again (Hermes's backoff).
   */
  async typing(chat: ChannelChat | string): Promise<void> {
    const id = chatIdOf(chat)
    const fails = this._typingFails.get(id)
    if (fails && Date.now() < fails.until) return
    try {
      await this._rpc('sendTyping', this._target(id))
      this._typingFails.delete(id)
    } catch (err) {
      const count = (fails?.count ?? 0) + 1
      const until = count >= 3 ? Date.now() + Math.min(60_000, 16_000 * 2 ** (count - 3)) : 0
      this._typingFails.set(id, { count, until })
      throw err
    }
  }

  /** As a data URI, which signal-cli takes in place of a file path, so nothing is written to disk. */
  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const id = chatIdOf(chat)
    if (file.data.byteLength > FILE_MAX) throw new Error('Signal attachments are at most 100 MB')
    // `;` and `,` would end the file name early in the data URI.
    const name = file.name.replace(/[;,]/g, '_')
    const uri = `data:${file.mimeType};filename=${name};base64,${Buffer.from(file.data).toString('base64')}`
    const caption = file.caption ? signalText(file.caption) : undefined
    const sent = await this._send(
      {
        ...this._target(id),
        message: caption?.text ?? '',
        ...(caption?.styles.length ? { textStyle: caption.styles } : {}),
        attachments: [uri],
      },
      1,
    )
    return { chat: id, id: String(sent.timestamp ?? Date.now()) }
  }
}
