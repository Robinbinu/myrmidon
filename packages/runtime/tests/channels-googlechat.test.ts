import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoogleChatAdapter, googleChatText, plainText, signJwt } from '../src/channels/index.ts'
import { fakeServer, now, rsaKey, testIO, until } from './fixtures/channel-server.ts'

const PROJECT = '123456789012'
const HOOK = 'https://box.example/hooks/channels/googlechat'
const chatKey = await rsaKey('chat-1')
const googleKey = await rsaKey('google-1')
const serviceKey = await rsaKey('sa-1')

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: GoogleChatAdapter[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Google's token service and key sets, and the Chat API, on one fake server. */
function google() {
  let n = 0
  const fake = fakeServer({
    'POST /token': () => ({ access_token: 'CHAT-TOKEN', expires_in: 3600 }),
    'GET /chatkeys': () => ({ keys: [chatKey.jwk] }),
    'GET /googlekeys': () => ({ keys: [googleKey.jwk] }),
    'GET /v1/spaces': () => ({ spaces: [] }),
    'POST /v1/spaces/*': () => ({ name: `spaces/S1/messages/M${++n}` }),
    'PATCH /v1/spaces/*': () => ({}),
    'GET /v1/media/*': () => new Response(new Uint8Array([4, 5, 6])),
  })
  servers.push(fake.server)
  return fake
}

const account = (base: string) =>
  JSON.stringify({
    type: 'service_account',
    client_email: 'myr@proj.iam.gserviceaccount.com',
    private_key: serviceKey.pem,
    private_key_id: 'sa-1',
    token_uri: `${base}/token`,
  })

function make(base: string, audience = PROJECT) {
  const adapter = new GoogleChatAdapter(account(base), audience, {
    api: base,
    chatKeys: `${base}/chatkeys`,
    googleKeys: `${base}/googlekeys`,
  })
  adapters.push(adapter)
  return adapter
}

const chatToken = (claims: Record<string, unknown> = {}, signer = chatKey) =>
  signJwt(
    { iss: 'chat@system.gserviceaccount.com', aud: PROJECT, exp: now() + 600, iat: now(), ...claims },
    signer.pem,
    signer.kid,
  )

const post = (adapter: GoogleChatAdapter, body: unknown, bearer?: string) =>
  adapter.webhook(
    new Request(HOOK, {
      method: 'POST',
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      body: JSON.stringify(body),
    }),
  )

const alice = { name: 'users/111', displayName: 'Alice', email: 'alice@example.com', type: 'HUMAN' }
const dmEvent = {
  type: 'MESSAGE',
  eventTime: '2026-10-08T10:00:00Z',
  space: { name: 'spaces/D1', spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true },
  user: alice,
  message: {
    name: 'spaces/D1/messages/X1',
    text: 'hello',
    argumentText: 'hello',
    sender: alice,
    thread: { name: 'spaces/D1/threads/T0' },
    createTime: '2026-10-08T10:00:00Z',
  },
}

test('without a public address it says so instead of starting', async () => {
  const { base } = google()
  const { handle, statuses } = testIO()
  await make(base).start(handle)
  expect(statuses).toEqual([{ state: 'error', error: expect.stringContaining('public HTTPS address') }])
})

test('starts with a token the service account signed for itself, and refuses a broken key', async () => {
  const fake = google()
  const { handle, statuses } = testIO(HOOK)
  await make(fake.base).start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(statuses.at(-1)).toEqual({ state: 'on', account: 'myr@proj.iam.gserviceaccount.com' })
  const grant = fake.calls.find((c) => c.path === '/token')?.body as Record<string, string>
  expect(grant.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
  const claims = JSON.parse(Buffer.from(grant.assertion?.split('.')[1] ?? '', 'base64url').toString())
  expect(claims).toMatchObject({
    iss: 'myr@proj.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/chat.bot',
    aud: `${fake.base}/token`,
  })
  expect(fake.calls.find((c) => c.path === '/v1/spaces')?.headers.get('authorization')).toBe(
    'Bearer CHAT-TOKEN',
  )

  await expect(new GoogleChatAdapter('{not json').check()).rejects.toThrow(/not JSON/)
  await expect(new GoogleChatAdapter('{"client_email": "x"}').check()).rejects.toThrow(
    /no client_email or private_key/,
  )
})

test('webhooks need a token Google Chat signed for this project (or an ID token for the endpoint URL)', async () => {
  const { base } = google()
  const adapter = make(base)
  const { handle, received, logs } = testIO(HOOK)
  await adapter.start(handle)
  expect((await post(adapter, dmEvent)).status).toBe(401)
  expect((await post(adapter, dmEvent, await chatToken({ aud: '999' }))).status).toBe(401)
  expect((await post(adapter, dmEvent, await chatToken({ iss: 'someone@example.com' }))).status).toBe(401)
  expect((await post(adapter, dmEvent, await chatToken({ exp: now() - 3600 }))).status).toBe(401)
  expect((await post(adapter, dmEvent, await chatToken({}, googleKey))).status).toBe(401)
  expect(received).toEqual([])
  expect(logs.join('\n')).toContain('unexpected audience')
  const ok = await post(adapter, dmEvent, await chatToken())
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({})
  expect(received).toHaveLength(1)

  // Audience = the endpoint URL: a Google ID token for that URL, and only Chat's own.
  const byUrl = make(base, '')
  const io = testIO(HOOK)
  await byUrl.start(io.handle)
  const idToken = (email: string) =>
    signJwt(
      { iss: 'https://accounts.google.com', aud: HOOK, exp: now() + 600, email, email_verified: true },
      googleKey.pem,
      googleKey.kid,
    )
  expect((await post(byUrl, dmEvent, await idToken('mallory@example.com'))).status).toBe(401)
  expect((await post(byUrl, dmEvent, await chatToken())).status).toBe(401)
  expect((await post(byUrl, dmEvent, await idToken('chat@system.gserviceaccount.com'))).status).toBe(200)
  expect(io.received).toHaveLength(1)
})

test('events become messages: a direct chat, a space thread with a mention, a card button press', async () => {
  const { base } = google()
  const adapter = make(base)
  const { handle, received } = testIO(HOOK)
  await adapter.start(handle)
  const send = async (event: unknown) => (await post(adapter, event, await chatToken())).status

  expect(await send(dmEvent)).toBe(200)
  // A direct chat's per-message thread is not a conversation of its own.
  expect(received[0]).toMatchObject({
    messageId: 'spaces/D1/messages/X1',
    chat: { id: 'spaces/D1', kind: 'dm' },
    sender: { id: 'users/111', name: 'Alice', handle: 'alice@example.com' },
    text: 'hello',
    mentioned: true,
  })
  expect(received[0]?.chat.thread).toBeUndefined()

  const space = { name: 'spaces/S1', spaceType: 'SPACE', displayName: 'Research' }
  expect(
    await send({
      type: 'MESSAGE',
      space,
      user: alice,
      message: {
        name: 'spaces/S1/messages/X2',
        text: '@Myr summarise this',
        argumentText: ' summarise this',
        threadReply: true,
        thread: { name: 'spaces/S1/threads/T1' },
        annotations: [{ type: 'USER_MENTION', userMention: { user: { name: 'users/999', type: 'BOT' } } }],
        attachment: [
          {
            contentName: 'notes.txt',
            contentType: 'text/plain',
            attachmentDataRef: { resourceName: 'spaces/S1/attachments/A1' },
          },
        ],
      },
    }),
  ).toBe(200)
  expect(received[1]).toMatchObject({
    chat: { id: 'spaces/S1', kind: 'group', title: 'Research', thread: 'spaces/S1/threads/T1' },
    text: 'summarise this',
    mentioned: true,
  })
  expect(await received[1]?.files?.[0]?.read()).toEqual(new Uint8Array([4, 5, 6]))

  expect(
    await send({
      type: 'MESSAGE',
      space,
      user: alice,
      message: { name: 'spaces/S1/messages/X3', text: 'just chatting', argumentText: 'just chatting' },
    }),
  ).toBe(200)
  expect(received[2]).toMatchObject({ chat: { id: 'spaces/S1', kind: 'group' }, mentioned: false })

  expect(
    await send({
      type: 'CARD_CLICKED',
      eventTime: '2026-10-08T10:01:00Z',
      space: dmEvent.space,
      user: alice,
      message: { name: 'spaces/D1/messages/B1' },
      action: { actionMethodName: 'myr', parameters: [{ key: 'data', value: 'a:o:k1' }] },
    }),
  ).toBe(200)
  expect(received[3]).toMatchObject({
    chat: { id: 'spaces/D1', kind: 'dm' },
    mentioned: true,
    press: { data: 'a:o:k1', message: { chat: 'spaces/D1', id: 'spaces/D1/messages/B1' } },
  })

  // Being added to a space, and other bots, are not messages.
  expect(await send({ type: 'ADDED_TO_SPACE', space, user: alice })).toBe(200)
  expect(
    await send({
      ...dmEvent,
      user: { name: 'users/5', type: 'BOT' },
      message: { ...dmEvent.message, name: 'm9' },
    }),
  ).toBe(200)
  expect(received).toHaveLength(4)
})

test("sends in Chat's formatting, into the thread, with card buttons; edits replace text and buttons", async () => {
  const fake = google()
  const adapter = make(fake.base)
  const { handle, statuses } = testIO(HOOK)
  await adapter.start(handle)
  // Its start-up check calls the platform in the background; once on, every call is the test's own.
  await until(() => statuses.some((s) => s.state === 'on'))
  const ref = await adapter.send(
    { id: 'spaces/S1', kind: 'group', thread: 'spaces/S1/threads/T1' },
    {
      text: '**Allow** [the run](https://example.com)?',
      buttons: [[{ label: 'Allow once', data: 'a:o:k1' }]],
    },
  )
  expect(ref).toEqual({ chat: 'spaces/S1', id: 'spaces/S1/messages/M1' })
  const sent = fake.calls.at(-1)
  expect(sent?.path).toBe('/v1/spaces/S1/messages')
  expect(sent?.query.get('messageReplyOption')).toBe('REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD')
  expect(sent?.body).toEqual({
    text: '*Allow* <https://example.com|the run>?',
    thread: { name: 'spaces/S1/threads/T1' },
    cardsV2: [
      {
        cardId: 'buttons',
        card: {
          sections: [
            {
              widgets: [
                {
                  buttonList: {
                    buttons: [
                      {
                        text: 'Allow once',
                        onClick: {
                          action: { function: 'myr', parameters: [{ key: 'data', value: 'a:o:k1' }] },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  })

  await adapter.edit(ref, { text: 'Allowed by _Alice_' })
  expect(fake.calls.at(-1)).toMatchObject({
    method: 'PATCH',
    path: '/v1/spaces/S1/messages/M1',
    body: { text: 'Allowed by _Alice_', cardsV2: [] },
  })
  expect(fake.calls.at(-1)?.query.get('updateMask')).toBe('text,cardsV2')

  // A thread of another space is dropped rather than refused.
  await adapter.send({ id: 'spaces/S1', kind: 'group', thread: 'spaces/OTHER/threads/T' }, { text: 'hi' })
  expect(fake.calls.at(-1)?.query.get('messageReplyOption')).toBeNull()
  expect(fake.calls.at(-1)?.body).not.toHaveProperty('thread')
})

test("files go as links from the gateway's webhook address: an app cannot upload one", async () => {
  const fake = google()
  const adapter = make(fake.base)
  const dir = mkdtempSync(join(tmpdir(), 'myr-gchat-'))
  dirs.push(dir)
  const { handle, statuses } = testIO(HOOK, dir)
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(adapter.can.files).toBe(true)
  const ref = await adapter.sendFile(
    { id: 'spaces/S1', kind: 'group', thread: 'spaces/S1/threads/T1' },
    { name: 'notes.md', mimeType: 'text/markdown', data: new Uint8Array([35, 32, 104, 105]) },
  )
  expect(ref).toEqual({ chat: 'spaces/S1', id: 'spaces/S1/messages/M1' })
  const sent = fake.calls.at(-1)
  expect(sent?.body).toMatchObject({ thread: { name: 'spaces/S1/threads/T1' } })
  const text = ((sent?.body ?? {}) as { text: string }).text
  expect(text).toMatch(
    /^📎 <https:\/\/box\.example\/hooks\/channels\/googlechat\?file=[\w-]{32}\|notes\.md> \(the link works for 7 days\)$/,
  )
  // The download needs no Google token: the link is the key.
  const served = await adapter.webhook(new Request(/<([^|]+)\|/.exec(text)?.[1] ?? ''))
  expect(served.status).toBe(200)
  expect(served.headers.get('content-disposition')).toStartWith('attachment;')
  expect(await served.text()).toBe('# hi')
})

test("Markdown in Google Chat's marks, and as plain text for LINE", () => {
  const md = [
    '## Result',
    '**bold**, *italic*, _also_, ~~gone~~ and `**code**`',
    '- see [the docs](https://example.com/docs)',
    '```ts',
    'const x = **y**',
    '```',
  ].join('\n')
  expect(googleChatText(md)).toBe(
    [
      '*Result*',
      '*bold*, _italic_, _also_, ~gone~ and `**code**`',
      '• see <https://example.com/docs|the docs>',
      '```',
      'const x = **y**',
      '```',
    ].join('\n'),
  )
  expect(plainText(md)).toBe(
    [
      'Result',
      'bold, italic, also, gone and **code**',
      '• see the docs (https://example.com/docs)',
      'const x = **y**',
    ].join('\n'),
  )
})
