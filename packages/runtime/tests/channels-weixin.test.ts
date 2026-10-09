import { afterEach, expect, test } from 'bun:test'
import { createCipheriv } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AdapterIO, type AdapterStatus, type Inbound, WeixinAdapter } from '../src/channels/index.ts'

type Call = { path: string; body: Record<string, unknown>; headers: Headers }

/** A stand-in for iLink (and its CDN, on the same server). */
function ilink(handlers: Record<string, (call: Call, n: number) => unknown>) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      const call = { path: url.pathname, body, headers: req.headers }
      calls.push(call)
      const n = (counts.get(url.pathname) ?? 0) + 1
      counts.set(url.pathname, n)
      const handler = handlers[url.pathname]
      const answer = handler ? await handler(call, n) : { ret: 0 }
      return answer instanceof Response ? answer : Response.json(answer)
    },
  })
  return { server, calls, api: `http://127.0.0.1:${server.port}` }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: WeixinAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function io(dir = mkdtempSync(join(tmpdir(), 'weixin-'))) {
  const received: Inbound[] = []
  const statuses: AdapterStatus[] = []
  const kv = new Map<string, string>()
  const handle: AdapterIO = {
    receive: async (m) => {
      received.push(m)
    },
    get: (k) => kv.get(k),
    set: (k, v) => kv.set(k, v),
    status: (s) => statuses.push(s),
    log: () => {},
    dir,
  }
  return { handle, received, statuses, kv, dir }
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

const idle = () => Bun.sleep(50).then(() => ({ ret: 0, msgs: [], get_updates_buf: 'buf-2' }))
const linked = (api: string) => {
  const ctx = io()
  writeFileSync(
    join(ctx.dir, 'account.json'),
    JSON.stringify({ accountId: 'bot@im.bot', token: 'tok', baseUrl: api }),
  )
  return ctx
}

test('linking by QR code: the code shown, then the account saved privately and messages polled', async () => {
  const w = ilink({
    '/ilink/bot/get_bot_qrcode': () => ({
      qrcode: 'qr-1',
      qrcode_img_content: 'https://liteapp.weixin.qq.com/q/1',
    }),
    '/ilink/bot/get_qrcode_status': (_c, n) =>
      n === 1
        ? { status: 'scaned' }
        : {
            status: 'confirmed',
            ilink_bot_id: 'bot@im.bot',
            bot_token: 'tok',
            baseurl: `http://127.0.0.1:${w.server.port}`,
            ilink_user_id: 'owner@im.wechat',
          },
    '/ilink/bot/getupdates': (_c, n) =>
      n === 1
        ? {
            ret: 0,
            get_updates_buf: 'buf-1',
            msgs: [
              {
                message_id: 11,
                from_user_id: 'alice@im.wechat',
                to_user_id: 'bot@im.bot',
                context_token: 'ctx-a',
                item_list: [{ type: 1, text_item: { text: 'hello' } }],
              },
              // The bot's own message, and the same text again under a new id, are dropped.
              {
                message_id: 12,
                from_user_id: 'bot@im.bot',
                item_list: [{ type: 1, text_item: { text: 'x' } }],
              },
              {
                message_id: 13,
                from_user_id: 'alice@im.wechat',
                item_list: [{ type: 1, text_item: { text: 'hello' } }],
              },
            ],
          }
        : idle(),
  })
  servers.push(w.server)
  const adapter = new WeixinAdapter(w.api, `${w.api}/c2c`)
  adapters.push(adapter)
  const { handle, received, statuses, kv, dir } = io()
  await adapter.start(handle)
  await until(() => received.length === 1)
  const linking = statuses.find((s) => s.state === 'linking')
  expect(linking).toMatchObject({ qr: 'https://liteapp.weixin.qq.com/q/1' })
  expect(linking?.state === 'linking' && linking.image.startsWith('data:image/png;base64,')).toBe(true)
  expect(statuses).toContainEqual({ state: 'on', account: 'bot@im.bot' })
  const file = join(dir, 'account.json')
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ accountId: 'bot@im.bot', token: 'tok' })
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(received[0]).toMatchObject({
    messageId: '11',
    chat: { id: 'alice@im.wechat', kind: 'dm' },
    text: 'hello',
    mentioned: true,
  })
  expect(kv.get('ctx:alice@im.wechat')).toBe('ctx-a')
  await until(() => kv.get('cursor') === 'buf-2')
  const poll = w.calls.find((c) => c.path === '/ilink/bot/getupdates')
  expect(poll?.headers.get('authorization')).toBe('Bearer tok')
  expect(poll?.headers.get('authorizationtype')).toBe('ilink_bot_token')
  expect(poll?.body).toMatchObject({ get_updates_buf: '', base_info: { channel_version: '2.2.0' } })
})

