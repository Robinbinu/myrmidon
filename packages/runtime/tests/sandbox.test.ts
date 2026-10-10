import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { notOn, pendingOn } from '../../../tests/platform.ts'
import { processTable, treeOf } from '../src/leash.ts'
import { RUNTIMES } from '../src/patterns.ts'
import {
  detectSandbox,
  fullAccessIn,
  guardLoopbackPort,
  sandboxPath,
  unconfinedSandbox,
} from '../src/sandbox.ts'
import { hostShell } from '../src/shell.ts'

let root: string

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'myr-sandbox-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The processes below `pid`, and any shell or sleep however orphaned, with their parents and command lines. */
function below(pid: number) {
  const rows = processTable() ?? []
  const tree = treeOf(rows, pid)
  return rows
    .filter((r) => r.pid !== pid && (tree.has(r.pid) || /\b(sh|bash|sleep|leash)\b/i.test(r.command)))
    .map((r) => [r.pid, r.ppid, r.command])
}

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
  // Git Bash shows a Windows path the POSIX way (C:\a\b as /c/a/b); a program it runs is given the path itself.
  const home = join(scratch, '.home')
  expect(r.stdout.trim()).toBe(
    process.platform === 'win32'
      ? home.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
      : home,
  )
  expect(existsSync(join(scratch, '.home/Library/Caches/com.apple.python/x.pyc'))).toBe(true)
  expect(existsSync(join(scratch, '.tmp/t'))).toBe(true)
})

notOn('win32', 'posixPath')(
  "a sandboxed PATH keeps the person's toolchains and system folders, never their apps or other folders",
  async () => {
    const home = join(root, 'home')
    const bun = join(home, '.bun', 'bin')
    const nvm = join(home, '.nvm', 'versions', 'node', 'v22', 'bin')
    mkdirSync(bun, { recursive: true })
    mkdirSync(nvm, { recursive: true })
    const person = [
      join(home, '.railway', 'bin'),
      '/Applications/Little Snitch.app/Contents/Components',
      bun,
      join(home, 'Desktop', 'Myrmidon', 'node_modules', '.bin'),
      nvm,
      '/usr/bin',
      '/bin',
    ].join(':')
    const path = sandboxPath(person, home).split(':')
    // The person's order for what is kept, then the system folders it lacked.
    expect(path.slice(0, 4)).toEqual([bun, nvm, '/usr/bin', '/bin'])
    expect(path).toContain('/usr/sbin')
    expect(path.join(':')).not.toContain('Little Snitch')
    expect(path.join(':')).not.toContain('Desktop')
    expect(path.join(':')).not.toContain('.railway')
    // Every runtime agents are told about is still found.
    const real = sandboxPath(process.env.PATH, homedir())
    for (const runtime of RUNTIMES) expect(Bun.which(runtime, { PATH: real })).not.toBeNull()

    // A confined command sees that PATH; full access keeps the person's.
    const saved = process.env.PATH
    process.env.PATH = `/Applications/Wireshark.app/Contents/MacOS:${saved}`
    try {
      const spec = { command: 'echo "$PATH"', cwd: root, writable: [root], timeoutMs: 10_000 }
      const confined = await detectSandbox({ home }).run(spec)
      expect(confined.code).toBe(0)
      expect(confined.stdout).not.toContain('Wireshark')
      expect((await unconfinedSandbox().run(spec)).stdout).toContain('Wireshark')
    } finally {
      process.env.PATH = saved
    }
  },
)

