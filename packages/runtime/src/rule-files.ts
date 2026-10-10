import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { RULE_FILE_MAX_BYTES, RULES_MAX_FILES } from './config.ts'
import { parseFrontmatter } from './omp/utils.ts'

/**
 * Project rules written for other coding tools (Cursor, Windsurf, Cline, GitHub Copilot, Continue, Claude Code, omp),
 * read the way omp 18.8.7 reads them (pi-coding-agent src/discovery/{cursor,windsurf,cline,github,agents,builtin}.ts
 * and src/discovery/helpers.ts `buildRule`), so a project set up for any of them works here unchanged. Its loaders are
 * async, glob through native code and pull in the whole discovery registry (about a second to import), so the few
 * rules that decide what a file means are ported here instead; the frontmatter parser is omp's own.
 *
 * A rule applies in one of three ways, after Cursor's rule types and omp's rule buckets:
 * - `always`: its text joins the project's instructions in every agent's prompt.
 * - `glob`: it comes with a file whose path matches one of its globs, when an agent reads or edits that file.
 * - `requested`: listed by name and description; the agent reads it when its task fits.
 * A rule that says none of these (Cursor's "manual" rules) is left out, as omp leaves it out. One with a stream
 * trigger (`condition`…) never joins the prompt: it watches what agents write (stream-rules.ts).
 */

export type RuleMode = 'always' | 'glob' | 'requested'

export interface ProjectRule {
  /** The file's name without its rule extension, as omp names rules; unique in a project. */
  readonly name: string
  /** Relative to the project, with forward slashes on every platform. */
  readonly file: string
  readonly mode: RuleMode
  /** The paths it is for (`glob` rules), relative to the project. */
  readonly globs?: readonly string[]
  readonly description?: string
  /** The body, frontmatter taken off. */
  readonly text: string
}

/** What a rule file with no frontmatter saying when it applies becomes: its tool's own default. */
type Plain = 'always' | 'skip'

interface RuleSource {
  /** omp's provider priority: of two rules with the same name, the higher one wins (capability/index.ts). */
  readonly priority: number
  readonly plain: Plain
  /** A folder of rule files and the extensions read there, or a single file. */
  readonly dir?: string
  readonly file?: string
  readonly extensions?: readonly string[]
  /** Into sub-folders too (GitHub's "within or below .github/instructions"). */
  readonly recursive?: boolean
  /** The name a single-file source's rule goes by. */
  readonly name?: string
  /** Its own reading of the frontmatter, in place of the shared one. */
  readonly read?: (fm: Frontmatter) => Classified
}

type Frontmatter = Record<string, unknown>
type Classified = { mode: RuleMode | 'skip'; globs?: string[]; description?: string }

/**
 * In omp's priority order, so a tie keeps the first. Cursor's and Windsurf's legacy single files, `.continue/rules`
 * and `.claude/rules` are not in omp 18.8.7's loaders (its docs name the two legacy files but its code reads neither);
 * they are read here by their own tools' rules.
 */
const SOURCES: readonly RuleSource[] = [
  // Myrmidon's own project rules, of any kind; `/rule` saves the project's stream rules here (stream-rules.ts).
  { dir: '.myrmidon/rules', extensions: ['md', 'mdc'], priority: 110, plain: 'skip' },
  // omp's sticky RULES.md: always applied, whatever its frontmatter says (builtin.ts loadStickyRulesFile).
  {
    file: '.omp/RULES.md',
    name: 'RULES@project',
    priority: 100,
    plain: 'always',
    read: () => ({ mode: 'always' }),
  },
  { dir: '.omp/rules', extensions: ['md', 'mdc'], priority: 100, plain: 'skip' },
  // Claude Code's path-scoped rules: `paths` frontmatter, and a rule without it is always loaded.
  { dir: '.claude/rules', extensions: ['md'], priority: 80, plain: 'always' },
  { dir: '.agent/rules', extensions: ['md', 'mdc'], priority: 70, plain: 'skip' },
  { dir: '.agents/rules', extensions: ['md', 'mdc'], priority: 70, plain: 'skip' },
  { dir: '.cursor/rules', extensions: ['mdc', 'md'], priority: 50, plain: 'skip' },
  { file: '.cursorrules', name: 'cursorrules', priority: 50, plain: 'always' },
  // Windsurf writes `trigger:` (always_on, glob, model_decision, manual); a plain file is taken as always on.
  { dir: '.windsurf/rules', extensions: ['md'], priority: 50, plain: 'always' },
  { file: '.windsurfrules', name: 'windsurfrules', priority: 50, plain: 'always' },
  // Continue applies a rule without `alwaysApply` or globs to everything.
  { dir: '.continue/rules', extensions: ['md'], priority: 45, plain: 'always' },
  // Cline reads every file in .clinerules (or the one file) on every task.
  { file: '.clinerules', name: 'clinerules', priority: 40, plain: 'always' },
  { dir: '.clinerules', extensions: ['md'], priority: 40, plain: 'always' },
  {
    dir: '.github/instructions',
    extensions: ['instructions.md'],
    recursive: true,
    priority: 30,
    plain: 'skip',
    read: copilot,
  },
]

