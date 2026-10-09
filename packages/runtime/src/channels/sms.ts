import { createHmac, timingSafeEqual } from 'node:crypto'
import { channelCopy } from './copy.ts'
import { plainText } from './format.ts'
import {
  type AdapterIO,
  type ChannelAdapter,
  type ChannelChat,
  chatIdOf,
  type Inbound,
  type InboundFile,
  type OutMessage,
  type SentRef,
} from './types.ts'

/**
 * SMS through Twilio's REST API (no library), ported from Hermes's adapter and OpenClaw's extension. Twilio
 * delivers texts only by posting them to a webhook, so it needs the gateway's public address: each post is checked
 * against `X-Twilio-Signature` (an HMAC-SHA1 of the URL and the sorted parameters with the auth token) and answered
 * with empty TwiML, and replies go out through the Messages API as plain text. The number's SMS webhook is pointed
 * at the gateway on start. MMS pictures come in as files, fetched from Twilio with the account's credentials.
 */

export const TWILIO_API = 'https://api.twilio.com'
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
/** Twilio's limit for one message's body (it is split into segments on the way). */
const SMS_MAX = 1600
/** Twilio caps an MMS at 5 MB. */
const MEDIA_MAX = 5 * 1024 * 1024
const REQUEST_MS = 30_000
/** Words carriers and Twilio handle themselves (opting out and back in); they never reach the crew. */
const KEYWORDS = new Set([
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'start',
  'yes',
  'unstop',
  'help',
  'info',
])
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

export class TwilioError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
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

/** Twilio's request signature: base64 HMAC-SHA1 of the URL followed by each parameter's name and value, sorted. */
export function twilioSignature(authToken: string, url: string, params: URLSearchParams): string {
  const data =
    url +
    [...params.keys()]
      .filter((k, i, all) => all.indexOf(k) === i)
      .sort()
      .map((k) =>
        params
          .getAll(k)
          .map((v) => k + v)
          .join(''),
      )
      .join('')
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64')
}

/** Twilio's account credentials and the API host they are used with. */
export interface TwilioAccount {
  readonly sid: string
  readonly token: string
  readonly api: string
}

