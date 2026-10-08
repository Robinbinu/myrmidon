import { afterEach, expect, test } from 'bun:test'
import { oauth1Signature, XAdapter, xPosts, xWeight } from '../src/channels/x.ts'
import { fakeIO, until } from './fixtures/channel-io.ts'

const KEYS = { apiKey: 'ck', apiSecret: 'cs', accessToken: 'at', accessSecret: 'as' }

type Call = { method: string; path: string; query: Record<string, string>; body?: Record<string, unknown> }

/**
 * A stand-in for the X API: every request must carry a valid OAuth 1.0a signature for KEYS (checked here with the
 * same base string X builds); each path answers from a handler.
 */
function xApi(handlers: Record<string, (call: Call, n: number) => Response | object>) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const query = Object.fromEntries(url.searchParams)
      const auth = req.headers.get('authorization') ?? ''
      const oauth = Object.fromEntries(
        [...auth.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1] ?? '', decodeURIComponent(m[2] ?? '')]),
      )
      const { oauth_signature: signature, ...signed } = oauth
      const expected = oauth1Signature(
        req.method,
        `${url.origin}${url.pathname}`,
        { ...query, ...signed },
        'cs',
        oauth.oauth_token === 'at' ? 'as' : 'wrong',
      )
      if (!auth.startsWith('OAuth ') || signature !== expected || oauth.oauth_consumer_key !== 'ck')
        return Response.json({ title: 'Unauthorized', status: 401 }, { status: 401 })
      const body = req.method === 'POST' ? ((await req.json()) as Record<string, unknown>) : undefined
      const call: Call = { method: req.method, path: url.pathname, query, ...(body ? { body } : {}) }
      calls.push(call)
      const key = `${req.method} ${url.pathname}`
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      const handler = handlers[key]
      if (!handler) return Response.json({ title: 'Not Found' }, { status: 404 })
      const answer = handler(call, n)
      return answer instanceof Response ? answer : Response.json(answer)
    },
  })
  servers.push(server)
  return { calls, api: `http://127.0.0.1:${server.port}` }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: XAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

const ME = () => ({ data: { id: '9', username: 'myrbot', name: 'Myr' } })
const BY = (call: Call) => ({
  data: (call.query.usernames ?? '')
    .split(',')
    .filter((u) => u.toLowerCase() === 'alice')
    .map(() => ({ id: '1', username: 'alice' })),
})

