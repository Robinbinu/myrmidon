import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { channelCopy } from './copy.ts'
import { jitter, message, mimeOf, sleep } from './net.ts'
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
import { chatIdOf } from './types.ts'

/**
 * WeChat (personal account) through Tencent's iLink Bot API, ported from Hermes's `weixin.py`: the account is linked
 * by scanning a QR code with WeChat; long-polled `getupdates` brings messages in; every reply echoes the person's
 * latest `context_token`; media moves through an AES-128-ECB encrypted CDN. iLink cannot edit messages and has no
 * buttons; the linked identity (an `…@im.bot` account) usually cannot be added to ordinary groups, so in practice it
 * answers direct messages.
 */

export const ILINK_API = 'https://ilinkai.weixin.qq.com'
export const WEIXIN_CDN = 'https://novac2c.cdn.weixin.qq.com/c2c'
const APP_ID = 'bot'
const CHANNEL_VERSION = '2.2.0'
const CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0)
const POLL_MS = 35_000
const API_MS = 15_000
const QR_MS = 35_000
/** After this many failed polls in a row, wait longer (Hermes: 3 failures, 2 s apart, then 30 s). */
const FAILURES = 3
const RETRY_MS = 2000
const BACKOFF_MS = 30_000
/** iLink says the session expired: Hermes pauses ten minutes before polling again. */
const EXPIRED_PAUSE_MS = 10 * 60 * 1000
const EXPIRED = -14
const RATE_LIMITED = -2
/** A code that expires is renewed this many times before linking gives up. */
const QR_REFRESHES = 3
const SEND_RETRIES = 4
const SEND_RETRY_MS = 1000
/** Pause between the bubbles of one message. */
const BUBBLE_MS = 1500
const TYPING_TICKET_MS = 600_000
/** iLink re-sends identical text under new message ids; the same text from the same person this soon is dropped. */
const CONTENT_DEDUPE_MS = 300_000
/** Lines longer than this are wrapped, since long lines are hard to copy in WeChat. */
const LINE_WIDTH = 120
const ITEM = { text: 1, image: 2, voice: 3, file: 4, video: 5 } as const
const MEDIA = { image: 1, video: 2, file: 3 } as const
/** The only hosts a message's own media addresses may point at (anything else would be a request forgery). */
const CDN_HOSTS = new Set([
  'novac2c.cdn.weixin.qq.com',
  'ilinkai.weixin.qq.com',
  'wx.qlogo.cn',
  'thirdwx.qlogo.cn',
  'res.wx.qq.com',
  'mmbiz.qpic.cn',
  'mmbiz.qlogo.cn',
])

interface Account {
  accountId: string
  token: string
  baseUrl: string
  userId?: string
}
interface WxMedia {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
}
interface WxItem {
  type?: number
  text_item?: { text?: string }
  image_item?: { media?: WxMedia; aeskey?: string }
  voice_item?: { media?: WxMedia; text?: string }
  file_item?: { media?: WxMedia; file_name?: string }
  video_item?: { media?: WxMedia }
  ref_msg?: { title?: string; message_item?: WxItem }
}
interface WxMessage {
  message_id?: string | number
  from_user_id?: string
  to_user_id?: string
  room_id?: string
  chat_room_id?: string
  msg_type?: number
  context_token?: string
  create_time_ms?: number
  item_list?: WxItem[]
}
interface WxReply {
  ret?: number
  errcode?: number
  errmsg?: string
  msg?: string
}

class IlinkError extends Error {
  constructor(
    message: string,
    readonly kind: 'expired' | 'rate' | 'stale' | 'other' = 'other',
  ) {
    super(message)
  }
}

/** What an iLink answer's codes mean: fine, a stale or expired session, a rate limit, or another failure. */
function verdict(r: WxReply): IlinkError | undefined {
  const ret = r.ret ?? 0
  const code = r.errcode ?? 0
  if (!ret && !code) return undefined
  const msg = r.errmsg ?? r.msg ?? 'unknown error'
  const text = `iLink answered ret=${ret} errcode=${code}: ${msg}`
  // A -2 saying "unknown error" or "prepare failed" is a stale session, not a real rate limit (Hermes #80125).
  const stale =
    (ret === RATE_LIMITED || code === RATE_LIMITED) && /^(unknown error|prepare failed)$/i.test(msg)
  if (ret === EXPIRED || code === EXPIRED || stale) return new IlinkError(text, stale ? 'stale' : 'expired')
  if (ret === RATE_LIMITED || code === RATE_LIMITED) return new IlinkError(text, 'rate')
  return new IlinkError(text)
}

