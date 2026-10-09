import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputerHub, McpHub, SettingsStore } from '@myrmidon/runtime'
import { needsFull } from '../src/devices.ts'
import { startServer, type WebServer } from '../src/server.ts'

const FAKE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'packages',
  'runtime',
  'tests',
  'fixtures',
  'fake-cua-driver.ts',
)

const homes: string[] = []
const servers: WebServer[] = []
const hubs: { hub: ComputerHub; mcp: McpHub }[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const { hub, mcp } of hubs.splice(0)) {
    await hub.stop()
    await mcp.close()
  }
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

test('Settings sees the driver and grants, switching computer use off stops agents, and Stop is open to every device', async () => {
  const home = mkdtempSync(join(tmpdir(), 'myr-computer-server-'))
  homes.push(home)
  mkdirSync(join(home, 'bin'))
  const driver = join(home, 'bin', 'cua-driver')
  writeFileSync(driver, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(driver, 0o755)
  const settings = new SettingsStore(home)
  const mcp = new McpHub(join(home, 'agent'))
  const hub = new ComputerHub(home, {
    mcp,
    enabled: () => settings.get().computerUse.enabled,
    paths: [driver],
    platform: 'darwin',
    grants: () => ({ accessibility: false, screenRecording: true }),
  })
  hubs.push({ hub, mcp })
  const server = startServer({ home, port: 0, settings, mcp, computer: hub })
  servers.push(server)
  const base = server.url.replace(/#.*$/, '')
  const call = (method: string, path: string, body?: unknown) =>
    fetch(new URL(path, base), {
      method,
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })

  const off = await (await call('GET', '/api/computer')).json()
  expect(off).toMatchObject({
    supported: true,
    enabled: false,
    state: { state: 'ready' },
    driver: { path: driver, version: '9.9.9', own: false },
    grants: { accessibility: false, screenRecording: true },
    controls: [],
  })
  expect(off.downloadBytes).toBeGreaterThan(40_000_000)

  const current = (await (await call('GET', '/api/settings')).json()).settings
  expect(current.computerUse).toEqual({ enabled: false })
  await call('PUT', '/api/settings', { ...current, computerUse: { enabled: true } })
  expect(settings.get().computerUse.enabled).toBe(true)
  await hub.ensure()
  await hub.take({ name: 'Notes', bundleId: 'com.apple.Notes' }, { colonyId: 'c1', agent: 'nova' })
  const on = await (await call('GET', '/api/computer')).json()
  expect(on.state.state).toBe('running')
  expect(on.controls).toMatchObject([{ colonyId: 'c1', agent: 'nova', app: 'Notes' }])

  // Switched off: whoever controls the Mac stops, and the driver with them.
  await call('PUT', '/api/settings', { ...current, computerUse: { enabled: false } })
  const after = await (await call('GET', '/api/computer')).json()
  expect(after.controls).toEqual([])
  expect(after.state.state).toBe('ready')
  expect(hub.stopped('c1')).toBe(true)

  expect((await (await call('POST', '/api/computer/stop', {})).json()).stopped).toBe(0)
  // Installing and granting are for full-access devices; Stop is a safety stop anyone may press.
  expect(needsFull('POST', '/api/computer/install')).toBe(true)
  expect(needsFull('POST', '/api/computer/grants')).toBe(true)
  expect(needsFull('POST', '/api/computer/restart')).toBe(true)
  expect(needsFull('PUT', '/api/chats/abc/computer-apps')).toBe(true)
  expect(needsFull('POST', '/api/computer/stop')).toBe(false)
  expect(needsFull('GET', '/api/computer')).toBe(false)
})
