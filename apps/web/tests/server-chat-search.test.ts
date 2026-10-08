import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatService } from '@myrmidon/runtime'
import { needsFull } from '../src/devices.ts'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

test('GET /api/chats/search answers the chats whose messages match, for any device that can chat', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-search-'))
  homes.push(home)
  const asked: string[] = []
  const chats = {
    search: async (q: string) => {
      asked.push(q)
      return [{ chatId: 'chat-a', from: 'lead', snippet: '…the total is 391 units…' }]
    },
    onStream: () => () => {},
  } as unknown as ChatService
  const server = startServer({ home, port: 0, chats })
  servers.push(server)
  const url = new URL('/api/chats/search?q=391%20units', server.url.replace(/#.*$/, ''))
  const auth = { authorization: `Bearer ${server.token}` }

  expect((await fetch(url)).status).toBe(401)
  const res = await fetch(url, { headers: auth })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([{ chatId: 'chat-a', from: 'lead', snippet: '…the total is 391 units…' }])
  expect(asked).toEqual(['391 units'])
  // Not shadowed by /api/chats/:chatId, and open to chats-only devices like the rest of the chat list.
  expect(needsFull('GET', '/api/chats/search')).toBe(false)
})
