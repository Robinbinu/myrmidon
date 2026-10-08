import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { channelCopy } from '../src/channels/copy.ts'
import {
  type AdapterIO,
  type AdapterStatus,
  type Inbound,
  SmsAdapter,
  twilioSignature,
} from '../src/channels/index.ts'

const SID = 'AC0123'
const TOKEN = 'auth-token'
const NUMBER = '+15550001111'
const HOOK = 'https://box.example.ts.net/hooks/channels/sms'
const AUTH = `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`

type Call = { method: string; path: string; form: URLSearchParams; auth: string }

/** A stand-in for Twilio's REST API: one number, the Messages API, and one MMS picture. */
function twilio(options: { smsUrl?: string } = {}) {
  const calls: Call[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const auth = req.headers.get('authorization') ?? ''
      const form = new URLSearchParams(await req.text())
      calls.push({ method: req.method, path: url.pathname + url.search, form, auth })
      if (auth !== AUTH) return Response.json({ code: 20003, message: 'Authenticate' }, { status: 401 })
      const base = `/2010-04-01/Accounts/${SID}`
      if (url.pathname === `${base}/IncomingPhoneNumbers.json`)
        return Response.json({
          incoming_phone_numbers:
            url.searchParams.get('PhoneNumber') === NUMBER
              ? [{ sid: 'PN1', phone_number: NUMBER, sms_url: options.smsUrl ?? '' }]
              : [],
        })
      if (url.pathname === `${base}/IncomingPhoneNumbers/PN1.json`) return Response.json({ sid: 'PN1' })
      if (url.pathname === `${base}/Messages.json`) return Response.json({ sid: `SM${calls.length}` })
      if (url.pathname === `${base}/Messages/MM1/Media/ME1`) return new Response(new Uint8Array([1, 2, 3]))
      return Response.json({ message: 'not found' }, { status: 404 })
    },
  })
  return { server, calls, api: `http://127.0.0.1:${server.port}` }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: SmsAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function io(webhookUrl?: string) {
  const received: Inbound[] = []
  const statuses: AdapterStatus[] = []
  const logs: string[] = []
  const kv = new Map<string, string>()
  const handle: AdapterIO = {
    receive: async (m) => {
      received.push(m)
    },
    get: (k) => kv.get(k),
    set: (k, v) => kv.set(k, v),
    status: (s) => statuses.push(s),
    log: (m) => logs.push(m),
    dir: tmpdir(),
    ...(webhookUrl ? { webhookUrl } : {}),
  }
  return { handle, received, statuses, logs }
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

/** A post as Twilio makes it: form-encoded, signed with the auth token over the public URL. */
function post(params: Record<string, string>, sign: { url?: string; token?: string; header?: string } = {}) {
  const form = new URLSearchParams(params)
  const signature = sign.header ?? twilioSignature(sign.token ?? TOKEN, sign.url ?? HOOK, form)
  return new Request('http://127.0.0.1/hooks/channels/sms', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    body: form.toString(),
  })
}

test("the signature matches Twilio's documented example", () => {
  // From Twilio's "Validating requests" guide.
  const params = new URLSearchParams({
    CallSid: 'CA1234567890ABCDE',
    Caller: '+12349013030',
    Digits: '1234',
    From: '+12349013030',
    To: '+18005551212',
  })
  expect(twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', params)).toBe(
    '0/KCTR6DLpKmkAf8muzZqo1nDgQ=',
  )
})

test('check() names the number; refused credentials and a number not on the account are errors', async () => {
  const { server, api } = twilio()
  servers.push(server)
  expect(await new SmsAdapter(SID, TOKEN, '+1 (555) 000-1111', api).check()).toBe(NUMBER)
  await expect(new SmsAdapter(SID, 'wrong', NUMBER, api).check()).rejects.toThrow(channelCopy.errors.smsToken)
  await expect(new SmsAdapter(SID, TOKEN, '+15559999999', api).check()).rejects.toThrow('not a number')
})

test('without a public address it says why and does nothing; refused credentials stop it', async () => {
  const { server, api, calls } = twilio()
  servers.push(server)
  const a = new SmsAdapter(SID, TOKEN, NUMBER, api)
  adapters.push(a)
  const first = io()
  await a.start(first.handle)
  expect(first.statuses).toEqual([{ state: 'error', error: channelCopy.errors.smsPublic }])
  expect(calls).toHaveLength(0)

  const b = new SmsAdapter(SID, 'wrong', NUMBER, api)
  adapters.push(b)
  const second = io(HOOK)
  await b.start(second.handle)
  await until(() => second.statuses.some((s) => s.state === 'error'))
  expect(second.statuses.at(-1)).toEqual({ state: 'error', error: channelCopy.errors.smsToken })
})

