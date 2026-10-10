import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '@myrmidon/runtime'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function start() {
  const dir = mkdtempSync(join(tmpdir(), 'myr-composer-'))
  homes.push(dir)
  const settings = new SettingsStore(dir)
  const server = startServer({ home: dir, port: 0, settings })
  servers.push(server)
  const base = server.url.replace(/#.*$/, '')
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, base), {
      method,
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: (await res.json()) as T }
  }
  return { dir, settings, call }
}

const PICKED = {
  mode: 'orchestrated',
  leadModel: 'openai/gpt',
  judgeModel: 'openai/gpt',
  roster: [{ role: 'coder', model: 'openai/gpt', specialist: 'Ada' }],
  extraWorkers: 1,
  thinking: 'high',
  helpers: 'always',
}

test("the message box's last crew is kept on the server and handed to every page with the models", async () => {
  const { dir, settings, call } = start()
  expect((await call<{ composer?: unknown }>('GET', '/api/models')).body.composer).toBeUndefined()
  const saved = await call<{ composer: unknown }>('PUT', '/api/settings/composer', PICKED)
  expect(saved.status).toBe(200)
  expect(saved.body.composer).toEqual(PICKED)
  expect((await call<{ composer?: unknown }>('GET', '/api/models')).body.composer).toEqual(PICKED)
  expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).composer).toEqual(PICKED)
  // It is not the default crew, which channels, calls and schedules use.
  expect(settings.get().team.leadModel).toBeUndefined()

  // Settings saved from a page that read them before the pick keeps the pick.
  const stale = await call<{ settings: Record<string, unknown> }>('GET', '/api/settings')
  await call('PUT', '/api/settings/composer', { ...PICKED, leadModel: 'anthropic/opus' })
  await call('PUT', '/api/settings', { ...stale.body.settings, composer: PICKED })
  expect(settings.get().composer?.leadModel).toBe('anthropic/opus')
})

test('a crew the server cannot keep is refused, and the last good one stays', async () => {
  const { settings, call } = start()
  await call('PUT', '/api/settings/composer', PICKED)
  for (const bad of [
    { ...PICKED, leadModel: undefined },
    { ...PICKED, mode: 'mob' },
    { ...PICKED, roster: Array.from({ length: 9 }, () => ({ role: 'coder', model: 'openai/gpt' })) },
    { ...PICKED, thinking: 'max' },
  ])
    expect((await call('PUT', '/api/settings/composer', bad)).status).toBe(400)
  // Fields the page does not send are not kept.
  await call('PUT', '/api/settings/composer', { ...PICKED, helpers: undefined, note: 'x' })
  expect(settings.get().composer).toEqual({
    mode: 'orchestrated',
    leadModel: 'openai/gpt',
    judgeModel: 'openai/gpt',
    roster: [{ role: 'coder', model: 'openai/gpt', specialist: 'Ada' }],
    extraWorkers: 1,
    thinking: 'high',
  })
})
