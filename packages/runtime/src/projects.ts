import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, parse, relative, resolve, sep } from 'node:path'
import { type LegacyProjectPermissions, type ProjectPermissions, projectLevelFrom } from '@myrmidon/protocol'
import {
  MAX_FIND_RESULTS,
  MAX_FIND_SCAN,
  MAX_PROJECT_FILE_BYTES,
  MAX_READ_FOLDERS,
  MAX_TREE_ENTRIES,
} from './config.ts'
import { git } from './git.ts'
import { expandHome, pathOf, readFolder, realPath, secretAt, secretPaths, within } from './read-access.ts'

/**
 * Project folders, like Claude Code's and Codex's: a chat can belong to a directory on this machine. Its agents
 * work in that directory (the shell starts there and the file tools read and edit it), and the chat list groups a
 * project's chats under it. The list lives in `<home>/projects.json`.
 */

export interface Project {
  readonly id: string
  readonly name: string
  /** Absolute, symlink-resolved path. */
  readonly path: string
  readonly addedAt: string
  /** The project's level of the permission model; no preset means it uses the global one. */
  readonly permissions: ProjectPermissions
}

export class ProjectStore {
  private readonly _file: string

  constructor(private readonly _home: string) {
    this._file = join(_home, 'projects.json')
  }

  list(): Project[] {
    if (!existsSync(this._file)) return []
    try {
      const raw = JSON.parse(readFileSync(this._file, 'utf8')) as unknown
      if (!Array.isArray(raw)) return []
      // Folders saved before the permission model keep their mode as a preset (see projectLevelFrom).
      return (raw as (Omit<Project, 'permissions'> & { permissions?: unknown })[])
        .filter((p) => p && typeof p.path === 'string')
        .map((p) => ({ ...p, permissions: projectLevelFrom(p.permissions) }))
    } catch {
      return []
    }
  }

  get(id: string): Project | undefined {
    return this.list().find((p) => p.id === id)
  }

  /** Adds a folder (or returns the existing entry for it). */
  add(path: string, name?: string): Project {
    const real = checkedDir(path)
    const existing = this.list().find((p) => p.path === real)
    if (existing) return existing
    const base = (name?.trim() || basename(real) || 'project').slice(0, 60)
    const slug =
      base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'project'
    const project: Project = {
      id: `${slug}-${Bun.hash(real).toString(36).slice(0, 6)}`,
      name: base,
      path: real,
      addedAt: new Date().toISOString(),
      // A new folder uses the global preset until the person gives it its own.
      permissions: { rules: [] },
    }
    this._write([...this.list(), project])
    return project
  }

  /**
   * Sets the project's level of the permission model (also accepted in the shape from before it); applies to its
   * running rounds at once and to every later one.
   */
  setPermissions(id: string, permissions: ProjectPermissions | LegacyProjectPermissions): Project {
    const given = permissions as { mode?: unknown; preset?: unknown }
    if (given.mode !== undefined && !['auto', 'ask', 'read-only', 'full'].includes(given.mode as string))
      throw new Error('mode is auto, ask, read-only or full')
    if (given.preset != null && !['read-only', 'ask', 'auto', 'full'].includes(given.preset as string))
      throw new Error('preset is read-only, ask, auto or full')
    const level = projectLevelFrom(permissions)
    const read = [...new Set((level.read ?? []).map((f) => f.trim()).filter(Boolean))]
    if (read.length > MAX_READ_FOLDERS) throw new Error(`at most ${MAX_READ_FOLDERS} readable folders`)
    for (const folder of read)
      if (secretAt(readFolder(folder), { dataDir: this._home }))
        throw new Error(
          `${folder} holds keys, sign-ins or other chats: a project cannot open it, only naming it in Settings → Permissions can`,
        )
    const list = this.list()
    const project = list.find((p) => p.id === id)
    if (!project) throw new Error('no such project')
    const { read: _, ...rest } = level
    const next = { ...project, permissions: { ...rest, ...(read.length ? { read } : {}) } }
    this._write(list.map((p) => (p.id === id ? next : p)))
    return next
  }

