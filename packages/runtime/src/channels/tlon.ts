import { randomUUID } from 'node:crypto'
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
 * Tlon (Urbit) through the ship's Eyre HTTP API, ported from OpenClaw's `tlon` extension: log in with the access
 * code for a session cookie, open an Eyre channel subscribed to the `channels` (/v2) and `chat` (/v3) firehoses,
 * read it as server-sent events (acknowledging every few, so the ship's queue stays short), and poke to send. Direct
 * messages are with a ship (`~sampel-palnet`); group chat channels are nests (`chat/~host/name`), and a reply thread
 * in one is a conversation of its own. In groups the ship answers when it is mentioned by name (or `@all`). DM
 * invitations are accepted so a stranger's first message can be answered with a pairing code; the hub's access rules
 * still decide who is acted on.
 */

const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30_000
const REQUEST_TIMEOUT_MS = 30_000
/** Events heard but not acknowledged before an ack is sent (OpenClaw's threshold). */
const ACK_EVERY = 20
/** OpenClaw chunks Tlon messages at this. */
const TEXT_LIMIT = 10_000
const IMAGE_MAX = 10 * 1024 * 1024
/** ~1970.1.1 as an Urbit date (@da): 2^127 plus the seconds since Urbit's epoch, in 64.64 fixed point. */
const DA_UNIX_EPOCH = 0x8000000cce9e0d80n << 64n
const DA_SECOND = 1n << 64n

class TlonAuthError extends Error {}
class TlonHttpError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`the ship answered ${status} to ${what}`)
  }
}

type Json = Record<string, unknown>
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

const ship = (raw: string) => {
  const s = raw.trim()
  return s && !s.startsWith('~') ? `~${s}` : s
}

/** A number as Urbit's @ud: digits in groups of three, separated by dots. */
const ud = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
const daFromUnix = (ms: number) => DA_UNIX_EPOCH + (BigInt(ms) * DA_SECOND) / 1000n

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type Inline = string | Json

/** Inline Markdown as Tlon's inline story items: bold, italics, strike, code, links, ship mentions. */
function inlines(text: string): Inline[] {
  const out: Inline[] = []
  const rules: [RegExp, (m: RegExpExecArray) => Inline][] = [
    [/^(~[a-z][-a-z]*)/, (m) => ({ ship: m[1] })],
    [/^\*\*(.+?)\*\*/, (m) => ({ bold: inlines(m[1] ?? '') })],
    [/^\*([^*\n]+?)\*/, (m) => ({ italics: inlines(m[1] ?? '') })],
    [/^~~(.+?)~~/, (m) => ({ strike: inlines(m[1] ?? '') })],
    [/^`([^`]+)`/, (m) => ({ 'inline-code': m[1] ?? '' })],
    [/^\[([^\]]+)\]\(([^)\s]+)\)/, (m) => ({ link: { href: m[2], content: m[1] } })],
    [/^(https?:\/\/[^\s<>"\]]+)/, (m) => ({ link: { href: m[1], content: m[1] } })],
    [/^\n/, () => ({ break: null })],
    // Plain text up to anything a rule above could start with ('h' for a bare URL); the rest goes a character at a time.
    [/^[^*~`[h\n]+/, (m) => m[0]],
  ]
  let rest = text
  while (rest) {
    let item: Inline = rest.charAt(0)
    let used = 1
    for (const [re, make] of rules) {
      const m = re.exec(rest)
      if (m) {
        item = make(m)
        used = m[0].length
        break
      }
    }
    const last = out.at(-1)
    if (typeof item === 'string' && typeof last === 'string') out[out.length - 1] = last + item
    else out.push(item)
    rest = rest.slice(used)
  }
  return out
}

/** Markdown as a Tlon story: code blocks and headers as blocks, everything else as paragraphs of inline items. */
function tlonStory(markdown: string): Json[] {
  const story: Json[] = []
  const lines = markdown.split('\n')
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) story.push({ inline: inlines(paragraph.join('\n')) })
    paragraph = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.startsWith('```')) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !lines[i]?.startsWith('```'); i++) code.push(lines[i] ?? '')
      story.push({ block: { code: { code: code.join('\n'), lang: line.slice(3).trim() || 'plaintext' } } })
      continue
    }
    const header = /^(#{1,6})\s+(.+)$/.exec(line)
    if (header) {
      flush()
      story.push({
        block: { header: { tag: `h${header[1]?.length ?? 1}`, content: inlines(header[2] ?? '') } },
      })
    } else if (!line.trim()) flush()
    else paragraph.push(line)
  }
  flush()
  return story.length ? story : [{ inline: [''] }]
}

