import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillLibrary } from '@myrmidon/runtime'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

test('the status says which learned skills the curator archived last, so the page can tell the person', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-status-'))
  homes.push(home)
  const skills = new SkillLibrary(home, join(home, 'claude'))
  const day = 24 * 60 * 60_000
  const t0 = Date.parse('2026-01-01T00:00:00Z')
  skills.write('old-habit', 'Something done once.', 'Steps.', t0)
  skills.curate(t0 + 95 * day)
  const server = startServer({ home, port: 0, skills })
  servers.push(server)
  const url = new URL('/api/status', server.url.replace(/#.*$/, ''))
  const status = (await (
    await fetch(url, { headers: { authorization: `Bearer ${server.token}` } })
  ).json()) as {
    skillsArchived?: unknown
  }
  expect(status.skillsArchived).toEqual({ at: new Date(t0 + 95 * day).toISOString(), names: ['old-habit'] })
})
