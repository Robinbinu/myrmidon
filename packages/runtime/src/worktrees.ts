import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { vcsIsPureJj } from './omp/natives.ts'
import { SKIP_DIRS } from './workspace.ts'

/**
 * A git worktree per coding worker, so parallel workers never edit the same folder. Each worktree is a branch made
 * from a snapshot of the project folder as it was (uncommitted changes included); the harness merges a worker's
 * changes back into the folder with a three-way merge when it submits its task. On a conflict the worker's tree gets
 * both sides with conflict markers, and the worker resolves them there. Agents never run git on these themselves.
 */

/** Harness commits on worker branches; they never reach the person's own branches. */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Myrmidon',
  GIT_AUTHOR_EMAIL: 'agents@myrmidon.local',
  GIT_COMMITTER_NAME: 'Myrmidon',
  GIT_COMMITTER_EMAIL: 'agents@myrmidon.local',
}

/** Installed dependencies are gitignored, so a fresh worktree lacks them; these are linked from the project. */
const DEPENDENCY_DIRS = new Set(['node_modules', '.venv', 'venv'])

interface Run {
  code: number
  out: string
  err: string
}

async function run(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  input?: string,
): Promise<Run> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

/** Removes a link to a folder, never what it points to: a junction on Windows is removed as an empty folder is. */
function unlink(path: string) {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return
  if (process.platform === 'win32') rmdirSync(path)
  else unlinkSync(path)
}

