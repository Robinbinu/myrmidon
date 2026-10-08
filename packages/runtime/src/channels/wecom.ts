import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { AccessToken, jitter, message, plainText, sameSecret, sleep, splitBytes } from './net.ts'
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
 * WeCom (WeChat Work) self-built apps in callback mode, ported from Hermes's `wecom_callback` adapter: WeCom posts
 * each message, AES-encrypted and signed, to the gateway's public address (the GET handshake answered too); the
 * access token is cached; replies go out through `message/send`; images, voice, video and files come in through
 * `media/get` and go out through `media/upload`. Apps only receive direct messages; WeCom cannot edit sent
 * messages, and Hermes sends no buttons here, so approvals and questions are typed.
 */

export const WECOM_API = 'https://qyapi.weixin.qq.com'
/** `message/send` keeps only the first 2048 bytes of a text and drops the rest without saying so. */
const TEXT_BYTES = 2048
/** WeCom's upload limits: images 10 MB, files 20 MB. */
const IMAGE_MAX = 10 * 1024 * 1024
const FILE_MAX = 20 * 1024 * 1024
/** Callbacks are small encrypted XML envelopes; anything bigger is refused before any work. */
const BODY_MAX = 64 * 1024
/** WeCom's codes for a token that is invalid or expired: fetch a new one and try once more. */
const TOKEN_CODES = new Set([40001, 40014, 42001])
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000

class WeComError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

