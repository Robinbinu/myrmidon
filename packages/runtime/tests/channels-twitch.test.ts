import { afterEach, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { TwitchAdapter } from '../src/channels/twitch.ts'
import { fakeIO, until } from './fixtures/channel-io.ts'

/**
 * A stand-in for Twitch: `/oauth2/validate` answers for the token, and the WebSocket speaks chat IRC (welcoming a
 * client after PASS and NICK, unless the token is refused).
 */
function twitch(options: { validate?: (auth: string) => Response; refuseLogin?: boolean } = {}) {
  const sockets: ServerWebSocket<unknown>[] = []
  const lines: { line: string; at: number }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/oauth2/validate') {
        const auth = req.headers.get('authorization') ?? ''
        if (options.validate) return options.validate(auth)
        return auth === 'OAuth goodtoken'
          ? Response.json({
              login: 'myrbot',
              user_id: '9',
              scopes: ['chat:read', 'chat:edit'],
              expires_in: 0,
            })
          : Response.json({ status: 401, message: 'invalid access token' }, { status: 401 })
      }
      if (srv.upgrade(req)) return undefined
      return new Response('no', { status: 404 })
    },
    websocket: {
      open(ws) {
        sockets.push(ws)
      },
      message(ws, data) {
        for (const line of String(data).split('\r\n').filter(Boolean)) {
          lines.push({ line, at: Date.now() })
          if (line.startsWith('NICK '))
            ws.send(
              options.refuseLogin
                ? ':tmi.twitch.tv NOTICE * :Login authentication failed'
                : `:tmi.twitch.tv 001 ${line.slice(5)} :Welcome, GLHF!`,
            )
        }
      },
    },
  })
  servers.push(server)
  const base = `127.0.0.1:${server.port}`
  return { sockets, lines, endpoints: { irc: `ws://${base}/`, id: `http://${base}` } }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: TwitchAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

const values = { username: 'MyrBot', token: 'oauth:goodtoken', channels: '#alice, Ops' }

test('check validates the token: the account, its login and its chat scopes', async () => {
  const fake = twitch()
  expect(await new TwitchAdapter(values, fake.endpoints).check()).toBe('@myrbot')
  await expect(new TwitchAdapter({ ...values, token: 'bad' }, fake.endpoints).check()).rejects.toThrow(
    'Twitch refused this token',
  )
  await expect(
    new TwitchAdapter({ ...values, username: 'someoneelse' }, fake.endpoints).check(),
  ).rejects.toThrow('this token is for @myrbot, not @someoneelse')
  const scopeless = twitch({
    validate: () => Response.json({ login: 'myrbot', scopes: ['chat:read'] }),
  })
  await expect(new TwitchAdapter(values, scopeless.endpoints).check()).rejects.toThrow('chat:edit')
})

