import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, SettingsStore } from '@myrmidon/runtime'
import { needsFull } from '../src/devices.ts'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

test('a project can be given full access, and the project list says when the sandbox is off', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-full-server-'))
  const folder = mkdtempSync(join(tmpdir(), 'myr-full-folder-'))
  homes.push(home, folder)
  const settings = new SettingsStore(home)
  const projects = new ProjectStore(home)
  const project = projects.add(folder)
  const server = startServer({ home, port: 0, settings, projects })
  servers.push(server)
  const base = server.url.replace(/#.*$/, '')
  const call = (method: string, path: string, body?: unknown) =>
    fetch(new URL(path, base), {
      method,
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })

  expect((await (await call('GET', '/api/projects')).json()).fullAccess).toBe(false)
  const put = await call('PUT', `/api/projects/${project.id}/permissions`, { mode: 'full', allow: [] })
  expect(put.status).toBe(200)
  expect(projects.get(project.id)?.permissions?.mode).toBe('full')

  const current = (await (await call('GET', '/api/settings')).json()).settings
  expect(current.sandbox).toEqual({ enabled: true })
  expect((await call('PUT', '/api/settings', { ...current, sandbox: { enabled: false } })).status).toBe(200)
  expect(settings.get().sandbox.enabled).toBe(false)
  expect((await (await call('GET', '/api/projects')).json()).fullAccess).toBe(true)
  // Only a device with full access may change either.
  expect(needsFull('PUT', `/api/projects/${project.id}/permissions`)).toBe(true)
  expect(needsFull('PUT', '/api/settings')).toBe(true)
})