/** iLink's media keys: base64 of 16 raw bytes, or base64 of 32 hex characters. */
function aesKey(b64: string): Buffer {
  const raw = Buffer.from(b64, 'base64')
  if (raw.length === 16) return raw
  const hex = raw.toString('ascii')
  if (raw.length === 32 && /^[0-9a-f]+$/i.test(hex)) return Buffer.from(hex, 'hex')
  throw new Error(`unexpected media key (${raw.length} bytes)`)
}

function ecbDecrypt(data: Buffer, key: Buffer): Buffer {
  const d = createDecipheriv('aes-128-ecb', key, null)
  d.setAutoPadding(false)
  const padded = Buffer.concat([d.update(data), d.final()])
  const pad = padded.at(-1) ?? 0
  // Padding stripped only when well formed (else the raw output, as Hermes does).
  return pad >= 1 && pad <= 16 && padded.subarray(-pad).every((b) => b === pad)
    ? padded.subarray(0, -pad)
    : padded
}

const ecbEncrypt = (data: Buffer, key: Buffer) => {
  const c = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([c.update(data), c.final()])
}

/** Long lines wrapped at spaces (code, tables and blank lines left alone), blank runs collapsed (after Hermes). */
export function weixinText(markdown: string): string {
  const out: string[] = []
  let inCode = false
  let blank = 0
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd()
    const fence = /^```/.test(line.trim())
    if (!fence && !inCode && !line.trim()) {
      if (++blank <= 1) out.push('')
      continue
    }
    blank = 0
    if (fence || inCode || line.length <= LINE_WIDTH || line.trim().startsWith('|')) out.push(line)
    else {
      let current = ''
      for (const word of line.split(/\s+/).filter(Boolean)) {
        if (current && current.length + 1 + word.length > LINE_WIDTH) {
          out.push(current)
          current = word
        } else current = current ? `${current} ${word}` : word
      }
      if (current) out.push(current)
    }
    if (fence) inCode = !inCode
  }
  return out.join('\n').trim()
}

/** A short exchange of chatty lines (2–6, none a heading, list or table) reads better as separate bubbles. */
function bubbles(text: string): string[] {
  const lines = text.split('\n').filter((l) => l.trim())
  const chatty = (l: string) =>
    l.trim().length <= 48 &&
    !/^[ \t]/.test(l) &&
    !/^[>\-*【#|]/.test(l.trim()) &&
    !/^\*\*[^*]+\*\*$/.test(l.trim()) &&
    !/^\d+\.\s/.test(l.trim())
  const first = lines[0]?.trim() ?? ''
  const heading = /^#{1,6}\s/.test(first) || (first.length <= 24 && /[:：]$/.test(first))
  return lines.length >= 2 && lines.length <= 6 && !heading && lines.every(chatty) ? lines : [text]
}

export class WeixinAdapter implements ChannelAdapter {
  readonly id = 'weixin'
  readonly label = 'WeChat'
  /** iLink splits at about 2048 characters; Hermes sends at most 2000. WeChat cannot edit messages. */
  readonly limits = { text: 2000, editMs: 1500 }
  readonly can = { buttons: false, files: true, edit: false }
  private _account?: Account
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  /** Sends one at a time, as iLink expects. */
  private _gate: Promise<unknown> = Promise.resolve()
  private readonly _tickets = new Map<string, { ticket: string; at: number }>()
  private readonly _seen = new Map<string, number>()

  constructor(
    private readonly api = ILINK_API,
    private readonly cdn = WEIXIN_CDN,
  ) {}

  private _file(dir: string) {
    return join(dir, 'account.json')
  }

  private _headers(body: string, token?: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'content-length': String(Buffer.byteLength(body)),
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
      'iLink-App-Id': APP_ID,
      'iLink-App-ClientVersion': CLIENT_VERSION,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    }
  }

  /** A POST to iLink with the linked account's token; never logs it. */
  private async _post<T extends WxReply>(endpoint: string, payload: Record<string, unknown>, ms = API_MS) {
    const account = this._account
    if (!account) throw new IlinkError('WeChat is not linked yet')
    const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } })
    let res: Response
    try {
      res = await fetch(`${account.baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: this._headers(body, account.token),
        body,
        signal: AbortSignal.timeout(ms),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') throw err
      throw new IlinkError(`cannot reach WeChat: ${err instanceof Error ? err.name : 'network error'}`)
    }
    if (!res.ok) throw new IlinkError(`iLink answered HTTP ${res.status}`)
    return (await res.json()) as T
  }

  private async _getJson<T>(base: string, endpoint: string, ms: number): Promise<T> {
    const res = await fetch(`${base}/${endpoint}`, {
      headers: { 'iLink-App-Id': APP_ID, 'iLink-App-ClientVersion': CLIENT_VERSION },
      signal: AbortSignal.timeout(ms),
    })
    if (!res.ok) throw new IlinkError(`iLink answered HTTP ${res.status}`)
    return (await res.json()) as T
  }

  async check(): Promise<string> {
    return this._account?.accountId ?? 'not linked yet: turn it on and scan the code with WeChat'
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    const path = this._file(io.dir)
    if (existsSync(path)) {
      try {
        this._account = JSON.parse(readFileSync(path, 'utf8')) as Account
      } catch {
        this._account = undefined
      }
    }
    this._loop = (async () => {
      if (!this._account) {
        this._account = await this._link(io, signal)
        if (!this._account) return
        writeFileSync(path, JSON.stringify(this._account), { mode: 0o600 })
      }
      await this._poll(io, signal)
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
  }

  /** Links an account by QR code (Hermes's `qr_login`): shows the code, waits for the scan and the confirmation. */
  private async _link(io: AdapterIO, signal: AbortSignal): Promise<Account | undefined> {
    let base = this.api
    let refreshes = 0
    let scanned = false
    const fetchCode = async () => {
      const r = await this._getJson<{ qrcode?: string; qrcode_img_content?: string }>(
        this.api,
        'ilink/bot/get_bot_qrcode?bot_type=3',
        QR_MS,
      )
      if (!r.qrcode) throw new IlinkError('iLink gave no QR code')
      // WeChat scans the page address in qrcode_img_content, not the bare code.
      const content = r.qrcode_img_content || r.qrcode
      io.status({
        state: 'linking',
        qr: content,
        image: await QRCode.toDataURL(content),
        hint: channelCopy.weixin.scan,
      })
      return { code: r.qrcode, content }
    }
    let qr: { code: string; content: string }
    let wait = RETRY_MS
    for (;;) {
      try {
        qr = await fetchCode()
        break
      } catch (err) {
        if (signal.aborted) return undefined
        io.status({ state: 'retrying', error: message(err) })
        await sleep(jitter(wait), signal)
        wait = Math.min(wait * 2, BACKOFF_MS)
      }
    }
    while (!signal.aborted) {
      let s: { status?: string; redirect_host?: string } & Record<string, string | undefined>
      try {
        s = await this._getJson(
          base,
          `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.code)}`,
          QR_MS,
        )
      } catch {
        await sleep(1000, signal)
        continue
      }
      if (s.status === 'scaned' && !scanned) {
        scanned = true
        io.status({
          state: 'linking',
          qr: qr.content,
          image: await QRCode.toDataURL(qr.content),
          hint: channelCopy.weixin.scanned,
        })
      } else if (s.status === 'scaned_but_redirect' && s.redirect_host) base = `https://${s.redirect_host}`
      else if (s.status === 'expired') {
        if (++refreshes > QR_REFRESHES) {
          io.status({ state: 'error', error: channelCopy.weixin.expired })
          return undefined
        }
        try {
          qr = await fetchCode()
          scanned = false
        } catch (err) {
          io.status({ state: 'error', error: message(err) })
          return undefined
        }
      } else if (s.status === 'confirmed') {
        if (!s.ilink_bot_id || !s.bot_token) {
          io.status({ state: 'error', error: 'WeChat confirmed the link but sent no account; scan again' })
          return undefined
        }
        return {
          accountId: s.ilink_bot_id,
          token: s.bot_token,
          baseUrl: (s.baseurl || this.api).replace(/\/$/, ''),
          ...(s.ilink_user_id ? { userId: s.ilink_user_id } : {}),
        }
      }
      await sleep(1000, signal)
    }
    return undefined
  }

  /** The long poll: messages handed to the hub, then the cursor saved (so a crash re-delivers rather than loses). */
  private async _poll(io: AdapterIO, signal: AbortSignal) {
    const account = this._account?.accountId ?? ''
    io.status({ state: 'on', account })
    let cursor = io.get('cursor') ?? ''
    let timeout = POLL_MS
    let failures = 0
    while (!signal.aborted) {
      try {
        let r: WxReply & { msgs?: WxMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number }
        try {
          r = await this._post('ilink/bot/getupdates', { get_updates_buf: cursor }, timeout + 5000)
        } catch (err) {
          if (!(err instanceof Error && err.name === 'TimeoutError')) throw err
          r = { msgs: [], get_updates_buf: cursor }
        }
        if (r.longpolling_timeout_ms && r.longpolling_timeout_ms > 0) timeout = r.longpolling_timeout_ms
        const bad = verdict(r)
        if (bad?.kind === 'expired' || bad?.kind === 'stale') {
          io.status({ state: 'retrying', error: channelCopy.weixin.sessionExpired })
          await sleep(EXPIRED_PAUSE_MS, signal)
          failures = 0
          continue
        }
        if (bad) throw bad
        if (failures) io.status({ state: 'on', account })
        failures = 0
        for (const msg of r.msgs ?? []) {
          const m = this._inbound(msg)
          if (m) await io.receive(m)
        }
        if (r.get_updates_buf && r.get_updates_buf !== cursor) {
          cursor = r.get_updates_buf
          io.set('cursor', cursor)
        }
      } catch (err) {
        if (signal.aborted) break
        failures++
        io.status({ state: 'retrying', error: message(err) })
        const streak = failures >= FAILURES
        await sleep(jitter(streak ? BACKOFF_MS : RETRY_MS), signal)
        if (streak) failures = 0
      }
    }
  }

  private _media(kind: InboundFile['kind'], media: WxMedia, name: string, mime: string, hexKey?: string) {
    return {
      kind,
      name,
      mimeType: mime,
      read: async () => {
        let url: string
        if (media.encrypt_query_param)
          url = `${this.cdn}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
        else if (media.full_url) {
          const u = new URL(media.full_url)
          if (!/^https?:$/.test(u.protocol) || !CDN_HOSTS.has(u.hostname))
            throw new Error(`refusing to fetch media from ${u.hostname}`)
          url = media.full_url
        } else throw new Error('the media item has no address')
        const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
        if (!res.ok) throw new Error(`WeChat's CDN answered ${res.status}`)
        const raw = Buffer.from(await res.arrayBuffer())
        // An image may carry a raw hex key beside its media block, which wins.
        const key = hexKey ? Buffer.from(hexKey, 'hex') : media.aes_key ? aesKey(media.aes_key) : undefined
        return new Uint8Array(key ? ecbDecrypt(raw, key) : raw)
      },
    } satisfies InboundFile
  }

  /** The text of an item list, with what it quotes (after Hermes's `_extract_text`). */
  private _text(items: WxItem[]): string {
    const t = channelCopy.weixin
    for (const item of items) {
      if (item.type !== ITEM.text) continue
      const text = item.text_item?.text ?? ''
      const ref = item.ref_msg
      const quoted = ref?.message_item
      if (quoted?.type && quoted.type !== ITEM.text)
        return `${t.quotedMedia(ref?.title ?? '')}\n${text}`.trim()
      if (quoted) {
        const parts = [ref?.title ?? '', this._text([quoted])].filter(Boolean)
        if (parts.length) return `${t.quoted(parts.join(' | '))}\n${text}`.trim()
      }
      return text
    }
    return ''
  }

  /** A message as the hub's; undefined for the bot's own, repeats, and empty ones. */
  private _inbound(msg: WxMessage): Inbound | undefined {
    const io = this._io
    const account = this._account?.accountId ?? ''
    const from = String(msg.from_user_id ?? '').trim()
    if (!from || from === account) return undefined
    const items = msg.item_list ?? []
    let text = this._text(items)
    const now = Date.now()
    for (const [k, at] of this._seen) if (now - at > CONTENT_DEDUPE_MS) this._seen.delete(k)
    if (text) {
      const k = `${from}:${createHash('md5').update(text).digest('hex')}`
      if (this._seen.has(k)) return undefined
      this._seen.set(k, now)
    }
    const room = String(msg.room_id ?? msg.chat_room_id ?? '').trim()
    const to = String(msg.to_user_id ?? '').trim()
    const group = Boolean(room) || (Boolean(to) && Boolean(account) && to !== account && msg.msg_type === 1)
    const chatId = group ? room || to || from : from
    if (msg.context_token) io?.set(`ctx:${from}`, msg.context_token)
    const id = String(msg.message_id ?? `${from}:${msg.create_time_ms ?? now}`)
    const files: InboundFile[] = []
    for (const item of items) {
      const quoted = item.ref_msg?.message_item
      for (const it of quoted ? [item, quoted] : [item]) {
        if (it.type === ITEM.image && it.image_item?.media)
          files.push(
            this._media('image', it.image_item.media, `image-${id}.jpg`, 'image/jpeg', it.image_item.aeskey),
          )
        else if (it.type === ITEM.video && it.video_item?.media)
          files.push(this._media('video', it.video_item.media, `video-${id}.mp4`, 'video/mp4'))
        else if (it.type === ITEM.file && it.file_item?.media) {
          const name = it.file_item.file_name || 'document.bin'
          files.push(this._media('document', it.file_item.media, name, mimeOf(name)))
        } else if (it.type === ITEM.voice && it === item) {
          // WeChat's own transcript is used when there is one: its voice notes are SILK, which the transcription
          // services Myrmidon uses cannot read. Without a transcript the recording is passed on.
          const heard = it.voice_item?.text?.trim()
          if (heard && !text) text = `${channelCopy.weixin.voice}\n${heard}`
          else if (it.voice_item?.media)
            files.push(this._media('voice', it.voice_item.media, `voice-${id}.silk`, 'audio/silk'))
        }
      }
    }
    if (!text && !files.length) return undefined
    return {
      messageId: id,
      chat: { id: chatId, kind: group ? 'group' : 'dm' },
      sender: { id: from, name: from },
      text,
      mentioned: true,
      ...(files.length ? { files } : {}),
      time: new Date(msg.create_time_ms ?? now).toISOString(),
    }
  }

  /** One at a time through the gate, so bubbles and files keep their order. */
  private _serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this._gate.then(work, work)
    this._gate = run.catch(() => {})
    return run
  }

  /**
   * One message's items, echoing the person's context token. A stale or expired session is retried once without
   * the token (iLink accepts that as a fallback); a rate limit is waited out a few times (Hermes's send ladder).
   */
  private async _sendItems(to: string, items: unknown[]): Promise<string> {
    let context = this._io?.get(`ctx:${to}`)
    let attempt = 0
    for (;;) {
      const clientId = `myrmidon-weixin-${crypto.randomUUID()}`
      const msg = {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: items,
        ...(context ? { context_token: context } : {}),
      }
      let bad: IlinkError | undefined
      try {
        bad = verdict(await this._post('ilink/bot/sendmessage', { msg }))
      } catch (err) {
        bad = err instanceof IlinkError ? err : new IlinkError(message(err))
      }
      if (!bad) return clientId
      if ((bad.kind === 'expired' || bad.kind === 'stale') && context) {
        context = undefined
        continue
      }
      if (bad.kind === 'stale')
        throw new Error(
          'WeChat will not deliver until the person messages the bot again (or it is linked again)',
        )
      if (bad.kind !== 'rate' && bad.kind !== 'other') throw bad
      if (attempt >= SEND_RETRIES) throw bad
      attempt++
      await sleep(bad.kind === 'rate' ? SEND_RETRY_MS * 3 : SEND_RETRY_MS * attempt)
    }
  }

  async send(chat: ChannelChat | string, m: OutMessage): Promise<SentRef> {
    const to = chatIdOf(chat)
    const pieces = bubbles(weixinText(m.text)).filter((p) => p.trim())
    return this._serial(async () => {
      let id = ''
      for (const [i, piece] of pieces.entries()) {
        if (i) await sleep(BUBBLE_MS)
        id = await this._sendItems(to, [{ type: ITEM.text, text_item: { text: piece } }])
      }
      return { chat: to, id }
    })
  }

  async edit(): Promise<void> {
    throw new Error('WeChat cannot edit a sent message')
  }

  /** "Typing…" needs a ticket from getconfig, kept ten minutes. */
  async typing(chat: ChannelChat | string): Promise<void> {
    const to = chatIdOf(chat)
    let ticket = this._tickets.get(to)
    if (!ticket || Date.now() - ticket.at > TYPING_TICKET_MS) {
      const context = this._io?.get(`ctx:${to}`)
      const r = await this._post<WxReply & { typing_ticket?: string }>('ilink/bot/getconfig', {
        ilink_user_id: to,
        ...(context ? { context_token: context } : {}),
      })
      if (!r.typing_ticket) return
      ticket = { ticket: r.typing_ticket, at: Date.now() }
      this._tickets.set(to, ticket)
    }
    await this._post('ilink/bot/sendtyping', { ilink_user_id: to, typing_ticket: ticket.ticket, status: 1 })
  }

  /** Encrypted with a fresh key, uploaded to the CDN, then sent as an image, a video or a file. */
  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const to = chatIdOf(chat)
    const plain = Buffer.from(file.data)
    const kind = file.mimeType.startsWith('image/')
      ? 'image'
      : file.mimeType.startsWith('video/')
        ? 'video'
        : 'file'
    const filekey = randomBytes(16).toString('hex')
    const key = randomBytes(16)
    const md5 = createHash('md5').update(plain).digest('hex')
    const up = await this._post<WxReply & { upload_param?: string; upload_full_url?: string }>(
      'ilink/bot/getuploadurl',
      {
        filekey,
        media_type: MEDIA[kind],
        to_user_id: to,
        rawsize: plain.length,
        rawfilemd5: md5,
        filesize: (Math.floor(plain.length / 16) + 1) * 16,
        no_need_thumb: true,
        aeskey: key.toString('hex'),
      },
    )
    const bad = verdict(up)
    if (bad) throw bad
    const url =
      up.upload_full_url ||
      (up.upload_param
        ? `${this.cdn}/upload?encrypted_query_param=${encodeURIComponent(up.upload_param)}&filekey=${encodeURIComponent(filekey)}`
        : '')
    if (!url) throw new Error('iLink gave no upload address')
    const cipher = ecbEncrypt(plain, key)
    // POST, not PUT: the CDN answers PUT with 404.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: cipher,
      signal: AbortSignal.timeout(120_000),
    })
    const param = res.status === 200 ? res.headers.get('x-encrypted-param') : null
    if (!param) throw new Error(`WeChat's CDN answered ${res.status} without the upload's address`)
    // iLink wants the key as base64 of its hex form; base64 of the raw bytes shows images as grey boxes.
    const media = {
      encrypt_query_param: param,
      aes_key: Buffer.from(key.toString('hex')).toString('base64'),
      encrypt_type: 1,
    }
    const item =
      kind === 'image'
        ? { type: ITEM.image, image_item: { media, mid_size: cipher.length } }
        : kind === 'video'
          ? {
              type: ITEM.video,
              video_item: { media, video_size: cipher.length, play_length: 0, video_md5: md5 },
            }
          : { type: ITEM.file, file_item: { media, file_name: file.name, len: String(plain.length) } }
    return this._serial(async () => {
      if (file.caption)
        await this._sendItems(to, [{ type: ITEM.text, text_item: { text: weixinText(file.caption) } }])
      return { chat: to, id: await this._sendItems(to, [item]) }
    })
  }
}
