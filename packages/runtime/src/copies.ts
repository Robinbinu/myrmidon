import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { IsoBackendKind, isoResolve, isoStart, isoStop } from './omp/natives.ts'
import { SKIP_DIRS } from './workspace.ts'
import type { MergeResult } from './worktrees.ts'

/**
 * A copy of the project per coding worker, for a project git worktrees cannot serve (not a git repository, or a pure
 * Jujutsu workspace): parallel workers never edit the same folder, as with worktrees. Each copy is a copy-on-write
 * clone made by omp's pi-iso (APFS on macOS, btrfs/zfs/reflink on Linux, block clones on Windows ReFS), beside a
 * second clone of the same moment that serves as the merge base, so merging back is three-way as with worktrees: the
 * project's current files are one side, the worker's the other. Text both sides changed is merged by `git merge-file`
 * when git is installed; otherwise, and for binary files, both sides changing one file is a conflict.
 *
 * Only clone backends are used: a full copy (pi-iso's rcopy) took 5-6 s for a 1.4 GB, 39k-file folder against 0.4 s
 * for an APFS clone and broke its symlinks, and an overlay (overlayfs, projfs) shows the live project through, so it
 * could not be the base. Where only those exist, there is no copy and workers share the folder, as before.
 *
 * Dependency, build and VCS folders (SKIP_DIRS) are cloned with the rest, so builds run, but never merged back.
 */

const CLONES = new Set([
  IsoBackendKind.Apfs,
  IsoBackendKind.Btrfs,
  IsoBackendKind.Zfs,
  IsoBackendKind.LinuxReflink,
  IsoBackendKind.WindowsBlockClone,
])

const BASES = '.base'

interface Copy {
  readonly agent: string
  /** The worker's copy, where it works. */
  readonly path: string
  /** The project as the copy last agreed with it: as it was made, then as of each merge. */
  readonly base: string
}

/** A file's next content: taken whole from another copy (keeping its mode), written, or removed. */
type Put = { from: string } | { data: Buffer } | null

/** A file's content, or undefined when it is not there. */
const read = (path: string): Buffer | undefined => (existsSync(path) ? readFileSync(path) : undefined)

/** A file taken whole from `path`, or removed when it is not there. */
const take = (path: string): Put => (existsSync(path) ? { from: path } : null)

const same = (a: Buffer | undefined, b: Buffer | undefined) =>
  a === undefined || b === undefined ? a === b : a.equals(b)

/** Git's own test for binary content: a NUL byte in the first 8000. */
const binary = (b: Buffer) => b.subarray(0, 8000).includes(0)

/** The files under `root` (symlinks included, as files), relative with `/`, outside SKIP_DIRS. */
function filesIn(root: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(child)
      } else out.push(child)
    }
  }
  walk('')
  return out
}

function put(path: string, value: Put) {
  if (value === null) {
    rmSync(path, { force: true })
    return
  }
  if ('from' in value && value.from === path) return
  mkdirSync(dirname(path), { recursive: true })
  if ('from' in value) copyFileSync(value.from, path)
  else writeFileSync(path, value.data)
}

/**
 * Merges one file three ways: `current` is the project's, `base` what both started from, `worker` the copy's. Clean
 * when only one side changed it, both made the same change, or `git merge-file` merges both; otherwise a conflict,
 * whose content is git's (or a whole-file) result with conflict markers.
 */
