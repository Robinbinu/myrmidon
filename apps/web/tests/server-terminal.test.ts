import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectStore } from '@myrmidon/runtime'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

test("the person's terminal in a project folder that is gone closes with the reason, not silently", async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-term-'))
  homes.push(home)
  const projects = {
    get: (id: string) => ({ id, name: 'gone', path: join(home, 'deleted-folder'), addedAt: '' }),
  } as unknown as ProjectStore
  const server = startServer({ home, port: 0, projects })
  servers.push(server)
  const base = new URL(server.url.replace(/#.*$/, ''))
  const url = `ws://${base.host}/api/terminal?project=p1&cols=80&rows=24`
  const ws = new WebSocket(url, {
    headers: { origin: base.origin, authorization: `Bearer ${server.token}` },
  } as never)
  const closed = await new Promise<CloseEvent>((resolve) => {
    ws.onclose = resolve
  })
  expect(closed.code).toBe(1011)
  expect(closed.reason).toContain('moved or deleted')
})
