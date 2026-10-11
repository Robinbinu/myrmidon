import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { MARKET_PICK_DEPTH } from './config.ts'
import {
  describeOrigin,
  fetchFolder,
  fetchGit,
  gitSource,
  type ImportedFrom,
  type InstalledFrom,
  type InstallOrigin,
  type InstallPin,
  integrityOf,
  PendingInstalls,
  unpackTarball,
} from './install-sources.ts'
import { expandHome } from './read-access.ts'
import { parseSkillSpec, resolveSkillVersion, SkillRegistryClient } from './skill-registry.ts'
import { combineScans, refuseBlocked, type SkillFinding, type SkillScan, scanSkill } from './skill-scan.ts'
import { allowSkills, parseForeignSkill, parseSkillFile, renameSkillFile } from './skills.ts'

/**
 * Installing skills into Myrmidon's skills folder from omp's skills registry (`@scope/name[@version]`), a git
 * repository, or a folder. As with plugins, a fetch is shown to the person first (which skills, from where, which
 * files can run, what the skill scanner found) and installs only on their yes; scripts a skill ships are never run by
 * installing it, and a skill the scan blocks installs only when they confirm it anyway.
 */

export interface SkillPreview {
  readonly id: string
  readonly skills: readonly { name: string; description: string }[]
  readonly source: string
  readonly kind: InstallOrigin['kind']
  readonly version?: string
  readonly commit?: string
  readonly integrity?: string
  /** How many files it brings. */
  readonly files: number
  /** Files an agent could run: executables and anything under `scripts/`. */
  readonly scripts: readonly string[]
  /** Yanked or deprecated versions. */
  readonly warnings: readonly string[]
  /** What the skill scanner found, across every skill it brings (files named from the fetched folder). */
  readonly scan: SkillScan
  /** What the marketplace it came from says about it, shown beside the scan. */
  readonly audit?: SkillAudit
  /** For an update: what is installed now. */
  readonly replaces?: InstallPin
  readonly expiresAt: string
}

/** A marketplace's own or a third party's check of a skill (skills.sh's audits, ClawHub's trust verdict). */
export interface SkillAudit {
  /** Who reports it: `skills.sh`, `ClawHub`. */
  readonly by: string
  readonly status: 'pass' | 'warn' | 'fail' | 'unknown'
  readonly summary?: string
  readonly url?: string
  readonly checks: readonly { name: string; status: SkillAudit['status']; summary?: string }[]
}

/** How a marketplace that serves files itself (an origin of kind `market`) fetches one skill into a folder. */
export type MarketFetch = (
  id: string,
  dest: string,
) => Promise<{ pin: InstallPin; audit?: SkillAudit; flagged?: string }>

/** What a marketplace adds to a fetch: which skill of a repository, its audit, and whether it flags it. */
export interface StageOptions {
  /** The one skill wanted from a repository holding many, by its name or its folder's, wherever it sits. */
  readonly pick?: string
  readonly audit?: SkillAudit
  /** Why the marketplace flags it as suspicious: this blocks the install as a critical scan finding does. */
  readonly flagged?: string
}

interface Held {
  origin: InstallOrigin
  pin: InstallPin
  /** Each skill's folder inside the fetched content ('' for a skill at its root). */
  paths: Record<string, string>
  replaces: boolean
  /** The scan hash of each skill whose scan blocks it, recorded as allowed if the person installs it anyway. */
  blocked: Record<string, string>
  /** A skill copied in from Claude Code or Codex. */
  imported?: ImportedFrom
}

/** A Claude Code or Codex skill being copied in: the name it gets here, the kind of folder it is in, its name there. */
interface Importing {
  as: string
  from: string
  name: string
}

/** What the person typed: a registry package, a git URL, or a folder. */
export function skillOrigin(text: string): InstallOrigin {
  const s = text.trim()
  if (!s) throw new Error('give @scope/name from the skills registry, a git URL or a folder')
  if (parseSkillSpec(s)) return { kind: 'registry', spec: s }
  const g = gitSource(s)
  if (g) return { kind: 'git', ...g }
  return { kind: 'folder', path: resolve(expandHome(s)) }
}

