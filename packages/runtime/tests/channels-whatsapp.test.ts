import { afterEach, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WAMessage } from 'baileys'
import { channelCopy } from '../src/channels/copy.ts'
import {
  type AdapterIO,
  type AdapterStatus,
  BUILT_IN_CHANNELS,
  backoffMs,
  type Inbound,
  WhatsAppAdapter,
  WhatsAppCloudAdapter,
  whatsappInbound,
  whatsappText,
} from '../src/channels/index.ts'

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: { stop(): Promise<void> }[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function io(extra: Partial<AdapterIO> = {}) {
  const received: Inbound[] = []
  const statuses: AdapterStatus[] = []
  const handle: AdapterIO = {
    receive: async (m) => {
      received.push(m)
    },
    get: () => undefined,
    set: () => {},
    status: (s) => statuses.push(s),
    log: () => {},
    dir: tmpdir(),
    ...extra,
  }
  return { handle, received, statuses }
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

// ── Markdown → WhatsApp ─────────────────────────────────────────────────────────────────────────────────────────

test('Markdown becomes WhatsApp formatting: bold, italic, strike, code kept, headings, bullets, links', () => {
  expect(whatsappText('**bold** and *italic* and _also_ and ~~gone~~')).toBe(
    '*bold* and _italic_ and _also_ and ~gone~',
  )
  expect(whatsappText('__bold__ too')).toBe('*bold* too')
  expect(whatsappText('# Title\n## The **big** one')).toBe('*Title*\n*The big one*')
  expect(whatsappText('- one\n* two\n  + three')).toBe('• one\n• two\n  • three')
  expect(whatsappText('see [docs](https://x.dev/a) or https://y.dev')).toBe(
    'see docs (https://x.dev/a) or https://y.dev',
  )
  expect(whatsappText('[https://x.dev](https://x.dev)')).toBe('https://x.dev')
  // Code is left alone, and a fence loses its language (WhatsApp would print it).
  expect(whatsappText('run `a **b** c`')).toBe('run `a **b** c`')
  expect(whatsappText('```ts\nconst x = **y**\n```')).toBe('```\nconst x = **y**\n```')
  expect(whatsappText('```\nleft open')).toBe('```\nleft open\n```')
  expect(whatsappText('> quoted')).toBe('> quoted')
  expect(whatsappText('2 * 3 * 4')).toBe('2 * 3 * 4')
})

// ── Baileys messages → the hub's ────────────────────────────────────────────────────────────────────────────────

const SELF = { jid: '15550001111:7@s.whatsapp.net', lid: '99887766:7@lid' }
const noRead = async () => new Uint8Array()
const wa = (
  key: Record<string, unknown>,
  message: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  ({
    key: { id: 'M1', ...key },
    message,
    messageTimestamp: 1_700_000_000,
    pushName: 'Alice',
    ...extra,
  }) as WAMessage

test('a direct message: text, the sender by phone number when WhatsApp gives it, always mentioned', () => {
  const m = whatsappInbound(
    wa({ remoteJid: '1234@lid', remoteJidAlt: '447700900123@s.whatsapp.net' }, { conversation: ' hello ' }),
    SELF,
    noRead,
  )
  expect(m).toMatchObject({
    messageId: 'M1',
    chat: { id: '1234@lid', kind: 'dm' },
    sender: { id: '447700900123@s.whatsapp.net', name: 'Alice', handle: '+447700900123' },
    text: 'hello',
    mentioned: true,
    time: new Date(1_700_000_000_000).toISOString(),
  })
  // Without the phone form, the LID is the id and there is no handle.
  const lidOnly = whatsappInbound(
    wa({ remoteJid: '1234@lid' }, { conversation: 'hi' }, { pushName: '' }),
    SELF,
    noRead,
  )
  expect(lidOnly?.sender).toEqual({ id: '1234@lid', name: 'Someone' })
})

test('ignored: its own messages, status updates, channels, and messages with nothing in them', () => {
  expect(
    whatsappInbound(wa({ remoteJid: '1@s.whatsapp.net', fromMe: true }, { conversation: 'x' }), SELF, noRead),
  ).toBe(undefined)
  expect(whatsappInbound(wa({ remoteJid: 'status@broadcast' }, { conversation: 'x' }), SELF, noRead)).toBe(
    undefined,
  )
  expect(whatsappInbound(wa({ remoteJid: '1@newsletter' }, { conversation: 'x' }), SELF, noRead)).toBe(
    undefined,
  )
  expect(
    whatsappInbound(wa({ remoteJid: '1@s.whatsapp.net' }, { reactionMessage: { text: '👍' } }), SELF, noRead),
  ).toBe(undefined)
})

test('groups: mentioned only when the bot is tagged (by number or LID, any device) or replied to', () => {
  const group = (message: Record<string, unknown>) =>
    whatsappInbound(
      wa(
        { remoteJid: '120363@g.us', participant: '5551@lid', participantAlt: '15552222222@s.whatsapp.net' },
        message,
      ),
      SELF,
      noRead,
    )
  const chatter = group({ conversation: 'lunch?' })
  expect(chatter).toMatchObject({
    chat: { id: '120363@g.us', kind: 'group' },
    sender: { id: '15552222222@s.whatsapp.net' },
    mentioned: false,
  })
  const tagged = group({
    extendedTextMessage: {
      text: '@15550001111 look at this',
      contextInfo: { mentionedJid: ['15550001111@s.whatsapp.net'] },
    },
  })
  expect(tagged).toMatchObject({ mentioned: true, text: 'look at this' })
  const byLid = group({
    extendedTextMessage: { text: '@99887766, please', contextInfo: { mentionedJid: ['99887766@lid'] } },
  })
  expect(byLid).toMatchObject({ mentioned: true, text: 'please' })
  // Someone else tagged: not for the bot.
  const other = group({
    extendedTextMessage: { text: '@1999 hi', contextInfo: { mentionedJid: ['1999@s.whatsapp.net'] } },
  })
  expect(other?.mentioned).toBe(false)
  const reply = group({
    extendedTextMessage: { text: 'yes do it', contextInfo: { participant: '99887766@lid' } },
  })
  expect(reply?.mentioned).toBe(true)
  expect(group({ conversation: '/status' })?.mentioned).toBe(true)
})

test('files: photos with captions, voice notes, documents, read only when asked; stickers are unsupported', async () => {
  const reads: string[] = []
  const read = async (msg: WAMessage) => {
    reads.push(msg.key.id ?? '')
    return new Uint8Array([7, 7])
  }
  const photo = whatsappInbound(
    wa(
      { remoteJid: '1@s.whatsapp.net', id: 'P1' },
      {
        ephemeralMessage: {
          message: { imageMessage: { caption: 'what is this', mimetype: 'image/jpeg', fileLength: 2048 } },
        },
      },
    ),
    SELF,
    read,
  )
  expect(photo).toMatchObject({ text: 'what is this' })
  expect(photo?.files?.[0]).toMatchObject({
    kind: 'image',
    name: 'photo-P1.jpg',
    mimeType: 'image/jpeg',
    size: 2048,
  })
  expect(reads).toEqual([])
  expect(await photo?.files?.[0]?.read()).toEqual(new Uint8Array([7, 7]))
  expect(reads).toEqual(['P1'])

  const voice = whatsappInbound(
    wa(
      { remoteJid: '1@s.whatsapp.net', id: 'V1' },
      { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } },
    ),
    SELF,
    read,
  )
  expect(voice?.files?.[0]).toMatchObject({ kind: 'voice', name: 'voice-V1.ogg', mimeType: 'audio/ogg' })
  expect(voice?.text).toBe('')

  const doc = whatsappInbound(
    wa(
      { remoteJid: '1@s.whatsapp.net', id: 'D1' },
      {
        documentWithCaptionMessage: {
          message: {
            documentMessage: { fileName: 'plan.pdf', mimetype: 'application/pdf', caption: 'read this' },
          },
        },
      },
    ),
    SELF,
    read,
  )
  expect(doc).toMatchObject({ text: 'read this', files: [{ kind: 'document', name: 'plan.pdf' }] })

  const sticker = whatsappInbound(wa({ remoteJid: '1@s.whatsapp.net' }, { stickerMessage: {} }), SELF, read)
  expect(sticker).toMatchObject({ text: '', unsupported: true })
})

/** A stand-in for Baileys's socket: events are emitted by the test, sends recorded. */
class FakeSock {
  private readonly handlers = new Map<string, ((data: unknown) => void)[]>()
  readonly sent: [string, Record<string, unknown>][] = []
  readonly presence: [string, string][] = []
  readonly reads: unknown[] = []
  user?: { id: string; lid?: string }
  ev = {
    on: (event: string, fn: (data: unknown) => void) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
    },
  }
  emit(event: string, data: unknown) {
    for (const fn of this.handlers.get(event) ?? []) fn(data)
  }
  close(code: number) {
    this.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: code } } },
    })
  }
  sendMessage = async (jid: string, content: Record<string, unknown>) => {
    this.sent.push([jid, content])
    return {
      key: { id: `OUT${this.sent.length}`, remoteJid: jid, fromMe: true },
      message: { conversation: '' },
    }
  }
  sendPresenceUpdate = async (type: string, jid: string) => {
    this.presence.push([type, jid])
  }
  readMessages = async (keys: unknown[]) => {
    this.reads.push(...keys)
  }
  groupMetadata = async () => ({ subject: 'The crew' })
  updateMediaMessage = async () => ({})
  end = () => this.close(428)
}

