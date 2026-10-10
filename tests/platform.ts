import { test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'

/** The platforms a test may be pending on. macOS is the reference platform: nothing is ever pending there. */
type Pending = 'linux' | 'win32'

/**
 * Product gaps that keep a test from passing on Linux or Windows, each with the code that has to change. A test
 * names its gap with `pendingOn`; when the gap is fixed, delete its entry here and every test naming it runs again.
 * docs/ci.md lists the same gaps by OS.
 */
export const GAPS = {
  posixProjectPaths:
    'projects.ts checkedDir accepts only paths starting with "/", so no Windows folder can be added as a project',
  desktopProcesses:
    'the desktop shell finds and stops its server with `ps`/POSIX signals (apps/desktop/src/server.ts, leash.ts)',
  sidecarNativeAddon:
    'build-sidecar.ts looks for pi_natives.<os>-<arch>.node, but the x64 packages ship -baseline/-modern builds',
  sqliteHandles:
    'SQLite stores close with db.close() while prepared statements live (core sqlite-store.ts), so the file stays ' +
    'open until GC and Windows cannot delete the folder',
  privateFileModes: 'private files rely on POSIX mode 0o600; Windows needs an owner-only ACL instead',
  terminals: 'the terminal panel needs a Windows pseudo-console (ConPTY) shell',
  bwrapHiddenFolders:
    'bubblewrap hides a folder with an empty writable tmpfs, so listing it or writing into it succeeds (into a ' +
    'throwaway layer) where macOS denies it (sandbox.ts bwrapMounts)',
} as const

export type Gap = keyof typeof GAPS

const announced = new Set<Gap>()

/**
 * A test that cannot pass on `on` until `gap` is fixed: skipped there (the log says why, once per gap and file), run
 * everywhere else. Use it instead of `test.skipIf(process.platform …)` so every platform skip is tracked in GAPS.
 */
export function pendingOn(on: Pending | readonly Pending[], gap: Gap): typeof test {
  const here = (typeof on === 'string' ? [on] : on).some((p) => p === process.platform)
  if (here && !announced.has(gap)) {
    announced.add(gap)
    console.warn(`pending on ${process.platform}: ${gap}: ${GAPS[gap]}`)
  }
  return test.skipIf(here) as typeof test
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
