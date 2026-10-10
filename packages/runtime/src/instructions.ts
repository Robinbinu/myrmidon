import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { INSTRUCTIONS_MAX_DIRS, INSTRUCTIONS_MAX_TEXT, MAX_IMPORT_DEPTH } from './config.ts'
import { containedIn, type ProjectRule, readProjectRules } from './rule-files.ts'
import { SKIP_DIRS } from './workspace.ts'

/**
 * A project's own instructions for coding agents, read the way Codex and Claude Code read them: AGENTS.md (the
 * cross-tool standard), CLAUDE.md, and Myrmidon's .myrmidon.md at the project root, with `@path` import lines
 * expanded, and the context files other tools keep (omp's context-file providers, project scope). Nested AGENTS.md /
 * CLAUDE.md files deeper in the tree are listed so agents read the nearest one before working there. Other tools'
 * rule files (rule-files.ts) join the text when they always apply, and are kept apart when they apply only sometimes.
 */

export interface ProjectInstructions {
  /** Files whose text was read into `text` (context files, then always-apply rules), relative to the project. */
  readonly files: string[]
  readonly text: string
  /** Instruction files in sub-folders, relative to the project. */
  readonly nested: string[]
  readonly truncated: boolean
  /** Rules that apply to some files or tasks only: listed for the agent, and shown with a file they match. */
  readonly rules: ProjectRule[]
}

/**
 * Myrmidon's own file last, so it reads as the most specific. Between them, the files omp reads as project context
 * (Gemini CLI's, Claude Code's, Copilot's, the .agents convention's and omp's own), forward-slashed on every platform.
 */
const ROOT_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.claude/CLAUDE.md',
  '.gemini/GEMINI.md',
  '.github/copilot-instructions.md',
  '.agent/AGENTS.md',
  '.agents/AGENTS.md',
  '.omp/AGENTS.md',
  '.myrmidon.md',
]
const NESTED_NAMES = new Set(['AGENTS.md', 'CLAUDE.md'])

export function readProjectInstructions(root: string): ProjectInstructions | undefined {
  const base = realpathSync(root)
  const seen = new Set<string>()
  const files: string[] = []

  // Expands lines that are only an `@path` import (Claude Code's syntax), within the project and a few hops deep.
  const expand = (file: string, depth: number): string => {
    const real = realpathSync(file)
    if (seen.has(real)) return ''
    seen.add(real)
    return readFileSync(real, 'utf8')
      .split('\n')
      .map((line) => {
        const m = /^\s*@(\S+)\s*$/.exec(line)
        if (!m || depth >= MAX_IMPORT_DEPTH) return line
        const target = resolve(dirname(real), (m[1] ?? '').replace(/^~\//, ''))
        if (!target.startsWith(base + sep) || !existsSync(target) || !statSync(target).isFile()) return line
        return expand(target, depth + 1)
      })
      .join('\n')
  }

  const parts: string[] = []
  const bodies: string[] = []
  // A file that says nothing the ones before it did (the usual CLAUDE.md that only imports AGENTS.md, a copied
  // .cursorrules) adds nothing new, after omp's paragraph-containment pass.
  const add = (name: string, body: string) => {
    if (!body || bodies.some((b) => containedIn(b, body))) return
    files.push(name)
    bodies.push(body)
    parts.push(`----- ${name} -----\n${body}`)
  }
  for (const name of ROOT_FILES) {
    const file = join(base, ...name.split('/'))
    if (!existsSync(file) || !statSync(file).isFile()) continue
    // A config folder's file may be a link; like an import, it is read only if it stays in the project.
    if (name.includes('/') && !realpathSync(file).startsWith(base + sep)) continue
    add(name, expand(file, 0).trim())
  }
  const rules: ProjectRule[] = []
  for (const rule of readProjectRules(base)) {
    if (rule.mode === 'always') add(rule.file, rule.text)
    else rules.push(rule)
  }

  const nested: string[] = []
  const queue = [base]
  for (let visited = 0; queue.length > 0 && visited < INSTRUCTIONS_MAX_DIRS; visited++) {
    const dir = queue.shift() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push(join(dir, e.name))
      else if (e.isFile() && NESTED_NAMES.has(e.name) && dir !== base)
        nested.push(relative(base, join(dir, e.name)))
    }
  }

  if (parts.length === 0 && nested.length === 0 && rules.length === 0) return undefined
  const text = parts.join('\n\n')
  return {
    files,
    text:
      text.length > INSTRUCTIONS_MAX_TEXT ? `${text.slice(0, INSTRUCTIONS_MAX_TEXT)}\n…[cut at 24 KB]` : text,
    nested: nested.sort(),
    truncated: text.length > INSTRUCTIONS_MAX_TEXT,
    rules,
  }
}
