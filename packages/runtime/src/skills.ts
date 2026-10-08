import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { SKILL_MAX_FILE_CHARS, SKILL_MAX_FILES } from './config.ts'
import { prompts } from './prompts.ts'

/**
 * Skills in the Agent Skills format (agentskills.io), as Claude Code, Codex and others use them: a folder with a
 * SKILL.md (front matter `name` and `description`, then instructions) and optional scripts/, references/ and
 * assets/. Agents see only each skill's name and description until they use one (use_skill), then its
 * instructions, then a bundled file only when they ask for it.
 */

export type SkillSource = 'myrmidon' | 'claude' | 'plugin' | 'project'

export interface Skill {
  readonly name: string
  readonly description: string
  /** Absolute, symlink-resolved folder. */
  readonly dir: string
  readonly source: SkillSource
  readonly enabled: boolean
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/
/** Marks a skill Myrmidon learned itself (in its front matter), as opposed to one the person wrote. */
const LEARNED = /^source:\s*learned\s*$/m

/** Parses a SKILL.md's front matter and body; undefined unless it names and describes the skill. */
export function parseSkillFile(
  text: string,
): { name: string; description: string; body: string } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return undefined
  let meta: unknown
  try {
    meta = Bun.YAML.parse(m[1] ?? '')
  } catch {
    // Skills written for other harnesses often hold an unquoted colon in their description, which strict YAML
    // rejects but those harnesses accept: fall back to reading the two keys line by line.
    meta = Object.fromEntries(
      (m[1] ?? '').split(/\r?\n/).flatMap((line) => {
        const kv = /^(name|description):\s*(.*)$/.exec(line)
        return kv ? [[kv[1], (kv[2] ?? '').replace(/^(["'])(.*)\1$/, '$2')]] : []
      }),
    )
  }
  const { name, description } = (meta ?? {}) as { name?: unknown; description?: unknown }
  if (typeof name !== 'string' || !NAME.test(name)) return undefined
  if (typeof description !== 'string' || !description.trim()) return undefined
  return { name, description: description.trim().slice(0, 1024), body: (m[2] ?? '').trim() }
}

export class SkillLibrary {
  private readonly _state: string
  readonly dir: string

  constructor(
    home: string,
    /** Where the person's Claude Code skills live; read in place, never written. */
    private readonly claudeDir = join(homedir(), '.claude', 'skills'),
    /** The skills folders of the person's enabled plugins. */
    private readonly pluginRoots: () => readonly string[] = () => [],
  ) {
    this.dir = join(home, 'skills')
    this._state = join(home, 'skills.json')
  }

  /** Every skill a chat can use: Myrmidon's own, the person's Claude Code skills, their plugins', and the project's. */
  list(project?: string): Skill[] {
    const disabled = new Set(this._disabled())
    const sources: [string, SkillSource][] = [
      [this.dir, 'myrmidon'],
      [this.claudeDir, 'claude'],
      ...this.pluginRoots().map((root): [string, SkillSource] => [root, 'plugin']),
      ...(project
        ? ([
            [join(project, '.myrmidon', 'skills'), 'project'],
            [join(project, '.claude', 'skills'), 'project'],
          ] as [string, SkillSource][])
        : []),
    ]
    const out = new Map<string, Skill>()
    for (const [root, source] of sources) {
      if (!existsSync(root)) continue
      for (const entry of readdirSync(root)) {
        const dir = join(root, entry)
        const file = join(dir, 'SKILL.md')
        if (!existsSync(file)) continue
        const parsed = parseSkillFile(readFileSync(file, 'utf8'))
        // The first source to name a skill wins: Myrmidon's own over the person's, theirs over a project's.
        if (!parsed || out.has(parsed.name)) continue
        out.set(parsed.name, {
          name: parsed.name,
          description: parsed.description,
          dir: realpathSync(dir),
          source,
          enabled: !disabled.has(parsed.name),
        })
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** A skill's instructions and the files it bundles, or one of those files (`file`, relative to the skill). */
  read(name: string, project?: string, file?: string): string {
    const skill = this.list(project).find((s) => s.name === name && s.enabled)
    if (!skill) throw new Error(`no skill called ${name}`)
    if (file) {
      const path = resolve(skill.dir, file)
      const real = existsSync(path) ? realpathSync(path) : path
      if (!real.startsWith(skill.dir + sep)) throw new Error(`${file} is outside the ${name} skill`)
      if (!existsSync(real) || !statSync(real).isFile())
        throw new Error(`the ${name} skill has no file ${file}`)
      const text = readFileSync(real, 'utf8')
      return text.length > SKILL_MAX_FILE_CHARS
        ? `${text.slice(0, SKILL_MAX_FILE_CHARS)}\n… (cut at ${SKILL_MAX_FILE_CHARS} chars)`
        : text
    }
    const parsed = parseSkillFile(readFileSync(join(skill.dir, 'SKILL.md'), 'utf8'))
    const files = bundled(skill.dir)
    return [
      `# Skill: ${name}`,
      prompts.toolResults.skillFolder(skill.dir),
      '',
      parsed?.body ?? '',
      files.length ? prompts.toolResults.skillFiles(files) : '',
    ].join('\n')
  }

  /**
   * Skills Myrmidon learned from finished work (`source: learned` in their front matter), with their instructions:
   * the only skills a reviewer may propose changes to.
   */
  learned(): { name: string; description: string; body: string }[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir).flatMap((entry) => {
      const file = join(this.dir, entry, 'SKILL.md')
      if (!existsSync(file)) return []
      const text = readFileSync(file, 'utf8')
      const parsed = parseSkillFile(text)
      return parsed && LEARNED.test(text.split(/\r?\n---/)[0] ?? '') ? [parsed] : []
    })
  }

  /** Saves a learned skill the person kept, in Myrmidon's own skills folder (every chat sees it). */
  write(name: string, description: string, body: string) {
    if (!NAME.test(name)) throw new Error(`not a skill name: ${name}`)
    const dir = join(this.dir, name)
    mkdirSync(dir, { recursive: true })
    const front = `---\nname: ${name}\ndescription: ${JSON.stringify(description.replace(/\s+/g, ' ').trim())}\nsource: learned\n---\n\n`
    writeFileSync(join(dir, 'SKILL.md.tmp'), `${front}${body.trim()}\n`)
    renameSync(join(dir, 'SKILL.md.tmp'), join(dir, 'SKILL.md'))
  }

  setEnabled(name: string, enabled: boolean) {
    const disabled = new Set(this._disabled())
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    writeFileSync(`${this._state}.tmp`, `${JSON.stringify({ disabled: [...disabled].sort() }, null, 2)}\n`)
    renameSync(`${this._state}.tmp`, this._state)
  }

  private _disabled(): string[] {
    try {
      const raw = JSON.parse(readFileSync(this._state, 'utf8')) as { disabled?: unknown }
      return Array.isArray(raw.disabled) ? raw.disabled.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
}

/** The files a skill bundles besides SKILL.md, relative to its folder. */
function bundled(dir: string): string[] {
  const out: string[] = []
  const walk = (at: string, depth: number) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (out.length >= SKILL_MAX_FILES || e.name.startsWith('.')) continue
      const path = join(at, e.name)
      if (e.isDirectory() && depth < 3) walk(path, depth + 1)
      else if (e.isFile() && !(depth === 0 && e.name === 'SKILL.md')) out.push(relative(dir, path))
    }
  }
  walk(dir, 0)
  return out.sort()
}
