import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { simpleParser } from 'mailparser'
import { createTransport } from 'nodemailer'
import { channelCopy } from '../src/channels/copy.ts'
import {
  type AdapterIO,
  type AdapterStatus,
  EmailAdapter,
  type EmailSettings,
  emailHtml,
  type Inbound,
  isAutomated,
  type MailboxClient,
  type MailSender,
  mailInbound,
  plainText,
  replySubject,
  senderVerified,
  stripQuoted,
  threadRoot,
} from '../src/channels/index.ts'

const BOT = 'myr@example.org'
const PASS =
  'mx.example.org; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=alice@example.com; dmarc=pass header.from=example.com'

/** An email as a mail server stores it. */
function rfc822(headers: Record<string, string>, body: string) {
  const lines = Object.entries({
    'Authentication-Results': PASS,
    From: 'Alice <alice@example.com>',
    To: BOT,
    Date: 'Thu, 08 Oct 2026 10:00:00 +0000',
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers,
  })
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${v}`)
  return `${lines.join('\r\n')}\r\n\r\n${body.replace(/\n/g, '\r\n')}`
}

const parse = (raw: string) => simpleParser(Buffer.from(raw))
const inboundOf = async (raw: string, verify = true, authserv?: string) =>
  mailInbound(await parse(raw), {
    self: BOT,
    verify,
    ...(authserv ? { authserv } : {}),
    fallbackId: 'uid-1@imap',
  })

test('quoted text is dropped: > lines, "On … wrote:" (also wrapped), Outlook headers, signatures', () => {
  expect(
    stripQuoted('Yes, do it.\n\nOn Mon, 5 Oct 2026 at 10:00, Myr <myr@example.org> wrote:\n> Shall I?\n'),
  ).toBe('Yes, do it.')
  expect(
    stripQuoted(
      'Sounds good\r\n\r\nOn Mon, 5 Oct 2026 at 10:00, Some Long Name\r\n<myr@example.org> wrote:\r\n> old',
    ),
  ).toBe('Sounds good')
  expect(stripQuoted('Top\n\n-----Original Message-----\nFrom: x')).toBe('Top')
  expect(stripQuoted('Top\n________________________________\nFrom: Myr\nSent: today')).toBe('Top')
  expect(stripQuoted('Top\nFrom: Myr <myr@example.org>\nSent: Monday\nSubject: x')).toBe('Top')
  expect(stripQuoted('Answer\n-- \nAlice\nCEO')).toBe('Answer')
  expect(stripQuoted('2\n\nSent from my iPhone')).toBe('2')
  expect(stripQuoted('> quoted\nmine\n> more\nalso mine')).toBe('mine\nalso mine')
  // Words that merely start a sentence with "On" are kept.
  expect(stripQuoted('On second thought, wait.\nThanks')).toBe('On second thought, wait.\nThanks')
})

test('threads: the first reference, else the message replied to, else the message itself', () => {
  expect(threadRoot({ messageId: '<c@x>', inReplyTo: '<b@x>', references: ['<a@x>', '<b@x>'] })).toBe('a@x')
  expect(threadRoot({ messageId: '<c@x>', inReplyTo: '<B@X>' })).toBe('b@x')
  expect(threadRoot({ messageId: '<C@x>' })).toBe('c@x')
  expect(threadRoot({ references: '<a@x> <b@x>' })).toBe('a@x')
  expect(replySubject('Plan')).toBe('Re: Plan')
  expect(replySubject('RE: Plan')).toBe('RE: Plan')
})

test('automatic mail is recognized by its headers and address', () => {
  const h = (o: Record<string, string>) => new Map(Object.entries(o))
  expect(isAutomated(h({}), 'alice@example.com')).toBe(false)
  expect(isAutomated(h({ 'auto-submitted': 'auto-replied' }), 'alice@example.com')).toBe(true)
  expect(isAutomated(h({ 'auto-submitted': 'no' }), 'alice@example.com')).toBe(false)
  expect(isAutomated(h({ precedence: 'bulk' }), 'alice@example.com')).toBe(true)
  expect(isAutomated(h({ 'list-id': '<news.example.com>' }), 'alice@example.com')).toBe(true)
  expect(isAutomated(h({}), 'no-reply@shop.example')).toBe(true)
  expect(isAutomated(h({}), 'MAILER-DAEMON@example.com')).toBe(true)
})

test('senders count only when the receiving server verified them, and nothing in comments or quotes passes', () => {
  expect(senderVerified([PASS], 'alice@example.com')).toBe(true)
  expect(senderVerified([PASS], 'alice@example.com', 'mx.example.org')).toBe(true)
  // Pinned to another server: the topmost header is not from it.
  expect(senderVerified([PASS], 'alice@example.com', 'mx.google.com')).toBe(false)
  // Only the topmost (prepended by the receiving server) counts.
  expect(
    senderVerified(['mx.example.org; dmarc=fail header.from=example.com', PASS], 'alice@example.com'),
  ).toBe(false)
  expect(senderVerified([], 'alice@example.com')).toBe(false)
  // Passing for another domain is no proof for this one.
  expect(senderVerified(['mx; dmarc=pass header.from=evil.example'], 'alice@example.com')).toBe(false)
  expect(senderVerified(['mx; spf=pass smtp.mailfrom=bounce@evil.example'], 'alice@example.com')).toBe(false)
  expect(senderVerified(['mx; spf=pass smtp.mailfrom=bounce@mail.example.com'], 'alice@example.com')).toBe(
    true,
  )
  expect(senderVerified(['mx; dkim=pass header.d=example.com'], 'alice@example.com')).toBe(true)
  expect(senderVerified(['mx; dkim=pass header.d=other.example'], 'alice@example.com')).toBe(false)
  expect(senderVerified(['mx; dmarc=fail (dmarc=pass) header.from=example.com'], 'alice@example.com')).toBe(
    false,
  )
  expect(
    senderVerified(
      ['mx; spf=fail smtp.mailfrom="x;dmarc=pass"@example.com header.from=example.com'],
      'alice@example.com',
    ),
  ).toBe(false)
  // Two DMARC verdicts are ambiguous.
  expect(senderVerified(['mx; dmarc=pass; dmarc=pass'], 'alice@example.com')).toBe(false)
})

test('an email becomes a message: subject on a new thread, quotes stripped, attachments, a thread per root', async () => {
  const fresh = await inboundOf(
    rfc822({ Subject: 'Draft the launch post', 'Message-ID': '<m1@example.com>' }, 'Make it short.'),
  )
  if ('ignored' in fresh) throw new Error(fresh.ignored)
  expect(fresh.inbound).toMatchObject({
    messageId: 'm1@example.com',
    chat: { id: 'alice@example.com', kind: 'dm', thread: 'm1@example.com' },
    sender: { id: 'alice@example.com', name: 'Alice', handle: 'alice@example.com' },
    text: 'Draft the launch post\n\nMake it short.',
    mentioned: true,
    time: '2026-10-08T10:00:00.000Z',
  })
  expect(fresh.thread).toEqual({
    root: 'm1@example.com',
    subject: 'Draft the launch post',
    refs: ['m1@example.com'],
  })

  const reply = await inboundOf(
    rfc822(
      {
        Subject: 'Re: Draft the launch post',
        'Message-ID': '<m3@example.com>',
        'In-Reply-To': '<m2@example.org>',
        References: '<m1@example.com> <m2@example.org>',
      },
      'Shorter.\n\nOn Thu, Myr <myr@example.org> wrote:\n> Here it is',
    ),
  )
  if ('ignored' in reply) throw new Error(reply.ignored)
  expect(reply.inbound.chat.thread).toBe('m1@example.com')
  expect(reply.inbound.text).toBe('Shorter.')
  expect(reply.thread.refs).toEqual(['m1@example.com', 'm2@example.org', 'm3@example.com'])

  const boundary = 'b1'
  const withFile = await inboundOf(
    rfc822(
      {
        Subject: 'Logs',
        'Message-ID': '<m4@example.com>',
        'Content-Type': `multipart/mixed; boundary="${boundary}"`,
      },
      [
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        'See attached.',
        `--${boundary}`,
        'Content-Type: image/png; name="shot.png"',
        'Content-Disposition: attachment; filename="shot.png"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from([1, 2, 3]).toString('base64'),
        `--${boundary}--`,
        '',
      ].join('\n'),
    ),
  )
  if ('ignored' in withFile) throw new Error(withFile.ignored)
  const file = withFile.inbound.files?.[0]
  expect(file).toMatchObject({ kind: 'image', name: 'shot.png', mimeType: 'image/png', size: 3 })
  expect([...((await file?.read()) ?? [])]).toEqual([1, 2, 3])
})

test('ignored: our own mail, automatic mail, unverified senders (unless checking is off)', async () => {
  expect(await inboundOf(rfc822({ From: `Myr <${BOT}>`, 'Message-ID': '<a@x>' }, 'x'))).toEqual({
    ignored: 'our own',
  })
  expect(
    await inboundOf(rfc822({ 'Auto-Submitted': 'auto-replied', 'Message-ID': '<b@x>' }, 'Out of office')),
  ).toEqual({
    ignored: 'automatic',
  })
  const forged = rfc822(
    { 'Authentication-Results': 'mx.example.org; dmarc=fail', 'Message-ID': '<c@x>' },
    'x',
  )
  expect(await inboundOf(forged)).toEqual({ ignored: 'unverified' })
  expect('inbound' in (await inboundOf(forged, false))).toBe(true)
  expect(await inboundOf(rfc822({ 'Message-ID': '<d@x>' }, 'x'), true, 'mx.google.com')).toEqual({
    ignored: 'unverified',
  })
})

test('Markdown renders as simple HTML for email and plain text for SMS', () => {
  expect(emailHtml('# Plan\n\nDo **this** and `that`:\n- one\n- two\n\n```\na < b\n```')).toBe(
    [
      '<h2>Plan</h2>',
      '<p>Do <b>this</b> and <code>that</code>:</p>',
      '<ul>',
      '<li>one</li>',
      '<li>two</li>',
      '</ul>',
      '<pre><code>a &lt; b</code></pre>',
    ].join('\n'),
  )
  expect(plainText('## Done\n\n**All** set: [report](https://x.example/r), `a_b`\n- one')).toBe(
    'Done\n\nAll set: report (https://x.example/r), a_b\n• one',
  )
})

/** A mailbox in memory, standing in for an IMAP server. */
function mailbox(options: { refuse?: boolean } = {}) {
  const messages = new Map<number, { raw: string; seen: boolean }>()
  const state = { uidValidity: '7', uidNext: 1, connects: 0, open: 0 }
  let mail: (() => void) | undefined
  let close: (() => void) | undefined
  const client: MailboxClient = {
    connect: async () => {
      state.connects++
      if (options.refuse)
        throw Object.assign(new Error('Authentication failed'), { authenticationFailed: true })
    },
    open: async () => {
      state.open++
      return { uidValidity: state.uidValidity, uidNext: state.uidNext }
    },
    unseenAfter: async (uid) =>
      [...messages.entries()].filter(([u, m]) => u > uid && !m.seen).map(([u]) => u),
    source: async (uid) => {
      const m = messages.get(uid)
      return m ? new TextEncoder().encode(m.raw) : undefined
    },
    markSeen: async (uid) => {
      const m = messages.get(uid)
      if (m) m.seen = true
    },
    onMail: (l) => {
      mail = l
    },
    onClose: (l) => {
      close = l
    },
    close: async () => {},
  }
  return {
    client,
    state,
    messages,
    deliver(raw: string) {
      messages.set(state.uidNext++, { raw, seen: false })
      mail?.()
    },
    drop: () => close?.(),
  }
}

/** nodemailer's JSON transport, which renders each message instead of sending it. */
function outbox(options: { refuse?: boolean } = {}) {
  const transport = createTransport({ jsonTransport: true })
  const sent: Record<string, unknown>[] = []
  const sender: MailSender = {
    verify: async () => {
      if (options.refuse)
        throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 })
      return true
    },
    sendMail: async (m) => {
      const info = await transport.sendMail(m)
      sent.push(JSON.parse(String(info.message)))
      return info
    },
  }
  return { sender, sent }
}

const SETTINGS: EmailSettings = {
  imapHost: 'imap.example.org',
  imapPort: 993,
  smtpHost: 'smtp.example.org',
  smtpPort: 587,
  user: BOT,
  password: 'pw',
  address: BOT,
  mailbox: 'INBOX',
  verify: true,
}

const adapters: EmailAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
})

function io(kv = new Map<string, string>()) {
  const received: Inbound[] = []
  const statuses: AdapterStatus[] = []
  const handle: AdapterIO = {
    receive: async (m) => {
      received.push(m)
    },
    get: (k) => kv.get(k),
    set: (k, v) => kv.set(k, v),
    status: (s) => statuses.push(s),
    log: () => {},
    dir: tmpdir(),
  }
  return { handle, received, statuses, kv }
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

test('check() logs in to both servers and names the address; refused logins are errors', async () => {
  const ok = new EmailAdapter(SETTINGS, { mailbox: () => mailbox().client, sender: () => outbox().sender })
  expect(await ok.check()).toBe(BOT)
  const badImap = new EmailAdapter(SETTINGS, {
    mailbox: () => mailbox({ refuse: true }).client,
    sender: () => outbox().sender,
  })
  await expect(badImap.check()).rejects.toThrow(channelCopy.errors.emailLogin)
  const badSmtp = new EmailAdapter(SETTINGS, {
    mailbox: () => mailbox().client,
    sender: () => outbox({ refuse: true }).sender,
  })
  await expect(badSmtp.check()).rejects.toThrow(channelCopy.errors.emailLogin)

  adapters.push(badImap)
  const { handle, statuses } = io()
  await badImap.start(handle)
  await until(() => statuses.some((s) => s.state === 'error'))
  expect(statuses.at(-1)).toEqual({ state: 'error', error: channelCopy.errors.emailLogin })
})

test('new mail is taken after the last UID, marked seen, and replies thread with Re: and References', async () => {
  const box = mailbox()
  // Mail already there when the channel is set up is left alone.
  box.deliver(rfc822({ Subject: 'old', 'Message-ID': '<old@example.com>' }, 'before'))
  const out = outbox()
  const adapter = new EmailAdapter(SETTINGS, { mailbox: () => box.client, sender: () => out.sender })
  adapters.push(adapter)
  const { handle, received, statuses, kv } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(statuses.at(-1)).toEqual({ state: 'on', account: BOT })
  expect(kv.get('uid')).toBe('1')

  box.deliver(rfc822({ Subject: 'Plan the trip', 'Message-ID': '<t1@example.com>' }, 'Three days.'))
  box.deliver(rfc822({ 'Auto-Submitted': 'auto-replied', 'Message-ID': '<ooo@example.com>' }, 'Away'))
  await until(() => kv.get('uid') === '3')
  expect(received.map((m) => m.text)).toEqual(['Plan the trip\n\nThree days.'])
  expect(box.messages.get(2)?.seen).toBe(true)
  // Ignored mail is passed over, not marked.
  expect(box.messages.get(3)?.seen).toBe(false)
  expect(box.messages.get(1)?.seen).toBe(false)

  const chat = received[0]?.chat ?? 'alice@example.com'
  const ref = await adapter.send(chat, { text: 'Here is a **plan**.' })
  expect(ref.chat).toBe('alice@example.com')
  expect(out.sent[0]).toMatchObject({
    from: { address: BOT },
    to: [{ address: 'alice@example.com' }],
    subject: 'Re: Plan the trip',
    inReplyTo: '<t1@example.com>',
    references: '<t1@example.com>',
    text: 'Here is a **plan**.',
    html: '<p>Here is a <b>plan</b>.</p>',
  })
  // The next reply answers ours, and keeps the whole chain.
  await adapter.sendFile(chat, { name: 'trip.pdf', mimeType: 'application/pdf', data: new Uint8Array([1]) })
  expect(out.sent[1]).toMatchObject({
    subject: 'Re: Plan the trip',
    inReplyTo: `<${ref.id}>`,
    references: `<t1@example.com> <${ref.id}>`,
    attachments: [{ filename: 'trip.pdf', contentType: 'application/pdf' }],
  })
  // A message with no thread (the owner notified) starts one.
  await adapter.send('alice@example.com', { text: 'Done.' })
  expect(out.sent[2]).toMatchObject({ subject: channelCopy.email.subject })
  expect(out.sent[2]?.inReplyTo).toBeUndefined()
  expect(adapter.can).toEqual({ buttons: false, files: true, edit: false })

  // A dropped connection reconnects and carries on from the saved UID.
  box.drop()
  await until(() => box.state.connects === 2, 15_000)
  box.deliver(
    rfc822(
      {
        Subject: 'Re: Plan the trip',
        'Message-ID': '<t2@example.com>',
        'In-Reply-To': `<${ref.id}>`,
        References: `<t1@example.com> <${ref.id}>`,
      },
      'Make it four.\n\n> Here is a plan.',
    ),
  )
  await until(() => received.length === 2, 15_000)
  expect(received[1]).toMatchObject({ text: 'Make it four.', chat: { thread: 't1@example.com' } })
}, 30_000)
