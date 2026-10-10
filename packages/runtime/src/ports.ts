import { existsSync, readFileSync } from 'node:fs'
import { PORT_LISTING_MS } from './config.ts'

/** What reading the listening ports needs, injected so each OS's branch is tested on any OS. */
export interface PortProbe {
  readonly platform: NodeJS.Platform
  readFile(path: string): string
  /** A system tool's stdout, or undefined when it is missing, fails or overruns. `quietOne`: as in `portListing`. */
  run(tool: string, args: readonly string[], quietOne?: boolean): string | undefined
}

/**
 * A system tool's output for `listeningPorts`, or undefined when it is missing, fails, or overruns its time (it runs
 * synchronously, and lsof can hang on a network mount). `quietOne`: exit 1 with nothing on stderr is a result.
 */
function portListing(tool: string, args: readonly string[], quietOne = false): string | undefined {
  try {
    const system = `/usr/sbin/${tool}`
    const out = Bun.spawnSync([existsSync(system) ? system : tool, ...args], {
      timeout: PORT_LISTING_MS,
      windowsHide: true,
    })
    const ok = out.exitCode === 0 || (quietOne && out.exitCode === 1 && out.stderr.length === 0)
    return ok ? new TextDecoder().decode(out.stdout) : undefined
  } catch {
    return undefined
  }
}

const hostProbe = (): PortProbe => ({
  platform: process.platform,
  readFile: (path) => readFileSync(path, 'utf8'),
  run: portListing,
})

/** Linux's /proc/net/tcp(6): "sl local_address rem_address st ...", HEXIP:HEXPORT, state 0A is LISTEN. */
export function procNetPorts(table: string): number[] {
  return table
    .split('\n')
    .slice(1)
    .flatMap((line) => {
      const [, local, , state] = line.trim().split(/\s+/)
      return state === '0A' && local ? [Number.parseInt(local.split(':').at(-1) ?? '', 16)] : []
    })
}

/** macOS `netstat -an -p tcp`: "tcp4  0  0  127.0.0.1.4318  *.*  LISTEN", the port the last dotted part. */
export function bsdNetstatPorts(text: string): number[] {
  return text.split('\n').flatMap((line) => {
    const columns = line.trim().split(/\s+/)
    const port = /\.(\d+)$/.exec(columns[3] ?? '')?.[1]
    return columns.at(-1) === 'LISTEN' && port ? [Number(port)] : []
  })
}

/** `lsof -Fn`: "n*:5173", "n127.0.0.1:4318", "n[::1]:3000", a name field with the port after its last colon. */
export function lsofPorts(text: string): number[] {
  return text.split('\n').flatMap((line) => {
    const port = /^n.*:(\d+)$/.exec(line)?.[1]
    return port ? [Number(port)] : []
  })
}

/**
 * Windows `netstat -an`: "TCP  127.0.0.1:4318  0.0.0.0:0  LISTENING  9876", IPv6 as "[::1]:5173". The state is
 * translated on a non-English Windows ("ABHÖREN"), so a listener is told by its foreign port, 0 only while listening.
 */
export function windowsNetstatPorts(text: string): number[] {
  return text.split('\n').flatMap((line) => {
    const [proto, local, foreign] = line.trim().split(/\s+/)
    const port = /:(\d+)$/.exec(local ?? '')?.[1]
    return proto === 'TCP' && port && foreign?.endsWith(':0') ? [Number(port)] : []
  })
}

/**
 * Every TCP port something on this machine listens on, or undefined where that cannot be read. Taken before a
 * server starts, it tells the ports the server opened from ones that were already in use (the dashboard's, say).
 */
export function listeningPorts(probe: PortProbe = hostProbe()): Set<number> | undefined {
  try {
    if (probe.platform === 'linux')
      return new Set(
        ['/proc/net/tcp', '/proc/net/tcp6'].flatMap((table) => procNetPorts(probe.readFile(table))),
      )
    if (probe.platform === 'darwin') {
      // netstat sees every user's listeners, but the kernel can hand a process an empty socket table (seen under
      // `bun test` on macOS 27), and netstat then exits 0 listing none. lsof reads this user's processes directly, so
      // the dashboard and the person's own apps are seen either way.
      const netstat = probe.run('netstat', ['-an', '-p', 'tcp'])
      // lsof exits 1, silently, when nothing listens.
      const lsof = probe.run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], true)
      if (netstat === undefined && lsof === undefined) return undefined
      return new Set([...bsdNetstatPorts(netstat ?? ''), ...lsofPorts(lsof ?? '')])
    }
    if (probe.platform === 'win32') {
      // Not `-p tcp`, which leaves out IPv6 listeners (a dev server on [::1]).
      const netstat = probe.run('netstat', ['-an'])
      return netstat === undefined ? undefined : new Set(windowsNetstatPorts(netstat))
    }
  } catch {
    return undefined
  }
  return undefined
}