test('on start the number is pointed at the gateway; signed texts come in, forged ones are refused', async () => {
  const { server, api, calls } = twilio({ smsUrl: 'https://old.example/sms' })
  servers.push(server)
  const adapter = new SmsAdapter(SID, TOKEN, NUMBER, api)
  adapters.push(adapter)
  const { handle, received, statuses, logs } = io(HOOK)
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(statuses.at(-1)).toEqual({ state: 'on', account: NUMBER })
  const pointed = calls.find((c) => c.path.endsWith('/IncomingPhoneNumbers/PN1.json'))
  expect(pointed?.form.get('SmsUrl')).toBe(HOOK)
  expect(pointed?.form.get('SmsMethod')).toBe('POST')
  expect(logs.join()).toContain('https://old.example/sms')

  const text = { AccountSid: SID, MessageSid: 'SM100', From: '+15552223333', To: NUMBER, Body: 'hello there' }
  // Unsigned, signed with another token, signed for another URL, or from another account: all refused.
  expect((await adapter.webhook(post(text, { header: '' }))).status).toBe(403)
  expect((await adapter.webhook(post(text, { token: 'other' }))).status).toBe(403)
  expect((await adapter.webhook(post(text, { url: 'https://evil.example/x' }))).status).toBe(403)
  expect((await adapter.webhook(post({ ...text, AccountSid: 'ACother' }))).status).toBe(403)
  // Tampering with a signed body breaks the signature.
  const signed = post(text)
  const tampered = new Request(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body: new URLSearchParams({ ...text, Body: 'rm -rf' }).toString(),
  })
  expect((await adapter.webhook(tampered)).status).toBe(403)
  expect(received).toHaveLength(0)

  const ok = await adapter.webhook(post(text))
  expect(ok.status).toBe(200)
  expect(ok.headers.get('content-type')).toBe('text/xml')
  expect(await ok.text()).toContain('<Response></Response>')
  // Twilio may sign the URL with the default port written out.
  expect(
    (
      await adapter.webhook(
        post({ ...text, MessageSid: 'SM101' }, { url: HOOK.replace('.net/', '.net:443/') }),
      )
    ).status,
  ).toBe(200)
  expect(received.map((m) => m.text)).toEqual(['hello there', 'hello there'])
  expect(received[0]).toMatchObject({
    messageId: 'SM100',
    chat: { id: '+15552223333', kind: 'dm' },
    sender: { id: '+15552223333' },
    mentioned: true,
  })

  // Opt-out words and our own number never reach the crew.
  await adapter.webhook(post({ ...text, MessageSid: 'SM102', Body: 'STOP' }))
  await adapter.webhook(post({ ...text, MessageSid: 'SM103', From: NUMBER }))
  expect(received).toHaveLength(2)
})

test('MMS pictures are read from Twilio with the account credentials; other URLs are dropped', async () => {
  const { server, api, calls } = twilio({ smsUrl: HOOK })
  servers.push(server)
  const adapter = new SmsAdapter(SID, TOKEN, NUMBER, api)
  adapters.push(adapter)
  const { handle, received, statuses } = io(HOOK)
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  // Already pointed here: nothing changed on the number.
  expect(calls.some((c) => c.path.endsWith('/PN1.json'))).toBe(false)
  await adapter.webhook(
    post({
      AccountSid: SID,
      MessageSid: 'MM1',
      From: '+15552223333',
      Body: '',
      NumMedia: '2',
      MediaUrl0: `${api}/2010-04-01/Accounts/${SID}/Messages/MM1/Media/ME1`,
      MediaContentType0: 'image/jpeg',
      MediaUrl1: 'http://169.254.169.254/latest/meta-data',
      MediaContentType1: 'image/png',
    }),
  )
  const files = received[0]?.files ?? []
  expect(files).toHaveLength(1)
  expect(files[0]).toMatchObject({ kind: 'image', name: 'mms-1.jpg', mimeType: 'image/jpeg' })
  expect([...((await files[0]?.read()) ?? [])]).toEqual([1, 2, 3])
  expect(calls.at(-1)?.auth).toBe(AUTH)
})

test('replies go out as plain text through the Messages API; edits send nothing', async () => {
  const { server, api, calls } = twilio()
  servers.push(server)
  const adapter = new SmsAdapter(SID, TOKEN, NUMBER, api)
  const ref = await adapter.send(
    { id: '+15552223333', kind: 'dm' },
    { text: '**Done**: see [the report](https://x.example/r)' },
  )
  expect(ref.chat).toBe('+15552223333')
  expect(ref.id).toMatch(/^SM/)
  const sent = calls.at(-1)
  expect(sent?.path).toBe(`/2010-04-01/Accounts/${SID}/Messages.json`)
  expect(Object.fromEntries(sent?.form ?? [])).toEqual({
    From: NUMBER,
    To: '+15552223333',
    Body: 'Done: see the report (https://x.example/r)',
  })
  const before = calls.length
  await adapter.edit(ref, { text: 'changed' })
  expect(calls.length).toBe(before)
  expect(adapter.can).toEqual({ buttons: false, files: false, edit: false })
  expect(adapter.limits.text).toBe(1600)
})