function merge3(
  paths: { current: string; base: string; worker: string },
  agent: string,
): { put: Put; conflict: boolean } {
  const current = read(paths.current)
  const base = read(paths.base)
  const worker = read(paths.worker)
  if (same(current, worker) || same(base, worker)) return { put: take(paths.current), conflict: false }
  if (same(current, base)) return { put: take(paths.worker), conflict: false }
  const text = current !== undefined && worker !== undefined && !binary(current) && !binary(worker)
  if (text && (base === undefined || !binary(base)) && Bun.which('git')) {
    // merge-file needs a base file; a file both sides added starts from an empty one.
    const dir = mkdtempSync(join(tmpdir(), 'myr-merge-'))
    try {
      const baseFile = join(dir, 'base')
      writeFileSync(baseFile, base ?? '')
      const r = Bun.spawnSync(
        [
          'git',
          'merge-file',
          '-p',
          '-L',
          'project',
          '-L',
          'base',
          '-L',
          agent,
          paths.current,
          baseFile,
          paths.worker,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      // Its exit code is the number of conflicts; below 0 (or past 127) it failed.
      if (r.exitCode !== null && r.exitCode >= 0 && r.exitCode < 128)
        return { put: { data: Buffer.from(r.stdout) }, conflict: r.exitCode > 0 }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  // No markers to write in: the worker's side stays in its copy, to keep or redo against the project's.
  if (!text) return { put: take(paths.worker), conflict: true }
  const marked = `<<<<<<< project\n${current}\n=======\n${worker}\n>>>>>>> ${agent}\n`
  return { put: { data: Buffer.from(marked) }, conflict: true }
}

export class ProjectCopies {
  private readonly _copies = new Map<string, Copy>()
  /** Merges touch the person's folder one at a time. */
  private _queue: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly project: string,
    private readonly root: string,
    private readonly kind: IsoBackendKind,
  ) {}

  /** Undefined when this computer can only copy the project in full (or overlay it), not clone it. */
  static async open(project: string, root: string): Promise<ProjectCopies | undefined> {
    const resolved = await isoResolve()
    const kind = [resolved.kind, ...resolved.candidates].find((k) => CLONES.has(k))
    return kind === undefined ? undefined : new ProjectCopies(realpathSync.native(project), root, kind)
  }

  /** Gives `agent` its copy, reusing one an interrupted run of this round left on disk. */
  async create(agent: string): Promise<{ workdir: string; branch: string; path: string }> {
    const existing = this._copies.get(agent)
    if (existing) return { workdir: existing.path, branch: '', path: existing.path }
    const name = agent.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '') || 'x'
    const path = join(this.root, name)
    const base = join(this.root, BASES, name)
    if (!existsSync(path) || !existsSync(base)) {
      for (const dir of [path, base]) rmSync(dir, { recursive: true, force: true })
      mkdirSync(dirname(base), { recursive: true })
      await isoStart(this.kind, this.project, base)
      // From the base, so both are the project at one moment.
      await isoStart(this.kind, base, path)
    }
    const real = { agent, path: realpathSync.native(path), base: realpathSync.native(base) }
    this._copies.set(agent, real)
    return { workdir: real.path, branch: '', path: real.path }
  }

  /** Merges the worker's changes since its last merge into the project folder (see `ProjectWorktrees.merge`). */
  merge(agent: string): Promise<MergeResult> {
    const next = this._queue.then(() => this._merge(agent))
    this._queue = next.catch(() => {})
    return next
  }

  /** Brings what others merged into the folder since the copy last agreed with it, keeping the worker's own work. */
  refresh(agent: string): Promise<MergeResult> {
    const next = this._queue.then(() => this._refresh(agent))
    this._queue = next.catch(() => {})
    return next
  }

  /** Removes copies whose changes are all in the project folder; one holding unmerged changes stays. */
  async close(): Promise<{ agent: string; kept: boolean }[]> {
    const out: { agent: string; kept: boolean }[] = []
    for (const copy of this._copies.values()) {
      let kept = true
      try {
        kept = (await this.changed(copy.base, copy.path)).length > 0
        if (!kept) for (const dir of [copy.path, copy.base]) await isoStop(this.kind, dir)
      } catch (err) {
        console.error(`closing ${copy.agent}'s copy failed:`, err)
      }
      out.push({ agent: copy.agent, kept })
    }
    this._copies.clear()
    return out
  }

  /** One file in the project, the copy's base and the copy. */
  private sides(copy: Copy, path: string) {
    return { current: join(this.project, path), base: join(copy.base, path), worker: join(copy.path, path) }
  }

  /**
   * The files that differ between `from` and `to` (added, removed or changed), as paths relative to both with `/`,
   * leaving out SKIP_DIRS. Not pi-iso's isoDiff, which tells files apart by size and modification time to the second
   * and so misses a same-size edit made within a second of the clone. A file whose size and modification time to the
   * nanosecond match (a clone keeps them) is taken as unchanged; any other is compared by content.
   */
  private async changed(from: string, to: string): Promise<string[]> {
    const files = new Set([...filesIn(from), ...filesIn(to)])
    return [...files]
      .filter((path) => {
        const a = statSync(join(from, path), { bigint: true, throwIfNoEntry: false })
        const b = statSync(join(to, path), { bigint: true, throwIfNoEntry: false })
        if (!a || !b) return true
        if (a.size === b.size && a.mtimeNs === b.mtimeNs) return false
        return !same(read(join(from, path)), read(join(to, path)))
      })
      .sort()
  }

  private async _merge(agent: string): Promise<MergeResult> {
    const copy = this._copies.get(agent)
    if (!copy) return { kind: 'nothing' }
    const mine = await this.changed(copy.base, copy.path)
    if (!mine.length) return { kind: 'nothing' }
    const at = (path: string) => this.sides(copy, path)
    const merged = mine.map((path) => ({ path, ...merge3(at(path), agent) }))
    const conflicts = merged.filter((m) => m.conflict).map((m) => m.path)
    if (conflicts.length) {
      // As with a worktree: the copy takes the folder's current state with the merge (markers and all), and that
      // state becomes its base, so the worker resolves the conflict there and submits again.
      const theirs = (await this.changed(copy.base, this.project)).filter((p) => !mine.includes(p))
      for (const path of theirs) put(at(path).worker, take(at(path).current))
      for (const m of merged) put(at(m.path).worker, m.put)
      for (const path of [...theirs, ...mine]) put(at(path).base, take(at(path).current))
      return { kind: 'conflict', files: conflicts }
    }
    const files = merged.filter((m) => !same(read(at(m.path).current), contentOf(m.put))).map((m) => m.path)
    for (const m of merged) {
      put(at(m.path).current, m.put)
      // The base is now the worker's side, as a worktree's base is its branch tip after a merge.
      put(at(m.path).base, take(at(m.path).worker))
    }
    return files.length ? { kind: 'merged', files } : { kind: 'nothing' }
  }

  private async _refresh(agent: string): Promise<MergeResult> {
    const copy = this._copies.get(agent)
    if (!copy) return { kind: 'nothing' }
    const theirs = await this.changed(copy.base, this.project)
    if (!theirs.length) return { kind: 'nothing' }
    const mine = new Set(await this.changed(copy.base, copy.path))
    const at = (path: string) => this.sides(copy, path)
    const plan = theirs.map((path) =>
      mine.has(path)
        ? { path, ...merge3(at(path), agent) }
        : { path, put: take(at(path).current), conflict: false },
    )
    // A refresh that would conflict leaves the copy alone; the worker meets the conflict when it submits.
    if (plan.some((p) => p.conflict))
      return { kind: 'conflict', files: plan.filter((p) => p.conflict).map((p) => p.path) }
    const files = plan.filter((p) => !same(read(at(p.path).worker), contentOf(p.put))).map((p) => p.path)
    for (const p of plan) {
      put(at(p.path).worker, p.put)
      put(at(p.path).base, take(at(p.path).current))
    }
    return files.length ? { kind: 'merged', files } : { kind: 'nothing' }
  }
}

function contentOf(value: Put): Buffer | undefined {
  if (value === null) return undefined
  return 'from' in value ? read(value.from) : value.data
}
