import { afterEach, expect, test } from 'bun:test'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import type { ServerWebSocket } from 'bun'
import {
  type AdapterIO,
  type AdapterStatus,
  decodeFrame,
  encodeFrame,
  FeishuAdapter,
  type Inbound,
  type WsFrame,
} from '../src/channels/index.ts'

type Call = { method: string; path: string; body: Record<string, unknown>; form?: string[] }
type Handler = (call: Call, n: number) => unknown

/** A stand-in for the Open Platform: each `METHOD /path` answers from a handler; `/ws` is the long connection. */
function openPlatform(handlers: Record<string, Handler>, onOpen?: (ws: ServerWebSocket<unknown>) => void) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const frames: WsFrame[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/ws') return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
      const call: Call = { method: req.method, path: url.pathname, body: {} }
      if (req.headers.get('content-type')?.includes('multipart')) {
        const form = await req.formData()
        call.form = [...form.keys()]
      } else call.body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      calls.push(call)
      const key = `${req.method} ${url.pathname}`
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      const handler = handlers[key]
      const answer = handler ? handler(call, n) : { code: 0, data: {} }
      return answer instanceof Response ? answer : Response.json(answer)
    },
    websocket: {
      open: (ws) => onOpen?.(ws),
      message: (_ws, data) => {
        frames.push(decodeFrame(new Uint8Array(data as Buffer)))
      },
    },
  })
  return { server, calls, frames, api: `http://127.0.0.1:${server.port}` }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: FeishuAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function io() {
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

const TOKEN = { code: 0, tenant_access_token: 't-1', expire: 7200 }
const BOT = { code: 0, bot: { app_name: 'Myr', open_id: 'ou_bot' } }
const base: Record<string, Handler> = {
  'POST /open-apis/auth/v3/tenant_access_token/internal': () => TOKEN,
  'GET /open-apis/bot/v3/info': () => BOT,
  'GET /open-apis/contact/v3/users/ou_alice': () => ({ code: 0, data: { user: { name: 'Alice' } } }),
}
const config = { appId: 'cli_1', appSecret: 'secret' }

const message = (id: string, chat: string, type: 'p2p' | 'group', text: string, extra = {}) => ({
  schema: '2.0',
  header: { event_id: `ev-${id}`, event_type: 'im.message.receive_v1' },
  event: {
    sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
    message: {
      message_id: id,
      chat_id: chat,
      chat_type: type,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: '1700000000000',
      ...extra,
    },
  },
})

const dataFrame = (body: unknown, headers: Record<string, string> = {}, payload?: Uint8Array) =>
  encodeFrame({
    seqId: 1n,
    logId: 2n,
    service: 7,
    method: 1,
    headers: Object.entries({ type: 'event', message_id: 'm', sum: '1', seq: '0', ...headers }).map(
      ([key, value]) => ({ key, value }),
    ),
    payload: payload ?? new TextEncoder().encode(JSON.stringify(body)),
  })

test('check() names the bot; refused credentials say so', async () => {
  const ok = openPlatform(base)
  servers.push(ok.server)
  expect(await new FeishuAdapter(config, ok.api).check()).toBe('Myr')

  const refused = openPlatform({
    'POST /open-apis/auth/v3/tenant_access_token/internal': () => ({
      code: 10014,
      msg: 'app secret invalid',
    }),
  })
  servers.push(refused.server)
  await expect(new FeishuAdapter(config, refused.api).check()).rejects.toThrow('refused this App ID')
  const a = new FeishuAdapter(config, refused.api)
  adapters.push(a)
  const { handle, statuses } = io()
  await a.start(handle)
  await until(() => statuses.some((s) => s.state === 'error'))
})

test('the long connection: direct and group messages, mentions, split frames, card presses, each answered', async () => {
  const button = {
    schema: '2.0',
    header: { event_id: 'ev-card', event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'ou_alice' },
      token: 'tok',
      action: { value: { d: 'a:o:k1' }, tag: 'button' },
      context: { open_message_id: 'om_card', open_chat_id: 'oc_dm' },
    },
  }
  const mention = message('om_2', 'oc_group', 'group', '@_user_1 please look @_user_2', {
    mentions: [
      { key: '@_user_1', name: 'Myr', id: { open_id: 'ou_bot' } },
      { key: '@_user_2', name: 'Bob', id: { open_id: 'ou_bob' } },
    ],
  })
  const whole = new TextEncoder().encode(JSON.stringify(message('om_4', 'oc_dm', 'p2p', 'split in two')))
  const p = openPlatform(
    {
      ...base,
      'POST /callback/ws/endpoint': (c) =>
        c.body.AppID === 'cli_1'
          ? {
              code: 0,
              data: {
                URL: `ws://127.0.0.1:${p.server.port}/ws?device_id=d&service_id=7`,
                ClientConfig: { PingInterval: 120 },
              },
            }
          : { code: 1, msg: 'bad' },
    },
    (ws) => {
      ws.send(dataFrame(message('om_1', 'oc_dm', 'p2p', 'hello')))
      ws.send(dataFrame(mention))
      ws.send(dataFrame(message('om_3', 'oc_group', 'group', 'just chatting')))
      ws.send(dataFrame(undefined, { message_id: 'big', sum: '2', seq: '1' }, whole.subarray(10)))
      ws.send(dataFrame(undefined, { message_id: 'big', sum: '2', seq: '0' }, whole.subarray(0, 10)))
      ws.send(dataFrame(button, { type: 'card' }))
    },
  )
  servers.push(p.server)
  const adapter = new FeishuAdapter(config, p.api)
  adapters.push(adapter)
  const { handle, received, statuses } = io()
  await adapter.start(handle)
  await until(() => received.length === 5)
  expect(statuses).toContainEqual({ state: 'on', account: 'Myr' })
  expect(received[0]).toMatchObject({
    messageId: 'om_1',
    chat: { id: 'oc_dm', kind: 'dm' },
    sender: { id: 'ou_alice', name: 'Alice' },
    text: 'hello',
    mentioned: true,
  })
  // The bot's own @ is dropped and others become names.
  expect(received[1]).toMatchObject({ chat: { kind: 'group' }, text: 'please look @Bob', mentioned: true })
  expect(received[2]).toMatchObject({ text: 'just chatting', mentioned: false })
  expect(received[3]).toMatchObject({ messageId: 'om_4', text: 'split in two' })
  expect(received[4]).toMatchObject({
    chat: { id: 'oc_dm', kind: 'dm' },
    press: { data: 'a:o:k1', message: { chat: 'oc_dm', id: 'om_card' } },
  })
  // Every data frame is answered with code 200; the card's answer carries an (empty) card reply.
  await until(() => p.frames.length >= 5)
  for (const f of p.frames) expect(JSON.parse(new TextDecoder().decode(f.payload)).code).toBe(200)
  const cardAnswer = p.frames.find((f) => f.headers.some((h) => h.key === 'type' && h.value === 'card'))
  const data = JSON.parse(new TextDecoder().decode(cardAnswer?.payload)).data
  expect(Buffer.from(data, 'base64').toString()).toBe('{}')
  expect(cardAnswer?.headers.some((h) => h.key === 'biz_rt')).toBe(true)
})

