import { readFileSync } from 'node:fs'
import { googleChatText } from './format.ts'
import { JwtError, KeySet, signJwt, verifyJwt } from './jwt.ts'
import { connectPushed, download, kindOf, RefusedError, sleep } from './push.ts'
import {
  type AdapterIO,
  type ChannelAdapter,
  type ChannelChat,
  chatIdOf,
  type Inbound,
  type InboundFile,
  type OutMessage,
  type SentRef,
  threadOf,
} from './types.ts'

/**
 * Google Chat as an HTTP endpoint app (no library), ported from OpenClaw's and Hermes's adapters: Chat posts each
 * event to the gateway with a bearer token Google signs (checked against Google's keys: issuer
 * chat@system.gserviceaccount.com and the project number as audience, or a Google ID token for the endpoint URL);
 * replies go through the Chat API with a service account's token (a JWT it signs, traded for an access token).
 * Spaces' threads are conversations of their own, only @mentions of the app count in spaces, buttons are card
 * buttons, and messages are edited in place.
 */

export const GOOGLE_CHAT_API = 'https://chat.googleapis.com'
/** The keys Chat signs project-number tokens with, and Google's own for ID tokens. */
export const CHAT_KEYS = 'https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com'
export const GOOGLE_KEYS = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const CHAT_ISSUER = 'chat@system.gserviceaccount.com'
const SCOPE = 'https://www.googleapis.com/auth/chat.bot'
/** Google rotates these keys every few days and publishes the next ones well ahead. */
const KEYS_TTL_MS = 3600_000
const RETRY_MAX_S = 30

export class GoogleChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface ServiceAccount {
  client_email: string
  private_key: string
  private_key_id?: string
  token_uri?: string
}
interface GcUser {
  name?: string
  displayName?: string
  email?: string
  type?: string
}
interface GcSpace {
  name?: string
  type?: string
  spaceType?: string
  singleUserBotDm?: boolean
  displayName?: string
  spaceThreadingState?: string
}
interface GcAttachment {
  name?: string
  contentName?: string
  contentType?: string
  attachmentDataRef?: { resourceName?: string }
}
interface GcMessage {
  name?: string
  text?: string
  argumentText?: string
  sender?: GcUser
  createTime?: string
  thread?: { name?: string }
  threadReply?: boolean
  annotations?: { type?: string; userMention?: { user?: GcUser } }[]
  slashCommand?: unknown
  attachment?: GcAttachment[]
}
interface GcEvent {
  type?: string
  eventTime?: string
  space?: GcSpace
  user?: GcUser
  message?: GcMessage
  action?: { actionMethodName?: string; parameters?: { key?: string; value?: string }[] }
  common?: { parameters?: Record<string, string> }
}

export interface GoogleChatOptions {
  readonly api?: string
  readonly chatKeys?: string
  readonly googleKeys?: string
}

export class GoogleChatAdapter implements ChannelAdapter {
  readonly id = 'googlechat'
  readonly label = 'Google Chat'
  /** Chat takes 4096 characters a message (OpenClaw splits at 4000) and about one write a second per space. */
  readonly limits = { text: 4000, editMs: 1500 }
  /** Sending files needs a person's own authorization (media.upload refuses apps), so the hub lists them. */
  readonly can = { buttons: true, files: false, edit: true }
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _account?: ServiceAccount
  private _token?: { value: string; expires: number }
  private readonly _api: string
  private readonly _chatKeys: KeySet
  private readonly _googleKeys: KeySet

  /**
   * `audience` is the project number when the app's Authentication Audience is Project Number; otherwise (empty,
   * or the URL itself) tokens are Google ID tokens for the endpoint URL.
   */
  constructor(
    private readonly serviceAccount: string,
    private readonly audience = '',
    options: GoogleChatOptions = {},
  ) {
    this._api = options.api ?? GOOGLE_CHAT_API
    const chatKeys = options.chatKeys ?? CHAT_KEYS
    const googleKeys = options.googleKeys ?? GOOGLE_KEYS
    this._chatKeys = new KeySet(async () => chatKeys, KEYS_TTL_MS)
    this._googleKeys = new KeySet(async () => googleKeys, KEYS_TTL_MS)
  }

  /** The key, pasted as JSON or named by its path; read when first needed, so a bad one is a status, not a crash. */
  private _key(): ServiceAccount {
    if (this._account) return this._account
    const raw = this.serviceAccount.trim()
    let parsed: Partial<ServiceAccount>
    try {
      parsed = JSON.parse(raw.startsWith('{') ? raw : readFileSync(raw, 'utf8')) as Partial<ServiceAccount>
    } catch {
      throw new RefusedError(
        "the service account key is not JSON (or no such file): paste the whole key file's contents, or its path",
      )
    }
    if (!parsed.client_email || !parsed.private_key)
      throw new RefusedError('the service account key has no client_email or private_key: use a JSON key')
    this._account = parsed as ServiceAccount
    return this._account
  }