/** The skills a fetched folder holds: itself, or each folder with a SKILL.md under `skills/` or at its top. */
function findSkills(root: string): { name: string; description: string; path: string }[] {
  const read = (dir: string) => {
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) return undefined
    const parsed = parseSkillFile(readFileSync(file, 'utf8'))
    return parsed
      ? { name: parsed.name, description: parsed.description, path: relative(root, dir) }
      : undefined
  }
  const top = read(root)
  if (top) return [top]
  for (const base of [join(root, 'skills'), root]) {
    if (!existsSync(base)) continue
    const found = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .flatMap((e) => read(join(base, e.name)) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
    if (found.length) return found
  }
  return []
}

/**
 * The skill called `want` (by its name, else its folder's) anywhere in a fetched repository, for a marketplace that
 * names a skill but not where its repository keeps it.
 */
function pickSkill(
  root: string,
  want: string,
): { name: string; description: string; path: string } | undefined {
  const found: { name: string; description: string; path: string }[] = []
  const walk = (dir: string, depth: number) => {
    const file = join(dir, 'SKILL.md')
    if (existsSync(file)) {
      const parsed = parseSkillFile(readFileSync(file, 'utf8'))
      if (parsed)
        found.push({ name: parsed.name, description: parsed.description, path: relative(root, dir) })
    }
    if (depth >= MARKET_PICK_DEPTH) return
    for (const e of readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules')
        walk(join(dir, e.name), depth + 1)
  }
  walk(root, 0)
  return found.find((s) => s.name === want) ?? found.find((s) => basename(s.path) === want)
}

/** The scan with the marketplace's flag as a critical finding first, so the install blocks as a scan block does. */
function withFlag(scan: SkillScan, flagged: string): SkillScan {
  const finding: SkillFinding = {
    rule: 'marketplace-flagged',
    category: 'supply_chain',
    severity: 'critical',
    file: 'SKILL.md',
    line: 0,
    excerpt: flagged,
    why: 'The marketplace it comes from flags this skill as suspicious.',
  }
  return { ...scan, verdict: 'block', findings: [finding, ...scan.findings] }
}

/** Every file under a folder, relative to it, and those that can run. */
function filesOf(root: string): { files: string[]; scripts: string[] } {
  const files: string[] = []
  const scripts: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (e.isFile()) {
        const rel = relative(root, path).split('\\').join('/')
        files.push(rel)
        if (rel.startsWith('scripts/') || rel.includes('/scripts/') || statSync(path).mode & 0o111)
          scripts.push(rel)
      }
    }
  }
  walk(root)
  return { files, scripts: scripts.sort() }
}

/**
 * Gives a copied Claude Code or Codex skill the name it has here: its SKILL.md is rewritten only when its name differs
 * or it left its name or description out, so an unchanged copy keeps the scan hash of what it was copied from.
 */
function renameImported(dir: string, name: string) {
  const file = join(dir, 'SKILL.md')
  if (!existsSync(file)) throw new Error('the folder has no SKILL.md')
  const text = readFileSync(file, 'utf8')
  if (parseSkillFile(text)?.name === name) return
  const parsed = parseForeignSkill(text, name)
  if (!parsed) throw new Error('its SKILL.md says nothing about what it does')
  writeFileSync(file, renameSkillFile(text, name, parsed.description))
}

export class SkillInstaller {
  readonly registry: SkillRegistryClient
  /** Marketplaces that serve skills themselves, by source id; skill-market.ts adds them. */
  readonly markets = new Map<string, MarketFetch>()
  private readonly _home: string
  private readonly _file: string
  private readonly _pending: PendingInstalls<Held>

  constructor(
    home: string,
    /** Myrmidon's own skills folder, where installed skills go. */
    readonly dir: string,
    registry?: SkillRegistryClient,
  ) {
    this.registry = registry ?? new SkillRegistryClient()
    this._home = home
    this._file = join(home, 'skills-installed.json')
    this._pending = new PendingInstalls(join(home, 'installs', 'skills'))
  }

