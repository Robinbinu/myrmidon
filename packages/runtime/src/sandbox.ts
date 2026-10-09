import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { SANDBOX_MAX_OUTPUT } from './config.ts'
import { spawnLeashed } from './leashed.ts'
import type { ColonySpec } from './spec.ts'

export interface SandboxRun {
  readonly command: string
  readonly cwd: string
  /**
   * The only directories the command may write to. The first one other than `cwd` (else `cwd`) holds the command's
   * private HOME and TMPDIR, so tools that write under ~ (pip, npm, git, Python's caches) stay out of the project.
   */
  readonly writable: readonly string[]
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

function macProfile(writable: readonly string[]) {
  const dirs = writable.map((d) => `(subpath ${sbplPath(realpathSync(d))})`).join(' ')
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${dirs} (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))`,
  ].join('\n')
}

const HOME_DIR = '.home'
const TMP_DIR = '.tmp'
/** A command's private HOME and TMPDIR, folders of the agent's scratch that file listings leave out. */
export const SANDBOX_DIRS: ReadonlySet<string> = new Set([HOME_DIR, TMP_DIR])

function confinedEnv(spec: Omit<SandboxRun, 'timeoutMs'>) {
  const own = spec.writable.find((d) => d !== spec.cwd) ?? spec.cwd
  const home = join(own, HOME_DIR)
  const tmp = join(own, TMP_DIR)
  mkdirSync(home, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: tmp, ...spec.env }
}

function startConfined(
  argv: string[],
  spec: Omit<SandboxRun, 'timeoutMs'>,
  env: Record<string, string | undefined> = confinedEnv(spec),
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

/** Signals a process and all its descendants: a dev server is usually a shell running npm running the real server. */
function killTree(pid: number, signal: 'SIGTERM' | 'SIGKILL') {
  const children = new TextDecoder()
    .decode(Bun.spawnSync(['pgrep', '-P', String(pid)]).stdout)
    .split('\n')
    .map(Number)
    .filter((n) => n > 0)
  for (const child of children) killTree(child, signal)
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone.
  }
}

async function spawnConfined(argv: string[], spec: SandboxRun): Promise<SandboxResult> {
  const proc = Bun.spawn(argv, {
    cwd: spec.cwd,
    env: confinedEnv(spec),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: spec.timeoutMs,
    killSignal: 'SIGKILL',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const timedOut = proc.signalCode === 'SIGKILL'
  return { code: timedOut ? null : code, stdout: cap(stdout), stderr: cap(stderr), timedOut }
}

const plainShell = (spec: Omit<SandboxRun, 'timeoutMs'>) => ['/bin/sh', '-c', spec.command]

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
 * round never has it), and its project is not read-only (which only the sandbox can keep untouched).
 */
export function fullAccessIn(spec: Pick<ColonySpec, 'fullAccess' | 'askAll' | 'chat'>): boolean {
  return !!spec.fullAccess && !spec.askAll && spec.chat?.project?.permissions?.mode !== 'read-only'
}

/** Picks the OS confinement backend. Returns `none` when no backend exists; callers must refuse exec tools then. */
export function detectSandbox(): Sandbox {
  if (process.platform === 'darwin' && Bun.which('sandbox-exec')) {
    const argv = (spec: Omit<SandboxRun, 'timeoutMs'>) => [
      'sandbox-exec',
      '-p',
      macProfile(spec.writable),
      '/bin/sh',
      '-c',
      spec.command,
    ]
    return {
      kind: 'sandbox-exec',
      argv,
      run: (spec) => spawnConfined(argv(spec), spec),
      start: (spec) => startConfined(argv(spec), spec),
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
      ...spec.writable.flatMap((d) => ['--bind', d, d]),
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
      run: (spec) => spawnConfined(argv(spec), spec),
      start: (spec) => startConfined(argv(spec), spec),
    }
  }
  const argv = plainShell
  return {
    kind: 'none',
    argv,
    run: (spec) => spawnConfined(argv(spec), spec),
    start: (spec) => startConfined(argv(spec), spec),
  }
}