function fakeBaileys() {
  const sockets: FakeSock[] = []
  let saved = 0
  const baileys = {
    useMultiFileAuthState: async (dir: string) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'creds.json'), '{}')
      return { state: { creds: {}, keys: {} }, saveCreds: async () => void saved++ }
    },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    makeCacheableSignalKeyStore: (keys: unknown) => keys,
    Browsers: { appropriate: (name: string) => ['Mac OS', name, '14'] },
    makeWASocket: () => {
      const sock = new FakeSock()
      sockets.push(sock)
      return sock
    },
    downloadMediaMessage: async () => Buffer.from([9]),
  }
  return { sockets, saved: () => saved, load: async () => baileys as unknown as typeof import('baileys') }
}

test('the linked device: a QR code to scan, a restart after linking, messages in and out, logged out cleared', async () => {
  const fake = fakeBaileys()
  const adapter = new WhatsAppAdapter(fake.load)
  adapters.push(adapter)
  const dir = mkdtempSync(join(tmpdir(), 'myr-wa-'))
  const { handle, received, statuses } = io({ dir })
  await adapter.start(handle)
  await until(() => fake.sockets.length === 1)
  const first = fake.sockets[0] as FakeSock

  first.emit('connection.update', { qr: '2@abc,def' })
  await until(() => statuses.some((s) => s.state === 'linking'))
  const linking = statuses.find((s) => s.state === 'linking')
  expect(linking).toMatchObject({ qr: '2@abc,def', hint: channelCopy.whatsapp.linking })
  expect(linking?.state === 'linking' && linking.image.startsWith('data:image/png;base64,')).toBe(true)

  // Scanned: WhatsApp asks for a restart, and the saved session reconnects at once.
  first.emit('creds.update', {})
  first.close(515)
  await until(() => fake.sockets.length === 2)
  expect(fake.saved()).toBe(1)
  const sock = fake.sockets[1] as FakeSock
  sock.user = { id: '15550001111:7@s.whatsapp.net', lid: '99887766:7@lid' }
  sock.emit('connection.update', { connection: 'open' })
  expect(statuses.at(-1)).toEqual({ state: 'on', account: '+15550001111' })
  expect(await adapter.check()).toBe('+15550001111')

  const now = Math.floor(Date.now() / 1000)
  sock.emit('messages.upsert', {
    type: 'notify',
    messages: [
      wa(
        { id: 'G1', remoteJid: '120363@g.us', participant: '5551@lid' },
        { extendedTextMessage: { text: '@99887766 hi', contextInfo: { mentionedJid: ['99887766@lid'] } } },
        { messageTimestamp: now },
      ),
      wa(
        { id: 'G2', remoteJid: '120363@g.us', participant: '5551@lid' },
        { conversation: 'chatter' },
        { messageTimestamp: now },
      ),
    ],
  })
  // History replayed from before the connection is not new work.
  sock.emit('messages.upsert', {
    type: 'append',
    messages: [
      wa(
        { id: 'OLD', remoteJid: '1@s.whatsapp.net' },
        { conversation: 'old' },
        { messageTimestamp: now - 3600 },
      ),
    ],
  })
  await until(() => received.length === 2)
  expect(received.find((m) => m.messageId === 'G1')).toMatchObject({
    chat: { id: '120363@g.us', kind: 'group', title: 'The crew' },
    text: 'hi',
    mentioned: true,
  })
  expect(received.find((m) => m.messageId === 'G2')?.mentioned).toBe(false)
  await until(() => sock.reads.length === 1)
  expect(sock.reads).toMatchObject([{ id: 'G1' }])

  const ref = await adapter.send('1@s.whatsapp.net', { text: '**Done**' })
  expect(ref).toEqual({ chat: '1@s.whatsapp.net', id: 'OUT1' })
  await adapter.edit(ref, { text: 'Done · 2s' })
  expect(sock.sent.at(-1)).toEqual([
    '1@s.whatsapp.net',
    { text: 'Done · 2s', edit: { remoteJid: '1@s.whatsapp.net', id: 'OUT1', fromMe: true } },
  ])
  await adapter.typing('1@s.whatsapp.net')
  await adapter.typing('1@s.whatsapp.net')
  expect(sock.presence).toEqual([['composing', '1@s.whatsapp.net']])
  await adapter.sendFile('1@s.whatsapp.net', {
    name: 'a.png',
    mimeType: 'image/png',
    data: new Uint8Array([1]),
  })
  expect(sock.sent.at(-1)?.[1]).toMatchObject({ image: Buffer.from([1]), mimetype: 'image/png' })
  await adapter.sendFile('1@s.whatsapp.net', {
    name: 'a.pdf',
    mimeType: 'application/pdf',
    data: new Uint8Array([1]),
  })
  expect(sock.sent.at(-1)?.[1]).toMatchObject({ document: Buffer.from([1]), fileName: 'a.pdf' })

  // A network drop is retried; the phone removing the device ends it, with the session cleared.
  sock.close(428)
  await until(() => statuses.at(-1)?.state === 'retrying')
  expect(existsSync(join(dir, 'auth', 'creds.json'))).toBe(true)
  await until(() => fake.sockets.length === 3, 5000)
  ;(fake.sockets[2] as FakeSock).close(401)
  await until(() => statuses.at(-1)?.state === 'error')
  expect(statuses.at(-1)).toEqual({ state: 'error', error: channelCopy.whatsapp.loggedOut })
  expect(existsSync(join(dir, 'auth'))).toBe(false)
  await expect(adapter.send('1@s.whatsapp.net', { text: 'x' })).rejects.toThrow(channelCopy.whatsapp.offline)
})

