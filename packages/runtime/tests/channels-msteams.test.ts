import { afterEach, expect, test } from 'bun:test'
import { signJwt, TeamsAdapter } from '../src/channels/index.ts'
import { fakeServer, now, rsaKey, testIO, until } from './fixtures/channel-server.ts'

const APP = 'app-id-1'
const BOT = `28:${APP}`
const key = await rsaKey('k1', { endorsements: ['msteams'] })
const skypeOnly = await rsaKey('k2', { endorsements: ['skype'] })
const stranger = await rsaKey('k1')

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: TeamsAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

/** Bot Framework's metadata, keys and token service, and a Teams service URL, all on one fake server. */
function teams() {
  let n = 0
  const fake = fakeServer({
    'GET /openid': () => ({ jwks_uri: `${fake.base}/keys` }),
    'GET /keys': () => ({ keys: [key.jwk, skypeOnly.jwk] }),
    'POST /botframework.com/oauth2/v2.0/token': () => ({ access_token: 'APP-TOKEN', expires_in: 3600 }),
    'POST /T1/oauth2/v2.0/token': () => ({ access_token: 'APP-TOKEN', expires_in: 3600 }),
    'POST /v3/conversations/*': () => ({ id: `act-${++n}` }),
    'PUT /v3/conversations/*': () => ({}),
    'GET /files/*': () => new Response(new Uint8Array([7, 8, 9])),
  })
  servers.push(fake.server)
  return fake
}

function make(base: string, tenant = '') {
  const adapter = new TeamsAdapter(APP, 'secret', tenant, {
    openId: `${base}/openid`,
    login: base,
    serviceUrlAllowed: (url) => url.origin === base,
  })
  adapters.push(adapter)
  return adapter
}

const token = (base: string, claims: Record<string, unknown> = {}, signer = key) =>
  signJwt(
    {
      iss: 'https://api.botframework.com',
      aud: APP,
      exp: now() + 600,
      nbf: now() - 10,
      serviceurl: base,
      ...claims,
    },
    signer.pem,
    signer.kid,
  )

const activity = (base: string, extra: Record<string, unknown> = {}) => ({
  type: 'message',
  id: 'm1',
  timestamp: '2026-10-08T10:00:00.000Z',
  channelId: 'msteams',
  serviceUrl: base,
  from: { id: '29:alice', name: 'Alice', aadObjectId: 'aad-alice' },
  recipient: { id: BOT, name: 'Myr' },
  conversation: { id: 'a:dm-alice', conversationType: 'personal', tenantId: 'T1' },
  channelData: { tenant: { id: 'T1' } },
  text: 'hello',
  ...extra,
})

const post = async (adapter: TeamsAdapter, body: unknown, bearer?: string) =>
  adapter.webhook(
    new Request('https://box.example/hooks/channels/msteams', {
      method: 'POST',
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      body: JSON.stringify(body),
    }),
  )

test('without a public address it says so instead of starting', async () => {
  const { base } = teams()
  const { handle, statuses } = testIO()
  await make(base).start(handle)
  expect(statuses).toEqual([{ state: 'error', error: expect.stringContaining('public HTTPS address') }])
})

test('starts by getting an app token, and refuses a wrong secret for good', async () => {
  const fake = teams()
  const { handle, statuses } = testIO('https://box.example/hooks/channels/msteams')
  await make(fake.base).start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(statuses.at(-1)).toEqual({ state: 'on', account: APP })
  expect(fake.calls.find((c) => c.path.endsWith('/token'))?.body).toMatchObject({
    grant_type: 'client_credentials',
    client_id: APP,
    scope: 'https://api.botframework.com/.default',
  })

  const refusing = fakeServer({
    'POST /botframework.com/oauth2/v2.0/token': () =>
      Response.json({ error: 'invalid_client' }, { status: 401 }),
  })
  servers.push(refusing.server)
  await expect(make(refusing.base).check()).rejects.toThrow(/refused this app ID/)
})

