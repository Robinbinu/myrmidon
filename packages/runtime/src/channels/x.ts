import { createHmac, randomBytes } from 'node:crypto'
import { plainText } from './format.ts'
import { Backoff, sleep } from './pace.ts'
import {
  type AdapterIO,
  type ChannelAdapter,
  type ChannelChat,
  type ChannelValues,
  chatIdOf,
  type Inbound,
  type OutMessage,
  type SentRef,
} from './types.ts'

/**
 * X (Twitter) through its v2 API over plain HTTP, after OpenClaw's X plugin: mentions of the bot account are
 * polled (with `since_id` kept across restarts) and answered as public replies threaded under the mention, but
 * only for the accounts listed under "Answers publicly" (the platform's allowlist, checked here before the hub's
 * own rules); everyone else's mentions are dropped without a word, as OpenClaw does, since every reply is public.
 * Direct messages are polled too when the app may read them, and go through the hub's pairing like any DM. Each
 * request is signed with OAuth 1.0a user tokens, which never expire or rotate. The X API is paid: the free tier
 * cannot read mentions.
 */

export const X_API = 'https://api.x.com'
/** Between polls; X's lower tiers allow a mentions read about every 90 s per user. */
const POLL_MS = 90_000
const BACKOFF_MIN_MS = 5000
const BACKOFF_MAX_MS = 15 * 60_000
/** Pages of new mentions read in one poll at most (100 each). */
const MAX_PAGES = 5
/** X's weighted length of a post. */
const POST_WEIGHT = 280
/** Every link counts as this many characters, whatever its length (t.co). */
const URL_WEIGHT = 23
/** A rate-limit wait longer than this fails a send rather than holding the chat up. */
const SEND_WAIT_MAX_MS = 60_000
const REFUSED = 'X refused these keys; copy the API key, its secret, and the access token and secret again'
const PAID =
  'this X app cannot read or post (it needs a paid X API plan, and "Read and write" permission, in the developer portal)'

class XError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly resetAt?: number,
  ) {
    super(message)
  }
}

/** Retrying will not help: the keys, the plan or the settings are wrong. */
class XRefused extends Error {}

