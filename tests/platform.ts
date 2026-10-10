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
  bwrapHiddenFolders:
    'bubblewrap hides a folder with an empty writable tmpfs, so listing it or writing into it succeeds (into a ' +
    'throwaway layer) where macOS denies it (sandbox.ts bwrapMounts)',
  voiceWarmupRace:
    'a voice call whose page closed while the engines warmed up still greets once they are ready, so the next ' +
    'call in the chat is spoken twice (apps/web voice gateway; seen on Linux every run)',
  sqliteHandles:
    'SQLite stores close with db.close() while prepared statements live (core sqlite-store.ts), so the file stays ' +
    'open until GC and Windows cannot delete the folder (EBUSY)',
  serverJsonAfterKill:
    'when the desktop app is killed, the leash stops its server without letting it remove server.json on Windows',
  cuaDriverOnWindows:
    'computer use starts the Cua Driver daemon on a unix socket in the data folder; on Windows it never comes up',
  dataFolderOnWindows:
    "a project's file and git views still serve Myrmidon's data folder and keys inside it on Windows",
  terminalForeground:
    "the terminal panel on Windows does not report what runs in each terminal's foreground (ConPTY), and its " +
    'folder stays busy after the server stops',
  bunWindowsSockets:
    'Bun 1.3.14 on Windows crashes (segfault, or exit 127) in the IRC raw-socket tests, ending the whole run',
} as const

export type Gap = keyof typeof GAPS

const announced = new Set<Gap>()

function pendingHere(on: Pending | readonly Pending[], gap: Gap): boolean {
  const here = (typeof on === 'string' ? [on] : on).some((p) => p === process.platform)
  if (here && !announced.has(gap)) {
    announced.add(gap)
    console.warn(`pending on ${process.platform}: ${gap}: ${GAPS[gap]}`)
  }
  return here
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

/**
 * Expects `path` to be readable by this account alone: mode 0600 where modes exist; on Windows, an access list with
 * full control for this account and nothing else, inherited or not (owner-only.ts).
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
  expect(entries).toEqual([`${account}:(F)`])
}