test('webhooks need a Bot Framework token for this app, endorsed for Teams, from the same service', async () => {
  const { base } = teams()
  const adapter = make(base)
  const { handle, received, logs } = testIO('https://box.example/hooks/channels/msteams')
  await adapter.start(handle)
  const body = activity(base)
  expect((await post(adapter, body)).status).toBe(401)
  expect((await post(adapter, body, 'not-a-jwt')).status).toBe(401)
  expect((await post(adapter, body, await token(base, { aud: 'https://api.botframework.com' }))).status).toBe(
    401,
  )
  expect((await post(adapter, body, await token(base, { iss: 'https://evil.example' }))).status).toBe(401)
  expect((await post(adapter, body, await token(base, { exp: now() - 3600 }))).status).toBe(401)
  // Same key id, someone else's key: the signature does not hold.
  expect((await post(adapter, body, await token(base, {}, stranger))).status).toBe(401)
  expect((await post(adapter, body, await token(base, {}, skypeOnly))).status).toBe(401)
  expect(
    (await post(adapter, body, await token(base, { serviceurl: 'https://elsewhere.example' }))).status,
  ).toBe(401)
  expect(received).toEqual([])
  expect(logs.join('\n')).not.toContain('APP-TOKEN')
  expect((await post(adapter, body, await token(base))).status).toBe(200)
  expect(received.map((m) => m.text)).toEqual(['hello'])
})

test('activities become messages: a direct chat, a channel thread with a mention, a group without one', async () => {
  const { base } = teams()
  const adapter = make(base, 'T1')
  const { handle, received, kv } = testIO('https://box.example/hooks/channels/msteams')
  await adapter.start(handle)
  const send = async (extra: Record<string, unknown>) =>
    (await post(adapter, activity(base, extra), await token(base))).status

  expect(await send({})).toBe(200)
  expect(received[0]).toMatchObject({
    messageId: 'm1',
    chat: { id: 'a:dm-alice', kind: 'dm' },
    sender: { id: 'aad-alice', name: 'Alice' },
    text: 'hello',
    mentioned: true,
  })
  // Replies go back to the service URL the conversation came from.
  expect(kv.get('service:a:dm-alice')).toBe(base)

  expect(
    await send({
      id: 'm2',
      conversation: { id: '19:abc@thread.tacv2;messageid=111', conversationType: 'channel', tenantId: 'T1' },
      channelData: { tenant: { id: 'T1' }, team: { name: 'Research' } },
      text: '<at>Myr</at> summarise this for <at>Bob</at>',
      entities: [
        { type: 'mention', mentioned: { id: BOT, name: 'Myr' }, text: '<at>Myr</at>' },
        { type: 'mention', mentioned: { id: '29:bob', name: 'Bob' }, text: '<at>Bob</at>' },
      ],
    }),
  ).toBe(200)
  expect(received[1]).toMatchObject({
    chat: { id: '19:abc@thread.tacv2', kind: 'group', title: 'Research', thread: '111' },
    text: 'summarise this for Bob',
    mentioned: true,
  })

  expect(
    await send({
      id: 'm3',
      conversation: {
        id: '19:group@thread.v2',
        conversationType: 'groupChat',
        name: 'Lunch',
        tenantId: 'T1',
      },
      text: 'anyone?',
    }),
  ).toBe(200)
  expect(received[2]).toMatchObject({ chat: { id: '19:group@thread.v2', kind: 'group' }, mentioned: false })

  // Another tenant's activity is refused when a tenant is set.
  expect(await send({ id: 'm4', channelData: { tenant: { id: 'T2' } } })).toBe(403)
  expect(received).toHaveLength(3)
})

test('files: an uploaded file and an inline image are read on demand, with the token only for Teams hosts', async () => {
  const fake = teams()
  const adapter = make(fake.base)
  const { handle, received, statuses } = testIO('https://box.example/hooks/channels/msteams')
  await adapter.start(handle)
  // Its start-up check calls the platform in the background; once on, every call is the test's own.
  await until(() => statuses.some((s) => s.state === 'on'))
  await post(
    adapter,
    activity(fake.base, {
      text: '',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: 'report.pdf',
          content: { downloadUrl: `${fake.base}/files/report.pdf`, fileType: 'pdf' },
        },
        { contentType: 'image/png', contentUrl: `${fake.base}/files/img` },
        { contentType: 'text/html', content: {} },
      ],
    }),
    await token(fake.base),
  )
  const files = received[0]?.files ?? []
  expect(files.map((f) => [f.kind, f.name, f.mimeType])).toEqual([
    ['document', 'report.pdf', 'application/pdf'],
    ['image', 'image-2.png', 'image/png'],
  ])
  expect(await files[0]?.read()).toEqual(new Uint8Array([7, 8, 9]))
  expect(fake.calls.at(-1)?.headers.get('authorization')).toBe('Bearer APP-TOKEN')
  expect(received[0]?.unsupported).toBeUndefined()
})