  /** An access token for the Chat API, kept until a minute before it expires. Never logged: it is a credential. */
  private async _accessToken(): Promise<string> {
    if (this._token && this._token.expires > Date.now() + 60_000) return this._token.value
    const account = this._key()
    const uri = account.token_uri ?? GOOGLE_TOKEN
    const now = Math.floor(Date.now() / 1000)
    let assertion: string
    try {
      assertion = await signJwt(
        { iss: account.client_email, scope: SCOPE, aud: uri, iat: now, exp: now + 3600 },
        account.private_key,
        account.private_key_id,
      )
    } catch {
      throw new RefusedError("the service account key's private_key is not a usable RSA key")
    }
    let res: Response
    try {
      res = await fetch(uri, {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      throw new GoogleChatError(
        0,
        `cannot reach Google: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string
      expires_in?: number
      error?: string
    }
    if (!res.ok || !data.access_token) {
      if (res.status === 400 || res.status === 401)
        throw new RefusedError(
          `Google refused this service account key (${data.error ?? res.status}); make a new key for it`,
        )
      throw new GoogleChatError(res.status, `Google answered ${res.status} for a token`)
    }
    this._token = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 }
    return data.access_token
  }

  private async _fetch(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
    let res: Response
    try {
      res = await fetch(`${this._api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await this._accessToken()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      })
    } catch (err) {
      if (err instanceof GoogleChatError || err instanceof RefusedError) throw err
      throw new GoogleChatError(
        0,
        `cannot reach Google Chat: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
    if (res.status === 401 && retry) {
      this._token = undefined
      return this._fetch(method, path, body, false)
    }
    const after = Number(res.headers.get('retry-after') ?? 0)
    if (res.status === 429 && retry && after > 0 && after <= RETRY_MAX_S) {
      await sleep(after * 1000)
      return this._fetch(method, path, body, false)
    }
    return res
  }

  private async _call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this._fetch(method, path, body)
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
    if (!res.ok)
      throw new GoogleChatError(res.status, data.error?.message ?? `Google Chat answered ${res.status}`)
    return data
  }

  async check(): Promise<string> {
    const account = this._key()
    try {
      await this._call('GET', '/v1/spaces?pageSize=1')
    } catch (err) {
      if (err instanceof GoogleChatError && err.status >= 400 && err.status < 500)
        throw new RefusedError(
          `Google Chat refused the app (${err.message}): enable the Google Chat API and configure the app in the Cloud console`,
        )
      throw err
    }
    return account.client_email
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    this._loop = connectPushed(this.label, io, this._abort.signal, () => this.check())
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
  }

  /** An event Chat posted, taken only with a token Google signed for this app; answered at once. */
  async webhook(req: Request): Promise<Response> {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
    if (!token) return new Response('unauthorized', { status: 401 })
    try {
      await this._verify(token)
    } catch (err) {
      this._io?.log(`refused a webhook: ${err instanceof Error ? err.message : String(err)}`)
      return new Response('unauthorized', { status: err instanceof JwtError ? 401 : 503 })
    }
    const event = (await req.json().catch(() => undefined)) as GcEvent | undefined
    if (!event || typeof event !== 'object') return new Response('bad request', { status: 400 })
    const message = this._inbound(event)
    // Recorded, not handled: the reply goes through the API later, so Chat gets its answer now.
    if (message) await this._io?.receive(message)
    return Response.json({})
  }

  private async _verify(token: string) {
    const audience = this.audience.trim()
    if (/^\d+$/.test(audience)) {
      await verifyJwt(token, this._chatKeys, { issuers: [CHAT_ISSUER], audience })
      return
    }
    const url = audience || this._io?.webhookUrl
    if (!url) throw new JwtError('no endpoint URL to check the audience against')
    const { claims } = await verifyJwt(token, this._googleKeys, {
      issuers: ['https://accounts.google.com', 'accounts.google.com'],
      audience: url,
    })
    // Any Google account can get an ID token for this URL; only Chat's own is taken.
    if (claims.email !== CHAT_ISSUER || claims.email_verified !== true)
      throw new JwtError(`the token is not Google Chat's (${String(claims.email)})`)
  }

  private _chat(space: GcSpace, message?: GcMessage): ChannelChat | undefined {
    if (!space.name) return undefined
    const dm = space.singleUserBotDm === true || space.type === 'DM' || space.spaceType === 'DIRECT_MESSAGE'
    // A reply in a thread is a conversation of its own; so is every thread of a threaded space. In a direct chat,
    // Chat gives each top-level message a thread of its own, which is not one.
    const threaded =
      message?.threadReply === true || (!dm && space.spaceThreadingState === 'THREADED_MESSAGES')
    const thread = threaded ? message?.thread?.name : undefined
    return {
      id: space.name,
      kind: dm ? 'dm' : 'group',
      ...(space.displayName ? { title: space.displayName } : {}),
      ...(thread ? { thread } : {}),
    }
  }

  private _sender(user: GcUser) {
    return {
      id: user.name ?? '',
      name: user.displayName || user.email || 'Someone',
      ...(user.email ? { handle: user.email } : {}),
    }
  }

  private _file(att: GcAttachment, resource: string, i: number): InboundFile {
    const mime = att.contentType ?? 'application/octet-stream'
    return {
      kind: kindOf(mime),
      name: att.contentName ?? `file-${i + 1}`,
      mimeType: mime,
      read: async () => download('Google Chat', await this._fetch('GET', `/v1/media/${resource}?alt=media`)),
    }
  }

  /** A Chat event as the hub's message; undefined for what channels ignore (other bots, being added, …). */
  private _inbound(event: GcEvent): Inbound | undefined {
    const message = event.message
    const user = event.user ?? message?.sender
    if (!event.space || !message?.name || !user?.name || user.type === 'BOT') return undefined
    const chat = this._chat(event.space, message)
    if (!chat) return undefined
    const time = message.createTime ?? event.eventTime ?? new Date().toISOString()
    if (event.type === 'CARD_CLICKED') {
      const params =
        event.common?.parameters ??
        Object.fromEntries((event.action?.parameters ?? []).map((p) => [p.key ?? '', p.value ?? '']))
      if (typeof params.data !== 'string') return undefined
      const id = `${message.name}:${event.eventTime ?? Date.now()}`
      return {
        messageId: `press:${id}`,
        chat,
        sender: this._sender(user),
        text: '',
        mentioned: true,
        press: { id, data: params.data, message: { chat: chat.id, id: message.name } },
        time,
      }
    }
    if (event.type !== 'MESSAGE') return undefined
    // `argumentText` is the text without the app's @mention; a slash command keeps its name.
    const text = ((message.slashCommand ? message.text : (message.argumentText ?? message.text)) ?? '').trim()
    const mentioned =
      chat.kind === 'dm' ||
      Boolean(message.slashCommand) ||
      (message.annotations ?? []).some(
        (a) => a.type === 'USER_MENTION' && a.userMention?.user?.type === 'BOT',
      )
    const files: InboundFile[] = []
    for (const [i, att] of (message.attachment ?? []).entries()) {
      // Uploaded files carry a resource the app may download; Drive links would need the person's authorization.
      const resource = att.attachmentDataRef?.resourceName
      if (resource) files.push(this._file(att, resource, i))
    }
    return {
      messageId: message.name,
      chat,
      sender: this._sender(user),
      text,
      mentioned,
      ...(files.length ? { files } : {}),
      ...(!text && !files.length && message.attachment?.length ? { unsupported: true } : {}),
      time,
    }
  }

  /** The text in Chat's formatting, with buttons as a card of button rows, each carrying its data. */
  private _body(message: OutMessage) {
    return {
      text: googleChatText(message.text),
      cardsV2: message.buttons?.length
        ? [
            {
              cardId: 'buttons',
              card: {
                sections: [
                  {
                    widgets: message.buttons.map((row) => ({
                      buttonList: {
                        buttons: row.map((b) => ({
                          text: b.label,
                          onClick: {
                            action: { function: 'myr', parameters: [{ key: 'data', value: b.data }] },
                          },
                        })),
                      },
                    })),
                  },
                ],
              },
            },
          ]
        : [],
    }
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const space = chatIdOf(chat)
    // A thread from another space would make Chat refuse the whole message.
    const thread = threadOf(chat)?.startsWith(`${space}/threads/`) ? threadOf(chat) : undefined
    const sent = await this._call<{ name?: string }>(
      'POST',
      `/v1/${space}/messages${thread ? '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' : ''}`,
      { ...this._body(message), ...(thread ? { thread: { name: thread } } : {}) },
    )
    return { chat: space, id: sent.name ?? '' }
  }

  async edit(ref: SentRef, message: OutMessage): Promise<void> {
    await this._call('PATCH', `/v1/${ref.id}?updateMask=text,cardsV2`, this._body(message))
  }

  /** Chat has no typing indicator for apps; the hub's status line shows the work instead. */
  async typing(): Promise<void> {}
}