function inlineText(item: unknown, top = false): string {
  if (typeof item === 'string') return item
  const r = rec(item)
  if (typeof r.ship === 'string') return r.ship
  if ('sect' in r) return `@${str(r.sect) || 'all'}`
  if ('break' in r) return '\n'
  if (typeof r['inline-code'] === 'string') return `\`${r['inline-code']}\``
  if (typeof r.code === 'string') return `\`${r.code}\``
  const link = rec(r.link)
  if (typeof link.href === 'string') return top ? link.href : str(link.content) || link.href
  for (const [key, mark] of [
    ['bold', '**'],
    ['italics', '*'],
    ['strike', '~~'],
  ] as const)
    if (Array.isArray(r[key]))
      return `${mark}${(r[key] as unknown[]).map((i) => inlineText(i)).join('')}${mark}`
  if (Array.isArray(r.blockquote))
    return `> ${(r.blockquote as unknown[]).map((i) => inlineText(i)).join('')}`
  return ''
}

/** A Tlon story as text (OpenClaw's extractMessageText, without citations), and its images. */
function storyText(content: unknown): { text: string; images: string[] } {
  const images: string[] = []
  if (!Array.isArray(content)) return { text: '', images }
  const text = content
    .map((verse) => {
      const v = rec(verse)
      if (Array.isArray(v.inline)) return v.inline.map((i) => inlineText(i, true)).join('')
      const block = rec(v.block)
      const image = rec(block.image)
      if (typeof image.src === 'string') {
        images.push(image.src)
        return ''
      }
      const code = rec(block.code)
      if (typeof code.code === 'string') return `\`\`\`${str(code.lang)}\n${code.code}\n\`\`\``
      const header = rec(block.header)
      if (Array.isArray(header.content)) return `## ${header.content.map((i) => inlineText(i)).join('')}`
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
  return { text, images }
}

export class TlonAdapter implements ChannelAdapter {
  readonly id = 'tlon'
  readonly label = 'Tlon'
  readonly limits = { text: TEXT_LIMIT, editMs: 1500 }
  readonly can = { buttons: false, files: false, edit: false }
  private readonly _base: string
  private _cookie?: string
  /** The ship's name with its sig (`~sampel-palnet`). */
  private _ship?: string
  private _channel?: string
  private _subs: { channels?: number; chat?: number } = {}
  private _action = 0
  private _heard = -1
  private _acked = -1
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _io?: AdapterIO
  /** DM invitations already accepted. */
  private readonly _accepted = new Set<string>()

  constructor(
    url: string,
    /** The ship's access code (`+code`), which logs in as the ship; never logged. */
    private readonly code: string,
  ) {
    const raw = url.trim()
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
    let origin = ''
    try {
      origin = new URL(withScheme).origin
    } catch {
      origin = ''
    }
    this._base = origin
  }

  private async _fetch(path: string, init: RequestInit & { what: string }, signal?: AbortSignal) {
    const { what, ...rest } = init
    try {
      return await fetch(`${this._base}${path}`, {
        ...rest,
        headers: {
          ...(this._cookie ? { cookie: this._cookie } : {}),
          ...(rest.headers as Record<string, string>),
        },
        signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw new Error(
        `cannot reach the ship for ${what}: ${err instanceof Error ? err.name : 'network error'}`,
      )
    }
  }

  /** Logs in with the access code; Eyre answers with the session cookie. */
  private async _login() {
    if (!this._base)
      throw new TlonAuthError('the ship URL is not a URL (e.g. https://sampel-palnet.tlon.network)')
    this._cookie = undefined
    const res = await this._fetch('/~/login', {
      what: 'the login',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: this.code }).toString(),
      redirect: 'manual',
    })
    if (res.status >= 400 && res.status < 500) throw new TlonAuthError('the ship refused this access code')
    if (res.status >= 400) throw new TlonHttpError(res.status, 'the login')
    const cookie = res.headers.get('set-cookie')?.split(';')[0]
    if (!cookie) throw new TlonAuthError('the ship sent no session cookie; check the URL points at the ship')
    this._cookie = cookie
    const name = await this._fetch('/~/name', { what: 'its name' })
    const text = name.ok ? (await name.text()).trim() : ''
    this._ship = ship(/^~?[a-z-]+$/.test(text) ? text : (new URL(this._base).hostname.split('.')[0] ?? ''))
  }

  async check(): Promise<string> {
    await this._login()
    return this._ship ?? ''
  }

  private async _put(body: unknown[], what: string) {
    const res = await this._fetch(`/~/channel/${this._channel}`, {
      what,
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok && res.status !== 204) throw new TlonHttpError(res.status, what)
  }

  private _subscription(app: string, path: string) {
    return { id: ++this._action, action: 'subscribe', ship: this._ship?.slice(1), app, path }
  }

  private async _poke(app: string, mark: string, json: unknown) {
    if (!this._channel) throw new Error('not connected to the ship')
    await this._put(
      [{ id: ++this._action, action: 'poke', ship: this._ship?.slice(1), app, mark, json }],
      'a poke',
    )
  }

  /** A fresh Eyre channel: created by its first PUT (the subscriptions), then woken with a hood poke. */
  private async _openChannel() {
    this._channel = `${Math.floor(Date.now() / 1000)}-${randomUUID()}`
    this._heard = -1
    this._acked = -1
    const channels = this._subscription('channels', '/v2')
    const chat = this._subscription('chat', '/v3')
    this._subs = { channels: channels.id, chat: chat.id }
    await this._put([channels, chat], 'subscribing')
    await this._poke('hood', 'helm-hi', 'Opening API channel')
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
          if (!this._cookie) await this._login()
          if (!this._channel) await this._openChannel()
          await this._stream(signal, () => {
            io.status({ state: 'on', account: this._ship ?? '' })
            backoff = BACKOFF_MIN_MS
          })
          if (signal.aborted) break
          io.status({ state: 'retrying', error: 'the ship closed the event stream' })
        } catch (err) {
          if (signal.aborted) break
          if (err instanceof TlonAuthError) return io.status({ state: 'error', error: err.message })
          // A lapsed session logs in again; a channel the ship forgot (idle too long) is opened afresh.
          if (err instanceof TlonHttpError && (err.status === 401 || err.status === 403))
            this._cookie = undefined
          if (err instanceof TlonHttpError && err.status === 404) this._channel = undefined
          io.status({ state: 'retrying', error: err instanceof Error ? err.message : String(err) })
        }
        await sleep(backoff * (0.75 + Math.random() * 0.5), signal)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
    if (this._channel && this._cookie)
      await this._fetch(`/~/channel/${this._channel}`, { what: 'closing', method: 'DELETE' }).catch(() => {})
    this._channel = undefined
  }

  /** Reads the channel's event stream until it ends; `opened` runs once the ship accepts it. */
  private async _stream(signal: AbortSignal, opened: () => void) {
    const res = await this._fetch(
      `/~/channel/${this._channel}`,
      { what: 'the event stream', headers: { accept: 'text/event-stream' } },
      signal,
    )
    if (!res.ok || !res.body) throw new TlonHttpError(res.status, 'the event stream')
    opened()
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
      let end = buffer.indexOf('\n\n')
      while (end >= 0) {
        const event = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        await this._event(event)
        end = buffer.indexOf('\n\n')
      }
    }
  }

  private async _event(raw: string) {
    let id: number | undefined
    let data = ''
    for (const line of raw.split('\n')) {
      if (line.startsWith('id:')) id = Number(line.slice(3).trim())
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (data) {
      try {
        const event = rec(JSON.parse(data))
        const sub = Number(event.id)
        if (event.response === 'quit') await this._resubscribe(sub)
        else if (sub === this._subs.channels) await this._onChannels(rec(event.json))
        else if (sub === this._subs.chat) await this._onChat(event.json)
      } catch (err) {
        this._io?.log(err instanceof Error ? err.message : String(err))
      }
    }
    if (id !== undefined && Number.isSafeInteger(id) && id > this._heard) this._heard = id
    // Acknowledged after handling, so a crash replays what was not yet recorded.
    if (this._heard - this._acked > ACK_EVERY) {
      await this._put([{ id: ++this._action, action: 'ack', 'event-id': this._heard }], 'an ack')
      this._acked = this._heard
    }
  }

  /** The ship ended a subscription (it does after a while, or on an error); subscribe again. */
  private async _resubscribe(sub: number) {
    const which = sub === this._subs.channels ? 'channels' : sub === this._subs.chat ? 'chat' : undefined
    if (!which) return
    const next = this._subscription(which, which === 'channels' ? '/v2' : '/v3')
    this._subs = { ...this._subs, [which]: next.id }
    await this._put([next], 'subscribing')
  }

  private _mentioned(text: string) {
    const me = this._ship ?? ''
    return (
      /@all\b/i.test(text) ||
      (me !== '' && new RegExp(`(^|\\s)${escapeRe(me)}(?=\\s|$|[,.!?:])`, 'i').test(text))
    )
  }

  private _files(images: string[]): InboundFile[] {
    return images.map((src, n) => ({
      kind: 'image' as const,
      name: src.split('/').pop()?.split('?')[0] || `image-${n + 1}`,
      mimeType: /\.png$/i.test(src) ? 'image/png' : /\.gif$/i.test(src) ? 'image/gif' : 'image/jpeg',
      read: async () => {
        const res = await fetch(src, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        if (!res.ok) throw new Error(`the image answered ${res.status}`)
        const bytes = new Uint8Array(await res.arrayBuffer())
        if (bytes.byteLength > IMAGE_MAX) throw new Error('the image is larger than 10 MB')
        return bytes
      },
    }))
  }

  private _message(
    messageId: string,
    chat: ChannelChat,
    author: string,
    content: Json,
    mentioned: boolean,
  ): Inbound | undefined {
    const { text, images } = storyText(content.content)
    if (!text && !images.length) return undefined
    const me = this._ship ?? ''
    const sent = Number(content.sent)
    return {
      messageId,
      chat,
      sender: { id: author, name: author, handle: author },
      text: me ? text.replace(new RegExp(escapeRe(me), 'gi'), '').trim() : text,
      mentioned,
      ...(images.length ? { files: this._files(images) } : {}),
      time: Number.isFinite(sent) && sent > 0 ? new Date(sent).toISOString() : new Date().toISOString(),
    }
  }

  /** A post or thread reply in a group chat channel. */
  private async _onChannels(event: Json) {
    const nest = str(event.nest)
    if (!nest.startsWith('chat/')) return
    const post = rec(rec(event.response).post)
    const rPost = rec(post['r-post'])
    const essay = rec(rec(rPost.set).essay)
    const reply = rec(rPost.reply)
    const replySet = rec(rec(reply['r-reply']).set)
    const memo = rec(replySet.memo)
    const isReply = Object.keys(memo).length > 0
    const content = isReply ? memo : essay
    const id = isReply ? str(reply.id) : str(post.id)
    const author = ship(str(content.author))
    if (!id || !author || author === this._ship) return
    const parent = isReply ? str(rec(replySet.seal)['parent-id']) || str(post.id) : ''
    const { text } = storyText(content.content)
    const message = this._message(
      id,
      { id: nest, kind: 'group', title: nest, ...(parent ? { thread: parent } : {}) },
      author,
      content,
      this._mentioned(text) || text.startsWith('/'),
    )
    if (message) await this._io?.receive(message)
  }

  /** A DM, or the list of DM invitations (accepted, so the hub can answer). */
  private async _onChat(event: unknown) {
    if (Array.isArray(event)) {
      for (const invite of event) {
        const from = ship(str(rec(invite).ship))
        if (!from || this._accepted.has(from)) continue
        await this._poke('chat', 'chat-dm-rsvp', { ship: from, ok: true })
        this._accepted.add(from)
      }
      return
    }
    const e = rec(event)
    const essay = rec(rec(rec(e.response).add).essay)
    const id = str(e.id)
    const author = ship(str(essay.author))
    const whom = typeof e.whom === 'string' ? e.whom : str(rec(e.whom).ship)
    const partner = /^~?[a-z-]+$/i.test(whom) ? ship(whom) : ''
    const from = partner || author
    if (!id || !from || author === this._ship || from === this._ship) return
    const message = this._message(id, { id: from, kind: 'dm' }, from, essay, true)
    if (message) await this._io?.receive(message)
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const to = chatIdOf(chat)
    const me = this._ship
    if (!me) throw new Error('not connected to the ship')
    const sent = Date.now()
    const content = tlonStory(message.text)
    const nest = /^chat\/(~?[a-z-]+)\/([^/]+)$/i.exec(to)
    if (nest) {
      const thread = threadOf(chat)
      const memo = { content, author: me, sent }
      // A thread is answered in the thread; its id is an @ud, which Tlon wants with its dots.
      const parent = thread && /^\d+$/.test(thread) ? ud(BigInt(thread)) : thread
      await this._poke('channels', 'channel-action-1', {
        channel: {
          nest: `chat/${ship(nest[1] ?? '')}/${nest[2]}`,
          action: {
            post: parent
              ? { reply: { id: parent, action: { add: memo } } }
              : { add: { ...memo, kind: '/chat', blob: null, meta: null } },
          },
        },
      })
      return { chat: to, id: `${me}/${sent}` }
    }
    const id = `${me}/${ud(daFromUnix(sent))}`
    await this._poke('chat', 'chat-dm-action', {
      ship: ship(to),
      diff: { id, delta: { add: { memo: { content, author: me, sent }, kind: null, time: null } } },
    })
    return { chat: to, id }
  }

  /** OpenClaw sends no edits; the hub only sends new messages (`can.edit` is false). */
  async edit(): Promise<void> {}

  /** Tlon has no typing indicator a client can set. */
  async typing(): Promise<void> {}
}
