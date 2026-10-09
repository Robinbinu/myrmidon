import { JwtError, jwksFromMetadata, KeySet, verifyJwt } from './jwt.ts'
import { connectPushed, download, kindOf, mimeOf, RefusedError, sleep } from './push.ts'
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
  threadOf,
} from './types.ts'

/**
 * Microsoft Teams through the Bot Framework over plain HTTP (no SDK), ported from OpenClaw's and Hermes's
 * adapters: Teams posts each activity to the gateway with a JWT signed by Bot Framework (checked against its
 * published keys: issuer, audience = the app ID, lifetime, the key's endorsement for Teams, the service URL);
 * replies go to that activity's service URL with an app token (client credentials). Buttons are Adaptive Card
 * actions (their presses arrive as `adaptiveCard/action` invokes), messages are edited in place, channel threads
 * are conversations of their own, and only @mentions of the bot count in group chats and channels.
 */

export const BOTFRAMEWORK_OPENID = 'https://login.botframework.com/v1/.well-known/openidconfiguration'
export const MS_LOGIN = 'https://login.microsoftonline.com'
const ISSUER = 'https://api.botframework.com'
const SCOPE = 'https://api.botframework.com/.default'
/**
 * The only hosts that may receive the app's token (OpenClaw's list: Teams in the commercial, GCC, GCC High and DoD
 * clouds, and Azure China), so a forged service URL cannot collect it.
 */
const SERVICE_HOSTS = [
  'smba.trafficmanager.net',
  'smba.infra.gcc.teams.microsoft.com',
  'smba.infra.gov.teams.microsoft.us',
  'smba.infra.dod.teams.microsoft.us',
  'botframework.azure.cn',
]
/** Bot Framework's signing keys change rarely; it asks for them to be cached about a day. */
const KEYS_TTL_MS = 24 * 3600_000
/** Images up to this size go inline (as OpenClaw sends them); larger ones need SharePoint, which is not ported. */
const IMAGE_MAX = 4 * 1024 * 1024
/** How long a button press waits for the hub's note, which Teams shows to whoever pressed. */
const PRESS_WAIT_MS = 3000
/** A `retry_after` longer than this fails the send rather than holding the chat up. */
const RETRY_MAX_S = 30
const CARD = 'application/vnd.microsoft.card.adaptive'
const FILE_INFO = 'application/vnd.microsoft.teams.file.download.info'

export class TeamsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface TeamsAccount {
  id: string
  name?: string
  aadObjectId?: string
}
interface Activity {
  type?: string
  id?: string
  name?: string
  timestamp?: string
  channelId?: string
  serviceUrl?: string
  from?: TeamsAccount
  recipient?: TeamsAccount
  conversation?: { id: string; conversationType?: string; name?: string; tenantId?: string }
  text?: string
  replyToId?: string
  value?: unknown
  entities?: { type?: string; mentioned?: TeamsAccount; text?: string }[]
  attachments?: {
    contentType?: string
    contentUrl?: string
    name?: string
    content?: { downloadUrl?: string; fileType?: string }
  }[]
  channelData?: { tenant?: { id?: string }; channel?: { name?: string }; team?: { name?: string } }
}

export interface TeamsOptions {
  /** Bot Framework's OpenID metadata, which names its signing keys. */
  readonly openId?: string
  /** Where app tokens come from. */
  readonly login?: string
  /** Which service URLs may receive the app's token; Teams' own by default. */
  readonly serviceUrlAllowed?: (url: URL) => boolean
}

const allowedService = (url: URL) =>
  url.protocol === 'https:' &&
  (url.port === '' || url.port === '443') &&
  SERVICE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))

/** A conversation id without the `;messageid=` of a channel thread. */
const baseOf = (conversation: string) => conversation.split(';')[0] ?? conversation

export class TeamsAdapter implements ChannelAdapter {
  readonly id = 'msteams'
  readonly label = 'Microsoft Teams'
  /** Teams takes about 28 KB a message; OpenClaw splits at 4000 characters, which reads better. */
  readonly limits = { text: 4000, editMs: 1500, file: IMAGE_MAX }
  readonly can = { buttons: true, files: true, edit: true }
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _token?: { value: string; expires: number }
  private readonly _keys: KeySet
  private readonly _login: string
  private readonly _serviceOk: (url: URL) => boolean
  /** Presses waiting for the hub's note, by activity id. */
  private readonly _presses = new Map<string, (note?: string) => void>()