/** Globs written as one comma-separated string (Cursor, GitHub's applyTo) or a list; commas inside {a,b} stay. */
export function splitGlobs(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    let depth = 0
    let current = ''
    for (const ch of item) {
      if (ch === '{') depth++
      if (ch === '}') depth = Math.max(0, depth - 1)
      if (ch === ',' && depth === 0) {
        out.push(current)
        current = ''
      } else current += ch
    }
    out.push(current)
  }
  // `./src/**` and `/src/**` both mean the project's src, as the tools treat a leading anchor.
  return [...new Set(out.map((g) => g.trim().replace(/^\.?\//, '')).filter(Boolean))]
}

/** omp's `buildRule` fields, with Windsurf's `trigger` and Claude Code's and Cline's `paths` read as theirs. */
function classify(fm: Frontmatter, plain: Plain): Classified {
  const description =
    typeof fm.description === 'string' && fm.description.trim() ? fm.description.trim() : undefined
  const globs = splitGlobs(fm.globs ?? fm.paths)
  const trigger = typeof fm.trigger === 'string' ? fm.trigger.trim().toLowerCase() : undefined
  if (fm.enabled === false || trigger === 'manual') return { mode: 'skip' }
  if (fm.alwaysApply === true || trigger === 'always_on') return { mode: 'always' }
  if (globs.length > 0) return { mode: 'glob', globs, ...(description ? { description } : {}) }
  if (description) return { mode: 'requested', description }
  // Cursor's `alwaysApply: false` with neither globs nor a description is a manual rule; so is Continue's.
  if (fm.alwaysApply === false || trigger === 'glob' || trigger === 'model_decision') return { mode: 'skip' }
  return { mode: plain }
}

/**
 * GitHub Copilot's `*.instructions.md` (omp github.ts `transformInstructionRule`): `applyTo` of `*`, `**` or `**\/*`
 * means every file, other globs scope it, and a file without one is listed with a description so it can be read.
 */
function copilot(fm: Frontmatter): Classified {
  if (fm.enabled === false) return { mode: 'skip' }
  const globs = splitGlobs(fm.applyTo)
  if (globs.some((g) => g === '*' || g === '**' || g === '**/*')) return { mode: 'always' }
  const own = typeof fm.description === 'string' && fm.description.trim() ? fm.description.trim() : undefined
  if (globs.length > 0)
    return { mode: 'glob', globs, description: own ?? `GitHub Copilot instructions for ${globs.join(', ')}` }
  return { mode: 'requested', description: own ?? 'GitHub Copilot instructions without applyTo metadata' }
}

const posix = (path: string) => path.split(sep).join('/')

/** A real file inside the project: a link that leads out of it is not read, as an @import outside it is not. */
function inside(base: string, path: string): string | undefined {
  try {
    const real = realpathSync.native(path)
    const stat = statSync(real)
    return real.startsWith(base + sep) && stat.isFile() && stat.size <= RULE_FILE_MAX_BYTES ? real : undefined
  } catch {
    return undefined
  }
}

function filesIn(base: string, source: RuleSource): string[] {
  if (source.file) {
    const path = join(base, ...source.file.split('/'))
    return existsSync(path) && statSync(path).isFile() ? [path] : []
  }
  const found: string[] = []
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // Hidden entries are skipped, as omp's glob skips them.
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue
      const path = join(dir, e.name)
      if (e.isDirectory() && source.recursive) walk(path)
      else if (e.isFile() && source.extensions?.some((x) => e.name.endsWith(`.${x}`))) found.push(path)
    }
  }
  walk(join(base, ...(source.dir as string).split('/')))
  return found
}

/** A rule file whose frontmatter makes it a stream rule (stream-rules.ts): it watches output, not the prompt. */
export interface StreamRuleFile {
  readonly name: string
  /** Absolute and symlink-resolved. */
  readonly path: string
  /** The whole file, frontmatter included: omp's parser reads its trigger and scope from it. */
  readonly source: string
}

/**
 * omp's rule buckets (capability/rule-buckets.ts) send a rule with a `condition`, `astCondition` or `question` (or
 * the legacy `ttsr_trigger`) to its stream-rule manager and never into the prompt, whatever else it says.
 */
function streamTrigger(fm: Frontmatter): boolean {
  return ['condition', 'ttsr_trigger', 'ttsrTrigger', 'astCondition', 'question'].some((key) => {
    const value = fm[key]
    return Array.isArray(value)
      ? value.some((v) => typeof v === 'string' && v.trim())
      : typeof value === 'string' && value.trim() !== ''
  })
}

function scan(root: string): { rules: ProjectRule[]; stream: StreamRuleFile[] } {
  const base = realpathSync.native(root)
  const rules: ProjectRule[] = []
  const stream: StreamRuleFile[] = []
  const names = new Set<string>()
  let read = 0
  for (const source of [...SOURCES].sort((a, b) => b.priority - a.priority)) {
    for (const path of filesIn(base, source)) {
      if (read >= RULES_MAX_FILES) return { rules, stream }
      const real = inside(base, path)
      if (!real) continue
      read++
      const raw = readFileSync(real, 'utf8')
      const { frontmatter, body } = parseFrontmatter(raw, { source: real, level: 'off' })
      const ext = source.extensions?.find((x) => path.endsWith(`.${x}`))
      const name = source.name ?? (ext ? basename(path).slice(0, -(ext.length + 1)) : basename(path))
      const text = body.trim()
      // A switched-off or empty file is not loaded at all; a manual rule is, and its name shadows a lower tool's.
      if (!text || frontmatter.enabled === false || names.has(name)) continue
      names.add(name)
      if (!source.read && streamTrigger(frontmatter)) {
        stream.push({ name, path: real, source: raw })
        continue
      }
      const kind = source.read ? source.read(frontmatter) : classify(frontmatter, source.plain)
      if (kind.mode === 'skip') continue
      rules.push({
        name,
        file: posix(relative(base, path)),
        mode: kind.mode,
        ...(kind.globs ? { globs: kind.globs } : {}),
        ...(kind.description ? { description: kind.description } : {}),
        text,
      })
    }
  }
  return { rules, stream }
}

/**
 * Every rule a project's tools define, at most `RULES_MAX_FILES` files, in omp's priority order. Rules are named by
 * their file, and of two with one name the higher-priority tool's wins (omp's `ruleCapability.key`), so a rule copied
 * into several tools' folders is read once. Stream rules are not among them: see `readProjectStreamRules`.
 */
export function readProjectRules(root: string): ProjectRule[] {
  return scan(root).rules
}

/** The project's stream rules, in any tool's rule folder, named and ranked as `readProjectRules` names its rules. */
export function readProjectStreamRules(root: string): StreamRuleFile[] {
  return scan(root).stream
}

/**
 * Whether a project-relative path (forward slashes) is one a `glob` rule is for. A glob without a slash also matches
 * the file's name in any folder (`*.ts`), the way Cursor and .gitignore read a bare pattern.
 */
export function ruleMatches(rule: ProjectRule, path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return (rule.globs ?? []).some((g) => {
    const glob = new Bun.Glob(g)
    return glob.match(path) || (!g.includes('/') && glob.match(name))
  })
}

/**
 * The paragraphs of a text, outside fenced code (omp system-prompt.ts `splitComparablePromptBlocks`): a rule that
 * shows up only inside an example is an example, not a repeat.
 */
function blocks(text: string): string[] {
  const out: string[] = []
  let current: string[] = []
  let fenced = false
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      current.push(line)
      continue
    }
    if (!fenced && line.trim() === '' && current.length > 0 && current.at(-1)?.trim() !== '') {
      const block = current.join('\n').trim()
      if (block) out.push(block)
      current = []
      continue
    }
    current.push(line)
  }
  const tail = current.join('\n').trim()
  if (tail) out.push(tail)
  return out
}

/**
 * Whether `text` says nothing `already` does not (omp's `promptBlocksContain`): all its paragraphs appear there in
 * one run. A CLAUDE.md or .cursorrules copied from AGENTS.md then adds no second copy to the prompt.
 */
export function containedIn(already: string, text: string): boolean {
  const have = blocks(already)
  const want = blocks(text)
  if (want.length === 0 || want.length > have.length) return false
  for (let start = 0; start <= have.length - want.length; start++)
    if (want.every((b, i) => have[start + i] === b)) return true
  return false
}
