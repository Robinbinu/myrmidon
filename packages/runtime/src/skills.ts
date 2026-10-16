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
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  BUILTIN_SKILLS_DIR,
  SKILL_ARCHIVE_DAYS,
  SKILL_CURATE_EVERY_MS,
  SKILL_MAX_FILE_CHARS,
  SKILL_MAX_FILES,
  SKILL_STALE_DAYS,
} from './config.ts'
import type { InstalledFrom } from './install-sources.ts'
import { prompts } from './prompts.ts'
import { slashed } from './read-access.ts'
import { SkillInstaller } from './skill-installs.ts'
import type { SkillRegistryClient } from './skill-registry.ts'
import { type SkillScan, scanSkill } from './skill-scan.ts'

/**
 * Skills in the Agent Skills format (agentskills.io), as Claude Code, Codex and others use them: a folder with a
 * SKILL.md (front matter `name` and `description`, then instructions) and optional scripts/, references/ and
 * assets/. Agents see only each skill's name and description until they use one (use_skill), then its
 * instructions, then a bundled file only when they ask for it.
 */

/** `builtin`: one of the skills Myrmidon comes with (prompts.ts `builtinSkills`); the person's own of the same name wins. */
export type SkillSource = 'myrmidon' | 'claude' | 'plugin' | 'project' | 'builtin'

export interface Skill {
  readonly name: string
  readonly description: string
  /** Absolute, symlink-resolved folder. */
  readonly dir: string
  readonly source: SkillSource
  readonly enabled: boolean
  /** For a skill Myrmidon learned: how much it is used, and whether it is on its way out. */
  readonly curation?: SkillCuration
  /** For a skill installed from the registry, a repository or a folder: where from, and exactly what. */
  readonly installed?: InstalledFrom
  /** What the skill scanner found in its folder. */
  readonly scan: SkillScan
  /**
   * Its scan blocks it and the person has not allowed this content: agents are not offered it, whatever `enabled`
   * says, until they allow it (or it changes into something the scan passes).
   */
  readonly held: boolean
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

/** `<home>/skills.json`: skills the person switched off, and blocked skills they allowed, by the scan hash allowed. */
interface SkillState {
  disabled: string[]
  allowed: Record<string, string>
}

const stateFile = (home: string) => join(home, 'skills.json')

function readState(file: string): SkillState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { disabled?: unknown; allowed?: unknown }
    return {
      disabled: Array.isArray(raw.disabled)
        ? raw.disabled.filter((x): x is string => typeof x === 'string')
        : [],
      allowed:
        raw.allowed && typeof raw.allowed === 'object'
          ? Object.fromEntries(
              Object.entries(raw.allowed).filter((e): e is [string, string] => typeof e[1] === 'string'),
            )
          : {},
    }
  } catch {
    return { disabled: [], allowed: {} }
  }
}

function writeState(file: string, state: SkillState) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

/**
 * Records that the person allowed these skills as they are now (name to scan hash), so a blocked scan does not hold
 * them; an install the person confirmed despite its scan records its skills here.
 */
