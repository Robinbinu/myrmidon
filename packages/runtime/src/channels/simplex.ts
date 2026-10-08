import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
 * SimpleX Chat through the `simplex-chat` terminal app's WebSocket API (`simplex-chat -p 5225`), ported from
 * Hermes's SimpleX adapter: JSON commands out (`{corrId, cmd}`, each reply carrying its corrId), events in
 * (`newChatItems`, `contactRequest`, file transfers). Contacts are addressed by their numeric contactId and groups
 * by `group:<groupId>` (never by display name, which `/_send` would silently drop when unresolved). Contact
 * requests are accepted as Hermes does by default: SimpleX has no other way in, and the hub's access rules still
 * decide who is acted on (a stranger gets a pairing code). Files are read from, and written for, the daemon's own
 * disk, so it must run on this machine.
 */

export const SIMPLEX_URL = 'ws://127.0.0.1:5225'
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60_000
const COMMAND_TIMEOUT_MS = 15_000
/** SimpleX has no hard limit; Hermes chunks at this. */
const TEXT_LIMIT = 8000
/** A message whose file never finishes downloading is handed on without it after this long. */
const FILE_WAIT_MS = 2 * 60_000
/** Files written for the daemon to send are removed after this long (it uploads them in the background). */
const OUTBOX_TTL_MS = 24 * 60 * 60_000
/** Marks commands this adapter sent, so their un-awaited replies are not taken for events. */
const CORR = 'myr-'

type Json = Record<string, unknown>

/** The daemon took a command but sent no reply in time (Hermes: it does not always answer chat commands). */
class NoAnswer extends Error {}

const rec = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

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

/** A contact's or group's shown name: its local name, else its profile's. */
const nameOf = (obj: Json, profile: string) => str(obj.localDisplayName) || str(rec(obj[profile]).displayName)

/** `/_send` by id: `@<contactId>` or `#<groupId>`, with the message as JSON (escaped, unlike the text syntax). */
const sendCommand = (chat: string, items: unknown[]) =>
  `/_send ${chat.startsWith('group:') ? `#${chat.slice(6)}` : `@${chat}`} json ${JSON.stringify(items)}`

/** Markdown as SimpleX writes it: *bold*, _italic_, ~strike~ (code and links are the same). */
function simplexMarkdown(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+(.+)$/gm, '\uE000$1\uE000')
    .replace(/\*\*(.+?)\*\*/g, '\uE000$1\uE000')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1_$2_')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/\uE000/g, '*')
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  txt: 'text/plain',
}

export class SimplexAdapter implements ChannelAdapter {
  readonly id = 'simplex'
  readonly label = 'SimpleX'
  readonly limits = { text: TEXT_LIMIT, editMs: 1500, file: 50 * 1024 * 1024 }
  readonly can = { buttons: false, files: true, edit: false }
  private _ws?: WebSocket
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _io?: AdapterIO
  private _me?: string
  private _corr = 0
  private readonly _pending = new Map<string, (resp: Json) => void>()
  /** Messages waiting for their file to finish downloading, by fileId. */
  private readonly _waiting = new Map<number, { item: Json; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly url = SIMPLEX_URL) {}

