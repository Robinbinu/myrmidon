import { createHmac } from 'node:crypto'
import { AccessToken, jitter, message, mimeOf, sameSecret, sleep } from './net.ts'
import type {
  AdapterIO,
  ChannelAdapter,
  ChannelChat,
  Inbound,
  InboundFile,
  OutMessage,
  SentRef,
} from './types.ts'
import { chatIdOf } from './types.ts'

/**
 * DingTalk robots through the Open Platform over plain HTTP and WebSocket (no SDK), ported from Hermes's adapter
 * (which uses dingtalk-stream): Stream mode by default (a WebSocket the app opens, so nothing needs to be
 * reachable), or the HTTP callback with its HMAC signature checked; replies go through the message's session
 * webhook while it lasts, then the robot send API; pictures, files, voice and video come in. DingTalk cannot edit a
 * robot's message, and its buttons (ActionCards) only open links, so approvals and questions are typed.
 */

export const DINGTALK_API = 'https://api.dingtalk.com'
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
const BOT_TOPIC = '/v1.0/im/bot/messages/get'
/** A session webhook this close to expiring is not used (Hermes keeps the same margin). */
const WEBHOOK_MARGIN_MS = 5 * 60 * 1000
/** A signed callback more than this far from our clock is refused (DingTalk's own rule). */
const CALLBACK_WINDOW_MS = 60 * 60 * 1000
/** Session webhooks are only ever DingTalk's own addresses (or the API this adapter uses); nothing else is posted to. */
const SESSION_WEBHOOK = /^https:\/\/(?:api|oapi)\.dingtalk\.com\//

class DingTalkError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly refused = false,
  ) {
    super(message)
  }
}

/** A robot message, as Stream mode and the HTTP callback both deliver it. */
interface DtMessage {
  msgId?: string
  msgtype?: string
  conversationId?: string
  conversationType?: string
  conversationTitle?: string
  senderId?: string
  senderStaffId?: string
  senderNick?: string
  isInAtList?: boolean
  sessionWebhook?: string
  sessionWebhookExpiredTime?: number
  createAt?: number
  robotCode?: string
  text?: { content?: string }
  content?: {
    downloadCode?: string
    fileName?: string
    recognition?: string
    richText?: { text?: string; downloadCode?: string; pictureDownloadCode?: string; type?: string }[]
  }
}
interface StreamFrame {
  type?: 'SYSTEM' | 'EVENT' | 'CALLBACK'
  headers?: { topic?: string; messageId?: string; contentType?: string }
  data?: string
}

