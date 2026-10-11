import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { CODEX_ADMIN_SKILLS, SKILL_IMPORT_MAX } from './config.ts'
import { expandHome } from './read-access.ts'
import { type SkillScan, scanSkill } from './skill-scan.ts'
import { parseForeignSkill, type SkillLibrary } from './skills.ts'

/** Also the most a request may name, for the server's check. */
export { SKILL_IMPORT_MAX }

/**
 * Skills the person already has in Claude Code and Codex, copied into Myrmidon's skills folder on their say. Listing
 * reads those tools' folders and changes nothing in them; each import goes through the skill installer as a folder
 * install would (copied, scanned, recorded with where it came from), and arrives switched off, so the person looks at
 * it before agents are offered it. Agents never read the tools' folders themselves (config.ts keeps them out of
 * reach); only this copy does.
 *
 * Where each tool keeps them: Claude Code in `~/.claude/skills` and its plugins' `skills/` (installed_plugins.json,
 * or the plugin cache); Codex in `~/.agents/skills`, `$CODEX_HOME/skills` (older), `/etc/codex/skills` (the admin's)
 * and its plugin cache, and a repository's `.agents/skills` from the project up to its git root, and `.codex/skills`.
 * Codex's own bundled skills (`$CODEX_HOME/skills/.system`) are for Codex and are not offered.
 */

export type SkillImportOrigin = 'claude' | 'claude-plugin' | 'agents' | 'codex' | 'codex-plugin' | 'project'

export const SKILL_IMPORT_ORIGINS: readonly SkillImportOrigin[] = [
  'claude',
  'claude-plugin',
  'agents',
  'codex',
  'codex-plugin',
  'project',
]

/** A skill in Claude Code or Codex, as the import picker shows it. */
export interface ImportableSkill {
  /** Stable while the folder stays where it is. */
  readonly id: string
  readonly origin: SkillImportOrigin
  /** Its name there. */
  readonly name: string
  /** The name it gets here: its own, or suffixed (`name-codex`) when a different skill here already has it. */
  readonly importAs: string
  readonly description: string
  /** Absolute, symlink-resolved folder. */
  readonly dir: string
  /** The plugin that brings it, for a plugin's skill. */
  readonly plugin?: string
  /** Codex's `agents/openai.yaml`: the name its app shows, and the tools (MCP servers) it says it needs. */
  readonly displayName?: string
  readonly requires?: readonly string[]
  /** Claude Code front matter worth seeing before importing it. */
  readonly license?: string
  readonly whenToUse?: string
  /** This folder was imported before, or the same skill is already here (as `importedAs`). */
  readonly alreadyImported: boolean
  readonly importedAs?: string
  /** Switched off in the tool it comes from (Codex's config.toml, Claude Code's enabled plugins). */
  readonly disabledThere?: boolean
  readonly scan: SkillScan
}

export interface SkillImportResult {
  readonly imported: readonly { id: string; name: string }[]
  /** Not imported: gone since it was listed, already here, blocked by its scan without an override, or failed. */
  readonly skipped: readonly {
    id: string
    name?: string
    reason: 'gone' | 'already' | 'blocked' | 'failed'
    error?: string
  }[]
}

export interface SkillImportOptions {
  /** Claude Code's folder (`~/.claude`). */
  claudeRoot?: string
  /** Codex's folder (`$CODEX_HOME`, else `~/.codex`). */
  codexRoot?: string
  /** The shared agents folder Codex reads user skills from (`~/.agents`). */
  agentsRoot?: string
  /** The administrator's Codex skills; none on Windows. */
  adminRoot?: string
}

/** A folder skills are listed from, and what to say about the skills in it. */
interface Root {
  origin: SkillImportOrigin
  dir: string
  plugin?: string
  off?: boolean
}

