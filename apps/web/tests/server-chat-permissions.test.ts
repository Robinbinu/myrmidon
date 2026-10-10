import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatService } from '@myrmidon/runtime'
import { DeviceStore, needsFull } from '../src/devices.ts'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const event = (seq: number, type: string, payload: unknown) => ({
  id: `col-1-${seq}`,
  seq,
  colonyId: 'col-1',
  time: new Date().toISOString(),
  type,
  actor: { kind: 'system', id: 'x' },
  trace: { traceId: 't', spanId: 's' },
  schema: 1,
  payload,
})
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

test('an approval remembers only what its card offered, tied to the answer: the rule is saved, then the call decided', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-remember-'))
  homes.push(home)
  const phone = new DeviceStore(home).add('Phone', 'chat').token
  const calls: unknown[][] = []
  const log: unknown[] = [
    event(1, 'approval/requested', {
      id: 'ap-1',
      agent: 'lead',
      tool: 'shell',
      summary: 'git status && bun test',
      call: { tool: 'shell', kind: 'command', command: 'git status && bun test' },
      offer: [
        { kind: 'command', target: 'git status' },
        { kind: 'command', target: 'bun test' },
        { kind: 'command', target: '*' },
      ],
    }),
  ]
  let failSave = false
  let decidedBySaving = false
  const chats = {
    events: async () => log,
    decideApproval: async (...args: unknown[]) => {
      if (decidedBySaving) throw new Error('that request is no longer waiting')
      calls.push(['decide', ...args])
    },
    remember: async (...args: unknown[]) => {
      if (failSave) throw new Error('settings need the chat runtime')
      calls.push(['remember', ...args])
      // Saving re-decides the waiting calls the rule covers, as ChatService.remember does.
      if (decidedBySaving)
        log.push(event(2, 'approval/decided', { id: 'ap-1', approved: true, by: 'person' }))
    },
    onStream: () => () => {},
  } as unknown as ChatService
  const server = startServer({ home, port: 0, chats })
  servers.push(server)
  const post = (body: unknown, auth = `Bearer ${server.token}`) =>
    fetch(new URL('/api/colonies/col-1/approvals/ap-1', server.url.replace(/#.*$/, '')), {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const allow = (target: string) => ({ kind: 'command', target, decision: 'allow' })
  expect(
    (await post({ approved: true, remember: { scope: 'project', rule: allow('bun test') } })).status,
  ).toBe(200)
  expect(calls.splice(0)).toEqual([
    ['remember', 'col-1', 'project', [allow('bun test')]],
    ['decide', 'col-1', 'ap-1', true, {}],
  ])
  // A compound command's parts are remembered together.
  const parts = [allow('git status'), allow('bun test')]
  expect((await post({ approved: true, remember: { scope: 'chat', rules: parts } })).status).toBe(200)
  expect(calls.splice(0)).toEqual([
    ['remember', 'col-1', 'chat', parts],
    ['decide', 'col-1', 'ap-1', true, {}],
  ])
  // Not offered on this card, wider than offered, for someone else, or not the answer given: refused, nothing done.
  for (const rule of [
    allow('rm'),
    allow('bun'),
    { ...allow('bun test'), who: 'crew' },
    { kind: 'tool', target: 'shell', decision: 'allow' },
  ])
    expect((await post({ approved: true, remember: { scope: 'global', rule } })).status).toBe(400)
  expect((await post({ approved: false, remember: { scope: 'chat', rule: allow('bun test') } })).status).toBe(
    400,
  )
  expect(
    (
      await post({
        approved: true,
        remember: { scope: 'chat', rule: { ...allow('bun test'), decision: 'deny' } },
      })
    ).status,
  ).toBe(400)
  expect(
    (await post({ approved: true, remember: { scope: 'galaxy', rule: allow('bun test') } })).status,
  ).toBe(400)
  expect((await post({ approved: true, remember: { scope: 'chat', rule: { kind: 'x' } } })).status).toBe(400)
  expect(calls).toEqual([])
  // A chats-only device remembers for this chat only, and only what this step is, not every command.
  const device = `Device ${phone}`
  expect(
    (await post({ approved: true, remember: { scope: 'chat', rule: allow('bun test') } }, device)).status,
  ).toBe(200)
  calls.splice(0)
  expect(
    (await post({ approved: true, remember: { scope: 'global', rule: allow('bun test') } }, device)).status,
  ).toBe(403)
  expect((await post({ approved: true, remember: { scope: 'chat', rule: allow('*') } }, device)).status).toBe(
    403,
  )
  expect(calls).toEqual([])
  // When saving fails, the step is not decided either.
  failSave = true
  expect(
    (await post({ approved: true, remember: { scope: 'global', rule: allow('bun test') } })).status,
  ).toBe(409)
  expect(calls).toEqual([])
  failSave = false
  // Saving the rule may already have decided the step, as the answer given: that is success.
  decidedBySaving = true
  const settled = await post({ approved: true, remember: { scope: 'global', rule: allow('bun test') } })
  expect(settled.status).toBe(200)
  expect(calls).toEqual([['remember', 'col-1', 'global', [allow('bun test')]]])
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
  // Opening a folder of the computer to a chat is a permission change: a chats-only device cannot make it.
  expect(needsFull('PUT', '/api/chats/chat-a/readable')).toBe(true)
})
