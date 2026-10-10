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

function serve() {
  const home = mkdtempSync(join(tmpdir(), 'myr-export-route-'))
  homes.push(home)
  const chats = {
    exportHtml: async (chatId: string) => {
      if (chatId !== 'chat-a') throw new Error('no such chat')
      return { title: 'Plans', html: '<!doctype html><title>Plans</title>' }
    },
    onStream: () => () => {},
  } as unknown as ChatService
  const server = startServer({ home, port: 0, chats })
  servers.push(server)
  const at = (path: string) => new URL(path, server.url.replace(/#.*$/, ''))
  return (path: string) => fetch(at(path), { headers: { authorization: `Bearer ${server.token}` } })
}

test("a chat's HTML export comes as a sandboxed download, never as a page of this origin", async () => {
  const get = serve()
  const res = await get('/api/chats/chat-a/export')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(res.headers.get('content-disposition')).toStartWith('attachment')
  expect(res.headers.get('content-security-policy')).toBe('sandbox')
  expect(await res.text()).toBe('<!doctype html><title>Plans</title>')
  const gone = await get('/api/chats/chat-zzz/export')
  expect(gone.status).toBe(404)
})

test('exporting is open to a chats-only device, which can read the chat already', () => {
  expect(needsFull('GET', '/api/chats/chat-a/export')).toBe(false)
})
