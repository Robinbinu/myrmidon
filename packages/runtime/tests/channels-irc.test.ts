import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'bun'
import { plainText, splitBytes } from '../src/channels/format.ts'
import { BUILT_IN_CHANNELS, type ChannelChats, ChannelHub, type ChannelKind } from '../src/channels/index.ts'
import { addressed, IrcAdapter, parseIrcLine } from '../src/channels/irc.ts'
import { fakeIO, until } from './fixtures/channel-io.ts'

interface Client {
  readonly socket: Socket<{ buf: string }>
  /** Every line the adapter sent, with when it arrived. */
  readonly lines: { line: string; at: number }[]
  send(line: string): void
}

/**
 * A stand-in IRC server: each line a client sends is recorded and passed to `onLine`, which answers. By default
 * it welcomes a client once it has sent NICK and USER.
 */
function ircServer(onLine?: (line: string, client: Client, nick: () => string) => boolean | undefined) {
  const clients: Client[] = []
  const server = Bun.listen<{ buf: string }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buf: '' }
        clients.push({
          socket,
          lines: [],
          send: (line) => void socket.write(`${line}\r\n`),
        })
      },
      data(socket, data) {
        const client = clients.find((c) => c.socket === socket)
        if (!client) return
        socket.data.buf += data.toString()
        let nl = socket.data.buf.indexOf('\r\n')
        while (nl >= 0) {
          const line = socket.data.buf.slice(0, nl)
          socket.data.buf = socket.data.buf.slice(nl + 2)
          client.lines.push({ line, at: Date.now() })
          const nick = () =>
            client.lines
              .filter((l) => l.line.startsWith('NICK '))
              .at(-1)
              ?.line.slice(5) ?? ''
          if (!onLine?.(line, client, nick) && line.startsWith('USER '))
            client.send(`:irc.test 001 ${nick()} :Welcome to the test network`)
          nl = socket.data.buf.indexOf('\r\n')
        }
      },
    },
  })
  servers.push(server)
  return { server, clients, port: server.port }
}

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: IrcAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

const settings = (port: number, extra: Record<string, string> = {}) => ({
  server: '127.0.0.1',
  port: String(port),
  tls: 'off',
  nick: 'myrbot',
  channels: 'room, #ops',
  ...extra,
})

test('lines parse with tags, prefixes and trailing parameters; mentions are found and stripped', () => {
  expect(parseIrcLine('@msgid=a\\sb;time=t :nick!u@h PRIVMSG #room :hello there')).toEqual({
    tags: { msgid: 'a b', time: 't' },
    prefix: 'nick!u@h',
    command: 'PRIVMSG',
    params: ['#room', 'hello there'],
  })
  expect(parseIrcLine('PING :irc.test')).toEqual({ tags: {}, command: 'PING', params: ['irc.test'] })
  expect(addressed('myrbot: deploy it', 'myrbot')).toEqual({ mentioned: true, text: 'deploy it' })
  expect(addressed('MyrBot, status?', 'myrbot')).toEqual({ mentioned: true, text: 'status?' })
  expect(addressed('ask myrbot later', 'myrbot')).toEqual({ mentioned: true, text: 'ask later' })
  expect(addressed('myrbots are great', 'myrbot').mentioned).toBe(false)
  expect(addressed('hi [bot]', '{bot}').mentioned).toBe(true)
})

