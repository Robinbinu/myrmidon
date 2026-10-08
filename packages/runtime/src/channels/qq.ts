import { AccessToken, jitter, message, plainText, sleep } from './net.ts'
import type {
  AdapterIO,
  Button,
  ChannelAdapter,
  ChannelChat,
  Inbound,
  InboundFile,
  OutFile,
  OutMessage,
  SentRef,
} from './types.ts'
import { chatIdOf } from './types.ts'

/**
 * QQ bots through the official QQ Bot API (no SDK), ported from Hermes's `qqbot` adapter: an app ID and secret
 * become an access token; the WebSocket gateway is kept with heartbeats, identify and resume; direct (C2C) messages
 * and group messages that @mention the bot come in; replies are passive (they cite the message they answer, with a
 * sequence number) while QQ allows it, active otherwise; Markdown with inline-keyboard buttons, whose clicks come
 * back as interactions; images and files go both ways. QQ cannot edit a sent message.
 */

export const QQ_API = 'https://api.sgroup.qq.com'
export const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
/** Direct messages and group @-messages, and button clicks. */
const INTENTS = (1 << 25) | (1 << 26)
const BACKOFF_S = [2, 5, 10, 30, 60]
/** A close this soon after connecting, three times running, means wrong settings or missing permissions. */
const QUICK_S = 5
const QUICK_MAX = 3
const RATE_LIMIT_MS = 60_000
/** Close codes that will not get better by reconnecting (Hermes's list). */
const FATAL: Record<number, string> = {
  4001: 'invalid opcode',
  4002: 'invalid payload',
  4010: 'invalid shard',
  4011: 'sharding required',
  4012: 'invalid API version',
  4013: 'invalid intent',
  4014: 'intent not authorized',
  4914: 'offline or sandbox-only',
  4915: 'banned',
}
/** Close codes after which the session cannot be resumed (4009, a timeout, can be). */
const SESSION_GONE = (code: number) => code === 4006 || code === 4007 || (code >= 4900 && code <= 4913)
/**
 * A reply may cite a message for 60 minutes in a direct chat and 5 in a group, up to 5 times; after that it is an
 * active message, of which QQ allows few.
 */
const PASSIVE_DM_MS = 60 * 60 * 1000
const PASSIVE_GROUP_MS = 5 * 60 * 1000
const PASSIVE_MAX = 5
const TYPING_S = 60
const TYPING_EVERY_MS = 50_000
/** Files are sent inline as base64, which QQ takes up to about 10 MB. */
const FILE_MAX = 10 * 1024 * 1024
/** QQ keyboards hold at most 5 rows of 5 buttons. */
const ROWS = 5
const PER_ROW = 5

class QQError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface QQAttachment {
  content_type?: string
  url?: string
  filename?: string
  size?: number
  voice_wav_url?: string
  asr_refer_text?: string
}
interface QQMessage {
  id: string
  content?: string
  timestamp?: string
  group_openid?: string
  author?: { user_openid?: string; member_openid?: string; id?: string }
  attachments?: QQAttachment[]
}
interface QQInteraction {
  id: string
  chat_type?: number
  group_openid?: string
  group_member_openid?: string
  user_openid?: string
  data?: { resolved?: { button_data?: string; user_id?: string; message_id?: string } }
}
interface QQPayload {
  op: number
  d?: unknown
  s?: number
  t?: string
}

/** Buttons as a QQ keyboard: rows kept when they fit, else packed into at most 5 rows of 5. */
function keyboard(rows: readonly (readonly Button[])[]) {
  const all = rows.flat().slice(0, ROWS * PER_ROW)
  const per = rows.length <= ROWS && rows.every((r) => r.length <= PER_ROW) ? 0 : Math.ceil(all.length / ROWS)
  const packed: Button[][] = per
    ? Array.from({ length: Math.ceil(all.length / per) }, (_, i) => all.slice(i * per, i * per + per))
    : rows.map((r) => [...r])
  let n = 0
  return {
    content: {
      rows: packed.map((row) => ({
        buttons: row.map((b) => ({
          id: String(n++),
          // One group: a click greys the others out.
          group_id: 'choice',
          render_data: { label: b.label, visited_label: b.label, style: 1 },
          action: { type: 1, data: b.data, permission: { type: 2 }, click_limit: 1, unsupport_tips: b.label },
        })),
      })),
    },
  }
}

