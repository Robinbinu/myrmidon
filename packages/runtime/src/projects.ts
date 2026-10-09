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
import { MAX_PROJECT_FILE_BYTES, NEW_PROJECT_MODE } from './config.ts'

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

  constructor(home: string) {
    this._file = join(home, 'projects.json')
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
    if (mode !== 'auto' && mode !== 'ask' && mode !== 'read-only')
      throw new Error('mode is auto, ask or read-only')
    const allow = [...new Set(permissions.allow.map((a) => a.trim()).filter(Boolean))].slice(0, 50)
    const list = this.list()
    const project = list.find((p) => p.id === id)
    if (!project) throw new Error('no such project')
    const next = { ...project, permissions: { mode, allow } }
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
 * A text file in a project folder, for the person to read in the app: one an agent edited, say. `file` is relative to
 * the folder or absolute inside it (agents name files both ways). Symlinks are followed only while they stay inside.
 */
export function readProjectFile(root: string, file: string): { path: string; text: string } {
  const base = realpathSync(root)
  const abs = resolve(base, file)
  const inside = (p: string) => p.startsWith(base + sep)
  // The real path decides (an absolute path may reach the folder through a symlink); a missing one is judged as named.
  const real = existsSync(abs) ? realpathSync(abs) : abs
  if (!file || !inside(real)) throw new Error(`${file} is not in this project`)
  if (!existsSync(real)) throw new Error(`${file} is no longer in the folder`)
  const stat = statSync(real)
  if (!stat.isFile()) throw new Error(`${file} is not a file`)
  if (stat.size > MAX_PROJECT_FILE_BYTES) throw new Error(`${file} is over 2 MB, too large to show`)
  const bytes = readFileSync(real)
  if (bytes.includes(0)) throw new Error(`${file} is not a text file`)
  return { path: relative(base, real), text: bytes.toString('utf8') }
}
