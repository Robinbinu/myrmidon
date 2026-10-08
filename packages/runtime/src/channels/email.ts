import { randomUUID } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import { type ParsedMail, simpleParser } from 'mailparser'
import { createTransport, type SendMailOptions } from 'nodemailer'
import { channelCopy } from './copy.ts'
import { emailHtml } from './format.ts'
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
  threadOf,
} from './types.ts'

/**
 * Email: IMAP in and SMTP out, ported from Hermes's adapter. The mailbox is watched with IDLE (imapflow), checked
 * again every minute as a fallback, and reconnected with backoff; mail is taken by UID after the last one handled
 * (saved across restarts) and marked seen once recorded. A sender's address is the chat and each thread (by
 * Message-ID, In-Reply-To and References) a conversation of its own; replies keep the thread's subject and headers.
 * Automatic mail, our own, and mail the receiving server did not verify (Authentication-Results: DMARC, or aligned
 * SPF or DKIM) are ignored, since anyone can write any From: line. Quoted text below a reply is dropped.
 */

const BACKOFF_MIN_MS = 5000
const BACKOFF_MAX_MS = 5 * 60_000
/** A fallback check this often, for servers whose IDLE goes quiet. */
const POLL_MS = 60_000
/** Mail larger than this is skipped (attachments past the hub's 10 MB are refused anyway). */
const MAIL_MAX = 40 * 1024 * 1024

/** Addresses and headers of automatic mail (Hermes's list), never answered. */
const NOREPLY =
  /noreply|no-reply|no_reply|donotreply|do-not-reply|mailer-daemon|postmaster|bounce|notifications@|automated@|auto-confirm|auto-reply|automailer/i

/** What the mailbox side needs of IMAP, so tests can stand in for a server. */
export interface MailboxClient {
  connect(): Promise<void>
  /** Opens the mailbox: its UIDVALIDITY and the next UID it will give. */
  open(path: string): Promise<{ uidValidity: string; uidNext: number }>
  /** Unseen messages with a UID above `uid`, in order. */
  unseenAfter(uid: number): Promise<number[]>
  /** The raw message, or undefined when it is gone or too large. */
  source(uid: number): Promise<Uint8Array | undefined>
  markSeen(uid: number): Promise<void>
  /** New mail arrived (an IDLE `EXISTS`). */
  onMail(listener: () => void): void
  onClose(listener: () => void): void
  close(): Promise<void>
}

export interface MailSender {
  verify(): Promise<unknown>
  sendMail(mail: SendMailOptions): Promise<{ messageId?: string }>
}

export interface EmailSettings {
  readonly imapHost: string
  readonly imapPort: number
  readonly smtpHost: string
  readonly smtpPort: number
  readonly user: string
  readonly password: string
  /** The bot's own address: what it sends from, and mail from it is ignored. */
  readonly address: string
  readonly mailbox: string
  /** The receiving server's authserv-id that Authentication-Results must carry (e.g. `mx.google.com`). */
  readonly authserv?: string
  /** False accepts mail whose sender was not verified. */
  readonly verify: boolean
}

/** A refused login (imapflow's `authenticationFailed`), which retrying cannot fix. */
const loginRefused = (err: unknown) =>
  (err as { authenticationFailed?: unknown })?.authenticationFailed === true

