import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ChatService, ChatShelf } from '@myrmidon/runtime'
import { needsFull } from '../src/devices.ts'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function serve() {
  const home = mkdtempSync(join(tmpdir(), 'myr-shelf-route-'))
  homes.push(home)
  const shelf = new ChatShelf(home)
  const renamed: string[] = []
  const chats = {
    file: async (chatId: string, patch: Parameters<ChatShelf['file']>[1]) => {
      if (chatId !== 'chat-a') throw new Error('no such chat')
      return shelf.file(chatId, patch)
    },
    rename: async (_chatId: string, title: string) => {
      renamed.push(title)
      return title
    },
    onStream: () => () => {},
  } as unknown as ChatService
  const server = startServer({ home, port: 0, chats, shelf })
  servers.push(server)
  const at = (path: string) => new URL(path, server.url.replace(/#.*$/, ''))
  const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(at(path), { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { call, renamed, shelf }
}

test('groups are made, renamed and deleted, and a chat is pinned, archived and filed in one', async () => {
  const { call, renamed, shelf } = serve()
  const made = await call('POST', '/api/chat-groups', { name: 'Client work' })
  expect(made.body).toMatchObject({ name: 'Client work' })
  const id = made.body.id as string
  expect((await call('GET', '/api/chat-groups')).body).toEqual({ groups: [{ id, name: 'Client work' }] })
  expect((await call('PATCH', `/api/chat-groups/${id}`, { name: 'Clients' })).body).toEqual({
    id,
    name: 'Clients',
  })

  const filed = await call('PATCH', '/api/chats/chat-a', { pinned: true, group: id, title: 'Invoices' })
  expect(filed.status).toBe(200)
  expect(filed.body.place).toMatchObject({ group: id })
  expect(renamed).toEqual(['Invoices'])
  expect(
    (await call('PATCH', '/api/chats/chat-a', { group: null, archived: true })).body.place,
  ).toMatchObject({
    archivedAt: expect.any(String),
  })
  expect(shelf.place('chat-a').group).toBeUndefined()

  expect((await call('PATCH', '/api/chats/chat-a', { pinned: 'yes' })).status).toBe(400)
  expect((await call('PATCH', '/api/chats/chat-a', {})).status).toBe(400)
  expect((await call('PATCH', '/api/chats/chat-zzz', { pinned: true })).body.error).toBe('no such chat')
  expect((await call('POST', '/api/chat-groups', { name: ' ' })).status).toBe(400)

  await call('DELETE', `/api/chat-groups/${id}`)
  expect((await call('GET', '/api/chat-groups')).body).toEqual({ groups: [] })
})

test('filing chats and their groups is open to a chats-only device, as renaming and deleting chats are', () => {
  expect(needsFull('POST', '/api/chat-groups')).toBe(false)
  expect(needsFull('PATCH', '/api/chats/chat-a')).toBe(false)
})
