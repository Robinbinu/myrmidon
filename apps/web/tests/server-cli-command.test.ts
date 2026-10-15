import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliCommand, compiledBinary, SettingsStore } from '@myrmidon/runtime'
import { prompts } from '../../../packages/runtime/src/prompts.ts'
import { needsFull } from '../src/devices.ts'
import { startServer, type WebServer } from '../src/server.ts'

const dirs: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A throwaway person's home (never the real one), a Myrmidon home in it, and a copy of the app's server binary. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'myr-cli-route-'))
  dirs.push(root)
  const home = join(root, 'home')
  const data = join(home, '.myrmidon')
  mkdirSync(data, { recursive: true })
  const sidecar = join(root, 'Myrmidon.app', 'Contents', 'Resources', 'app', 'sidecar')
  mkdirSync(sidecar, { recursive: true })
  const binary = join(sidecar, 'myrmidon')
  writeFileSync(binary, '#!/bin/sh\necho ok\n')
  chmodSync(binary, 0o755)
  return { home, data, binary }
}

function client(server: WebServer) {
  const base = server.url.replace(/#.*$/, '')
  return async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(new URL(path, base), {
      method,
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: (await res.json()) as T }
  }
}

type Status = { state: string; link: string; target?: string; reason?: string; profileBlock: boolean }

test('the desktop app installs and removes the command through the API, and the choice is kept in settings', async () => {
  const { home, data, binary } = world()
  const settings = new SettingsStore(data)
  const cliCommand = new CliCommand({ home, binary, loginPath: async () => '/usr/bin:/bin' })
  const server = startServer({ home: data, port: 0, settings, cliCommand })
  servers.push(server)
  const call = client(server)
  expect((await call<Status>('GET', '/api/cli-command')).body.state).toBe('missing')
  expect(settings.get().cli.command).toBe(false)

  const installed = await call<Status>('POST', '/api/cli-command')
  expect(installed.status).toBe(200)
  expect(installed.body).toMatchObject({ state: 'installed', target: binary, profileBlock: true })
  expect(readlinkSync(join(home, '.local', 'bin', 'myrmidon'))).toBe(binary)
  expect(readFileSync(join(home, '.zprofile'), 'utf8')).toContain(prompts.cliCommand.blockStart)
  expect(settings.get().cli.command).toBe(true)
  // A page saving settings it read before cannot turn the choice back.
  const stale = { ...settings.get(), cli: { command: false } }
  await call('PUT', '/api/settings', stale)
  expect(settings.get().cli.command).toBe(true)

  // Setup counts the step as set up, and does not skip it in the app.
  const setup = await call<{ have: Record<string, boolean>; skip: string[] }>('GET', '/api/setup')
  expect(setup.body.have.command).toBe(true)
  expect(setup.body.skip).toEqual([])

  const removed = await call<Status>('DELETE', '/api/cli-command')
  expect(removed.body).toMatchObject({ state: 'missing', profileBlock: false })
  expect(existsSync(join(home, '.local', 'bin', 'myrmidon'))).toBe(false)
  expect(readFileSync(join(home, '.zprofile'), 'utf8')).toBe('')
  expect(settings.get().cli.command).toBe(false)
})

test('run from source, the API refuses with the reason, and setup skips the step', async () => {
  const { home, data } = world()
  const settings = new SettingsStore(data)
  const cliCommand = new CliCommand({ home, binary: compiledBinary() })
  const server = startServer({ home: data, port: 0, settings, cliCommand })
  servers.push(server)
  const call = client(server)
  expect((await call<Status>('GET', '/api/cli-command')).body).toMatchObject({
    state: 'unavailable',
    reason: prompts.cliCommand.unavailable,
  })
  const refused = await call<Status & { error: string }>('POST', '/api/cli-command')
  expect(refused.status).toBe(409)
  expect(refused.body.error).toBe(prompts.cliCommand.unavailable)
  expect(settings.get().cli.command).toBe(false)
  expect(existsSync(join(home, '.local'))).toBe(false)
  expect((await call<{ skip: string[] }>('GET', '/api/setup')).body.skip).toEqual(['command'])
})

test('only a device with full access may see or change the command', () => {
  for (const method of ['GET', 'POST', 'DELETE']) expect(needsFull(method, '/api/cli-command')).toBe(true)
})