export class QQAdapter implements ChannelAdapter {
  readonly id = 'qq'
  readonly label = 'QQ'
  readonly limits = { text: 4000, editMs: 1500, file: FILE_MAX }
  private readonly _token: AccessToken
  private _markdown: boolean
  private _me?: { id: string; name: string }
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _ws?: WebSocket
  private _session?: { id?: string; seq?: number }
  /** The message (or button click) each chat last sent, which replies cite while QQ allows. */
  private readonly _last = new Map<string, { msgId?: string; eventId?: string; at: number; seq: number }>()
  private readonly _typed = new Map<string, number>()

  constructor(
    private readonly config: { appId: string; secret: string; markdown?: boolean },
    private readonly endpoints = { api: QQ_API, token: QQ_TOKEN_URL },
  ) {
    this._markdown = config.markdown ?? true
    this._token = new AccessToken(async () => {
      let res: Response
      try {
        res = await fetch(endpoints.token, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ appId: config.appId, clientSecret: config.secret }),
        })
      } catch (err) {
        throw new QQError(0, `cannot reach QQ: ${err instanceof Error ? err.name : 'network error'}`)
      }
      const data = (await res.json().catch(() => ({}))) as {
        access_token?: string
        expires_in?: string | number
      }
      if (!data.access_token)
        throw new QQError(
          401,
          'QQ refused this App ID and AppSecret; copy them again from the QQ Open Platform',
        )
      return { token: data.access_token, expiresIn: Number(data.expires_in ?? 7200) }
    })
  }

  /** Buttons need Markdown messages; without the Markdown permission approvals and questions are typed. */
  get can() {
    return { buttons: this._markdown, files: true, edit: false }
  }

  /** One API call with the bot's token, renewed once if QQ refuses it; never logs it. */
  private async _call<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    retried = false,
  ): Promise<T> {
    const token = await this._token.get()
    let res: Response
    try {
      res = await fetch(`${this.endpoints.api}${path}`, {
        method,
        headers: {
          authorization: `QQBot ${token}`,
          'x-union-appid': this.config.appId,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch (err) {
      throw new QQError(0, `cannot reach QQ: ${err instanceof Error ? err.name : 'network error'}`)
    }
    const data = (await res.json().catch(() => ({}))) as T & { code?: number; message?: string }
    if (res.status === 401 && !retried) {
      this._token.reset()
      return this._call(method, path, body, true)
    }
    if (res.status >= 400)
      throw new QQError(
        res.status,
        `QQ answered ${res.status}: ${data.message ?? 'error'} (${data.code ?? ''})`,
      )
    return data
  }

  async check(): Promise<string> {
    try {
      await this._token.get()
    } catch (err) {
      if (err instanceof QQError && err.status === 401) throw new Error(err.message)
      throw err
    }
    const me = await this._call<{ id?: string; username?: string }>('GET', '/users/@me')
    this._me = { id: me.id ?? '', name: me.username ?? 'QQ bot' }
    return this._me.name
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      let attempt = 0
      let quick = 0
      while (!signal.aborted) {
        const opened = Date.now()
        let code: number
        try {
          if (!this._me) await this.check()
          const { url } = await this._call<{ url?: string }>('GET', '/gateway')
          if (!url) throw new QQError(0, 'QQ gave no gateway address')
          code = await this._connect(url, signal)
          if (signal.aborted) break
        } catch (err) {
          if (signal.aborted) break
          if (/refused this App ID/.test(message(err)))
            return io.status({ state: 'error', error: message(err) })
          io.status({ state: 'retrying', error: message(err) })
          await sleep(jitter((BACKOFF_S[Math.min(attempt++, BACKOFF_S.length - 1)] ?? 60) * 1000), signal)
          continue
        }
        const fatal = FATAL[code]
        if (fatal)
          return io.status({
            state: 'error',
            error: `QQ says the bot is ${fatal}; check it on the QQ Open Platform`,
          })
        if (Date.now() - opened < QUICK_S * 1000) {
          if (++quick >= QUICK_MAX)
            return io.status({
              state: 'error',
              error: 'QQ keeps closing the connection: check the App ID, AppSecret and the bot’s permissions',
            })
        } else {
          quick = 0
          attempt = 0
        }
        if (code === 4004) this._token.reset()
        if (SESSION_GONE(code)) this._session = undefined
        io.status({ state: 'retrying', error: `the gateway closed (${code})` })
        const wait =
          code === 4008 ? RATE_LIMIT_MS : (BACKOFF_S[Math.min(attempt++, BACKOFF_S.length - 1)] ?? 60) * 1000
        await sleep(jitter(wait), signal)
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    this._ws?.close()
    await this._loop?.catch(() => {})
  }

  /** One gateway connection: Hello → identify (or resume) → events, heartbeats meanwhile; resolves with the close code. */
  private _connect(url: string, signal: AbortSignal): Promise<number> {
    return new Promise<number>((resolve) => {
      const ws = new WebSocket(url)
      this._ws = ws
      let beat: ReturnType<typeof setInterval> | undefined
      const send = (p: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(p))
      ws.onmessage = (ev) => {
        let p: QQPayload
        try {
          p = JSON.parse(String(ev.data)) as QQPayload
        } catch {
          return
        }
        if (typeof p.s === 'number')
          this._session = { ...this._session, seq: Math.max(p.s, this._session?.seq ?? 0) }
        if (p.op === 10) {
          const interval = (p.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 30_000
          clearInterval(beat)
          // At 80% of QQ's interval, so a slow tick never misses it.
          beat = setInterval(() => send({ op: 1, d: this._session?.seq ?? null }), interval * 0.8)
          void this._token.get().then((token) => {
            const s = this._session
            if (s?.id && s.seq !== undefined)
              send({ op: 6, d: { token: `QQBot ${token}`, session_id: s.id, seq: s.seq } })
            else
              send({
                op: 2,
                d: {
                  token: `QQBot ${token}`,
                  intents: INTENTS,
                  shard: [0, 1],
                  properties: { $os: process.platform, $browser: 'myrmidon', $device: 'myrmidon' },
                },
              })
          })
        } else if (p.op === 0) {
          if (p.t === 'READY' || p.t === 'RESUMED') {
            if (p.t === 'READY')
              this._session = {
                ...this._session,
                id: (p.d as { session_id?: string } | undefined)?.session_id,
              }
            this._io?.status({ state: 'on', account: this._me?.name ?? 'QQ bot' })
          } else if (p.t === 'C2C_MESSAGE_CREATE' || p.t === 'GROUP_AT_MESSAGE_CREATE') {
            const m = this._inbound(p.t, p.d as QQMessage)
            if (m) void this._io?.receive(m)
          } else if (p.t === 'INTERACTION_CREATE') void this._interaction(p.d as QQInteraction)
        } else if (p.op === 7) ws.close()
        else if (p.op === 9) {
          // Not resumable: identify afresh on the next connection.
          if (!p.d) this._session = undefined
          ws.close()
        }
      }
      ws.onclose = (ev) => {
        clearInterval(beat)
        if (this._ws === ws) this._ws = undefined
        resolve(ev.code)
      }
      signal.addEventListener('abort', () => ws.close(), { once: true })
    })
  }

  private _attachment(a: QQAttachment, i: number): InboundFile | { transcript: string } | undefined {
    const fix = (u: string) => (u.startsWith('//') ? `https:${u}` : u)
    const type = (a.content_type ?? '').toLowerCase()
    const voice = type === 'voice' || type.startsWith('audio/')
    // QQ voice notes are SILK; QQ also offers them as WAV, which transcription can read, and its own transcript.
    const url = voice && a.voice_wav_url ? a.voice_wav_url : a.url
    if (voice && !a.voice_wav_url && a.asr_refer_text) return { transcript: a.asr_refer_text }
    if (!url) return undefined
    const kind: InboundFile['kind'] = voice
      ? 'voice'
      : type.startsWith('image/')
        ? 'image'
        : type.startsWith('video/')
          ? 'video'
          : 'document'
    return {
      kind,
      name: voice && a.voice_wav_url ? `voice-${i}.wav` : a.filename || `file-${i}`,
      mimeType: voice
        ? a.voice_wav_url
          ? 'audio/wav'
          : 'audio/silk'
        : type.includes('/')
          ? type
          : 'application/octet-stream',
      ...(a.size ? { size: a.size } : {}),
      read: async () => {
        // QQ's media addresses want the bot's token too.
        const res = await fetch(fix(url), { headers: { authorization: `QQBot ${await this._token.get()}` } })
        if (!res.ok) throw new Error(`QQ answered ${res.status} for the file`)
        return new Uint8Array(await res.arrayBuffer())
      },
    }
  }

  /** A direct or group @-message as the hub's; the message is kept so replies can cite it. */
  private _inbound(type: string, d: QQMessage): Inbound | undefined {
    const group = type === 'GROUP_AT_MESSAGE_CREATE'
    const sender = group ? d.author?.member_openid : d.author?.user_openid
    const target = group ? d.group_openid : d.author?.user_openid
    if (!d?.id || !sender || !target) return undefined
    const chatId = `${group ? 'group' : 'c2c'}:${target}`
    this._last.set(chatId, { msgId: d.id, at: Date.now(), seq: 0 })
    let text = (d.content ?? '').trim()
    // Group messages start with the bot's @mention (Hermes strips it the same way).
    if (group) text = text.replace(/^@\S+\s*/, '')
    const files: InboundFile[] = []
    for (const [i, a] of (d.attachments ?? []).entries()) {
      const f = this._attachment(a, i)
      if (f && 'transcript' in f) text = text ? `${text}\n\n${f.transcript}` : f.transcript
      else if (f) files.push(f)
    }
    if (!text && !files.length) return undefined
    return {
      messageId: d.id,
      chat: { id: chatId, kind: group ? 'group' : 'dm' },
      sender: { id: sender, name: `QQ user ${sender.slice(0, 6)}` },
      text,
      // QQ delivers only group messages that @mention the bot.
      mentioned: true,
      ...(files.length ? { files } : {}),
      time:
        d.timestamp && !Number.isNaN(Date.parse(d.timestamp))
          ? new Date(d.timestamp).toISOString()
          : new Date().toISOString(),
    }
  }

  /** A button click: acknowledged at once (QQ shows an error on the button otherwise), then handed to the hub. */
  private async _interaction(d: QQInteraction) {
    if (!d?.id) return
    await this._call('PUT', `/interactions/${encodeURIComponent(d.id)}`, { code: 0 }).catch((err) =>
      this._io?.log(`acknowledging a click: ${message(err)}`),
    )
    const group = d.chat_type === 1
    const target = group ? d.group_openid : d.user_openid
    const sender = d.group_member_openid || d.user_openid || d.data?.resolved?.user_id
    if (!target || !sender) return
    const chatId = `${group ? 'group' : 'c2c'}:${target}`
    // A click may be answered passively too, citing the click.
    this._last.set(chatId, { eventId: d.id, at: Date.now(), seq: 0 })
    const ref = d.data?.resolved?.message_id
    await this._io?.receive({
      messageId: `press:${d.id}`,
      chat: { id: chatId, kind: group ? 'group' : 'dm' },
      sender: { id: sender, name: `QQ user ${sender.slice(0, 6)}` },
      text: '',
      mentioned: true,
      press: {
        id: d.id,
        data: d.data?.resolved?.button_data ?? '',
        ...(ref ? { message: { chat: chatId, id: ref } } : {}),
      },
      time: new Date().toISOString(),
    })
  }

  private _path(chatId: string) {
    const [kind, ...rest] = chatId.split(':')
    const id = encodeURIComponent(rest.join(':'))
    return kind === 'group' ? `/v2/groups/${id}` : `/v2/users/${id}`
  }

  /** What a reply cites: the chat's last message (or click) while QQ still allows it, with the next sequence number. */
  private _cite(chatId: string): Record<string, unknown> {
    const last = this._last.get(chatId)
    const window = chatId.startsWith('group:') ? PASSIVE_GROUP_MS : PASSIVE_DM_MS
    if (!last || Date.now() - last.at > window || last.seq >= PASSIVE_MAX) return { msg_seq: 1 }
    last.seq++
    return { ...(last.msgId ? { msg_id: last.msgId } : { event_id: last.eventId }), msg_seq: last.seq }
  }

  /** Posts a message, citing what it answers; if QQ refuses the citation (expired, used up), sent as active. */
  private async _post(chatId: string, body: Record<string, unknown>): Promise<SentRef> {
    const cite = this._cite(chatId)
    let r: { id?: string }
    try {
      r = await this._call('POST', `${this._path(chatId)}/messages`, { ...body, ...cite })
    } catch (err) {
      const cited = 'msg_id' in cite || 'event_id' in cite
      if (!cited || !(err instanceof QQError) || err.status === 0 || err.status >= 500) throw err
      this._last.delete(chatId)
      r = await this._call('POST', `${this._path(chatId)}/messages`, { ...body, msg_seq: 1 })
    }
    return { chat: chatId, id: r.id ?? crypto.randomUUID() }
  }

  async send(chat: ChannelChat | string, m: OutMessage): Promise<SentRef> {
    const chatId = chatIdOf(chat)
    if (this._markdown) {
      try {
        return await this._post(chatId, {
          msg_type: 2,
          markdown: { content: m.text },
          ...(m.buttons?.length ? { keyboard: keyboard(m.buttons) } : {}),
        })
      } catch (err) {
        if (!(err instanceof QQError) || err.status === 0 || err.status >= 500) throw err
        // Most likely the bot lacks QQ's Markdown permission: plain text from now on (and typed approvals).
        const ref = await this._post(chatId, { msg_type: 0, content: plainText(m.text) })
        this._markdown = false
        this._io?.log(`QQ refused Markdown (${err.message}); sending plain text`)
        return ref
      }
    }
    return this._post(chatId, { msg_type: 0, content: plainText(m.text) })
  }

  async edit(): Promise<void> {
    throw new Error('QQ cannot edit a sent message')
  }

  /** "Typing…" in direct chats only, citing the person's last message, renewed before QQ's 60 s run out. */
  async typing(chat: ChannelChat | string): Promise<void> {
    const chatId = chatIdOf(chat)
    const last = this._last.get(chatId)
    if (!chatId.startsWith('c2c:') || !last?.msgId || Date.now() - last.at > PASSIVE_DM_MS) return
    if (Date.now() - (this._typed.get(chatId) ?? 0) < TYPING_EVERY_MS) return
    this._typed.set(chatId, Date.now())
    await this._call('POST', `${this._path(chatId)}/messages`, {
      msg_type: 6,
      msg_id: last.msgId,
      // Far from the replies' own sequence numbers, so they never collide.
      msg_seq: 100 + Math.floor(Math.random() * 60_000),
      input_notify: { input_type: 1, input_second: TYPING_S },
    })
  }

  /** Uploaded inline (base64), then sent as a media message: images and videos shown, the rest as files. */
  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const chatId = chatIdOf(chat)
    const fileType = /^image\/(png|jpeg|gif)$/.test(file.mimeType) ? 1 : file.mimeType === 'video/mp4' ? 2 : 4
    const upload = await this._call<{ file_info?: string }>('POST', `${this._path(chatId)}/files`, {
      file_type: fileType,
      file_data: Buffer.from(file.data).toString('base64'),
      srv_send_msg: false,
      ...(fileType === 4 ? { file_name: file.name } : {}),
    })
    if (!upload.file_info) throw new Error('QQ took the file but gave nothing to send')
    return this._post(chatId, {
      msg_type: 7,
      media: { file_info: upload.file_info },
      ...(file.caption ? { content: file.caption } : {}),
    })
  }

  /** Clicks were acknowledged when they arrived. */
  async answerPress(): Promise<void> {}
}
