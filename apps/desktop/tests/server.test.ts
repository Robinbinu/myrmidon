import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { freePort, myrmidonHome, overlayUrl, pageUrl, runningServer, startServer } from '../src/server.ts'

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

test('a server.json whose server has gone is removed, so nothing takes it for a running server', async () => {
  const gone = Bun.spawn([process.execPath, '-e', ''])
  await gone.exited
  const file = join(home, 'server.json')
  writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${freePort()}/`, token: 't', pid: gone.pid }))
  expect(await runningServer(home)).toBeUndefined()
  expect(existsSync(file)).toBe(false)
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
  expect(myrmidonHome({ MYRMIDON_HOME: '/data/myr' })).toBe(resolve('/data/myr'))
  expect(myrmidonHome({}).endsWith(`${sep}.myrmidon`)).toBe(true)
})

/** Whether a process is running: signal 0 only checks, on every platform. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function gone(pids: readonly number[]): Promise<number[]> {
  for (let i = 0; i < 50 && pids.some(alive); i++) await Bun.sleep(100)
  return pids.filter(alive)
}

/** The pids the fake server wrote down: its own and its parent's, the leash. */
function serverPids(home: string): { pid: number; ppid: number } {
  return JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'))
}

test('the server the app started stops when the app is killed, and its server.json goes with it', async () => {
  const app = Bun.spawn([process.execPath, join(import.meta.dir, 'server-parent.ts'), home], {
    stdout: 'pipe',
  })
  let children: number[] = []
  try {
    const reader = app.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('started')
    const { pid, ppid } = serverPids(home)
    children = [ppid, pid]
    expect(children.every(alive)).toBe(true)
    app.kill('SIGKILL')
    expect(await gone(children)).toEqual([])
    // Where there are signals the server removes server.json as it stops; Windows can only end it, so there the next
    // reader finds its pid gone and removes the file. Either way nothing takes it for a running server.
    expect(await runningServer(home)).toBeUndefined()
    expect(existsSync(join(home, 'server.json'))).toBe(false)
  } finally {
    for (const pid of [app.pid, ...children])
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
  }
})

for (const platform of ['darwin', 'linux', 'win32'] as const)
  test(`on ${platform} quitting asks the server to stop over its API, and it removes server.json`, async () => {
    const server = await startServer({ command: FAKE, home, port: freePort(), pollMs: 20, platform })
    const { pid, ppid } = serverPids(home)
    await server.stop()
    expect(await gone([pid, ppid])).toEqual([])
    expect(existsSync(join(home, 'server.json'))).toBe(false)
    expect(readFileSync(join(home, 'stopped-by'), 'utf8')).toBe('api')
  })

for (const platform of ['darwin', 'linux', 'win32'] as const)
  test(`on ${platform} a server that does not take the request is still stopped, with all it started`, async () => {
    const command = [...FAKE, '--no-shutdown']
    const server = await startServer({ command, home, port: freePort(), pollMs: 20, platform })
    const { pid, ppid } = serverPids(home)
    await server.stop()
    expect(await gone([pid, ppid])).toEqual([])
    // Where there are signals, SIGTERM lets it stop its chats; Windows goes straight to the leash's firm stop. A
    // Windows host cannot deliver a SIGTERM the server could catch, whichever system's path it takes.
    if (platform !== 'win32' && process.platform !== 'win32')
      expect(readFileSync(join(home, 'stopped-by'), 'utf8')).toBe('SIGTERM')
  })

test('another server writing server.json for the same home is not taken for the one the app started', async () => {
  const otherPort = freePort()
  const other = Bun.spawn([...FAKE, '--port', String(otherPort), '--home', home], { stdout: 'ignore' })
  try {
    for (let i = 0; i < 100 && !existsSync(join(home, 'server.json')); i++) await Bun.sleep(20)
    const port = freePort()
    const server = await startServer({ command: [...FAKE, '--delay', '300'], home, port, pollMs: 20 })
    expect(server.pageUrl).toBe(`http://127.0.0.1:${port}/#token=fake-token`)
    await server.stop()
  } finally {
    other.kill('SIGKILL')
  }
})

test("the overlay windows load the dashboard's page at /overlay, with its token", () => {
  expect(overlayUrl('http://127.0.0.1:4318/?chat=a#token=t0k')).toBe(
    'http://127.0.0.1:4318/overlay#token=t0k',
  )
})
