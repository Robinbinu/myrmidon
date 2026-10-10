import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ChatService, SessionImports } from '@myrmidon/runtime'
import { needsFull } from '../src/devices.ts'
import { startServer, type WebServer } from '../src/server.ts'

const dirs: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const ID = '33333333-3333-4333-8333-333333333333'

function serve(publicUrl?: string) {
  const home = mkdtempSync(join(tmpdir(), 'myr-import-route-'))
  dirs.push(home)
  // One Claude Code session, as Claude Code keeps it.
  const claude = join(home, 'claude-root')
  const folder = join(claude, 'projects', '-work-app')
  mkdirSync(folder, { recursive: true })
  const base = { sessionId: ID, cwd: '/work/app', timestamp: '2026-10-03T09:00:00Z' }
  writeFileSync(
    join(folder, `${ID}.jsonl`),
    [
      {
        ...base,
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        message: { role: 'user', content: 'Plan the release' },
      },
      {
        ...base,
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: {
          id: 'm1',
          role: 'assistant',
          model: 'claude-x',
          content: [{ type: 'text', text: 'Here is a plan.' }],
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  )
  const imports = new SessionImports(home, { claudeRoot: claude, codexRoot: join(home, 'no-codex') })
  const sent: Record<string, unknown>[] = []
  const chats = {
    send: async (
      text: string,
      _config: unknown,
      chatId: string | undefined,
      options: Record<string, unknown>,
    ) => {
      sent.push({ text, chatId, ...options })
      return { chatId: 'chat-new-1', colonyId: 'c1', started: true }
    },
    onStream: () => () => {},
  } as unknown as ChatService
  const server = startServer({ home, port: 0, chats, imports, ...(publicUrl ? { publicUrl } : {}) })
  servers.push(server)
  const at = (path: string) => new URL(path, server.url.replace(/#.*$/, ''))
  const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = headers,
  ) => {
    const res = await fetch(at(path), {
      method,
      headers: extra,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { server, call, sent }
}

test('sessions are listed and imported, the import is read back, and a new chat is sent from it', async () => {
  const { call, sent } = serve()
  const listed = await call('GET', '/api/import-sessions')
  expect(listed.status).toBe(200)
  expect(listed.body.sessions).toEqual([
    expect.objectContaining({ source: 'claude', id: ID, cwd: '/work/app', preview: 'Plan the release' }),
  ])

  const imported = await call('POST', '/api/import-sessions', { source: 'claude', id: ID })
  expect(imported.status).toBe(200)
  expect(imported.body).toMatchObject({
    source: 'claude',
    sourceId: ID,
    turns: [
      { role: 'user', text: 'Plan the release' },
      { role: 'assistant', text: 'Here is a plan.' },
    ],
  })
  const importId = imported.body.id as string
  expect((await call('GET', `/api/imported/${importId}`)).body.id).toBe(importId)
  expect((await call('GET', '/api/imported/import-nope-1')).status).toBe(404)
  expect((await call('GET', '/api/imported/..%2F..%2Fsettings')).status).toBe(404)

  expect((await call('POST', '/api/import-sessions', { source: 'claude', id: 'missing' })).status).toBe(422)
  expect((await call('POST', '/api/import-sessions', { source: 'cursor', id: ID })).status).toBe(400)

  const config = { mode: 'orchestrated', leadModel: 'mock/lead', judgeModel: 'mock/lead' }
  const chat = await call('POST', '/api/chats', { text: 'Ship it', config, importOf: importId })
  expect(chat.status).toBe(200)
  expect(sent.at(-1)).toMatchObject({ text: 'Ship it', importOf: importId })
  expect((await call('POST', '/api/chats', { text: 'x', config, importOf: '../etc' })).status).toBe(400)
})

test("reading other tools' sessions needs a full-access device; reading a chat's import does not", async () => {
  expect(needsFull('GET', '/api/import-sessions')).toBe(true)
  expect(needsFull('POST', '/api/import-sessions')).toBe(true)
  expect(needsFull('GET', '/api/imported/import-abc-1')).toBe(false)

  const { server, call } = serve('https://box.example.ts.net')
  const host = { host: 'box.example.ts.net', origin: 'https://box.example.ts.net' }
  const { code } = server.pairingLink('chat')
  const paired = await fetch(new URL('/api/pair', server.url.replace(/#.*$/, '')), {
    method: 'POST',
    headers: { ...host, 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'Phone' }),
  })
  expect(paired.status).toBe(200)
  const phone = { ...host, cookie: (paired.headers.get('set-cookie') ?? '').split(';')[0] ?? '' }
  expect((await call('GET', '/api/whoami', undefined, phone)).status).toBe(200)
  expect((await call('GET', '/api/import-sessions', undefined, phone)).status).toBe(403)
  expect((await call('POST', '/api/import-sessions', { source: 'claude', id: ID }, phone)).status).toBe(403)
})