  /** Forgets a project. Its folder and its chats are untouched; the chats just stop being grouped under it. */
  remove(id: string): void {
    this._write(this.list().filter((p) => p.id !== id))
  }

  private _write(projects: Project[]) {
    const tmp = `${this._file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(projects, null, 2)}\n`)
    renameSync(tmp, this._file)
  }
}

/** A folder path the person typed as an absolute one (`~` is the home folder); a relative one is refused. */
export function absoluteFolder(
  path: string,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const expanded = expandHome(path.trim(), home, platform)
  if (!pathOf(platform).isAbsolute(expanded)) throw new Error('use an absolute path (or one starting with ~)')
  return pathOf(platform).resolve(expanded)
}

/** Whether `path` (absolute) is the top of its file system: `/`, a drive (`C:\`) or a network share. */
export function isFsRoot(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = pathOf(platform)
  const abs = p.resolve(path)
  return p.parse(abs).root === abs || p.dirname(abs) === abs
}

/** An existing directory, as an absolute path with symlinks resolved; `~` means the home directory. */
function checkedDir(path: string): string {
  const abs = absoluteFolder(path)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`not a folder: ${abs}`)
  const real = realpathSync(abs)
  if (isFsRoot(real) || real === realpathSync(homedir()))
    throw new Error(`pick a project folder, not ${parse(real).root} or your home folder`)
  return real
}

/** The drives Windows has now (`C:\`, `D:\`…), for the folder picker to start from. */
export function windowsDrives(exists: (path: string) => boolean = existsSync): string[] {
  return [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `${letter}:\\`).filter(exists)
}

/** The folder above `abs` for the picker's "..", none at the top of a file system (on Windows, a drive). */
export function folderParent(abs: string, platform: NodeJS.Platform = process.platform): string | undefined {
  return isFsRoot(abs, platform) ? undefined : pathOf(platform).resolve(abs, '..')
}

/**
 * Sub-folders of a directory, for the folder picker. Hidden folders are left out. On Windows the drives come too,
 * as the picker cannot go above one.
 */
export function listFolders(path: string): {
  path: string
  parent: string | undefined
  folders: string[]
  drives?: string[]
} {
  const abs = resolve(expandHome(path.trim() || '~'))
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`not a folder: ${abs}`)
  const folders = readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 500)
  return {
    path: abs,
    parent: folderParent(abs),
    folders,
    ...(process.platform === 'win32' ? { drives: windowsDrives() } : {}),
  }
}

/** Whose keys a project's file views hide: the person's home (the real one unless a test sets it), Myrmidon's data. */
export interface SecretGuard {
  readonly home?: string
  readonly dataDir?: string
}

/**
 * The person's keys and sign-ins (SANDBOX_SECRETS) and Myrmidon's data folder that lie deeper inside a project folder
 * than the folder itself: a project around the home (one at /Users, say) must not show `~/.ssh` to whoever browses
 * it, just as the sandbox hides them from its agents. The deepest rule decides, as there: a project the person made
 * inside one of those folders is theirs to read. Ordinary project content, `.env` included, is not hidden: the file
 * views need full access (devices.ts `needsFull`), and hiding a project's own files from its owner would only get in
 * the way.
 */
function secretsIn(base: string, guard: SecretGuard): string[] {
  const guarded = [...secretPaths(guard.home), ...(guard.dataDir ? [realPath(guard.dataDir)] : [])]
  return guarded.filter((s) => within(s, base) && !within(base, s))
}

/** Whether `path` (absolute) is or leads into one of `secrets`, a symlink followed to where it really points. */
const hiddenBy = (path: string, secrets: readonly string[]) =>
  secrets.length > 0 && secrets.some((s) => within(realPath(path), s) || within(path, s))

