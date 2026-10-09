import { randomBytes } from 'node:crypto'
import { channelCopy } from '../channels/copy.ts'
import { type TwilioAccount, twilioRequest, twilioSigned } from '../channels/sms.ts'
import { PHONE_MESSAGE_MAX, PHONE_START_MS, PHONE_TICKET_MS } from '../config.ts'
import { prompts } from '../prompts.ts'
import { mulawDecode, mulawEncode, Resampler, resample } from './audio.ts'
import type { CallChats, CallOutput, CallSession } from './call.ts'
import type { VoiceHub } from './hub.ts'

/**
 * Phone calls on the SMS channel's Twilio number, as OpenClaw's voice-call plugin does them: Twilio posts each call to
 * the number's voice webhook (checked against `X-Twilio-Signature`, as SMS posts are), which answers with TwiML that
 * connects the call to a bidirectional Media Stream; the call's audio then comes over a WebSocket as base64 μ-law at
 * 8 kHz (`start`, `media`, `mark`, `stop` events), into the same pipeline as a call in the app. Its speech goes back as
 * `media` messages with the stream's sid, and `clear` empties what Twilio has buffered when the person talks over it.
 * Closing the socket ends the call (nothing follows `<Connect>` in the TwiML). Who may call is the SMS channel's
 * business: the people it lets in, by its own rules; unknown numbers are rejected unanswered, or texted a pairing code.
 *
 * Twilio: https://www.twilio.com/docs/voice/media-streams/websocket-messages,
 * https://www.twilio.com/docs/voice/twiml/stream, https://www.twilio.com/docs/usage/webhooks/webhooks-security.
 * OpenClaw (MIT): https://github.com/openclaw/openclaw/tree/main/extensions/voice-call.
 */

/** Twilio Media Streams' audio, both ways: `audio/x-mulaw`, 8 kHz, mono. */
const LINE_RATE = 8000
/** The rate the call runs at: Silero VAD and Smart Turn are 16 kHz models. */
const CALL_RATE = 16_000

/** Where Twilio posts the number's calls, and where it opens their audio streams (under the SMS channel's hook). */
export const PHONE_HOOK = '/hooks/channels/sms/voice'
export const PHONE_STREAM = '/hooks/channels/sms/stream'

/** Someone the SMS channel lets in, about to be on a call. */
export interface PhoneCaller {
  /** Its owner: they decide approvals by their yes or no, as in the app. */
  readonly owner: boolean
  /** Their name on the channel (a number, for SMS). */
  readonly name: string
  /** The channel's label, which marks a member's words to the crew. */
  readonly label: string
  /** The chat their texts continue, which the call continues too. */
  readonly chatId?: string
  readonly project?: string
}

export interface PhonePorts {
  /** The SMS channel's Twilio account and number while it runs. */
  account(): (TwilioAccount & { readonly number: string }) | undefined
  /** Whether phone calls are on (Settings → Voice), with voice calls themselves. */
  enabled(): boolean
  /** The gateway's public address (an origin), which Twilio must reach. */
  readonly publicUrl?: string
  /**
   * Whether `number` may talk to the crew, by the SMS channel's rules; `ask`: a stranger may be texted a pairing code
   * (`pairing`). Undefined: not let in.
   */
  admit(number: string, ask: boolean): Promise<PhoneCaller | 'pairing' | undefined>
  /** A call from `number` made a new chat. */
  chatMade(number: string, chatId: string): void
  /** What the call calls the owner. */
  ownerName(): string
  /** The chat's title and crew, for the call assistant. */
  describe?(
    chatId: string,
  ): Promise<{ title?: string; crew?: readonly { name: string; role?: string }[] } | undefined>
  readonly voice: Pick<VoiceHub, 'call' | 'refusal' | 'warm'>
  readonly chats: CallChats
  log(line: string): void
}

export type PhoneStatus =
  | { readonly state: 'off' }
  /** The SMS channel is not running, or phone calls lack an https public address. */
  | { readonly state: 'error'; readonly error: string }
  | { readonly state: 'connecting' }
  | { readonly state: 'on'; readonly number: string }

