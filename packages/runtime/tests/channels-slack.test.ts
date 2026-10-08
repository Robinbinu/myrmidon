import { afterEach, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import type { ServerWebSocket } from 'bun'
import {
  type AdapterIO,
  type AdapterStatus,
  type Inbound,
  SlackAdapter,
  slackMrkdwn,
} from '../src/channels/index.ts'

type Call = { method: string; params: Record<string, string>; auth: string }
type Route = (
  params: Record<string, string>,
  n: number,
  auth: string,
) => Response | Record<string, unknown> | undefined

/**
 * A stand-in for Slack: the Web API under `/api/<method>` (form-encoded, answered from `routes` or defaults; every
 * call recorded), a Socket Mode WebSocket at `/socket` that says hello and records acknowledgements, file downloads
 * at `/files/`, the upload address at `/upload/` and a press's `response_url` at `/respond/`.
 */
function fakeSlack(routes: Record<string, Route> = {}) {
  const calls: Call[] = []
  const acks: string[] = []
  const sockets: ServerWebSocket<unknown>[] = []
  const uploads: { type: string; bytes: string }[] = []
  const responses: Record<string, unknown>[] = []
  const counts = new Map<string, number>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/socket' && srv.upgrade(req, { data: undefined })) return undefined
      if (url.pathname.startsWith('/files/'))
        return req.headers.get('authorization') === 'Bearer xoxb-bot'
          ? new Response('notes', { headers: { 'content-type': 'text/plain' } })
          : new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } })
      if (url.pathname.startsWith('/upload/')) {
        uploads.push({ type: req.headers.get('content-type') ?? '', bytes: await req.text() })
        return new Response('OK')
      }
      if (url.pathname.startsWith('/respond/')) {
        responses.push((await req.json()) as Record<string, unknown>)
        return new Response('ok')
      }
      const method = url.pathname.replace(/^\/api\//, '')
      const params = Object.fromEntries(new URLSearchParams(await req.text()))
      const auth = req.headers.get('authorization') ?? ''
      calls.push({ method, params, auth })
      const n = (counts.get(method) ?? 0) + 1
      counts.set(method, n)
      const custom = routes[method]?.(params, n, auth)
      if (custom instanceof Response) return custom
      if (custom) return Response.json(custom)
      const base = `127.0.0.1:${server.port}`
      const answers: Record<string, Record<string, unknown>> = {
        'auth.test': { ok: true, user: 'myr', user_id: 'UBOT', team: 'Acme', team_id: 'T1' },
        'apps.connections.open': { ok: true, url: `ws://${base}/socket?ticket=${n}` },
        'users.info': { ok: true, user: { name: 'alice', profile: { display_name: 'Alice' } } },
        'conversations.info': { ok: true, channel: { name: 'general' } },
        'chat.postMessage': { ok: true, channel: params.channel, ts: `1700.${n}` },
        'files.getUploadURLExternal': { ok: true, upload_url: `http://${base}/upload/F1`, file_id: 'F1' },
      }
      return Response.json(answers[method] ?? { ok: true })
    },
    websocket: {
      open(ws) {
        sockets.push(ws)
        ws.send(JSON.stringify({ type: 'hello', num_connections: 1 }))
      },
      message(_ws, raw) {
        const msg = JSON.parse(String(raw)) as { envelope_id?: string }
        if (msg.envelope_id) acks.push(msg.envelope_id)
      },
    },
  })
  const send = (envelope: unknown) => sockets.at(-1)?.send(JSON.stringify(envelope))
  return { server, calls, acks, sockets, uploads, responses, send, base: `http://127.0.0.1:${server.port}` }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: SlackAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

function setup(routes: Record<string, Route> = {}, tokens = { bot: 'xoxb-bot', app: 'xapp-app' }) {
  const fake = fakeSlack(routes)
  servers.push(fake.server)
  const adapter = new SlackAdapter(tokens.bot, tokens.app, `${fake.base}/api`)
  adapters.push(adapter)
  return { fake, adapter }
}

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

async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

const event = (id: string, e: Record<string, unknown>) => ({
  envelope_id: id,
  type: 'events_api',
  payload: { type: 'event_callback', event: { type: 'message', user: 'U1', ...e } },
})