async function git(cwd: string, args: string[], env: Record<string, string> = {}, input?: string) {
  const r = await run(cwd, args, env, input)
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.err.trim() || `exit ${r.code}`}`)
  return r.out
}

const refPart = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '') || 'x'

interface Tree {
  readonly agent: string
  readonly branch: string
  /** The worktree's top folder. */
  readonly path: string
  /** Where the agent works: the project's own subfolder inside the worktree. */
  readonly workdir: string
  /** Remembers what the folder last had of this worker's changes, so a resumed round merges from there too. */
  readonly baseRef: string
  /** Dependency folders linked in from the project, relative to the worktree top; never committed. */
  readonly links: string[]
}

export type MergeResult =
  | { kind: 'nothing' }
  | { kind: 'merged'; files: string[] }
  | { kind: 'conflict'; files: string[] }

export class ProjectWorktrees {
  private readonly _trees = new Map<string, Tree>()
  /** Merges touch the person's folder one at a time. */
  private _queue: Promise<unknown> = Promise.resolve()

  private constructor(
    /** The repository's top folder (the project may be a subfolder of it). */
    private readonly top: string,
    /** The project folder relative to `top`, with a trailing slash, or ''. */
    private readonly prefix: string,
    private readonly root: string,
    private readonly colony: string,
  ) {}

  /**
   * Undefined when the project is not inside a git repository, or is a Jujutsu workspace of its own (no colocated git)
   * inside one: git would see the outer repository, and worktrees of that are not the project.
   */
  static async open(project: string, root: string, colony: string): Promise<ProjectWorktrees | undefined> {
    if (vcsIsPureJj(project)) return undefined
    const top = await run(project, ['rev-parse', '--show-toplevel'])
    if (top.code !== 0) return undefined
    const prefix = (await git(project, ['rev-parse', '--show-prefix'])).trim()
    return new ProjectWorktrees(realpathSync.native(top.out.trim()), prefix, root, colony)
  }

  get(agent: string): { workdir: string; branch: string } | undefined {
    return this._trees.get(agent)
  }

  /** Gives `agent` its worktree, reusing one an interrupted run of this round left on disk. */
  async create(agent: string): Promise<{ workdir: string; branch: string; path: string }> {
    const existing = this._trees.get(agent)
    if (existing) return existing
    const branch = `myr/${refPart(this.colony)}/${refPart(agent)}`
    const baseRef = `refs/myrmidon/${refPart(this.colony)}/${refPart(agent)}`
    const path = join(this.root, refPart(agent))
    if (!existsSync(join(path, '.git'))) {
      const base = await this.snapshot()
      mkdirSync(this.root, { recursive: true })
      rmSync(path, { recursive: true, force: true })
      await git(this.top, ['worktree', 'prune'])
      await git(this.top, ['worktree', 'add', '-q', '-B', branch, path, base])
      await git(this.top, ['update-ref', baseRef, base])
    }
    const real = realpathSync.native(path)
    const links = this.linkDependencies(real)
    const tree: Tree = { agent, branch, path: real, workdir: join(real, this.prefix), baseRef, links }
    this._trees.set(agent, tree)
    return tree
  }

  /**
   * Merges the worker's changes since its last merge into the project folder. The folder's current state (with
   * anyone else's changes) is one side, the worker's branch the other, and the last merged point the base.
   */
  merge(agent: string): Promise<MergeResult> {
    const next = this._queue.then(() => this._merge(agent))
    this._queue = next.catch(() => {})
    return next
  }

  /**
   * Brings what others merged into the folder since this worktree was made (or last synced) into it, keeping the
   * worker's own unmerged changes, so a task that starts later builds on the latest code. A conflict leaves the
   * worktree as it is; the worker meets it when it submits.
   */
  refresh(agent: string): Promise<MergeResult> {
    const next = this._queue.then(() => this._refresh(agent))
    this._queue = next.catch(() => {})
    return next
  }

  private async _refresh(agent: string): Promise<MergeResult> {
    const tree = this._trees.get(agent)
    if (!tree) return { kind: 'nothing' }
    const tip = await this.commitWork(tree, `${agent}: work`)
    const base = (await git(this.top, ['rev-parse', tree.baseRef])).trim()
    const current = await this.snapshot()
    if ((await this.treeOf(current)) === (await this.treeOf(base))) return { kind: 'nothing' }
    const m = await run(this.top, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      `--merge-base=${base}`,
      current,
      tip,
    ])
    if (m.code !== 0 && m.code !== 1) throw new Error(`git merge-tree failed: ${m.err.trim()}`)
    const [merged = '', ...conflicted] = m.out.trim().split('\n')
    if (m.code === 1) return { kind: 'conflict', files: [...new Set(conflicted.filter(Boolean))] }
    const files = (await git(this.top, ['diff', '--name-only', tip, merged])).split('\n').filter(Boolean)
    await git(tree.path, ['read-tree', '--reset', '-u', merged])
    await this.commitWork(tree, `${agent}: bring in the project's current state`)
    await git(this.top, ['update-ref', tree.baseRef, current])
    return files.length ? { kind: 'merged', files } : { kind: 'nothing' }
  }

  private async _merge(agent: string): Promise<MergeResult> {
    const tree = this._trees.get(agent)
    if (!tree) return { kind: 'nothing' }
    const tip = await this.commitWork(tree, `${agent}: work`)
    const base = (await git(this.top, ['rev-parse', tree.baseRef])).trim()
    if ((await this.treeOf(tip)) === (await this.treeOf(base))) return { kind: 'nothing' }
    for (let attempt = 0; ; attempt++) {
      const current = await this.snapshot()
      const m = await run(this.top, [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '--no-messages',
        `--merge-base=${base}`,
        current,
        tip,
      ])
      if (m.code !== 0 && m.code !== 1) throw new Error(`git merge-tree failed: ${m.err.trim()}`)
      const [merged = '', ...conflicted] = m.out.trim().split('\n')
      if (m.code === 1) {
        // The worker's tree takes the merged result, markers and all, and now contains the folder's state.
        await git(tree.path, ['read-tree', '--reset', '-u', merged])
        await this.commitWork(tree, `${agent}: merge the project's current state (conflicts to resolve)`)
        await git(this.top, ['update-ref', tree.baseRef, current])
        return { kind: 'conflict', files: [...new Set(conflicted.filter(Boolean))] }
      }
      const files = (await git(this.top, ['diff', '--name-only', current, merged]))
        .split('\n')
        .filter(Boolean)
      const patch = await git(this.top, ['diff', '--binary', '--no-color', '--no-ext-diff', current, merged])
      const applied = patch
        ? await run(this.top, ['apply', '--whitespace=nowarn', '-'], {}, patch)
        : undefined
      if (!applied || applied.code === 0) {
        await git(this.top, ['update-ref', tree.baseRef, tip])
        return files.length ? { kind: 'merged', files } : { kind: 'nothing' }
      }
      // Someone changed the folder between the snapshot and the apply: take a fresh snapshot once.
      if (attempt >= 1) throw new Error(`could not apply ${agent}'s changes: ${applied.err.trim()}`)
    }
  }

  /**
   * The project files the worker changed since its last merge, relative to the project folder: what a merge would
   * bring in, read without merging.
   */
  pending(agent: string): Promise<string[]> {
    const next = this._queue.then(async () => {
      const tree = this._trees.get(agent)
      if (!tree) return []
      const tip = await this.commitWork(tree, `${agent}: work`)
      const base = (await git(this.top, ['rev-parse', tree.baseRef])).trim()
      return (await git(this.top, ['diff', '--name-only', base, tip]))
        .split('\n')
        .filter((f) => f !== '' && f.startsWith(this.prefix))
        .map((f) => f.slice(this.prefix.length))
    })
    this._queue = next.catch(() => {})
    return next
  }

  /** Commits the worktree's changes as one kept trial of an experiment (autoresearch) and returns the commit. */
  async keep(agent: string, message: string): Promise<string> {
    const tree = this._trees.get(agent)
    if (!tree) throw new Error(`${agent} has no worktree`)
    return this.commitWork(tree, message)
  }

  /**
   * Drops the worktree's changes since its last commit (an experiment's trial that did not improve), new files
   * included; the linked dependency folders stay.
   */
  async revert(agent: string): Promise<void> {
    const tree = this._trees.get(agent)
    if (!tree) throw new Error(`${agent} has no worktree`)
    await git(tree.path, ['reset', '-q', '--hard', 'HEAD'])
    await git(tree.path, ['clean', '-fdq', '--', '.', ...tree.links.map((l) => `:(exclude)${l}`)])
  }

  /**
   * Removes worktrees whose changes are all in the project folder; one holding unmerged changes stays, with its
   * branch, so nothing is lost.
   */
  async close(): Promise<{ agent: string; kept: boolean }[]> {
    const out: { agent: string; kept: boolean }[] = []
    for (const tree of this._trees.values()) {
      let kept = true
      try {
        const tip = await this.commitWork(tree, `${tree.agent}: work left when the round ended`)
        const base = (await git(this.top, ['rev-parse', tree.baseRef])).trim()
        kept = (await this.treeOf(tip)) !== (await this.treeOf(base))
        if (!kept) {
          // The links go first, as links: Git for Windows leaves a worktree's folder behind when a junction is in it.
          for (const link of tree.links) unlink(join(tree.path, link))
          await git(this.top, ['worktree', 'remove', '--force', tree.path])
          await git(this.top, ['branch', '-D', tree.branch])
          await git(this.top, ['update-ref', '-d', tree.baseRef])
        }
      } catch (err) {
        console.error(`closing ${tree.agent}'s worktree failed:`, err)
      }
      out.push({ agent: tree.agent, kept })
    }
    this._trees.clear()
    return out
  }

  /** Commits everything in the worktree (except linked dependencies) and returns the branch tip. */
  private async commitWork(tree: Tree, message: string): Promise<string> {
    // Only links git does not ignore already are excluded: `git add` refuses a pathspec naming an ignored path, and
    // Git for Windows takes a junction for the folder it points to, which `node_modules/` ignores.
    const ignored = tree.links.length
      ? new Set(
          (await run(tree.path, ['check-ignore', '--', ...tree.links])).out.split(/\r?\n/).filter(Boolean),
        )
      : new Set<string>()
    const excluded = tree.links.filter((l) => !ignored.has(l)).map((l) => `:(exclude)${l}`)
    await git(tree.path, ['add', '-A', '--', '.', ...excluded])
    const staged = await git(tree.path, ['diff', '--cached', '--name-only'])
    if (staged.trim()) await git(tree.path, ['commit', '-q', '--no-verify', '-m', message], IDENTITY)
    return (await git(tree.path, ['rev-parse', 'HEAD'])).trim()
  }

  private async treeOf(commit: string) {
    return (await git(this.top, ['rev-parse', `${commit}^{tree}`])).trim()
  }

  /**
   * A commit of the folder as it is, untracked files included, made with a throwaway index so the person's own
   * index, HEAD and branches stay untouched.
   */
  private async snapshot(): Promise<string> {
    const index = join(this.root, `.index-${crypto.randomUUID()}`)
    mkdirSync(this.root, { recursive: true })
    try {
      const real = resolve(this.top, (await git(this.top, ['rev-parse', '--git-path', 'index'])).trim())
      if (existsSync(real)) copyFileSync(real, index)
      const env = { GIT_INDEX_FILE: index }
      await git(this.top, ['add', '-A'], env)
      const tree = (await git(this.top, ['write-tree'], env)).trim()
      const head = await run(this.top, ['rev-parse', '--verify', '-q', 'HEAD'])
      const parent = head.code === 0 ? ['-p', head.out.trim()] : []
      return (
        await git(this.top, ['commit-tree', tree, ...parent, '-m', 'myrmidon: project snapshot'], IDENTITY)
      ).trim()
    } finally {
      rmSync(index, { force: true })
    }
  }

  /** Links the project's gitignored dependency folders into the worktree, so its builds and tests run. */
  private linkDependencies(path: string): string[] {
    const links: string[] = []
    const walk = (rel: string, depth: number) => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = readdirSync(join(this.top, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const child = rel ? `${rel}/${e.name}` : e.name
        if (DEPENDENCY_DIRS.has(e.name)) {
          const target = join(path, child)
          const linked = lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()
          if (linked) links.push(child)
          else if (!existsSync(target) && existsSync(dirname(target))) {
            // A directory symlink needs Developer Mode or an administrator on Windows; a junction needs neither.
            symlinkSync(join(this.top, child), target, process.platform === 'win32' ? 'junction' : 'dir')
            links.push(child)
          }
          continue
        }
        if (depth < 3 && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(child, depth + 1)
      }
    }
    walk('', 0)
    return links
  }
}
