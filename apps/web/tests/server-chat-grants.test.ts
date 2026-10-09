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

test('PUT /api/chats/:id/allowed allows or takes back one kind of step for a chat, and checks what it is given', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-grants-'))
  homes.push(home)
  const calls: unknown[][] = []
  const chats = {
    allowInChat: async (...args: unknown[]) => {
      calls.push(args)
      return args[2] ? [args[1]] : []
    },
    onStream: () => () => {},
  } as unknown as ChatService
  const server = startServer({ home, port: 0, chats })
  servers.push(server)
  const url = new URL('/api/chats/chat-a/allowed', server.url.replace(/#.*$/, ''))
  const put = (body: unknown) =>
    fetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const allowed = await put({ grant: 'command', allowed: true })
  expect(allowed.status).toBe(200)
  expect(await allowed.json()).toEqual({ grants: ['command'] })
  expect(await (await put({ grant: 'command', allowed: false })).json()).toEqual({ grants: [] })
  expect((await put({ grant: 'everything', allowed: true })).status).toBe(400)
  expect((await put({ grant: 'file' })).status).toBe(400)
  expect(calls).toEqual([
    ['chat-a', 'command', true],
    ['chat-a', 'command', false],
  ])
  // Like approving each step, open to any device that can chat.
  expect(needsFull('PUT', '/api/chats/chat-a/allowed')).toBe(false)
})

test('PUT /api/chats/:id/readable opens or hides a folder for a chat, and checks what it is given', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-reads-'))
  homes.push(home)
  const calls: unknown[][] = []
  const chats = {
    allowReadInChat: async (...args: unknown[]) => {
      calls.push(args)
      if (args[1] === '~/.ssh')
        throw new Error('~/.ssh holds keys: only naming it in Settings → Tools opens it')
      return args[2] ? [args[1]] : []
    },
    onStream: () => () => {},
  } as unknown as ChatService
  const server = startServer({ home, port: 0, chats })
  servers.push(server)
  const url = new URL('/api/chats/chat-a/readable', server.url.replace(/#.*$/, ''))
  const put = (body: unknown) =>
    fetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  expect(await (await put({ folder: '/notes', allowed: true })).json()).toEqual({ reads: ['/notes'] })
  expect(await (await put({ folder: '/notes', allowed: false })).json()).toEqual({ reads: [] })
  const refused = await put({ folder: '~/.ssh', allowed: true })
  expect(refused.status).toBe(422)
  expect((await refused.json()).error).toContain('Settings')
  expect((await put({ folder: '', allowed: true })).status).toBe(400)
  expect((await put({ folder: '/notes' })).status).toBe(400)
  expect(calls).toEqual([
    ['chat-a', '/notes', true],
    ['chat-a', '/notes', false],
    ['chat-a', '~/.ssh', true],
  ])
  // Like approving the request it answers, open to any device that can chat.
  expect(needsFull('PUT', '/api/chats/chat-a/readable')).toBe(false)
})
