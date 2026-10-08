import { createDecipheriv, createHash } from 'node:crypto'
import { AccessToken, jitter, message, mimeOf, plainText, sameSecret, sleep } from './net.ts'
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
 * Feishu (China) and Lark (international) through the Open Platform's HTTP API, ported from Hermes's and OpenClaw's
 * adapters (both use the official SDK; this speaks its wire protocol directly): events arrive over the long
 * connection (a WebSocket the app opens, so nothing needs to be reachable), or by webhook with the signature checked
 * and the body decrypted; the tenant token is cached; messages are posts (Markdown) edited in place, and messages with
 * buttons are interactive cards whose presses come back as card actions; images and files go both ways; topic
 * threads are conversations of their own.
 */

export const FEISHU_API = 'https://open.feishu.cn'
export const LARK_API = 'https://open.larksuite.com'
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
/** How often to ping the long connection when Feishu does not say (its SDK's default). */
const PING_S = 120
/** Images up to 10 MB are sent as images; files up to 30 MB. */
const IMAGE_MAX = 10 * 1024 * 1024
const FILE_MAX = 30 * 1024 * 1024
/** A signed webhook more than this far from our clock is refused (a replayed capture). */
const WEBHOOK_WINDOW_MS = 60 * 60 * 1000
/** The tenant token was refused or expired: fetch a new one and try once more. */
const TOKEN_CODES = new Set([99991661, 99991663, 99991664, 99991668])
const POST_INVALID = /content format of the post type is incorrect/i
const UPLOAD_TYPES: Record<string, string> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  xls: 'xls',
  xlsx: 'xls',
  ppt: 'ppt',
  pptx: 'ppt',
  mp4: 'mp4',
  opus: 'opus',
}

class FeishuError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly refused = false,
  ) {
    super(message)
  }
}

interface FsMention {
  key: string
  name?: string
  id?: { open_id?: string }
}
interface FsMessageEvent {
  sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string }
  message?: {
    message_id: string
    root_id?: string
    thread_id?: string
    chat_id: string
    chat_type: 'p2p' | 'group' | string
    message_type: string
    content: string
    create_time?: string
    mentions?: FsMention[]
  }
}
interface FsCardAction {
  operator?: { open_id?: string }
  open_id?: string
  token?: string
  action?: { value?: { d?: string } }
  context?: { open_message_id?: string; open_chat_id?: string }
  open_message_id?: string
  open_chat_id?: string
}
interface FsEnvelope {
  schema?: string
  type?: string
  token?: string
  challenge?: string
  encrypt?: string
  header?: { event_id?: string; event_type?: string; token?: string }
  event?: unknown
  action?: unknown
}
type PostElement = {
  tag: string
  text?: string
  href?: string
  user_id?: string
  user_name?: string
  image_key?: string
  file_key?: string
  language?: string
  emoji_type?: string
}

// --- The long connection's frames: protobuf (the SDK's pbbp2.proto), small enough to read and write by hand. ---

interface WsHeader {
  key: string
  value: string
}
export interface WsFrame {
  seqId: bigint
  logId: bigint
  service: number
  method: number
  headers: WsHeader[]
  payloadEncoding?: string
  payloadType?: string
  payload?: Uint8Array
  logIdNew?: string
}
/** Frame methods: control (ping and pong) and data (events and card actions). */
const CONTROL = 0
const DATA = 1

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder()

function varint(n: bigint): Uint8Array {
  const out: number[] = []
  let v = n
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v) b |= 0x80
    out.push(b)
  } while (v)
  return Uint8Array.from(out)
}

class PbWriter {
  private readonly parts: Uint8Array[] = []
  uint(field: number, n: bigint | number) {
    this.parts.push(varint(BigInt(field << 3)), varint(BigInt(n)))
  }
  bytes(field: number, b: Uint8Array) {
    this.parts.push(varint(BigInt((field << 3) | 2)), varint(BigInt(b.length)), b)
  }
  string(field: number, s: string) {
    this.bytes(field, utf8.encode(s))
  }
  finish(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(Buffer.concat(this.parts))
  }
}

