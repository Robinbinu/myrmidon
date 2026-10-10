import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { constants, homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { Process } from '@oh-my-pi/pi-natives'
import {
  SANDBOX_HIDDEN_ROOTS,
  SANDBOX_HIDDEN_TMP,
  SANDBOX_MAX_OUTPUT,
  SANDBOX_SYSTEM_BINS,
  SANDBOX_TEMP_READABLE,
} from './config.ts'
import { spawnLeashed } from './leashed.ts'
import { presetOf } from './permissions.ts'
import { realOrNone, realPath, toolchainPaths, within } from './read-access.ts'
import { hostShell } from './shell.ts'
import type { ColonySpec } from './spec.ts'

export interface SandboxRun {
  readonly command: string
  readonly cwd: string
  /**
   * The only directories the command may write to. The first one other than `cwd` (else `cwd`) holds the command's
   * private HOME and TMPDIR, so tools that write under ~ (pip, npm, git, Python's caches) stay out of the project.
   */
  readonly writable: readonly string[]
  /**
   * Folders (or files) the command may read but not write although they sit in the person's home or a `hidden`
   * folder: the project, the chat's own folder, folders the person allowed. Writable folders are readable too.
   */
  readonly readable?: readonly string[]
  /**
   * Folders the command can neither read nor write, besides the person's home (always hidden): Myrmidon's data
   * folder, the person's keys inside a readable folder. A readable or writable folder inside one is reachable again.
   */
  readonly hidden?: readonly string[]
  readonly timeoutMs: number
  readonly env?: Record<string, string>
}

export interface SandboxResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** A long-running confined process, such as a dev server. */
export interface SandboxProcess {
  readonly pid: number
  /** The latest output (stdout and stderr interleaved), up to 64 KB. */
  output(): string
  /** Resolves with the exit code once the process ends. */
  readonly exited: Promise<number | null>
  stop(): void
}

export interface Sandbox {
  /** `unconfined` is full access: commands run as the person, with no OS confinement at all. */
  readonly kind: 'sandbox-exec' | 'bubblewrap' | 'none' | 'unconfined'
  /** The program and arguments `run` and `start` execute for a spec: the command inside its confinement, if any. */
  argv(spec: Omit<SandboxRun, 'timeoutMs'>): string[]
  run(spec: SandboxRun): Promise<SandboxResult>
  /** Starts a process that keeps running (no timeout) until stopped; same confinement as `run`. */
  start(spec: Omit<SandboxRun, 'timeoutMs'>): SandboxProcess
}

function cap(text: string) {
  return text.length > SANDBOX_MAX_OUTPUT
    ? `${text.slice(0, SANDBOX_MAX_OUTPUT)}\n…[truncated ${text.length - SANDBOX_MAX_OUTPUT} chars]`
    : text
}

// SBPL string literals have no escaping we rely on, so paths with quotes or backslashes are refused.
function sbplPath(path: string) {
  if (/["\\]/.test(path)) throw new Error(`unsupported character in sandbox path: ${path}`)
  return `"${path}"`
}

type PathSpec = Pick<SandboxRun, 'writable' | 'readable' | 'hidden'>

/**
 * Loopback ports no confined command may connect to: the DevTools port of the Chrome Myrmidon runs, which answers
 * anyone on this computer without a key and would hand over every tab (the person's own, other chats') and its
 * cookies. Each profile is written as its command starts, so a port is guarded from the commands started after it is
 * added; the browser adds its port when it is made, before any command runs. bubblewrap cannot filter ports, so on
 * Linux this guards nothing.
 */
const guardedPorts = new Set<number>()

export function guardLoopbackPort(port: number): void {
  guardedPorts.add(port)
}

export interface PathRule {
  readonly path: string
  readonly access: 'hide' | 'read' | 'write'
}

const ORDER = { hide: 0, read: 1, write: 2 } as const

/**
 * Myrmidon's socket folders in /tmp as they are now (see SANDBOX_HIDDEN_TMP), for bubblewrap, which can only cover
 * folders that exist: one made after a command started stays visible to it. macOS's profile matches them by name.
 */
function tmpSocketDirs(): string[] {
  if (process.platform !== 'linux') return []
  try {
    return readdirSync('/tmp')
      .filter((name) => name.startsWith(SANDBOX_HIDDEN_TMP))
      .map((name) => join('/tmp', name))
  } catch {
    return []
  }
}
const depth = (path: string) => path.split(sep).filter(Boolean).length

/**
 * A command's path rules, parents before children, so the deepest rule covering a path decides (in SBPL the last
 * matching rule wins; in bubblewrap a later mount covers an earlier one). The person's home is hidden; toolchains,
 * readable and writable folders are opened inside it; `hidden` folders are closed again inside those.
 */
export function pathRules(spec: PathSpec, home: string): PathRule[] {
  // Only real paths match (macOS checks /private/var for /var). A folder to open that does not exist needs no rule;
  // one to hide keeps its rule, so a command that could write its parent cannot create it (~/.ssh in a project at ~).
  const real = (paths: readonly string[]) => paths.flatMap((p) => realOrNone(p) ?? [])
  const rules: PathRule[] = [
    ...[
      ...(home && home !== sep ? [home] : []),
      ...SANDBOX_HIDDEN_ROOTS,
      ...tmpSocketDirs(),
      ...(spec.hidden ?? []),
    ].map((path) => ({
      path: realPath(path),
      access: 'hide' as const,
    })),
    // The running program itself: plugin tests run Myrmidon's own binary, wherever it is installed.
    ...[...toolchainPaths(home), ...real(spec.readable ?? []), ...real([process.execPath])].map((path) => ({
      path,
      access: 'read' as const,
    })),
    ...spec.writable.map((d) => ({ path: realpathSync(d), access: 'write' as const })),
  ]
  const seen = new Set<string>()
  return rules
    .sort((a, b) => depth(a.path) - depth(b.path) || ORDER[a.access] - ORDER[b.access])
    .filter((r) => {
      const key = `${r.access}:${r.path}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** The folders above `path`: a program stats its way down to a folder it may read, while listing them stays denied. */
function ancestors(path: string): string[] {
  const out: string[] = []
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) out.push(dir)
  return [...out, sep]
}

export function macProfile(spec: PathSpec, home: string): string {
  const rules = pathRules(spec, home)
  const subpath = (r: PathRule) => `(subpath ${sbplPath(r.path)})`
  const reads = rules.map((r) => `(${r.access === 'hide' ? 'deny' : 'allow'} file-read* ${subpath(r)})`)
  // Connecting to a unix socket is not a file read: a socket in a hidden folder (the Cua Driver's, in the data
  // folder) would stay reachable without its own rules. It acts on a service, so like writing it needs a folder the
  // command may write: a folder it may only read (a key folder the person opened) gives no docker.sock.
  const sockets = rules
    .filter((r) => r.access !== 'read')
    .map(
      (r) =>
        `(${r.access === 'hide' ? 'deny' : 'allow'} network-outbound (remote unix-socket ${subpath(r)}))`,
    )
  // Socket folders made in /tmp after this profile was written (a dev server keeps its profile for hours).
  const tmp = `(regex #"^/private/tmp/${SANDBOX_HIDDEN_TMP}")`
  const temp = SANDBOX_TEMP_READABLE.map((name) => `(regex #"^/private/var/folders/[^/]+/[^/]+/T/${name}")`)
  const writes = rules
    .filter((r) => r.access !== 'read')
    .map((r) => `(${r.access === 'hide' ? 'deny' : 'allow'} file-write* ${subpath(r)})`)
  const opened = rules.filter((r) => r.access !== 'hide').map((r) => r.path)
  const parents = [...new Set(opened.flatMap(ancestors))]
  const above = parents.map((d) => `(literal ${sbplPath(d)})`)
  // bun opens the folders above a project to find its root, and fails when it cannot: inside the folders hidden
  // outside the home (a project in the temp folder), those on the way down may be listed, never their files, unless
  // something hidden for its own sake (a home, the data folder) holds them.
  const roots = SANDBOX_HIDDEN_ROOTS.map(realPath)
  const guarded = rules.filter((r) => r.access === 'hide' && !roots.includes(r.path)).map((r) => r.path)
  const listed = parents
    .filter((d) => roots.some((r) => within(d, r)) && !guarded.some((g) => within(d, g)))
    .map((d) => `(literal ${sbplPath(d)})`)
  return [
    '(version 1)',
    '(allow default)',
    ...reads,
    // After the reads, so a readable /tmp (or /) does not open them again: the last matching rule wins.
    `(deny file-read* ${tmp})`,
    `(allow file-read* ${temp.join(' ')})`,
    ...sockets,
    `(deny network-outbound (remote unix-socket ${tmp}))`,
    // SBPL's "localhost" is every loopback address, 127.0.0.1 and ::1 alike.
    ...[...guardedPorts].map((port) => `(deny network-outbound (remote ip "localhost:${port}"))`),
    // Commands are Myrmidon's children, so macOS lets them use its Screen Recording and Accessibility grants. With no
    // window server and no ScreenCaptureKit (replayd) they cannot capture the screen or post input events, and with
    // no Apple events they cannot script other apps (System Events). Accessibility calls made straight to another
    // app's process are not covered here.
    '(deny mach-lookup (global-name-regex #"^com\\.apple\\.windowserver") (global-name "com.apple.replayd"))',
    '(deny appleevent-send)',
    // LaunchServices starts what it opens outside the sandbox: `open ./Made.app` (or NSWorkspace) would run a bundle
    // the command wrote with none of these rules.
    '(deny lsopen)',
    // The clipboard often holds passwords. Builds, git, package managers and test runners do not use it; a test
    // that copies and pastes fails here.
    '(deny mach-lookup (global-name-regex #"^com\\.apple\\.pasteboard\\."))',
    '(deny file-write*)',
    ...writes,
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))',
    ...(above.length ? [`(allow file-read-metadata ${above.join(' ')})`] : []),
    ...(listed.length ? [`(allow file-read* ${listed.join(' ')})`] : []),
  ].join('\n')
}

/** The same rules as bubblewrap mounts: an empty tmpfs (or /dev/null, for a file) over what is hidden. */
export function bwrapMounts(spec: PathSpec, home: string): string[] {
  return pathRules(spec, home).flatMap((r) => {
    if (r.access === 'write') return ['--bind', r.path, r.path]
    if (r.access === 'read') return ['--ro-bind', r.path, r.path]
    // A mount needs something to cover.
    if (!existsSync(r.path)) return []
    return statSync(r.path).isDirectory() ? ['--tmpfs', r.path] : ['--ro-bind', '/dev/null', r.path]
  })
}

const HOME_DIR = '.home'
const TMP_DIR = '.tmp'
/** A command's private HOME and TMPDIR, folders of the agent's scratch that file listings leave out. */
export const SANDBOX_DIRS: ReadonlySet<string> = new Set([HOME_DIR, TMP_DIR])

/**
 * A sandboxed command's PATH: the entries of the person's `path` that are toolchains in their `home` or system
 * folders (SANDBOX_SYSTEM_BINS), in their order, then the system folders it lacks. The rest would name their apps
 * and folders, and the sandbox could not run what is in them anyway.
 */
export function sandboxPath(path: string | undefined, home: string): string {
  const toolchains = toolchainPaths(home)
  const system: readonly string[] = SANDBOX_SYSTEM_BINS
  const kept = (path ?? '').split(':').filter((dir) => {
    if (system.includes(dir)) return true
    const real = dir.startsWith(sep) ? realOrNone(dir) : undefined
    return real !== undefined && toolchains.some((t) => within(real, t))
  })
  return [...new Set([...kept, ...system.filter((dir) => existsSync(dir))])].join(':')
}

function confinedEnv(spec: Omit<SandboxRun, 'timeoutMs'>, person: string) {
  const own = spec.writable.find((d) => d !== spec.cwd) ?? spec.cwd
  const home = join(own, HOME_DIR)
  const tmp = join(own, TMP_DIR)
  mkdirSync(home, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  return { PATH: sandboxPath(process.env.PATH, person), HOME: home, TMPDIR: tmp, ...spec.env }
}

function startConfined(
  argv: string[],
  spec: Omit<SandboxRun, 'timeoutMs'>,
  env: Record<string, string | undefined>,
): SandboxProcess {
  // Leashed outside the confinement, so a dev server and what it started stop when Myrmidon dies, however it dies.
  const proc = spawnLeashed(argv, { cwd: spec.cwd, env, stdout: 'pipe', stderr: 'pipe' })
  let output = ''
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true })
      if (output.length > SANDBOX_MAX_OUTPUT) output = output.slice(-SANDBOX_MAX_OUTPUT)
    }
  }
  void drain(proc.stdout)
  void drain(proc.stderr)
  return {
    pid: proc.pid,
    output: () => output,
    exited: proc.exited.then((code) => (proc.signalCode ? null : code)),
    stop: () => {
      killTree(proc.pid, 'SIGTERM')
      setTimeout(() => {
        if (proc.exitCode === null && !proc.signalCode) killTree(proc.pid, 'SIGKILL')
      }, 3000).unref()
    },
  }
}

/**
 * Signals a process and all its descendants, children first: a dev server is usually a shell running npm running the
 * real server. Windows has no signals, so there the whole tree is ended at once.
 */
function killTree(pid: number, signal: 'SIGTERM' | 'SIGKILL') {
  // Null when it has already gone.
  Process.fromPid(pid)?.killTree(constants.signals[signal])
}

async function spawnConfined(argv: string[], spec: SandboxRun, home: string): Promise<SandboxResult> {
  const proc = Bun.spawn(argv, {
    cwd: spec.cwd,
    env: confinedEnv(spec, home),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: spec.timeoutMs,
    killSignal: 'SIGKILL',
    windowsHide: true,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const timedOut = proc.signalCode === 'SIGKILL'
  return { code: timedOut ? null : code, stdout: cap(stdout), stderr: cap(stderr), timedOut }
}

/** No confinement: the command in this OS's shell (Git Bash, else PowerShell, on Windows; see shell.ts). */
const plainShell = (spec: Omit<SandboxRun, 'timeoutMs'>) => hostShell().argv(spec.command)

/**
 * A command run to completion on a leash: when it times out, the leash stops its whole tree (killing the leash alone
 * would orphan the command), and what it leaves running in the background is stopped when it ends.
 */
async function runLeashed(
  argv: string[],
  spec: SandboxRun,
  env: Record<string, string | undefined>,
): Promise<SandboxResult> {
  const proc = spawnLeashed(argv, { cwd: spec.cwd, env, stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.stdin.end()
  }, spec.timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code: timedOut ? null : code, stdout: cap(stdout), stderr: cap(stderr), timedOut }
}

/**
 * Full access, like Hermes Agent's local backend: commands run directly as the person, in their own environment and
 * home, able to read and change anything they can. Still leashed (nothing outlives Myrmidon), timed out and capped.
 */
export function unconfinedSandbox(): Sandbox {
  const argv = plainShell
  const env = (spec: Omit<SandboxRun, 'timeoutMs'>) => ({ ...process.env, ...spec.env })
  return {
    kind: 'unconfined',
    argv,
    run: (spec) => runLeashed(argv(spec), spec, env(spec)),
    start: (spec) => startConfined(argv(spec), spec, env(spec)),
  }
}

/**
 * Whether a round runs with full access: it was given it, and nobody but the person wrote into it (a channel member's
 * round never has it), and it is not read-only (which only the sandbox can keep untouched).
 */
export function fullAccessIn(
  spec: Pick<ColonySpec, 'fullAccess' | 'askAll' | 'chat' | 'permissions'>,
): boolean {
  return !!spec.fullAccess && !spec.askAll && presetOf(spec) !== 'read-only'
}

/**
 * Picks the OS confinement backend. Returns `none` when no backend exists; callers must refuse exec tools then.
 * `home` is the person's home, hidden from commands but for what `pathRules` opens (tests pass a stand-in).
 */
export function detectSandbox(options: { home?: string } = {}): Sandbox {
  const home = options.home ?? homedir()
  if (process.platform === 'darwin' && Bun.which('sandbox-exec')) {
    const argv = (spec: Omit<SandboxRun, 'timeoutMs'>) => [
      'sandbox-exec',
      '-p',
      macProfile(spec, home),
      '/bin/sh',
      '-c',
      spec.command,
    ]
    return {
      kind: 'sandbox-exec',
      argv,
      run: (spec) => spawnConfined(argv(spec), spec, home),
      start: (spec) => startConfined(argv(spec), spec, confinedEnv(spec, home)),
    }
  }
  const bwrap = process.platform === 'linux' ? Bun.which('bwrap') : null
  if (bwrap) {
    const argv = (spec: Omit<SandboxRun, 'timeoutMs'>) => [
      bwrap,
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      ...bwrapMounts(spec, home),
      '--unshare-pid',
      '--die-with-parent',
      '--chdir',
      spec.cwd,
      '/bin/sh',
      '-c',
      spec.command,
    ]
    return {
      kind: 'bubblewrap',
      argv,
      run: (spec) => spawnConfined(argv(spec), spec, home),
      start: (spec) => startConfined(argv(spec), spec, confinedEnv(spec, home)),
    }
  }
  const argv = plainShell
  return {
    kind: 'none',
    argv,
    run: (spec) => spawnConfined(argv(spec), spec, home),
    start: (spec) => startConfined(argv(spec), spec, confinedEnv(spec, home)),
  }
}