test('sending: posts, cards for buttons, edits by PUT or PATCH, topics, files, and plain text when a post is refused', async () => {
  let refusePost = false
  const p = openPlatform({
    ...base,
    'POST /open-apis/im/v1/messages': (c) =>
      refusePost && c.body.msg_type === 'post'
        ? { code: 230001, msg: 'The content format of the post type is incorrect' }
        : { code: 0, data: { message_id: `om_${c.body.msg_type}` } },
    'POST /open-apis/im/v1/messages/om_root/reply': () => ({ code: 0, data: { message_id: 'om_in_topic' } }),
    'POST /open-apis/im/v1/images': () => ({ code: 0, data: { image_key: 'img_1' } }),
    'POST /open-apis/im/v1/files': () => ({ code: 0, data: { file_key: 'file_1' } }),
  })
  servers.push(p.server)
  const adapter = new FeishuAdapter(config, p.api)

  const ref = await adapter.send('oc_dm', { text: '**hi**\n```ts\nx\n```\nafter' })
  expect(ref).toEqual({ chat: 'oc_dm', id: 'om_post' })
  const sent = p.calls.at(-1)
  expect(sent?.body).toMatchObject({ receive_id: 'oc_dm', msg_type: 'post' })
  // Each code block is a row of its own.
  expect(JSON.parse(String(sent?.body.content)).zh_cn.content).toHaveLength(3)

  const card = await adapter.send('oc_dm', { text: 'ok?', buttons: [[{ label: 'Yes', data: 'q:k:0:0' }]] })
  const body = JSON.parse(String(p.calls.at(-1)?.body.content))
  expect(p.calls.at(-1)?.body.msg_type).toBe('interactive')
  expect(body.elements[1].actions[0]).toMatchObject({ text: { content: 'Yes' }, value: { d: 'q:k:0:0' } })

  await adapter.edit(card, { text: 'answered' })
  expect(p.calls.at(-1)).toMatchObject({ method: 'PATCH', path: '/open-apis/im/v1/messages/om_interactive' })
  await adapter.edit(ref, { text: 'changed' })
  expect(p.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/open-apis/im/v1/messages/om_post' })

  await adapter.send({ id: 'oc_group', kind: 'group', thread: 'om_root' }, { text: 'in the topic' })
  expect(p.calls.at(-1)?.body).toMatchObject({ reply_in_thread: true, msg_type: 'post' })

  refusePost = true
  await adapter.send('oc_dm', { text: '**plain** now' })
  expect(p.calls.at(-1)?.body).toMatchObject({
    msg_type: 'text',
    content: JSON.stringify({ text: 'plain now' }),
  })

  await adapter.sendFile('oc_dm', { name: 'a.png', mimeType: 'image/png', data: new Uint8Array([1]) })
  expect(p.calls.at(-2)).toMatchObject({ path: '/open-apis/im/v1/images', form: ['image_type', 'image'] })
  expect(p.calls.at(-1)?.body).toMatchObject({
    msg_type: 'image',
    content: JSON.stringify({ image_key: 'img_1' }),
  })
  await adapter.sendFile('oc_dm', { name: 'r.pdf', mimeType: 'application/pdf', data: new Uint8Array([1]) })
  expect(p.calls.at(-1)?.body).toMatchObject({ msg_type: 'file' })
})

function encrypt(text: string, key: string) {
  const iv = randomBytes(16)
  const c = createCipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), iv)
  return Buffer.concat([iv, c.update(text), c.final()]).toString('base64')
}

