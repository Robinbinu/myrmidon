import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { bunShim } from '../../../tests/platform.ts'
import { BrowserHub, findChrome } from '../src/browser.ts'
import { LEASH_GRACE_MS } from '../src/config.ts'
import type { ProcessRow } from '../src/leash.ts'
import { leashRunning, spawnLeashed } from '../src/leashed.ts'
import { detectSandbox } from '../src/sandbox.ts'
import { runningProcesses } from './fixtures/processes.ts'
import { sleeper, twoSleeps } from './fixtures/sleeper.ts'

// No child of Myrmidon may outlive it, however it dies: each kind is started by a stand-in Myrmidon (a separate
// process running the real code), which is then SIGKILLed. Windows has no signals or process groups: there SIGKILL
// is TerminateProcess, a leash stops its tree at once, with no grace, and trees are found by parent ids alone.

const PARENT = join(import.meta.dir, 'fixtures', 'children-parent.ts')
const KITTEN_MODEL = join(homedir(), '.myrmidon', 'voice', 'kitten', 'nano')
/** How long a tree gets to go once its parent is killed: the leash's grace, and time to notice and sweep. */
const GONE_MS = LEASH_GRACE_MS + 5_000

const dirs: string[] = []
/** Every process a test saw, killed after it whatever happened, so a failing test leaves nothing running. */
const seen = new Set<number>()
afterEach(() => {
  for (const pid of seen) signal(pid, 'SIGKILL')
  seen.clear()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'myr-children-'))
  dirs.push(dir)
  return dir
}

function signal(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(pid, sig)
  } catch {
    // Already gone.
  }
}

/** Running processes, with their parent and process group (none on Windows). */
function processes(): Map<number, ProcessRow> {
  return new Map(runningProcesses().map((r) => [r.pid, r]))
}

/** The processes below `pid`, and those in the process groups they lead (which an orphan may have left). */
function tree(pid: number): number[] {
  const all = processes()
  const found = new Set([pid])
  for (let grew = true; grew; ) {
    grew = false
    for (const [p, { ppid, pgid }] of all)
      if ((found.has(ppid) || (pgid !== undefined && found.has(pgid) && pgid !== pid)) && !found.has(p)) {
        found.add(p)
        grew = true
      }
  }
  found.delete(pid)
  for (const p of found) seen.add(p)
  return [...found]
}

async function waitGone(pids: readonly number[], ms = GONE_MS): Promise<number[]> {
  const deadline = Date.now() + ms
  for (;;) {
    const all = processes()
    const left = pids.filter((p) => all.has(p))
    if (!left.length || Date.now() >= deadline) return left
    await Bun.sleep(100)
  }
}

/** This environment's PATH with `bin` first, under the name PATH has here (Windows' names ignore case: often Path). */
function pathWith(bin: string): Record<string, string> {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { [key]: `${bin}${delimiter}${process.env[key]}` }
}

/** Starts the stand-in Myrmidon with one kind of child and waits until it says the child runs. */
async function startParent(kind: string, dir: string, env: Record<string, string> = {}) {
  const parent = Bun.spawn([process.execPath, PARENT, kind, dir], {
    env: { ...process.env, ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  seen.add(parent.pid)
  const reader = parent.stdout.getReader()
  let out = ''
  const deadline = Date.now() + 60_000
  while (!out.includes('\n') && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), parent.exited.then(() => undefined)])
    if (!chunk || chunk.done) break
    out += new TextDecoder().decode(chunk.value)
  }
  reader.releaseLock()
  if (!out.startsWith('started'))
    throw new Error(`the parent did not start its child: ${out}${await new Response(parent.stderr).text()}`)
  return { parent, words: out.trim().split(/\s+/).slice(1).map(Number) }
}

/** Starts `kind`, SIGKILLs its parent, and returns the processes it had started that are still running. */
async function orphansAfterKill(kind: string, env?: Record<string, string>) {
  const dir = tempDir()
  const { parent, words } = await startParent(kind, dir, env)
  const children = tree(parent.pid)
  expect(children.length).toBeGreaterThan(0)
  parent.kill('SIGKILL')
  await parent.exited
  const left = await waitGone(children.filter((p) => !words.includes(p)))
  // With their command lines, so a failure says what outlived the parent.
  const rows = processes()
  return { children, left: left.map((p) => `${p} ${rows.get(p)?.command ?? ''}`), words }
}

test('a leashed command and all it started stop when the parent is SIGKILLed, one ignoring SIGTERM too', async () => {
  const { children, left } = await orphansAfterKill('leash')
  // The leash, the command, and its two children.
  expect(children.length).toBe(4)
  expect(left).toEqual([])
})

test("a child started after a leashed one does not hold the leash's stdin open", async () => {
  const { left, words } = await orphansAfterKill('sibling')
  expect(left).toEqual([])
  const other = words[0] ?? 0
  expect(processes().has(other)).toBe(true)
})

test.skipIf(!findChrome())(
  'Chrome and its helpers stop when the process that launched it is SIGKILLed',
  async () => {
    const { left } = await orphansAfterKill('chrome')
    expect(left).toEqual([])
  },
  60_000,
)

test.skipIf(!findChrome())(
  'closing the browser stops Chrome and its leash, and the next one starts on the same profile',
  async () => {
    const hub = new BrowserHub(join(tempDir(), 'profile'))
    try {
      const before = new Set(tree(process.pid))
      await hub.tab('c1', 'wren')
      const started = tree(process.pid).filter((p) => !before.has(p))
      expect(started.length).toBeGreaterThan(1)
      await hub.close()
      expect(await waitGone(started)).toEqual([])
      const tab = await hub.tab('c1', 'wren')
      await tab.page.setContent('<p>again</p>')
      expect(await tab.page.$eval('p', (p) => p.textContent)).toBe('again')
    } finally {
      await hub.close()
    }
  },
  60_000,
)

