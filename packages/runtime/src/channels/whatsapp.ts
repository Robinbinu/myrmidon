import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AnyMessageContent, ConnectionState, proto, WAMessage, WAMessageKey, WASocket } from 'baileys'
import QRCode from 'qrcode'
import { channelCopy } from './copy.ts'
import { whatsappText } from './format.ts'
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
} from './types.ts'

/**
 * WhatsApp as a linked device (like WhatsApp Web) through Baileys, ported from OpenClaw's WhatsApp extension and
 * Hermes's bridge: the session lives in the channel's own folder, linking is by QR code, reconnects follow OpenClaw's
 * backoff (2 s → 30 s, ×1.8, 25% jitter), a logged-out session is cleared so the next start links afresh, and sends
 * go out one at a time (Hermes: overlapping sends on one socket can be misrouted). Direct chats and groups (`@g.us`);
 * in groups the bot is mentioned when its number is tagged or one of its messages is replied to.
 *
 * Not an official API: WhatsApp may ban a number it takes for a bot, hence the setup text's warning.
 */

const BACKOFF = { initialMs: 2000, maxMs: 30_000, factor: 1.8, jitter: 0.25 }
/** Codes WhatsApp shows for linking expire after about a minute; after this many unscanned rounds it stops. */
const LINK_ROUNDS = 3
/** Baileys can hang on a send (a stuck media upload); give up rather than hold the chat (Hermes: 60 s). */
const SEND_TIMEOUT_MS = 60_000
/** `fetchLatestBaileysVersion` is a plain fetch to GitHub; past this the library's own version is used. */
const VERSION_TIMEOUT_MS = 15_000
/** Messages replayed on reconnect (`append`) older than this before connecting are history, not new work. */
const APPEND_GRACE_MS = 60_000
/** Sent messages kept so Baileys can resend one a phone failed to decrypt. */
const SENT_KEPT = 256
/** WhatsApp shows images up to 16 MB inline; larger ones go as documents. */
const IMAGE_MAX = 16 * 1024 * 1024
/** "Typing…" lasts about 25 s on WhatsApp; the hub's 4 s renewals (Telegram's pace) are thinned to this. */
const TYPING_MS = 10_000

/** WhatsApp's close codes (Baileys's `DisconnectReason`). */
const LOGGED_OUT = 401
const REPLACED = 440
const RESTART = 515

type Baileys = typeof import('baileys')

/** Attempt `n` (from 1) of OpenClaw's reconnect policy, in ms. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(BACKOFF.maxMs, BACKOFF.initialMs * BACKOFF.factor ** Math.max(attempt - 1, 0))
  return Math.min(BACKOFF.maxMs, Math.round(base + base * BACKOFF.jitter * random()))
}

/** A JID without its device (`123:4@s.whatsapp.net` → `123@s.whatsapp.net`), so the bot's ids compare equal. */
export const bareJid = (jid: string | null | undefined) => (jid ?? '').replace(/:\d+(?=@)/, '')
const userOf = (jid: string) => bareJid(jid).split('@')[0] ?? ''
const isPhone = (jid: string | null | undefined) => Boolean(jid?.endsWith('@s.whatsapp.net'))

/** Who the linked account is, in both its forms (phone number and LID), for recognizing mentions of it. */
export interface WhatsAppSelf {
  readonly jid: string
  readonly lid?: string
}

/** Wrappers WhatsApp puts around a message (disappearing, view once, a document with a caption). */
function unwrap(message: proto.IMessage | null | undefined): proto.IMessage | undefined {
  let m = message ?? undefined
  for (let i = 0; i < 8 && m; i++) {
    const inner =
      m.ephemeralMessage?.message ??
      m.viewOnceMessage?.message ??
      m.viewOnceMessageV2?.message ??
      m.viewOnceMessageV2Extension?.message ??
      m.documentWithCaptionMessage?.message
    if (!inner) break
    m = inner
  }
  return m
}

const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v))

/**
 * A Baileys message as the hub's: undefined for what channels ignore (its own messages, status updates, channels,
 * receipts and protocol messages). `read` downloads a file's bytes when the hub asks for them.
 */