/** A message's title in the chat list: its first line without Markdown, short. */
const titleOf = (text: string) =>
  (text.split('\n').find((l) => l.trim()) ?? 'Myrmidon')
    .replace(/[#*_`>~[\]]/g, '')
    .trim()
    .slice(0, 20) || 'Myrmidon'

/** Work around DingTalk's Markdown renderer (after Hermes): a blank line before a numbered list, fences unindented. */
function dingMarkdown(text: string): string {
  const lines = text.split('\n')
  return lines
    .flatMap((line, i) => {
      const prev = i > 0 ? (lines[i - 1] ?? '').trim() : ''
      const numbered = /^\d+\.\s/
      const fixed = line.trim().startsWith('```') ? line.trimStart() : line
      return prev && numbered.test(line.trim()) && !numbered.test(prev) ? ['', fixed] : [fixed]
    })
    .join('\n')
}

export class DingTalkAdapter implements ChannelAdapter {
  readonly id = 'dingtalk'
  readonly label = 'DingTalk'
  /** A robot's Markdown message holds about 20,000 characters (Hermes's limit); DingTalk cannot edit them. */
  readonly limits = { text: 20_000, editMs: 1500 }
  readonly can = { buttons: false, files: false, edit: false }
  private readonly _token: AccessToken
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _io?: AdapterIO
  private _ws?: WebSocket

  constructor(
    private readonly config: { clientId: string; clientSecret: string; robotCode?: string },
    private readonly api = DINGTALK_API,
  ) {
    this._token = new AccessToken(async () => {
      let res: Response
      try {
        res = await fetch(`${this.api}/v1.0/oauth2/accessToken`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appKey: config.clientId, appSecret: config.clientSecret }),
        })
      } catch (err) {
        throw new DingTalkError(
          0,
          `cannot reach DingTalk: ${err instanceof Error ? err.name : 'network error'}`,
        )
      }
      const data = (await res.json().catch(() => ({}))) as { accessToken?: string; expireIn?: number }
      if (!res.ok || !data.accessToken)
        throw new DingTalkError(
          res.status,
          'DingTalk refused this Client ID and Client Secret; copy them again from the developer console',
          res.status >= 400 && res.status < 500,
        )
      return { token: data.accessToken, expiresIn: data.expireIn ?? 7200 }
    })
  }

  private get _robot() {
    return this.config.robotCode || this.config.clientId
  }

  /** One Open Platform call with the app's token; never logs it. */
  private async _call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const token = await this._token.get()
    let res: Response
    try {
      res = await fetch(`${this.api}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new DingTalkError(
        0,
        `cannot reach DingTalk: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
    const data = (await res.json().catch(() => ({}))) as T & { code?: string; message?: string }
    if (res.status === 401) this._token.reset()
    if (!res.ok) throw new DingTalkError(res.status, data.message ?? `DingTalk answered ${res.status}`)
    return data
  }

  async check(): Promise<string> {
    try {
      await this._token.get()
    } catch (err) {
      if (err instanceof DingTalkError && err.refused) throw new Error(err.message)
      throw err
    }
    return this.config.clientId
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      let checked = false
      while (!signal.aborted && !checked) {
        try {
          await this.check()
          checked = true
        } catch (err) {
          if (/refused this Client ID/.test(message(err)))
            return io.status({ state: 'error', error: message(err) })
          io.status({ state: 'retrying', error: message(err) })
          await sleep(jitter(backoff), signal)
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        }
      }
      backoff = BACKOFF_MIN_MS
      // Stream mode always runs; it needs nothing reachable, and is harmless when the robot is set to HTTP mode
      // (webhook() takes those).
      while (!signal.aborted) {
        try {
          if (await this._connect(signal)) backoff = BACKOFF_MIN_MS
          if (signal.aborted) break
          io.status({ state: 'retrying', error: 'the stream connection closed' })
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

  /** One Stream connection, until it closes; true when it opened. */
  private async _connect(signal: AbortSignal): Promise<boolean> {
    let res: Response
    try {
      res = await fetch(`${this.api}/v1.0/gateway/connections/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          subscriptions: [{ type: 'CALLBACK', topic: BOT_TOPIC }],
          ua: 'myrmidon',
        }),
        signal,
      })
    } catch (err) {
      if (signal.aborted) return false
      throw new DingTalkError(
        0,
        `cannot reach DingTalk: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
    const data = (await res.json().catch(() => ({}))) as {
      endpoint?: string
      ticket?: string
      message?: string
    }
    if (!res.ok || !data.endpoint || !data.ticket)
      throw new DingTalkError(
        res.status,
        `DingTalk would not open Stream mode: ${data.message ?? res.status}`,
      )
    const url = `${data.endpoint}?ticket=${encodeURIComponent(data.ticket)}`
    return new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url)
      this._ws = ws
      let opened = false
      ws.onopen = () => {
        opened = true
        this._io?.status({ state: 'on', account: this.config.clientId })
      }
      ws.onmessage = (ev) => {
        void this._frame(ws, String(ev.data)).catch((err) => this._io?.log(`stream: ${message(err)}`))
      }
      ws.onclose = () => {
        if (this._ws === ws) this._ws = undefined
        resolve(opened)
      }
      signal.addEventListener('abort', () => ws.close(), { once: true })
    })
  }

  /** A Stream frame: pings are echoed, a disconnect notice closes (to reconnect), robot messages are acked. */
  private async _frame(ws: WebSocket, raw: string) {
    const frame = JSON.parse(raw) as StreamFrame
    const headers = frame.headers ?? {}
    const ack = (data: unknown) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({
            code: 200,
            headers: { contentType: 'application/json', messageId: headers.messageId ?? '' },
            message: 'OK',
            data: JSON.stringify(data),
          }),
        )
    }
    if (frame.type === 'SYSTEM') {
      if (headers.topic === 'ping')
        ws.send(JSON.stringify({ code: 200, headers, message: 'OK', data: frame.data ?? '' }))
      else if (headers.topic === 'disconnect') ws.close()
      return
    }
    if (frame.type === 'CALLBACK' && headers.topic === BOT_TOPIC) {
      const m = this._inbound(JSON.parse(frame.data ?? '{}') as DtMessage)
      if (m) await this._io?.receive(m)
      return ack({ response: null })
    }
    ack({ status: 'SUCCESS', message: 'success' })
  }

  /**
   * The robot's HTTP callback (for a robot set to HTTP mode): accepted only with DingTalk's signature, an HMAC-SHA256
   * of the timestamp with the Client Secret, within an hour of now.
   */
  async webhook(req: Request): Promise<Response> {
    const ts = req.headers.get('timestamp') ?? ''
    const sign = req.headers.get('sign') ?? ''
    const expected = createHmac('sha256', this.config.clientSecret)
      .update(`${ts}\n${this.config.clientSecret}`)
      .digest('base64')
    if (Math.abs(Date.now() - Number(ts)) > CALLBACK_WINDOW_MS || !sameSecret(sign, expected))
      return new Response('unauthorized', { status: 401 })
    const body = (await req.json().catch(() => undefined)) as DtMessage | undefined
    const m = body && this._inbound(body)
    if (m) await this._io?.receive(m)
    return Response.json({})
  }

  private _file(
    kind: InboundFile['kind'],
    code: string,
    name: string,
    mime: string,
    robot: string,
  ): InboundFile {
    return {
      kind,
      name,
      mimeType: mime,
      read: async () => {
        const { downloadUrl } = await this._call<{ downloadUrl?: string }>(
          '/v1.0/robot/messageFiles/download',
          {
            downloadCode: code,
            robotCode: robot,
          },
        )
        if (!downloadUrl) throw new Error('DingTalk gave no address for the file')
        const res = await fetch(downloadUrl)
        if (!res.ok) throw new Error(`DingTalk answered ${res.status} for the file`)
        return new Uint8Array(await res.arrayBuffer())
      },
    }
  }

  /** A robot message as the hub's; its reply address and kind of chat are kept for sending later. */
  private _inbound(d: DtMessage): Inbound | undefined {
    const chatId = d.conversationId
    const senderId = d.senderStaffId || d.senderId
    if (!chatId || !senderId) return undefined
    const kind = d.conversationType === '2' ? 'group' : 'dm'
    const io = this._io
    io?.set(`kind:${chatId}`, kind)
    if (kind === 'dm' && d.senderStaffId) io?.set(`staff:${chatId}`, d.senderStaffId)
    if (
      d.sessionWebhook &&
      (SESSION_WEBHOOK.test(d.sessionWebhook) || d.sessionWebhook.startsWith(`${this.api}/`))
    )
      io?.set(
        `hook:${chatId}`,
        JSON.stringify({ url: d.sessionWebhook, until: d.sessionWebhookExpiredTime ?? 0 }),
      )
    const robot = d.robotCode || this._robot
    const id = d.msgId ?? `${chatId}:${d.createAt ?? Date.now()}`
    const c = d.content ?? {}
    const files: InboundFile[] = []
    let text = ''
    let unsupported = false
    switch (d.msgtype) {
      case 'text':
        text = (d.text?.content ?? '').trim()
        break
      case 'richText':
        for (const item of c.richText ?? []) {
          if (item.text) text += item.text
          const code = item.downloadCode ?? item.pictureDownloadCode
          if (code) files.push(this._file('image', code, `image-${files.length}.png`, 'image/png', robot))
        }
        text = text.trim()
        break
      case 'picture':
        if (c.downloadCode)
          files.push(this._file('image', c.downloadCode, `image-${id}.png`, 'image/png', robot))
        break
      case 'file': {
        const name = c.fileName ?? `file-${id}`
        if (c.downloadCode) files.push(this._file('document', c.downloadCode, name, mimeOf(name), robot))
        break
      }
      case 'audio':
        // DingTalk transcribes voice messages itself; its text is used when there is one.
        if (c.recognition?.trim()) text = c.recognition.trim()
        else if (c.downloadCode)
          files.push(this._file('voice', c.downloadCode, `voice-${id}.amr`, 'audio/amr', robot))
        break
      case 'video':
        if (c.downloadCode)
          files.push(this._file('video', c.downloadCode, `video-${id}.mp4`, 'video/mp4', robot))
        break
      default:
        unsupported = true
    }
    if (!text && !files.length && !unsupported) return undefined
    return {
      messageId: id,
      chat: { id: chatId, kind, ...(d.conversationTitle ? { title: d.conversationTitle } : {}) },
      sender: { id: senderId, name: d.senderNick || 'DingTalk user' },
      text,
      // In a group DingTalk delivers only messages that @mention the robot; isInAtList says so.
      mentioned: kind === 'dm' || Boolean(d.isInAtList),
      ...(files.length ? { files } : {}),
      ...(unsupported ? { unsupported: true } : {}),
      time: new Date(d.createAt ?? Date.now()).toISOString(),
    }
  }

  /**
   * Markdown through the chat's session webhook while it is valid (no permission needed), else the robot send API
   * (one person by staff id, or the group), which needs the robot's send-message permission.
   */
  async send(chat: ChannelChat | string, m: OutMessage): Promise<SentRef> {
    const id = chatIdOf(chat)
    const markdown = { title: titleOf(m.text), text: dingMarkdown(m.text) }
    const saved = this._io?.get(`hook:${id}`)
    const hook = saved ? (JSON.parse(saved) as { url: string; until: number }) : undefined
    if (hook && (!hook.until || hook.until - WEBHOOK_MARGIN_MS > Date.now())) {
      let res: Response
      try {
        res = await fetch(hook.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ msgtype: 'markdown', markdown }),
        })
      } catch (err) {
        throw new DingTalkError(
          0,
          `cannot reach DingTalk: ${err instanceof Error ? err.name : 'network error'}`,
        )
      }
      const data = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
      if (res.ok && !data.errcode) return { chat: id, id: crypto.randomUUID() }
      // An expired or refused session webhook: the robot API may still reach the chat.
      this._io?.log(`session webhook refused (${data.errmsg ?? res.status}); using the robot API`)
    }
    const kind = this._io?.get(`kind:${id}`) ?? (typeof chat === 'string' ? 'dm' : chat.kind)
    const msgParam = JSON.stringify(markdown)
    if (kind === 'group') {
      const r = await this._call<{ processQueryKey?: string }>('/v1.0/robot/groupMessages/send', {
        robotCode: this._robot,
        openConversationId: id,
        msgKey: 'sampleMarkdown',
        msgParam,
      })
      return { chat: id, id: r.processQueryKey ?? crypto.randomUUID() }
    }
    const staff = this._io?.get(`staff:${id}`)
    if (!staff) throw new Error('DingTalk can only answer this chat after its next message')
    const r = await this._call<{ processQueryKey?: string }>('/v1.0/robot/oToMessages/batchSend', {
      robotCode: this._robot,
      userIds: [staff],
      msgKey: 'sampleMarkdown',
      msgParam,
    })
    return { chat: id, id: r.processQueryKey ?? crypto.randomUUID() }
  }

  async edit(): Promise<void> {
    throw new Error('DingTalk cannot edit a robot message')
  }

  /** DingTalk has no typing indicator for robots. */
  async typing(): Promise<void> {}
}