/** The socket a Media Stream came in on. */
export interface PhoneSocket {
  send(text: string): void
  close(code?: number, reason?: string): void
}

/** What Twilio sends on a Media Stream; only the fields used here. */
interface StreamMessage {
  event?: string
  streamSid?: string
  start?: { accountSid?: string; callSid?: string; customParameters?: Record<string, string> }
  media?: { track?: string; payload?: string }
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const twiml = (body: string, status = 200) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status,
    headers: { 'content-type': 'text/xml' },
  })
/** Not answered at all, so not billed (https://www.twilio.com/docs/voice/twiml/reject). */
const REJECT = '<Reject reason="rejected"/>'
const say = (text: string) => `<Say>${xml(text)}</Say><Hangup/>`

export class PhoneLine {
  /** One-time tickets in the TwiML of calls this line answered or made, by ticket: who is on the other end. */
  private readonly _tickets = new Map<string, { number: string; caller: PhoneCaller; expires: number }>()
  private _state: PhoneStatus = { state: 'connecting' }

  constructor(private readonly ports: PhonePorts) {}

  /** The voice webhook's address, as Twilio is given it (and signs it). */
  get hookUrl(): string | undefined {
    return this.ports.publicUrl ? `${this.ports.publicUrl}${PHONE_HOOK}` : undefined
  }

  /** The Media Stream's address: Twilio takes only wss. */
  get streamUrl(): string | undefined {
    const url = this.ports.publicUrl
    return url?.startsWith('https://') ? `wss://${url.slice('https://'.length)}${PHONE_STREAM}` : undefined
  }

  /** Why calls cannot be taken now, or undefined. */
  private _blocked(): string | undefined {
    if (!this.ports.enabled()) return channelCopy.errors.phoneOff
    if (!this.ports.account()) return channelCopy.errors.phoneSms
    if (!this.streamUrl) return channelCopy.errors.phonePublic
    return undefined
  }

  status(): PhoneStatus {
    if (!this.ports.enabled()) return { state: 'off' }
    const blocked = this._blocked()
    return blocked ? { state: 'error', error: blocked } : this._state
  }

  /**
   * Points the number's voice webhook here, as the SMS channel points its messages; run when phone calls are turned
   * on, the SMS channel changes, or the gateway starts. Turned off, the number is left as it is: calls are then
   * rejected here unanswered.
   */
  async sync(): Promise<void> {
    const account = this.ports.account()
    const hook = this.hookUrl
    if (this._blocked() || !account || !hook) return
    this._state = { state: 'connecting' }
    try {
      const found = await twilioRequest<{
        incoming_phone_numbers?: {
          sid: string
          phone_number: string
          voice_url?: string | null
          voice_application_sid?: string | null
          trunk_sid?: string | null
        }[]
      }>(account, 'GET', `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(account.number)}`)
      const number = found.incoming_phone_numbers?.find((n) => n.phone_number === account.number)
      if (!number) throw new Error(channelCopy.errors.smsNumber(account.number))
      // Twilio calls neither the voice URL of a number with an app or a trunk (IncomingPhoneNumber resource).
      if (number.voice_application_sid || number.trunk_sid)
        throw new Error(channelCopy.errors.phoneApp(account.number))
      if (number.voice_url !== hook) {
        await twilioRequest(account, 'POST', `/IncomingPhoneNumbers/${encodeURIComponent(number.sid)}.json`, {
          VoiceUrl: hook,
          VoiceMethod: 'POST',
        })
        this.ports.log(
          `pointed ${account.number}'s voice webhook here${number.voice_url ? ` (it was ${number.voice_url})` : ''}`,
        )
      }
      this._state = { state: 'on', number: account.number }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this._state = { state: 'error', error }
      this.ports.log(error)
    }
  }

