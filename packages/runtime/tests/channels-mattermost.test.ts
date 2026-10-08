import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import type { ServerWebSocket } from 'bun'
import { channelCopy } from '../src/channels/copy.ts'
import { type AdapterIO, type AdapterStatus, type Inbound, MattermostAdapter } from '../src/channels/index.ts'

const TOKEN = 'bot-token'
const ME = { id: 'bot1', username: 'myrbot', is_bot: true }

type Call = { method: string; path: string; body: unknown; auth: string }

/** A stand-in for a Mattermost server: REST v4 plus its WebSocket, which the test feeds events through. */
function mattermost(options: { challenge?: 'fail' } = {}) {
  const calls: Call[] = []
  const actions: Record<string, unknown>[] = []
  const sockets: ServerWebSocket<unknown>[] = []
  let n = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const path = url.pathname.replace(/^\/api\/v4\//, '')
      if (path === 'websocket') return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
      const auth = req.headers.get('authorization') ?? ''
      const body = req.headers.get('content-type')?.includes('json')
        ? await req.json()
        : req.method === 'POST'
          ? await req.formData().catch(() => undefined)
          : undefined
      calls.push({ method: req.method, path, body, auth })
      if (auth !== `Bearer ${TOKEN}`)
        return Response.json(
          { id: 'api.context.session_expired.app_error', message: 'Invalid token' },
          { status: 401 },
        )
      if (path === 'users/me') return Response.json(ME)
      if (path === 'users/u9') return Response.json({ id: 'u9', username: 'carol' })
      if (path === 'channels/c-town') return Response.json({ id: 'c-town', type: 'O', display_name: 'Town' })
      if (path === 'files' && req.method === 'POST') return Response.json({ file_infos: [{ id: 'f-up' }] })
      if (path === 'files/f1') return new Response(new Uint8Array([4, 5, 6]))
      if (path === 'files/f2/info')
        return Response.json({ id: 'f2', name: 'notes.txt', mime_type: 'text/plain', size: 2 })
      if (path === 'posts' || path === 'posts/ephemeral')
        return Response.json({ id: `p${++n}` }, { status: 201 })
      if (/^posts\/[^/]+\/patch$/.test(path)) return Response.json({ id: path.split('/')[1] })
      return Response.json({ message: 'not found' }, { status: 404 })
    },
    websocket: {
      open(ws) {
        sockets.push(ws)
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as { seq: number; action: string; data?: { token?: string } }
        actions.push(msg)
        if (msg.action === 'authentication_challenge') {
          const ok = options.challenge !== 'fail' && msg.data?.token === TOKEN
          ws.send(JSON.stringify({ status: ok ? 'OK' : 'FAIL', seq_reply: msg.seq }))
          if (ok) ws.send(JSON.stringify({ event: 'hello', data: { server_version: '10' } }))
        }
      },
    },
  })
  const emit = (event: string, data: Record<string, unknown>) => {
    for (const ws of sockets) ws.send(JSON.stringify({ event, data, broadcast: {}, seq: 1 }))
  }
  return { server, calls, actions, emit, url: `http://127.0.0.1:${server.port}` }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: MattermostAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function io(webhookUrl?: string) {
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
    ...(webhookUrl ? { webhookUrl } : {}),
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

const posted = (post: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  channel_type: 'O',
  channel_display_name: 'Town',
  sender_name: '@alice',
  post: JSON.stringify({
    create_at: 1700000000000,
    user_id: 'u1',
    channel_id: 'c-town',
    message: '',
    ...post,
  }),
  ...extra,
})

async function running(webhookUrl?: string) {
  const fake = mattermost()
  servers.push(fake.server)
  const adapter = new MattermostAdapter(`${fake.url}/`, TOKEN)
  adapters.push(adapter)
  const handle = io(webhookUrl)
  await adapter.start(handle.handle)
  await until(() => handle.statuses.some((s) => s.state === 'on'))
  return { fake, adapter, ...handle }
}

