/**
 * The Myrmidon server behind the window. The shell finds it the way `myrmidon ask` and the other CLI commands do,
 * through `<home>/server.json`: a server already running for this home is used as it is, otherwise the shell starts
 * one and stops it again on quit.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnLeashed } from '../../../packages/runtime/src/leashed.ts'
import { SERVER_POLL_MS, SERVER_START_TIMEOUT_MS, SERVER_STOP_TIMEOUT_MS } from './config.ts'
import { desktopCopy } from './copy.ts'

/** What `myrmidon serve` writes to `<home>/server.json` (only this user can read it). */
export interface ServerFile {
  url: string
  token: string
  pid: number
}

export interface Server {
  /** The page to open: the server's address with its token in the hash, where the client reads it. */
  readonly pageUrl: string
  /** Whether the shell started it, and so stops it on quit. */
  readonly owned: boolean
  stop(): Promise<void>
}

/** The Myrmidon home the CLI would use (apps/cli/src/home.ts), without the `--home` flag the shell never gets. */
export function myrmidonHome(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.MYRMIDON_HOME ?? join(homedir(), '.myrmidon'))
}

/** Where a server the shell starts on `port` answers; `myrmidon serve` uses this loopback address. */
export const loopbackOrigin = (port: number) => `http://127.0.0.1:${port}`

export function pageUrl(server: ServerFile): string {
  const url = new URL(server.url)
  url.hash = server.token ? `token=${server.token}` : ''
  return url.toString()
}

function readServerFile(home: string): ServerFile | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'))
    if (!raw || typeof raw !== 'object') return undefined
    const { url, token, pid } = raw as Record<string, unknown>
    if (typeof url !== 'string' || typeof token !== 'string' || typeof pid !== 'number') return undefined
    return { url, token, pid }
  } catch {
    return undefined
  }
}

/** server.json outlives a crash, so a server only counts once it answers with that token. */
async function answers(server: ServerFile): Promise<boolean> {
  try {
    const res = await fetch(new URL('/api/whoami', server.url), {
      headers: server.token ? { authorization: `Bearer ${server.token}` } : {},
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** The server already running for `home`, which the shell then uses and leaves running. */
export async function runningServer(home: string): Promise<Server | undefined> {
  const found = readServerFile(home)
  return found && (await answers(found))
    ? { pageUrl: pageUrl(found), owned: false, stop: async () => {} }
    : undefined
}

/** A loopback port nothing listens on now, so the window knows the server's address before it starts. */
export function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const { port } = probe
  probe.stop(true)
  return port
}

/**
 * Starts `command serve` on `port` and waits until it answers. `command` is the CLI: `bun apps/cli/src/main.ts`
 * from the repository in development, the bundled executable in a built app. Aborting `signal` stops it.
 */
export async function startServer(options: {
  command: readonly string[]
  home: string
  port: number
  cwd?: string
  signal?: AbortSignal
  timeoutMs?: number
  pollMs?: number
}): Promise<Server> {
  // Leashed, so the server stops with the app even when the app crashes or is killed.
  const child = spawnLeashed(
    [...options.command, 'serve', '--port', String(options.port), '--home', options.home],
    {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    // SIGTERM lets the server stop its running chats and remove server.json (apps/cli/src/main.ts).
    child.kill('SIGTERM')
    const stopped = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(SERVER_STOP_TIMEOUT_MS).then(() => false),
    ])
    if (!stopped) {
      // Not SIGKILL, which would kill only the leash: ending its stdin kills the server and all it started.
      child.stdin.end()
      await child.exited
    }
  }

  const timeoutMs = options.timeoutMs ?? SERVER_START_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      await stop()
      throw options.signal.reason
    }
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(desktopCopy.errors.exited(child.exitCode))
    const written = readServerFile(options.home)
    if (written && parentPid(written.pid) === child.pid && (await answers(written)))
      return { pageUrl: pageUrl(written), owned: true, stop }
    await Bun.sleep(options.pollMs ?? SERVER_POLL_MS)
  }
  await stop()
  throw new Error(desktopCopy.errors.timeout(Math.round(timeoutMs / 1000)))
}

/** A process's parent: the server's is its leash. */
function parentPid(pid: number): number | undefined {
  const ps = Bun.spawnSync(['ps', '-o', 'ppid=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' })
  return Number(new TextDecoder().decode(ps.stdout).trim()) || undefined
}