function readFields(buf: Uint8Array, each: (field: number, value: bigint | Uint8Array) => void) {
  let pos = 0
  const read = (): bigint => {
    let result = 0n
    let shift = 0n
    for (;;) {
      const b = buf[pos++]
      if (b === undefined) throw new Error('truncated frame')
      result |= BigInt(b & 0x7f) << shift
      if (!(b & 0x80)) return result
      shift += 7n
    }
  }
  while (pos < buf.length) {
    const key = Number(read())
    const wire = key & 7
    if (wire === 0) each(key >> 3, read())
    else if (wire === 2) {
      const len = Number(read())
      each(key >> 3, buf.subarray(pos, pos + len))
      pos += len
    } else if (wire === 1) pos += 8
    else if (wire === 5) pos += 4
    else throw new Error(`unknown wire type ${wire}`)
  }
}

export function encodeFrame(f: WsFrame): Uint8Array<ArrayBuffer> {
  const w = new PbWriter()
  w.uint(1, f.seqId)
  w.uint(2, f.logId)
  w.uint(3, f.service)
  w.uint(4, f.method)
  for (const h of f.headers) {
    const hw = new PbWriter()
    hw.string(1, h.key)
    hw.string(2, h.value)
    w.bytes(5, hw.finish())
  }
  if (f.payloadEncoding) w.string(6, f.payloadEncoding)
  if (f.payloadType) w.string(7, f.payloadType)
  if (f.payload) w.bytes(8, f.payload)
  if (f.logIdNew) w.string(9, f.logIdNew)
  return w.finish()
}

export function decodeFrame(buf: Uint8Array): WsFrame {
  const f: WsFrame = { seqId: 0n, logId: 0n, service: 0, method: 0, headers: [] }
  const str = (v: bigint | Uint8Array) => (typeof v === 'bigint' ? String(v) : fromUtf8.decode(v))
  readFields(buf, (field, v) => {
    if (field === 1 && typeof v === 'bigint') f.seqId = v
    else if (field === 2 && typeof v === 'bigint') f.logId = v
    else if (field === 3) f.service = Number(v)
    else if (field === 4) f.method = Number(v)
    else if (field === 5 && typeof v !== 'bigint') {
      const h: WsHeader = { key: '', value: '' }
      readFields(v, (hf, hv) => {
        if (hf === 1) h.key = str(hv)
        else if (hf === 2) h.value = str(hv)
      })
      f.headers.push(h)
    } else if (field === 6) f.payloadEncoding = str(v)
    else if (field === 7) f.payloadType = str(v)
    else if (field === 8 && typeof v !== 'bigint') f.payload = new Uint8Array(v)
    else if (field === 9) f.logIdNew = str(v)
  })
  return f
}

/** A webhook body encrypted with the app's Encrypt Key: AES-256-CBC, key SHA-256 of it, IV the first 16 bytes. */
export function feishuDecrypt(encrypt: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest()
  const raw = Buffer.from(encrypt, 'base64')
  const decipher = createDecipheriv('aes-256-cbc', key, raw.subarray(0, 16))
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8')
}

/** Markdown as a post: one `md` element per row, a code block in a row of its own (Feishu's renderer can drop
 * what follows a fence inside one large element; Hermes splits the same way). */