test("reconnects follow OpenClaw's backoff: 2 s, ×1.8, up to 30 s, with at most 25% jitter", () => {
  expect(backoffMs(1, () => 0)).toBe(2000)
  expect(backoffMs(1, () => 1)).toBe(2500)
  expect(backoffMs(2, () => 0)).toBe(3600)
  expect(backoffMs(3, () => 0)).toBe(6480)
  expect(backoffMs(20, () => 1)).toBe(30_000)
})

test('the linked device needs no settings, and its setup warns about bans', () => {
  const kind = BUILT_IN_CHANNELS.whatsapp
  expect(kind?.fields).toEqual([])
  expect(kind?.setup).toContain('spare number')
  expect(kind?.setup).toContain('never message people first')
  expect(kind?.setup).toContain('bulk')
  const adapter = kind?.make({})
  expect(adapter?.can).toEqual({ buttons: false, files: true, edit: true })
  expect(BUILT_IN_CHANNELS['whatsapp-cloud']?.fields.filter((f) => f.secret).map((f) => f.key)).toEqual([
    'token',
    'appSecret',
  ])
})

// ── The Cloud API ───────────────────────────────────────────────────────────────────────────────────────────────

type GraphCall = {
  method: string
  path: string
  auth: string
  json?: Record<string, unknown>
  form?: FormData
}