/** A tag's text in WeCom's flat XML (`<Tag><![CDATA[…]]></Tag>` or `<Tag>123</Tag>`); no entities, no nesting. */
function xmlTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${tag}>`).exec(xml)
  return m ? (m[1] ?? m[2] ?? '') : undefined
}

const sha1 = (parts: string[]) =>
  createHash('sha1')
    .update([...parts].sort().join(''))
    .digest('hex')

/**
 * WeCom's message crypto (Tencent's WXBizMsgCrypt): AES-256-CBC with the EncodingAESKey (base64, 43 characters) as
 * key and its first 16 bytes as IV, PKCS#7 padded to 32 bytes; the plain text is 16 random bytes, the message
 * length (4 bytes, big-endian), the message, and the corp ID. The signature is SHA-1 of the sorted token, timestamp,
 * nonce and ciphertext.
 */
export class WeComCrypto {
  private readonly key: Buffer

  constructor(
    private readonly token: string,
    encodingAesKey: string,
    private readonly corpId: string,
  ) {
    if (encodingAesKey.length !== 43) throw new Error('the EncodingAESKey must be 43 characters')
    this.key = Buffer.from(`${encodingAesKey}=`, 'base64')
  }

  signature(timestamp: string, nonce: string, encrypted: string) {
    return sha1([this.token, timestamp, nonce, encrypted])
  }

  /** The message inside, or undefined when the signature, padding or corp ID is wrong. */
  decrypt(signature: string, timestamp: string, nonce: string, encrypted: string): string | undefined {
    if (!sameSecret(signature, this.signature(timestamp, nonce, encrypted))) return undefined
    try {
      const decipher = createDecipheriv('aes-256-cbc', this.key, this.key.subarray(0, 16))
      decipher.setAutoPadding(false)
      const padded = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()])
      const pad = padded.at(-1) ?? 0
      if (pad < 1 || pad > 32) return undefined
      const plain = padded.subarray(16, padded.length - pad)
      const length = plain.readUInt32BE(0)
      if (plain.subarray(4 + length).toString('utf8') !== this.corpId) return undefined
      return plain.subarray(4, 4 + length).toString('utf8')
    } catch {
      return undefined
    }
  }

  encrypt(text: string): string {
    const body = Buffer.from(text, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    const plain = Buffer.concat([randomBytes(16), length, body, Buffer.from(this.corpId, 'utf8')])
    const pad = 32 - (plain.length % 32)
    const cipher = createCipheriv('aes-256-cbc', this.key, this.key.subarray(0, 16))
    cipher.setAutoPadding(false)
    return Buffer.concat([
      cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])),
      cipher.final(),
    ]).toString('base64')
  }
}

export class WeComAdapter implements ChannelAdapter {
  readonly id = 'wecom'
  readonly label = 'WeCom'
  /** Under 2048 bytes in most languages; longer pieces are split by bytes before sending. */
  readonly limits = { text: 2000, editMs: 1500, file: FILE_MAX }
  readonly can = { buttons: false, files: true, edit: false }
  private readonly _token: AccessToken
  private readonly _crypto?: WeComCrypto
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  private readonly _names = new Map<string, string>()

  constructor(
    private readonly config: {
      corpId: string
      agentId: string
      secret: string
      token: string
      aesKey: string
    },
    private readonly api = WECOM_API,
  ) {
    try {
      this._crypto = new WeComCrypto(config.token, config.aesKey, config.corpId)
    } catch {
      // check() says what is wrong; the webhook refuses everything meanwhile.
    }
    this._token = new AccessToken(async () => {
      const q = new URLSearchParams({ corpid: config.corpId, corpsecret: config.secret })
      const data = await this._get<{ access_token?: string; expires_in?: number }>(`/cgi-bin/gettoken?${q}`)
      if (!data.access_token) throw new WeComError(-1, 'WeCom gave no access token')
      return { token: data.access_token, expiresIn: data.expires_in ?? 7200 }
    })
  }

  /** A GET to WeCom; never logs the URL (it carries the secret or the token). */
  private async _get<T>(path: string): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.api}${path}`)
    } catch (err) {
      throw new WeComError(0, `cannot reach WeCom: ${err instanceof Error ? err.name : 'network error'}`)
    }
    const data = (await res.json().catch(() => ({}))) as T & { errcode?: number; errmsg?: string }
    if (data.errcode) throw new WeComError(data.errcode, data.errmsg ?? `WeCom answered ${res.status}`)
    if (!res.ok) throw new WeComError(res.status, `WeCom answered ${res.status}`)
    return data
  }

  /** A call with the access token, renewed once if WeCom says it went stale. */
  private async _call<T>(
    path: string,
    body?: Record<string, unknown> | FormData,
    retried = false,
  ): Promise<T> {
    const token = await this._token.get()
    const url = `${this.api}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
    let res: Response
    try {
      res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        ...(body instanceof FormData
          ? { body }
          : body
            ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
      })
    } catch (err) {
      throw new WeComError(0, `cannot reach WeCom: ${err instanceof Error ? err.name : 'network error'}`)
    }
    const data = (await res.json().catch(() => ({}))) as T & { errcode?: number; errmsg?: string }
    if (data.errcode && TOKEN_CODES.has(data.errcode) && !retried) {
      this._token.reset()
      return this._call(path, body, true)
    }
    if (data.errcode) throw new WeComError(data.errcode, data.errmsg ?? `WeCom answered ${res.status}`)
    return data
  }

  async check(): Promise<string> {
    if (!this._crypto) throw new Error('The EncodingAESKey must be 43 characters; copy it again from WeCom')
    try {
      await this._token.get()
    } catch (err) {
      if (err instanceof WeComError && err.code > 0)
        throw new Error(`WeCom refused this corp ID and secret (${err.message}); copy them again`)
      throw err
    }
    try {
      const agent = await this._call<{ name?: string }>(
        `/cgi-bin/agent/get?agentid=${encodeURIComponent(this.config.agentId)}`,
      )
      return agent.name ?? `app ${this.config.agentId}`
    } catch (err) {
      throw new Error(`WeCom does not know app ${this.config.agentId} with this secret (${message(err)})`)
    }
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      while (!signal.aborted) {
        try {
          const account = await this.check()
          if (!io.webhookUrl)
            return io.status({
              state: 'error',
              error:
                "WeCom sends messages to a public HTTPS address: start the gateway with --public-url, then set the app's receive-message URL to <public-url>/hooks/channels/wecom",
            })
          return io.status({ state: 'on', account })
        } catch (err) {
          const why = message(err)
          if (/refused|does not know|43 characters/.test(why))
            return io.status({ state: 'error', error: why })
          io.status({ state: 'retrying', error: why })
          await sleep(jitter(backoff), signal)
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
   * WeCom's callback: a GET to check the address (the echoed string decrypted), or a POST of an encrypted message;
   * anything not signed with the app's token, or not for this corp, is refused.
   */
  async webhook(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams
    const signature = q.get('msg_signature') ?? ''
    const timestamp = q.get('timestamp') ?? ''
    const nonce = q.get('nonce') ?? ''
    if (!this._crypto) return new Response('forbidden', { status: 403 })
    if (req.method === 'GET') {
      const echo = this._crypto.decrypt(signature, timestamp, nonce, q.get('echostr') ?? '')
      return echo === undefined ? new Response('forbidden', { status: 403 }) : new Response(echo)
    }
    const body = await req.text()
    if (body.length > BODY_MAX) return new Response('too large', { status: 413 })
    const xml = this._crypto.decrypt(signature, timestamp, nonce, xmlTag(body, 'Encrypt') ?? '')
    if (xml === undefined) return new Response('forbidden', { status: 403 })
    const m = await this._inbound(xml)
    if (m) await this._io?.receive(m)
    // Answered at once; the reply goes out later through message/send.
    return new Response('success')
  }

  /** A person's name in the directory (needs the app to see them), or their user id. */
  private async _name(userId: string): Promise<string> {
    const known = this._names.get(userId)
    if (known) return known
    let name = userId
    try {
      name =
        (await this._call<{ name?: string }>(`/cgi-bin/user/get?userid=${encodeURIComponent(userId)}`))
          .name || name
    } catch {
      // Apps outside the directory's visible range cannot read names; the id is shown instead.
    }
    this._names.set(userId, name)
    return name
  }

  private _media(kind: InboundFile['kind'], mediaId: string, name: string, mime: string): InboundFile {
    return {
      kind,
      name,
      mimeType: mime,
      read: async () => {
        const token = await this._token.get()
        const res = await fetch(
          `${this.api}/cgi-bin/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`,
        )
        if (!res.ok || res.headers.get('content-type')?.includes('json'))
          throw new Error(`WeCom answered ${res.status} for the file`)
        return new Uint8Array(await res.arrayBuffer())
      },
    }
  }

  /** A decrypted callback as the hub's message; undefined for events (entering the app, subscribing). */
  private async _inbound(xml: string): Promise<Inbound | undefined> {
    const type = (xmlTag(xml, 'MsgType') ?? '').toLowerCase()
    const from = xmlTag(xml, 'FromUserName')
    if (!from || type === 'event') return undefined
    const created = Number(xmlTag(xml, 'CreateTime') ?? 0)
    const id = xmlTag(xml, 'MsgId') || `${from}:${created}`
    const media = xmlTag(xml, 'MediaId') ?? ''
    const files: InboundFile[] = []
    let text = ''
    if (type === 'text') text = (xmlTag(xml, 'Content') ?? '').trim()
    else if (type === 'image' && media)
      files.push(this._media('image', media, `image-${id}.jpg`, 'image/jpeg'))
    else if (type === 'voice' && media) {
      const format = (xmlTag(xml, 'Format') ?? 'amr').toLowerCase()
      files.push(this._media('voice', media, `voice-${id}.${format}`, `audio/${format}`))
    } else if (type === 'video' && media)
      files.push(this._media('video', media, `video-${id}.mp4`, 'video/mp4'))
    else if (type === 'file' && media) {
      const name = xmlTag(xml, 'FileName') || `file-${id}`
      files.push(this._media('document', media, name, 'application/octet-stream'))
    }
    return {
      messageId: id,
      chat: { id: from, kind: 'dm' },
      sender: { id: from, name: await this._name(from), handle: from },
      text,
      mentioned: true,
      ...(files.length ? { files } : {}),
      ...(!text && !files.length ? { unsupported: true } : {}),
      time: new Date((created || Date.now() / 1000) * 1000).toISOString(),
    }
  }

  private async _sendMessage(to: string, body: Record<string, unknown>): Promise<SentRef> {
    const r = await this._call<{ msgid?: string }>('/cgi-bin/message/send', {
      touser: to,
      agentid: Number(this.config.agentId),
      safe: 0,
      ...body,
    })
    return { chat: to, id: r.msgid ?? crypto.randomUUID() }
  }

  /** As plain text (WeCom's Markdown shows only in the WeCom app, not in WeChat), split under 2048 bytes. */
  async send(chat: ChannelChat | string, m: OutMessage): Promise<SentRef> {
    const to = chatIdOf(chat)
    let ref: SentRef | undefined
    for (const piece of splitBytes(plainText(m.text), TEXT_BYTES))
      ref = await this._sendMessage(to, { msgtype: 'text', text: { content: piece } })
    return ref ?? { chat: to, id: '' }
  }

  async edit(): Promise<void> {
    throw new Error('WeCom cannot edit a sent message')
  }

  /** WeCom has no typing indicator for apps. */
  async typing(): Promise<void> {}

  /** Uploads to WeCom's temporary media, then sends it: images inline, everything else as a file. */
  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const image = /^image\/(png|jpeg|gif)$/.test(file.mimeType) && file.data.byteLength <= IMAGE_MAX
    const type = image ? 'image' : 'file'
    const form = new FormData()
    form.set('media', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.name)
    const { media_id } = await this._call<{ media_id?: string }>(`/cgi-bin/media/upload?type=${type}`, form)
    if (file.caption) await this.send(chat, { text: file.caption })
    return this._sendMessage(chatIdOf(chat), { msgtype: type, [type]: { media_id } })
  }
}