test('check proves both tokens and names the app; refused tokens say which', async () => {
  const { fake, adapter } = setup({
    'auth.test': (_p, _n, auth) =>
      auth === 'Bearer xoxb-bad' ? { ok: false, error: 'invalid_auth' } : undefined,
    'apps.connections.open': (_p, _n, auth) =>
      auth === 'Bearer xapp-bad' ? { ok: false, error: 'invalid_auth' } : undefined,
  })
  expect(await adapter.check()).toBe('@myr in Acme')
  expect(fake.calls.map((c) => [c.method, c.auth])).toEqual([
    ['auth.test', 'Bearer xoxb-bot'],
    ['apps.connections.open', 'Bearer xapp-app'],
  ])
  const api = `${fake.base}/api`
  await expect(new SlackAdapter('xoxb-bad', 'xapp-app', api).check()).rejects.toThrow('refused the bot token')
  await expect(new SlackAdapter('xoxb-bot', 'xapp-bad', api).check()).rejects.toThrow(
    'refused the app-level token',
  )
  await expect(new SlackAdapter('xoxb-bot', 'xoxb-bot', api).check()).rejects.toThrow('starts with xapp-')

  const refused = setup({ 'auth.test': () => ({ ok: false, error: 'token_revoked' }) })
  const watch = io()
  await refused.adapter.start(watch.handle)
  await until(() => watch.statuses.some((s) => s.state === 'error'))
  expect(watch.statuses.at(-1)).toMatchObject({
    state: 'error',
    error: expect.stringContaining('refused the bot token'),
  })
})

test('socket envelopes are acknowledged and become the hub’s messages: DMs, mentions, threads, files, ! commands', async () => {
  const { fake, adapter } = setup()
  const { handle, received, statuses, kv } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(statuses).toContainEqual({ state: 'on', account: '@myr in Acme' })

  fake.send(
    event('E1', {
      channel: 'D1',
      channel_type: 'im',
      text: 'hello &amp; <https://x.dev|the site>',
      ts: '1.1',
    }),
  )
  fake.send(event('E2', { type: 'app_mention', channel: 'C1', text: '<@UBOT> please look', ts: '2.1' }))
  fake.send(
    event('E3', { channel: 'C1', channel_type: 'channel', text: 'and more', ts: '2.2', thread_ts: '2.1' }),
  )
  fake.send(
    event('E4', { channel: 'C1', channel_type: 'channel', text: 'chatting among ourselves', ts: '3.1' }),
  )
  fake.send(event('E5', { channel: 'D1', channel_type: 'im', subtype: 'message_changed', ts: '4.1' }))
  fake.send(event('E6', { channel: 'D1', channel_type: 'im', bot_id: 'B9', text: 'bot talk', ts: '4.2' }))
  fake.send(
    event('E7', {
      channel: 'D1',
      channel_type: 'im',
      subtype: 'file_share',
      text: '',
      ts: '4.3',
      files: [
        {
          id: 'F9',
          name: 'notes.txt',
          mimetype: 'text/plain',
          size: 5,
          url_private_download: `${fake.base}/files/notes.txt`,
        },
      ],
    }),
  )
  fake.send(event('E8', { channel: 'D1', channel_type: 'im', text: '!new', ts: '4.4' }))
  fake.send({ envelope_id: 'E9', type: 'events_api', payload: { type: 'app_rate_limited' } })
  await until(() => received.length === 6 && fake.acks.length === 9)
  expect(fake.acks).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9'])

  expect(received[0]).toMatchObject({
    messageId: '1.1',
    chat: { id: 'D1', kind: 'dm' },
    sender: { id: 'U1', name: 'Alice', handle: 'alice' },
    text: 'hello & the site (https://x.dev)',
    mentioned: true,
  })
  expect(received[0]?.chat.thread).toBeUndefined()
  // In a channel the answer goes into a thread under the message, which is its own conversation.
  expect(received[1]).toMatchObject({
    chat: { id: 'C1', kind: 'group', title: '#general', thread: '2.1' },
    text: 'please look',
    mentioned: true,
  })
  expect(received[2]).toMatchObject({ chat: { thread: '2.1' }, text: 'and more', mentioned: true })
  expect(JSON.parse(kv.get('threads') ?? '[]')).toContain('C1:2.1')
  expect(received[3]).toMatchObject({ chat: { thread: '3.1' }, mentioned: false })
  const file = received[4]?.files?.[0]
  expect(file).toMatchObject({ kind: 'document', name: 'notes.txt', mimeType: 'text/plain', size: 5 })
  expect(new TextDecoder().decode(await file?.read())).toBe('notes')
  expect(received[5]).toMatchObject({ text: '/new' })
  // Names are looked up once per person.
  expect(fake.calls.filter((c) => c.method === 'users.info')).toHaveLength(1)
})

