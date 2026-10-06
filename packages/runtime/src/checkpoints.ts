import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/**
 * Checkpoints of project folders, kept in a shadow git repository per project at `<home>/checkpoints/<id>.git`
 * (Cline's approach). The project's own `.git`, branch, index, and stash are never touched, folders that are not
 * git repos work too, and changes made through the shell are captured as well as the file tools' edits. Rounds
 * snapshot their project when they start and when they end; rewinding restores a snapshot after first saving the
 * current state, so a rewind can itself be undone.
 */

export interface ChangedFile {
  readonly path: string
  /** git's status letter: A added, M modified, D deleted, R renamed. */
  readonly status: string
  /** Undefined for binary files. */
  readonly added?: number
  readonly removed?: number
}

export interface Changes {
  readonly files: ChangedFile[]
  readonly patch: string
  /** The patch was cut at MAX_PATCH. */
  readonly truncated: boolean
}

const MAX_PATCH = 512 * 1024
/** Never worth snapshotting, even without a .gitignore saying so. */
const EXCLUDE = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.DS_Store',
  '.next/',
  '.turbo/',
  '.cache/',
]

export class Checkpoints {
  private readonly _queues = new Map<string, Promise<unknown>>()

  constructor(private readonly dir: string) {}

  /** Records the folder's current state and returns the checkpoint's commit hash. */
  snapshot(project: { id: string; path: string }, label: string): Promise<string> {
    return this._serial(project.id, async () => {
      const git = await this._repo(project)
      await git(['add', '--all', '--', '.'])
      await git(['commit', '--quiet', '--allow-empty', '--no-verify', '-m', label.slice(0, 200)])
      return (await git(['rev-parse', 'HEAD'])).trim()
    })
  }

  /** What changed between two checkpoints, or from one to the folder as it is now. */
  async changes(project: { id: string; path: string }, from: string, to?: string): Promise<Changes> {
    const target = to ?? (await this.snapshot(project, 'compare'))
    return this._serial(project.id, async () => {
      const git = await this._repo(project)
      const numstat = await git(['diff', '--numstat', '-M', from, target])
      const names = await git(['diff', '--name-status', '-M', from, target])
      const statuses = new Map(
        names
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [status = '', ...paths] = l.split('\t')
            return [paths.at(-1) ?? '', status.slice(0, 1)] as const
          }),
      )
      const files = numstat
        .split('\n')
        .filter(Boolean)
        .map((l): ChangedFile => {
          const [a = '', r = '', ...rest] = l.split('\t')
          // Renames print as "old => new" (or "dir/{old => new}"); keep the new name.
          const raw = rest.join('\t')
          const path = raw.includes(' => ')
            ? raw.replace(/\{([^}]*) => ([^}]*)\}/, '$2').replace(/^.* => /, '')
            : raw
          return {
            path,
            status: statuses.get(path) ?? 'M',
            ...(a === '-' ? {} : { added: Number(a), removed: Number(r) }),
          }
        })
      const patch = await git(['diff', '-M', from, target])
      return {
        files,
        patch: patch.length > MAX_PATCH ? patch.slice(0, MAX_PATCH) : patch,
        truncated: patch.length > MAX_PATCH,
      }
    })
  }

  /**
   * Puts the folder back the way it was at `commit`: changed and deleted files are restored, files added since are
   * removed. Returns the checkpoint of the state just before the rewind, which undoes it.
   */
  async restore(
    project: { id: string; path: string },
    commit: string,
  ): Promise<{ undo: string; changed: number }> {
    const undo = await this.snapshot(project, `before rewinding to ${commit.slice(0, 10)}`)
    return this._serial(project.id, async () => {
      const git = await this._repo(project)
      const root = resolve(project.path)
      const added = (await git(['diff', '--name-only', '--diff-filter=A', '--no-renames', commit, undo]))
        .split('\n')
        .filter(Boolean)
      for (const path of added) {
        const full = resolve(root, path)
        if (full.startsWith(root + sep)) rmSync(full, { force: true })
      }
      const changed = (await git(['diff', '--name-only', '--no-renames', commit, undo]))
        .split('\n')
        .filter(Boolean)
      if (changed.length > added.length) await git(['checkout', commit, '--', '.'])
      await git(['add', '--all', '--', '.'])
      await git([
        'commit',
        '--quiet',
        '--allow-empty',
        '--no-verify',
        '-m',
        `rewound to ${commit.slice(0, 10)}`,
      ])
      return { undo, changed: changed.length }
    })
  }

  private async _repo(project: { id: string; path: string }) {
    const gitDir = join(this.dir, `${project.id}.git`)
    const git = async (args: string[]) => {
      const proc = Bun.spawn(['git', `--git-dir=${gitDir}`, `--work-tree=${project.path}`, ...args], {
        cwd: project.path,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) throw new Error(`checkpoint git ${args[0]} failed: ${err.trim() || `exit ${code}`}`)
      return out
    }
    if (!existsSync(join(gitDir, 'HEAD'))) {
      mkdirSync(this.dir, { recursive: true })
      await git(['init', '--quiet'])
      for (const [key, value] of [
        ['user.name', 'Myrmidon'],
        ['user.email', 'checkpoints@myrmidon.local'],
        ['commit.gpgsign', 'false'],
        ['core.autocrlf', 'false'],
        ['core.quotepath', 'false'],
      ] as const)
        await git(['config', key, value])
      mkdirSync(join(gitDir, 'info'), { recursive: true })
      writeFileSync(join(gitDir, 'info', 'exclude'), `${EXCLUDE.join('\n')}\n`)
    }
    return git
  }

  private _serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const next = (this._queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
    this._queues.set(key, next)
    return next
  }
}
