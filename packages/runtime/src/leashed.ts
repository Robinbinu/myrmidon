import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { LEASH_COMMAND, LEASH_GRACE_MS } from './config.ts'

const SCRIPT = join(import.meta.dir, 'leash.ts')
// A compiled Myrmidon (the desktop app's server) has no leash.ts on disk, so it runs itself as the leash
// (apps/desktop/src/sidecar.ts), as it does its other workers. Not its source text with `-e`: Bun hands the leash's
// module, not its text, to a text import of a file the bundle also imports as code, and the child then looked for
// the file inside the parent's own binary ("Module not found /$bunfs/root/leash.ts").
const RUN_LEASH = existsSync(SCRIPT) ? [SCRIPT] : [LEASH_COMMAND]

/**
 * On Windows every child Bun starts joins a job object that ends it the moment its parent dies: a leash there would
 * be gone before it could stop its command's tree, and what the command started (anything not Bun's own child) would
 * outlive it. Detached, the leash is left out of that job and outlives its parent long enough to stop the tree.
 */
const OUTSIDE_JOB = process.platform === 'win32'

/** How `env` differs from this process's environment, as the leash reads it (MYR_LEASH_ENV, see leash.ts). */
function envChanges(env: Record<string, string | undefined>): string {
  const set = Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[1] !== undefined && process.env[e[0]] !== e[1],
    ),
  )
  const unset = Object.keys(process.env).filter((name) => env[name] === undefined)
  return JSON.stringify({ set, unset })
}

function leash(args: readonly string[]): string[] {
  return [process.execPath, ...RUN_LEASH, `--grace=${LEASH_GRACE_MS}`, ...args]
}

/**
 * Starts `argv` on a leash (see leash.ts), for children meant to run as long as Myrmidon does: when this process
 * dies, however it dies, the command and everything it started are stopped. Otherwise it is `Bun.spawn`: stdout,
 * stderr, exit code and signals pass through. The returned process is the leash, whose stdin must stay open:
 * ending it (`proc.stdin.end()`) is the firm stop, SIGTERM then SIGKILL to the whole tree.
 */
export function spawnLeashed<
  const Out extends Bun.SpawnOptions.Readable = 'pipe',
  const Err extends Bun.SpawnOptions.Readable = 'inherit',
>(
  argv: readonly string[],
  options: Omit<Bun.SpawnOptions.SpawnOptions<'pipe', Out, Err>, 'stdin' | 'stdio'> = {},
): Bun.Subprocess<'pipe', Out, Err> {
  return stopsByStdin(
    Bun.spawn(leash(argv), {
      windowsHide: true,
      detached: OUTSIDE_JOB,
      ...options,
      // The leash runs in Myrmidon's environment and gives the command its own, sent as the changes (an environment
      // twice over could pass Windows' limit on its size).
      env: {
        ...process.env,
        ...(options.env ? { MYR_LEASH_ENV: envChanges(options.env) } : {}),
      },
      stdin: 'pipe',
    }),
  )
}

/**
 * On Windows a signal to a process ends it at once, with nothing passed on: killing a leash would orphan its command.
 * There `kill()` ends the leash's stdin instead, which stops the command's whole tree as when this process dies.
 */
export function stopsByStdin<
  P extends Bun.Subprocess<'pipe', Bun.SpawnOptions.Readable, Bun.SpawnOptions.Readable>,
>(proc: P, platform: NodeJS.Platform = process.platform): P {
  if (platform === 'win32')
    proc.kill = () => {
      proc.stdin.end()
    }
  return proc
}

/**
 * Leashes a process that is already running, for a child a library started (puppeteer's Chrome): its tree and
 * process group are stopped when this process dies. The leash ends by itself once the process has; ending its stdin
 * stops the process's tree as when this process dies.
 */
export function leashRunning(pid: number): Bun.Subprocess<'pipe', 'ignore', 'ignore'> {
  return stopsByStdin(
    Bun.spawn(leash([`--pid=${pid}`]), {
      detached: OUTSIDE_JOB,
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    }),
  )
}