/** imapflow behind `MailboxClient`: implicit TLS on 993, STARTTLS otherwise. */
export function imapMailbox(s: EmailSettings): MailboxClient {
  const client = new ImapFlow({
    host: s.imapHost,
    port: s.imapPort,
    secure: s.imapPort === 993,
    auth: { user: s.user, pass: s.password },
    logger: false,
    connectionTimeout: 30_000,
    // Some servers drop an IDLE that runs too long; it is restarted before that.
    maxIdleTime: 5 * 60_000,
  })
  // An 'error' with no listener would crash the process; the 'close' that follows is what reconnects.
  client.on('error', () => {})
  return {
    // imapflow marks a refused login with `authenticationFailed`, which the adapter looks for.
    connect: () => client.connect(),
    open: async (path) => {
      const box = await client.mailboxOpen(path)
      return { uidValidity: String(box.uidValidity), uidNext: box.uidNext }
    },
    unseenAfter: async (uid) => {
      const found = await client.search({ uid: `${uid + 1}:*`, seen: false }, { uid: true })
      // `n:*` always includes the newest message, even when its UID is below n.
      return (found || []).filter((u) => u > uid).sort((a, b) => a - b)
    },
    source: async (uid) => {
      const head = await client.fetchOne(String(uid), { size: true }, { uid: true })
      if (!head || (head.size ?? 0) > MAIL_MAX) return undefined
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true })
      const source = msg ? msg.source : undefined
      return source ? new Uint8Array(source) : undefined
    },
    markSeen: async (uid) => {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
    },
    onMail: (listener) => client.on('exists', listener),
    onClose: (listener) => client.on('close', listener),
    close: async () => {
      await client.logout().catch(() => client.close())
    },
  }
}

/** nodemailer over SMTP: implicit TLS on 465, STARTTLS required otherwise (except plain port 25). */
export function smtpSender(s: EmailSettings): MailSender {
  return createTransport({
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpPort === 465,
    requireTLS: s.smtpPort !== 465 && s.smtpPort !== 25,
    auth: { user: s.user, pass: s.password },
    connectionTimeout: 30_000,
  })
}

/** A message id without its angle brackets, lower-cased: one form for comparing and storing. */
const bare = (id: string | undefined) => (id ?? '').trim().replace(/^<|>$/g, '').toLowerCase()

/** The message that started a thread: the first of References, else the one it replies to, else itself. */
export function threadRoot(mail: { messageId?: string; inReplyTo?: string; references?: string | string[] }) {
  const refs = typeof mail.references === 'string' ? mail.references.split(/\s+/) : (mail.references ?? [])
  return bare(refs.find((r) => r.trim()) ?? mail.inReplyTo ?? mail.messageId)
}

/** The reply's own words: quoted text (`>` lines, and everything after "On … wrote:" and the like) dropped. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  for (const [i, line] of lines.entries()) {
    const next = lines[i + 1] ?? ''
    if (/^\s*On\b.*\bwrote:\s*$/i.test(line)) break
    // Gmail wraps a long "On … wrote:" over two lines.
    if (/^\s*On\b/i.test(line) && /\bwrote:\s*$/i.test(next) && !/^\s*>/.test(next)) break
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break
    // Outlook: a rule, or straight away a From: line followed by Sent: or Date:.
    if (/^\s*_{10,}\s*$/.test(line) && /^\s*From:/i.test(next)) break
    if (/^\s*From:\s/i.test(line) && /^\s*(Sent|Date):\s/i.test(next)) break
    // A signature, or a phone's: a typed `/approve KEY` or option number must stand on its own.
    if (line === '-- ' || /^\s*(Sent from my \w+|Get Outlook for \w+)/i.test(line)) break
    if (/^\s*>/.test(line)) continue
    out.push(line)
  }
  return out.join('\n').trim()
}

/** Mail sent by a program, not a person: auto-replies, lists, bulk, bounces. */
export function isAutomated(headers: ReadonlyMap<string, unknown>, from: string): boolean {
  const h = (key: string) => {
    const v = headers.get(key)
    return v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  }
  const auto = h('auto-submitted').toLowerCase()
  return (
    NOREPLY.test(from) ||
    (auto !== '' && auto !== 'no') ||
    /^(bulk|list|junk)$/i.test(h('precedence').trim()) ||
    headers.has('list-id') ||
    headers.has('list-unsubscribe') ||
    headers.has('x-auto-response-suppress')
  )
}