test('Markdown becomes plain text, and lines are cut by bytes at spaces, never inside a character', () => {
  expect(plainText('# Title\n- **bold** and `a*b*c`\n[docs](https://d.test)\n```ts\nconst x = 1\n```')).toBe(
    'Title\n• bold and a*b*c\ndocs (https://d.test)\nconst x = 1',
  )
  expect(splitBytes('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
  const cut = splitBytes('😀'.repeat(5), 9)
  expect(cut).toEqual(['😀😀', '😀😀', '😀'])
})

test('check registers and says which nick; a taken nick falls back to nick_', async () => {
  const { port } = ircServer((line, client) => {
    if (line === 'NICK myrbot') client.send(':irc.test 433 * myrbot :Nickname is already in use')
    if (line === 'NICK myrbot_') client.send(':irc.test 001 myrbot_ :Welcome')
    return true
  })
  expect(await new IrcAdapter(settings(port)).check()).toBe('myrbot_ on 127.0.0.1')
})

test('it joins, answers PING, and maps DMs and addressed channel lines; the rest is ignored', async () => {
  const { port, clients } = ircServer()
  const adapter = new IrcAdapter(settings(port))
  adapters.push(adapter)
  const { handle, received, statuses } = fakeIO()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(statuses).toContainEqual({ state: 'on', account: 'myrbot on 127.0.0.1' })
  const client = clients[0]
  if (!client) throw new Error('no client')
  await until(() => client.lines.some((l) => l.line === 'JOIN #ops'))
  expect(client.lines.map((l) => l.line)).toContain('JOIN #room')

  client.send('PING :keepalive-1')
  await until(() => client.lines.some((l) => l.line === 'PONG :keepalive-1'))

  client.send(':alice!~al@host.example PRIVMSG myrbot :hello \u0002there\u0002')
  client.send(':alice!~al@host.example PRIVMSG #Room :myrbot: run the tests')
  client.send(':bob!~b@elsewhere PRIVMSG #room :just chatting')
  client.send(':alice!~al@host.example NOTICE myrbot :a notice')
  client.send(':alice!~al@host.example PRIVMSG myrbot :\u0001VERSION\u0001')
  client.send(':alice!~al@host.example PRIVMSG myrbot :\u0001ACTION waves\u0001')
  // IRC clients keep /commands for themselves, so the channel's are typed with !.
  client.send(':alice!~al@host.example PRIVMSG myrbot :!approve K7QX always')
  client.send(':alice!~al@host.example PRIVMSG myrbot :!important news')
  await until(() => received.length === 6)

  expect(received[0]).toMatchObject({
    chat: { id: 'alice', kind: 'dm' },
    sender: { id: 'alice!~al@host.example', name: 'alice' },
    text: 'hello there',
    mentioned: true,
  })
  // A nick is anyone's to take: no handle, so the allowlist can match only the full mask.
  expect(received[0]?.sender.handle).toBeUndefined()
  expect(received[1]).toMatchObject({
    chat: { id: '#room', kind: 'group', title: '#Room' },
    text: 'run the tests',
    mentioned: true,
  })
  expect(received[2]).toMatchObject({ chat: { id: '#room' }, mentioned: false })
  expect(received[3]?.text).toBe('* alice waves')
  expect(received[4]?.text).toBe('/approve K7QX always')
  expect(received[5]?.text).toBe('!important news')
})

test('sending: plain text, a line per line, cut to 400 bytes, paced after a burst', async () => {
  const { port, clients } = ircServer()
  const adapter = new IrcAdapter(settings(port), { burst: 2, everyMs: 150 })
  adapters.push(adapter)
  const { handle, statuses } = fakeIO()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  const client = clients[0]
  if (!client) throw new Error('no client')

  const long = 'é'.repeat(300)
  const t0 = Date.now()
  const ref = await adapter.send('#room', {
    text: `**Done** with [the report](https://x.test)\n\n${long}\nlast`,
  })
  expect(ref.chat).toBe('#room')
  await until(() => client.lines.filter((l) => l.line.startsWith('PRIVMSG #room :')).length === 4)
  const all = client.lines.filter((l) => l.line.startsWith('PRIVMSG #room :'))
  expect(all.map((l) => l.line.slice('PRIVMSG #room :'.length))).toEqual([
    'Done with the report (https://x.test)',
    'é'.repeat(200),
    'é'.repeat(100),
    'last',
  ])
  for (const l of all)
    expect(Buffer.byteLength(l.line.slice('PRIVMSG #room :'.length))).toBeLessThanOrEqual(400)
  // Two at once, then one per 150 ms: the last two waited their turn (measured where they were sent, since the
  // server's own clock bunches lines up when the machine is busy).
  expect(Date.now() - t0).toBeGreaterThanOrEqual(280)

  // A CR/LF in what is sent never starts a second command.
  await adapter.send('alice', { text: 'one\r\nQUIT :gotcha' })
  await until(() => client.lines.some((l) => l.line === 'PRIVMSG alice :QUIT :gotcha'))
  expect(client.lines.some((l) => l.line.startsWith('QUIT'))).toBe(false)
  await expect(adapter.send('bad target', { text: 'x' })).rejects.toThrow('not an IRC channel or nick')
})

test('SASL PLAIN with the password when offered; a refused password is an error, not retried', async () => {
  let auth = ''
  const sasl = (refuse: boolean) =>
    ircServer((line, client, nick) => {
      if (line === 'CAP LS 302') client.send(':irc.test CAP * LS :multi-prefix sasl=PLAIN,EXTERNAL')
      else if (line === 'CAP REQ :sasl') client.send(':irc.test CAP * ACK :sasl')
      else if (line === 'AUTHENTICATE PLAIN') client.send('AUTHENTICATE +')
      else if (line.startsWith('AUTHENTICATE ')) {
        auth = Buffer.from(line.slice(13), 'base64').toString()
        client.send(
          refuse ? ':irc.test 904 * :SASL authentication failed' : ':irc.test 903 * :SASL successful',
        )
      } else if (line === 'CAP END') client.send(`:irc.test 001 ${nick()} :Welcome`)
      // Registration waits for CAP END.
      return true
    })
  const ok = sasl(false)
  expect(await new IrcAdapter(settings(ok.port, { password: 'hunter2' })).check()).toBe('myrbot on 127.0.0.1')
  expect(auth).toBe('myrbot\0myrbot\0hunter2')
  expect(ok.clients[0]?.lines.some((l) => l.line.startsWith('PASS'))).toBe(false)

  const refused = sasl(true)
  await expect(new IrcAdapter(settings(refused.port, { password: 'wrong' })).check()).rejects.toThrow(
    'refused the password',
  )
  const adapter = new IrcAdapter(settings(refused.port, { password: 'wrong' }))
  adapters.push(adapter)
  const { handle, statuses } = fakeIO()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'error'))
  expect(statuses.at(-1)).toMatchObject({ state: 'error', error: expect.stringContaining('SASL') })
})