export function allowSkills(home: string, hashes: Readonly<Record<string, string>>) {
  if (!Object.keys(hashes).length) return
  const file = stateFile(home)
  const state = readState(file)
  writeState(file, { ...state, allowed: { ...state.allowed, ...hashes } })
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/
/** What a skill may be called: kebab-case, as omp's managed skills (learn, manage_skill check names against it). */
export const SKILL_NAME = NAME
/** Marks a skill Myrmidon learned itself (in its front matter), as opposed to one the person wrote. */
const LEARNED = /^source:\s*learned\s*$/m
/** Marks a skill Myrmidon wrote from the ones it comes with, so only those are ever replaced or removed. */
const BUILTIN = /^source:\s*builtin\s*$/m

/** The SKILL.md Myrmidon writes for one of the skills it comes with. */
function builtinSkillFile(name: string, skill: { description: string; body: string }): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(skill.description)}\nsource: builtin\n---\n\n${skill.body.trim()}\n`
}

/**
 * Writes the skills Myrmidon comes with into `dir` (`<home>/builtin-skills` by default), so the library reads them like
 * any other skill folder: a file is written only when its text changed, and a folder Myrmidon wrote for a skill it no
 * longer comes with is removed. Anything else in the folder is left alone. Returns the folder.
 */
export function writeBuiltinSkills(home: string, dir = join(home, BUILTIN_SKILLS_DIR)): string {
  mkdirSync(dir, { recursive: true })
  const skills = prompts.builtinSkills as Record<string, { description: string; body: string }>
  for (const [name, skill] of Object.entries(skills)) {
    const file = join(dir, name, 'SKILL.md')
    const text = builtinSkillFile(name, skill)
    if (existsSync(file) && readFileSync(file, 'utf8') === text) continue
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(`${file}.tmp`, text)
    renameSync(`${file}.tmp`, file)
  }
  for (const entry of readdirSync(dir)) {
    if (entry in skills) continue
    const file = join(dir, entry, 'SKILL.md')
    if (existsSync(file) && BUILTIN.test(readFileSync(file, 'utf8').split(/\r?\n---/)[0] ?? ''))
      rmSync(join(dir, entry), { recursive: true, force: true })
  }
  return dir
}

/** A SKILL.md's front matter (its top-level keys) and body; undefined when it has no front matter. */
function splitSkillFile(text: string): { meta: Record<string, unknown>; body: string } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return undefined
  let meta: unknown
  try {
    meta = Bun.YAML.parse(m[1] ?? '')
  } catch {
    // Skills written for other harnesses often hold an unquoted colon in their description, which strict YAML
    // rejects but those harnesses accept: fall back to reading the top-level keys line by line.
    meta = Object.fromEntries(
      (m[1] ?? '').split(/\r?\n/).flatMap((line) => {
        const kv = /^([\w-]+):\s*(.*)$/.exec(line)
        return kv ? [[kv[1], (kv[2] ?? '').replace(/^(["'])(.*)\1$/, '$2')]] : []
      }),
    )
  }
  return {
    meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {},
    body: (m[2] ?? '').trim(),
  }
}

/** Parses a SKILL.md's front matter and body; undefined unless it names and describes the skill. */
export function parseSkillFile(
  text: string,
): { name: string; description: string; body: string } | undefined {
  const split = splitSkillFile(text)
  if (!split) return undefined
  const { name, description } = split.meta
  if (typeof name !== 'string' || !NAME.test(name)) return undefined
  if (typeof description !== 'string' || !description.trim()) return undefined
  return { name, description: description.trim().slice(0, 1024), body: split.body }
}

/**
 * Reads a SKILL.md written for Claude Code, which lets a skill leave out its name (its folder's) and its description
 * (its first paragraph); undefined when neither gives a usable name and description. `meta` is every key it set.
 */
export function parseForeignSkill(
  text: string,
  folder: string,
): { name: string; description: string; meta: Record<string, unknown> } | undefined {
  const { meta, body } = splitSkillFile(text) ?? { meta: {}, body: text.trim() }
  const name = typeof meta.name === 'string' ? meta.name : folder
  if (!NAME.test(name)) return undefined
  const paragraph = body
    .split(/\r?\n\s*\r?\n/)
    .find((p) => p.trim() && !p.trim().startsWith('#'))
    ?.replace(/\s+/g, ' ')
    .trim()
  const description =
    typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim() : paragraph
  return description ? { name, description: description.slice(0, 1024), meta } : undefined
}

/**
 * The SKILL.md with its front matter naming the skill `name`, and describing it when it did not say: the rest is left
 * as written. Myrmidon reads a skill only when its front matter names and describes it.
 */
export function renameSkillFile(text: string, name: string, description: string): string {
  const described = `description: ${JSON.stringify(description.replace(/\s+/g, ' ').trim())}`
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)
  if (!m) return `---\nname: ${name}\n${described}\n---\n\n${text}`
  const lines = (m[1] ?? '').split(/\r?\n/).filter((l) => !/^name:/.test(l))
  if (!lines.some((l) => /^description:/.test(l))) lines.unshift(described)
  return `---\nname: ${name}\n${lines.join('\n')}\n---${m[2] ?? ''}${text.slice(m[0].length)}`
}

export class SkillLibrary {
  private readonly _state: string
  private readonly _home: string
  readonly dir: string

  constructor(
    home: string,
    /** Where the person's Claude Code skills live; read in place, never written. */
    private readonly claudeDir = join(homedir(), '.claude', 'skills'),
    /** The skills folders of the person's enabled plugins. */
    private readonly pluginRoots: () => readonly string[] = () => [],
    registry?: SkillRegistryClient,
    /** Where the skills Myrmidon comes with were written (`writeBuiltinSkills`); read last, so any other skill of the same name wins. */
    private readonly builtinDir?: string,
  ) {
    this.dir = join(home, 'skills')
    this.installs = new SkillInstaller(home, this.dir, registry)
    this._home = home
    this._state = stateFile(home)
    this._usageFile = join(home, 'skills-usage.json')
    this._archivedFile = join(home, 'skills-archived.json')
    this._archive = join(this.dir, '.archive')
  }

  /** Installing skills from the registry, a repository or a folder, after the person reviewed them. */
  readonly installs: SkillInstaller
  private readonly _usageFile: string
  private readonly _archivedFile: string
  private readonly _archive: string
  /** The curation thresholds, for the person to see. */
  readonly retire = { staleDays: SKILL_STALE_DAYS, archiveDays: SKILL_ARCHIVE_DAYS }

  /**
   * Every skill a chat can use: Myrmidon's own, the person's Claude Code skills, their plugins', the project's, then the
   * ones Myrmidon comes with.
   */
  list(project?: string, now = Date.now()): Skill[] {
    const state = readState(this._state)
    const disabled = new Set(state.disabled)
    const usage = this._usage()
    const installed = this.installs.installed()
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
      ...(this.builtinDir ? ([[this.builtinDir, 'builtin']] as [string, SkillSource][]) : []),
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
        const scan = scanSkill(dir)
        out.set(parsed.name, {
          name: parsed.name,
          description: parsed.description,
          dir: realpathSync.native(dir),
          source,
          enabled: !disabled.has(parsed.name),
          scan,
          held: scan.verdict === 'block' && state.allowed[parsed.name] !== scan.hash,
          ...(learned ? { curation: this._curation(parsed.name, usage, now) } : {}),
          ...(source === 'myrmidon' && installed[parsed.name] ? { installed: installed[parsed.name] } : {}),
        })
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** The skills agents are offered: switched on, and not held by their scan. */
  offered(project?: string): Skill[] {
    return this.list(project).filter((s) => s.enabled && !s.held)
  }

  /** The person allows a skill its scan blocked, as it is now: if it changes, the scan decides again. */
  allow(name: string, project?: string) {
    const skill = this.list(project).find((s) => s.name === name)
    if (!skill) throw new Error(`no skill called ${name}`)
    allowSkills(this._home, { [name]: skill.scan.hash })
  }

  /** A skill's instructions and the files it bundles, or one of those files (`file`, relative to the skill). */
  read(name: string, project?: string, file?: string): string {
    const skill = this.offered(project).find((s) => s.name === name)
    if (!skill) throw new Error(`no skill called ${name}`)
    if (file) {
      const path = resolve(skill.dir, file)
      const real = existsSync(path) ? realpathSync.native(path) : path
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

  /**
   * Moves learned skills unused for SKILL_ARCHIVE_DAYS (and not kept) to the archive; returns their names. A learned
   * skill with no clock yet (written before usage was kept, or only ever kept and let go) starts it now: its file's
   * age says nothing about whether anyone used it.
   */
  curate(now = Date.now()): string[] {
    const out: string[] = []
    for (const skill of this.list(undefined, now)) {
      const c = skill.curation
      if (!c || c.kept || skill.source !== 'myrmidon') continue
      const u = this._usage()[skill.name]
      if (!u?.since && !u?.lastUsed) {
        this._updateUsage(skill.name, (u) => {
          u.since = new Date(now).toISOString()
        })
        continue
      }
      if (now - this._idleSince(skill.name, this._usage(), now) < SKILL_ARCHIVE_DAYS * DAY_MS) continue
      mkdirSync(this._archive, { recursive: true })
      const target = join(this._archive, skill.name)
      rmSync(target, { recursive: true, force: true })
      renameSync(join(this.dir, skill.name), target)
      out.push(skill.name)
    }
    if (out.length) {
      const record = { at: new Date(now).toISOString(), names: out }
      writeFileSync(`${this._archivedFile}.tmp`, `${JSON.stringify(record, null, 2)}\n`)
      renameSync(`${this._archivedFile}.tmp`, this._archivedFile)
    }
    return out
  }

  /** The curator's last archiving (`skills-archived.json`), so the app can tell the person what went and when. */
  lastArchived(): { at: string; names: string[] } | undefined {
    try {
      const raw = JSON.parse(readFileSync(this._archivedFile, 'utf8')) as { at?: unknown; names?: unknown }
      if (typeof raw.at !== 'string' || !Array.isArray(raw.names)) return undefined
      return { at: raw.at, names: raw.names.filter((n): n is string => typeof n === 'string') }
    } catch {
      return undefined
    }
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

  /** Moves a learned skill to the archive (a retirement the person approved); Settings can bring it back. */
  archive(name: string) {
    const from = join(this.dir, name)
    const file = join(from, 'SKILL.md')
    if (!NAME.test(name) || !existsSync(file) || !isLearned(readFileSync(file, 'utf8')))
      throw new Error(`no learned skill called ${name}`)
    mkdirSync(this._archive, { recursive: true })
    const target = join(this._archive, name)
    rmSync(target, { recursive: true, force: true })
    renameSync(from, target)
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

  private _curation(name: string, usage: Record<string, Usage>, now: number): SkillCuration {
    const u = usage[name]
    const kept = u?.kept === true
    return {
      uses: u?.uses ?? 0,
      ...(u?.lastUsed ? { lastUsed: u.lastUsed } : {}),
      stale: !kept && now - this._idleSince(name, usage, now) >= SKILL_STALE_DAYS * DAY_MS,
      kept,
    }
  }

  /** When a learned skill was last used or given a fresh start; one with no record yet counts as fresh. */
  private _idleSince(name: string, usage: Record<string, Usage>, now: number): number {
    const u = usage[name]
    const times = [u?.lastUsed, u?.since].filter((t): t is string => !!t).map((t) => Date.parse(t))
    return times.length ? Math.max(...times) : now
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
    const state = readState(this._state)
    const disabled = new Set(state.disabled)
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    writeState(this._state, { ...state, disabled: [...disabled].sort() })
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
      else if (e.isFile() && !(depth === 0 && e.name === 'SKILL.md')) out.push(slashed(relative(dir, path)))
    }
  }
  walk(dir, 0)
  return out.sort()
}
