import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
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

test('a message the person can fix is refused in words that say how; a malformed request stays technical', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-send-'))
  homes.push(home)
  const chats = { onStream: () => () => {}, send: async () => ({}) } as unknown as ChatService
  const server = startServer({ home, port: 0, chats })
  servers.push(server)
  const url = new URL('/api/chats', server.url.replace(/#.*$/, ''))
  const post = async (body: unknown) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, error: ((await res.json()) as { error?: string }).error ?? '' }
  }
  const long = await post({ text: 'x'.repeat(20_001) })
  expect(long.status).toBe(400)
  expect(long.error).toBe(
    'That message is 20,001 characters; the most one message can hold is 20,000. Shorten it, or attach it as a file.',
  )
  const many = await post({
    text: 'hi',
    attachments: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, data: 'aGk=' })),
  })
  expect(many.error).toBe('Attach at most 10 files to one message.')
  const warn = console.warn
  console.warn = () => {}
  try {
    expect((await post({ text: 'hi', chatId: 'not a chat id' })).error).toStartWith('invalid request')
  } finally {
    console.warn = warn
  }
})
