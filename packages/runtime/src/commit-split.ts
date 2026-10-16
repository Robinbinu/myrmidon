import { COMMIT_SPLIT } from './config.ts'
import { git } from './git.ts'
import { loadCommit } from './omp/commit.ts'
import { prompts } from './prompts.ts'

/**
 * Splitting a working tree into atomic commits, after omp's commit workflow (commit/agentic/): the agent proposes
 * groups of files with a message each and the groups they build on; the plan must cover every changed file exactly
 * once, its order must have no cycle (omp's computeDependencyOrder), and each message must pass omp's summary checks
 * and its filler and meta-phrase rules. The plan is shown to the person before anything is written, and the commits
 * are made in dependency order with `git add` and `git commit` only: nothing is ever pushed.
 */

export interface CommitGroup {
  /** Paths relative to the repository root, as `git status` shows them. */
  readonly files: readonly string[]
  readonly subject: string
  readonly body?: string
  /** Indexes (0-based) of the groups this one builds on, which are committed first. */
  readonly dependsOn?: readonly number[]
}

export interface CommitPlan {
  /** The groups in the order they are committed. */
  readonly order: readonly number[]
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
  /** The plan as the person reads it: each commit's message and files, in order. */
  readonly preview: string
}

// After omp's agentic/validation.ts: words that say nothing, and phrases about the commit instead of the change.
const FILLER = ['comprehensive', 'various', 'several', 'improved', 'enhanced', 'better']
const META = ['this commit', 'this change', 'updated code', 'modified files']
/** `type(scope): ` or `type: `, a conventional commit's prefix, whose scope omp checks. */
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]*)\))?!?:\s/

/** Every path the working tree changed against HEAD (staged, unstaged, untracked), with a rename's old path. */
export async function changedPaths(cwd: string): Promise<{ path: string; from?: string }[]> {
  const raw = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const parts = raw.split('\0')
  const out: { path: string; from?: string }[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry || entry.length < 4) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    // -z puts a rename's old path in the next field.
    if (status.includes('R') || status.includes('C')) out.push({ path, from: parts[++i] ?? '' })
    else out.push({ path })
  }
  return out
}

/** Checks `groups` against what changed in `cwd` and orders them; the plan can be written only when `errors` is empty. */
export async function planCommits(cwd: string, groups: readonly CommitGroup[]): Promise<CommitPlan> {
  const say = prompts.commitSplit
  const { topo, validation } = await loadCommit()
  const changed = await changedPaths(cwd)
  const errors: string[] = []
  const warnings: string[] = []
  if (!changed.length) errors.push(say.nothingChanged)
  if (!groups.length) errors.push(say.noGroups)
  if (groups.length > COMMIT_SPLIT.maxCommits) errors.push(say.tooMany(COMMIT_SPLIT.maxCommits))
  const known = new Set(changed.map((c) => c.path))
  const used = new Map<string, number>()
  groups.forEach((g, i) => {
    const n = i + 1
    if (!g.files.length) errors.push(say.emptyGroup(n))
    for (const file of g.files) {
      if (!known.has(file)) errors.push(say.notChanged(n, file))
      else if (used.has(file)) errors.push(say.twice(file, (used.get(file) ?? 0) + 1, n))
      else used.set(file, i)
    }
    const subject = g.subject.trim()
    for (const e of validation.validateSummary(subject, COMMIT_SPLIT.subjectMaxChars).errors)
      errors.push(say.message(n, e))
    const prefix = CONVENTIONAL.exec(subject)
    if (prefix?.[2] !== undefined)
      for (const e of validation.validateScope(prefix[2] || null).errors) errors.push(say.message(n, e))
    const lower = subject.toLowerCase()
    for (const word of FILLER)
      if (lower.includes(word)) warnings.push(say.message(n, `Avoid filler word: ${word}`))
    for (const phrase of META)
      if (lower.includes(phrase)) errors.push(say.message(n, `Avoid meta phrase: ${phrase}`))
    for (const line of (g.body ?? '').split('\n'))
      if (line.length > COMMIT_SPLIT.bodyLineMaxChars) {
        warnings.push(say.longBodyLine(n, COMMIT_SPLIT.bodyLineMaxChars))
        break
      }
  })
  for (const c of changed) if (!used.has(c.path)) errors.push(say.missing(c.path))
  const deps = groups.map((g) => [...(g.dependsOn ?? [])].map(Math.floor))
  let order: number[] = groups.map((_, i) => i)
  const sorted = topo.computeDependencyOrder(deps.map((dependencies) => ({ dependencies })) as never)
  if ('error' in sorted) errors.push(sorted.error)
  else order = sorted
  const preview = order
    .map((i, at) => {
      const g = groups[i]
      if (!g) return ''
      const after = (g.dependsOn ?? []).length ? say.after((g.dependsOn ?? []).map((d) => d + 1)) : ''
      return `${at + 1}. ${g.subject.trim()}${after}\n${g.body?.trim() ? `${g.body.trim()}\n` : ''}${g.files.map((f) => `   ${f}`).join('\n')}`
    })
    .join('\n\n')
  return { order, errors, warnings, preview }
}

/**
 * Makes the plan's commits in order: unstages everything, then for each group adds its files (a rename with its old
 * path) and commits with its message. Stops at the first failure, saying which commits were made. Never pushes.
 * Returns each commit's short hash and subject.
 */
export async function writeCommits(
  cwd: string,
  groups: readonly CommitGroup[],
  order: readonly number[],
): Promise<string[]> {
  const renames = new Map(
    (await changedPaths(cwd)).flatMap((c) => (c.from ? [[c.path, c.from] as const] : [])),
  )
  // A repository with no commit yet has nothing to reset to; there is nothing staged to keep apart either way.
  await git(cwd, ['reset', '-q']).catch(() => undefined)
  const made: string[] = []
  for (const i of order) {
    const g = groups[i]
    if (!g) continue
    const paths = g.files.flatMap((f) => (renames.has(f) ? [f, renames.get(f) as string] : [f]))
    try {
      await git(cwd, ['add', '-A', '--', ...paths])
      const message = ['-m', g.subject.trim(), ...(g.body?.trim() ? ['-m', g.body.trim()] : [])]
      await git(cwd, ['commit', '-q', ...message])
      made.push(`${(await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim()} ${g.subject.trim()}`)
    } catch (err) {
      throw new Error(prompts.commitSplit.stopped(made, err instanceof Error ? err.message : String(err)))
    }
  }
  return made
}