/** A stand-in for the Graph API: answers by path, records every call. */
function graphApi(handler: (call: GraphCall) => unknown = () => ({ messages: [{ id: 'wamid.OUT' }] })) {
  const calls: GraphCall[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const type = req.headers.get('content-type') ?? ''
      const call: GraphCall = {
        method: req.method,
        path: url.pathname + url.search,
        auth: req.headers.get('authorization') ?? '',
        ...(type.includes('json') ? { json: (await req.json()) as Record<string, unknown> } : {}),
        ...(type.includes('multipart') ? { form: await req.formData() } : {}),
      }
      calls.push(call)
      if (url.pathname === '/media-bytes/MEDIA1') return new Response(new Uint8Array([1, 2, 3]))
      const answer = handler(call)
      if (answer instanceof Response) return answer
      return Response.json(answer)
    },
  })
  return { server, calls, api: `http://127.0.0.1:${server.port}` }
}

const SETTINGS = {
  phoneNumberId: '1061',
  token: 'EAA-TOKEN',
  appSecret: 'app-secret',
  verifyToken: 'verify-me',
}

function cloud(handler?: (call: GraphCall) => unknown) {
  const graph = graphApi(handler)
  servers.push(graph.server)
  const adapter = new WhatsAppCloudAdapter(SETTINGS, graph.api)
  adapters.push(adapter)
  return { ...graph, adapter }
}