  /** A call to the number, posted by Twilio: answered with a Media Stream for someone SMS lets in. */
  async incoming(req: Request): Promise<Response> {
    const account = this.ports.account()
    const hook = this.hookUrl
    const params = new URLSearchParams(await req.text().catch(() => ''))
    // Twilio signs the address it was given, the public one (the request may arrive through a proxy).
    if (
      !account ||
      !hook ||
      !twilioSigned(account.token, hook, params, req.headers.get('x-twilio-signature') ?? '') ||
      params.get('AccountSid') !== account.sid
    )
      return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain' } })
    const from = params.get('From')?.trim() ?? ''
    // Calls this line makes carry their own TwiML; anything else posted here is not one to answer.
    if (this._blocked() || params.get('Direction') !== 'inbound' || !from) return twiml(REJECT)
    const caller = await this.ports.admit(from, true)
    if (caller === 'pairing') return twiml(say(prompts.voice.phone.pairing))
    if (!caller) return twiml(REJECT)
    void this.ports.voice.warm()
    const refused = this.ports.voice.refusal(caller.chatId)
    if (refused) {
      this.ports.log(`could not take a call from ${from}: ${refused.message}`)
      return twiml(say(prompts.voice.phone.unavailable))
    }
    return twiml(this._connect(from, caller))
  }

  /** Calls `number` (someone SMS lets in; undefined when there is no owner to call) from the number; returns the call's sid. */
  async dial(number: string | undefined): Promise<string> {
    if (!number) throw new Error(channelCopy.errors.phoneNoOwner)
    const blocked = this._blocked()
    const account = this.ports.account()
    if (blocked || !account) throw new Error(blocked ?? channelCopy.errors.phoneSms)
    const caller = await this.ports.admit(number, false)
    if (!caller || caller === 'pairing') throw new Error(channelCopy.errors.phoneNotAllowed(number))
    const refused = this.ports.voice.refusal(caller.chatId)
    if (refused) throw refused
    // The TwiML goes with the call (the Calls resource's `Twiml`), so the webhook only ever answers inbound calls.
    const call = await twilioRequest<{ sid: string }>(account, 'POST', '/Calls.json', {
      To: number,
      From: account.number,
      Twiml: `<Response>${this._connect(number, caller)}</Response>`,
    })
    void this.ports.voice.warm()
    return call.sid
  }

  /** TwiML connecting the call to a Media Stream, with a one-time ticket naming who is on the other end. */
  private _connect(number: string, caller: PhoneCaller): string {
    const now = Date.now()
    for (const [k, t] of this._tickets) if (t.expires < now) this._tickets.delete(k)
    const ticket = randomBytes(18).toString('base64url')
    this._tickets.set(ticket, { number, caller, expires: now + PHONE_TICKET_MS })
    // The stream URL takes no query string: values travel as <Parameter>s, in its `start` message.
    return `<Connect><Stream url="${xml(this.streamUrl ?? '')}"><Parameter name="ticket" value="${ticket}"/></Stream></Connect>`
  }

  /**
   * Whether a Media Stream's upgrade request is Twilio's: signed (header in lowercase on WebSockets) over the wss
   * address it was given, with no parameters. The ticket in its `start` then says which call it is.
   */
  streamSigned(req: Request): boolean {
    const account = this.ports.account()
    const url = this.streamUrl
    return Boolean(
      account &&
        url &&
        twilioSigned(account.token, url, new URLSearchParams(), req.headers.get('x-twilio-signature') ?? ''),
    )
  }

  /** A Media Stream that just opened; its call starts with its `start` message. */
  stream(socket: PhoneSocket): PhoneStream {
    return new PhoneStream(socket, this.ports, (ticket) => {
      const found = ticket ? this._tickets.get(ticket) : undefined
      if (ticket) this._tickets.delete(ticket)
      return found && found.expires >= Date.now() ? found : undefined
    })
  }
}

/** One call's audio stream from Twilio, carried to and from a call session. */
export class PhoneStream {
  private _sid?: string
  private _session?: CallSession
  private readonly _in = new Resampler(LINE_RATE, CALL_RATE)
  private readonly _timer: ReturnType<typeof setTimeout>
  private _closed = false

  constructor(
    private readonly socket: PhoneSocket,
    private readonly ports: PhonePorts,
    private readonly redeem: (
      ticket: string | undefined,
    ) => { number: string; caller: PhoneCaller } | undefined,
  ) {
    this._timer = setTimeout(() => this._close(1008, 'no start'), PHONE_START_MS)
  }