test('it signs in, joins, answers PING, and takes channel messages as groups that mention it or not', async () => {
  const fake = twitch()
  const adapter = new TwitchAdapter(values, fake.endpoints)
  adapters.push(adapter)
  const { handle, received, statuses } = fakeIO()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(statuses).toContainEqual({ state: 'on', account: '@myrbot' })
  const said = fake.lines.map((l) => l.line)
  expect(said).toContain('CAP REQ :twitch.tv/tags twitch.tv/commands')
  expect(said).toContain('PASS oauth:goodtoken')
  await until(() => fake.lines.some((l) => l.line === 'JOIN #ops'))
  expect(fake.lines.map((l) => l.line)).toContain('JOIN #alice')

  const ws = fake.sockets[0]
  ws?.send('PING :tmi.twitch.tv')
  await until(() => fake.lines.some((l) => l.line === 'PONG :tmi.twitch.tv'))
  const tags = (id: string, extra = '') =>
    `@badges=;display-name=Alice;id=${id};tmi-sent-ts=1700000000000;user-id=1234${extra}`
  ws?.send(`${tags('m1')} :alice!alice@alice.tmi.twitch.tv PRIVMSG #alice :@MyrBot what is up`)
  ws?.send(`${tags('m2')} :alice!alice@alice.tmi.twitch.tv PRIVMSG #alice :hello chat`)
  ws?.send(
    `${tags('m3', ';reply-parent-user-login=myrbot;reply-parent-msg-id=x')} :alice!alice@alice.tmi.twitch.tv PRIVMSG #alice :@myrbot thanks`,
  )
  ws?.send('@id=m4;user-id=9 :myrbot!myrbot@myrbot.tmi.twitch.tv PRIVMSG #alice :my own line')
  ws?.send(`${tags('m5')} :alice!alice@alice.tmi.twitch.tv PRIVMSG #alice :@myrbot !status`)
  await until(() => received.length === 4)
  expect(received[0]).toMatchObject({
    messageId: 'm1',
    chat: { id: '#alice', kind: 'group' },
    sender: { id: '1234', name: 'Alice', handle: 'alice' },
    text: 'what is up',
    mentioned: true,
    time: new Date(1700000000000).toISOString(),
  })
  expect(received[1]).toMatchObject({ text: 'hello chat', mentioned: false })
  expect(received[2]).toMatchObject({ text: 'thanks', mentioned: true })
  expect(received[3]).toMatchObject({ text: '/status', mentioned: true })
})

test('sending: one line of plain text, 500 characters a message, a reply to the mention, paced', async () => {
  const fake = twitch()
  const adapter = new TwitchAdapter(values, fake.endpoints, { burst: 1, everyMs: 120 })
  adapters.push(adapter)
  const { handle, received, statuses } = fakeIO()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  fake.sockets[0]?.send('@id=m9;user-id=1 :alice!alice@alice.tmi.twitch.tv PRIVMSG #alice :@myrbot go')
  await until(() => received.length === 1)

  const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')
  const t0 = Date.now()
  await adapter.send('#alice', { text: `**Done**\n\n${words}` })
  // One at once, then one per 120 ms.
  expect(Date.now() - t0).toBeGreaterThanOrEqual(110)
  await until(() => fake.lines.filter((l) => l.line.includes('PRIVMSG #alice :')).length === 2)
  const sent = fake.lines.filter((l) => l.line.includes('PRIVMSG #alice :'))
  for (const l of sent) {
    expect(l.line.startsWith('@reply-parent-msg-id=m9 PRIVMSG #alice :')).toBe(true)
    expect(l.line.split('PRIVMSG #alice :')[1]?.length).toBeLessThanOrEqual(500)
    expect(l.line).not.toContain('\n')
  }
  expect(sent[0]?.line).toContain(':Done word0 word1')
  await expect(adapter.send('alice', { text: 'x' })).rejects.toThrow('not a Twitch channel')
})

test('a refused sign-in or token is an error; RECONNECT connects again', async () => {
  const refused = twitch({ refuseLogin: true })
  const a = new TwitchAdapter(values, refused.endpoints)
  adapters.push(a)
  const first = fakeIO()
  await a.start(first.handle)
  await until(() => first.statuses.some((s) => s.state === 'error'))
  expect(first.statuses.at(-1)).toMatchObject({
    error: expect.stringContaining('Login authentication failed'),
  })

  const badToken = twitch()
  const b = new TwitchAdapter({ ...values, token: 'nope' }, badToken.endpoints)
  adapters.push(b)
  const second = fakeIO()
  await b.start(second.handle)
  await until(() => second.statuses.some((s) => s.state === 'error'))
  expect(badToken.sockets.length).toBe(0)

  const fake = twitch()
  const c = new TwitchAdapter(values, fake.endpoints)
  adapters.push(c)
  const third = fakeIO()
  await c.start(third.handle)
  await until(() => third.statuses.some((s) => s.state === 'on'))
  fake.sockets[0]?.send(':tmi.twitch.tv RECONNECT')
  await until(() => third.statuses.some((s) => s.state === 'retrying'))
  await until(() => fake.sockets.length === 2 && third.statuses.at(-1)?.state === 'on', 5000)
})
