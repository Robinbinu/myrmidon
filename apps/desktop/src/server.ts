/**
 * The Myrmidon server behind the window. The shell finds it the way `myrmidon ask` and the other CLI commands do,
 * through `<home>/server.json`: a server already running for this home is used as it is, otherwise the shell starts
 * one and stops it again on quit.
 */
import { readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { alive } from '../../../packages/runtime/src/leash.ts'
import { spawnLeashed } from '../../../packages/runtime/src/leashed.ts'
import { LAUNCH_ID_ENV, SERVER_POLL_MS, SERVER_START_TIMEOUT_MS, SERVER_STOP_TIMEOUT_MS } from './config.ts'
import { desktopCopy } from './copy.ts'
import type { Platform } from './platform.ts'

/** What `myrmidon serve` writes to `<home>/server.json` (only this user can read it). */
export interface ServerFile {
  url: string
  token: string
  pid: number
  /** The name the desktop app gave the server it started (LAUNCH_ID_ENV); absent for any other server. */
  launch?: string
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

/** The page the overlay windows show while an agent drives the Mac: the dashboard's address at /overlay, token kept. */
export function overlayUrl(page: string): string {
  const url = new URL(page)
  url.pathname = '/overlay'
  url.search = ''
  return url.toString()
}

export function pageUrl(server: ServerFile): string {
  const url = new URL(server.url)
  url.hash = server.token ? `token=${server.token}` : ''
  return url.toString()
}

/**
 * The server.json of a server still running. One whose process has gone is removed: on Windows a stopped server
 * never gets to remove its own (it cannot be signalled, only ended), and a crash leaves it everywhere.
 */
function readServerFile(home: string): ServerFile | undefined {
  const file = join(home, 'server.json')
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return undefined
    const { url, token, pid, launch } = raw as Record<string, unknown>
    if (typeof url !== 'string' || typeof token !== 'string' || typeof pid !== 'number') return undefined
    if (!alive(pid)) {
      rmSync(file, { force: true })
      return undefined
    }
    return { url, token, pid, ...(typeof launch === 'string' ? { launch } : {}) }
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
  platform?: Platform
}): Promise<Server> {
  const platform = options.platform ?? (process.platform as Platform)
  // Its server.json carries this back, so another server starting for the same home is never taken for it.
  const launch = crypto.randomUUID()
  // Leashed, so the server stops with the app even when the app crashes or is killed.
  const child = spawnLeashed(
    [...options.command, 'serve', '--port', String(options.port), '--home', options.home],
    {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...process.env, [LAUNCH_ID_ENV]: launch },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )
  let started: ServerFile | undefined
  const exited = () => child.exitCode !== null || child.signalCode !== null
  const exitsWithin = (ms: number) =>
    Promise.race([child.exited.then(() => true), Bun.sleep(ms).then(() => false)])
  const stop = async () => {
    if (exited()) return
    const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS
    // The server stops its running chats and removes server.json (apps/cli/src/main.ts) when asked over its API,
    // which works the same everywhere; SIGTERM does the same where there are signals. On Windows a kill is
    // TerminateProcess, which would end only the leash, so there it is left to the firm stop below.
    let asked = started !== undefined && (await askToStop(started))
    if (!asked && platform !== 'win32') {
      child.kill('SIGTERM')
      asked = true
    }
    if (asked && (await exitsWithin(Math.max(0, deadline - Date.now())))) return
    // Not SIGKILL, which would kill only the leash: ending its stdin stops the server and all it started.
    child.stdin.end()
    await child.exited
    // A server stopped without a chance to remove its server.json (always so on Windows) leaves it behind.
    readServerFile(options.home)
  }

  const timeoutMs = options.timeoutMs ?? SERVER_START_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      await stop()
      throw options.signal.reason
    }
    if (exited()) throw new Error(desktopCopy.errors.exited(child.exitCode))
    const written = readServerFile(options.home)
    if (written?.launch === launch && (await answers(written))) {
      started = written
      return { pageUrl: pageUrl(written), owned: true, stop }
    }
    await Bun.sleep(options.pollMs ?? SERVER_POLL_MS)
  }
  await stop()
  throw new Error(desktopCopy.errors.timeout(Math.round(timeoutMs / 1000)))
}

/** Asks a server to stop itself, with the token it wrote to server.json; whether it took the request. */
async function askToStop(server: ServerFile): Promise<boolean> {
  try {
    const res = await fetch(new URL('/api/shutdown', server.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}` },
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}
