import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SANDBOX_SECRETS, SANDBOX_TOOLCHAINS } from './config.ts'

/**
 * What a sandboxed agent may read outside its own folders. The person's home is hidden as a whole; toolchains, the
 * project, the chat's own folder and the folders the person allows (in Settings, for a project, or in one chat) are
 * opened back up; keys and sign-ins (SANDBOX_SECRETS) and Myrmidon's data folder stay hidden inside any of those
 * unless named exactly. The deepest rule that covers a path decides, so the shell (sandbox.ts) and the file tools
 * (workspace.ts) agree on every path.
 */

/** `~` and `~/…` in the person's home; any other path as given. */
export function expandHome(path: string, home = homedir()): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/** The real path of `path`: symlinks resolved in the part that exists, the rest (not created yet) kept. */
export function realPath(path: string): string {
  const target = resolve(path)
  let probe = target
  while (!existsSync(probe)) probe = dirname(probe)
  return join(realOrNone(probe) ?? probe, relative(probe, target))
}

export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root === sep ? root : root + sep)
}

const depth = (path: string) => path.split(sep).filter(Boolean).length

/**
 * Whether `path` (real) is reachable: some root covers it, and no hidden folder deeper than that root does. A root
 * that is exactly a hidden folder opens it (the person named it).
 */
export function reachable(path: string, roots: readonly string[], hidden: readonly string[]): boolean {
  const deepest = (dirs: readonly string[]) => Math.max(-1, ...dirs.filter((d) => within(path, d)).map(depth))
  const root = deepest(roots)
  return root >= 0 && root >= deepest(hidden)
}

/** The real path, or none when the folder is missing or macOS's privacy controls keep even Myrmidon from it. */
export function realOrNone(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** Each path and, when it resolves elsewhere, its real path too, so a symlinked folder is covered. */
function withReal(paths: readonly string[]): string[] {
  return [...new Set(paths.flatMap((p) => [p, realOrNone(p) ?? p]))]
}

/** The person's secrets (see SANDBOX_SECRETS), absolute. */
export function secretPaths(home = homedir()): string[] {
  return withReal(SANDBOX_SECRETS.map((p) => join(home, p)))
}

/** The toolchain folders that exist in the person's home (see SANDBOX_TOOLCHAINS), real paths. */
export function toolchainPaths(home = homedir()): string[] {
  return SANDBOX_TOOLCHAINS.flatMap((p) => realOrNone(join(home, p)) ?? [])
}

/**
 * The secret, or Myrmidon's data folder, that `path` is or lies in: a project or a chat can never grant it, only the
 * person by naming it in Settings. The chat's own folder (`colonyDir`) is not one.
 */
export function secretAt(
  path: string,
  where: { home?: string; dataDir?: string; colonyDir?: string } = {},
): string | undefined {
  const real = realPath(path)
  if (where.colonyDir && within(real, realPath(where.colonyDir))) return undefined
  const guarded = [...secretPaths(where.home), ...(where.dataDir ? [realPath(where.dataDir)] : [])]
  return guarded.find((s) => within(real, s) || within(path, s))
}

/**
 * The guarded paths as the person would type them (`~/.ssh`) and in full, for Settings to warn when a folder listed
 * there opens one of them.
 */
export function guardedPaths(dataDir: string, home = homedir()): string[] {
  const full = [...SANDBOX_SECRETS.map((p) => join(home, p)), resolve(dataDir)]
  return [...new Set(full.flatMap((p) => (within(p, home) ? [`~${p.slice(home.length)}`, p] : [p])))]
}

/** A folder the person typed (absolute, or starting with `~`), as an absolute path; anything else is refused. */
export function readFolder(input: string, home = homedir()): string {
  const path = expandHome(input.trim(), home)
  if (!isAbsolute(path)) throw new Error(`${input} is not a full path: start it with / or ~`)
  return resolve(path)
}
