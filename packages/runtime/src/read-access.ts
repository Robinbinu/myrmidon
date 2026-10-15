import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { SANDBOX_SECRETS, SANDBOX_TOOLCHAINS } from './config.ts'

/**
 * What a sandboxed agent may read outside its own folders. The person's home is hidden as a whole; toolchains, the
 * project, the chat's own folder and the folders the person allows (in Settings, for a project, or in one chat) are
 * opened back up; keys and sign-ins (SANDBOX_SECRETS) and Myrmidon's data folder stay hidden inside any of those
 * unless named exactly (a key folder can be, in one chat, when the person allows an agent's request for it). The deepest rule that covers a path decides, so the shell (sandbox.ts) and the file tools
 * (workspace.ts) agree on every path.
 */

/** Node's path functions for `platform`, so the Windows rules can be checked on any computer. */
export const pathOf = (platform: NodeJS.Platform = process.platform) => (platform === 'win32' ? win32 : posix)

/** A relative path as agents and the person read it: `/` between its parts on every system, Windows included. */
export const slashed = (path: string): string => path.split(sep).join('/')

/** APFS and NTFS are case-insensitive by default: there `~/.SSH` is `~/.ssh`, so paths are compared that way too. */
const foldsCase = (platform: NodeJS.Platform) => platform === 'darwin' || platform === 'win32'

/** `~` and `~/…` (on Windows also `~\…`) in the person's home; any other path as given. */
export function expandHome(
  path: string,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (path === '~') return home
  const tilde = platform === 'win32' ? /^~[\\/]/ : /^~\//
  return tilde.test(path) ? pathOf(platform).join(home, path.slice(2)) : path
}

/** Links followed at most while resolving a path, as the system's own limit (ELOOP). */
const MAX_LINK_HOPS = 40

/**
 * The real path of `path`: symlinks resolved in the part that exists, the rest (not created yet) kept. A link whose
 * target is not there yet is followed too, since writing to it, or into it, creates its target.
 */
export function realPath(path: string): string {
  let target = resolve(path)
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
    let probe = target
    let link: string | undefined
    // A drive that is not there (Z:\ on Windows) is its own parent. existsSync follows links, so a link to something
    // not there yet looks missing too; stopping at it matters, since a write to it (or into it) lands at its target.
    while (!existsSync(probe) && dirname(probe) !== probe) {
      link = linkTarget(probe)
      if (link !== undefined) break
      probe = dirname(probe)
    }
    if (link === undefined) return join(realOrNone(probe) ?? probe, relative(probe, target))
    target = join(resolve(dirname(probe), link), relative(probe, target))
  }
  throw new Error(`too many symbolic links: ${path}`)
}

/** What a symbolic link names, or nothing when `path` is not one. */
function linkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined
  } catch {
    return undefined
  }
}

/** Whether `path` is `root` or lies inside it; both absolute, compared as `platform`'s file systems compare names. */
export function within(path: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (p: string) => (foldsCase(platform) ? p.toLowerCase() : p)
  const [p, r] = [fold(path), fold(root)]
  const { sep } = pathOf(platform)
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)
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

/**
 * The real path, or none when the folder is missing or macOS's privacy controls keep even Myrmidon from it. The
 * system's own resolution gives each name's case as it is on disk and follows Windows junctions and substituted drives.
 */
export function realOrNone(path: string): string | undefined {
  try {
    return realpathSync.native(path)
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

/** The folder of keys or sign-ins (see SANDBOX_SECRETS) that `path` is or lies in. */
export function keysAt(path: string, home?: string): string | undefined {
  const real = realPath(path)
  return secretPaths(home).find((s) => within(real, s) || within(path, s))
}

/** Whether `path` is or lies in Myrmidon's data folder, which holds every chat; the chat's own folder is not. */
export function chatsAt(path: string, where: { dataDir?: string; colonyDir?: string }): boolean {
  if (!where.dataDir) return false
  const real = realPath(path)
  if (where.colonyDir && within(real, realPath(where.colonyDir))) return false
  const data = realPath(where.dataDir)
  return within(real, data) || within(path, data)
}

/**
 * The secret, or Myrmidon's data folder, that `path` is or lies in: a project can never grant it, and only the person
 * by naming it in Settings opens it for every chat. The chat's own folder (`colonyDir`) is not one.
 */
export function secretAt(
  path: string,
  where: { home?: string; dataDir?: string; colonyDir?: string } = {},
): string | undefined {
  if (where.dataDir && chatsAt(path, where)) return realPath(where.dataDir)
  return keysAt(path, where.home)
}

/**
 * Whether a folder allowed for reading (`grant`, real) opens `path` (real): it covers it, and when `path` holds keys or
 * sign-ins, the grant lies within that folder too, so allowing ~ never opens ~/.ssh.
 */
export function grantCovers(grant: string, path: string, home?: string): boolean {
  if (!within(path, grant)) return false
  const keys = secretPaths(home).filter((s) => within(path, s))
  return keys.length === 0 || keys.some((k) => within(grant, k))
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
export function readFolder(
  input: string,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const p = pathOf(platform)
  const path = expandHome(input.trim(), home, platform)
  if (!p.isAbsolute(path))
    throw new Error(
      `${input} is not a full path: start it with ${platform === 'win32' ? 'a drive (C:\\)' : '/'} or ~`,
    )
  return p.resolve(path)
}