/** RFC 3986 percent-encoding, as OAuth 1.0a signs it. */
const pct = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** The OAuth 1.0a HMAC-SHA1 signature of a request (RFC 5849 §3.4), over its URL, query and oauth_ parameters. */
export function oauth1Signature(
  method: string,
  url: string,
  params: Readonly<Record<string, string>>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const normalized = Object.entries(params)
    .map(([k, v]) => [pct(k), pct(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const base = `${method.toUpperCase()}&${pct(url)}&${pct(normalized)}`
  return createHmac('sha1', `${pct(consumerSecret)}&${pct(tokenSecret)}`)
    .update(base)
    .digest('base64')
}

/** X's weighted length: most scripts count 1, CJK and emoji 2, each URL 23 (twitter-text's rules). */
function weight(char: string): number {
  if (/^\p{Extended_Pictographic}/u.test(char)) return 2
  const code = char.codePointAt(0) ?? 0
  return code <= 0x10ff ||
    (code >= 0x2000 && code <= 0x200d) ||
    (code >= 0x2010 && code <= 0x201f) ||
    (code >= 0x2032 && code <= 0x2037)
    ? 1
    : 2
}

const URL = /https?:\/\/\S+/g
const segments = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** Text as tokens with their weight: a URL is one token of 23, everything else a grapheme each. */
function tokens(text: string): { text: string; weight: number }[] {
  const out: { text: string; weight: number }[] = []
  let at = 0
  const plain = (s: string) => {
    for (const { segment } of segments.segment(s))
      out.push({ text: segment, weight: [...segment].reduce((n, c) => n + weight(c), 0) })
  }
  for (const m of text.matchAll(URL)) {
    plain(text.slice(at, m.index))
    out.push({ text: m[0], weight: URL_WEIGHT })
    at = m.index + m[0].length
  }
  plain(text.slice(at))
  return out
}

export const xWeight = (text: string) => tokens(text.normalize('NFC')).reduce((n, t) => n + t.weight, 0)

/** The text as posts of at most 280 weighted characters, cut at a space or line when one is near (OpenClaw). */
export function xPosts(text: string, max = POST_WEIGHT): string[] {
  const all = tokens(text.normalize('NFC').trim())
  const posts: string[] = []
  let start = 0
  while (start < all.length) {
    let end = start
    let total = 0
    while (end < all.length && total + (all[end]?.weight ?? 0) <= max) {
      total += all[end]?.weight ?? 0
      end++
    }
    if (end === start) end++
    if (end < all.length) {
      let cut = end
      while (cut > start && !/^\s+$/.test(all[cut]?.text ?? '')) cut--
      if (cut - start > (end - start) / 3) end = cut
    }
    const post = all
      .slice(start, end)
      .map((t) => t.text)
      .join('')
      .trim()
    if (post) posts.push(post)
    start = end
    while (start < all.length && /^\s+$/.test(all[start]?.text ?? '')) start++
  }
  return posts
}

const decodeEntities = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const newer = (a: string, b?: string) => !b || BigInt(a) > BigInt(b)

interface XUser {
  id: string
  username: string
  name?: string
}
interface XPost {
  id: string
  text: string
  author_id?: string
  conversation_id?: string
  created_at?: string
  referenced_tweets?: { type: string; id: string }[]
}
interface XPage<T> {
  data?: T[]
  includes?: { users?: XUser[] }
  meta?: { newest_id?: string; next_token?: string; result_count?: number }
  errors?: { detail?: string; title?: string }[]
}
interface XDm {
  id: string
  event_type?: string
  text?: string
  sender_id?: string
  dm_conversation_id?: string
  created_at?: string
}

export class XAdapter implements ChannelAdapter {
  readonly id = 'x'
  readonly label = 'X'
  /** A post's 280 (weighted; the adapter re-cuts what the hub's count misses); no edits, files or buttons. */
  readonly limits = { text: POST_WEIGHT, editMs: 1500 }
  readonly can = { buttons: false, files: false, edit: false }
  private _me?: XUser
  private _allowed = new Set<string>()
  private _dms = true
  private _io?: AdapterIO
  private _abort?: AbortController
  private _loop?: Promise<void>
  /** The post an answer in each conversation replies under (the last allowed mention, then the bot's last reply). */
  private readonly _replyTo = new Map<string, string>()

  constructor(
    private readonly values: ChannelValues,
    private readonly api = X_API,
    private readonly pollMs = POLL_MS,
  ) {}

  private _keys() {
    const keys = {
      key: this.values.apiKey?.trim() ?? '',
      secret: this.values.apiSecret?.trim() ?? '',
      token: this.values.accessToken?.trim() ?? '',
      tokenSecret: this.values.accessSecret?.trim() ?? '',
    }
    if (!keys.key || !keys.secret || !keys.token || !keys.tokenSecret)
      throw new XRefused('X needs the API key and secret, and the access token and secret')
    return keys
  }

  /** A signed request; never logs or throws the keys. */
  private async _call<T>(
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string | undefined> = {},
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const keys = this._keys()
    const params = Object.fromEntries(
      Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined),
    )
    const url = `${this.api}${path}`
    const oauth: Record<string, string> = {
      oauth_consumer_key: keys.key,
      oauth_nonce: randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: String(Math.floor(Date.now() / 1000)),
      oauth_token: keys.token,
      oauth_version: '1.0',
    }
    oauth.oauth_signature = oauth1Signature(
      method,
      url,
      { ...params, ...oauth },
      keys.secret,
      keys.tokenSecret,
    )
    const header = `OAuth ${Object.entries(oauth)
      .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
      .join(', ')}`
    const qs = new URLSearchParams(params).toString()
    let res: Response
    try {
      res = await fetch(qs ? `${url}?${qs}` : url, {
        method,
        headers: { authorization: header, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw new XError(0, `cannot reach X: ${err instanceof Error ? err.name : 'network error'}`)
    }
    const data = (await res.json().catch(() => ({}))) as T & {
      title?: string
      detail?: string
      reason?: string
      errors?: { message?: string; detail?: string }[]
    }
    if (!res.ok) {
      const reset = Number(res.headers.get('x-rate-limit-reset'))
      const detail = data.detail ?? data.errors?.[0]?.message ?? data.errors?.[0]?.detail ?? data.title
      if (res.status === 401) throw new XRefused(REFUSED)
      if (
        res.status === 403 &&
        (data.reason === 'client-not-enrolled' || /enrolled|project|access level/i.test(detail ?? ''))
      )
        throw new XRefused(PAID)
      throw new XError(
        res.status,
        `X answered ${res.status}${detail ? `: ${detail}` : ''}`,
        Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined,
      )
    }
    return data
  }

  /** Who the keys are, and the accounts it answers publicly (usernames looked up once, to their stable IDs). */
  async check(): Promise<string> {
    const me = await this._call<{ data?: XUser }>('GET', '/2/users/me')
    if (!me.data?.id) throw new Error('X did not say which account these keys are for')
    const listed = (this.values.replyTo ?? '')
      .split(/[\s,]+/)
      .map((a) => a.replace(/^@/, '').trim())
      .filter(Boolean)
    if (!listed.length) throw new XRefused('list at least one account it may answer publicly')
    const ids = listed.filter((a) => /^\d+$/.test(a))
    const names = listed.filter((a) => !/^\d+$/.test(a))
    for (const name of names) if (!/^\w{1,15}$/.test(name)) throw new XRefused(`not an X username: @${name}`)
    if (names.length) {
      const found = await this._call<{ data?: XUser[] }>('GET', '/2/users/by', { usernames: names.join(',') })
      for (const name of names) {
        const user = found.data?.find((u) => u.username.toLowerCase() === name.toLowerCase())
        if (!user) throw new XRefused(`there is no X account @${name}`)
        ids.push(user.id)
      }
    }
    this._me = me.data
    this._allowed = new Set(ids)
    return `@${me.data.username}`
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    const startedAt = new Date(Date.now() - 1000).toISOString().replace(/\.\d+Z$/, 'Z')
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      const backoff = new Backoff(BACKOFF_MIN_MS, BACKOFF_MAX_MS, 0)
      let account: string | undefined
      while (!signal.aborted) {
        try {
          account ??= await this.check()
          await this._pollMentions(io, startedAt, signal)
          if (this._dms) await this._pollDms(io, startedAt, signal)
          io.status({ state: 'on', account })
          backoff.up()
          await sleep(this.pollMs, signal)
        } catch (err) {
          if (signal.aborted) break
          const error = err instanceof Error ? err.message : String(err)
          if (err instanceof XRefused) return io.status({ state: 'error', error })
          if (err instanceof XError && err.status >= 400 && err.status < 500 && err.status !== 429)
            return io.status({ state: 'error', error })
          io.status({ state: 'retrying', error })
          const until = err instanceof XError && err.resetAt ? err.resetAt - Date.now() : 0
          await sleep(Math.max(until, backoff.next()), signal)
        }
      }
    })()
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
  }

  /** New mentions, oldest first; `since` moves past them only once all are recorded. */
  private async _pollMentions(io: AdapterIO, startedAt: string, signal: AbortSignal) {
    const me = this._me
    if (!me) return
    const since = io.get('since')
    const posts: XPost[] = []
    const users = new Map<string, XUser>()
    let newest = since
    let next: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this._call<XPage<XPost>>(
        'GET',
        `/2/users/${me.id}/mentions`,
        {
          // The first poll ever starts now, rather than answering every mention the account ever had.
          ...(since ? { since_id: since } : { start_time: startedAt }),
          max_results: '100',
          'tweet.fields': 'author_id,conversation_id,created_at,referenced_tweets',
          expansions: 'author_id',
          'user.fields': 'username,name',
          ...(next ? { pagination_token: next } : {}),
        },
        undefined,
        signal,
      )
      for (const post of res.data ?? []) posts.push(post)
      for (const user of res.includes?.users ?? []) users.set(user.id, user)
      if (res.meta?.newest_id && newer(res.meta.newest_id, newest)) newest = res.meta.newest_id
      next = res.meta?.next_token
      if (!next) break
    }
    posts.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    for (const post of posts) {
      const message = this._mention(post, users)
      if (message) await io.receive(message)
    }
    if (newest && newest !== since) io.set('since', newest)
  }

  /** A mention as the hub's message; undefined for the bot's own posts, reposts, and unlisted authors. */
  private _mention(post: XPost, users: Map<string, XUser>): Inbound | undefined {
    const author = post.author_id ?? ''
    const conversation = post.conversation_id ?? post.id
    if (!author || author === this._me?.id) return undefined
    if (post.referenced_tweets?.some((r) => r.type === 'retweeted')) return undefined
    // Every reply is public: only the listed accounts get one, whatever the hub would allow.
    if (!this._allowed.has(author)) return undefined
    const user = users.get(author)
    const handle = this._me?.username ?? ''
    const text = decodeEntities(post.text)
      // The @handles X puts in front of a reply, then the bot's own anywhere.
      .replace(/^(?:@\w+\s+)+/, '')
      .replace(new RegExp(`@${handle}\\b`, 'gi'), '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    this._replyTo.set(conversation, post.id)
    this._io?.set(`reply:${conversation}`, post.id)
    return {
      messageId: post.id,
      chat: { id: conversation, kind: 'group', title: user ? `@${user.username} on X` : 'X thread' },
      sender: {
        id: author,
        name: user?.name || user?.username || author,
        ...(user ? { handle: user.username } : {}),
      },
      text,
      mentioned: true,
      time: post.created_at ?? new Date().toISOString(),
    }
  }

  /** New direct messages (X lists the newest first); stops asking when the app may not read them. */
  private async _pollDms(io: AdapterIO, startedAt: string, signal: AbortSignal) {
    let res: XPage<XDm>
    try {
      res = await this._call<XPage<XDm>>(
        'GET',
        '/2/dm_events',
        {
          event_types: 'MessageCreate',
          'dm_event.fields': 'id,text,sender_id,dm_conversation_id,created_at',
          expansions: 'sender_id',
          'user.fields': 'username,name',
          max_results: '50',
        },
        undefined,
        signal,
      )
    } catch (err) {
      if (
        !(err instanceof XError && err.status === 403) &&
        !(err instanceof XRefused && err.message === PAID)
      )
        throw err
      this._dms = false
      io.log('direct messages are off: this X app may not read them ("Read, write and Direct Messages")')
      return
    }
    const since = io.get('dm-since')
    const users = new Map((res.includes?.users ?? []).map((u) => [u.id, u]))
    const fresh = (res.data ?? [])
      .filter((e) => e.event_type === 'MessageCreate' && e.sender_id !== this._me?.id && e.dm_conversation_id)
      .filter((e) => (since ? newer(e.id, since) : Date.parse(e.created_at ?? '') >= Date.parse(startedAt)))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    for (const e of fresh) {
      const user = users.get(e.sender_id ?? '')
      await io.receive({
        messageId: e.id,
        chat: { id: `dm:${e.dm_conversation_id}`, kind: 'dm' },
        sender: {
          id: e.sender_id ?? '',
          name: user?.name || user?.username || (e.sender_id ?? ''),
          ...(user ? { handle: user.username } : {}),
        },
        text: decodeEntities(e.text ?? '').trim(),
        mentioned: true,
        time: e.created_at ?? new Date().toISOString(),
      })
      io.set('dm-since', e.id)
    }
    const top = res.data?.[0]?.id
    if (!since && top) io.set('dm-since', fresh.at(-1)?.id ?? top)
  }

  /** Sends, waiting out one short rate limit. */
  private async _post<T>(path: string, body: unknown): Promise<T> {
    try {
      return await this._call<T>('POST', path, {}, body)
    } catch (err) {
      const wait = err instanceof XError && err.status === 429 && err.resetAt ? err.resetAt - Date.now() : -1
      if (wait < 0 || wait > SEND_WAIT_MAX_MS) throw err
      await sleep(wait)
      return this._call<T>('POST', path, {}, body)
    }
  }

  /**
   * A DM goes to its conversation; anything else is a public reply, threaded under the mention it answers, in posts
   * of 280. There is nothing to reply to in a conversation no listed account started, so nothing is posted.
   */
  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    const id = chatIdOf(chat)
    const text = plainText(message.text).trim()
    if (id.startsWith('dm:')) {
      const sent = await this._post<{ data?: { dm_event_id?: string } }>(
        `/2/dm_conversations/${encodeURIComponent(id.slice(3))}/messages`,
        { text },
      )
      return { chat: id, id: sent.data?.dm_event_id ?? '' }
    }
    const start = this._replyTo.get(id) ?? this._io?.get(`reply:${id}`)
    if (!start || !/^\d+$/.test(id))
      throw new Error('X answers only in a thread a listed account mentioned it in')
    let parent: string = start
    for (const post of xPosts(text)) {
      const sent: { data?: { id?: string } } = await this._post('/2/tweets', {
        text: post,
        reply: { in_reply_to_tweet_id: parent },
      })
      if (!sent.data?.id) throw new Error('X did not say which post it made')
      parent = sent.data.id
      // The next piece threads under this one.
      this._replyTo.set(id, parent)
      this._io?.set(`reply:${id}`, parent)
    }
    return { chat: id, id: parent }
  }

  /** X posts cannot be edited through the API. */
  async edit(): Promise<void> {}

  /** X has no typing indicator for posts. */
  async typing(): Promise<void> {}
}
