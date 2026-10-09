import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectPermissions } from '@myrmidon/protocol'
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
  // The shape from before the permission model is still accepted; the new one is a project level.
  expect(projects.get(project.id)?.permissions?.preset).toBe('full')
  const level: ProjectPermissions = {
    preset: 'ask',
    rules: [{ kind: 'command', target: 'bun test', decision: 'allow' }],
  }
  expect((await call('PUT', `/api/projects/${project.id}/permissions`, level)).status).toBe(200)
  expect(projects.get(project.id)?.permissions).toEqual(level)
  // Only a preset: the project's rules and who-can-use-what stay (it is not the old shape, which had a mode).
  const access = { crew: { web: false } }
  await call('PUT', `/api/projects/${project.id}/permissions`, { ...level, access })
  expect((await call('PUT', `/api/projects/${project.id}/permissions`, { preset: 'read-only' })).status).toBe(
    200,
  )
  expect(projects.get(project.id)?.permissions).toEqual({ ...level, preset: 'read-only', access })
  await call('PUT', `/api/projects/${project.id}/permissions`, level)
  // "Use global": no preset of its own.
  await call('PUT', `/api/projects/${project.id}/permissions`, { preset: null, rules: [] })
  expect(projects.get(project.id)?.permissions).toEqual({ rules: [] })

  // Full access is the global preset now; turning the sandbox off the old way still means it.
  const current = (await (await call('GET', '/api/settings')).json()).settings
  expect(current.permissions).toEqual({ preset: 'auto', rules: [] })
  expect((await call('PUT', '/api/settings', { ...current, sandbox: { enabled: false } })).status).toBe(200)
  expect(settings.get().permissions.preset).toBe('full')
  expect(await (await call('GET', '/api/projects')).json()).toMatchObject({
    fullAccess: true,
    preset: 'full',
  })
  // Only a device with full access may change either.
  expect(needsFull('PUT', `/api/projects/${project.id}/permissions`)).toBe(true)
  expect(needsFull('PUT', '/api/settings')).toBe(true)
})