/** The suffix a skill gets when its name is taken here: the tool it comes from. */
const SUFFIX: Record<SkillImportOrigin, string> = {
  claude: 'claude',
  'claude-plugin': 'claude',
  agents: 'codex',
  codex: 'codex',
  'codex-plugin': 'codex',
  project: 'project',
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

const real = (path: string) => (existsSync(path) ? realpathSync.native(path) : resolve(path))

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The folders directly in `dir`, leaving out hidden ones (Codex's `.system`). */
const subdirs = (dir: string) =>
  isDir(dir)
    ? readdirSync(dir)
        .filter((e) => !e.startsWith('.') && isDir(join(dir, e)))
        .sort()
    : []

/** `<cache>/<marketplace>/<plugin>/<version>`: each plugin's newest version folder (by when it was written). */
function cachedPlugins(cache: string): { plugin: string; dir: string }[] {
  return subdirs(cache).flatMap((market) =>
    subdirs(join(cache, market)).flatMap((plugin) => {
      const versions = subdirs(join(cache, market, plugin)).map((v) => join(cache, market, plugin, v))
      const newest = versions.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
      return newest ? [{ plugin, dir: newest }] : []
    }),
  )
}

/** A name that is free here: `base`, else `base-<suffix>`, `base-<suffix>-2`…, each within the 64 characters allowed. */
function freeName(base: string, suffix: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base
  for (let n = 1; ; n++) {
    const tail = n === 1 ? `-${suffix}` : `-${suffix}-${n}`
    const name = `${base.slice(0, 64 - tail.length).replace(/-+$/, '')}${tail}`
    if (!taken(name)) return name
  }
}

export class SkillImports {
  private readonly _claude: string
  private readonly _codex: string
  private readonly _agents: string
  private readonly _admin: string | undefined

  constructor(
    private readonly _skills: SkillLibrary,
    options: SkillImportOptions = {},
  ) {
    this._claude = options.claudeRoot ?? join(homedir(), '.claude')
    this._codex = options.codexRoot ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
    this._agents = options.agentsRoot ?? join(homedir(), '.agents')
    this._admin = options.adminRoot ?? (process.platform === 'win32' ? undefined : CODEX_ADMIN_SKILLS)
  }

  /** The Claude Code and Codex skills on this machine (and in `project`), in the order of SKILL_IMPORT_ORIGINS. */
  list(project?: string): ImportableSkill[] {
    const here = new Map(this._skills.list(project).map((s) => [s.name, s.scan.hash]))
    const reserved = new Set([...subdirs(this._skills.dir), ...this._skills.archived().map((a) => a.name)])
    const importedFrom = new Map<string, string>()
    for (const [name, from] of Object.entries(this._skills.installs.installed()))
      if (from.imported && from.origin.kind === 'folder') importedFrom.set(real(from.origin.path), name)
    const claimed = new Map<string, string>()
    const offInCodex = this._codexDisabled()
    const seen = new Set<string>()
    const out: ImportableSkill[] = []
    for (const root of this._roots(project)) {
      for (const entry of subdirs(root.dir)) {
        if (out.length >= SKILL_IMPORT_MAX) return out
        const file = join(root.dir, entry, 'SKILL.md')
        if (!existsSync(file)) continue
        const dir = realpathSync.native(join(root.dir, entry))
        if (seen.has(dir)) continue
        seen.add(dir)
        const parsed = parseForeignSkill(readFileSync(file, 'utf8'), entry)
        if (!parsed) continue
        const scan = scanSkill(dir)
        const before = importedFrom.get(dir)
        const same = here.get(parsed.name) === scan.hash ? parsed.name : undefined
        const importedAs = before && here.has(before) ? before : same
        const importAs =
          importedAs ??
          freeName(
            parsed.name,
            SUFFIX[root.origin],
            (n) => reserved.has(n) || here.has(n) || (claimed.has(n) && claimed.get(n) !== scan.hash),
          )
        // Claimed for this listing, so two different skills of one name are not both offered under it (the same skill
        // in two folders is, and whichever is imported first makes the other already here).
        if (!importedAs) claimed.set(importAs, scan.hash)
        const { meta } = parsed
        const card = this._openaiYaml(dir)
        out.push({
          id: `${root.origin}:${parsed.name}:${createHash('sha256').update(dir).digest('hex').slice(0, 10)}`,
          origin: root.origin,
          name: parsed.name,
          importAs,
          description: parsed.description,
          dir,
          ...(root.plugin ? { plugin: root.plugin } : {}),
          ...card,
          ...(typeof meta.license === 'string' ? { license: meta.license } : {}),
          ...(typeof meta.when_to_use === 'string' ? { whenToUse: meta.when_to_use } : {}),
          alreadyImported: !!importedAs,
          ...(importedAs ? { importedAs } : {}),
          ...(root.off || offInCodex.has(dir) ? { disabledThere: true } : {}),
          scan,
        })
      }
    }
    return out
  }

  /**
   * Copies the chosen skills in, each switched off until the person turns it on. One whose scan blocks it is imported
   * only when its id is in `override` (the person's "Import anyway"); one already here is left alone.
   */
  async import(
    ids: readonly string[],
    opts: { project?: string; override?: readonly string[] } = {},
  ): Promise<SkillImportResult> {
    const imported: { id: string; name: string }[] = []
    const skipped: SkillImportResult['skipped'][number][] = []
    for (const id of ids) {
      // Listed again each time: an import just made can make the next one a duplicate, or take its name.
      const c = this.list(opts.project).find((x) => x.id === id)
      if (!c) skipped.push({ id, reason: 'gone' })
      else if (c.alreadyImported) skipped.push({ id, name: c.importedAs ?? c.name, reason: 'already' })
      else if (c.scan.verdict === 'block' && !opts.override?.includes(id))
        skipped.push({ id, name: c.name, reason: 'blocked' })
      else {
        // Off before it lands, so no chat is offered it in between.
        this._skills.setEnabled(c.importAs, false)
        let preview: { id: string } | undefined
        try {
          preview = await this._skills.installs.prepareImport(c.dir, {
            as: c.importAs,
            from: c.origin,
            name: c.name,
          })
          this._skills.installs.confirm(preview.id, { override: opts.override?.includes(id) === true })
          imported.push({ id, name: c.importAs })
        } catch (err) {
          if (preview) this._skills.installs.cancel(preview.id)
          this._skills.setEnabled(c.importAs, true)
          skipped.push({
            id,
            name: c.name,
            reason: 'failed',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    return { imported, skipped }
  }

  private _roots(project?: string): Root[] {
    const roots: Root[] = [
      { origin: 'claude', dir: join(this._claude, 'skills') },
      ...this._claudePlugins(project),
      { origin: 'agents', dir: join(this._agents, 'skills') },
      { origin: 'codex', dir: join(this._codex, 'skills') },
      ...(this._admin ? [{ origin: 'codex' as const, dir: this._admin }] : []),
      ...cachedPlugins(join(this._codex, 'plugins', 'cache')).map(
        ({ plugin, dir }): Root => ({ origin: 'codex-plugin', dir: join(dir, 'skills'), plugin }),
      ),
    ]
    if (!project) return roots
    // A project's `.claude/skills` is read in place already (skills.ts); Codex's are not.
    for (let at = resolve(project); ; at = dirname(at)) {
      roots.push({ origin: 'project', dir: join(at, '.agents', 'skills') })
      if (existsSync(join(at, '.git')) || dirname(at) === at) break
    }
    roots.push({ origin: 'project', dir: join(project, '.codex', 'skills') })
    return roots
  }

  /**
   * Claude Code's installed plugins (installed_plugins.json; a project-scoped one only for its project), else every
   * plugin in its cache; one switched off in its settings is marked so.
   */
  private _claudePlugins(project?: string): Root[] {
    const settings = readJson(join(this._claude, 'settings.json')) as { enabledPlugins?: unknown } | undefined
    const enabled = (settings?.enabledPlugins ?? {}) as Record<string, unknown>
    const index = readJson(join(this._claude, 'plugins', 'installed_plugins.json')) as
      | { plugins?: Record<string, unknown> }
      | undefined
    if (!index?.plugins || typeof index.plugins !== 'object')
      return cachedPlugins(join(this._claude, 'plugins', 'cache')).map(({ plugin, dir }) => ({
        origin: 'claude-plugin',
        dir: join(dir, 'skills'),
        plugin,
      }))
    return Object.entries(index.plugins).flatMap(([key, value]) => {
      const installs = (Array.isArray(value) ? value : [value]) as {
        installPath?: unknown
        scope?: unknown
        projectPath?: unknown
      }[]
      const plugin = key.split('@')[0] ?? key
      return installs.flatMap((i): Root[] => {
        if (typeof i?.installPath !== 'string') return []
        const scoped = i.scope === 'project' || i.scope === 'local'
        if (
          scoped &&
          (!project || typeof i.projectPath !== 'string' || real(i.projectPath) !== real(project))
        )
          return []
        return [
          {
            origin: 'claude-plugin',
            dir: join(i.installPath, 'skills'),
            plugin,
            ...(enabled[key] === false ? { off: true } : {}),
          },
        ]
      })
    })
  }

  /** Skills switched off in Codex: `[[skills.config]]` entries of its config.toml with `enabled = false`. */
  private _codexDisabled(): Set<string> {
    const off = new Set<string>()
    let config: unknown
    try {
      config = Bun.TOML.parse(readFileSync(join(this._codex, 'config.toml'), 'utf8'))
    } catch {
      return off
    }
    const entries = (config as { skills?: { config?: unknown } })?.skills?.config
    if (!Array.isArray(entries)) return off
    for (const e of entries as { path?: unknown; enabled?: unknown }[]) {
      if (e?.enabled !== false || typeof e.path !== 'string') continue
      const path = resolve(expandHome(e.path))
      off.add(real(basename(path) === 'SKILL.md' ? dirname(path) : path))
    }
    return off
  }

  /** What a Codex skill's `agents/openai.yaml` says about it that the picker shows. */
  private _openaiYaml(dir: string): { displayName?: string; requires?: string[] } {
    const file = join(dir, 'agents', 'openai.yaml')
    if (!existsSync(file)) return {}
    let card: unknown
    try {
      card = Bun.YAML.parse(readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
    const c = (card ?? {}) as {
      interface?: { display_name?: unknown }
      dependencies?: { tools?: unknown }
    }
    const name = c.interface?.display_name
    const tools = Array.isArray(c.dependencies?.tools) ? (c.dependencies.tools as { value?: unknown }[]) : []
    const requires = tools.flatMap((t) => (typeof t?.value === 'string' ? [t.value] : []))
    return {
      ...(typeof name === 'string' && name.trim() ? { displayName: name.trim() } : {}),
      ...(requires.length ? { requires } : {}),
    }
  }
}