test('check() names the bot; a refused token is an error, at check and on the socket', async () => {
  const fake = mattermost()
  servers.push(fake.server)
  expect(await new MattermostAdapter(fake.url, TOKEN).check()).toBe('@myrbot')
  await expect(new MattermostAdapter(fake.url, 'wrong').check()).rejects.toThrow(
    channelCopy.errors.mattermostToken,
  )
  const a = new MattermostAdapter(fake.url, 'wrong')
  adapters.push(a)
  const first = io()
  await a.start(first.handle)
  await until(() => first.statuses.some((s) => s.state === 'error'))
  expect(first.statuses.at(-1)).toEqual({ state: 'error', error: channelCopy.errors.mattermostToken })

  // REST accepts the token but the WebSocket's challenge does not.
  const refusing = mattermost({ challenge: 'fail' })
  servers.push(refusing.server)
  const b = new MattermostAdapter(refusing.url, TOKEN)
  adapters.push(b)
  const second = io()
  await b.start(second.handle)
  await until(() => second.statuses.some((s) => s.state === 'error'))
  expect(second.statuses.some((s) => s.state === 'on')).toBe(false)
})

test('posted events become messages: direct chats, mentions, threads, files; own and system posts ignored', async () => {
  const { fake, received, statuses, adapter } = await running()
  expect(statuses.at(-1)).toEqual({ state: 'on', account: '@myrbot' })
  expect(fake.actions[0]).toMatchObject({ action: 'authentication_challenge', data: { token: TOKEN } })
  expect(adapter.can.buttons).toBe(false)

  fake.emit('posted', posted({ id: 'p-dm', channel_id: 'c-dm', message: 'hello' }, { channel_type: 'D' }))
  fake.emit('posted', posted({ id: 'p-chat', message: 'chatting among ourselves' }))
  fake.emit(
    'posted',
    posted({ id: 'p-at', message: '@myrbot please look' }, { mentions: JSON.stringify(['bot1']) }),
  )
  fake.emit('posted', posted({ id: 'p-thread', root_id: 'p-root', message: 'and @MyrBot this too' }))
  fake.emit('posted', posted({ id: 'p-own', user_id: 'bot1', message: 'my own' }))
  fake.emit('posted', posted({ id: 'p-sys', type: 'system_join_channel', message: 'alice joined' }))
  fake.emit('posted', posted({ id: 'p-bot', message: 'another bot', props: { from_bot: 'true' } }))
  fake.emit(
    'posted',
    posted(
      {
        id: 'p-files',
        channel_id: 'c-dm',
        message: 'see attached',
        file_ids: ['f1'],
        metadata: { files: [{ id: 'f1', name: 'shot.png', mime_type: 'image/png', size: 3 }] },
      },
      { channel_type: 'D' },
    ),
  )
  fake.emit(
    'posted',
    posted(
      { id: 'p-old', channel_id: 'c-dm', message: 'old server', file_ids: ['f2'] },
      { channel_type: 'D' },
    ),
  )
  await until(() => received.length === 6)

  expect(received[0]).toMatchObject({
    messageId: 'p-dm',
    chat: { id: 'c-dm', kind: 'dm' },
    sender: { id: 'u1', name: 'alice', handle: 'alice' },
    text: 'hello',
    mentioned: true,
    time: new Date(1700000000000).toISOString(),
  })
  expect(received[0]?.chat.title).toBeUndefined()
  expect(received[1]).toMatchObject({
    chat: { id: 'c-town', kind: 'group', title: 'Town' },
    mentioned: false,
  })
  expect(received[2]).toMatchObject({ text: 'please look', mentioned: true })
  expect(received[3]).toMatchObject({ chat: { thread: 'p-root' }, text: 'and  this too', mentioned: true })
  const shot = received[4]?.files?.[0]
  expect(shot).toMatchObject({ kind: 'image', name: 'shot.png', mimeType: 'image/png', size: 3 })
  expect([...((await shot?.read()) ?? [])]).toEqual([4, 5, 6])
  expect(fake.calls.at(-1)).toMatchObject({ path: 'files/f1', auth: `Bearer ${TOKEN}` })
  expect(received[5]?.files?.[0]).toMatchObject({ kind: 'document', name: 'notes.txt' })
  expect(received.map((m) => m.messageId)).not.toContain('p-own')
})