const secretRefused = (path: string) => `${path} holds keys or sign-ins, which the app does not show`

/**
 * Whether a file of the project (relative to it; it need not exist) is one the file views hide (see `secretsIn`),
 * for other views of the folder, such as its git diffs.
 */
export function projectSecret(root: string, file: string, guard: SecretGuard = {}): boolean {
  const base = realpathSync(root)
  return hiddenBy(resolve(base, file), secretsIn(base, guard))
}

/** Throws when a file of the project is one the file views hide (see `projectSecret`). */
export function refuseProjectSecret(root: string, file: string, guard: SecretGuard = {}): void {
  if (projectSecret(root, file, guard)) throw new Error(secretRefused(file))
}

/**
 * A path in a project folder as its real path, refused when it leads outside (`allowRoot`: the folder itself counts)
 * or into the person's keys (see `secretsIn`), whether it exists or not, so the answer never says which do. `path`
 * is relative to the folder or absolute inside it (agents name files both ways). Symlinks are followed only while
 * they stay inside. A missing path is judged as named.
 */
function projectPath(
  root: string,
  path: string,
  allowRoot: boolean,
  guard: SecretGuard,
): { base: string; real: string; secrets: string[] } {
  const base = realpathSync(root)
  const abs = resolve(base, path)
  const real = existsSync(abs) ? realpathSync(abs) : abs
  if ((!path && !allowRoot) || !within(real, base) || (!allowRoot && within(base, real)))
    throw new Error(`${path} is not in this project`)
  const secrets = secretsIn(base, guard)
  if (hiddenBy(abs, secrets)) throw new Error(secretRefused(path))
  if (!existsSync(real)) throw new Error(`${path} is no longer in the folder`)
  return { base, real, secrets }
}

/** A path relative to a project folder as git and the app write it, with `/` on Windows too. */
const slashed = (path: string) => path.split(sep).join('/')

/** A text file in a project folder, for the person to read in the app: one an agent edited, say. */
export function readProjectFile(
  root: string,
  file: string,
  guard: SecretGuard = {},
): { path: string; text: string } {
  const { base, real } = projectPath(root, file, false, guard)
  const stat = statSync(real)
  if (!stat.isFile()) throw new Error(`${file} is not a file`)
  if (stat.size > MAX_PROJECT_FILE_BYTES) throw new Error(`${file} is over 2 MB, too large to show`)
  const bytes = readFileSync(real)
  if (bytes.includes(0)) throw new Error(`${file} is not a text file`)
  return { path: slashed(relative(base, real)), text: bytes.toString('utf8') }
}

export interface ProjectEntry {
  readonly name: string
  /** Relative to the project folder. */
  readonly path: string
  readonly dir: boolean
  /** A file's git status: M modified, A added, D deleted, R renamed, U conflicted, ? untracked. */
  readonly status?: string
  /** A folder holding changed or new files. */
  readonly changed?: true
  /** Git ignores it (and, for a folder, everything in it). */
  readonly ignored?: true
}

/**
 * One folder of a project, for the person's file browser: folders first, then files, by name, with git status where
 * the folder is a repository (like an editor's explorer). Only `.git` is left out; ignored entries are marked.
 */
