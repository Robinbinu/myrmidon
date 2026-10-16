import { join } from 'node:path'
import { CODE_REVIEW } from './config.ts'
import { git } from './git.ts'

/**
 * What a /review round reviews and how its reviewers split it, after omp's /review (its review-request prompt and
 * reviewer agent): the changes of a branch, a commit, a range or the uncommitted work, as files with their +/- lines,
 * grouped by locality (one folder, tests beside their code) into at most CODE_REVIEW.maxReviewers groups, one per
 * reviewer working in parallel. Nothing here changes the repository.
 */

export interface ReviewFile {
  readonly path: string
  readonly added: number
  readonly removed: number
}

export interface ReviewScope {
  /** What is reviewed, for the agents: "uncommitted changes", "branch feature against main", "commit abc123"… */
  readonly mode: string
  /** The read-only command that prints the patch reviewers read. */
  readonly diff: string
  readonly files: readonly ReviewFile[]
  /** Files to review together, one group per reviewer. */
  readonly groups: readonly (readonly ReviewFile[])[]
}

/** Notes the person pinned to lines of the diff before the review (omp's /annotate). */
export interface ReviewNote {
  readonly path: string
  readonly line: number
  readonly text: string
}

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return (await git(cwd, args)).trim()
  } catch {
    return undefined
  }
}

/** `git diff --numstat` output as files; a binary file counts 0/0. */
function numstat(text: string): ReviewFile[] {
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [a, r, ...rest] = line.split('\t')
      const path = renamedTo(rest.join('\t'))
      return path ? [{ path, added: Number(a) || 0, removed: Number(r) || 0 }] : []
    })
}

/** How many lines a new file has; 0 for one too big to read for a count, or binary. */
async function lineCount(path: string): Promise<number> {
  const file = Bun.file(path)
  if (file.size > CODE_REVIEW.countBytes) return 0
  const text = await file.text().catch(() => '')
  if (!text || text.includes('\0')) return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** A renamed file's new path as numstat writes it: `old => new`, or `dir/{a => b}/file`. */
function renamedTo(path: string): string {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path)
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, '/')
  return path.split(' => ').at(-1) ?? path
}

