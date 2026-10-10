import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OmpRuntime, QuotaSnapshot } from '@myrmidon/runtime'
import { DeviceStore, needsFull } from '../src/devices.ts'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

const SNAPSHOT: QuotaSnapshot = {
  fetchedAt: 1_800_000_000_000,
  accounts: [
    {
      provider: 'anthropic',
      account: 'ada@example.com',
      plan: 'max',
      windows: [{ id: 'anthropic:5h', label: 'Claude 5 Hour', usedPercent: 92.3, status: 'warning' }],
      status: 'warning',
    },
    { provider: 'github-copilot', account: 'ada-gh', windows: [], status: 'unknown', error: 'unreachable' },
  ],
}

function serve() {
  const home = mkdtempSync(join(tmpdir(), 'myr-usage-'))
  homes.push(home)
  const reads: { force?: boolean }[] = []
  const omp = {
    available: () => [],
    quota: {
      read: async (options: { force?: boolean } = {}) => {
        reads.push(options)
        return SNAPSHOT
      },
    },
  } as unknown as OmpRuntime
  const phone = new DeviceStore(home).add('Phone', 'chat').token
  const server = startServer({ home, port: 0, omp })
  servers.push(server)
  const get = async (path: string, authorization: string) => {
    const res = await fetch(new URL(path, server.url.replace(/#.*$/, '')), { headers: { authorization } })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { get, reads, owner: `Bearer ${server.token}`, phone: `Device ${phone}` }
}

test('GET /api/usage answers each account with its plan, windows and errors, and refresh asks omp afresh', async () => {
  const { get, reads, owner } = serve()
  const plain = await get('/api/usage', owner)
  expect(plain).toEqual({ status: 200, body: SNAPSHOT as never })
  await get('/api/usage?refresh=1', owner)
  expect(reads).toEqual([{ force: false }, { force: true }])
})

test('a chats-only device may read limits, without whose accounts they are and without forcing a refresh', async () => {
  const { get, reads, phone } = serve()
  expect(needsFull('GET', '/api/usage')).toBe(false)
  const read = await get('/api/usage?refresh=1', phone)
  expect(read.status).toBe(200)
  const accounts = read.body.accounts as Record<string, unknown>[]
  expect(accounts.map((a) => a.provider)).toEqual(['anthropic', 'github-copilot'])
  expect(accounts.some((a) => 'account' in a)).toBe(false)
  expect(JSON.stringify(read.body)).not.toContain('ada')
  expect(accounts[0]).toMatchObject({ plan: 'max', status: 'warning' })
  expect(reads).toEqual([{ force: false }])
})

test('without a sign-in the route is closed', async () => {
  const { get } = serve()
  expect((await get('/api/usage', 'Bearer wrong')).status).toBe(401)
})