const sign = (body: string, secret = SETTINGS.appSecret) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

const delivery = (messages: unknown[], phoneNumberId = SETTINGS.phoneNumberId) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId },
              contacts: [{ wa_id: '447700900123', profile: { name: 'Alice' } }],
              messages,
            },
          },
        ],
      },
    ],
  })

const post = (adapter: WhatsAppCloudAdapter, body: string, signature?: string) =>
  adapter.webhook(
    new Request('https://box/hooks/channels/whatsapp-cloud', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature ? { 'x-hub-signature-256': signature } : {}),
      },
      body,
    }),
  )

test("webhook verification: Meta's challenge echoed for the right verify token, refused otherwise", async () => {
  const { adapter } = cloud()
  const get = (q: string) => adapter.webhook(new Request(`https://box/hooks/channels/whatsapp-cloud?${q}`))
  const ok = await get('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444')
  expect(ok.status).toBe(200)
  expect(await ok.text()).toBe('1158201444')
  expect((await get('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status).toBe(403)
  expect((await get('hub.mode=subscribe&hub.verify_token=verify-mf&hub.challenge=1')).status).toBe(403)
  expect((await get('hub.mode=unsubscribe&hub.verify_token=verify-me&hub.challenge=1')).status).toBe(400)
})

test('deliveries must be signed with the app secret; signed ones become messages, buttons presses, files', async () => {
  const { adapter, calls, api } = cloud((call) =>
    call.path === '/v21.0/MEDIA1'
      ? { url: `${api}/media-bytes/MEDIA1`, mime_type: 'image/jpeg' }
      : { success: true },
  )
  const { handle, received } = io({ webhookUrl: 'https://box/hooks/channels/whatsapp-cloud' })
  await adapter.start(handle)
  const text = {
    from: '447700900123',
    id: 'wamid.T1',
    timestamp: '1700000000',
    type: 'text',
    text: { body: 'hi **there**' },
  }
  const body = delivery([text])

  // Unsigned, wrongly signed, or signed over other bytes: refused before anything is read.
  expect((await post(adapter, body)).status).toBe(401)
  expect((await post(adapter, body, sign(body, 'other-secret'))).status).toBe(401)
  expect((await post(adapter, body, sign(`${body} `))).status).toBe(401)
  expect(received).toEqual([])

  expect((await post(adapter, body, sign(body))).status).toBe(200)
  expect(received[0]).toMatchObject({
    messageId: 'wamid.T1',
    chat: { id: '447700900123', kind: 'dm' },
    sender: { id: '447700900123', name: 'Alice', handle: '+447700900123' },
    text: 'hi **there**',
    mentioned: true,
    time: new Date(1_700_000_000_000).toISOString(),
  })

  // Another number on the same Meta app: answered 200 (or Meta retries), but not taken.
  const foreign = delivery([{ ...text, id: 'wamid.X' }], '9999')
  expect((await post(adapter, foreign, sign(foreign))).status).toBe(200)
  expect(received).toHaveLength(1)

  const more = delivery([
    {
      from: '447700900123',
      id: 'wamid.B1',
      type: 'interactive',
      context: { from: '15550001111', id: 'wamid.ASK' },
      interactive: { type: 'button_reply', button_reply: { id: 'a:o:K1', title: 'Allow once' } },
    },
    {
      from: '447700900123',
      id: 'wamid.I1',
      type: 'image',
      image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'look' },
    },
    {
      from: '447700900123',
      id: 'wamid.A1',
      type: 'audio',
      audio: { id: 'MEDIA2', mime_type: 'audio/ogg; codecs=opus', voice: true },
    },
    { from: '447700900123', id: 'wamid.R1', type: 'reaction', reaction: { emoji: '👍' } },
    { from: '447700900123', id: 'wamid.S1', type: 'sticker', sticker: { id: 'MEDIA3' } },
    { from: '120363', id: 'wamid.G1', type: 'text', text: { body: 'group' }, chat: { id: 'g' } },
  ])
  expect((await post(adapter, more, sign(more))).status).toBe(200)
  const [press, image, voice, sticker] = received.slice(1)
  expect(received).toHaveLength(5)
  expect(press).toMatchObject({
    messageId: 'wamid.B1',
    text: '',
    press: { id: 'wamid.B1', data: 'a:o:K1', message: { chat: '447700900123', id: 'wamid.ASK' } },
  })
  expect(image).toMatchObject({ text: 'look', files: [{ kind: 'image', mimeType: 'image/jpeg' }] })
  expect(voice?.files?.[0]).toMatchObject({ kind: 'voice', mimeType: 'audio/ogg' })
  expect(sticker).toMatchObject({ unsupported: true })

  // The file is fetched by id, then from the address Meta gives, both with the token.
  expect(await image?.files?.[0]?.read()).toEqual(new Uint8Array([1, 2, 3]))
  expect(calls.filter((c) => c.path.includes('MEDIA1')).map((c) => [c.path, c.auth])).toEqual([
    ['/v21.0/MEDIA1', 'Bearer EAA-TOKEN'],
    ['/media-bytes/MEDIA1', 'Bearer EAA-TOKEN'],
  ])

  // Typing marks the chat's last message read, renewed sparingly.
  await adapter.typing('447700900123')
  await adapter.typing('447700900123')
  const typing = calls.filter((c) => c.json?.typing_indicator)
  expect(typing).toHaveLength(1)
  expect(typing[0]?.json).toMatchObject({ status: 'read', message_id: 'wamid.S1' })
})

test('sending: Markdown as WhatsApp text, buttons as reply buttons or a list, long bodies split', async () => {
  const { adapter, calls } = cloud()
  const ref = await adapter.send('447700900123', { text: '**Done**' })
  expect(ref).toEqual({ chat: '447700900123', id: 'wamid.OUT' })
  expect(calls.at(-1)).toMatchObject({
    method: 'POST',
    path: '/v21.0/1061/messages',
    auth: 'Bearer EAA-TOKEN',
    json: { messaging_product: 'whatsapp', to: '447700900123', type: 'text', text: { body: '*Done*' } },
  })

  // The hub's approval: three rows of one button each, titles cut to Meta's 20 characters.
  await adapter.send('447700900123', {
    text: 'May I?',
    buttons: [
      [{ label: 'Allow once', data: 'a:o:K' }],
      [{ label: 'Always allow shell_command', data: 'a:a:K' }],
      [{ label: 'Deny', data: 'a:d:K' }],
    ],
  })
  expect(calls.at(-1)?.json).toMatchObject({
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'May I?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'a:o:K', title: 'Allow once' } },
          { type: 'reply', reply: { id: 'a:a:K', title: 'Always allow shell_…' } },
          { type: 'reply', reply: { id: 'a:d:K', title: 'Deny' } },
        ],
      },
    },
  })

  // More than three options: a list.
  const options = ['Red', 'Green', 'Blue', 'A much longer option than a list row can show'].map(
    (label, i) => [{ label, data: `q:k:0:${i}` }],
  )
  await adapter.send('447700900123', { text: 'Which?', buttons: options })
  const list = calls.at(-1)?.json?.interactive as {
    type: string
    action: { button: string; sections: { rows: unknown[] }[] }
  }
  expect(list.type).toBe('list')
  expect(list.action.button).toBe(channelCopy.whatsappCloud.choose)
  expect(list.action.sections[0]?.rows[3]).toEqual({
    id: 'q:k:0:3',
    title: 'A much longer option th…',
    description: 'A much longer option than a list row can show',
  })

  // A body over Meta's 1024 characters: all but its last line goes first, the buttons with the last.
  const before = calls.length
  await adapter.send('447700900123', {
    text: `${'x'.repeat(1100)}\nLast line`,
    buttons: [[{ label: 'Ok', data: 'a:o:Z' }]],
  })
  const [first, second] = calls.slice(before)
  expect(first?.json).toMatchObject({ type: 'text', text: { body: 'x'.repeat(1100) } })
  expect(second?.json).toMatchObject({ type: 'interactive', interactive: { body: { text: 'Last line' } } })

  // No edits on the Cloud API.
  expect(adapter.can.edit).toBe(false)
  await expect(adapter.edit(ref, { text: 'x' })).rejects.toThrow(channelCopy.whatsappCloud.noEdit)

  // A press's note comes as a reply to it.
  await adapter.answerPress(
    { id: 'wamid.B1', data: 'a:o:K', message: { chat: '447700900123', id: 'wamid.ASK' } },
    'Allowed',
  )
  expect(calls.at(-1)?.json).toMatchObject({
    type: 'text',
    text: { body: 'Allowed' },
    context: { message_id: 'wamid.B1' },
  })
})