test('full access runs the command itself, with no sandbox around it; the default wraps it', () => {
  const spec = { command: 'echo hi', cwd: root, writable: [root] }
  const bare = unconfinedSandbox().argv(spec)
  // The system's own shell: /bin/sh, or on Windows the one shell.ts picks (Git's sh first).
  expect(bare).toEqual(
    process.platform === 'win32' ? hostShell().argv('echo hi') : ['/bin/sh', '-c', 'echo hi'],
  )
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

pendingOn('win32', 'timeoutStopOnWindows')(
  'a full-access command that runs too long is stopped, with what it started',
  async () => {
    const marker = join(root, 'late')
    const started = Date.now()
    const log = join(root, 'leash.log')
    const running = unconfinedSandbox().run({
      command: `(sleep 3 && touch "${marker}") & sleep 30`,
      cwd: root,
      writable: [root],
      timeoutMs: 500,
      env: { MYR_LEASH_LOG: log },
    })
    const r = await Promise.race([running, Bun.sleep(10_000)])
    // Says what is still running, and what the leash saw (leash.ts MYR_LEASH_LOG), when the command was not stopped.
    if (!r)
      throw new Error(
        `not stopped: ${JSON.stringify(below(process.pid))}\n${existsSync(log) ? readFileSync(log, 'utf8') : 'no sweep'}`,
      )
    expect(r.timedOut).toBe(true)
    expect(r.code).toBeNull()
    expect(Date.now() - started).toBeLessThan(10_000)
    await Bun.sleep(3_500)
    expect(existsSync(marker)).toBe(false)
  },
  20_000,
)

test.skipIf(detectSandbox().kind === 'none')(
  "a sandboxed command cannot connect to a socket in a hidden folder or another run's /tmp/myr-*, only its own",
  async () => {
    const hidden = join(root, 'h')
    const own = join(root, 'w')
    const tmp = realpathSync.native(mkdtempSync('/tmp/myr-sock-'))
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
    // The clipboard is out of reach: the probe only counts what kinds of data it holds, never reads them.
    const clipboard = await run(
      `osascript -l JavaScript -e 'ObjC.import("AppKit"); var t = $.NSPasteboard.generalPasteboard.types; "types=" + (t ? t.count : "none")'`,
    )
    expect(clipboard.stdout.trim()).toBe('types=none')
  },
  30_000,
)

test.skipIf(detectSandbox().kind !== 'sandbox-exec')(
  'a sandboxed command cannot have LaunchServices start an app it wrote, outside the sandbox',
  async () => {
    const scratch = join(root, 'scratch')
    const outside = join(root, 'outside')
    const app = join(scratch, 'Probe.app')
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(
      join(app, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>run</string>
<key>CFBundleIdentifier</key><string>dev.myrmidon.test.probe-${Date.now()}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>`,
    )
    // Started by LaunchServices it would run unconfined, and could write where the command cannot.
    writeFileSync(join(app, 'Contents', 'MacOS', 'run'), `#!/bin/sh\ntouch "${outside}/escaped"\n`)
    chmodSync(join(app, 'Contents', 'MacOS', 'run'), 0o755)
    try {
      const r = await detectSandbox().run({
        command: `open -g -j "${app}"`,
        cwd: scratch,
        writable: [scratch],
        timeoutMs: 20_000,
      })
      expect(r.code).not.toBe(0)
      await Bun.sleep(1_500)
      expect(existsSync(join(outside, 'escaped'))).toBe(false)
    } finally {
      Bun.spawnSync([
        '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
        '-u',
        app,
      ])
    }
  },
  30_000,
)

test.skipIf(detectSandbox().kind === 'none')(
  "outside the home, other disks, the shared folder, temp folders and other runs' /tmp/myr-* stay unreadable",
  async () => {
    const project = join(root, 'project')
    const scratch = join(root, 'scratch')
    const other = realpathSync.native(mkdtempSync('/tmp/myr-other-'))
    mkdirSync(project)
    mkdirSync(scratch)
    // The test's own folder is in the temp folder (macOS) or is a /tmp/myr-* folder (Linux): outside its project.
    writeFileSync(join(root, 'left.txt'), 'left behind')
    writeFileSync(join(other, 'run.txt'), 'another run')
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { hi: 'echo hi' } }))
    const run = (command: string) =>
      detectSandbox().run({ command, cwd: project, writable: [project, scratch], timeoutMs: 20_000 })
    try {
      expect((await run(`cat "${join(root, 'left.txt')}"`)).code).not.toBe(0)
      expect((await run(`cat "${join(other, 'run.txt')}"`)).code).not.toBe(0)
      // A readable /tmp does not open them again.
      const tmpOpen = await detectSandbox().run({
        command: `cat "${join(other, 'run.txt')}"`,
        cwd: project,
        writable: [project, scratch],
        readable: ['/tmp'],
        timeoutMs: 20_000,
      })
      expect(tmpOpen.code).not.toBe(0)
      for (const dir of ['/Volumes', '/Users/Shared'].filter(existsSync))
        expect((await run(`ls "${dir}"`)).code).not.toBe(0)
      // What toolchains and the command's own temp need still works.
      const commands = [
        `"${process.execPath}" --version`,
        // bun looks for the project's root in the folders above it.
        `"${process.execPath}" run --silent hi`,
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

/** A server on loopback outside the sandbox, answering `name`. */
function loopbackServer(name: string) {
  return Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(name) })
}

/** Fetches `url` from inside the sandbox with bun, which every sandbox may run. */
function fetchInside(url: string) {
  return detectSandbox().run({
    command: `"${process.execPath}" -e 'process.stdout.write(await (await fetch("${url}")).text())'`,
    cwd: root,
    writable: [root],
    timeoutMs: 20_000,
  })
}

test.skipIf(detectSandbox().kind === 'none')(
  'a sandboxed command keeps the network: it reaches a server on loopback outside the sandbox',
  async () => {
    const server = loopbackServer('served')
    try {
      const r = await fetchInside(`http://127.0.0.1:${server.port}/`)
      expect({ code: r.code, stdout: r.stdout }).toEqual({ code: 0, stdout: 'served' })
    } finally {
      server.stop(true)
    }
  },
  30_000,
)

pendingOn('linux', 'devtoolsPortOnLinux', detectSandbox().kind === 'none')(
  "a sandboxed command cannot reach a guarded loopback port, such as the managed Chrome's DevTools",
  async () => {
    const devtools = loopbackServer('devtools')
    guardLoopbackPort(devtools.port as number)
    try {
      for (const host of ['127.0.0.1', 'localhost']) {
        const r = await fetchInside(`http://${host}:${devtools.port}/json/version`)
        expect(r.stdout).not.toContain('devtools')
        expect(r.code).not.toBe(0)
      }
    } finally {
      devtools.stop(true)
    }
  },
  30_000,
)

test.skipIf(detectSandbox().kind !== 'bubblewrap')(
  "on Linux the X server's sockets, the session's runtime folder and other accounts' homes are out of sight",
  async () => {
    const run = (command: string) =>
      detectSandbox().run({ command, cwd: root, writable: [root], timeoutMs: 10_000 })
    const uid = process.getuid?.()
    const runtime = [`/run/user/${uid}`, process.env.XDG_RUNTIME_DIR].filter((d): d is string => !!d)
    // A runner without a display has no /tmp/.X11-unix; one is made there so the socket check runs (CI only).
    const x11 = '/tmp/.X11-unix'
    const madeX11 = !existsSync(x11) && !!process.env.CI
    if (madeX11) {
      mkdirSync(x11)
      chmodSync(x11, 0o1777)
    }
    const display = join(x11, `X${4000 + Math.floor(Math.random() * 1000)}`)
    const server = existsSync(x11)
      ? Bun.listen({
          unix: display,
          socket: {
            open(s) {
              s.write('x11')
              s.end()
            },
            data() {},
          },
        })
      : undefined
    try {
      for (const dir of [x11, ...runtime].filter(existsSync)) {
        const r = await run(`ls -A "${dir}"`)
        expect({ dir, code: r.code === 0 ? 0 : 'denied' }).toEqual({ dir, code: 'denied' })
      }
      if (server) {
        const connect = await run(
          `"${process.execPath}" -e 'await Bun.connect({ unix: "${display}", socket: { data(_, d) { process.stdout.write(d); process.exit(0) } } })'`,
        )
        expect(connect.stdout).not.toContain('x11')
        expect(connect.code).not.toBe(0)
      }
      // A runtime folder elsewhere is hidden too, when it is the person's alone as the XDG spec has it; a shared
      // folder named there is not.
      const saved = process.env.XDG_RUNTIME_DIR
      const own = join(root, 'runtime')
      mkdirSync(own, { mode: 0o700 })
      writeFileSync(join(own, 'bus'), 'session bus')
      try {
        process.env.XDG_RUNTIME_DIR = own
        expect((await run(`cat "${own}/bus"`)).code).not.toBe(0)
        process.env.XDG_RUNTIME_DIR = '/tmp'
        expect((await run('ls /tmp')).code).toBe(0)
      } finally {
        if (saved === undefined) delete process.env.XDG_RUNTIME_DIR
        else process.env.XDG_RUNTIME_DIR = saved
      }
      // /home shows at most the folders on the way to what opens (Bun's own folder, the person's home); the others
      // cannot be listed or read.
      const mine = new Set(
        [homedir(), process.execPath].filter((p) => p.startsWith('/home/')).map((p) => p.split('/')[2]),
      )
      const listed = await run('ls -A /home')
      if (listed.code === 0)
        expect(listed.stdout.split('\n').filter((name) => name && !mine.has(name))).toEqual([])
      for (const name of existsSync('/home') ? readdirSync('/home').filter((n) => !mine.has(n)) : [])
        expect((await run(`ls -A "/home/${name}"`)).code).not.toBe(0)
    } finally {
      server?.stop(true)
      rmSync(display, { force: true })
      if (madeX11) rmSync(x11, { recursive: true, force: true })
    }
  },
  30_000,
)

test.skipIf(detectSandbox().kind !== 'bubblewrap')(
  'on Linux a sandboxed command runs in a session of its own, so it cannot type into the terminal Myrmidon runs in',
  async () => {
    // The session id as the sandbox's own process list sees it: 0 when the session leader is outside the sandbox
    // (Myrmidon's terminal session), its own shell when the command has a session of its own.
    const r = await detectSandbox().run({
      command: 'read -r _ _ _ _ _ sid _ < /proc/self/stat && echo "$sid"',
      cwd: root,
      writable: [root],
      timeoutMs: 10_000,
    })
    expect(r.code).toBe(0)
    expect(Number(r.stdout.trim())).toBeGreaterThan(0)
  },
)

test('full access never holds for a round someone else wrote into, nor in a read-only project', () => {
  const chat = (preset: 'auto' | 'read-only' | 'full') => ({
    chatId: 'c',
    round: 1,
    request: 'r',
    history: '',
    project: { id: 'p', name: 'p', path: root, permissions: { preset, rules: [] } },
  })
  expect(fullAccessIn({ fullAccess: true })).toBe(true)
  expect(fullAccessIn({})).toBe(false)
  expect(fullAccessIn({ fullAccess: true, askAll: true })).toBe(false)
  expect(fullAccessIn({ fullAccess: true, chat: chat('read-only') })).toBe(false)
  expect(fullAccessIn({ fullAccess: true, chat: chat('full') })).toBe(true)
})
