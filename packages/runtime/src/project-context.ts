import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ProjectInstructions, readProjectInstructions } from './instructions.ts'
import { SKIP_DIRS } from './workspace.ts'

/**
 * What an agent should know about a project before touching it: the project's own agent instructions, the commands
 * that check its work (typecheck, lint, test, build), and an outline of its folders. Read once when a round starts.
 */

export interface ProjectCheck {
  /** What the command checks, e.g. `typecheck`, `lint`, `test`. */
  readonly name: string
  readonly command: string
}

export interface ProjectContext {
  readonly instructions?: ProjectInstructions
  readonly checks: ProjectCheck[]
  /** Top-level folders and files, two levels deep, with file counts. */
  readonly layout: string
  /** The project's git state when the round started; absent outside a repository. */
  readonly git?: ProjectGit
}

export interface ProjectGit {
  /** Absent on a detached HEAD. */
  readonly branch?: string
  /** Files with uncommitted changes, untracked ones included. */
  readonly changed: number
  /** The latest commit subjects, newest first, at most three. */
  readonly recent: readonly string[]
}

const SCRIPT_CHECKS = ['check', 'typecheck', 'lint', 'test', 'build'] as const

function packageRunner(root: string): string {
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun run'
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm run'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  return 'npm run'
}

/** The project's own check commands, from its manifests: package.json scripts, Cargo, Go, Python, Make. */
export function projectChecks(root: string): ProjectCheck[] {
  const checks: ProjectCheck[] = []
  const read = (name: string) => {
    try {
      return readFileSync(join(root, name), 'utf8')
    } catch {
      return undefined
    }
  }
  const pkg = read('package.json')
  if (pkg) {
    try {
      const scripts = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts ?? {}
      const runner = packageRunner(root)
      for (const name of SCRIPT_CHECKS)
        if (typeof scripts[name] === 'string') checks.push({ name, command: `${runner} ${name}` })
    } catch {
      // A package.json that does not parse has no usable scripts.
    }
  }
  if (read('Cargo.toml') !== undefined)
    checks.push({ name: 'typecheck', command: 'cargo check' }, { name: 'test', command: 'cargo test' })
  if (read('go.mod') !== undefined)
    checks.push({ name: 'lint', command: 'go vet ./...' }, { name: 'test', command: 'go test ./...' })
  const py = read('pyproject.toml')
  if (py !== undefined) {
    if (py.includes('[tool.ruff')) checks.push({ name: 'lint', command: 'ruff check .' })
    if (py.includes('[tool.mypy')) checks.push({ name: 'typecheck', command: 'mypy .' })
    if (py.includes('pytest') || existsSync(join(root, 'tests')))
      checks.push({ name: 'test', command: 'python -m pytest -q' })
  }
  const make = read('Makefile')
  if (make && /^test:/m.test(make) && !checks.some((c) => c.name === 'test'))
    checks.push({ name: 'test', command: 'make test' })
  return checks
}

/**
 * The checks of an agent's scratch folder, for run_checks outside a project: those its manifests define, as a
 * project's are found, and for a TypeScript folder with no check or typecheck script, the compiler itself.
 */
export function scratchChecks(dir: string): ProjectCheck[] {
  const checks = projectChecks(dir)
  if (
    existsSync(join(dir, 'tsconfig.json')) &&
    !checks.some((c) => c.name === 'check' || c.name === 'typecheck')
  )
    checks.push({
      name: 'typecheck',
      command: `${Bun.which('bun') ? 'bunx' : 'npx --yes'} --package typescript tsc --noEmit`,
    })
  return checks
}

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`

/** Folders two levels deep with how many files each holds, then top-level files; at most 40 lines. */
export function projectLayout(root: string): string {
  const visible = (name: string) => !name.startsWith('.') && !SKIP_DIRS.has(name)
  const count = (dir: string, depth = 0): number => {
    let n = 0
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!visible(e.name)) continue
        if (e.isFile()) n += 1
        else if (e.isDirectory() && depth < 6) n += count(join(dir, e.name), depth + 1)
      }
    } catch {
      // An unreadable folder counts as empty.
    }
    return n
  }
  const lines: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => visible(e.name))
  } catch {
    return ''
  }
  const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
  for (const d of dirs) {
    lines.push(`${d.name}/ (${files(count(join(root, d.name)))})`)
    const subs = readdirSync(join(root, d.name), { withFileTypes: true })
      .filter((e) => e.isDirectory() && visible(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const s of subs.slice(0, 8))
      lines.push(`  ${d.name}/${s.name}/ (${files(count(join(root, d.name, s.name)))})`)
    if (subs.length > 8) lines.push(`  … ${subs.length - 8} more folders`)
  }
  const top = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort()
  if (top.length)
    lines.push(top.slice(0, 20).join(', ') + (top.length > 20 ? `, … ${top.length - 20} more` : ''))
  return lines.slice(0, 40).join('\n')
}

/**
 * The project's branch, how many files have uncommitted changes and the last three commit subjects, read once when the
 * round starts, after Codex's environment context and Claude Code's git status snapshot. A few milliseconds of git;
 * nothing when the folder is not a repository or git is missing.
 */
export function projectGit(root: string): ProjectGit | undefined {
  const git = (...args: string[]) => {
    try {
      const r = Bun.spawnSync(['git', ...args], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      })
      return r.exitCode === 0 ? r.stdout.toString() : undefined
    } catch {
      return undefined
    }
  }
  if (git('rev-parse', '--is-inside-work-tree')?.trim() !== 'true') return undefined
  const branch = git('branch', '--show-current')?.trim()
  const changed = (git('status', '--porcelain') ?? '').split('\n').filter(Boolean).length
  // A repository without commits has no log yet.
  const recent = (git('log', '-n3', '--pretty=format:%s') ?? '').split('\n').filter(Boolean)
  return { ...(branch ? { branch } : {}), changed, recent }
}

export function readProjectContext(root: string): ProjectContext {
  const instructions = readProjectInstructions(root)
  const git = projectGit(root)
  return {
    ...(instructions ? { instructions } : {}),
    checks: projectChecks(root),
    layout: projectLayout(root),
    ...(git ? { git } : {}),
  }
}
