import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

export interface SandboxRun {
  readonly command: string
  readonly cwd: string
  /** The only directories the command may write to. */
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

export interface Sandbox {
  readonly kind: 'sandbox-exec' | 'bubblewrap' | 'none'
  run(spec: SandboxRun): Promise<SandboxResult>
}

const MAX_OUTPUT = 64 * 1024

function cap(text: string) {
  return text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated ${text.length - MAX_OUTPUT} chars]`
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

async function spawnConfined(argv: string[], spec: SandboxRun): Promise<SandboxResult> {
  const tmp = join(spec.writable[0] ?? spec.cwd, '.tmp')
  mkdirSync(tmp, { recursive: true })
  const proc = Bun.spawn(argv, {
    cwd: spec.cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: spec.cwd, TMPDIR: tmp, ...spec.env },
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

/** Picks the OS confinement backend. Returns `none` when no backend exists; callers must refuse exec tools then. */
export function detectSandbox(): Sandbox {
  if (process.platform === 'darwin' && Bun.which('sandbox-exec')) {
    return {
      kind: 'sandbox-exec',
      run: (spec) =>
        spawnConfined(['sandbox-exec', '-p', macProfile(spec.writable), '/bin/sh', '-c', spec.command], spec),
    }
  }
  const bwrap = process.platform === 'linux' ? Bun.which('bwrap') : null
  if (bwrap) {
    return {
      kind: 'bubblewrap',
      run: (spec) =>
        spawnConfined(
          [
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
          ],
          spec,
        ),
    }
  }
  return { kind: 'none', run: (spec) => spawnConfined(['/bin/sh', '-c', spec.command], spec) }
}
