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

/** Running processes (not zombies) and their parents. */
function processes(): Map<number, number> {
  const out = new Map<number, number>()
  const ps = new TextDecoder().decode(Bun.spawnSync(['ps', '-Ao', 'pid=,ppid=,stat=']).stdout)
  for (const line of ps.trim().split('\n')) {
    const [pid, ppid, stat] = line.trim().split(/\s+/)
    if (pid && ppid && !stat?.startsWith('Z')) out.set(Number(pid), Number(ppid))
  }
  return out
}

function below(root: number): number[] {
  const all = processes()
  const found = new Set([root])
  for (let grew = true; grew; ) {
    grew = false
    for (const [pid, ppid] of all)
      if (found.has(ppid) && !found.has(pid)) {
        found.add(pid)
        grew = true
      }
  }
  found.delete(root)
  return [...found]
}

test('the server the app started stops when the app is killed, and removes server.json', async () => {
  const app = Bun.spawn([process.execPath, join(import.meta.dir, 'server-parent.ts'), home], {
    stdout: 'pipe',
  })
  let children: number[] = []
  try {
    const reader = app.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('started')
    // The leash and the server under it.
    children = below(app.pid)
    expect(children.length).toBe(2)
    expect(existsSync(join(home, 'server.json'))).toBe(true)
    app.kill('SIGKILL')
    const left = () => children.filter((pid) => processes().has(pid))
    for (let i = 0; i < 50 && left().length; i++) await Bun.sleep(100)
    expect(left()).toEqual([])
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
