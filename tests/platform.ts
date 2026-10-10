import { describe, expect, test } from 'bun:test'
import { chmodSync, statSync, writeFileSync } from 'node:fs'

/** The platforms a test may be pending on. macOS is the reference platform: nothing is ever pending there. */
type Pending = 'linux' | 'win32'

/**
 * Product gaps that keep a test from passing on Linux or Windows, each saying what has to change. A test names its
 * gap with `pendingOn`; when the gap is fixed, delete its entry here and every test naming it runs again (typecheck
 * finds them). docs/ci.md lists the same gaps by OS.
 */
export const GAPS = {
  devtoolsPortOnLinux:
    'bubblewrap cannot filter ports, so a sandboxed command on Linux still reaches a guarded loopback port: the ' +
    "managed Chrome's DevTools, which hands over every tab and its cookies (sandbox.ts guardLoopbackPort). A " +
    'network namespace per command would also cut it off from the dev servers it starts and the browser loads, ' +
    'and slirp4netns or pasta to restore the network are missing on most desktops; DevTools over a pipe needs a ' +
    'Bun that does not double-close it',
  cuaDriverOnWindows:
    'computer use cannot start a Cua Driver on Windows (its manifest and daemon never answer), so every computer ' +
    'tool fails there',
  bunWindowsSockets:
    "Bun's sockets on Windows corrupt its heap when a TCP connection is ended or dropped (usockets: a segfault in " +
    'us_internal_socket_close_and_notify or in a later malloc), in Bun 1.3.14 and 1.4.3 alike, ending the whole run ' +
    'in the IRC tests; the IRC client no longer ends a socket from its own close callbacks, which stopped it in the ' +
    'SASL and PASS tests, but a connection the server drops still crashes it',
  timeoutStopOnWindows:
    'a full-access command past its timeout is not stopped on Windows: run() does not return for the whole sleep ' +
    '(sandbox.ts runLeashed, leash.ts)',
} as const

export type Gap = keyof typeof GAPS

/**
 * Tests of one system's own mechanism that mean nothing on another: an SBPL profile or bubblewrap mounts built from
 * Windows paths, or POSIX PATH handling (cross-platform.test.ts covers each system's rules). Not gaps: nothing is
 * meant to change.
 */
export const OTHER_SYSTEMS = {
  macProfile:
    "Seatbelt profiles take only macOS paths; a Windows host's paths (with \\) are refused by design",
  bwrapMounts: 'bubblewrap mounts are built from Linux paths; Windows has no bubblewrap (its sandbox is WSL)',
  posixPath:
    "the POSIX PATH (':' separated, /usr/bin) is checked here; cross-platform.test.ts checks Windows'",
} as const

/** A test of a mechanism `on` does not have: skipped there (the log says why), run everywhere else. */
export function notOn(on: Pending | readonly Pending[], why: keyof typeof OTHER_SYSTEMS): typeof test {
  const here = (typeof on === 'string' ? [on] : on).some((p) => p === process.platform)
  if (here) console.warn(`not on ${process.platform}: ${why}: ${OTHER_SYSTEMS[why]}`)
  return test.skipIf(here) as typeof test
}

const announced = new Set<Gap>()

/** MYR_RUN_PENDING=1 runs pending tests too, to see whether a fix closes their gap and how they fail if not. */
const runPending = process.env.MYR_RUN_PENDING === '1'

function pendingHere(on: Pending | readonly Pending[], gap: Gap): boolean {
  const here = (typeof on === 'string' ? [on] : on).some((p) => p === process.platform)
  if (here && !announced.has(gap)) {
    announced.add(gap)
    console.warn(
      `${runPending ? 'running, though pending' : 'pending'} on ${process.platform}: ${gap}: ${GAPS[gap]}`,
    )
  }
  return here && !runPending
}

/**
 * A test that cannot pass on `on` until `gap` is fixed: skipped there (the log says why, once per gap and file), run
 * everywhere else. Use it instead of `test.skipIf(process.platform …)` so every platform skip is tracked in GAPS.
 * `unless` is the test's own reason to skip anywhere (no sandbox, no Chrome), kept as it was.
 */
export function pendingOn(on: Pending | readonly Pending[], gap: Gap, unless = false): typeof test {
  return test.skipIf(pendingHere(on, gap) || unless) as typeof test
}

/** `pendingOn` for a whole `describe` block. */
export function describePendingOn(on: Pending | readonly Pending[], gap: Gap): typeof describe {
  return describe.skipIf(pendingHere(on, gap)) as typeof describe
}

/**
 * Writes an executable at `path` that runs `script` with this Bun, passing its arguments through: a `#!/bin/sh`
 * script on macOS and Linux, a `.cmd` beside `path` on Windows. Returns the path to run.
 */
export function bunShim(path: string, script: string): string {
  if (process.platform === 'win32') {
    const cmd = `${path}.cmd`
    writeFileSync(cmd, `@"${process.execPath}" "${script}" %*\r\n`)
    return cmd
  }
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

/** Entries Windows keeps on every private file: the system itself and administrators can always take ownership. */
const WINDOWS_ALWAYS = ['NT AUTHORITY\\SYSTEM:(F)', 'BUILTIN\\Administrators:(F)']

/**
 * Expects `path` to be readable by this account alone: mode 0600 where modes exist; on Windows, an access list with
 * nothing inherited and full control for this account, beside only the system and administrators (owner-only.ts).
 */
export function expectOwnerOnly(path: string): void {
  if (process.platform !== 'win32') {
    expect(statSync(path).mode & 0o777).toBe(0o600)
    return
  }
  const out = Bun.spawnSync(['icacls', path], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString()
  // `<path> <entry>` on the first line, one more entry per line below it, then a blank line and a summary.
  const [first = '', ...rest] = out.split(/\r?\n\r?\n/)[0]?.split(/\r?\n/) ?? []
  const entries = [first.slice(path.length), ...rest].map((line) => line.trim()).filter(Boolean)
  const account = `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${process.env.USERNAME}`
  expect(entries).toContain(`${account}:(F)`)
  expect(entries.filter((e) => e !== `${account}:(F)` && !WINDOWS_ALWAYS.includes(e))).toEqual([])
}
