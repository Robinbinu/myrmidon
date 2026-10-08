import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import {
  SKILL_ARCHIVE_DAYS,
  SKILL_CURATE_EVERY_MS,
  SKILL_MAX_FILE_CHARS,
  SKILL_MAX_FILES,
  SKILL_STALE_DAYS,
} from './config.ts'
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
  /** For a skill Myrmidon learned: how much it is used, and whether it is on its way out. */
  readonly curation?: SkillCuration
}

/** How a learned skill is used, after Hermes's curator: unused ones go stale, then to the archive. */
export interface SkillCuration {
  readonly uses: number
  readonly lastUsed?: string
  /** Unused for SKILL_STALE_DAYS: still offered, archived at SKILL_ARCHIVE_DAYS unless used or kept. */
  readonly stale: boolean
  /** The person keeps it whatever its use. */
  readonly kept: boolean
}

/** What is remembered about each learned skill's use (`skills-usage.json`). */
interface Usage {
  uses: number
  lastUsed?: string
  /** When its clock last started without a use: written or restored. */
  since?: string
  kept?: boolean
}

const DAY_MS = 24 * 60 * 60_000

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
    this._usageFile = join(home, 'skills-usage.json')
    this._archive = join(this.dir, '.archive')
  }

  private readonly _usageFile: string
  private readonly _archive: string
  /** The curation thresholds, for the person to see. */
  readonly retire = { staleDays: SKILL_STALE_DAYS, archiveDays: SKILL_ARCHIVE_DAYS }

  /** Every skill a chat can use: Myrmidon's own, the person's Claude Code skills, their plugins', and the project's. */
  list(project?: string, now = Date.now()): Skill[] {
    const disabled = new Set(this._disabled())
    const usage = this._usage()
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
        const text = readFileSync(file, 'utf8')
        const parsed = parseSkillFile(text)
        // The first source to name a skill wins: Myrmidon's own over the person's, theirs over a project's.
        if (!parsed || out.has(parsed.name)) continue
        const learned = source === 'myrmidon' && isLearned(text)
        out.set(parsed.name, {
          name: parsed.name,
          description: parsed.description,
          dir: realpathSync(dir),
          source,
          enabled: !disabled.has(parsed.name),
          ...(learned ? { curation: this._curation(parsed.name, usage, file, now) } : {}),
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
      return parsed && isLearned(text) ? [parsed] : []
    })
  }

  /** Saves a learned skill the person kept, in Myrmidon's own skills folder (every chat sees it). */
  write(name: string, description: string, body: string, now = Date.now()) {
    if (!NAME.test(name)) throw new Error(`not a skill name: ${name}`)
    const dir = join(this.dir, name)
    mkdirSync(dir, { recursive: true })
    const front = `---\nname: ${name}\ndescription: ${JSON.stringify(description.replace(/\s+/g, ' ').trim())}\nsource: learned\n---\n\n`
    writeFileSync(join(dir, 'SKILL.md.tmp'), `${front}${body.trim()}\n`)
    renameSync(join(dir, 'SKILL.md.tmp'), join(dir, 'SKILL.md'))
    this._updateUsage(name, (u) => {
      u.since = new Date(now).toISOString()
    })
  }

  /** An agent loaded a skill's instructions: counted, and its clock starts again. */
  noteUse(name: string, now = Date.now()) {
    this._updateUsage(name, (u) => {
      u.uses += 1
      u.lastUsed = new Date(now).toISOString()
    })
  }

  /** Keeps a learned skill whatever its use, or lets it be retired again. */
  setKept(name: string, kept: boolean) {
    this._updateUsage(name, (u) => {
      if (kept) u.kept = true
      else delete u.kept
    })
  }

  /** Moves learned skills unused for SKILL_ARCHIVE_DAYS (and not kept) to the archive; returns their names. */
  curate(now = Date.now()): string[] {
    const out: string[] = []
    for (const skill of this.list(undefined, now)) {
      const c = skill.curation
      if (!c || c.kept || skill.source !== 'myrmidon') continue
      if (
        now - this._idleSince(skill.name, this._usage(), join(skill.dir, 'SKILL.md')) <
        SKILL_ARCHIVE_DAYS * DAY_MS
      )
        continue
      mkdirSync(this._archive, { recursive: true })
      const target = join(this._archive, skill.name)
      rmSync(target, { recursive: true, force: true })
      renameSync(join(this.dir, skill.name), target)
      out.push(skill.name)
    }
    return out
  }

  /** Curates now and every SKILL_CURATE_EVERY_MS while the server runs; returns how to stop. */
  curateEvery(report: (archived: string[], error?: unknown) => void): () => void {
    const run = () => {
      try {
        const archived = this.curate()
        if (archived.length) report(archived)
      } catch (err) {
        report([], err)
      }
    }
    run()
    const timer = setInterval(run, SKILL_CURATE_EVERY_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  /** Learned skills moved to the archive, to restore from Settings. */
  archived(): { name: string; description: string }[] {
    if (!existsSync(this._archive)) return []
    return readdirSync(this._archive)
      .flatMap((entry) => {
        const file = join(this._archive, entry, 'SKILL.md')
        const parsed = existsSync(file) ? parseSkillFile(readFileSync(file, 'utf8')) : undefined
        return parsed ? [{ name: parsed.name, description: parsed.description }] : []
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Brings an archived skill back, with a fresh clock so it is not archived again at once. */
  restore(name: string, now = Date.now()) {
    const from = join(this._archive, name)
    if (!NAME.test(name) || !existsSync(join(from, 'SKILL.md')))
      throw new Error(`no archived skill called ${name}`)
    const to = join(this.dir, name)
    if (existsSync(to)) throw new Error(`a skill called ${name} already exists`)
    renameSync(from, to)
    this._updateUsage(name, (u) => {
      u.since = new Date(now).toISOString()
    })
  }

  private _curation(name: string, usage: Record<string, Usage>, file: string, now: number): SkillCuration {
    const u = usage[name]
    const kept = u?.kept === true
    return {
      uses: u?.uses ?? 0,
      ...(u?.lastUsed ? { lastUsed: u.lastUsed } : {}),
      stale: !kept && now - this._idleSince(name, usage, file) >= SKILL_STALE_DAYS * DAY_MS,
      kept,
    }
  }

  /** When a learned skill was last used or given a fresh start; a skill with no record counts from its file's age. */
  private _idleSince(name: string, usage: Record<string, Usage>, file: string): number {
    const u = usage[name]
    const times = [u?.lastUsed, u?.since].filter((t): t is string => !!t).map((t) => Date.parse(t))
    return times.length ? Math.max(...times) : statSync(file).mtimeMs
  }

  private _usage(): Record<string, Usage> {
    try {
      const raw = JSON.parse(readFileSync(this._usageFile, 'utf8')) as unknown
      return raw && typeof raw === 'object' ? (raw as Record<string, Usage>) : {}
    } catch {
      return {}
    }
  }

  private _updateUsage(name: string, change: (u: Usage) => void) {
    const all = this._usage()
    const u = all[name] ?? { uses: 0 }
    change(u)
    all[name] = u
    writeFileSync(`${this._usageFile}.tmp`, `${JSON.stringify(all, null, 2)}\n`)
    renameSync(`${this._usageFile}.tmp`, this._usageFile)
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

/** Whether a SKILL.md marks a skill Myrmidon learned (`source: learned` in its front matter). */
function isLearned(text: string): boolean {
  return LEARNED.test(text.split(/\r?\n---/)[0] ?? '')
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