const aligned = (a: string, b: string) => {
  const x = a.toLowerCase().replace(/\.$/, '')
  const y = b.toLowerCase().replace(/\.$/, '')
  return Boolean(x && y) && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`))
}

/**
 * Whether the receiving server verified the sender (Hermes's check): the topmost Authentication-Results (the one
 * the receiving server prepended) must be from `authserv` when given, and show DMARC pass, SPF pass for an aligned
 * envelope domain, or DKIM pass for an aligned signing domain. Comments and quoted strings are removed first, so
 * nothing inside them can pass for a result.
 */
export function senderVerified(results: readonly string[], from: string, authserv?: string): boolean {
  const top = results[0]
  const domain = from.split('@')[1] ?? ''
  if (!top || !domain) return false
  let text = top.replace(/\s+/g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, '""')
  for (let prev = ''; prev !== text; ) {
    prev = text
    text = text.replace(/\([^()]*\)/g, ' ')
  }
  const [head, ...clauses] = text.split(';').map((c) => c.trim())
  if (authserv && (head ?? '').split(' ')[0]?.toLowerCase() !== authserv.trim().toLowerCase()) return false
  const verdicts = clauses.flatMap((clause) => {
    const m = /^(dmarc|spf|dkim)\s*=\s*([a-z]+)/i.exec(clause)
    if (!m) return []
    const props = [
      ...clause.matchAll(/(header\.from|header\.d|smtp\.mailfrom|smtp\.from|envelope-from)=(\S+)/gi),
    ].map((p) => [(p[1] ?? '').toLowerCase(), (p[2] ?? '').split('@').pop() ?? ''] as const)
    return [{ method: (m[1] ?? '').toLowerCase(), pass: (m[2] ?? '').toLowerCase() === 'pass', props }]
  })
  const domains = (props: readonly (readonly [string, string])[], names: readonly string[]) =>
    props.filter(([k]) => names.includes(k)).map(([, v]) => v)
  const dmarc = verdicts.filter((v) => v.method === 'dmarc')
  if (
    dmarc.length === 1 &&
    dmarc[0]?.pass &&
    domains(dmarc[0].props, ['header.from']).every((d) => aligned(d, domain))
  )
    return true
  const spf = verdicts.filter((v) => v.method === 'spf')
  const spfDomains = spf[0] ? domains(spf[0].props, ['smtp.mailfrom', 'smtp.from', 'envelope-from']) : []
  if (spf.length === 1 && spf[0]?.pass && spfDomains.length && spfDomains.every((d) => aligned(d, domain)))
    return true
  return verdicts.some((v) => {
    if (v.method !== 'dkim' || !v.pass) return false
    const d = domains(v.props, ['header.d'])
    return d.length > 0 && d.every((x) => aligned(x, domain))
  })
}

/** Where a thread stands, kept so replies (after a restart too) carry its subject and headers. */
interface ThreadState {
  subject: string
  /** Message ids in the thread, oldest first (the last is what a reply answers). */
  refs: string[]
}

const kindOf = (mime: string): InboundFile['kind'] =>
  mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('audio/')
      ? 'audio'
      : mime.startsWith('video/')
        ? 'video'
        : 'document'

/**
 * A parsed email as the hub's message (and where its thread stands), or the reason it is ignored: no sender, our
 * own, automatic, or unverified.
 */
export function mailInbound(
  mail: ParsedMail,
  options: { self: string; verify: boolean; authserv?: string; fallbackId: string },
): { inbound: Inbound; thread: ThreadState & { root: string } } | { ignored: string } {
  const from = mail.from?.value[0]
  const address = (from?.address ?? '').trim().toLowerCase()
  if (!address.includes('@')) return { ignored: 'no sender' }
  if (address === options.self.trim().toLowerCase()) return { ignored: 'our own' }
  if (isAutomated(mail.headers, address)) return { ignored: 'automatic' }
  const results = mail.headerLines
    .filter((l) => l.key === 'authentication-results')
    .map((l) => l.line.replace(/^[^:]*:\s*/, ''))
  if (options.verify && !senderVerified(results, address, options.authserv)) return { ignored: 'unverified' }
  const messageId = bare(mail.messageId) || options.fallbackId
  const root = threadRoot(mail) || messageId
  const subject = (mail.subject ?? '').trim()
  const reply = root !== messageId
  const body = stripQuoted(mail.text ?? '')
  const files: InboundFile[] = mail.attachments
    .filter((a) => !a.related)
    .map((a, i) => ({
      kind: kindOf(a.contentType),
      name: a.filename || `attachment-${i + 1}`,
      mimeType: a.contentType || 'application/octet-stream',
      size: a.size,
      read: async () => new Uint8Array(a.content),
    }))
  const refs = typeof mail.references === 'string' ? mail.references.split(/\s+/) : (mail.references ?? [])
  return {
    inbound: {
      messageId,
      chat: { id: address, kind: 'dm', thread: root },
      sender: { id: address, name: from?.name?.trim() || address, handle: address },
      // A new thread's subject is often the whole request.
      text: reply || !subject ? body : channelCopy.email.withSubject(subject, body),
      mentioned: true,
      ...(files.length ? { files } : {}),
      time: (mail.date ?? new Date()).toISOString(),
    },
    thread: {
      root,
      subject: subject || channelCopy.email.subject,
      refs: [...refs.map(bare), messageId].filter(Boolean),
    },
  }
}

/** "Re: subject", once. */
export const replySubject = (subject: string) =>
  /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`

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

export class EmailAdapter implements ChannelAdapter {
  readonly id = 'email'
  readonly label = 'Email'
  /** An email carries a whole answer; edits never happen (`editMs` is unused). */
  readonly limits = { text: 100_000, editMs: 60_000, file: 15 * 1024 * 1024 }
  readonly can = { buttons: false, files: true, edit: false }
  private _abort?: AbortController
  private _loop?: Promise<void>
  private _io?: AdapterIO
  private _sender?: MailSender

  constructor(
    private readonly settings: EmailSettings,
    private readonly deps: {
      readonly mailbox?: (s: EmailSettings) => MailboxClient
      readonly sender?: (s: EmailSettings) => MailSender
    } = {},
  ) {}

  private _mailbox() {
    return (this.deps.mailbox ?? imapMailbox)(this.settings)
  }

  private get _smtp() {
    this._sender ??= (this.deps.sender ?? smtpSender)(this.settings)
    return this._sender
  }

  async check(): Promise<string> {
    const box = this._mailbox()
    try {
      await box.connect()
      await box.open(this.settings.mailbox)
    } catch (err) {
      if (loginRefused(err)) throw new Error(channelCopy.errors.emailLogin)
      throw err
    } finally {
      await box.close().catch(() => {})
    }
    try {
      await this._smtp.verify()
    } catch (err) {
      const e = err as { code?: string; responseCode?: number; message?: string }
      if (e.code === 'EAUTH' || e.responseCode === 535) throw new Error(channelCopy.errors.emailLogin)
      throw new Error(channelCopy.errors.emailSend(e.message ?? String(err)))
    }
    return this.settings.address
  }

  async start(io: AdapterIO): Promise<void> {
    this._io = io
    this._abort = new AbortController()
    const signal = this._abort.signal
    io.status({ state: 'connecting' })
    this._loop = (async () => {
      let backoff = BACKOFF_MIN_MS
      while (!signal.aborted) {
        const box = this._mailbox()
        let wake: (() => void) | undefined
        let closed = false
        box.onMail(() => wake?.())
        box.onClose(() => {
          closed = true
          wake?.()
        })
        try {
          await box.connect()
          const opened = await box.open(this.settings.mailbox)
          // A new mailbox (or one whose UIDs were renumbered) starts after what is already there.
          if (io.get('uidvalidity') !== opened.uidValidity) {
            io.set('uidvalidity', opened.uidValidity)
            io.set('uid', String(opened.uidNext - 1))
          }
          io.status({ state: 'on', account: this.settings.address })
          backoff = BACKOFF_MIN_MS
          while (!signal.aborted && !closed) {
            await this._drain(io, box, opened.uidValidity)
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, POLL_MS)
              wake = () => {
                clearTimeout(timer)
                resolve()
              }
              signal.addEventListener('abort', wake, { once: true })
            })
            wake = undefined
          }
          if (signal.aborted) break
          io.status({ state: 'retrying', error: 'the mail server closed the connection' })
        } catch (err) {
          if (signal.aborted) break
          if (loginRefused(err)) {
            io.status({ state: 'error', error: channelCopy.errors.emailLogin })
            break
          }
          io.status({ state: 'retrying', error: err instanceof Error ? err.message : String(err) })
        } finally {
          await box.close().catch(() => {})
        }
        await sleep(backoff * (0.75 + Math.random() * 0.5), signal)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    })()
  }

  /** Everything new since the last UID handled, each recorded before the UID moves past it. */
  private async _drain(io: AdapterIO, box: MailboxClient, validity: string) {
    const last = Number(io.get('uid') ?? 0)
    for (const uid of await box.unseenAfter(last)) {
      const raw = await box.source(uid)
      if (raw) {
        try {
          const mail = await simpleParser(Buffer.from(raw))
          const result = mailInbound(mail, {
            self: this.settings.address,
            verify: this.settings.verify,
            ...(this.settings.authserv ? { authserv: this.settings.authserv } : {}),
            fallbackId: `uid-${validity}-${uid}@imap`,
          })
          if ('ignored' in result) {
            if (result.ignored === 'unverified')
              io.log(`ignored mail from an unverified sender (Authentication-Results did not pass)`)
          } else {
            this._remember(result.thread.root, result.thread)
            await io.receive(result.inbound)
            await box.markSeen(uid)
          }
        } catch (err) {
          // One message that cannot be read must not hold up the rest.
          io.log(
            `skipped a message that could not be read: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      io.set('uid', String(uid))
    }
  }

  private _thread(root: string | undefined): ThreadState | undefined {
    if (!root) return undefined
    try {
      return JSON.parse(this._io?.get(`thread:${root}`) ?? '') as ThreadState
    } catch {
      return undefined
    }
  }

  private _remember(root: string, state: ThreadState) {
    // The last few ids are enough for mail clients to thread a reply.
    this._io?.set(`thread:${root}`, JSON.stringify({ subject: state.subject, refs: state.refs.slice(-10) }))
  }

  private _domain() {
    return this.settings.address.split('@')[1] || 'localhost'
  }

  private async _mail(chat: ChannelChat | string, text: string, files: readonly OutFile[] = []) {
    const to = chatIdOf(chat)
    const root = threadOf(chat)
    const state = this._thread(root)
    const messageId = `${randomUUID()}@${this._domain()}`
    const refs = state?.refs ?? []
    const last = refs.at(-1)
    await this._smtp.sendMail({
      from: this.settings.address,
      to,
      subject: state ? replySubject(state.subject) : channelCopy.email.subject,
      messageId: `<${messageId}>`,
      ...(last ? { inReplyTo: `<${last}>`, references: refs.map((r) => `<${r}>`).join(' ') } : {}),
      text,
      ...(text ? { html: emailHtml(text) } : {}),
      ...(files.length
        ? {
            attachments: files.map((f) => ({
              filename: f.name,
              content: Buffer.from(f.data),
              contentType: f.mimeType,
            })),
          }
        : {}),
    })
    // Our reply joins the thread, so the next one follows it.
    if (root && state) this._remember(root, { subject: state.subject, refs: [...refs, messageId] })
    return { chat: to, id: messageId }
  }

  async stop(): Promise<void> {
    this._abort?.abort()
    await this._loop?.catch(() => {})
    const sender = this._sender as { close?: () => void } | undefined
    sender?.close?.()
  }

  async send(chat: ChannelChat | string, message: OutMessage): Promise<SentRef> {
    return this._mail(chat, message.text)
  }

  /** A sent email cannot be changed; an edit sends nothing rather than another email. */
  async edit(_ref: SentRef, _message: OutMessage): Promise<void> {}

  async typing(_chat: ChannelChat | string): Promise<void> {}

  async sendFile(chat: ChannelChat | string, file: OutFile): Promise<SentRef> {
    return this._mail(chat, file.caption ?? '', [file])
  }
}
