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
import { join, relative, resolve } from 'node:path'
import {
  describeOrigin,
  fetchFolder,
  fetchGit,
  gitSource,
  type InstalledFrom,
  type InstallOrigin,
  type InstallPin,
  integrityOf,
  PendingInstalls,
  unpackTarball,
} from './install-sources.ts'
import { expandHome } from './read-access.ts'
import { parseSkillSpec, resolveSkillVersion, SkillRegistryClient } from './skill-registry.ts'
import { combineScans, refuseBlocked, type SkillScan, scanSkill } from './skill-scan.ts'
import { allowSkills, parseSkillFile } from './skills.ts'

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
  /** For an update: what is installed now. */
  readonly replaces?: InstallPin
  readonly expiresAt: string
}

interface Held {
  origin: InstallOrigin
  pin: InstallPin
  /** Each skill's folder inside the fetched content ('' for a skill at its root). */
  paths: Record<string, string>
  replaces: boolean
  /** The scan hash of each skill whose scan blocks it, recorded as allowed if the person installs it anyway. */
  blocked: Record<string, string>
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

export class SkillInstaller {
  readonly registry: SkillRegistryClient
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

  /** Fetches the newest of an installed skill from where it came from, to review as an update. */
  prepareUpdate(name: string): Promise<SkillPreview> {
    const from = this.installed()[name]
    if (!from) throw new Error(`${name} was not installed from a registry, repository or folder`)
    return this._stage(from.origin, name)
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
        record[name] = { origin: held.origin, source: describeOrigin(held.origin), ...held.pin, installedAt }
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

  private async _stage(origin: InstallOrigin, only?: string): Promise<SkillPreview> {
    const { id, dir } = this._pending.stage()
    try {
      const content = join(dir, 'content')
      let pin: InstallPin = {}
      let warnings: string[] = []
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
      else throw new Error(`a skill cannot come from ${origin.kind}`)

      const found = findSkills(content).filter((s) => !only || s.name === only)
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
      const scans = found.map((s) => ({ name: s.name, path: s.path, scan: scanSkill(join(content, s.path)) }))
      const expiresAt = this._pending.hold(id, {
        origin,
        pin,
        paths: Object.fromEntries(found.map((s) => [s.name, s.path])),
        replaces: !!only,
        blocked: Object.fromEntries(
          scans.filter((s) => s.scan.verdict === 'block').map((s) => [s.name, s.scan.hash]),
        ),
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