/** The branch the work is measured against: the remote's default, else main, master or develop if they exist. */
async function baseBranch(cwd: string): Promise<string | undefined> {
  const remote = await tryGit(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (remote) return remote
  for (const name of ['main', 'master', 'develop'])
    if (await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) return name
  return undefined
}

/**
 * What `target` names in the repository at `cwd`: nothing (the uncommitted work if there is any, else the branch
 * against its base), "uncommitted", a commit, a range `a..b`, a branch, or a pull request (`#12`, `pr 12`), whose
 * diff reviewers read with pr://N/diff. Anything else (file paths) narrows the default to those files.
 */
export async function reviewScope(cwd: string, target = ''): Promise<ReviewScope> {
  const t = target.trim()
  const pr = /^(?:#|pr\s*#?|pull request\s*#?)(\d+)$/i.exec(t)?.[1]
  if (pr) return withGroups({ mode: `pull request #${pr}`, diff: `fs_read pr://${pr}/diff`, files: [] })
  // A new file's lines all count as added, as its diff will show them.
  const untracked = async () =>
    Promise.all(
      ((await tryGit(cwd, ['ls-files', '--others', '--exclude-standard'])) ?? '')
        .split('\n')
        .filter(Boolean)
        .map(async (path) => ({ path, added: await lineCount(join(cwd, path)), removed: 0 })),
    )
  const uncommitted = async (): Promise<ReviewScope> => ({
    mode: 'uncommitted changes (staged, unstaged and untracked)',
    diff: 'git diff HEAD, and git status for untracked files',
    files: [
      ...numstat((await tryGit(cwd, ['diff', 'HEAD', '--numstat', '-M'])) ?? ''),
      ...(await untracked()),
    ],
    groups: [],
  })
  const range = async (from: string, to: string, mode: string): Promise<ReviewScope> => ({
    mode,
    diff: `git diff ${from}...${to}`,
    files: numstat((await tryGit(cwd, ['diff', `${from}...${to}`, '--numstat', '-M'])) ?? ''),
    groups: [],
  })
  if (/^(uncommitted|working tree|local|unstaged|staged)( changes| work)?$/i.test(t))
    return withGroups(await uncommitted())
  const dots = /^([^\s.]+)\.\.\.?([^\s.]+)$/.exec(t)
  if (dots?.[1] && dots[2]) return withGroups(await range(dots[1], dots[2], `range ${t}`))
  if (t && !/\s/.test(t) && (await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${t}`]))) {
    const base = (await baseBranch(cwd)) ?? 'HEAD'
    return withGroups(await range(base, t, `branch ${t} against ${base}`))
  }
  if (
    t &&
    /^[0-9a-f]{4,40}$/i.test(t) &&
    (await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${t}^{commit}`]))
  )
    return withGroups({
      mode: `commit ${t}`,
      diff: `git show ${t}`,
      files: numstat((await tryGit(cwd, ['show', '--numstat', '--format=', '-M', t])) ?? ''),
    })
  const local = await uncommitted()
  let scope: Omit<ReviewScope, 'groups'> = local
  if (!local.files.length) {
    const base = await baseBranch(cwd)
    const branch = await tryGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (base && branch && branch !== base)
      scope = await range(base, 'HEAD', `branch ${branch} against ${base}`)
  }
  // Paths narrow it to those files.
  const only = t ? t.split(/[\s,]+/).filter(Boolean) : []
  if (only.length)
    scope = {
      ...scope,
      files: scope.files.filter((f) =>
        only.some((o) => f.path === o || f.path.startsWith(`${o.replace(/\/$/, '')}/`)),
      ),
    }
  return withGroups(scope)
}

/** The scope with its files grouped, one group per reviewer. */
function withGroups(scope: Omit<ReviewScope, 'groups'>): ReviewScope {
  return { ...scope, groups: reviewGroups(scope.files) }
}

/**
 * Files grouped by locality for parallel reviewers, as omp's review request asks (same folder together; tests with
 * their code): one group per folder, merged smallest first until there are at most
 * min(CODE_REVIEW.maxReviewers, ceil(files / CODE_REVIEW.filesPerReviewer)).
 */
export function reviewGroups(files: readonly ReviewFile[]): ReviewFile[][] {
  if (!files.length) return []
  const want = Math.max(
    1,
    Math.min(CODE_REVIEW.maxReviewers, Math.ceil(files.length / CODE_REVIEW.filesPerReviewer)),
  )
  // A test belongs with the code it tests: tests/x.test.ts and src/x.ts share the stem "x".
  const stem = (p: string) => (p.split('/').pop() ?? p).replace(/(\.test|\.spec|_test)?\.[^.]+$/, '')
  const folder = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')
  const isTest = (p: string) => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.|_test\./.test(p)
  const byFolder = new Map<string, ReviewFile[]>()
  const homeOf = new Map<string, string>()
  for (const f of files) if (!isTest(f.path)) homeOf.set(stem(f.path), folder(f.path))
  for (const f of files) {
    // Only a test moves, to the folder of the code of its name; code stays in its own folder.
    const key = (isTest(f.path) ? homeOf.get(stem(f.path)) : undefined) ?? folder(f.path)
    byFolder.set(key, [...(byFolder.get(key) ?? []), f])
  }
  const groups = [...byFolder.values()]
  const size = (g: readonly ReviewFile[]) => g.reduce((n, f) => n + f.added + f.removed + 1, 0)
  while (groups.length > want) {
    groups.sort((a, b) => size(a) - size(b))
    const [a, b, ...rest] = groups
    groups.splice(0, groups.length, [...(a ?? []), ...(b ?? [])], ...rest)
  }
  return groups.sort((a, b) => size(b) - size(a))
}
