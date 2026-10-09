import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freePort, myrmidonHome, pageUrl, runningServer, startServer } from '../src/server.ts'

const FAKE = [process.execPath, join(import.meta.dir, 'fake-cli.ts')]
let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'myr-desktop-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

test('starts the server on the chosen port, opens it with its token, and stops it on request', async () => {
  const port = freePort()
  const server = await startServer({ command: FAKE, home, port, pollMs: 20 })
  expect(server.owned).toBe(true)
  expect(server.pageUrl).toBe(`http://127.0.0.1:${port}/#token=fake-token`)
  expect(await runningServer(home)).toMatchObject({ owned: false, pageUrl: server.pageUrl })
  await server.stop()
  expect(existsSync(join(home, 'server.json'))).toBe(false)
  expect(await runningServer(home)).toBeUndefined()
})

test('a server.json left by a crash does not count as a running server', async () => {
  writeFileSync(
    join(home, 'server.json'),
    JSON.stringify({ url: `http://127.0.0.1:${freePort()}/`, token: 't', pid: 1 }),
  )
  expect(await runningServer(home)).toBeUndefined()
})

test('a server that exits while starting is reported, not waited on', async () => {
  await expect(
    startServer({ command: [...FAKE, '--crash'], home, port: freePort(), pollMs: 20 }),
  ).rejects.toThrow('exit code 3')
})

test('quitting while the server starts stops it', async () => {
  const quit = new AbortController()
  const starting = startServer({ command: FAKE, home, port: freePort(), pollMs: 20, signal: quit.signal })
  quit.abort(new Error('quit'))
  await expect(starting).rejects.toThrow('quit')
})

test('the page URL carries the token in its hash, and a dev server without one gets none', () => {
  expect(pageUrl({ url: 'http://127.0.0.1:4318/', token: 'abc', pid: 1 })).toBe(
    'http://127.0.0.1:4318/#token=abc',
  )
  expect(pageUrl({ url: 'http://127.0.0.1:4318/', token: '', pid: 1 })).toBe('http://127.0.0.1:4318/')
})

test('the home is the CLI’s: MYRMIDON_HOME, else ~/.myrmidon', () => {
  expect(myrmidonHome({ MYRMIDON_HOME: '/data/myr' })).toBe('/data/myr')
  expect(myrmidonHome({}).endsWith('/.myrmidon')).toBe(true)
})