  /** Where each installed skill came from, by name. */
  installed(): Record<string, InstalledFrom> {
    try {
      const raw = JSON.parse(readFileSync(this._file, 'utf8')) as { skills?: unknown }
      return raw.skills && typeof raw.skills === 'object' ? (raw.skills as Record<string, InstalledFrom>) : {}
    } catch {
      return {}
    }
  }

  /** Fetches skills for the person to review; nothing is installed until `confirm(id)`. */
  prepare(source: string): Promise<SkillPreview> {
    return this._stage(skillOrigin(source))
  }

  /** Fetches skills from where a marketplace says they are, for the person to review as `prepare` does. */
  prepareFrom(origin: InstallOrigin, opts: StageOptions = {}): Promise<SkillPreview> {
    return this._stage(origin, undefined, opts)
  }

  /** Fetches the newest of an installed skill from where it came from, to review as an update. */
  prepareUpdate(name: string): Promise<SkillPreview> {
    const from = this.installed()[name]
    if (!from) throw new Error(`${name} was not installed from a registry, repository or folder`)
    const imported = from.imported
    return this._stage(
      from.origin,
      name,
      imported ? { importing: { as: name, from: imported.from, name: imported.name } } : {},
    )
  }

  /**
   * Stages a Claude Code or Codex skill folder for review, to be installed as `importing.as` (its SKILL.md renamed to
   * match when that differs, or when it left its name or description out).
   */
  prepareImport(dir: string, importing: Importing): Promise<SkillPreview> {
    return this._stage({ kind: 'folder', path: dir }, undefined, { importing })
  }

  /**
   * Installs reviewed skills (or applies a reviewed update) and records where they came from; returns their names. A
   * skill the scan blocks needs `override` (the person's "install anyway"); without it the review stays open.
   */
  confirm(id: string, opts: { override?: boolean } = {}): string[] {
    refuseBlocked(this._pending.peek(id)?.blocked ?? {}, opts.override)
    const held = this._pending.take(id)
    const content = join(held.dir, 'content')
    try {
      mkdirSync(this.dir, { recursive: true })
      const names = Object.keys(held.paths)
      for (const name of names) {
        const target = join(this.dir, name)
        if (existsSync(target) && !held.replaces) throw new Error(`a skill called ${name} already exists`)
      }
      const installedAt = new Date().toISOString()
      const record = this.installed()
      for (const name of names) {
        const target = join(this.dir, name)
        const old = join(this.dir, `.old-${name}-${Date.now()}`)
        if (existsSync(target)) renameSync(target, old)
        renameSync(join(content, held.paths[name] ?? ''), target)
        rmSync(old, { recursive: true, force: true })
        record[name] = {
          origin: held.origin,
          source: describeOrigin(held.origin),
          ...held.pin,
          installedAt,
          ...(held.imported ? { imported: held.imported } : {}),
        }
      }
      this._save(record)
      allowSkills(this._home, held.blocked)
      return names
    } finally {
      this._pending.drop(id)
    }
  }

  cancel(id: string) {
    this._pending.drop(id)
  }

  /** Removes a skill that was installed; skills the person or Myrmidon wrote are not touched. */
  remove(name: string) {
    const record = this.installed()
    if (!record[name]) throw new Error(`${name} was not installed, so it is not removed here`)
    rmSync(join(this.dir, name), { recursive: true, force: true })
    delete record[name]
    this._save(record)
  }

