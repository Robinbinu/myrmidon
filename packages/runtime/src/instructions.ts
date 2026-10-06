import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { SKIP_DIRS } from './workspace.ts'

/**
 * A project's own instructions for coding agents, read the way Codex and Claude Code read them: AGENTS.md (the
 * cross-tool standard), CLAUDE.md, and Myrmidon's .myrmidon.md at the project root, with `@path` import lines
 * expanded. Nested AGENTS.md / CLAUDE.md files deeper in the tree are listed so agents read the nearest one before
 * working there.
 */

export interface ProjectInstructions {
  /** Root files that were read, relative to the project. */
  readonly files: string[]
  readonly text: string
  /** Instruction files in sub-folders, relative to the project. */
  readonly nested: string[]
  readonly truncated: boolean
}

const ROOT_FILES = ['AGENTS.md', 'CLAUDE.md', '.myrmidon.md']
const NESTED_NAMES = new Set(['AGENTS.md', 'CLAUDE.md'])
const MAX_TEXT = 24 * 1024
const MAX_IMPORT_DEPTH = 4
const MAX_DIRS = 3000

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
  for (const name of ROOT_FILES) {
    const file = join(base, name)
    if (!existsSync(file) || !statSync(file).isFile()) continue
    const body = expand(file, 0).trim()
    // A CLAUDE.md that only imports AGENTS.md (the usual bridge) adds nothing new.
    if (!body) continue
    files.push(name)
    parts.push(`----- ${name} -----\n${body}`)
  }

  const nested: string[] = []
  const queue = [base]
  for (let visited = 0; queue.length > 0 && visited < MAX_DIRS; visited++) {
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

  if (parts.length === 0 && nested.length === 0) return undefined
  const text = parts.join('\n\n')
  return {
    files,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…[cut at 24 KB]` : text,
    nested: nested.sort(),
    truncated: text.length > MAX_TEXT,
  }
}
