import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectSandbox, fullAccessIn, unconfinedSandbox } from '../src/sandbox.ts'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'myr-sandbox-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('a command run in the project keeps HOME and TMPDIR in the agent scratch, not the project', async () => {
  const project = join(root, 'project')
  const scratch = join(root, 'scratch')
  mkdirSync(project)
  mkdirSync(scratch)
  const caches = '$HOME/Library/Caches/com.apple.python'
  const r = await detectSandbox().run({
    command: `mkdir -p "${caches}" && touch "${caches}/x.pyc" "$TMPDIR/t" && echo "$HOME"`,
    cwd: project,
    writable: [project, scratch],
    timeoutMs: 10_000,
  })
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(readdirSync(project)).toEqual([])
  expect(r.stdout.trim()).toBe(join(scratch, '.home'))
  expect(existsSync(join(scratch, '.home/Library/Caches/com.apple.python/x.pyc'))).toBe(true)
  expect(existsSync(join(scratch, '.tmp/t'))).toBe(true)
})

test('full access runs the command itself, with no sandbox around it; the default wraps it', () => {
  const spec = { command: 'echo hi', cwd: root, writable: [root] }
  const bare = unconfinedSandbox().argv(spec)
  expect(bare).toEqual(['/bin/sh', '-c', 'echo hi'])
  expect(bare.some((a) => /sandbox-exec|bwrap/.test(a))).toBe(false)
  const confined = detectSandbox()
  if (confined.kind === 'sandbox-exec') expect(confined.argv(spec)[0]).toBe('sandbox-exec')
  if (confined.kind === 'bubblewrap') expect(confined.argv(spec)[0]).toEndWith('bwrap')
})

test.skipIf(detectSandbox().kind === 'none')(
  'a full-access command writes outside its folders and sees the real home; a confined one cannot',
  async () => {
    const scratch = join(root, 'scratch')
    const outside = join(root, 'outside')
    mkdirSync(scratch)
    mkdirSync(outside)
    const spec = {
      command: `touch "${outside}/x" && echo "$HOME"`,
      cwd: scratch,
      writable: [scratch],
      timeoutMs: 10_000,
    }
    const confined = await detectSandbox().run(spec)
    expect(confined.code).not.toBe(0)
    expect(existsSync(join(outside, 'x'))).toBe(false)
    const free = await unconfinedSandbox().run(spec)
    expect(free.code).toBe(0)
    expect(existsSync(join(outside, 'x'))).toBe(true)
    expect(free.stdout.trim()).toBe(homedir())
  },
)

test('a full-access command that runs too long is stopped, with what it started', async () => {
  const marker = join(root, 'late')
  const started = Date.now()
  const r = await unconfinedSandbox().run({
    command: `(sleep 3 && touch "${marker}") & sleep 30`,
    cwd: root,
    writable: [root],
    timeoutMs: 500,
  })
  expect(r.timedOut).toBe(true)
  expect(r.code).toBeNull()
  expect(Date.now() - started).toBeLessThan(10_000)
  await Bun.sleep(3_500)
  expect(existsSync(marker)).toBe(false)
}, 20_000)

test.skipIf(detectSandbox().kind === 'none')(
  "a sandboxed command cannot connect to a socket in a hidden folder or another run's /tmp/myr-*, only its own",
  async () => {
    const hidden = join(root, 'h')
    const own = join(root, 'w')
    const tmp = realpathSync(mkdtempSync('/tmp/myr-sock-'))
    mkdirSync(hidden)
    mkdirSync(own)
    const sockets = [join(hidden, 'd.sock'), join(tmp, 'd.sock'), join(own, 'd.sock')]
    const servers = sockets.map((unix) =>
      Bun.listen({
        unix,
        socket: {
          open(s) {
            s.write('hi')
            s.end()
          },
          data() {},
        },
      }),
    )
    try {
      const sandbox = detectSandbox()
      // The client is bun itself, which every sandbox may run.
      const connect = (path: string) =>
        sandbox.run({
          command: `"${process.execPath}" -e 'await Bun.connect({ unix: "${path}", socket: { data(_, d) { process.stdout.write(d); process.exit(0) }, close() { process.exit(0) } } })'`,
          cwd: own,
          writable: [own],
          hidden: [hidden],
          timeoutMs: 10_000,
        })
      expect((await connect(sockets[2] as string)).stdout).toBe('hi')
      for (const path of sockets.slice(0, 2)) {
        const r = await connect(path as string)
        expect(r.stdout).not.toContain('hi')
        expect(r.code).not.toBe(0)
      }
    } finally {
      for (const s of servers) s.stop(true)
      rmSync(tmp, { recursive: true, force: true })
    }
  },
)

