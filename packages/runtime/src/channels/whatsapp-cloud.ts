import { createHmac, timingSafeEqual } from 'node:crypto'
import { channelCopy } from './copy.ts'
import { whatsappText } from './format.ts'
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
  type PressNote,
  type SentRef,
} from './types.ts'

/**
 * WhatsApp through Meta's official Cloud API (the WhatsApp Business Platform), ported from Hermes's
 * `whatsapp_cloud.py`: webhooks only (Meta's GET handshake with the verify token, and every POST checked against
 * `X-Hub-Signature-256`, an HMAC of the body with the app secret, before it is read), the Graph API for sending,
 * reply buttons (up to three) or a list (up to ten) for the hub's buttons, media fetched by id with the token, and
 * files sent by upload. Direct chats only: the Cloud API has no groups. It cannot edit a message, and Meta allows
 * free-form replies only within 24 hours of the person's last message.
 */

export const GRAPH_API = 'https://graph.facebook.com'
const GRAPH_VERSION = 'v21.0'
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
/** Meta's webhook bodies are at most 3 MB. */
const WEBHOOK_MAX = 3 * 1024 * 1024
/** Meta's caps: reply buttons (3, titles of 20), list rows (10, titles of 24, descriptions of 72), a body of 1024. */
const BUTTONS_MAX = 3
const ROWS_MAX = 10
const BODY_MAX = 1024
/** Images are sent as images up to Meta's 5 MB; documents up to 100 MB. */
const IMAGE_MAX = 5 * 1024 * 1024
/** A typing indicator shows for up to 25 s, so it is renewed no more often than this. */
const TYPING_MS = 20_000
/** Chats whose last message id is kept (the typing indicator and read receipt attach to it). */
const CHATS_KEPT = 1000
/** Graph error codes: a bad token, an unknown object, and a reply outside the 24-hour window. */
const BAD_TOKEN = 190
const NO_OBJECT = 100
const WINDOW_CLOSED = 131047

class CloudError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly status = 0,
  ) {
    super(message)
  }
}