  private async _stage(
    origin: InstallOrigin,
    only?: string,
    opts: StageOptions & { importing?: Importing } = {},
  ): Promise<SkillPreview> {
    const { id, dir } = this._pending.stage()
    try {
      const content = join(dir, 'content')
      let pin: InstallPin = {}
      let warnings: string[] = []
      let { audit, flagged } = opts
      if (origin.kind === 'registry') {
        const spec = parseSkillSpec(origin.spec)
        if (!spec) throw new Error(`not a registry skill: ${origin.spec}`)
        const packument = await this.registry.packument(spec.scope, spec.name)
        const chosen = resolveSkillVersion(packument, spec.range)
        const tgz = await this.registry.tarball(spec.scope, spec.name, chosen.version)
        const integrity = integrityOf(tgz)
        if (integrity !== chosen.summary.integrity)
          throw new Error(
            `@${spec.scope}/${spec.name}@${chosen.version} does not match its published hash; nothing was installed`,
          )
        unpackTarball(tgz, content, false)
        if (!existsSync(join(content, 'SKILL.md'))) throw new Error('the package has no SKILL.md')
        pin = { version: chosen.version, integrity }
        warnings = chosen.warnings
      } else if (origin.kind === 'git') pin = await fetchGit(origin, content)
      else if (origin.kind === 'folder') pin = fetchFolder(origin.path, content)
      else if (origin.kind === 'market') {
        const market = this.markets.get(origin.source)
        if (!market) throw new Error(`skills from ${origin.source} cannot be fetched here`)
        const got = await market(origin.id, content)
        pin = got.pin
        audit = got.audit ?? audit
        flagged = got.flagged ?? flagged
      } else throw new Error(`a skill cannot come from ${origin.kind}`)
      const { importing } = opts
      let imported: ImportedFrom | undefined
      if (importing) {
        if (origin.kind !== 'folder') throw new Error('only a folder is imported')
        imported = { from: importing.from, name: importing.name, hash: scanSkill(origin.path).hash }
        renameImported(content, importing.as)
      }

      let found: { name: string; description: string; path: string }[]
      if (opts.pick) {
        const picked = pickSkill(content, opts.pick)
        if (!picked) throw new Error(`it has no skill called ${opts.pick}`)
        found = [picked]
        // Recorded with its folder, so an update fetches only that skill.
        if (origin.kind === 'git' && picked.path) origin = { ...origin, subdir: picked.path }
      } else found = findSkills(content).filter((s) => !only || s.name === only)
      if (!found.length)
        throw new Error(
          only ? `it no longer has a skill called ${only}` : 'no SKILL.md with a name and description',
        )
      for (const s of found)
        if (!only && existsSync(join(this.dir, s.name)))
          throw new Error(`a skill called ${s.name} already exists`)
      const { files, scripts } = filesOf(content)
      const inside = (s: { path: string }) => (rel: string) => !s.path || rel.startsWith(`${s.path}/`)
      const kept = files.filter((f) => found.some((s) => inside(s)(f)))
      const previous = only ? this.installed()[only] : undefined
      const scans = found.map((s) => {
        const scan = scanSkill(join(content, s.path))
        return { name: s.name, path: s.path, scan: flagged ? withFlag(scan, flagged) : scan }
      })
      const expiresAt = this._pending.hold(id, {
        origin,
        pin,
        paths: Object.fromEntries(found.map((s) => [s.name, s.path])),
        replaces: !!only,
        blocked: Object.fromEntries(
          scans.filter((s) => s.scan.verdict === 'block').map((s) => [s.name, s.scan.hash]),
        ),
        ...(imported ? { imported } : {}),
      })
      return {
        id,
        skills: found.map(({ name, description }) => ({ name, description })),
        source: describeOrigin(origin),
        kind: origin.kind,
        ...pin,
        files: kept.length,
        scripts: scripts.filter((f) => found.some((s) => inside(s)(f))),
        warnings,
        scan: combineScans(scans),
        ...(audit ? { audit } : {}),
        ...(previous
          ? {
              replaces: {
                ...(previous.version ? { version: previous.version } : {}),
                ...(previous.commit ? { commit: previous.commit } : {}),
              },
            }
          : {}),
        expiresAt,
      }
    } catch (err) {
      this._pending.drop(id)
      throw err
    }
  }

  private _save(skills: Record<string, InstalledFrom>) {
    writeFileSync(`${this._file}.tmp`, `${JSON.stringify({ skills }, null, 2)}\n`)
    renameSync(`${this._file}.tmp`, this._file)
  }
}
