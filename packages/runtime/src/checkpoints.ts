import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { type Changes, capPatch, changedFiles, git as runGit } from './git.ts'

/**
 * Checkpoints of project folders, kept in a shadow git repository per project at `<home>/checkpoints/<id>.git`
 * (Cline's approach). The project's own `.git`, branch, index, and stash are never touched, folders that are not
 * git repos work too, and changes made through the shell are captured as well as the file tools' edits. Rounds
 * snapshot their project when they start and when they end; rewinding restores a snapshot after first saving the
 * current state, so a rewind can itself be undone.
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