test('sending echoes the context token, retries once without it when the session is stale, and fails clearly after', async () => {
  let stale = 1
  const w = ilink({
    '/ilink/bot/getupdates': idle,
    '/ilink/bot/sendmessage': (c) => {
      const msg = c.body.msg as { context_token?: string }
      if (stale > 0 && msg.context_token) {
        stale--
        return { ret: -14, errmsg: 'session timeout' }
      }
      return stale < 0 ? { ret: -2, errmsg: 'prepare failed' } : { ret: 0 }
    },
  })
  servers.push(w.server)
  const adapter = new WeixinAdapter(w.api, `${w.api}/c2c`)
  adapters.push(adapter)
  const { handle, kv, statuses } = linked(w.api)
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  kv.set('ctx:alice', 'ctx-a')
  const ref = await adapter.send('alice', { text: 'Here is the answer.' })
  expect(ref.id).toStartWith('myrmidon-weixin-')
  const sends = w.calls.filter((c) => c.path === '/ilink/bot/sendmessage').map((c) => c.body.msg)
  expect(sends[0]).toMatchObject({
    to_user_id: 'alice',
    context_token: 'ctx-a',
    message_type: 2,
    item_list: [{ type: 1, text_item: { text: 'Here is the answer.' } }],
  })
  expect((sends[1] as Record<string, unknown>).context_token).toBeUndefined()

  stale = -1
  await expect(adapter.send('alice', { text: 'again' })).rejects.toThrow('messages the bot again')
  await expect(adapter.edit()).rejects.toThrow('cannot edit')
})

test('media in messages is fetched from the CDN and decrypted; media out is encrypted and uploaded', async () => {
  const key = Buffer.from('0123456789abcdef')
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const sealed = Buffer.concat([cipher.update(Buffer.from('a picture')), cipher.final()])
  const w = ilink({
    '/ilink/bot/getupdates': (_c, n) =>
      n === 1
        ? {
            ret: 0,
            msgs: [
              {
                message_id: 21,
                from_user_id: 'alice',
                item_list: [
                  {
                    type: 2,
                    image_item: { media: { encrypt_query_param: 'eqp', aes_key: key.toString('base64') } },
                  },
                ],
              },
            ],
          }
        : idle(),
    '/c2c/download': () => new Response(sealed),
    '/ilink/bot/getuploadurl': () => ({ ret: 0, upload_param: 'up-1' }),
    '/c2c/upload': () => new Response('', { headers: { 'x-encrypted-param': 'enc-1' } }),
  })
  servers.push(w.server)
  const adapter = new WeixinAdapter(w.api, `${w.api}/c2c`)
  adapters.push(adapter)
  const { handle, received } = linked(w.api)
  await adapter.start(handle)
  await until(() => received.length === 1)
  const file = received[0]?.files?.[0]
  expect(file).toMatchObject({ kind: 'image', mimeType: 'image/jpeg' })
  expect(Buffer.from((await file?.read()) ?? []).toString()).toBe('a picture')

  await adapter.sendFile('alice', {
    name: 'r.pdf',
    mimeType: 'application/pdf',
    data: new Uint8Array([1, 2, 3]),
  })
  const req = w.calls.find((c) => c.path === '/ilink/bot/getuploadurl')?.body
  expect(req).toMatchObject({
    media_type: 3,
    to_user_id: 'alice',
    rawsize: 3,
    filesize: 16,
    no_need_thumb: true,
  })
  const sent = w.calls.filter((c) => c.path === '/ilink/bot/sendmessage').at(-1)?.body.msg as {
    item_list: { type: number; file_item: { media: { encrypt_query_param: string; aes_key: string } } }[]
  }
  expect(sent.item_list[0]?.type).toBe(4)
  expect(sent.item_list[0]?.file_item.media.encrypt_query_param).toBe('enc-1')
  // The key goes as base64 of its hex form, and is the same one getuploadurl was given.
  expect(Buffer.from(sent.item_list[0]?.file_item.media.aes_key ?? '', 'base64').toString()).toBe(
    String(req?.aeskey),
  )
})
