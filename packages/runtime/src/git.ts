/**
 * Read-only views of a project's own git repository for the workspace's Git tab: branch and status, working
 * changes, history, and one commit's diff. Nothing here changes the repository.
 */

export interface ChangedFile {
  readonly path: string
  /** git's status letter: A added, M modified, D deleted, R renamed, ? untracked. */
  readonly status: string
  /** Undefined for binary (and untracked) files. */
  readonly added?: number
  readonly removed?: number
}

export interface Changes {
  readonly files: ChangedFile[]
  readonly patch: string
  /** The patch was cut at MAX_PATCH. */
  readonly truncated: boolean
}

export interface GitStatus {
  readonly repo: true
  readonly branch?: string
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
  /** Staged (`index`) and unstaged (`worktree`) state per file, as porcelain v2 letters ('.' for unchanged). */
  readonly files: { path: string; index: string; worktree: string }[]
  readonly log: { hash: string; short: string; subject: string; author: string; date: string }[]
}

export const MAX_PATCH = 512 * 1024

/** Runs git in `cwd` and returns stdout; throws with git's message on failure. */
export async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim() || `exit ${code}`}`)
  return out
}

/** Files from `git diff --numstat -M` and `--name-status -M` output for the same range. */
export function changedFiles(numstat: string, nameStatus: string): ChangedFile[] {
  const statuses = new Map(
    nameStatus
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [status = '', ...paths] = l.split('\t')
        return [paths.at(-1) ?? '', status.slice(0, 1)] as const
      }),
  )
  return numstat
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
}

export function capPatch(patch: string): { patch: string; truncated: boolean } {
  return patch.length > MAX_PATCH
    ? { patch: patch.slice(0, MAX_PATCH), truncated: true }
    : { patch, truncated: false }
}

/** Branch, upstream, file status and recent history; `{ repo: false }` when the folder is not in a git repo. */
export async function gitStatus(path: string, limit = 50): Promise<GitStatus | { repo: false }> {
  try {
    await git(path, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return { repo: false }
  }
  const porcelain = await git(path, ['status', '--porcelain=v2', '--branch', '--untracked-files=all'])
  let branch: string | undefined
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  const files: GitStatus['files'] = []
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('# branch.head '))
      branch = line.slice(14) === '(detached)' ? undefined : line.slice(14)
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18)
    else if (line.startsWith('# branch.ab ')) {
      const [a = '+0', b = '-0'] = line.slice(12).split(' ')
      ahead = Number(a.slice(1))
      behind = Number(b.slice(1))
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ')
      const xy = parts[1] ?? '..'
      // Ordinary entries end with the path; renames ("2") end with "path\toriginal".
      const tail = parts.slice(line.startsWith('1 ') ? 8 : 9).join(' ')
      files.push({ path: tail.split('\t')[0] ?? tail, index: xy[0] ?? '.', worktree: xy[1] ?? '.' })
    } else if (line.startsWith('? ')) files.push({ path: line.slice(2), index: '?', worktree: '?' })
  }
  let log: GitStatus['log'] = []
  try {
    log = (await git(path, ['log', `-n${limit}`, '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI']))
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash = '', short = '', subject = '', author = '', date = ''] = l.split('\x1f')
        return { hash, short, subject, author, date }
      })
  } catch {
    // A repository without commits has no log yet.
  }
  return {
    repo: true,
    ...(branch ? { branch } : {}),
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    files,
    log,
  }
}

/** Uncommitted changes (staged and unstaged) against HEAD, with untracked files listed. */
export async function gitWorkingChanges(path: string): Promise<Changes> {
  const base = (await git(path, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim()
  // Before the first commit, compare against git's empty tree.
  const against = base || (await git(path, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
  const files = changedFiles(
    await git(path, ['diff', '--numstat', '-M', against]),
    await git(path, ['diff', '--name-status', '-M', against]),
  )
  const untracked = (await git(path, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .filter(Boolean)
    .map((p): ChangedFile => ({ path: p, status: '?' }))
  return { files: [...files, ...untracked], ...capPatch(await git(path, ['diff', '-M', against])) }
}

/** One commit's message and diff against its first parent. */
export async function gitCommit(
  path: string,
  hash: string,
): Promise<Changes & { subject: string; body: string; author: string; date: string }> {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error('not a commit hash')
  const [subject = '', body = '', author = '', date = ''] = (
    await git(path, ['show', '-s', '--format=%s%x1f%b%x1f%an <%ae>%x1f%aI', hash])
  ).split('\x1f')
  return {
    subject,
    body: body.trim(),
    author,
    date: date.trim(),
    files: changedFiles(
      await git(path, ['show', '--numstat', '-M', '--format=', hash]),
      await git(path, ['show', '--name-status', '-M', '--format=', hash]),
    ),
    ...capPatch(await git(path, ['show', '-M', '--format=', hash])),
  }
}
