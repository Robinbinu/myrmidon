import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore, SkillLibrary } from '@myrmidon/runtime'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

test('the skill sources are listed, and turning ClawHub on is kept in the settings file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-market-'))
  homes.push(home)
  const settings = new SettingsStore(home)
  const server = startServer({
    home,
    port: 0,
    skills: new SkillLibrary(home, join(home, 'claude')),
    settings,
  })
  servers.push(server)
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, server.url.replace(/#.*$/, '')), {
      method,
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const listed = await call('GET', '/api/skill-market')
  const clawhub = () =>
    (listed.body.sources as { id: string; enabled: boolean }[]).find((s) => s.id === 'clawhub')
  expect(clawhub()).toMatchObject({ enabled: false, optIn: true })
  const on = await call('PUT', '/api/skill-market/sources/clawhub', { enabled: true })
  expect(
    (on.body.sources as { id: string; enabled: boolean }[]).find((s) => s.id === 'clawhub')?.enabled,
  ).toBe(true)
  expect(settings.get().skillMarket.sources).toEqual({ clawhub: true })
  expect((await call('PUT', '/api/skill-market/sources/nowhere', { enabled: true })).status).toBe(404)
  // A ref that names no source is refused before anything is fetched.
  const bad = await call('POST', '/api/skill-market/install', { ref: 'nowhere:x' })
  expect(bad).toMatchObject({ status: 422 })
  // An empty search asks nobody.
  expect((await call('GET', '/api/skill-market/search?q=')).body).toEqual({ hits: [], errors: [] })
})
