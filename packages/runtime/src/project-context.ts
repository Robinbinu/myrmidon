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

export function readProjectContext(root: string): ProjectContext {
  const instructions = readProjectInstructions(root)
  return {
    ...(instructions ? { instructions } : {}),
    checks: projectChecks(root),
    layout: projectLayout(root),
  }
}