export async function listProjectDir(
  root: string,
  dir: string,
  guard: SecretGuard = {},
): Promise<{ path: string; entries: ProjectEntry[]; truncated: boolean }> {
  const { base, real, secrets } = projectPath(root, dir, true, guard)
  if (!statSync(real).isDirectory()) throw new Error(`${dir} is not a folder`)
  const at = slashed(relative(base, real))
  const marks = await gitMarks(base, at)
  const entries: ProjectEntry[] = []
  for (const d of readdirSync(real, { withFileTypes: true })) {
    if (d.name === '.git' || hiddenBy(join(real, d.name), secrets)) continue
    let isDir = d.isDirectory()
    if (d.isSymbolicLink()) {
      try {
        isDir = statSync(join(real, d.name)).isDirectory()
      } catch {
        continue
      }
    }
    const path = at ? `${at}/${d.name}` : d.name
    const mark = marks.get(d.name)
    entries.push({
      name: d.name,
      path,
      dir: isDir,
      ...(mark === '!' ? { ignored: true as const } : {}),
      ...(isDir && mark && mark !== '!' ? { changed: true as const } : {}),
      ...(!isDir && mark && mark !== '!' ? { status: mark } : {}),
    })
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  return {
    path: at,
    entries: entries.slice(0, MAX_TREE_ENTRIES),
    truncated: entries.length > MAX_TREE_ENTRIES,
  }
}

/**
 * Git's word on each entry directly in `dir` (relative to the folder): a file's status letter, `*` for a folder with
 * changes inside, `!` for an ignored entry. Empty outside a repository.
 */
async function gitMarks(base: string, dir: string): Promise<Map<string, string>> {
  const marks = new Map<string, string>()
  let out: string
  let prefix: string
  try {
    prefix = (await git(base, ['rev-parse', '--show-prefix'])).trim()
    out = await git(base, [
      'status',
      '--porcelain=v1',
      '-z',
      '--ignored=matching',
      '-unormal',
      '--',
      dir || '.',
    ])
  } catch {
    return marks
  }
  const records = out.split('\0')
  const inDir = prefix + (dir ? `${dir}/` : '')
  for (let i = 0; i < records.length; i++) {
    const r = records[i] ?? ''
    if (r.length < 4) continue
    const xy = r.slice(0, 2)
    // A rename or copy is followed by the path it came from.
    if (xy[0] === 'R' || xy[0] === 'C') i++
    const path = r.slice(3)
    if (!path.startsWith(inDir)) continue
    const rest = path.slice(inDir.length)
    const name = rest.split('/')[0] ?? ''
    if (!name) continue
    const whole = rest === name || rest === `${name}/`
    if (xy === '!!') {
      if (whole) marks.set(name, '!')
      continue
    }
    const letter = xy === '??' ? '?' : xy.includes('U') ? 'U' : xy[1] !== ' ' ? (xy[1] ?? '') : (xy[0] ?? '')
    if (whole && rest === name) marks.set(name, letter)
    else if (marks.get(name) !== '!') marks.set(name, '*')
  }
  return marks
}

/**
 * Files in a project whose path contains `query` (any case), for the file browser's filter: what git tracks or would
 * add (ignored files left out), or in a folder that is not a repository, every file outside `.git` and node_modules.
 */
export async function findProjectFiles(
  root: string,
  query: string,
  guard: SecretGuard = {},
): Promise<{ paths: string[]; truncated: boolean }> {
  const { real, secrets } = projectPath(root, '', true, guard)
  const q = query.trim().toLowerCase()
  let all: string[]
  try {
    all = (await git(real, ['ls-files', '-co', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  } catch {
    all = walkFiles(real, secrets)
  }
  const found = [...new Set(all)]
    .filter((p) => p.toLowerCase().includes(q) && !hiddenBy(join(real, p), secrets))
    .sort((a, b) => a.localeCompare(b))
  return { paths: found.slice(0, MAX_FIND_RESULTS), truncated: found.length > MAX_FIND_RESULTS }
}

function walkFiles(base: string, secrets: readonly string[]): string[] {
  const out: string[] = []
  const walk = (dir: string, at: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_FIND_SCAN) return
      // Hidden folders are skipped whole, so they never use up the scan.
      if (d.name === '.git' || d.name === 'node_modules' || hiddenBy(join(dir, d.name), secrets)) continue
      const path = at ? `${at}/${d.name}` : d.name
      if (d.isDirectory()) walk(join(dir, d.name), path)
      else if (d.isFile()) out.push(path)
    }
  }
  walk(base, '')
  return out
}
