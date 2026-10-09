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

// Replaces the chat grants route (`/api/chats/:id/allowed`): a chat's level of the permission model.
test('GET and PUT /api/chats/:id/permissions read and set a chat level, and check what they are given', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-chat-perms-'))
  homes.push(home)
  const calls: unknown[][] = []
  const chats = {
    chatPermissions: async () => ({ rules: [{ kind: 'edit', target: '*', decision: 'allow' }] }),
    setChatPermissions: async (...args: unknown[]) => {
      calls.push(args)
      return args[1]
    },
    onStream: () => () => {},
  } as unknown as ChatService
  const server = startServer({ home, port: 0, chats })
  servers.push(server)
  const url = new URL('/api/chats/chat-a/permissions', server.url.replace(/#.*$/, ''))
  const call = (method: string, body?: unknown) =>
    fetch(url, {
      method,
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })

  expect(await (await call('GET')).json()).toEqual({
    permissions: { rules: [{ kind: 'edit', target: '*', decision: 'allow' }] },
  })
  const level = { preset: 'ask', rules: [{ kind: 'command', target: 'bun test', decision: 'allow' }] }
  const put = await call('PUT', level)
  expect(put.status).toBe(200)
  expect(await put.json()).toEqual({ permissions: level })
  expect((await call('PUT', { preset: 'yolo', rules: [] })).status).toBe(400)
  expect((await call('PUT', { preset: 'ask' })).status).toBe(400)
  expect(calls).toEqual([['chat-a', level]])
  // A chat's preset can be Full access: only a device with full access may change it.
  expect(needsFull('PUT', '/api/chats/chat-a/permissions')).toBe(true)
  expect(needsFull('GET', '/api/chats/chat-a/permissions')).toBe(false)
})

test('an approval can be remembered: the call is decided, then the rule saved at the level asked for', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-remember-'))
  homes.push(home)
  const calls: unknown[][] = []
  const chats = {
    decideApproval: async (...args: unknown[]) => void calls.push(['decide', ...args]),
    remember: async (...args: unknown[]) => void calls.push(['remember', ...args]),
    onStream: () => () => {},
  } as unknown as ChatService
  const server = startServer({ home, port: 0, chats })
  servers.push(server)
  const post = (body: unknown) =>
    fetch(new URL('/api/colonies/col-1/approvals/ap-1', server.url.replace(/#.*$/, '')), {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const rule = { kind: 'command', target: 'bun test', decision: 'allow' }
  expect((await post({ approved: true, remember: { scope: 'project', rule } })).status).toBe(200)
  expect((await post({ approved: true, remember: { scope: 'galaxy', rule } })).status).toBe(400)
  expect((await post({ approved: true, remember: { scope: 'chat', rule: { kind: 'x' } } })).status).toBe(400)
  expect(calls).toEqual([
    ['decide', 'col-1', 'ap-1', true, {}],
    ['remember', 'col-1', 'project', rule],
  ])
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
