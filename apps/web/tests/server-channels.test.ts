import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatService } from '@myrmidon/runtime'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

const CODE = 'K7QX3MNP'

/** A gateway whose Telegram channel (switched off) has one request waiting, sent the code above. */
function serve() {
  const home = mkdtempSync(join(tmpdir(), 'myr-channels-server-'))
  homes.push(home)
  mkdirSync(join(home, 'channels'), { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(home, 'channels', 'channels.json'),
    JSON.stringify({
      telegram: {
        values: { token: 'tok' },
        enabled: false,
        pending: [
          {
            id: 'req1',
            codeHash: createHash('sha256').update(CODE).digest('hex'),
            kind: 'person',
            sender: { id: '100', name: 'Alice' },
            chat: { id: '100', kind: 'dm' },
            createdAt: new Date(now).toISOString(),
            expires: new Date(now + 60 * 60_000).toISOString(),
          },
        ],
      },
    }),
  )
  const chats = {
    list: async () => [],
    onEvents: () => () => {},
    onStream: () => () => {},
  } as unknown as ChatService
  const server = startServer({ home, port: 0, chats })
  servers.push(server)
  const origin = new URL(server.url.replace(/#.*$/, ''))
  const call = (path: string, body: unknown) =>
    fetch(new URL(path, origin), {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { call }
}

test('approving a channel request takes the code it was sent, never its id alone', async () => {
  const { call } = serve()
  const byId = await call('/api/channels/telegram/approve', { request: 'req1' })
  expect(byId.status).toBe(400)
  const wrong = await call('/api/channels/telegram/approve', { code: 'AAAAAAAA', request: 'req1' })
  expect(wrong.status).toBe(404)
  const right = await call('/api/channels/telegram/approve', { code: CODE.toLowerCase(), request: 'req1' })
  expect(right.status).toBe(200)
  expect((await right.json()).person).toMatchObject({ id: '100', role: 'owner' })
})

test('only Settings makes an approved person the owner', async () => {
  const { call } = serve()
  expect((await call('/api/channels/telegram/owner', { person: '100' })).status).toBe(404)
  await call('/api/channels/telegram/approve', { code: CODE })
  expect((await call('/api/channels/telegram/owner', { person: '100' })).status).toBe(200)
})