test.skipIf(detectSandbox().kind !== 'sandbox-exec')(
  "a sandboxed command cannot capture the screen or drive apps with Myrmidon's privacy grants",
  async () => {
    const shot = join(root, 'shot.png')
    const run = (command: string) =>
      detectSandbox().run({ command, cwd: root, writable: [root], timeoutMs: 20_000 })
    await run(`/usr/sbin/screencapture -x "${shot}"`)
    expect(existsSync(shot)).toBe(false)
    const events = await run(
      `osascript -e 'with timeout of 5 seconds' -e 'tell application "System Events" to count processes' -e 'end timeout'`,
    )
    expect(events.code).not.toBe(0)
  },
  30_000,
)

test.skipIf(detectSandbox().kind === 'none')(
  "outside the home, other disks, the shared folder, temp folders and other runs' /tmp/myr-* stay unreadable",
  async () => {
    const project = join(root, 'project')
    const scratch = join(root, 'scratch')
    const other = realpathSync(mkdtempSync('/tmp/myr-other-'))
    mkdirSync(project)
    mkdirSync(scratch)
    // The test's own folder is in the temp folder (macOS) or is a /tmp/myr-* folder (Linux): outside its project.
    writeFileSync(join(root, 'left.txt'), 'left behind')
    writeFileSync(join(other, 'run.txt'), 'another run')
    const run = (command: string) =>
      detectSandbox().run({ command, cwd: project, writable: [project, scratch], timeoutMs: 20_000 })
    try {
      expect((await run(`cat "${join(root, 'left.txt')}"`)).code).not.toBe(0)
      expect((await run(`cat "${join(other, 'run.txt')}"`)).code).not.toBe(0)
      for (const dir of ['/Volumes', '/Users/Shared'].filter(existsSync))
        expect((await run(`ls "${dir}"`)).code).not.toBe(0)
      // What toolchains and the command's own temp need still works.
      const commands = [
        `"${process.execPath}" --version`,
        'echo x > "$TMPDIR/t" && cat "$TMPDIR/t"',
        ...(Bun.which('bun') ? ['bun --version'] : []),
        ...(Bun.which('python3') ? ['python3 -c 1'] : []),
        ...(Bun.which('git') ? ['git init -q && git status --short'] : []),
      ]
      for (const command of commands) {
        const r = await run(command)
        expect({ command, code: r.code, stderr: r.stderr }).toEqual({ command, code: 0, stderr: '' })
      }
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  },
  60_000,
)

test('full access never holds for a round someone else wrote into, nor in a read-only project', () => {
  const chat = (mode: 'auto' | 'read-only' | 'full') => ({
    chatId: 'c',
    round: 1,
    request: 'r',
    history: '',
    project: { id: 'p', name: 'p', path: root, permissions: { mode, allow: [] } },
  })
  expect(fullAccessIn({ fullAccess: true })).toBe(true)
  expect(fullAccessIn({})).toBe(false)
  expect(fullAccessIn({ fullAccess: true, askAll: true })).toBe(false)
  expect(fullAccessIn({ fullAccess: true, chat: chat('read-only') })).toBe(false)
  expect(fullAccessIn({ fullAccess: true, chat: chat('full') })).toBe(true)
})