test("the OAuth 1.0a signature matches X's documented example", () => {
  expect(
    oauth1Signature(
      'POST',
      'https://api.twitter.com/1.1/statuses/update.json',
      {
        status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
        include_entities: 'true',
        oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
        oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: '1318622958',
        oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
        oauth_version: '1.0',
      },
      'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    ),
  ).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=')
})

test('posts are cut to 280 weighted characters: CJK and emoji count two, a link 23', () => {
  expect(xWeight('hello')).toBe(5)
  expect(xWeight('日本')).toBe(4)
  expect(xWeight(`see https://example.com/${'a'.repeat(100)}`)).toBe(4 + 23)
  const cjk = xPosts('漢'.repeat(200))
  expect(cjk.length).toBe(2)
  for (const p of cjk) expect(xWeight(p)).toBeLessThanOrEqual(280)
  const words = xPosts(Array.from({ length: 80 }, (_, i) => `w${i}`).join(' '))
  expect(words.length).toBe(2)
  expect(words[0]?.endsWith(' ')).toBe(false)
  expect(words.join(' ')).toBe(Array.from({ length: 80 }, (_, i) => `w${i}`).join(' '))
})

test('check signs in, says the account, and looks the listed accounts up; refusals say why', async () => {
  const { api } = xApi({ 'GET /2/users/me': ME, 'GET /2/users/by': BY })
  expect(await new XAdapter({ ...KEYS, replyTo: '@alice, 42' }, api).check()).toBe('@myrbot')
  await expect(new XAdapter({ ...KEYS, replyTo: '@nobody' }, api).check()).rejects.toThrow(
    'no X account @nobody',
  )
  await expect(new XAdapter({ ...KEYS, replyTo: '' }, api).check()).rejects.toThrow('at least one account')
  await expect(new XAdapter({ ...KEYS, accessSecret: 'bad', replyTo: 'alice' }, api).check()).rejects.toThrow(
    'X refused these keys',
  )
  const free = xApi({
    'GET /2/users/me': () =>
      Response.json({ title: 'Client Forbidden', reason: 'client-not-enrolled' }, { status: 403 }),
  })
  await expect(new XAdapter({ ...KEYS, replyTo: 'alice' }, free.api).check()).rejects.toThrow('paid X API')
})

test('mentions from listed accounts and DMs come in; others, its own and reposts are dropped; since_id is kept', async () => {
  const now = new Date().toISOString()
  const { calls, api } = xApi({
    'GET /2/users/me': ME,
    'GET /2/users/by': BY,
    'GET /2/users/9/mentions': (_c, n) =>
      n === 1
        ? {
            data: [
              {
                id: '102',
                text: '@myrbot @carol and also &amp; this',
                author_id: '1',
                conversation_id: '100',
              },
              {
                id: '101',
                text: '@myrbot do the thing',
                author_id: '1',
                conversation_id: '100',
                created_at: now,
              },
              { id: '103', text: '@myrbot hi', author_id: '666', conversation_id: '103' },
              { id: '104', text: '@myrbot me', author_id: '9', conversation_id: '104' },
              {
                id: '105',
                text: 'RT @myrbot hi',
                author_id: '1',
                conversation_id: '105',
                referenced_tweets: [{ type: 'retweeted', id: '1' }],
              },
            ],
            includes: { users: [{ id: '1', username: 'alice', name: 'Alice' }] },
            meta: { newest_id: '105', result_count: 5 },
          }
        : { meta: { result_count: 0 } },
    'GET /2/dm_events': () => ({
      data: [
        {
          id: '501',
          event_type: 'MessageCreate',
          text: 'hi in private',
          sender_id: '7',
          dm_conversation_id: '7-9',
          created_at: now,
        },
        {
          id: '400',
          event_type: 'MessageCreate',
          text: 'old',
          sender_id: '7',
          dm_conversation_id: '7-9',
          created_at: '2020-01-01T00:00:00.000Z',
        },
      ],
      includes: { users: [{ id: '7', username: 'dave', name: 'Dave' }] },
    }),
  })
  const adapter = new XAdapter({ ...KEYS, replyTo: 'alice' }, api, 40)
  adapters.push(adapter)
  const { handle, received, statuses, kv } = fakeIO()
  await adapter.start(handle)
  await until(() => calls.filter((c) => c.path === '/2/users/9/mentions').length >= 2)
  expect(statuses).toContainEqual({ state: 'on', account: '@myrbot' })
  const mentions = calls.filter((c) => c.path === '/2/users/9/mentions')
  expect(mentions[0]?.query.start_time).toBeDefined()
  expect(mentions[0]?.query.since_id).toBeUndefined()
  expect(mentions[1]?.query.since_id).toBe('105')
  expect(kv.get('since')).toBe('105')

  expect(received.map((m) => m.messageId)).toEqual(['101', '102', '501'])
  expect(received[0]).toMatchObject({
    chat: { id: '100', kind: 'group' },
    sender: { id: '1', name: 'Alice', handle: 'alice' },
    text: 'do the thing',
    mentioned: true,
  })
  expect(received[1]?.text).toBe('and also & this')
  expect(received[2]).toMatchObject({
    chat: { id: 'dm:7-9', kind: 'dm' },
    sender: { id: '7', handle: 'dave' },
    text: 'hi in private',
  })
  expect(kv.get('dm-since')).toBe('501')
  expect(kv.get('reply:100')).toBe('102')
})

test('answers thread under the mention in posts of 280; DMs go to their conversation; nothing else is posted', async () => {
  let next = 900
  const { calls, api } = xApi({
    'GET /2/users/me': ME,
    'GET /2/users/by': BY,
    'GET /2/users/9/mentions': (_c, n) =>
      n === 1
        ? {
            data: [{ id: '201', text: '@myrbot go', author_id: '1', conversation_id: '200' }],
            meta: { newest_id: '201' },
          }
        : { meta: {} },
    'GET /2/dm_events': () => Response.json({ title: 'Forbidden' }, { status: 403 }),
    'POST /2/tweets': () => ({ data: { id: String(++next), text: '' } }),
    'POST /2/dm_conversations/7-9/messages': () => ({ data: { dm_event_id: '777' } }),
  })
  const adapter = new XAdapter({ ...KEYS, replyTo: '1' }, api, 40)
  adapters.push(adapter)
  const { handle, received, logs } = fakeIO()
  await adapter.start(handle)
  await until(() => received.length === 1)
  await until(() => logs.some((l) => l.includes('direct messages are off')))

  const long = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ')
  const ref = await adapter.send('200', { text: `**Done:** ${long}` })
  const posts = calls.filter((c) => c.path === '/2/tweets')
  expect(posts.length).toBe(2)
  expect(posts[0]?.body).toMatchObject({ reply: { in_reply_to_tweet_id: '201' } })
  expect(String(posts[0]?.body?.text).startsWith('Done: word0')).toBe(true)
  expect(posts[1]?.body).toMatchObject({ reply: { in_reply_to_tweet_id: '901' } })
  expect(ref).toEqual({ chat: '200', id: '902' })

  expect(await adapter.send('dm:7-9', { text: 'private answer' })).toEqual({ chat: 'dm:7-9', id: '777' })
  expect(calls.at(-1)?.body).toEqual({ text: 'private answer' })
  await expect(adapter.send('300', { text: 'unsolicited' })).rejects.toThrow('listed account')
  expect(calls.filter((c) => c.path === '/2/tweets').length).toBe(2)
})

test('refused keys stop it with the reason; rate limits are waited out', async () => {
  const refused = xApi({ 'GET /2/users/me': ME })
  const a = new XAdapter({ ...KEYS, apiKey: 'other', replyTo: '1' }, refused.api, 40)
  adapters.push(a)
  const first = fakeIO()
  await a.start(first.handle)
  await until(() => first.statuses.some((s) => s.state === 'error'))
  expect(first.statuses.at(-1)).toMatchObject({ error: expect.stringContaining('refused these keys') })

  const limited = xApi({
    'GET /2/users/me': ME,
    'GET /2/users/9/mentions': () =>
      new Response(JSON.stringify({ title: 'Too Many Requests' }), {
        status: 429,
        headers: { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 600) },
      }),
  })
  const b = new XAdapter({ ...KEYS, replyTo: '1' }, limited.api, 40)
  adapters.push(b)
  const second = fakeIO()
  await b.start(second.handle)
  await until(() => second.statuses.some((s) => s.state === 'retrying'))
  expect(second.statuses.at(-1)).toMatchObject({ error: expect.stringContaining('429') })
})