test('a button press is acknowledged, becomes a press, and a note reaches only the presser', async () => {
  const { fake, adapter } = setup()
  const { handle, received, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  const press = (id: string, value: string, ts: string) => ({
    envelope_id: id,
    type: 'interactive',
    payload: {
      type: 'block_actions',
      user: { id: 'U1', username: 'alice' },
      channel: { id: 'D1' },
      container: { type: 'message', message_ts: '5.5', channel_id: 'D1' },
      response_url: `${fake.base}/respond/${id}`,
      trigger_id: `tr-${id}`,
      actions: [{ type: 'button', action_id: 'myr_0_0', value, action_ts: ts }],
    },
  })
  fake.send(press('P1', 'a:o:k1', '6.6'))
  await until(() => received.length === 1)
  expect(fake.acks).toContain('P1')
  expect(received[0]).toMatchObject({
    messageId: 'press:6.6',
    chat: { id: 'D1', kind: 'dm' },
    sender: { id: 'U1', name: 'Alice' },
    mentioned: true,
    press: { id: '6.6', data: 'a:o:k1', message: { chat: 'D1', id: '5.5' } },
  })
  const first = received[0]?.press
  if (!first) throw new Error('no press')
  await adapter.answerPress(first, 'Only the owner can approve this.')
  expect(fake.responses).toEqual([
    { response_type: 'ephemeral', replace_original: false, text: 'Only the owner can approve this.' },
  ])

  // A note the edited message already shows is not repeated.
  fake.send(press('P2', 'a:d:k2', '7.7'))
  await until(() => received.length === 2)
  const second = received[1]?.press
  if (!second) throw new Error('no press')
  await adapter.answerPress(second, 'Denied')
  expect(fake.responses).toHaveLength(1)
})

test('sends mrkdwn in sections with buttons as actions, into threads; edits replace the blocks', async () => {
  const { fake, adapter } = setup({
    'chat.postMessage': (p) => (p.channel === 'C404' ? { ok: false, error: 'not_in_channel' } : undefined),
  })
  const ref = await adapter.send(
    { id: 'C1', kind: 'group', thread: '2.1' },
    {
      text: '**Done**, see [the docs](https://x.dev/a?b=1&c=2) <now>',
      buttons: [[{ label: 'Allow once', data: 'a:o:k1' }], [{ label: 'Deny', data: 'a:d:k1' }]],
    },
  )
  expect(ref).toEqual({ chat: 'C1', id: '1700.1' })
  const post = fake.calls.at(-1)?.params ?? {}
  expect(post).toMatchObject({ channel: 'C1', thread_ts: '2.1', unfurl_links: 'false' })
  const mrkdwn = '*Done*, see <https://x.dev/a?b=1&amp;c=2|the docs> &lt;now&gt;'
  expect(post.text).toBe(mrkdwn)
  expect(JSON.parse(post.blocks ?? '[]')).toEqual([
    { type: 'section', text: { type: 'mrkdwn', text: mrkdwn } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'myr_0_0',
          text: { type: 'plain_text', text: 'Allow once', emoji: true },
          value: 'a:o:k1',
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'myr_1_0',
          text: { type: 'plain_text', text: 'Deny', emoji: true },
          value: 'a:d:k1',
        },
      ],
    },
  ])

  await adapter.edit(ref, { text: 'Allowed' })
  const update = fake.calls.at(-1)
  expect(update?.method).toBe('chat.update')
  expect(update?.params).toMatchObject({ channel: 'C1', ts: '1700.1', text: 'Allowed' })
  expect(JSON.parse(update?.params.blocks ?? '[]')).toEqual([
    { type: 'section', text: { type: 'mrkdwn', text: 'Allowed' } },
  ])

  // A long message is split into sections, a code block closed and reopened across the cut.
  const long = `\`\`\`\n${Array.from({ length: 400 }, (_, i) => `line ${i} of the log`).join('\n')}\n\`\`\``
  await adapter.send('D1', { text: long })
  const sections = JSON.parse(fake.calls.at(-1)?.params.blocks ?? '[]') as { text: { text: string } }[]
  expect(sections.length).toBeGreaterThan(1)
  for (const s of sections) {
    expect(s.text.text.length).toBeLessThanOrEqual(3000)
    expect((s.text.text.match(/```/g) ?? []).length % 2).toBe(0)
  }

  await expect(adapter.send('C404', { text: 'hi' })).rejects.toThrow('/invite')
  // Slack has no typing indicator for bots: nothing is called.
  const before = fake.calls.length
  await adapter.typing('D1')
  expect(fake.calls.length).toBe(before)
})

test('files go up through an upload address and are shared into the chat', async () => {
  const { fake, adapter } = setup()
  const ref = await adapter.sendFile(
    { id: 'C1', kind: 'group', thread: '2.1' },
    {
      name: 'report.txt',
      mimeType: 'text/plain',
      data: new TextEncoder().encode('hello'),
      caption: 'The report',
    },
  )
  expect(ref).toEqual({ chat: 'C1', id: 'F1' })
  expect(fake.calls.map((c) => c.method)).toEqual([
    'files.getUploadURLExternal',
    'files.completeUploadExternal',
  ])
  expect(fake.calls[0]?.params).toEqual({ filename: 'report.txt', length: '5' })
  expect(fake.uploads).toEqual([{ type: 'text/plain', bytes: 'hello' }])
  expect(fake.calls[1]?.params).toMatchObject({
    channel_id: 'C1',
    thread_ts: '2.1',
    initial_comment: 'The report',
  })
  expect(JSON.parse(fake.calls[1]?.params.files ?? '[]')).toEqual([{ id: 'F1', title: 'report.txt' }])
})

test('a 429 waits for Retry-After and tries again', async () => {
  const { fake, adapter } = setup({
    'chat.postMessage': (_p, n) =>
      n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : undefined,
  })
  const started = Date.now()
  await adapter.send('D1', { text: 'hello' })
  expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  expect(fake.calls.filter((c) => c.method === 'chat.postMessage')).toHaveLength(2)
})

test('a refresh Slack asks for opens a new connection; Socket Mode switched off stops it', async () => {
  const { fake, adapter } = setup()
  const { handle, statuses } = io()
  await adapter.start(handle)
  await until(() => fake.sockets.length === 1)
  fake.send({ type: 'disconnect', reason: 'refresh_requested' })
  await until(() => fake.sockets.length === 2)
  expect(statuses.some((s) => s.state === 'retrying')).toBe(false)
  fake.send({ type: 'disconnect', reason: 'link_disabled' })
  await until(() => statuses.some((s) => s.state === 'error'))
  expect(statuses.at(-1)).toMatchObject({
    state: 'error',
    error: expect.stringContaining('Socket Mode is off'),
  })
})

test('Slack mrkdwn: emphasis, links, headings, bullets, quotes and code, with &, <, > escaped', () => {
  expect(slackMrkdwn('**bold** *it* _it_ ~~gone~~ `**raw** <b>`')).toBe(
    '*bold* _it_ _it_ ~gone~ `**raw** &lt;b&gt;`',
  )
  // A closing `*` right after punctuation gets a zero-width space, or Slack would not close it.
  expect(slackMrkdwn('**done.**')).toBe('*done.​*')
  expect(slackMrkdwn('# Title\n- one\n> quoted <@U1>')).toBe('*Title*\n• one\n> quoted &lt;@U1&gt;')
  expect(slackMrkdwn('```ts\nconst a = 1 && b < 2\n```')).toBe('```\nconst a = 1 &amp;&amp; b &lt; 2\n```')
  expect(slackMrkdwn('<!channel> hi')).toBe('&lt;!channel&gt; hi')
})
