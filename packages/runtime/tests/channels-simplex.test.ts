import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { type AdapterIO, type AdapterStatus, type Inbound, SimplexAdapter } from '../src/channels/index.ts'

const servers: { stop(force?: boolean): unknown }[] = []
const adapters: SimplexAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const s of servers.splice(0)) s.stop(true)
})

/** A stand-in for `simplex-chat -p`: answers commands by corrId, records them, and can push events. */
function daemon(options: { user?: boolean } = {}) {
  const commands: string[] = []
  const sockets = new Set<ServerWebSocket<unknown>>()
  let item = 100
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response('upgrade', { status: 426 })
    },
    websocket: {
      open: (ws) => {
        sockets.add(ws)
      },
      close: (ws) => {
        sockets.delete(ws)
      },
      message(ws, raw) {
        const { corrId, cmd } = JSON.parse(String(raw)) as { corrId: string; cmd: string }
        commands.push(cmd)
        const reply = (resp: unknown) => {
          ws.send(JSON.stringify({ corrId, resp }))
        }
        if (cmd === '/user')
          reply(
            options.user === false
              ? { type: 'chatCmdError', chatError: { type: 'error', errorType: { type: 'noActiveUser' } } }
              : {
                  type: 'activeUser',
                  user: { localDisplayName: 'myrbot', profile: { displayName: 'myrbot' } },
                },
          )
        else if (cmd.startsWith('/_send'))
          reply({ type: 'newChatItems', chatItems: [{ chatItem: { meta: { itemId: ++item } } }] })
        else if (cmd.startsWith('/_accept')) reply({ type: 'acceptingContactRequest' })
      },
    },
  })
  servers.push(server)
  const push = (resp: unknown) => {
    for (const ws of sockets) ws.send(JSON.stringify({ resp }))
  }
  return { commands, push, sockets, url: `ws://127.0.0.1:${server.port}` }
}

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
    dir: mkdtempSync(join(tmpdir(), 'simplex-')),
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

const direct = (contactId: number, text: string, extra: Record<string, unknown> = {}) => ({
  chatInfo: {
    type: 'direct',
    contact: { contactId, localDisplayName: 'alice', profile: { displayName: 'Alice' } },
  },
  chatItem: {
    chatDir: { type: 'directRcv' },
    meta: { itemId: Math.floor(Math.random() * 1e6), itemTs: '2026-10-08T10:00:00Z' },
    content: { type: 'rcvMsgContent', msgContent: { type: 'text', text } },
    ...extra,
  },
})

const inGroup = (text: string, meta: Record<string, unknown> = {}, dir = 'groupRcv') => ({
  chatInfo: { type: 'group', groupInfo: { groupId: 3, localDisplayName: 'team' } },
  chatItem: {
    chatDir: { type: dir, groupMember: { memberId: 'm-9', memberContactId: 5, localDisplayName: 'alice' } },
    meta: { itemId: Math.floor(Math.random() * 1e6), ...meta },
    content: { type: 'rcvMsgContent', msgContent: { type: 'text', text } },
  },
})

test('the check reads the active profile; no profile or no daemon is an error', async () => {
  const { url } = daemon()
  expect(await new SimplexAdapter(url).check()).toBe('myrbot')
  const empty = daemon({ user: false })
  await expect(new SimplexAdapter(empty.url).check()).rejects.toThrow('no user profile')
  await expect(new SimplexAdapter('ws://127.0.0.1:1').check()).rejects.toThrow('cannot reach simplex-chat')
})

test('chat items become messages: contacts by id, groups by group:id, mentions, our own ignored', async () => {
  const d = daemon()
  const adapter = new SimplexAdapter(d.url)
  adapters.push(adapter)
  const { handle, received, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  expect(statuses.find((s) => s.state === 'on')).toEqual({ state: 'on', account: 'myrbot' })
  d.push({
    type: 'newChatItems',
    chatItems: [
      direct(5, 'hello'),
      inGroup('@myrbot what now?'),
      inGroup('chatting among ourselves'),
      inGroup('flagged', { userMention: true }),
      inGroup('my own words', {}, 'groupSnd'),
    ],
  })
  await until(() => received.length === 4)
  expect(received[0]).toMatchObject({
    chat: { id: '5', kind: 'dm' },
    sender: { id: '5', name: 'alice' },
    text: 'hello',
    mentioned: true,
    time: '2026-10-08T10:00:00.000Z',
  })
  expect(received[1]).toMatchObject({
    chat: { id: 'group:3', kind: 'group', title: 'team' },
    sender: { id: '5', name: 'alice' },
    text: 'what now?',
    mentioned: true,
  })
  expect(received.slice(2).map((m) => [m.text, m.mentioned])).toEqual([
    ['chatting among ourselves', false],
    ['flagged', true],
  ])
})

test('contact requests are accepted (the hub decides who is acted on)', async () => {
  const d = daemon()
  const adapter = new SimplexAdapter(d.url)
  adapters.push(adapter)
  const { handle, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  d.push({ type: 'contactRequest', contactRequest: { contactRequestId: 7, localDisplayName: 'stranger' } })
  await until(() => d.commands.includes('/_accept 7'))
})

test('sends address contacts and groups by id, as JSON, in SimpleX markdown', async () => {
  const d = daemon()
  const adapter = new SimplexAdapter(d.url)
  adapters.push(adapter)
  const { handle, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  const ref = await adapter.send({ id: '5', kind: 'dm' }, { text: '**Done** in *2m*' })
  expect(ref).toEqual({ chat: '5', id: '101' })
  await adapter.send('group:3', { text: 'hi "all"' })
  const sends = d.commands.filter((c) => c.startsWith('/_send'))
  expect(sends[0]).toBe(
    `/_send @5 json ${JSON.stringify([{ msgContent: { type: 'text', text: '*Done* in _2m_' } }])}`,
  )
  expect(sends[1]).toBe(
    `/_send #3 json ${JSON.stringify([{ msgContent: { type: 'text', text: 'hi "all"' } }])}`,
  )
})

test('a file still downloading is received first, then handed on with its message', async () => {
  const d = daemon()
  const adapter = new SimplexAdapter(d.url)
  adapters.push(adapter)
  const { handle, received, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  const path = join(handle.dir, 'photo.jpg')
  writeFileSync(path, new Uint8Array([9, 8, 7]))
  const item = direct(5, 'look', { file: { fileId: 12, fileName: 'photo.jpg', fileSize: 3 } })
  item.chatItem.content.msgContent.type = 'image'
  d.push({ type: 'newChatItems', chatItems: [item] })
  await until(() => d.commands.includes('/freceive 12'))
  expect(received).toHaveLength(0)
  d.push({
    type: 'rcvFileComplete',
    chatItem: { chatItem: { file: { fileId: 12, fileSource: { filePath: path } } } },
  })
  await until(() => received.length === 1)
  const file = received[0]?.files?.[0]
  expect(file).toMatchObject({ kind: 'image', name: 'photo.jpg', mimeType: 'image/jpeg', size: 3 })
  expect([...((await file?.read()) ?? [])]).toEqual([9, 8, 7])
})

test('a dropped connection is retried, and comes back', async () => {
  const d = daemon()
  const adapter = new SimplexAdapter(d.url)
  adapters.push(adapter)
  const { handle, statuses } = io()
  await adapter.start(handle)
  await until(() => statuses.some((s) => s.state === 'on'))
  for (const ws of d.sockets) ws.close()
  await until(() => statuses.some((s) => s.state === 'retrying'))
  await until(() => statuses.filter((s) => s.state === 'on').length === 2, 6000)
})
