import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import {
  type AdapterIO,
  type AdapterStatus,
  type Inbound,
  WeComAdapter,
  WeComCrypto,
} from '../src/channels/index.ts'

type Call = { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> }

/** A stand-in for qyapi.weixin.qq.com. */
function wecomApi(handlers: Record<string, (call: Call, n: number) => unknown>) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const multipart = req.headers.get('content-type')?.includes('multipart')
      const body = multipart
        ? Object.fromEntries([...(await req.formData()).keys()].map((k) => [k, true]))
        : ((await req.json().catch(() => ({}))) as Record<string, unknown>)
      const call = { method: req.method, path: url.pathname, query: url.searchParams, body }
      calls.push(call)
      const n = (counts.get(url.pathname) ?? 0) + 1
      counts.set(url.pathname, n)
      const handler = handlers[url.pathname]
      const answer = handler ? handler(call, n) : { errcode: 0, errmsg: 'ok' }
      return answer instanceof Response ? answer : Response.json(answer)
    },
  })
  return { server, calls, api: `http://127.0.0.1:${server.port}` }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: WeComAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function io() {
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

// Tencent's published sample for the callback crypto (WXBizMsgCrypt's URL verification example).
const SAMPLE = {
  token: 'QDG6eK',
  corpId: 'wx5823bf96d3bd56c7',
  aesKey: 'jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C',
}
const config = { ...SAMPLE, agentId: '1000002', secret: 'corp-secret' }
const TOKEN = { access_token: 'wt-1', expires_in: 7200, errcode: 0 }
const base = {
  '/cgi-bin/gettoken': () => TOKEN,
  '/cgi-bin/agent/get': () => ({ errcode: 0, name: 'Myr App' }),
  '/cgi-bin/user/get': () => ({ errcode: 0, name: 'Alice Wang' }),
}

test('the crypto matches Tencent’s sample, and round-trips', () => {
  const c = new WeComCrypto(SAMPLE.token, SAMPLE.aesKey, SAMPLE.corpId)
  expect(
    c.decrypt(
      '5c45ff5e21c57e6ad56bac8758b79b1d9ac89fd3',
      '1409659589',
      '263014780',
      'P9nAzCzyDtyTWESHep1vC5X9xho/qYX3Zpb4yKa9SKld1DsH3Iyt3tP3zNdtp+4RPcs8TgAE7OaBO+FZXvnaqQ==',
    ),
  ).toBe('1616140317555161061')
  const sealed = c.encrypt('<xml>你好</xml>')
  expect(c.decrypt(c.signature('1', '2', sealed), '1', '2', sealed)).toBe('<xml>你好</xml>')
  // A wrong signature, or a message for another corp, is refused.
  expect(c.decrypt('0'.repeat(40), '1', '2', sealed)).toBeUndefined()
  const other = new WeComCrypto(SAMPLE.token, SAMPLE.aesKey, 'ww-other')
  const theirs = other.encrypt('<xml/>')
  expect(c.decrypt(c.signature('1', '2', theirs), '1', '2', theirs)).toBeUndefined()
})

test('check() names the app; refused credentials and a bad EncodingAESKey say so', async () => {
  const ok = wecomApi(base)
  servers.push(ok.server)
  expect(await new WeComAdapter(config, ok.api).check()).toBe('Myr App')
  expect(ok.calls[0]?.query.get('corpsecret')).toBe('corp-secret')

  const refused = wecomApi({ '/cgi-bin/gettoken': () => ({ errcode: 40001, errmsg: 'invalid credential' }) })
  servers.push(refused.server)
  await expect(new WeComAdapter(config, refused.api).check()).rejects.toThrow('refused this corp ID')
  await expect(new WeComAdapter({ ...config, aesKey: 'short' }, ok.api).check()).rejects.toThrow(
    '43 characters',
  )

  // Without a public address it cannot receive anything, and says how to fix that.
  const a = new WeComAdapter(config, ok.api)
  adapters.push(a)
  const { handle, statuses } = io()
  await a.start(handle)
  await until(() => statuses.some((s) => s.state === 'error'))
  expect(statuses.at(-1)).toMatchObject({ error: expect.stringContaining('--public-url') })
})

test('the callback: URL check and messages accepted only when signed and for this corp', async () => {
  const w = wecomApi(base)
  servers.push(w.server)
  const adapter = new WeComAdapter(config, w.api)
  adapters.push(adapter)
  const { handle, received, statuses } = io()
  await adapter.start({ ...handle, webhookUrl: 'https://box.example/hooks/channels/wecom' })
  await until(() => statuses.some((s) => s.state === 'on'))
  const c = new WeComCrypto(SAMPLE.token, SAMPLE.aesKey, SAMPLE.corpId)

  const echo = c.encrypt('echo-123')
  const verify = (sig: string) =>
    adapter.webhook(
      new Request(
        `https://box/hooks?msg_signature=${sig}&timestamp=1&nonce=2&echostr=${encodeURIComponent(echo)}`,
      ),
    )
  expect(await (await verify(c.signature('1', '2', echo))).text()).toBe('echo-123')
  expect((await verify('bad')).status).toBe(403)

  const post = (inner: string, crypto = c, sig?: string) => {
    const sealed = crypto.encrypt(inner)
    const s = sig ?? crypto.signature('10', 'n', sealed)
    return adapter.webhook(
      new Request(`https://box/hooks?msg_signature=${s}&timestamp=10&nonce=n`, {
        method: 'POST',
        body: `<xml><ToUserName><![CDATA[${SAMPLE.corpId}]]></ToUserName><Encrypt><![CDATA[${sealed}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>`,
      }),
    )
  }
  const text = `<xml><ToUserName><![CDATA[${SAMPLE.corpId}]]></ToUserName><FromUserName><![CDATA[alice]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello there]]></Content><MsgId>777</MsgId><AgentID>1000002</AgentID></xml>`
  expect((await post(text, c, 'f'.repeat(40))).status).toBe(403)
  expect((await post(text, new WeComCrypto(SAMPLE.token, SAMPLE.aesKey, 'ww-other'))).status).toBe(403)
  const ok = await post(text)
  expect(await ok.text()).toBe('success')
  expect(received[0]).toMatchObject({
    messageId: '777',
    chat: { id: 'alice', kind: 'dm' },
    sender: { id: 'alice', name: 'Alice Wang' },
    text: 'hello there',
    mentioned: true,
  })
  const image = `<xml><FromUserName><![CDATA[alice]]></FromUserName><CreateTime>1700000001</CreateTime><MsgType><![CDATA[image]]></MsgType><PicUrl><![CDATA[http://x]]></PicUrl><MediaId><![CDATA[media-1]]></MediaId><MsgId>778</MsgId></xml>`
  await post(image)
  expect(received[1]?.files?.[0]).toMatchObject({ kind: 'image' })
  // Entering the app is an event, not a message.
  await post(
    `<xml><FromUserName>alice</FromUserName><MsgType>event</MsgType><Event>enter_agent</Event></xml>`,
  )
  expect(received).toHaveLength(2)
})

test('sending: plain text under 2048 bytes a piece, a stale token renewed once, files uploaded first', async () => {
  let refuse = true
  const w = wecomApi({
    ...base,
    '/cgi-bin/message/send': () => {
      if (refuse) {
        refuse = false
        return { errcode: 42001, errmsg: 'access_token expired' }
      }
      return { errcode: 0, msgid: 'mid-1' }
    },
    '/cgi-bin/media/upload': () => ({ errcode: 0, media_id: 'm-9' }),
  })
  servers.push(w.server)
  const adapter = new WeComAdapter(config, w.api)
  const ref = await adapter.send('alice', { text: '**Done**: see [the report](https://example.com/r)' })
  expect(ref).toEqual({ chat: 'alice', id: 'mid-1' })
  const sends = w.calls.filter((c) => c.path === '/cgi-bin/message/send')
  expect(sends).toHaveLength(2)
  expect(w.calls.filter((c) => c.path === '/cgi-bin/gettoken')).toHaveLength(2)
  expect(sends[1]?.body).toMatchObject({
    touser: 'alice',
    msgtype: 'text',
    agentid: 1000002,
    text: { content: 'Done: see the report (https://example.com/r)' },
  })

  await adapter.send('alice', { text: '长'.repeat(1500) })
  const pieces = w.calls
    .filter((c) => c.path === '/cgi-bin/message/send')
    .slice(2)
    .map((c) => String((c.body.text as { content: string }).content))
  expect(pieces.length).toBe(3)
  for (const p of pieces) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(2048)
  expect(pieces.join('')).toBe('长'.repeat(1500))

  await adapter.sendFile('alice', { name: 'a.png', mimeType: 'image/png', data: new Uint8Array([1]) })
  const upload = w.calls.find((c) => c.path === '/cgi-bin/media/upload')
  expect(upload?.query.get('type')).toBe('image')
  expect(upload?.body).toEqual({ media: true })
  expect(w.calls.at(-1)?.body).toMatchObject({ msgtype: 'image', image: { media_id: 'm-9' } })
  await expect(adapter.edit()).rejects.toThrow('cannot edit')
})