interface CloudMedia {
  id?: string
  mime_type?: string
  caption?: string
  filename?: string
  voice?: boolean
}
interface CloudMessage {
  id?: string
  from?: string
  timestamp?: string
  type?: string
  /** Set on messages from a group; the Cloud API's groups are not supported here. */
  chat?: unknown
  context?: { from?: string; id?: string }
  text?: { body?: string }
  button?: { text?: string; payload?: string }
  interactive?: {
    button_reply?: { id?: string; title?: string }
    list_reply?: { id?: string; title?: string }
  }
  image?: CloudMedia
  video?: CloudMedia
  audio?: CloudMedia
  voice?: CloudMedia
  document?: CloudMedia
  sticker?: CloudMedia
}
interface CloudChange {
  field?: string
  value?: {
    metadata?: { phone_number_id?: string }
    contacts?: { wa_id?: string; profile?: { name?: string } }[]
    messages?: CloudMessage[]
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

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Constant-time comparison of two strings (a different length is simply unequal). */
function same(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export class WhatsAppCloudAdapter implements ChannelAdapter {
  readonly id = 'whatsapp-cloud'
  readonly label = 'WhatsApp Cloud API'
  /** Meta's text limit and largest document; `editMs` goes unused, since nothing is edited. */
  readonly limits = { text: 4096, editMs: 1500, file: 100 * 1024 * 1024 }
  readonly can = { buttons: true, files: true, edit: false }
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  /** The last message each chat sent, and when typing was last shown there. */
  private readonly _last = new Map<string, string>()
  private readonly _typed = new Map<string, number>()

  constructor(
    private readonly settings: {
      readonly phoneNumberId: string
      readonly token: string
      readonly appSecret: string
      readonly verifyToken: string
    },
    private readonly api = GRAPH_API,
  ) {}

  private _url(path: string) {
    return `${this.api}/${GRAPH_VERSION}/${path}`
  }

  /** A Graph API call with the token; never logs or throws the token. */
  private async _call<T>(path: string, init: { method?: string; json?: unknown; form?: FormData } = {}) {
    let res: Response
    try {
      res = await fetch(this._url(path), {
        method: init.method ?? (init.json || init.form ? 'POST' : 'GET'),
        headers: {
          authorization: `Bearer ${this.settings.token}`,
          ...(init.json ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.json ? { body: JSON.stringify(init.json) } : init.form ? { body: init.form } : {}),
      })
    } catch (err) {
      throw new CloudError(
        0,
        `${channelCopy.whatsappCloud.unreachable}: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } }
    if (!res.ok || data.error)
      throw new CloudError(
        data.error?.code ?? 0,
        data.error?.message ?? `the Graph API answered ${res.status}`,
        res.status,
      )
    return data as T
  }

  async check(): Promise<string> {
    try {
      const me = await this._call<{ display_phone_number?: string; verified_name?: string }>(
        `${encodeURIComponent(this.settings.phoneNumberId)}?fields=display_phone_number,verified_name`,
      )
      return (
        [me.verified_name, me.display_phone_number].filter(Boolean).join(' · ') || this.settings.phoneNumberId
      )
    } catch (err) {
      if (err instanceof CloudError && (err.status === 401 || err.code === BAD_TOKEN))
        throw new Error(channelCopy.whatsappCloud.refused)
      if (err instanceof CloudError && (err.status === 404 || err.code === NO_OBJECT))
        throw new Error(channelCopy.whatsappCloud.noNumber)
      throw err
    }
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    if (!io.webhookUrl) return io.status({ state: 'error', error: channelCopy.whatsappCloud.needsPublic })
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      while (!signal.aborted) {
        try {
          return io.status({ state: 'on', account: await this.check() })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (message === channelCopy.whatsappCloud.refused || message === channelCopy.whatsappCloud.noNumber)
            return io.status({ state: 'error', error: message })
          io.status({ state: 'retrying', error: message })
          // Jitter, so many gateways recovering together do not hit Meta at the same moment.
          await sleep(backoff * (0.75 + Math.random() * 0.5), signal)
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        }
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
  }

  /**
   * Meta's subscription handshake (GET: the verify token must match, then the challenge is echoed) and its
   * deliveries (POST: refused unless signed with the app secret). A signed delivery is always answered 200, even
   * when nothing in it is for this number: Meta retries anything else for days.
   */
  async webhook(req: Request): Promise<Response> {
    if (req.method === 'GET') {
      const q = new URL(req.url).searchParams
      if (q.get('hub.mode') !== 'subscribe') return new Response('bad mode', { status: 400 })
      if (!same(q.get('hub.verify_token') ?? '', this.settings.verifyToken))
        return new Response('forbidden', { status: 403 })
      const challenge = q.get('hub.challenge')
      if (!challenge) return new Response('no challenge', { status: 400 })
      return new Response(challenge, { headers: { 'content-type': 'text/plain' } })
    }
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
    const raw = Buffer.from(await req.arrayBuffer())
    if (raw.byteLength > WEBHOOK_MAX) return new Response('too large', { status: 413 })
    // The signature covers the raw bytes, so it is checked before anything is parsed.
    const given = (req.headers.get('x-hub-signature-256') ?? '').trim().toLowerCase()
    const expected = `sha256=${createHmac('sha256', this.settings.appSecret).update(raw).digest('hex')}`
    if (!same(given, expected)) return new Response('unauthorized', { status: 401 })
    let payload: { object?: string; entry?: { changes?: CloudChange[] }[] }
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      return new Response('bad json', { status: 400 })
    }
    if (payload.object !== 'whatsapp_business_account') return new Response('ok')
    for (const entry of payload.entry ?? [])
      for (const change of entry.changes ?? []) {
        const value = change.value
        // One Meta app can serve several numbers: only this one's messages are taken.
        if (change.field !== 'messages' || value?.metadata?.phone_number_id !== this.settings.phoneNumberId)
          continue
        const names = new Map(
          (value.contacts ?? []).map((c) => [c.wa_id ?? '', c.profile?.name?.trim() ?? ''] as const),
        )
        for (const raw of value.messages ?? []) {
          const message = this._inbound(raw, names)
          if (!message) continue
          const chat = message.chat.id
          if (this._last.size >= CHATS_KEPT && !this._last.has(chat))
            this._last.delete(this._last.keys().next().value ?? '')
          this._last.set(chat, message.messageId)
          try {
            await this._io?.receive(message)
          } catch (err) {
            this._io?.log(err instanceof Error ? err.message : String(err))
          }
        }
      }
    return new Response('ok')
  }

  private _file(kind: InboundFile['kind'], media: CloudMedia, name: string, mime: string): InboundFile {
    const mediaId = media.id ?? ''
    return {
      kind,
      name: media.filename || name,
      mimeType: media.mime_type?.split(';')[0]?.trim() || mime,
      read: async () => {
        // The id goes into a URL: only Meta's plain ids are accepted.
        if (!/^[A-Za-z0-9._-]+$/.test(mediaId)) throw new Error(`not a media id: ${mediaId.slice(0, 40)}`)
        const meta = await this._call<{ url?: string }>(mediaId)
        if (!meta.url) throw new Error('the Graph API gave no address for the file')
        // The address is signed but still wants the token (Meta's documentation says so).
        const res = await fetch(meta.url, { headers: { authorization: `Bearer ${this.settings.token}` } })
        if (!res.ok) throw new Error(`the Graph API answered ${res.status} for the file`)
        return new Uint8Array(await res.arrayBuffer())
      },
    }
  }

  /** A Cloud API message as the hub's; undefined for what channels ignore (reactions, system notes, groups). */
  private _inbound(m: CloudMessage, names: Map<string, string>): Inbound | undefined {
    const from = m.from?.trim()
    if (!from || !m.id || m.chat) return undefined
    const chat: ChannelChat = { id: from, kind: 'dm' }
    const name = names.get(from)
    const base = {
      messageId: m.id,
      chat,
      sender: { id: from, name: name || `+${from}`, handle: `+${from}` },
      mentioned: true,
      time: new Date(m.timestamp ? Number(m.timestamp) * 1000 : Date.now()).toISOString(),
    }
    const reply = m.interactive?.button_reply ?? m.interactive?.list_reply
    if (m.type === 'interactive' && reply?.id)
      return {
        ...base,
        text: '',
        press: { id: m.id, data: reply.id, message: { chat: from, id: m.context?.id ?? '' } },
      }
    const files: InboundFile[] = []
    if (m.type === 'image' && m.image)
      files.push(this._file('image', m.image, `photo-${m.id}.jpg`, 'image/jpeg'))
    if (m.type === 'video' && m.video)
      files.push(this._file('video', m.video, `video-${m.id}.mp4`, 'video/mp4'))
    const audio = m.type === 'audio' || m.type === 'voice' ? (m.audio ?? m.voice) : undefined
    if (audio) {
      const voice = m.type === 'voice' || Boolean(audio.voice)
      files.push(
        this._file(voice ? 'voice' : 'audio', audio, `${voice ? 'voice' : 'audio'}-${m.id}.ogg`, 'audio/ogg'),
      )
    }
    if (m.type === 'document' && m.document)
      files.push(this._file('document', m.document, `file-${m.id}`, 'application/octet-stream'))
    const text = (
      m.text?.body ??
      m.button?.text ??
      m.image?.caption ??
      m.video?.caption ??
      m.document?.caption ??
      ''
    ).trim()
    if (!text && !files.length) {
      // Reactions and system notes (a number changed) are not messages to answer.
      if (m.type === 'reaction' || m.type === 'system') return undefined
      return { ...base, text: '', unsupported: true }
    }
    return { ...base, text, ...(files.length ? { files } : {}) }
  }

  private async _message(to: string, body: Record<string, unknown>): Promise<SentRef> {
    try {
      const sent = await this._call<{ messages?: { id?: string }[] }>(
        `${encodeURIComponent(this.settings.phoneNumberId)}/messages`,
        { json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...body } },
      )
      return { chat: to, id: sent.messages?.[0]?.id ?? '' }
    } catch (err) {
      if (err instanceof CloudError && err.code === WINDOW_CLOSED)
        throw new Error(channelCopy.whatsappCloud.window)
      if (err instanceof CloudError && err.status)
        throw new Error(channelCopy.whatsappCloud.rejected(err.message))
      throw err
    }
  }

  /** The hub's buttons as Meta's: reply buttons for up to three, a list for up to ten, else numbered text. */
  private _interactive(text: string, buttons: readonly Button[]): Record<string, unknown> | undefined {
    if (buttons.length <= BUTTONS_MAX)
      return {
        type: 'button',
        body: { text },
        action: {
          buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.data, title: clip(b.label, 20) } })),
        },
      }
    if (buttons.length <= ROWS_MAX)
      return {
        type: 'list',
        body: { text },
        action: {
          button: channelCopy.whatsappCloud.choose,
          sections: [
            {
              rows: buttons.map((b) => ({
                id: b.data,
                title: clip(b.label, 24),
                ...(b.label.length > 24 ? { description: clip(b.label, 72) } : {}),
              })),
            },
          ],
        },
      }
    return undefined
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const to = chatIdOf(chat)
    const text = whatsappText(message.text)
    const buttons = (message.buttons ?? []).flat()
    if (!buttons.length) return this._message(to, { type: 'text', text: { body: text, preview_url: false } })
    // Longer than Meta allows with buttons: all but the last line goes first as a message of its own.
    const lines = text.trimEnd().split('\n')
    const long = text.length > BODY_MAX
    const body = long ? clip(lines.at(-1) ?? '', BODY_MAX) : text
    const interactive = this._interactive(body, buttons)
    if (!interactive) {
      // Too many choices for Meta's widgets: numbered, which the hub also accepts typed.
      const list = buttons.map((b, i) => `${i + 1}. ${b.label}`).join('\n')
      return this._message(to, { type: 'text', text: { body: `${text}\n\n${list}`, preview_url: false } })
    }
    if (long)
      await this._message(to, {
        type: 'text',
        text: { body: lines.slice(0, -1).join('\n'), preview_url: false },
      })
    return this._message(to, { type: 'interactive', interactive })
  }

  async edit(_ref: SentRef, _message: OutMessage): Promise<void> {
    throw new Error(channelCopy.whatsappCloud.noEdit)
  }

  /** Marks the chat's last message read with a typing indicator (Meta couples the two); renewed sparingly. */
  async typing(chat: ChannelChat | string): Promise<void> {
    const to = chatIdOf(chat)
    const last = this._last.get(to)
    if (!last || Date.now() - (this._typed.get(to) ?? 0) < TYPING_MS) return
    this._typed.set(to, Date.now())
    await this._call(`${encodeURIComponent(this.settings.phoneNumberId)}/messages`, {
      json: {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: last,
        typing_indicator: { type: 'text' },
      },
    })
  }

  /** Images small enough go as images; everything else as a document, uploaded first. */
  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const to = chatIdOf(chat)
    const image = /^image\/(png|jpeg)$/.test(file.mimeType) && file.data.byteLength <= IMAGE_MAX
    const form = new FormData()
    form.set('messaging_product', 'whatsapp')
    form.set('type', file.mimeType)
    form.set('file', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.name)
    const uploaded = await this._call<{ id?: string }>(
      `${encodeURIComponent(this.settings.phoneNumberId)}/media`,
      { form },
    )
    const caption = file.caption ? { caption: file.caption } : {}
    return image
      ? this._message(to, { type: 'image', image: { id: uploaded.id, ...caption } })
      : this._message(to, {
          type: 'document',
          document: { id: uploaded.id, filename: file.name, ...caption },
        })
  }

  /**
   * No toast to show as Telegram has, and the message with the buttons cannot be edited: a note (allowed, denied,
   * only the owner may) comes as a reply to the press.
   */
  async answerPress(press: ButtonPress, note?: PressNote): Promise<void> {
    const to = press.message?.chat
    // Notes arrive as messages here, so one that only repeats the pressed message is left out.
    if (!note || note.echo || !to) return
    await this._message(to, { type: 'text', text: { body: note.text }, context: { message_id: press.id } })
  }
}