test('files go up to /media first, then as an image or a document', async () => {
  const { adapter, calls } = cloud((call) =>
    call.path.endsWith('/media') ? { id: 'UP1' } : { messages: [{ id: 'wamid.F' }] },
  )
  await adapter.sendFile('447700900123', {
    name: 'chart.png',
    mimeType: 'image/png',
    data: new Uint8Array([1]),
    caption: 'Q3',
  })
  const upload = calls.at(-2)
  expect(upload?.path).toBe('/v21.0/1061/media')
  expect(upload?.auth).toBe('Bearer EAA-TOKEN')
  expect(upload?.form?.get('messaging_product')).toBe('whatsapp')
  expect(upload?.form?.get('type')).toBe('image/png')
  expect((upload?.form?.get('file') as File | undefined)?.name).toBe('chart.png')
  expect(calls.at(-1)?.json).toMatchObject({ type: 'image', image: { id: 'UP1', caption: 'Q3' } })

  await adapter.sendFile('447700900123', {
    name: 'plan.pdf',
    mimeType: 'application/pdf',
    data: new Uint8Array([1]),
  })
  expect(calls.at(-1)?.json).toMatchObject({
    type: 'document',
    document: { id: 'UP1', filename: 'plan.pdf' },
  })
})

test('check names the number; a refused token, an unknown id and a missing public address are errors', async () => {
  const { adapter } = cloud((call) =>
    call.path.startsWith('/v21.0/1061?')
      ? { display_phone_number: '+1 555 000 1111', verified_name: 'Acme' }
      : {},
  )
  expect(await adapter.check()).toBe('Acme · +1 555 000 1111')

  const refused = cloud(() =>
    Response.json({ error: { message: 'Invalid OAuth access token', code: 190 } }, { status: 401 }),
  )
  await expect(refused.adapter.check()).rejects.toThrow(channelCopy.whatsappCloud.refused)
  const unknown = cloud(() =>
    Response.json({ error: { message: 'Unsupported get request', code: 100 } }, { status: 400 }),
  )
  await expect(unknown.adapter.check()).rejects.toThrow(channelCopy.whatsappCloud.noNumber)

  // Out of the 24-hour window, the reason says so.
  const late = cloud(() =>
    Response.json({ error: { message: 'Re-engagement message', code: 131047 } }, { status: 400 }),
  )
  await expect(late.adapter.send('447700900123', { text: 'hello?' })).rejects.toThrow(
    channelCopy.whatsappCloud.window,
  )

  const { handle, statuses } = io()
  await adapter.start(handle)
  expect(statuses).toEqual([{ state: 'error', error: channelCopy.whatsappCloud.needsPublic }])

  const online = io({ webhookUrl: 'https://box/hooks/channels/whatsapp-cloud' })
  await adapter.start(online.handle)
  await until(() => online.statuses.some((s) => s.state === 'on'))
  expect(online.statuses.at(-1)).toEqual({ state: 'on', account: 'Acme · +1 555 000 1111' })
})