test('without SASL on offer the password goes as PASS before NICK; bad settings and dead servers say why', async () => {
  const { port, clients } = ircServer((line, client) => {
    if (line === 'CAP LS 302') client.send(':irc.test 421 * CAP :Unknown command')
    return undefined
  })
  expect(await new IrcAdapter(settings(port, { password: 'serverpw' })).check()).toBe('myrbot on 127.0.0.1')
  const lines = clients[0]?.lines.map((l) => l.line) ?? []
  expect(lines.indexOf('PASS serverpw')).toBeGreaterThan(-1)
  expect(lines.indexOf('PASS serverpw')).toBeLessThan(lines.indexOf('NICK myrbot'))

  await expect(new IrcAdapter(settings(port, { nick: '9lives' })).check()).rejects.toThrow('an IRC nick')
  await expect(new IrcAdapter({ ...settings(port), server: '' }).check()).rejects.toThrow('server address')
  const closed = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const deadPort = closed.port
  closed.stop(true)
  await expect(new IrcAdapter(settings(deadPort)).check()).rejects.toThrow('cannot reach')
})

test('a dropped connection is retried and comes back', async () => {
  const { port, clients } = ircServer()
  const adapter = new IrcAdapter(settings(port))
  adapters.push(adapter)
  const { handle, statuses } = fakeIO()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  clients[0]?.send('ERROR :Closing Link: (Ping timeout)')
  clients[0]?.socket.end()
  await until(() => statuses.some((s) => s.state === 'retrying'))
  expect(statuses.find((s) => s.state === 'retrying')).toMatchObject({
    error: expect.stringContaining('Closing Link'),
  })
  await until(() => clients.length === 2 && statuses.at(-1)?.state === 'on', 5000)
})

test('through the hub: a stranger gets a pairing code over PRIVMSG, and approving makes them the owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myr-irc-hub-'))
  const { port, clients } = ircServer()
  const chats: ChannelChats = {
    send: async () => ({ chatId: 'c1', colonyId: 'col-1', started: false }),
    rename: async () => undefined,
    stop: async () => {},
    onEvents: () => () => {},
    read: async () => [],
    decideApproval: async () => {},
    allowAlways: async () => {},
    artifact: async () => undefined,
  }
  const hub = new ChannelHub({ dir, chats, kinds: () => ({ irc: BUILT_IN_CHANNELS.irc as ChannelKind }) })
  try {
    await hub.configure('irc', { values: settings(port) })
    await until(() => hub.list()[0]?.status.state === 'on')
    const client = clients.at(-1)
    if (!client) throw new Error('no client')
    client.send(':alice!~al@host.example PRIVMSG myrbot :hello')
    await until(() => client.lines.some((l) => l.line.includes('myrmidon channels approve irc')))
    const code = /approve irc ([A-Z0-9]{8})/.exec(client.lines.map((l) => l.line).join('\n'))?.[1] ?? ''
    await hub.approve('irc', { code })
    await until(() =>
      client.lines.some((l) => l.line.startsWith("PRIVMSG alice :You're set up as the owner")),
    )
    expect(hub.list()[0]?.people).toMatchObject([
      { id: 'alice!~al@host.example', role: 'owner', dm: 'alice' },
    ])
  } finally {
    await hub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
