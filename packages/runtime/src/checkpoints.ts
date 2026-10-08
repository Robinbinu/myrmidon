import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { type Changes, capPatch, changedFiles, git as runGit } from './git.ts'

/**
 * Checkpoints of project folders, kept in a shadow git repository per project at `<home>/checkpoints/<id>.git`
 * (Cline's approach). The project's own `.git`, branch, index, and stash are never touched, folders that are not
 * git repos work too, and changes made through the shell are captured as well as the file tools' edits. Rounds
 * snapshot their project when they start and when they end; rewinding restores a round's own files after first
 * saving the current state, so a rewind can itself be undone.
 */

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
      return {
        files: changedFiles(
          await git(['diff', '--numstat', '-M', from, target]),
          await git(['diff', '--name-status', '-M', from, target]),
        ),
        ...capPatch(await git(['diff', '-M', from, target])),
      }
    })
  }

  /** The files that differ between two checkpoints, by path. */
  async files(project: { id: string; path: string }, from: string, to: string): Promise<string[]> {
    return this._serial(project.id, async () => {
      const git = await this._repo(project)
      return (await git(['diff', '--name-only', '--no-renames', from, to])).split('\n').filter(Boolean)
    })
  }

  /**
   * Puts `files` back the way they were at `commit`: restored, or removed if they did not exist then. Nothing else in
   * the folder is touched, so work done since by anyone else stays. Returns the checkpoint of the state just before,
   * which undoes it.
   */
  async restore(
    project: { id: string; path: string },
    commit: string,
    files: readonly string[],
  ): Promise<{ undo: string; changed: number }> {
    const undo = await this.snapshot(project, `before rewinding to ${commit.slice(0, 10)}`)
    return this._serial(project.id, async () => {
      const git = await this._repo(project)
      const root = resolve(project.path)
      const existed = new Set(
        (await git(['ls-tree', '-r', '--name-only', commit])).split('\n').filter(Boolean),
      )
      const back = files.filter((f) => existed.has(f))
      for (const path of files) {
        const full = resolve(root, path)
        if (!existed.has(path) && full.startsWith(root + sep)) rmSync(full, { force: true })
      }
      // In batches, so a round that touched thousands of files stays under the argument limit.
      for (let i = 0; i < back.length; i += 200)
        await git(['checkout', commit, '--', ...back.slice(i, i + 200)])
      await git(['add', '--all', '--', '.'])
      await git([
        'commit',
        '--quiet',
        '--allow-empty',
        '--no-verify',
        '-m',
        `rewound ${files.length} file(s) to ${commit.slice(0, 10)}`,
      ])
      return { undo, changed: files.length }
    })
  }

  private async _repo(project: { id: string; path: string }) {
    const gitDir = join(this.dir, `${project.id}.git`)
    const git = (args: string[]) =>
      runGit(project.path, [`--git-dir=${gitDir}`, `--work-tree=${project.path}`, ...args])
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