  /** A message from Twilio. */
  message(raw: string) {
    if (this._closed) return
    if (raw.length > PHONE_MESSAGE_MAX) return this._close(1009, 'message too large')
    let msg: StreamMessage
    try {
      msg = JSON.parse(raw) as StreamMessage
    } catch {
      return
    }
    if (msg.event === 'start') void this._start(msg)
    else if (msg.event === 'media') {
      // Only the caller's own audio (a bidirectional stream has no other track, but say so).
      if (!this._session || (msg.media?.track && msg.media.track !== 'inbound') || !msg.media?.payload) return
      const ulaw = new Uint8Array(Buffer.from(msg.media.payload, 'base64'))
      this._session.audio(this._in.push(mulawDecode(ulaw)))
    } else if (msg.event === 'stop') this._session?.hangUp()
    // `connected` comes before `start`; `mark` and `dtmf` are not used.
  }

  /** The socket closed (the call ended, or Twilio went away). */
  closed() {
    this._closed = true
    clearTimeout(this._timer)
    this._session?.hangUp()
  }

  private async _start(msg: StreamMessage) {
    if (this._sid) return
    clearTimeout(this._timer)
    const account = this.ports.account()
    const found = this.redeem(msg.start?.customParameters?.ticket)
    if (!found || !account || msg.start?.accountSid !== account.sid || !msg.streamSid)
      return this._close(1008, 'not a call this gateway answered')
    this._sid = msg.streamSid
    const { number, caller } = found
    // Usually warm already: the webhook started it.
    await this.ports.voice.warm()
    const chat = caller.chatId ? await this.ports.describe?.(caller.chatId).catch(() => undefined) : undefined
    if (this._closed) return
    let session: CallSession
    try {
      session = this.ports.voice.call(
        this.ports.chats,
        {
          ...(caller.chatId ? { chatId: caller.chatId } : {}),
          ...(chat?.title ? { chatTitle: chat.title } : {}),
          ...(chat?.crew?.length ? { crew: chat.crew } : {}),
          ...(caller.project ? { project: caller.project } : {}),
          name: caller.owner ? this.ports.ownerName() : prompts.voice.phone.member,
          ...(caller.owner ? {} : { member: { name: caller.name, channel: caller.label } }),
          phone: number,
          sampleRate: CALL_RATE,
        },
        (out) => this._out(out, number, caller),
      )
    } catch (err) {
      this.ports.log(
        `could not take a call with ${number}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return this._close(1011, 'call refused')
    }
    this._session = session
    await session.start()
  }

  private _out(out: CallOutput, number: string, caller: PhoneCaller) {
    if (out.type === 'audio') {
      const ulaw = mulawEncode(resample(out.pcm, out.sampleRate, LINE_RATE))
      this._send({
        event: 'media',
        streamSid: this._sid,
        media: { payload: Buffer.from(ulaw).toString('base64') },
      })
    } else if (out.type === 'stop-audio') this._send({ event: 'clear', streamSid: this._sid })
    else if (out.type === 'chat' && !caller.chatId) this.ports.chatMade(number, out.chatId)
    else if (out.type === 'error') this.ports.log(`call with ${number}: ${out.message}`)
    else if (out.type === 'latency')
      this.ports.log(
        `answered in ${out.ms} ms (heard ${out.heard}, first words ${out.thought}, first sound ${out.voiced})`,
      )
    // Nothing follows <Connect> in the TwiML, so closing the stream ends the call.
    else if (out.type === 'ended') this._close(1000, 'call ended')
  }

  private _send(message: unknown) {
    if (this._closed) return
    try {
      this.socket.send(JSON.stringify(message))
    } catch {
      // The socket went away; its close ends the call.
    }
  }

  private _close(code: number, reason: string) {
    if (this._closed) return
    this._closed = true
    clearTimeout(this._timer)
    this._session?.hangUp()
    try {
      this.socket.close(code, reason)
    } catch {
      // Already closed.
    }
  }
}