test('sending: threads, edits that drop buttons, typing over the socket, files by id', async () => {
  const { fake, adapter } = await running()
  const thread = { id: 'c-town', kind: 'group' as const, thread: 'p-root' }
  const ref = await adapter.send(thread, {
    text: 'see ![chart](https://x.example/c.png)',
    buttons: [[{ label: 'Yes', data: 'q:k:0:0' }]],
  })
  expect(ref).toEqual({ chat: 'c-town', id: 'p1' })
  // Without a public address there are no buttons to send.
  expect(fake.calls.at(-1)).toMatchObject({
    method: 'POST',
    path: 'posts',
    body: { channel_id: 'c-town', root_id: 'p-root', message: 'see https://x.example/c.png' },
  })
  expect(((fake.calls.at(-1) as Call).body as { props?: unknown }).props).toBeUndefined()

  await adapter.edit(ref, { text: 'done' })
  expect(fake.calls.at(-1)).toMatchObject({
    method: 'PUT',
    path: 'posts/p1/patch',
    body: { message: 'done', props: { attachments: [] } },
  })

  await adapter.typing(thread)
  await until(() => fake.actions.some((a) => a.action === 'user_typing'))
  expect(fake.actions.find((a) => a.action === 'user_typing')).toMatchObject({
    data: { channel_id: 'c-town', parent_id: 'p-root' },
  })

  const file = await adapter.sendFile('c-dm', {
    name: 'r.pdf',
    mimeType: 'application/pdf',
    data: new Uint8Array([1]),
  })
  expect(file).toEqual({ chat: 'c-dm', id: 'p2' })
  const upload = fake.calls.find((c) => c.path === 'files') as Call
  expect((upload.body as FormData).get('channel_id')).toBe('c-dm')
  expect(((upload.body as FormData).get('files') as File).name).toBe('r.pdf')
  expect(fake.calls.at(-1)).toMatchObject({ path: 'posts', body: { channel_id: 'c-dm', file_ids: ['f-up'] } })
})

test('with a public address, buttons are signed actions; a press with a valid signature comes in', async () => {
  const hook = 'https://box.example.ts.net/hooks/channels/mattermost'
  const { fake, adapter, received, kv } = await running(hook)
  expect(adapter.can.buttons).toBe(true)
  expect(kv.get('action-secret')?.length).toBeGreaterThan(20)
  await adapter.send('c-town', {
    text: 'Allow?',
    buttons: [[{ label: 'Allow once', data: 'a:o:k1' }], [{ label: 'Deny', data: 'a:d:k1' }]],
  })
  const props = (
    (fake.calls.at(-1) as Call).body as { props: { attachments: { actions: Record<string, unknown>[] }[] } }
  ).props
  const actions = props.attachments[0]?.actions ?? []
  expect(actions.map((a) => a.name)).toEqual(['Allow once', 'Deny'])
  expect(actions.every((a) => /^[a-z0-9]+$/i.test(String(a.id)))).toBe(true)
  const integration = actions[0]?.integration as { url: string; context: { data: string; sig: string } }
  expect(integration.url).toBe(hook)
  expect(integration.context.data).toBe('a:o:k1')

  const press = (context: Record<string, unknown>, channel = 'c-town') =>
    adapter.webhook(
      new Request(hook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          user_id: 'u9',
          channel_id: channel,
          post_id: 'p1',
          trigger_id: 't1',
          context,
        }),
      }),
    )
  expect((await press({ data: 'a:o:k1' })).status).toBe(401)
  expect((await press({ data: 'a:a:k1', sig: integration.context.sig })).status).toBe(401)
  // A signature is good only in the channel it was sent to.
  expect((await press(integration.context, 'c-other')).status).toBe(401)
  expect(received).toHaveLength(0)
  expect((await press(integration.context)).status).toBe(200)
  expect(received[0]).toMatchObject({
    chat: { id: 'c-town', kind: 'group', title: 'Town' },
    sender: { id: 'u9', name: 'carol' },
    press: { data: 'a:o:k1', message: { chat: 'c-town', id: 'p1' } },
  })

  const pressed = received[0]?.press
  if (pressed) await adapter.answerPress(pressed, 'Allowed')
  expect(fake.calls.at(-1)).toMatchObject({
    path: 'posts/ephemeral',
    body: { user_id: 'u9', post: { channel_id: 'c-town', message: 'Allowed' } },
  })
})