test('a leash on a process already running ends once that process has', async () => {
  const proc = Bun.spawn(sleeper(), { detached: true })
  seen.add(proc.pid)
  const leash = leashRunning(proc.pid)
  seen.add(leash.pid)
  proc.kill('SIGKILL')
  expect(await leash.exited).toBe(0)
})

function fakeFermion(dir: string) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  bunShim(join(bin, 'fermion'), join(import.meta.dir, 'fixtures', 'fake-fermion.ts'))
  return bin
}

/**
 * The processes Phonon's fake server makes: the leash, the server, and the server's own process; on Windows also the
 * cmd.exe running the server's `.cmd` shim, which runs Bun (a `#!/bin/sh` shim execs it).
 */
const PHONON_TREE = process.platform === 'win32' ? 4 : 3

test("Phonon's server and what it started stop when Myrmidon is SIGKILLed", async () => {
  const bin = fakeFermion(tempDir())
  const { children, left } = await orphansAfterKill('phonon', pathWith(bin))
  expect(children.length).toBe(PHONON_TREE)
  expect(left).toEqual([])
})

test('a dev server from start_server, and its children, stop when Myrmidon is SIGKILLed', async () => {
  const { children, left } = await orphansAfterKill('server')
  expect(children.length).toBeGreaterThanOrEqual(3)
  expect(left).toEqual([])
})

test.skipIf(!existsSync(join(KITTEN_MODEL, 'config.json')))(
  "Kitten's worker exits when Myrmidon is SIGKILLed",
  async () => {
    const { children, left } = await orphansAfterKill('kitten')
    expect(children.length).toBe(1)
    expect(left).toEqual([])
  },
  60_000,
)

test("the leash passes the command's stdout, stderr, environment and exit code through", async () => {
  // BUN_BE_BUN is the leash's own (a compiled Myrmidon needs it to run the leash) and must not reach the command.
  const proc = spawnLeashed(['sh', '-c', 'echo "out $MYR_X [$BUN_BE_BUN]"; echo err >&2; exit 3'], {
    env: { ...process.env, MYR_X: 'x' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect({ out, err, code }).toEqual({ out: 'out x []\n', err: 'err\n', code: 3 })
})

test('the leash runs from its source alone, as a compiled Myrmidon runs it', async () => {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'leash.ts'), 'utf8')
  const proc = Bun.spawn([process.execPath, '-e', source, '--', '--grace=100', 'sh', '-c', 'exit 5'], {
    stdin: 'pipe',
  })
  expect(await proc.exited).toBe(5)
})

test('a signal to the leash goes to the command, and the leash ends the way the command did', async () => {
  const proc = spawnLeashed(sleeper(), { stdout: 'ignore' })
  for (let i = 0; i < 50 && tree(proc.pid).length === 0; i++) await Bun.sleep(50)
  const children = tree(proc.pid)
  expect(children.length).toBe(1)
  proc.kill('SIGTERM')
  await proc.exited
  if (process.platform === 'win32') {
    // No signal to pass on: kill() ends the leash's stdin, the leash ends the command (which then exits 1, as a
    // process ended from outside does there), and exits as it did.
    expect(proc.signalCode).toBeNull()
    expect(proc.exitCode).toBe(1)
  } else expect(proc.signalCode).toBe('SIGTERM')
  expect(await waitGone(children)).toEqual([])
})

test("ending the leash's stdin stops the whole tree, killing what ignores SIGTERM after the grace", async () => {
  const proc = spawnLeashed(sleeper('--ignore-term', '--children=1'), { stdout: 'ignore' })
  for (let i = 0; i < 50 && tree(proc.pid).length < 2; i++) await Bun.sleep(50)
  const children = tree(proc.pid)
  expect(children.length).toBe(2)
  const started = Date.now()
  proc.stdin.end()
  await proc.exited
  if (process.platform === 'win32') {
    // Nothing ignores being ended there: the command is ended at once, and the leash exits as it did.
    expect(proc.signalCode).toBeNull()
    expect(proc.exitCode).toBe(1)
  } else {
    expect(Date.now() - started).toBeGreaterThanOrEqual(LEASH_GRACE_MS)
    expect(proc.signalCode).toBe('SIGKILL')
  }
  expect(await waitGone(children, 1000)).toEqual([])
})

test('what a command leaves running when it ends is stopped with it', async () => {
  const proc = spawnLeashed(sleeper('--orphan'), { stdout: 'pipe' })
  const orphan = Number((await new Response(proc.stdout).text()).trim())
  seen.add(orphan)
  expect(await proc.exited).toBe(0)
  expect(await waitGone([orphan], 1000)).toEqual([])
})

test("stopping Phonon stops its server's whole tree", async () => {
  const dir = tempDir()
  const bin = fakeFermion(dir)
  const { parent } = await startParent('phonon', dir, pathWith(bin))
  const children = tree(parent.pid)
  expect(children.length).toBe(PHONON_TREE)
  parent.stdin.write('stop\n')
  parent.stdin.flush()
  expect(await waitGone(children)).toEqual([])
  expect(processes().has(parent.pid)).toBe(true)
})

test('stopping a dev server stops its whole tree', async () => {
  const project = tempDir()
  const server = detectSandbox().start({
    command: twoSleeps(),
    cwd: project,
    writable: [project],
  })
  for (let i = 0; i < 50 && tree(server.pid).length < 3; i++) await Bun.sleep(50)
  const children = tree(server.pid)
  expect(children.length).toBeGreaterThanOrEqual(3)
  server.stop()
  await server.exited
  expect(await waitGone(children)).toEqual([])
})
