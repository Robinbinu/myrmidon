import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComputerHub } from '@myrmidon/runtime'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

test("the desktop app's overlay gets who controls what and where each agent acted", async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-overlay-'))
  homes.push(home)
  let asked = 0
  const computer = {
    controls: () => [{ colonyId: 'c1', agent: 'nova', app: 'Notes', bundleId: 'com.apple.Notes', since: 1 }],
    pointers: () => {
      asked++
      return [{ colonyId: 'c1', agent: 'nova', x: 640, y: 400, action: 'click', at: 2 }]
    },
  } as unknown as ComputerHub
  const server = startServer({ home, port: 0, computer })
  servers.push(server)
  const base = server.url.replace(/#.*$/, '')
  const auth = { authorization: `Bearer ${server.token}` }
  expect((await fetch(new URL('/api/computer/pointers', base))).status).toBe(401)
  const res = await fetch(new URL('/api/computer/pointers', base), { headers: auth })
  expect(await res.json()).toEqual({
    controls: [{ colonyId: 'c1', agent: 'nova', app: 'Notes', bundleId: 'com.apple.Notes', since: 1 }],
    pointers: [{ colonyId: 'c1', agent: 'nova', x: 640, y: 400, action: 'click', at: 2 }],
  })
  expect(asked).toBe(1)
})