  /** Opens a connection (taking events only when running); resolves once open, rejects with a readable reason. */
  private _open(events: boolean): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(this.url)
      } catch {
        return reject(new Error(`${this.url} is not a WebSocket address (e.g. ${SIMPLEX_URL})`))
      }
      const fail = () =>
        reject(new Error(`cannot reach simplex-chat at ${this.url}; start it with simplex-chat -p 5225`))
      ws.addEventListener('open', () => {
        ws.removeEventListener('error', fail)
        resolve(ws)
      })
      ws.addEventListener('error', fail, { once: true })
      ws.addEventListener('message', (e) => this._onFrame(String(e.data), events))
    })
  }

  private _onFrame(raw: string, events: boolean) {
    let frame: Json
    try {
      frame = rec(JSON.parse(raw))
    } catch {
      return
    }
    // Usually `{corrId, resp: {type…}}`; some daemon versions put the fields at the top or wrap them in Right.
    const wrapped = rec(frame.resp ?? frame)
    const resp = wrapped.Right
      ? rec(wrapped.Right)
      : wrapped.Left
        ? { type: 'chatCmdError', ...rec(wrapped.Left) }
        : wrapped
    const corrId = str(frame.corrId)
    const waiter = corrId ? this._pending.get(corrId) : undefined
    if (waiter) {
      this._pending.delete(corrId)
      return waiter(resp)
    }
    if (corrId.startsWith(CORR) || !events) return
    void this._onEvent(resp).catch((err) => this._io?.log(err instanceof Error ? err.message : String(err)))
  }

  /** Sends a command on `ws` and waits for the reply with its corrId (or throws on a timeout). */
  private _command(cmd: string, ws = this._ws, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Json> {
    if (!ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('not connected to simplex-chat'))
    const corrId = `${CORR}${++this._corr}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(corrId)
        reject(new NoAnswer('simplex-chat did not answer'))
      }, timeoutMs)
      this._pending.set(corrId, (resp) => {
        clearTimeout(timer)
        resolve(resp)
      })
      ws.send(JSON.stringify({ corrId, cmd }))
    })
  }

  /** A command the daemon answers without a corrId (`/freceive`), sent without waiting. */
  private _fire(cmd: string) {
    if (this._ws?.readyState === WebSocket.OPEN)
      this._ws.send(JSON.stringify({ corrId: `${CORR}${++this._corr}`, cmd }))
  }

  /** The active profile's name, which is also how it is @mentioned in groups. */
  private async _whoami(ws: WebSocket): Promise<string> {
    const resp = await this._command('/user', ws)
    if (resp.type !== 'activeUser')
      throw new Error('simplex-chat has no user profile yet: run it once in a terminal to create one')
    const user = rec(resp.user)
    return nameOf(user, 'profile') || 'SimpleX'
  }

  async check(): Promise<string> {
    const ws = await this._open(false)
    try {
      return await this._whoami(ws)
    } finally {
      ws.close()
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
          const ws = await this._open(true)
          this._ws = ws
          const closed = new Promise<void>((resolve) =>
            ws.addEventListener('close', () => resolve(), { once: true }),
          )
          this._me = await this._whoami(ws)
          io.status({ state: 'on', account: this._me })
          backoff = BACKOFF_MIN_MS
          const stop = () => ws.close()
          signal.addEventListener('abort', stop, { once: true })
          await closed
          signal.removeEventListener('abort', stop)
          if (signal.aborted) break
          io.status({ state: 'retrying', error: 'simplex-chat closed the connection' })
        } catch (err) {
          if (signal.aborted) break
          this._ws?.close()
          io.status({ state: 'retrying', error: err instanceof Error ? err.message : String(err) })
        } finally {
          this._ws = undefined
        }
        // Jitter, as Hermes reconnects.
        await sleep(backoff * (1 + Math.random() * 0.2), signal)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    this._ws?.close()
    await this._loop?.catch(() => {})
    for (const { timer } of this._waiting.values()) clearTimeout(timer)
    this._waiting.clear()
  }

  private async _onEvent(resp: Json) {
    const type = str(resp.type)
    if (type === 'contactRequest' || type === 'receivedContactRequest') {
      const id = rec(resp.contactRequest).contactRequestId
      if (id !== undefined) await this._command(`/_accept ${str(id)}`)
      return
    }
    // XFTP files announce themselves before their message; start the download now.
    if (type === 'rcvFileDescrReady') {
      const id = rec(resp.rcvFileTransfer).fileId
      if (id !== undefined) this._fire(`/freceive ${str(id)}`)
      return
    }
    if (type === 'rcvFileComplete') {
      const item = rec(rec(resp.chatItem).chatItem)
      const file = rec(item.file)
      const waiting = this._waiting.get(Number(file.fileId))
      if (!waiting) return
      this._waiting.delete(Number(file.fileId))
      clearTimeout(waiting.timer)
      rec(rec(waiting.item.chatItem).file).fileSource = file.fileSource
      return this._deliver(waiting.item)
    }
    if (type === 'newChatItems') {
      const items = Array.isArray(resp.chatItems) ? resp.chatItems : [resp.chatItems]
      for (const item of items) await this._item(rec(item))
    } else if (type === 'newChatItem')
      await this._item(rec(resp.chatItem).chatInfo ? rec(resp.chatItem) : resp)
  }

  /** A received chat item; one whose file is still downloading waits for it (or for FILE_WAIT_MS). */
  private async _item(item: Json) {
    const data = rec(item.chatItem)
    const file = rec(data.file)
    const path = str(rec(file.fileSource).filePath)
    const fileId = Number(file.fileId)
    if (file.fileId !== undefined && !path && rec(data.content).type === 'rcvMsgContent') {
      const timer = setTimeout(() => {
        this._waiting.delete(fileId)
        void this._deliver(item)
      }, FILE_WAIT_MS)
      this._waiting.set(fileId, { item, timer })
      this._fire(`/freceive ${fileId}`)
      return
    }
    await this._deliver(item)
  }

  private async _deliver(item: Json) {
    const message = this._inbound(item)
    if (message) await this._io?.receive(message)
  }

  /** A chat item as the hub's message; undefined for our own messages, events and unknown chats. */
  private _inbound(item: Json): Inbound | undefined {
    const info = rec(item.chatInfo)
    const data = rec(item.chatItem)
    const dir = rec(data.chatDir)
    const content = rec(data.content)
    const meta = rec(data.meta)
    if (dir.type === 'directSnd' || dir.type === 'groupSnd' || content.type !== 'rcvMsgContent')
      return undefined
    const msg = rec(content.msgContent)
    const raw = str(msg.text)
    let chat: ChannelChat
    let sender: { id: string; name: string }
    if (info.type === 'direct') {
      const contact = rec(info.contact)
      const id = str(contact.contactId)
      chat = { id, kind: 'dm' }
      sender = { id, name: nameOf(contact, 'profile') || id }
    } else if (info.type === 'group') {
      const group = rec(info.groupInfo)
      const member = rec(dir.groupMember)
      // A member who is also a contact is the same person as in the direct chat.
      const contactId = str(member.memberContactId)
      const id = contactId || `member:${str(member.memberId)}`
      chat = { id: `group:${str(group.groupId)}`, kind: 'group', title: nameOf(group, 'groupProfile') }
      sender = { id, name: nameOf(member, 'memberProfile') || id }
    } else return undefined
    if (!chat.id || !sender.id || sender.id === 'member:') return undefined
    const me = this._me ?? ''
    const atMe = me ? new RegExp(`@${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi') : undefined
    const mentioned =
      chat.kind === 'dm' ||
      meta.userMention === true ||
      rec(rec(data.quotedItem).chatDir).type === 'groupSnd' ||
      (atMe ? raw.search(atMe) >= 0 : false) ||
      raw.startsWith('/')
    const text = (atMe ? raw.replace(atMe, '') : raw).trim()
    const files = this._files(msg, rec(data.file))
    if (!text && !files.length) return undefined
    const when = str(meta.itemTs) || str(meta.createdAt)
    return {
      messageId: str(meta.itemId) || `${chat.id}:${when}`,
      chat,
      sender,
      text,
      mentioned,
      ...(files.length ? { files } : {}),
      time: when && !Number.isNaN(Date.parse(when)) ? new Date(when).toISOString() : new Date().toISOString(),
    }
  }

  private _files(msg: Json, file: Json): InboundFile[] {
    const path = str(rec(file.fileSource).filePath)
    if (!path) return []
    const name = str(file.fileName) || path.split('/').pop() || 'file'
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const mimeType = MIME[ext] ?? 'application/octet-stream'
    const type = str(msg.type)
    const kind: InboundFile['kind'] =
      type === 'image'
        ? 'image'
        : type === 'voice'
          ? 'voice'
          : type === 'video'
            ? 'video'
            : mimeType.startsWith('audio/')
              ? 'audio'
              : mimeType.startsWith('image/')
                ? 'image'
                : 'document'
    const size = Number(file.fileSize)
    return [
      {
        kind,
        name,
        mimeType,
        ...(Number.isFinite(size) && size > 0 ? { size } : {}),
        read: async () => new Uint8Array(await Bun.file(path).arrayBuffer()),
      },
    ]
  }

  /** Sends items and returns the new message's id from the daemon's reply. */
  private async _send(chat: ChannelChat | string, items: unknown[]): Promise<SentRef> {
    const id = chatIdOf(chat)
    let resp: Json
    try {
      resp = await this._command(sendCommand(id, items))
    } catch (err) {
      // Taken but unanswered is most likely sent; failing would make the hub send it again, twice over.
      if (!(err instanceof NoAnswer)) throw err
      this._io?.log('simplex-chat did not confirm a message; taking it as sent')
      return { chat: id, id: String(Date.now()) }
    }
    if (resp.type === 'chatCmdError' || resp.type === 'chatError')
      throw new Error(
        `simplex-chat refused the message: ${JSON.stringify(rec(resp.chatError ?? resp).errorType ?? resp.type)}`,
      )
    const first = rec((Array.isArray(resp.chatItems) ? resp.chatItems : [])[0])
    return { chat: id, id: str(rec(rec(first.chatItem).meta).itemId) || String(Date.now()) }
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    return this._send(chat, [{ msgContent: { type: 'text', text: simplexMarkdown(message.text) } }])
  }

  /** Hermes sends no edits; the hub only sends new messages (`can.edit` is false). */
  async edit(): Promise<void> {}

  /** SimpleX has no typing indicator. */
  async typing(): Promise<void> {}

  /** Written to the channel's folder for the daemon to upload; it must run on this machine to read it. */
  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    const outbox = join(this._io?.dir ?? '.', 'outbox')
    mkdirSync(outbox, { recursive: true, mode: 0o700 })
    const now = Date.now()
    for (const old of readdirSync(outbox)) {
      const path = join(outbox, old)
      if (now - statSync(path).mtimeMs > OUTBOX_TTL_MS) rmSync(path, { force: true })
    }
    const path = join(outbox, `${now}-${file.name.replace(/[^\w.-]+/g, '_')}`)
    await Bun.write(path, file.data)
    return this._send(chat, [{ filePath: path, msgContent: { type: 'file', text: file.caption ?? '' } }])
  }
}
