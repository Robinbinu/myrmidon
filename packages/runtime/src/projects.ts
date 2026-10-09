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
import { basename, join, relative, resolve, sep } from 'node:path'
import type { ProjectPermissions } from '@myrmidon/protocol'
import {
  MAX_FIND_RESULTS,
  MAX_FIND_SCAN,
  MAX_PROJECT_FILE_BYTES,
  MAX_READ_FOLDERS,
  MAX_TREE_ENTRIES,
  NEW_PROJECT_MODE,
} from './config.ts'
import { git } from './git.ts'
import { readFolder, secretAt } from './read-access.ts'

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
  /** Absent on folders added before new ones started on `NEW_PROJECT_MODE`: those are autonomous. */
  readonly permissions?: ProjectPermissions
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
      return Array.isArray(raw) ? (raw as Project[]).filter((p) => p && typeof p.path === 'string') : []
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
      permissions: { mode: NEW_PROJECT_MODE, allow: [] },
    }
    this._write([...this.list(), project])
    return project
  }

  /** Sets how freely agents may change the project; applies from the chat's next round. */
  setPermissions(id: string, permissions: ProjectPermissions): Project {
    const mode = permissions.mode
    if (mode !== 'auto' && mode !== 'ask' && mode !== 'read-only' && mode !== 'full')
      throw new Error('mode is auto, ask, read-only or full')
    const allow = [...new Set(permissions.allow.map((a) => a.trim()).filter(Boolean))].slice(0, 50)
    const read = [...new Set((permissions.read ?? []).map((f) => f.trim()).filter(Boolean))]
    if (read.length > MAX_READ_FOLDERS) throw new Error(`at most ${MAX_READ_FOLDERS} readable folders`)
    for (const folder of read)
      if (secretAt(readFolder(folder), { dataDir: this._home }))
        throw new Error(
          `${folder} holds keys, sign-ins or other chats: a project cannot open it, only naming it in Settings → Tools can`,
        )
    const list = this.list()
    const project = list.find((p) => p.id === id)
    if (!project) throw new Error('no such project')
    const next = { ...project, permissions: { mode, allow, ...(read.length ? { read } : {}) } }
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

/** An existing directory, as an absolute path with symlinks resolved; `~` means the home directory. */
function checkedDir(path: string): string {
  const expanded = path.trim().replace(/^~(?=$|\/)/, homedir())
  if (!expanded.startsWith('/')) throw new Error('use an absolute path (or one starting with ~)')
  const abs = resolve(expanded)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`not a folder: ${abs}`)
  const real = realpathSync(abs)
  if (real === '/' || real === realpathSync(homedir()))
    throw new Error('pick a project folder, not / or your home folder')
  return real
}

/** Sub-folders of a directory, for the folder picker. Hidden folders are left out. */
export function listFolders(path: string): { path: string; parent: string | undefined; folders: string[] } {
  const expanded = (path.trim() || '~').replace(/^~(?=$|\/)/, homedir())
  const abs = resolve(expanded)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`not a folder: ${abs}`)
  const folders = readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 500)
  const parent = abs === '/' ? undefined : resolve(abs, '..')
  return { path: abs, parent, folders }
}

/**
 * A path in a project folder as its real path, refused when it leads outside (`allowRoot`: the folder itself counts).
 * `path` is relative to the folder or absolute inside it (agents name files both ways). Symlinks are followed only
 * while they stay inside. A missing path is judged as named.
 */
function projectPath(root: string, path: string, allowRoot = false): { base: string; real: string } {
  const base = realpathSync(root)
  const abs = resolve(base, path)
  const real = existsSync(abs) ? realpathSync(abs) : abs
  if ((!path && !allowRoot) || !(real.startsWith(base + sep) || (allowRoot && real === base)))
    throw new Error(`${path} is not in this project`)
  if (!existsSync(real)) throw new Error(`${path} is no longer in the folder`)
  return { base, real }
}

/** A text file in a project folder, for the person to read in the app: one an agent edited, say. */
export function readProjectFile(root: string, file: string): { path: string; text: string } {
  const { base, real } = projectPath(root, file)
  const stat = statSync(real)
  if (!stat.isFile()) throw new Error(`${file} is not a file`)
  if (stat.size > MAX_PROJECT_FILE_BYTES) throw new Error(`${file} is over 2 MB, too large to show`)
  const bytes = readFileSync(real)
  if (bytes.includes(0)) throw new Error(`${file} is not a text file`)
  return { path: relative(base, real), text: bytes.toString('utf8') }
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
): Promise<{ path: string; entries: ProjectEntry[]; truncated: boolean }> {
  const { base, real } = projectPath(root, dir, true)
  if (!statSync(real).isDirectory()) throw new Error(`${dir} is not a folder`)
  const at = relative(base, real)
  const marks = await gitMarks(base, at)
  const entries: ProjectEntry[] = []
  for (const d of readdirSync(real, { withFileTypes: true })) {
    if (d.name === '.git') continue
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
): Promise<{ paths: string[]; truncated: boolean }> {
  const { real } = projectPath(root, '', true)
  const q = query.trim().toLowerCase()
  let all: string[]
  try {
    all = (await git(real, ['ls-files', '-co', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  } catch {
    all = walkFiles(real)
  }
  const found = [...new Set(all)]
    .filter((p) => p.toLowerCase().includes(q))
    .sort((a, b) => a.localeCompare(b))
  return { paths: found.slice(0, MAX_FIND_RESULTS), truncated: found.length > MAX_FIND_RESULTS }
}

function walkFiles(base: string): string[] {
  const out: string[] = []
  const walk = (dir: string, at: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_FIND_SCAN) return
      if (d.name === '.git' || d.name === 'node_modules') continue
      const path = at ? `${at}/${d.name}` : d.name
      if (d.isDirectory()) walk(join(dir, d.name), path)
      else if (d.isFile()) out.push(path)
    }
  }
  walk(base, '')
  return out
}