test('webhooks: decrypted with the Encrypt Key, signature and token checked, challenge answered', async () => {
  const p = openPlatform(base)
  servers.push(p.server)
  const key = 'encrypt-key'
  const adapter = new FeishuAdapter({ ...config, encryptKey: key, verificationToken: 'vt' }, p.api)
  adapters.push(adapter)
  const { handle, received } = io()
  await adapter.start(handle)
  const post = (body: string, signed = true, wrong = false) => {
    const ts = String(Math.floor(Date.now() / 1000))
    const nonce = 'n1'
    const sig = createHash('sha256').update(`${ts}${nonce}${key}${body}`).digest('hex')
    return adapter.webhook(
      new Request('https://box/hooks/channels/feishu', {
        method: 'POST',
        headers: signed
          ? {
              'x-lark-request-timestamp': ts,
              'x-lark-request-nonce': nonce,
              'x-lark-signature': wrong ? sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a') : sig,
            }
          : {},
        body,
      }),
    )
  }
  const challenge = JSON.stringify({
    encrypt: encrypt(JSON.stringify({ type: 'url_verification', challenge: 'c-1', token: 'vt' }), key),
  })
  expect(await (await post(challenge, false)).json()).toEqual({ challenge: 'c-1' })

  const event = message('om_9', 'oc_dm', 'p2p', 'by webhook')
  const sealed = JSON.stringify({
    encrypt: encrypt(JSON.stringify({ ...event, header: { ...event.header, token: 'vt' } }), key),
  })
  expect((await post(sealed, false)).status).toBe(401)
  expect((await post(sealed, true, true)).status).toBe(401)
  const wrongToken = JSON.stringify({
    encrypt: encrypt(JSON.stringify({ ...event, header: { ...event.header, token: 'nope' } }), key),
  })
  expect((await post(wrongToken)).status).toBe(401)
  expect((await post(JSON.stringify({ encrypt: 'not-really-encrypted' }))).status).toBe(401)
  expect((await post(sealed)).status).toBe(200)
  expect(received.map((m) => m.text)).toEqual(['by webhook'])

  // Without a token or key, webhook events are not taken at all.
  const open = new FeishuAdapter(config, p.api)
  const res = await open.webhook(
    new Request('https://box/hooks', {
      method: 'POST',
      body: JSON.stringify(message('om_x', 'oc', 'p2p', 'x')),
    }),
  )
  expect(res.status).toBe(403)
})

test('images in messages are read through the message resource API', async () => {
  const p = openPlatform({
    ...base,
    'GET /open-apis/im/v1/messages/om_img/resources/img_k': () => new Response(new Uint8Array([9, 8, 7])),
  })
  servers.push(p.server)
  const adapter = new FeishuAdapter({ ...config, verificationToken: 'vt' }, p.api)
  adapters.push(adapter)
  const { handle, received } = io()
  await adapter.start(handle)
  const event = message('om_img', 'oc_dm', 'p2p', '', {
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_k' }),
  })
  await adapter.webhook(
    new Request('https://box', {
      method: 'POST',
      body: JSON.stringify({ ...event, header: { ...event.header, token: 'vt' } }),
    }),
  )
  const file = received[0]?.files?.[0]
  expect(file).toMatchObject({ kind: 'image' })
  expect([...((await file?.read()) ?? [])]).toEqual([9, 8, 7])
})