  constructor(
    private readonly appId: string,
    private readonly password: string,
    private readonly tenant = '',
    options: TeamsOptions = {},
  ) {
    this._keys = new KeySet(jwksFromMetadata(options.openId ?? BOTFRAMEWORK_OPENID), KEYS_TTL_MS)
    this._login = options.login ?? MS_LOGIN
    this._serviceOk = options.serviceUrlAllowed ?? allowedService
  }

  /** An app token, kept until a minute before it expires. Never logged: it is a credential. */
  private async _accessToken(): Promise<string> {
    if (this._token && this._token.expires > Date.now() + 60_000) return this._token.value
    let res: Response
    try {
      res = await fetch(`${this._login}/${this.tenant.trim() || 'botframework.com'}/oauth2/v2.0/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.appId,
          client_secret: this.password,
          scope: SCOPE,
        }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      throw new TeamsError(0, `cannot reach Microsoft: ${err instanceof Error ? err.name : 'network error'}`)
    }
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string
      expires_in?: number
      error?: string
    }
    if (!res.ok || !data.access_token) {
      if (res.status === 400 || res.status === 401)
        throw new RefusedError(
          `Microsoft refused this app ID and client secret (${data.error ?? res.status}); copy them again from the Azure Bot's configuration`,
        )
      throw new TeamsError(res.status, `Microsoft answered ${res.status} for a token`)
    }
    this._token = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 }
    return data.access_token
  }

  /** The service URL Teams last posted from for a conversation, which replies go to. */
  private _service(conversation: string): string {
    const url = this._io?.get(`service:${baseOf(conversation)}`)
    if (!url)
      throw new Error('Teams has not written from this conversation yet, so there is no address to reply to')
    return url
  }

  /** A call to the conversation's activities (an `id` for one of them), with one retry on a refused token. */
  private async _call<T>(
    conversation: string,
    method: string,
    id: string,
    body: unknown,
    retry = true,
  ): Promise<T> {
    const base = this._service(conversation).replace(/\/+$/, '')
    const url = `${base}/v3/conversations/${encodeURIComponent(conversation)}/activities${id ? `/${encodeURIComponent(id)}` : ''}`
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${await this._accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      if (err instanceof TeamsError || err instanceof RefusedError) throw err
      throw new TeamsError(0, `cannot reach Teams: ${err instanceof Error ? err.name : 'network error'}`)
    }
    if (res.status === 401 && retry) {
      this._token = undefined
      return this._call(conversation, method, id, body, false)
    }
    const after = Number(res.headers.get('retry-after') ?? 0)
    if (res.status === 429 && retry && after > 0 && after <= RETRY_MAX_S) {
      await sleep(after * 1000)
      return this._call(conversation, method, id, body, false)
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
    if (!res.ok) throw new TeamsError(res.status, data.error?.message ?? `Teams answered ${res.status}`)
    return data
  }

  async check(): Promise<string> {
    await this._accessToken()
    return this.appId
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    this._loop = connectPushed(this.label, io, this._abort.signal, () => this.check())
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
    for (const resolve of this._presses.values()) resolve()
  }

  /** An activity Teams posted, taken only with a valid Bot Framework token for this app. */
  async webhook(req: Request): Promise<Response> {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
    if (!token) return new Response('unauthorized', { status: 401 })
    const activity = (await req.json().catch(() => undefined)) as Activity | undefined
    if (!activity || typeof activity !== 'object') return new Response('bad request', { status: 400 })
    try {
      await this._verify(token, activity)
    } catch (err) {
      this._io?.log(`refused a webhook: ${err instanceof Error ? err.message : String(err)}`)
      return new Response('unauthorized', { status: err instanceof JwtError ? 401 : 503 })
    }
    const io = this._io
    if (!io || activity.channelId !== 'msteams') return new Response(null, { status: 200 })
    const serviceUrl = URL.parse(activity.serviceUrl ?? '')
    if (!serviceUrl || !this._serviceOk(serviceUrl)) return new Response('bad service URL', { status: 400 })
    const tenant = activity.channelData?.tenant?.id ?? activity.conversation?.tenantId
    if (this.tenant.trim() && tenant !== this.tenant.trim()) return new Response('forbidden', { status: 403 })
    const conversation = activity.conversation?.id
    if (conversation && io.get(`service:${baseOf(conversation)}`) !== activity.serviceUrl)
      io.set(`service:${baseOf(conversation)}`, activity.serviceUrl ?? '')

    if (activity.type === 'invoke') {
      if (activity.name !== 'adaptiveCard/action') return Response.json({})
      const data = (activity.value as { action?: { data?: { myr?: unknown } } } | undefined)?.action?.data
        ?.myr
      const press = typeof data === 'string' ? this._press(activity, data) : undefined
      let note: string | undefined
      if (press?.press) {
        const id = press.press.id
        const answered = new Promise<string | undefined>((resolve) => this._presses.set(id, resolve))
        await io.receive(press)
        note = await Promise.race([answered, sleep(PRESS_WAIT_MS).then(() => undefined)])
        this._presses.delete(id)
      }
      return Response.json({
        statusCode: 200,
        type: 'application/vnd.microsoft.activity.message',
        value: note ?? '',
      })
    }
    if (activity.type === 'message') {
      // An Action.Submit from an older client arrives as a message carrying the button's data.
      const submitted = (activity.value as { myr?: unknown } | undefined)?.myr
      const message =
        typeof submitted === 'string' ? this._press(activity, submitted) : this._message(activity)
      if (message) await io.receive(message)
    }
    return new Response(null, { status: 200 })
  }

  /** Bot Framework's token: signed by one of its keys endorsed for this channel, for this app, from this service. */
  private async _verify(token: string, activity: Activity) {
    const { claims, jwk } = await verifyJwt(token, this._keys, { issuers: [ISSUER], audience: this.appId })
    if (jwk.endorsements && !jwk.endorsements.includes(activity.channelId ?? ''))
      throw new JwtError(`the signing key is not endorsed for ${activity.channelId}`)
    const trim = (url: unknown) => String(url ?? '').replace(/\/+$/, '')
    if (claims.serviceurl !== undefined && trim(claims.serviceurl) !== trim(activity.serviceUrl))
      throw new JwtError('the service URL does not match the token')
  }

  private _chat(activity: Activity): ChannelChat | undefined {
    const conversation = activity.conversation
    if (!conversation?.id) return undefined
    const kind = conversation.conversationType === 'personal' ? 'dm' : 'group'
    // A channel post and its replies share `;messageid=<the post>`: a thread, a conversation of its own.
    const thread = /;messageid=(\d+)/.exec(conversation.id)?.[1]
    const title = conversation.name ?? activity.channelData?.channel?.name ?? activity.channelData?.team?.name
    return {
      id: baseOf(conversation.id),
      kind,
      ...(title ? { title } : {}),
      ...(thread && kind === 'group' ? { thread } : {}),
    }
  }

  private _sender(from: TeamsAccount) {
    // The directory id is the same person everywhere; `from.id` differs per bot.
    return { id: from.aadObjectId ?? from.id, name: from.name || 'Someone' }
  }

  private _press(activity: Activity, data: string): Inbound | undefined {
    const chat = this._chat(activity)
    if (!chat || !activity.from || !activity.id) return undefined
    return {
      messageId: `press:${activity.id}`,
      chat,
      sender: this._sender(activity.from),
      text: '',
      mentioned: true,
      press: {
        id: activity.id,
        data,
        ...(activity.replyToId && activity.conversation
          ? { message: { chat: activity.conversation.id, id: activity.replyToId } }
          : {}),
      },
      time: activity.timestamp ?? new Date().toISOString(),
    }
  }

  private _file(name: string, mime: string, url: string): InboundFile {
    return {
      kind: kindOf(mime),
      name,
      mimeType: mime,
      read: async () => {
        const where = URL.parse(url)
        // Teams' own attachment hosts want the app's token; SharePoint download links are already signed.
        const own = where !== null && this._serviceOk(where)
        if (!where || (!own && where.protocol !== 'https:'))
          throw new Error('Teams gave a file address that is not HTTPS')
        const headers: Record<string, string> = own
          ? { authorization: `Bearer ${await this._accessToken()}` }
          : {}
        return download('Teams', await fetch(where, { headers, signal: AbortSignal.timeout(60_000) }))
      },
    }
  }

  /** A message activity as the hub's message; undefined for the bot's own. */
  private _message(activity: Activity): Inbound | undefined {
    const from = activity.from
    if (!from || !activity.id || from.id === activity.recipient?.id) return undefined
    const chat = this._chat(activity)
    if (!chat) return undefined
    const bot = activity.recipient?.id
    const ours = (activity.entities ?? []).filter((e) => e.type === 'mention' && e.mentioned?.id === bot)
    let text = activity.text ?? ''
    for (const e of ours) if (e.text) text = text.split(e.text).join('')
    // Other people's mentions keep their names.
    text = text
      .replace(/<at>([^<]*)<\/at>/g, '$1')
      .replace(/&nbsp;/g, ' ')
      .trim()
    const files: InboundFile[] = []
    for (const [i, att] of (activity.attachments ?? []).entries()) {
      if (att.contentType === FILE_INFO && att.content?.downloadUrl) {
        const name = att.name ?? `file-${i + 1}${att.content.fileType ? `.${att.content.fileType}` : ''}`
        files.push(this._file(name, mimeOf(name), att.content.downloadUrl))
      } else if (att.contentType?.startsWith('image/') && att.contentUrl) {
        const name = att.name ?? `image-${i + 1}.${att.contentType.slice(6).replace('jpeg', 'jpg')}`
        files.push(this._file(name, att.contentType, att.contentUrl))
      }
    }
    // The message's own HTML rendering and cards come as attachments too; only files count.
    const other = (activity.attachments ?? []).some(
      (a) =>
        a.contentType !== 'text/html' && a.contentType !== FILE_INFO && !a.contentType?.startsWith('image/'),
    )
    return {
      messageId: activity.id,
      chat,
      sender: this._sender(from),
      text,
      mentioned: chat.kind === 'dm' || ours.length > 0,
      ...(files.length ? { files } : {}),
      ...(!text && !files.length && other ? { unsupported: true } : {}),
      time: activity.timestamp ?? new Date().toISOString(),
    }
  }

  /** A chat as the conversation id replies go to: a channel thread's carries its post. */
  private _conversation(chat: ChannelChat | string) {
    const thread = threadOf(chat)
    return thread ? `${chatIdOf(chat)};messageid=${thread}` : chatIdOf(chat)
  }

  /** The text as Markdown (Teams renders it), with buttons as an Adaptive Card of actions under it. */
  private _activity(message: OutMessage) {
    return {
      type: 'message',
      text: message.text,
      textFormat: 'markdown',
      attachments: message.buttons?.length ? [{ contentType: CARD, content: card(message.buttons) }] : [],
    }
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const conversation = this._conversation(chat)
    const sent = await this._call<{ id?: string }>(conversation, 'POST', '', this._activity(message))
    return { chat: conversation, id: sent.id ?? '' }
  }

  async edit(ref: SentRef, message: OutMessage): Promise<void> {
    await this._call(ref.chat, 'PUT', ref.id, { ...this._activity(message), id: ref.id })
  }

  async typing(chat: ChannelChat | string): Promise<void> {
    await this._call(this._conversation(chat), 'POST', '', { type: 'typing' })
  }

  /** Images go inline; other files would need a consent card or SharePoint, so the hub lists them by name. */
  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    if (!file.mimeType.startsWith('image/') || file.data.byteLength > IMAGE_MAX)
      throw new Error('Teams takes only images up to 4 MB from a bot here')
    const conversation = this._conversation(chat)
    const sent = await this._call<{ id?: string }>(conversation, 'POST', '', {
      type: 'message',
      ...(file.caption ? { text: file.caption, textFormat: 'markdown' } : {}),
      attachments: [
        {
          contentType: file.mimeType,
          contentUrl: `data:${file.mimeType};base64,${Buffer.from(file.data).toString('base64')}`,
          name: file.name,
        },
      ],
    })
    return { chat: conversation, id: sent.id ?? '' }
  }

  /** The note becomes the invoke's answer, which Teams shows to whoever pressed. */
  async answerPress(press: ButtonPress, note?: PressNote): Promise<void> {
    this._presses.get(press.id)?.(note?.text)
  }
}

/** Rows of buttons as an Adaptive Card: one action set per row, each an `Action.Execute` carrying its data. */
function card(rows: readonly (readonly Button[])[]) {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: rows.map((row) => ({
      type: 'ActionSet',
      actions: row.map((b) => ({
        type: 'Action.Execute',
        title: b.label,
        verb: 'myr',
        data: { myr: b.data },
      })),
    })),
  }
}