function post(markdown: string): string {
  const rows: { tag: 'md'; text: string }[][] = []
  let current: string[] = []
  let inCode = false
  const flush = () => {
    const text = current.join('\n')
    if (text.trim()) rows.push([{ tag: 'md', text }])
    current = []
  }
  for (const line of markdown.split('\n')) {
    const fence = /^\s*```/.test(line)
    if (fence && !inCode) flush()
    current.push(line)
    if (fence) {
      inCode = !inCode
      if (!inCode) flush()
    }
  }
  flush()
  return JSON.stringify({ zh_cn: { content: rows.length ? rows : [[{ tag: 'md', text: markdown }]] } })
}

/** An interactive card: the Markdown, then a row of buttons per row; `update_multi` so edits reach everyone. */
function card(m: OutMessage): string {
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    elements: [
      { tag: 'markdown', content: m.text },
      ...(m.buttons ?? []).map((row) => ({
        tag: 'action',
        actions: row.map((b) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: b.label },
          type: 'default',
          value: { d: b.data },
        })),
      })),
    ],
  })
}

export class FeishuAdapter implements ChannelAdapter {
  readonly id = 'feishu'
  readonly label = 'Feishu / Lark'
  /** Posts and cards may be up to 30 KB, which 4000 characters stay under even in Chinese. */
  readonly limits = { text: 4000, editMs: 1500, file: FILE_MAX }
  readonly can = { buttons: true, files: true, edit: true }
  private readonly _token: AccessToken
  private _me?: { openId: string; name: string }
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _io?: AdapterIO
  private _ws?: WebSocket
  /** Messages sent as cards, edited with PATCH rather than PUT. */
  private readonly _cards = new Set<string>()
  private readonly _names = new Map<string, string>()
  /** Pieces of a long-connection message that arrived split, by message id. */
  private readonly _parts = new Map<string, Uint8Array[]>()

  constructor(
    private readonly config: {
      appId: string
      appSecret: string
      verificationToken?: string
      encryptKey?: string
    },
    private readonly api = FEISHU_API,
  ) {
    this._token = new AccessToken(async () => {
      let res: Response
      try {
        res = await fetch(`${this.api}/open-apis/auth/v3/tenant_access_token/internal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
        })
      } catch (err) {
        throw new FeishuError(0, `cannot reach Feishu: ${err instanceof Error ? err.name : 'network error'}`)
      }
      const data = (await res.json().catch(() => ({}))) as {
        code?: number
        msg?: string
        tenant_access_token?: string
        expire?: number
      }
      if (data.code !== 0 || !data.tenant_access_token)
        throw new FeishuError(
          data.code ?? res.status,
          'Feishu refused this App ID and App Secret; copy them again from the developer console',
          res.status < 500,
        )
      return { token: data.tenant_access_token, expiresIn: data.expire ?? 7200 }
    })
  }

  /** One Open Platform call; the token is renewed once if Feishu says it went stale. Never logs the token. */
  private async _call<T>(
    method: string,
    path: string,
    body?: Record<string, unknown> | FormData,
    retried = false,
  ): Promise<T> {
    const token = await this._token.get()
    let res: Response
    try {
      res = await fetch(`${this.api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body && !(body instanceof FormData)
            ? { 'content-type': 'application/json; charset=utf-8' }
            : {}),
        },
        ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      })
    } catch (err) {
      throw new FeishuError(0, `cannot reach Feishu: ${err instanceof Error ? err.name : 'network error'}`)
    }
    const data = (await res.json().catch(() => ({}))) as T & { code?: number; msg?: string }
    if (data.code === 0) return data
    if (!retried && data.code !== undefined && TOKEN_CODES.has(data.code)) {
      this._token.reset()
      return this._call(method, path, body, true)
    }
    throw new FeishuError(data.code ?? res.status, data.msg ?? `Feishu answered ${res.status}`)
  }

  async check(): Promise<string> {
    try {
      await this._token.get()
    } catch (err) {
      if (err instanceof FeishuError && err.refused) throw new Error(err.message)
      throw err
    }
    let info: { bot?: { app_name?: string; open_id?: string } }
    try {
      info = await this._call('GET', '/open-apis/bot/v3/info')
    } catch (err) {
      throw new Error(`Feishu has no bot for this app (${message(err)}); turn on its Bot capability`)
    }
    this._me = { openId: info.bot?.open_id ?? '', name: info.bot?.app_name ?? 'bot' }
    return this._me.name
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      // Who the bot is first: mentions of it in groups are recognized by its open_id.
      while (!signal.aborted && !this._me) {
        try {
          await this.check()
        } catch (err) {
          if (/refused this App ID|no bot for this app/.test(message(err)))
            return io.status({ state: 'error', error: message(err) })
          io.status({ state: 'retrying', error: message(err) })
          await sleep(jitter(backoff), signal)
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        }
      }
      const account = this._me?.name ?? 'bot'
      backoff = BACKOFF_MIN_MS
      // The long connection always runs: it needs nothing reachable, and it is harmless when the app is set to
      // send events by webhook instead (webhook() takes those).
      while (!signal.aborted) {
        try {
          if (await this._connect(signal, account)) backoff = BACKOFF_MIN_MS
          if (signal.aborted) break
          io.status({ state: 'retrying', error: 'the long connection closed' })
        } catch (err) {
          if (signal.aborted) break
          io.status({ state: 'retrying', error: message(err) })
        }
        await sleep(jitter(backoff), signal)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    this._ws?.close()
    await this._loop?.catch(() => {})
  }

  /** One long connection, until it closes; true when it opened (so the next retry starts from the short wait). */
  private async _connect(signal: AbortSignal, account: string): Promise<boolean> {
    let res: Response
    try {
      res = await fetch(`${this.api}/callback/ws/endpoint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', locale: 'zh' },
        body: JSON.stringify({ AppID: this.config.appId, AppSecret: this.config.appSecret }),
        signal,
      })
    } catch (err) {
      if (signal.aborted) return false
      throw new FeishuError(0, `cannot reach Feishu: ${err instanceof Error ? err.name : 'network error'}`)
    }
    const body = (await res.json().catch(() => ({}))) as {
      code?: number
      msg?: string
      data?: { URL?: string; ClientConfig?: { PingInterval?: number } }
    }
    const url = body.data?.URL
    if (body.code !== 0 || !url)
      throw new FeishuError(
        body.code ?? res.status,
        `Feishu would not open the long connection: ${body.msg ?? res.status}`,
      )
    const service = Number(new URL(url).searchParams.get('service_id') ?? 0)
    let pingMs = (body.data?.ClientConfig?.PingInterval ?? PING_S) * 1000
    return new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      this._ws = ws
      let opened = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const ping = () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(
              encodeFrame({
                seqId: 0n,
                logId: 0n,
                service,
                method: CONTROL,
                headers: [{ key: 'type', value: 'ping' }],
              }),
            )
          ping()
        }, pingMs)
      }
      ws.onopen = () => {
        opened = true
        this._io?.status({ state: 'on', account })
        ping()
      }
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return
        void this._frame(ws, new Uint8Array(ev.data), (ms) => {
          pingMs = ms
          ping()
        }).catch((err) => this._io?.log(`long connection: ${message(err)}`))
      }
      ws.onclose = () => {
        clearTimeout(timer)
        if (this._ws === ws) this._ws = undefined
        resolve(opened)
      }
      signal.addEventListener('abort', () => ws.close(), { once: true })
    })
  }

  /** A frame from the long connection: pongs carry new settings; data frames are answered once handled. */
  private async _frame(ws: WebSocket, raw: Uint8Array, setPing: (ms: number) => void) {
    const frame = decodeFrame(raw)
    const h = Object.fromEntries(frame.headers.map((x) => [x.key, x.value]))
    if (frame.method === CONTROL) {
      if (h.type === 'pong' && frame.payload?.length) {
        const cfg = JSON.parse(fromUtf8.decode(frame.payload)) as { PingInterval?: number }
        if (cfg.PingInterval && cfg.PingInterval > 0) setPing(cfg.PingInterval * 1000)
      }
      return
    }
    if (frame.method !== DATA) return
    let payload = frame.payload ?? new Uint8Array()
    const sum = Number(h.sum ?? 1)
    if (sum > 1) {
      const id = h.message_id ?? ''
      const parts = this._parts.get(id) ?? new Array<Uint8Array>(sum)
      parts[Number(h.seq ?? 0)] = payload
      this._parts.set(id, parts)
      if (parts.filter(Boolean).length < sum) return
      this._parts.delete(id)
      payload = Buffer.concat(parts)
    }
    const started = Date.now()
    let result: unknown
    try {
      result = await this._dispatch(JSON.parse(fromUtf8.decode(payload)) as FsEnvelope, h.type === 'card')
    } catch (err) {
      this._io?.log(`event: ${message(err)}`)
    }
    const answer = {
      code: 200,
      headers: {},
      ...(result ? { data: Buffer.from(JSON.stringify(result)).toString('base64') } : {}),
    }
    if (ws.readyState === WebSocket.OPEN)
      ws.send(
        encodeFrame({
          ...frame,
          headers: [...frame.headers, { key: 'biz_rt', value: String(Date.now() - started) }],
          payload: utf8.encode(JSON.stringify(answer)),
        }),
      )
  }

  /** An event (long connection or webhook) handed to the hub; a card action is answered with an empty card reply. */
  private async _dispatch(envelope: FsEnvelope, legacyCard: boolean): Promise<unknown> {
    const type = envelope.header?.event_type
    if (type === 'im.message.receive_v1') {
      const m = await this._message(envelope.event as FsMessageEvent)
      if (m) await this._io?.receive(m)
      return undefined
    }
    if (type === 'card.action.trigger' || legacyCard || (!type && envelope.action)) {
      const action = (type ? envelope.event : envelope) as FsCardAction
      const m = await this._press(action, envelope.header?.event_id)
      if (m) await this._io?.receive(m)
      return {}
    }
    return undefined
  }

  async webhook(req: Request): Promise<Response> {
    const raw = await req.text()
    let body: FsEnvelope
    try {
      body = JSON.parse(raw) as FsEnvelope
    } catch {
      return new Response('bad request', { status: 400 })
    }
    const { encryptKey, verificationToken } = this.config
    if (body.encrypt) {
      if (!encryptKey) return new Response('encrypted, but no Encrypt Key is set', { status: 400 })
      try {
        body = JSON.parse(feishuDecrypt(body.encrypt, encryptKey)) as FsEnvelope
      } catch {
        return new Response('unauthorized', { status: 401 })
      }
    }
    const token = body.header?.token ?? body.token ?? ''
    if (verificationToken && !sameSecret(token, verificationToken))
      return new Response('unauthorized', { status: 401 })
    // Feishu checks the address with a challenge before sending events (only the token vouches for it).
    if (body.type === 'url_verification') return Response.json({ challenge: body.challenge ?? '' })
    if (encryptKey) {
      const ts = req.headers.get('x-lark-request-timestamp') ?? ''
      const nonce = req.headers.get('x-lark-request-nonce') ?? ''
      const expected = createHash('sha256').update(`${ts}${nonce}${encryptKey}${raw}`).digest('hex')
      const fresh = Math.abs(Date.now() - Number(ts) * 1000) < WEBHOOK_WINDOW_MS
      if (!fresh || !sameSecret(req.headers.get('x-lark-signature') ?? '', expected))
        return new Response('unauthorized', { status: 401 })
    } else if (!verificationToken) {
      // Unauthenticated events could come from anyone who learns the address.
      return new Response('set a Verification Token or Encrypt Key for webhooks', { status: 403 })
    }
    return Response.json((await this._dispatch(body, false)) ?? {})
  }

  /** Whose open_id this is, by name (needs the contact permission; the id otherwise). */
  private async _name(openId: string): Promise<string> {
    const known = this._names.get(openId)
    if (known) return known
    let name = 'Feishu user'
    try {
      const r = await this._call<{ data?: { user?: { name?: string } } }>(
        'GET',
        `/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`,
      )
      name = r.data?.user?.name || name
    } catch {
      // Without contact:user.base:readonly Feishu will not say; the person is still known by id.
    }
    this._names.set(openId, name)
    return name
  }

  private _resource(messageId: string, key: string, kind: InboundFile['kind'], name: string, mime: string) {
    return {
      kind,
      name,
      mimeType: mime,
      read: async () => {
        const type = kind === 'image' ? 'image' : 'file'
        const token = await this._token.get()
        const res = await fetch(
          `${this.api}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}?type=${type}`,
          { headers: { authorization: `Bearer ${token}` } },
        )
        if (!res.ok || res.headers.get('content-type')?.includes('application/json'))
          throw new Error(`Feishu answered ${res.status} for the file`)
        return new Uint8Array(await res.arrayBuffer())
      },
    } satisfies InboundFile
  }

  /** im.message.receive_v1 as the hub's message; undefined for what channels ignore (other bots). */
  private async _message(ev: FsMessageEvent): Promise<Inbound | undefined> {
    const msg = ev?.message
    const openId = ev?.sender?.sender_id?.open_id
    if (!msg?.chat_id || !openId || ev.sender?.sender_type !== 'user') return undefined
    const kind = msg.chat_type === 'p2p' ? 'dm' : 'group'
    this._io?.set(`kind:${msg.chat_id}`, kind)
    // A topic is a conversation of its own, answered by replying in it to its first message.
    const thread = msg.thread_id ? msg.root_id || msg.message_id : undefined
    const chat: ChannelChat = { id: msg.chat_id, kind, ...(thread ? { thread } : {}) }
    const mentions = msg.mentions ?? []
    const me = this._me?.openId
    const mine = new Set(mentions.filter((m) => me && m.id?.open_id === me).map((m) => m.key))
    const named = new Map(mentions.map((m) => [m.key, m.name ?? '']))
    // Mentions arrive as `@_user_1` placeholders: the bot's own are dropped, others become @names.
    const unplace = (s: string) =>
      s
        .replace(/@_user_\d+|@_all/g, (key) =>
          key === '@_all' ? '@all' : mine.has(key) ? '' : `@${named.get(key) || 'someone'}`,
        )
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    let content: Record<string, unknown> = {}
    try {
      content = JSON.parse(msg.content) as Record<string, unknown>
    } catch {}
    const files: InboundFile[] = []
    let text = ''
    let unsupported = false
    const id = msg.message_id
    switch (msg.message_type) {
      case 'text':
        text = unplace(String(content.text ?? ''))
        break
      case 'post': {
        const body = (Array.isArray(content.content) ? content : (Object.values(content)[0] ?? {})) as {
          title?: string
          content?: PostElement[][]
        }
        const lines = (body.content ?? []).map((row) =>
          row
            .map((el) => {
              if (el.tag === 'text' || el.tag === 'md') return el.text ?? ''
              if (el.tag === 'a') return el.href ? `[${el.text ?? el.href}](${el.href})` : (el.text ?? '')
              if (el.tag === 'at')
                return mine.has(el.user_id ?? '') || el.user_id === me ? '' : `@${el.user_name ?? ''}`
              if (el.tag === 'code_block') return `\`\`\`${el.language ?? ''}\n${el.text ?? ''}\n\`\`\``
              if (el.tag === 'emotion') return `:${el.emoji_type ?? ''}:`
              if (el.tag === 'hr') return '---'
              if (el.tag === 'img' && el.image_key)
                files.push(
                  this._resource(id, el.image_key, 'image', `image-${files.length}.png`, 'image/png'),
                )
              if (el.tag === 'media' && el.file_key)
                files.push(this._resource(id, el.file_key, 'video', `video-${files.length}.mp4`, 'video/mp4'))
              return ''
            })
            .join(''),
        )
        text = unplace([body.title, ...lines].filter(Boolean).join('\n'))
        break
      }
      case 'image':
        files.push(this._resource(id, String(content.image_key), 'image', `image-${id}.png`, 'image/png'))
        break
      case 'file': {
        const name = String(content.file_name ?? `file-${id}`)
        files.push(this._resource(id, String(content.file_key), 'document', name, mimeOf(name)))
        break
      }
      case 'audio':
        files.push(this._resource(id, String(content.file_key), 'voice', `voice-${id}.opus`, 'audio/ogg'))
        break
      case 'media': {
        const name = String(content.file_name ?? `video-${id}.mp4`)
        files.push(this._resource(id, String(content.file_key), 'video', name, 'video/mp4'))
        break
      }
      default:
        unsupported = true
    }
    return {
      messageId: id,
      chat,
      sender: { id: openId, name: await this._name(openId) },
      text,
      mentioned: kind === 'dm' || mine.size > 0,
      ...(files.length ? { files } : {}),
      ...(unsupported ? { unsupported: true } : {}),
      time: new Date(Number(msg.create_time) || Date.now()).toISOString(),
    }
  }

  /** A card button press (the card.action.trigger callback, or the older card callback shape). */
  private async _press(a: FsCardAction, eventId?: string): Promise<Inbound | undefined> {
    const openId = a?.operator?.open_id ?? a?.open_id
    const chatId = a?.context?.open_chat_id ?? a?.open_chat_id
    const messageId = a?.context?.open_message_id ?? a?.open_message_id
    if (!openId || !chatId) return undefined
    const pressId = eventId ?? a.token ?? `${messageId}:${Date.now()}`
    const kind = this._io?.get(`kind:${chatId}`) === 'dm' ? 'dm' : 'group'
    return {
      messageId: `press:${pressId}`,
      chat: { id: chatId, kind },
      sender: { id: openId, name: await this._name(openId) },
      text: '',
      mentioned: true,
      press: {
        id: pressId,
        data: a.action?.value?.d ?? '',
        ...(messageId ? { message: { chat: chatId, id: messageId } } : {}),
      },
      time: new Date().toISOString(),
    }
  }

  /** Sends one message to a chat, or into its topic by replying to the topic's first message. */
  private async _post(chat: ChannelChat | string, msgType: string, content: string): Promise<SentRef> {
    const thread = threadOf(chat)
    const r = thread
      ? await this._call<{ data?: { message_id?: string } }>(
          'POST',
          `/open-apis/im/v1/messages/${encodeURIComponent(thread)}/reply`,
          { msg_type: msgType, content, reply_in_thread: true },
        )
      : await this._call<{ data?: { message_id?: string } }>(
          'POST',
          '/open-apis/im/v1/messages?receive_id_type=chat_id',
          { receive_id: chatIdOf(chat), msg_type: msgType, content },
        )
    return { chat: chatIdOf(chat), id: r.data?.message_id ?? '' }
  }

  /** Buttons go as a card; text as a post, or plain text when Feishu refuses the post. */
  async send(chat: ChannelChat | string, m: OutMessage): Promise<SentRef> {
    if (m.buttons?.length) {
      const ref = await this._post(chat, 'interactive', card(m))
      this._cards.add(ref.id)
      return ref
    }
    try {
      return await this._post(chat, 'post', post(m.text))
    } catch (err) {
      if (!(err instanceof FeishuError && POST_INVALID.test(err.message))) throw err
      return this._post(chat, 'text', JSON.stringify({ text: plainText(m.text) }))
    }
  }

  async edit(ref: SentRef, m: OutMessage): Promise<void> {
    const id = encodeURIComponent(ref.id)
    if (this._cards.has(ref.id) || m.buttons?.length) {
      await this._call('PATCH', `/open-apis/im/v1/messages/${id}`, { content: card(m) })
      return
    }
    try {
      await this._call('PUT', `/open-apis/im/v1/messages/${id}`, { msg_type: 'post', content: post(m.text) })
    } catch (err) {
      // A card sent before a restart (its id no longer remembered) is edited as a card.
      if (!(err instanceof FeishuError) || err.code === 0) throw err
      await this._call('PATCH', `/open-apis/im/v1/messages/${id}`, { content: card(m) })
      this._cards.add(ref.id)
    }
  }

  /** Feishu has no typing indicator for bots (Hermes's adapter does the same). */
  async typing(): Promise<void> {}

  /** Images small enough go as images (shown inline); everything else as a file. */
  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const blob = new Blob([new Uint8Array(file.data)], { type: file.mimeType })
    const form = new FormData()
    let ref: SentRef
    if (/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.mimeType) && file.data.byteLength <= IMAGE_MAX) {
      form.set('image_type', 'message')
      form.set('image', blob, file.name)
      const r = await this._call<{ data?: { image_key?: string } }>('POST', '/open-apis/im/v1/images', form)
      ref = await this._post(chat, 'image', JSON.stringify({ image_key: r.data?.image_key }))
    } else {
      form.set('file_type', UPLOAD_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'stream')
      form.set('file_name', file.name)
      form.set('file', blob, file.name)
      const r = await this._call<{ data?: { file_key?: string } }>('POST', '/open-apis/im/v1/files', form)
      ref = await this._post(chat, 'file', JSON.stringify({ file_key: r.data?.file_key }))
    }
    if (file.caption) await this.send(chat, { text: file.caption })
    return ref
  }

  /** A press was already answered in the card callback's reply (Feishu wants it within 3 seconds). */
  async answerPress(): Promise<void> {}
}