test('sends, edits, buttons as an Adaptive Card, typing and images, to the right conversation', async () => {
  const fake = teams()
  const adapter = make(fake.base)
  const { handle, received, statuses } = testIO('https://box.example/hooks/channels/msteams')
  await adapter.start(handle)
  // Its start-up check calls the platform in the background; once on, every call is the test's own.
  await until(() => statuses.some((s) => s.state === 'on'))
  await post(
    adapter,
    activity(fake.base, {
      conversation: { id: '19:abc@thread.tacv2;messageid=111', conversationType: 'channel' },
    }),
    await token(fake.base),
  )
  const chat = received[0]?.chat
  if (!chat) throw new Error('no chat')

  const ref = await adapter.send(chat, {
    text: '**Allow?**',
    buttons: [[{ label: 'Allow once', data: 'a:o:k1' }], [{ label: 'Deny', data: 'a:d:k1' }]],
  })
  expect(ref).toEqual({ chat: '19:abc@thread.tacv2;messageid=111', id: 'act-1' })
  const sent = fake.calls.at(-1)
  expect(sent?.path).toBe(
    `/v3/conversations/${encodeURIComponent('19:abc@thread.tacv2;messageid=111')}/activities`,
  )
  expect(sent?.headers.get('authorization')).toBe('Bearer APP-TOKEN')
  expect(sent?.body).toMatchObject({
    type: 'message',
    text: '**Allow?**',
    textFormat: 'markdown',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          body: [
            {
              type: 'ActionSet',
              actions: [{ type: 'Action.Execute', title: 'Allow once', data: { myr: 'a:o:k1' } }],
            },
            {
              type: 'ActionSet',
              actions: [{ type: 'Action.Execute', title: 'Deny', data: { myr: 'a:d:k1' } }],
            },
          ],
        },
      },
    ],
  })

  await adapter.edit(ref, { text: 'Allowed by Alice' })
  expect(fake.calls.at(-1)).toMatchObject({
    method: 'PUT',
    path: `/v3/conversations/${encodeURIComponent(ref.chat)}/activities/act-1`,
    body: { id: 'act-1', text: 'Allowed by Alice', attachments: [] },
  })

  await adapter.typing(chat)
  expect(fake.calls.at(-1)?.body).toEqual({ type: 'typing' })

  await adapter.sendFile(chat, { name: 'chart.png', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) })
  expect(fake.calls.at(-1)?.body).toMatchObject({
    attachments: [{ contentType: 'image/png', contentUrl: 'data:image/png;base64,AQID', name: 'chart.png' }],
  })
  await expect(
    adapter.sendFile(chat, { name: 'a.pdf', mimeType: 'application/pdf', data: new Uint8Array([1]) }),
  ).rejects.toThrow(/only images/)

  // A conversation Teams never wrote from has no address to reply to.
  await expect(adapter.send('a:unknown', { text: 'hi' })).rejects.toThrow(/no address/)
})

test("a card button press arrives as an invoke and is answered with the hub's note", async () => {
  const { base } = teams()
  const adapter = make(base)
  const io = testIO('https://box.example/hooks/channels/msteams')
  io.onReceive((m) => {
    if (m.press)
      setTimeout(() => void adapter.answerPress(m.press as NonNullable<typeof m.press>, 'Allowed'), 20)
  })
  await adapter.start(io.handle)
  const res = await post(
    adapter,
    activity(base, {
      type: 'invoke',
      name: 'adaptiveCard/action',
      id: 'inv-1',
      replyToId: 'act-9',
      value: { action: { type: 'Action.Execute', verb: 'myr', data: { myr: 'a:o:k1' } } },
    }),
    await token(base),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    statusCode: 200,
    type: 'application/vnd.microsoft.activity.message',
    value: 'Allowed',
  })
  expect(io.received[0]).toMatchObject({
    messageId: 'press:inv-1',
    mentioned: true,
    press: { id: 'inv-1', data: 'a:o:k1', message: { chat: 'a:dm-alice', id: 'act-9' } },
  })
})