export function whatsappInbound(
  msg: WAMessage,
  self: WhatsAppSelf,
  read: (msg: WAMessage) => Promise<Uint8Array>,
): Inbound | undefined {
  const key = msg.key as WAMessageKey
  const remote = key.remoteJid ?? ''
  if (!remote || key.fromMe || !key.id) return undefined
  if (remote.endsWith('@broadcast') || remote.endsWith('@newsletter') || remote.endsWith('@status'))
    return undefined
  const m = unwrap(msg.message)
  if (!m) return undefined
  const group = remote.endsWith('@g.us')
  // Baileys 7 says who wrote by LID; the phone-number form comes alongside when WhatsApp shares it.
  const by = group ? (key.participant ?? '') : remote
  const alt = group ? key.participantAlt : key.remoteJidAlt
  const sender = bareJid(isPhone(alt) ? alt : by)
  if (!sender) return undefined
  const phone = isPhone(sender) ? `+${userOf(sender)}` : undefined

  const image = m.imageMessage
  const video = m.videoMessage ?? m.ptvMessage
  const audio = m.audioMessage
  const doc = m.documentMessage
  const raw = (
    m.conversation ??
    m.extendedTextMessage?.text ??
    image?.caption ??
    video?.caption ??
    doc?.caption ??
    ''
  ).trim()
  const files: InboundFile[] = []
  const file = (
    kind: InboundFile['kind'],
    media: { mimetype?: string | null; fileLength?: unknown },
    name: string,
    mime: string,
  ) => {
    const size = num(media.fileLength)
    files.push({
      kind,
      name,
      mimeType: media.mimetype?.split(';')[0]?.trim() || mime,
      ...(size ? { size } : {}),
      read: () => read(msg),
    })
  }
  if (image) file('image', image, `photo-${key.id}.jpg`, 'image/jpeg')
  if (video) file('video', video, `video-${key.id}.mp4`, 'video/mp4')
  if (audio)
    file(audio.ptt ? 'voice' : 'audio', audio, `${audio.ptt ? 'voice' : 'audio'}-${key.id}.ogg`, 'audio/ogg')
  if (doc) file('document', doc, doc.fileName || `file-${key.id}`, 'application/octet-stream')
  const unsupported = Boolean(
    m.stickerMessage ||
      m.locationMessage ||
      m.liveLocationMessage ||
      m.contactMessage ||
      m.contactsArrayMessage ||
      m.pollCreationMessage ||
      m.pollCreationMessageV3,
  )
  // Receipts, reactions, edits and the like share the stream and carry nothing to act on.
  if (!raw && !files.length && !unsupported) return undefined

  const context = (m.extendedTextMessage ?? image ?? video ?? audio ?? doc)?.contextInfo
  const mine = new Set([bareJid(self.jid), bareJid(self.lid)].filter(Boolean))
  const mentioned =
    !group ||
    (context?.mentionedJid ?? []).some((j) => mine.has(bareJid(j))) ||
    mine.has(bareJid(context?.participant)) ||
    raw.startsWith('/')
  // A tag shows in the text as `@` and the number (or LID) it points at.
  let text = raw
  for (const id of mine) text = text.replace(new RegExp(`@${userOf(id)}\\b[,:]?\\s*`, 'g'), '')
  const time = num(msg.messageTimestamp)
  const chat: ChannelChat = { id: remote, kind: group ? 'group' : 'dm' }
  return {
    messageId: key.id,
    chat,
    sender: {
      id: sender,
      name: msg.pushName?.trim() || phone || 'Someone',
      ...(phone ? { handle: phone } : {}),
    },
    text: text.trim(),
    mentioned,
    ...(files.length ? { files } : {}),
    ...(!raw && !files.length ? { unsupported: true } : {}),
    time: new Date(time ? time * 1000 : Date.now()).toISOString(),
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

/** Baileys wants a pino-like logger; the adapter reports through `io` instead. */
const quiet = {
  level: 'silent',
  child: () => quiet,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const statusCode = (err: unknown) =>
  (err as { output?: { statusCode?: number } } | undefined)?.output?.statusCode

export class WhatsAppAdapter implements ChannelAdapter {
  readonly id = 'whatsapp'
  readonly label = 'WhatsApp'
  /** WhatsApp takes far longer messages, but they are hard to read on a phone (Hermes uses 4096). */
  readonly limits = { text: 4000, editMs: 3000, file: 64 * 1024 * 1024 }
  /** Buttons on linked devices are unreliable (often not shown), so the hub sends typed commands instead. */
  readonly can = { buttons: false, files: true, edit: true }
  private _sock?: WASocket
  private _self: WhatsAppSelf = { jid: '' }
  private _account?: string
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _queue: Promise<unknown> = Promise.resolve()
  private readonly _sent = new Map<string, proto.IMessage>()
  private readonly _groups = new Map<string, string>()
  private readonly _typed = new Map<string, number>()

  /** `load` brings Baileys in on first start (tests give a stand-in), keeping it out of every import of channels. */
  constructor(private readonly load: () => Promise<Baileys> = () => import('baileys')) {}

  async check(): Promise<string> {
    // Nothing to check before linking: the session is made by scanning the code once it starts.
    return this._account ?? channelCopy.whatsapp.account
  }

  async start(io: AdapterIO): Promise<void> {
    this._abort = new AbortController()
    io.status({ state: 'connecting' })
    this._loop = this._run(io, join(io.dir, 'auth'), this._abort.signal).catch((err) =>
      io.status({ state: 'error', error: err instanceof Error ? err.message : String(err) }),
    )
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    this._sock?.end(undefined)
    await this._loop?.catch(() => {})
  }

  private async _run(io: AdapterIO, auth: string, signal: AbortSignal) {
    const baileys = await this.load()
    let attempt = 0
    let unscanned = 0
    while (!signal.aborted) {
      const { code, opened, linking } = await this._connect(baileys, io, auth, signal)
      if (signal.aborted) return
      if (code === LOGGED_OUT) {
        // The phone removed this device (or never finished linking): a fresh start links again.
        rmSync(auth, { recursive: true, force: true })
        return io.status({ state: 'error', error: channelCopy.whatsapp.loggedOut })
      }
      if (code === REPLACED) return io.status({ state: 'error', error: channelCopy.whatsapp.replaced })
      // WhatsApp asks for a restart right after a phone links; the saved session connects at once.
      if (code === RESTART) {
        attempt = 0
        continue
      }
      if (opened) attempt = 0
      if (linking && !opened && ++unscanned >= LINK_ROUNDS)
        return io.status({ state: 'error', error: channelCopy.whatsapp.linkExpired })
      attempt += 1
      io.status({ state: 'retrying', error: channelCopy.whatsapp.closed(code ?? '?') })
      await sleep(backoffMs(attempt), signal)
    }
  }

  /** One connection, from opening the socket to its close; resolves with why it closed. */
  private async _connect(
    baileys: Baileys,
    io: AdapterIO,
    auth: string,
    signal: AbortSignal,
  ): Promise<{ code?: number; opened: boolean; linking: boolean }> {
    const { state, saveCreds } = await baileys.useMultiFileAuthState(auth)
    const { version } = await baileys.fetchLatestBaileysVersion({
      signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
    })
    if (signal.aborted) return { opened: false, linking: false }
    const sock = baileys.makeWASocket({
      auth: { creds: state.creds, keys: baileys.makeCacheableSignalKeyStore(state.keys, quiet) },
      version,
      logger: quiet,
      browser: baileys.Browsers.appropriate('Myrmidon'),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async (k) => (k.id ? this._sent.get(k.id) : undefined),
    })
    this._sock = sock
    let saving: Promise<void> = Promise.resolve()
    sock.ev.on('creds.update', () => {
      saving = saving.then(saveCreds).catch((err) => io.log(`saving the session failed: ${String(err)}`))
    })
    const connectedAt = Date.now()
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return
      for (const msg of messages) {
        // Replayed history from before this connection is not new work.
        const at = Number(msg.messageTimestamp ?? 0) * 1000
        if (type === 'append' && at < connectedAt - APPEND_GRACE_MS) continue
        void this._receive(baileys, sock, io, msg).catch((err) => io.log(String(err)))
      }
    })
    return new Promise((resolve) => {
      let opened = false
      let linking = false
      const done = (code?: number) => {
        signal.removeEventListener('abort', onAbort)
        // The session must be on disk before reconnecting with it (just after linking above all).
        void saving.then(() => resolve({ ...(code ? { code } : {}), opened, linking }))
      }
      const onAbort = () => done()
      signal.addEventListener('abort', onAbort, { once: true })
      sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
        if (update.qr) {
          linking = true
          const qr = update.qr
          void QRCode.toDataURL(qr).then((image) =>
            io.status({ state: 'linking', qr, image, hint: channelCopy.whatsapp.linking }),
          )
        }
        if (update.connection === 'open') {
          opened = true
          const user = sock.user
          this._self = { jid: user?.id ?? '', ...(user?.lid ? { lid: user.lid } : {}) }
          this._account = `+${userOf(user?.id ?? '')}`
          io.status({ state: 'on', account: this._account })
        }
        if (update.connection === 'close') {
          if (this._sock === sock) this._sock = undefined
          done(statusCode(update.lastDisconnect?.error))
        }
      })
    })
  }

  private async _receive(baileys: Baileys, sock: WASocket, io: AdapterIO, msg: WAMessage) {
    const message = whatsappInbound(msg, this._self, async (m) => {
      const data = await baileys.downloadMediaMessage(
        m,
        'buffer',
        {},
        { logger: quiet, reuploadRequest: sock.updateMediaMessage },
      )
      return new Uint8Array(data)
    })
    if (!message) return
    let chat = message.chat
    if (chat.kind === 'group' && message.mentioned) {
      // The group's name, for the chat's title in the app; looked up once.
      let title = this._groups.get(chat.id)
      if (title === undefined) {
        title = await sock
          .groupMetadata(chat.id)
          .then((g) => g.subject ?? '')
          .catch(() => '')
        this._groups.set(chat.id, title)
      }
      if (title) chat = { ...chat, title }
    }
    await io.receive({ ...message, chat })
    // Blue ticks for what reaches the hub; a group's chatter it ignores stays unread.
    if (message.mentioned) await sock.readMessages([msg.key]).catch(() => {})
  }

  /** One send at a time on the socket, each given up after `SEND_TIMEOUT_MS`. */
  private _send(jid: string, content: AnyMessageContent): Promise<WAMessage | undefined> {
    const sock = this._sock
    if (!sock) return Promise.reject(new Error(channelCopy.whatsapp.offline))
    const task = this._queue.then(() => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(channelCopy.whatsapp.tooSlow)), SEND_TIMEOUT_MS)
      })
      return Promise.race([sock.sendMessage(jid, content), timeout]).finally(() => clearTimeout(timer))
    })
    this._queue = task.catch(() => {})
    return task.then((sent) => {
      if (sent?.key.id && sent.message) {
        this._sent.set(sent.key.id, sent.message)
        if (this._sent.size > SENT_KEPT) this._sent.delete(this._sent.keys().next().value ?? '')
      }
      return sent
    })
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const jid = chatIdOf(chat)
    const sent = await this._send(jid, { text: whatsappText(message.text) })
    return { chat: jid, id: sent?.key.id ?? '' }
  }

  async edit(ref: SentRef, message: OutMessage): Promise<void> {
    await this._send(ref.chat, {
      text: whatsappText(message.text),
      edit: { remoteJid: ref.chat, id: ref.id, fromMe: true },
    })
  }

  async typing(chat: ChannelChat | string): Promise<void> {
    const jid = chatIdOf(chat)
    if (Date.now() - (this._typed.get(jid) ?? 0) < TYPING_MS) return
    this._typed.set(jid, Date.now())
    await this._sock?.sendPresenceUpdate('composing', jid)
  }

  /** Images small enough go as photos (shown inline); everything else as a document. */
  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const jid = chatIdOf(chat)
    const data = Buffer.from(file.data)
    const photo = /^image\/(png|jpeg|webp)$/.test(file.mimeType) && data.byteLength <= IMAGE_MAX
    const sent = await this._send(
      jid,
      photo
        ? { image: data, mimetype: file.mimeType, ...(file.caption ? { caption: file.caption } : {}) }
        : {
            document: data,
            mimetype: file.mimeType,
            fileName: file.name,
            ...(file.caption ? { caption: file.caption } : {}),
          },
    )
    return { chat: jid, id: sent?.key.id ?? '' }
  }
}