/** A call to the account's REST API (form-encoded in, JSON out). Never logs or throws the credentials. */
export async function twilioRequest<T>(
  account: TwilioAccount,
  method: string,
  path: string,
  form?: Record<string, string>,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${account.api}/2010-04-01/Accounts/${encodeURIComponent(account.sid)}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${account.sid}:${account.token}`).toString('base64')}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      signal: AbortSignal.timeout(REQUEST_MS),
    })
  } catch (err) {
    throw new TwilioError(0, `cannot reach Twilio: ${err instanceof Error ? err.name : 'network error'}`)
  }
  const data = (await res.json().catch(() => ({}))) as T & { message?: string }
  if (!res.ok) throw new TwilioError(res.status, data.message ?? `Twilio answered ${res.status}`)
  return data
}

/** The URL with the scheme's default port added or removed: Twilio may sign either form (Hermes). */
function portVariant(url: string): string | undefined {
  const u = new URL(url)
  // A Media Stream's wss address has https's default port.
  const port =
    u.protocol === 'https:' || u.protocol === 'wss:'
      ? '443'
      : u.protocol === 'http:' || u.protocol === 'ws:'
        ? '80'
        : undefined
  if (!port) return undefined
  // URL drops a default port on parse, so add it by hand.
  const at = url.indexOf(u.host) + u.host.length
  return url.includes(`${u.hostname}:${port}`)
    ? url.replace(`${u.hostname}:${port}`, u.hostname)
    : `${url.slice(0, at)}:${port}${url.slice(at)}`
}

/** Whether `given` is Twilio's signature of this request, for the URL in either port form. */
export function twilioSigned(
  authToken: string,
  url: string,
  params: URLSearchParams,
  given: string,
): boolean {
  if (!authToken || !given) return false
  const g = Buffer.from(given)
  for (const candidate of [url, portVariant(url)]) {
    if (!candidate) continue
    const expected = Buffer.from(twilioSignature(authToken, candidate, params))
    if (g.length === expected.length && timingSafeEqual(g, expected)) return true
  }
  return false
}

const kindOf = (mime: string): InboundFile['kind'] =>
  mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('audio/')
      ? 'audio'
      : mime.startsWith('video/')
        ? 'video'
        : 'document'

const extension = (mime: string) => {
  const sub = (mime.split('/')[1] ?? 'bin').split(/[;+]/)[0] ?? 'bin'
  return sub === 'jpeg' ? 'jpg' : sub
}

export class SmsAdapter implements ChannelAdapter {
  readonly id = 'sms'
  readonly label = 'SMS'
  readonly limits = { text: SMS_MAX, editMs: 60_000 }
  readonly can = { buttons: false, files: false, edit: false }
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _io?: AdapterIO
  private _number?: { sid: string; smsUrl?: string }
  private readonly _from: string

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    number: string,
    private readonly api = TWILIO_API,
  ) {
    this._from = number.replace(/[\s()-]/g, '')
  }

  private get _auth() {
    return `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`
  }

  private _call<T>(method: string, path: string, form?: Record<string, string>): Promise<T> {
    return twilioRequest({ sid: this.accountSid, token: this.authToken, api: this.api }, method, path, form)
  }

  async check(): Promise<string> {
    let found: { incoming_phone_numbers?: { sid: string; phone_number: string; sms_url?: string }[] }
    try {
      found = await this._call(
        'GET',
        `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(this._from)}`,
      )
    } catch (err) {
      if (err instanceof TwilioError && (err.status === 401 || err.status === 403))
        throw new Error(channelCopy.errors.smsToken)
      throw err
    }
    const number = found.incoming_phone_numbers?.find((n) => n.phone_number === this._from)
    if (!number) throw new Error(channelCopy.errors.smsNumber(this._from))
    this._number = { sid: number.sid, ...(number.sms_url ? { smsUrl: number.sms_url } : {}) }
    return this._from
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    const url = io.webhookUrl
    if (!url) return io.status({ state: 'error', error: channelCopy.errors.smsPublic })
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      while (!signal.aborted) {
        try {
          const account = await this.check()
          const number = this._number
          if (number && number.smsUrl !== url) {
            // Twilio sends each text to the number's webhook, so it is pointed here (as Telegram's setWebhook).
            await this._call('POST', `/IncomingPhoneNumbers/${encodeURIComponent(number.sid)}.json`, {
              SmsUrl: url,
              SmsMethod: 'POST',
            })
            io.log(
              `pointed ${account}'s SMS webhook here${number.smsUrl ? ` (it was ${number.smsUrl})` : ''}`,
            )
          }
          return io.status({ state: 'on', account })
        } catch (err) {
          if (signal.aborted) return
          const message = err instanceof Error ? err.message : String(err)
          if (message === channelCopy.errors.smsToken || message === channelCopy.errors.smsNumber(this._from))
            return io.status({ state: 'error', error: message })
          io.status({ state: 'retrying', error: message })
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

  /** A text Twilio posted, accepted only with a valid signature from this account. */
  async webhook(req: Request): Promise<Response> {
    const twiml = (status = 200) =>
      new Response(status === 200 ? EMPTY_TWIML : 'forbidden', {
        status,
        headers: { 'content-type': status === 200 ? 'text/xml' : 'text/plain' },
      })
    const url = this._io?.webhookUrl
    const params = new URLSearchParams(await req.text().catch(() => ''))
    // Twilio signs the address it was given, which is the public one (the request may arrive through a proxy).
    if (!url || !twilioSigned(this.authToken, url, params, req.headers.get('x-twilio-signature') ?? ''))
      return twiml(403)
    if (params.get('AccountSid') !== this.accountSid) return twiml(403)
    const message = this._inbound(params)
    if (message) await this._io?.receive(message)
    return twiml()
  }

  private _media(url: string, messageSid: string, mimeType: string, index: number): InboundFile | undefined {
    // Only Twilio's own media for this very message, so a posted URL cannot make the gateway fetch elsewhere.
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    const prefix = `/2010-04-01/Accounts/${this.accountSid}/Messages/${messageSid}/Media/`
    if (parsed.origin !== new URL(this.api).origin || !parsed.pathname.startsWith(prefix)) return undefined
    return {
      kind: kindOf(mimeType),
      name: `mms-${index + 1}.${extension(mimeType)}`,
      mimeType,
      read: async () => {
        const res = await fetch(parsed, {
          headers: { authorization: this._auth },
          signal: AbortSignal.timeout(REQUEST_MS * 2),
        })
        if (!res.ok) throw new Error(`Twilio answered ${res.status} for the picture`)
        const data = new Uint8Array(await res.arrayBuffer())
        if (data.byteLength > MEDIA_MAX) throw new Error('Twilio pictures are at most 5 MB')
        return data
      },
    }
  }

  /** A Twilio post as the hub's message; undefined for our own number and carrier keywords. */
  private _inbound(p: URLSearchParams): Inbound | undefined {
    const from = p.get('From')?.trim() ?? ''
    const sid = p.get('MessageSid') ?? p.get('SmsSid') ?? ''
    const text = (p.get('Body') ?? '').trim()
    if (!from || !sid || from === this._from) return undefined
    if (KEYWORDS.has(text.toLowerCase())) return undefined
    const files: InboundFile[] = []
    const count = Math.min(10, Number(p.get('NumMedia') ?? 0) || 0)
    for (let i = 0; i < count; i++) {
      const url = p.get(`MediaUrl${i}`)
      const file =
        url && this._media(url, sid, p.get(`MediaContentType${i}`) || 'application/octet-stream', i)
      if (file) files.push(file)
    }
    if (!text && !files.length) return undefined
    return {
      messageId: sid,
      chat: { id: from, kind: 'dm' },
      sender: { id: from, name: from, handle: from },
      text,
      mentioned: true,
      ...(files.length ? { files } : {}),
      time: new Date().toISOString(),
    }
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const to = chatIdOf(chat)
    const sent = await this._call<{ sid: string }>('POST', '/Messages.json', {
      From: this._from,
      To: to,
      Body: plainText(message.text),
    })
    return { chat: to, id: sent.sid }
  }

  /** A text cannot be changed once sent; an edit sends nothing rather than a second text. */
  async edit(_ref: SentRef, _message: OutMessage): Promise<void> {}

  async typing(_chat: ChannelChat | string): Promise<void> {}
}
