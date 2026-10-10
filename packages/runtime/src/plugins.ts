import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { PluginCommand } from '@myrmidon/protocol'
import { checkedHooks, HOOK_EVENTS, type HookGroup, type HooksConfig } from './hooks.ts'
import {
  dependenciesOf,
  describeOrigin,
  type FetchFn,
  fetchFolder,
  fetchGit,
  fetchNpm,
  type InstalledFrom,
  type InstallOrigin,
  type InstallPin,
  installDependencies,
  originName,
  PendingInstalls,
  parseInstallSource,
} from './install-sources.ts'
import { MarketplaceStore } from './marketplaces.ts'
import type { McpServerConfig } from './mcp.ts'

/**
 * Plugins: one folder that adds skills, slash commands, hooks and MCP servers, switched on and off as a unit. The
 * layout is Claude Code's, so its plugins work unchanged: `.claude-plugin/plugin.json` names the plugin, and
 * `skills/`, `commands/`, `hooks/hooks.json` and `.mcp.json` hold the parts. They live in `<home>/plugins/<name>`;
 * plugins run their hooks and servers as the person, so only the person adds them, never a project.
 */

export interface PluginInfo {
  readonly name: string
  readonly version?: string
  readonly description?: string
  readonly author?: string
  readonly dir: string
  readonly enabled: boolean
  readonly skills: readonly string[]
  readonly commands: readonly PluginCommand[]
  /** How many hook commands it adds. */
  readonly hooks: number
  readonly mcpServers: readonly string[]
  /** Its code's entry point (`myrmidon.json` "server", or `server/index.ts`), relative to its folder. */
  readonly server?: string
  /** Its UI's entry point (`myrmidon.json` "ui", or `ui/index.tsx`), relative to its folder. */
  readonly ui?: string
  /** The settings it declares, by key. */
  readonly settings: Readonly<Record<string, PluginSetting>>
  /** Where it was installed from and exactly what (version, commit, hash); none for a plugin made here. */
  readonly installed?: InstalledFrom
  /** Set when a part could not be read; the rest of the plugin still loads. */
  readonly error?: string
}

/**
 * What a fetched plugin holds, shown to the person before anything is installed: installing needs their yes on this
 * (`confirm(id)`), because a plugin's code, hooks and MCP servers run as them.
 */
export interface PluginPreview {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly author?: string
  readonly version?: string
  /** Where it comes from, as one line. */
  readonly source: string
  readonly kind: InstallOrigin['kind']
  readonly commit?: string
  readonly integrity?: string
  /** Code that runs in the server once it is switched on. */
  readonly server?: string
  readonly ui?: string
  readonly hooks: number
  readonly mcpServers: readonly string[]
  readonly skills: readonly string[]
  readonly commands: readonly string[]
  /** npm packages installing it also installs (their scripts are not run). */
  readonly dependencies: readonly string[]
  /** For an update: what is installed now. */
  readonly replaces?: InstallPin
  readonly expiresAt: string
}

/** A fetched plugin waiting for the person's yes. */
interface Held {
  name: string
  origin: InstallOrigin
  pin: InstallPin
  replaces: boolean
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/

/** One setting a plugin declares in `myrmidon.json`; the person sets it in Settings → Plugins. */
export interface PluginSetting {
  readonly type: 'string' | 'number' | 'boolean'
  readonly default?: string | number | boolean
  readonly description?: string
  /** Shown as dots and kept out of logs, e.g. an API key. */
  readonly secret?: boolean
}

/** What `<home>/plugins.json` holds: which plugins are off, each one's settings, and where each was installed from. */
interface PluginState {
  disabled: string[]
  settings: Record<string, Record<string, string | number | boolean>>
  installed: Record<string, InstalledFrom>
}

/** Claude Code writes `${CLAUDE_PLUGIN_ROOT}` for the plugin's own folder in hook commands and server configs. */
function withRoot<T>(value: T, root: string): T {
  return JSON.parse(
    JSON.stringify(value).replaceAll('${CLAUDE_PLUGIN_ROOT}', root.replaceAll('\\', '\\\\')),
  ) as T
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** A command file's front matter and body, as Claude Code writes them. */
function parseCommand(text: string): { description?: string; argumentHint?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { body: text.trim() }
  let meta: Record<string, unknown> = {}
  try {
    meta = (Bun.YAML.parse(m[1] ?? '') ?? {}) as Record<string, unknown>
  } catch {
    // Loose front matter (an unquoted colon) still names its description.
    const d = /^description:\s*(.*)$/m.exec(m[1] ?? '')
    if (d) meta = { description: d[1] }
  }
  return {
    ...(typeof meta.description === 'string' ? { description: meta.description.trim() } : {}),
    ...(typeof meta['argument-hint'] === 'string' ? { argumentHint: meta['argument-hint'].trim() } : {}),
    body: (m[2] ?? '').trim(),
  }
}

export class PluginStore {
  readonly dir: string
  /** Claude Code marketplaces the person added, to browse and install plugins from. */
  readonly marketplaces: MarketplaceStore
  private readonly _state: string
  private readonly _pending: PendingInstalls<Held>

  constructor(
    home: string,
    private readonly fetchFn: FetchFn = (...a) => fetch(...a),
  ) {
    this.dir = join(home, 'plugins')
    this._state = join(home, 'plugins.json')
    this.marketplaces = new MarketplaceStore(home, fetchFn)
    this._pending = new PendingInstalls(join(home, 'installs', 'plugins'))
  }

  list(): PluginInfo[] {
    if (!existsSync(this.dir)) return []
    const state = this._readState()
    const disabled = new Set(state.disabled)
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => {
        const info = this._read(join(this.dir, e.name), !disabled.has(e.name))
        const from = state.installed[e.name]
        return from ? { ...info, installed: from } : info
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Folders of the enabled plugins' skills, for the skill library. */
  skillRoots(): string[] {
    return this._on().map((p) => join(p.dir, 'skills'))
  }

  commands(): PluginCommand[] {
    return this._on().flatMap((p) => p.commands)
  }

  /** The enabled plugins' hooks, with their folder filled in. */
  hooks(): HooksConfig {
    const out: Partial<Record<(typeof HOOK_EVENTS)[number], HookGroup[]>> = {}
    for (const p of this._on()) {
      const file = join(p.dir, 'hooks', 'hooks.json')
      if (!existsSync(file)) continue
      try {
        const config = withRoot(checkedHooks(readJson(file)), p.dir)
        for (const event of HOOK_EVENTS) out[event] = [...(out[event] ?? []), ...(config.hooks[event] ?? [])]
      } catch {
        // A broken hooks file is reported in the plugin's row (list), not here, on every tool call.
      }
    }
    return { hooks: out }
  }

  /** The enabled plugins' MCP servers, named `<plugin>_<server>` so two plugins never collide. */
  mcpServers(): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {}
    for (const p of this._on())
      for (const [name, config] of Object.entries(this._mcp(p.dir))) out[`${p.name}_${name}`] = config
    return out
  }

  /**
   * Fetches a plugin for the person to review: from a folder (copied), a git URL (cloned at a commit), an npm package
   * or tarball (unpacked), or a marketplace (`{ marketplace, plugin }`). Nothing is installed and nothing runs: the
   * preview says what it holds (code, hooks, MCP servers), and `confirm(id)` installs it. Only the person's own
   * action in Settings or the CLI reaches this; no agent tool does.
   */
  async prepare(source: string | { marketplace: string; plugin: string }): Promise<PluginPreview> {
    const origin: InstallOrigin =
      typeof source === 'string'
        ? parseInstallSource(source)
        : { kind: 'marketplace', marketplace: source.marketplace, plugin: source.plugin }
    return this._stage(origin)
  }

  /** Fetches the newest of an installed plugin from where it came from, for the person to review as an update. */
  async prepareUpdate(name: string): Promise<PluginPreview> {
    const plugin = this._get(name)
    if (!plugin.installed) throw new Error(`${name} was not installed from a source it can be updated from`)
    if (plugin.installed.origin.kind === 'marketplace')
      await this.marketplaces.update(plugin.installed.origin.marketplace)
    return this._stage(plugin.installed.origin, plugin)
  }

  /**
   * Installs a reviewed plugin (or applies a reviewed update): its dependencies install with scripts off, it moves
   * into place, and where it came from is recorded. A new plugin starts enabled: the person chose to add it.
   */
  async confirm(id: string): Promise<PluginInfo> {
    const held = this._pending.take(id)
    const content = join(held.dir, 'content')
    try {
      await installDependencies(content)
      const target = join(this.dir, held.name)
      if (held.replaces) {
        const old = join(this.dir, `.old-${held.name}-${Date.now()}`)
        renameSync(target, old)
        renameSync(content, target)
        rmSync(old, { recursive: true, force: true })
      } else {
        if (existsSync(target)) throw new Error(`a plugin called ${held.name} is already installed`)
        mkdirSync(this.dir, { recursive: true })
        renameSync(content, target)
      }
      const state = this._readState()
      const record: InstalledFrom = {
        origin: held.origin,
        source: describeOrigin(held.origin),
        ...held.pin,
        installedAt: new Date().toISOString(),
      }
      this._save({ ...state, installed: { ...state.installed, [held.name]: record } })
      if (!held.replaces) this.setEnabled(held.name, true)
      return this._get(held.name)
    } finally {
      this._pending.drop(id)
    }
  }

  /** Which plugin a review is for, and whether it updates one already installed. */
  reviewed(id: string): { name: string; replaces: boolean } | undefined {
    const held = this._pending.peek(id)
    return held && { name: held.name, replaces: held.replaces }
  }

  /** Drops a fetched plugin the person decided not to install. */
  cancel(id: string) {
    this._pending.drop(id)
  }

  private async _stage(origin: InstallOrigin, replaces?: PluginInfo): Promise<PluginPreview> {
    const { id, dir } = this._pending.stage()
    try {
      const content = join(dir, 'content')
      let pin: InstallPin
      let listedVersion: string | undefined
      if (origin.kind === 'marketplace') {
        const r = this.marketplaces.resolve(origin.marketplace, origin.plugin)
        pin = { ...(await this._fetch(r.fetch, content)), ...(r.commit ? { commit: r.commit } : {}) }
        listedVersion = r.entry.version
      } else pin = await this._fetch(origin, content)
      const found = this._read(content, true)
      const manifest = this._manifest(content)
      const name = replaces?.name ?? (manifest.name ?? originName(origin)).toLowerCase()
      if (!NAME.test(name)) throw new Error(`"${name}" is not a usable plugin name (a-z, 0-9 and -)`)
      if (
        !found.skills.length &&
        !found.commands.length &&
        !found.hooks &&
        !found.mcpServers.length &&
        !found.server &&
        !found.ui
      )
        throw new Error('this has no skills, commands, hooks, MCP servers, code or UI, so it is not a plugin')
      if (!replaces && existsSync(join(this.dir, name)))
        throw new Error(`a plugin called ${name} is already installed`)
      const version = found.version ?? pin.version ?? listedVersion
      const expiresAt = this._pending.hold(id, {
        name,
        origin,
        pin: { ...pin, ...(version ? { version } : {}) },
        replaces: !!replaces,
      })
      return {
        id,
        name,
        ...(found.description ? { description: found.description } : {}),
        ...(found.author ? { author: found.author } : {}),
        ...(version ? { version } : {}),
        source: describeOrigin(origin),
        kind: origin.kind,
        ...(pin.commit ? { commit: pin.commit } : {}),
        ...(pin.integrity ? { integrity: pin.integrity } : {}),
        ...(found.server ? { server: found.server } : {}),
        ...(found.ui ? { ui: found.ui } : {}),
        hooks: found.hooks,
        mcpServers: found.mcpServers,
        skills: found.skills,
        commands: found.commands.map((c) => c.name),
        dependencies: dependenciesOf(content),
        ...(replaces
          ? {
              replaces: {
                ...(replaces.version ? { version: replaces.version } : {}),
                ...(replaces.installed?.commit ? { commit: replaces.installed.commit } : {}),
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

  private async _fetch(origin: InstallOrigin, dest: string): Promise<InstallPin> {
    switch (origin.kind) {
      case 'folder':
        return fetchFolder(origin.path, dest)
      case 'git':
        return fetchGit(origin, dest)
      case 'npm':
        return fetchNpm(origin, dest, this.fetchFn)
      default:
        throw new Error(`a plugin cannot come from ${origin.kind}`)
    }
  }

  setEnabled(name: string, enabled: boolean) {
    this._get(name)
    const state = this._readState()
    const disabled = new Set(state.disabled)
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    this._save({ ...state, disabled: [...disabled].sort() })
  }

  /** A plugin's settings: what the person set, over the defaults its manifest declares. */
  settings(name: string): Record<string, string | number | boolean> {
    const declared = this.list().find((p) => p.name === name)?.settings ?? {}
    const set = this._readState().settings[name] ?? {}
    const out: Record<string, string | number | boolean> = {}
    for (const [key, spec] of Object.entries(declared)) {
      const value = set[key] ?? spec.default
      if (value !== undefined) out[key] = value
    }
    return out
  }

  /** Saves settings the plugin declares, checked against their types; other keys are refused. */
  setSettings(name: string, values: Record<string, unknown>) {
    const declared = this._get(name).settings
    const checked: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(values)) {
      const spec = declared[key]
      if (!spec) throw new Error(`${name} has no setting called ${key}`)
      if (typeof value !== spec.type) throw new Error(`${key} must be a ${spec.type}`)
      checked[key] = value as string | number | boolean
    }
    const state = this._readState()
    this._save({ ...state, settings: { ...state.settings, [name]: { ...state.settings[name], ...checked } } })
  }

  remove(name: string) {
    const plugin = this._get(name)
    rmSync(plugin.dir, { recursive: true, force: true })
    // A plugin added again later under this name starts switched on, with its defaults.
    const state = this._readState()
    const { [name]: _gone, ...settings } = state.settings
    const { [name]: _from, ...installed } = state.installed
    this._save({ disabled: state.disabled.filter((n) => n !== name), settings, installed })
  }

  private _get(name: string): PluginInfo {
    const plugin = this.list().find((p) => p.name === name)
    if (!plugin) throw new Error(`no plugin called ${name}`)
    return plugin
  }

  private _on(): PluginInfo[] {
    return this.list().filter((p) => p.enabled)
  }

  private _readState(): PluginState {
    try {
      const raw = readJson(this._state) as { disabled?: unknown; settings?: unknown; installed?: unknown }
      return {
        disabled: Array.isArray(raw.disabled)
          ? raw.disabled.filter((n): n is string => typeof n === 'string')
          : [],
        settings:
          raw.settings && typeof raw.settings === 'object' ? (raw.settings as PluginState['settings']) : {},
        installed:
          raw.installed && typeof raw.installed === 'object'
            ? (raw.installed as PluginState['installed'])
            : {},
      }
    } catch {
      return { disabled: [], settings: {}, installed: {} }
    }
  }

  private _save(state: PluginState) {
    // Settings may hold a plugin's API key.
    writeFileSync(this._state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  }

  /** `myrmidon.json`: the code's entry point and declared settings; a missing file means neither. */
  private _extras(dir: string): {
    server?: string
    ui?: string
    settings: Record<string, PluginSetting>
    error?: string
  } {
    const file = join(dir, 'myrmidon.json')
    const defaults = {
      ...(existsSync(join(dir, 'server', 'index.ts')) ? { server: 'server/index.ts' } : {}),
      ...(existsSync(join(dir, 'ui', 'index.tsx')) ? { ui: 'ui/index.tsx' } : {}),
    }
    if (!existsSync(file)) return { ...defaults, settings: {} }
    let raw: { server?: unknown; ui?: unknown; settings?: unknown }
    try {
      raw = readJson(file) as typeof raw
    } catch {
      return { ...defaults, settings: {}, error: 'myrmidon.json is not valid JSON' }
    }
    const server = typeof raw.server === 'string' ? raw.server : defaults.server
    const ui = typeof raw.ui === 'string' ? raw.ui : defaults.ui
    const settings: Record<string, PluginSetting> = {}
    for (const [key, spec] of Object.entries((raw.settings ?? {}) as Record<string, Partial<PluginSetting>>))
      if (spec && ['string', 'number', 'boolean'].includes(spec.type as string))
        settings[key] = spec as PluginSetting
    return { ...(server ? { server } : {}), ...(ui ? { ui } : {}), settings }
  }

  private _mcp(dir: string): Record<string, McpServerConfig> {
    const file = join(dir, '.mcp.json')
    if (!existsSync(file)) return {}
    const raw = readJson(file) as { mcpServers?: Record<string, McpServerConfig> } & Record<string, unknown>
    // Claude Code accepts the servers at the top level or under `mcpServers`.
    const servers = (raw.mcpServers ?? raw) as Record<string, McpServerConfig>
    return withRoot(
      Object.fromEntries(Object.entries(servers).filter(([, c]) => c && typeof c === 'object')),
      dir,
    )
  }

  /** `.claude-plugin/plugin.json`, read loosely: fields of the wrong type are left out. */
  private _manifest(dir: string): {
    name?: string
    version?: string
    description?: string
    author?: string
    error?: string
  } {
    const file = join(dir, '.claude-plugin', 'plugin.json')
    if (!existsSync(file)) return {}
    let raw: Record<string, unknown>
    try {
      raw = readJson(file) as Record<string, unknown>
    } catch {
      return { error: '.claude-plugin/plugin.json is not valid JSON' }
    }
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    const name = str(raw.name)
    const version = str(raw.version)
    const description = str(raw.description)
    // Claude Code's manifest gives the author as a string or as { name, email }.
    const author = str(raw.author) ?? str((raw.author as { name?: unknown } | undefined)?.name)
    return {
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
      ...(author ? { author } : {}),
    }
  }

  /** A plugin folder's manifest and parts; a part that cannot be read is noted, and the rest still count. */
  private _read(dir: string, enabled: boolean): PluginInfo {
    const manifest = this._manifest(dir)
    const extras = this._extras(dir)
    const errors: string[] = [manifest.error, extras.error].filter((e): e is string => !!e)
    // The store knows a plugin by its folder; the manifest's name only names a new install.
    const name = basename(dir)
    const skillsDir = join(dir, 'skills')
    const skills = existsSync(skillsDir)
      ? readdirSync(skillsDir).filter((s) => existsSync(join(skillsDir, s, 'SKILL.md')))
      : []
    const commandsDir = join(dir, 'commands')
    const commands: PluginCommand[] = existsSync(commandsDir)
      ? readdirSync(commandsDir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => {
            const c = parseCommand(readFileSync(join(commandsDir, f), 'utf8'))
            return {
              name: f.replace(/\.md$/, ''),
              plugin: name,
              description: c.description ?? c.body.split('\n')[0]?.slice(0, 100) ?? '',
              ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
              prompt: c.body,
            }
          })
      : []
    let hooks = 0
    const hooksFile = join(dir, 'hooks', 'hooks.json')
    if (existsSync(hooksFile))
      try {
        const config = checkedHooks(readJson(hooksFile))
        hooks = HOOK_EVENTS.reduce(
          (n, e) => n + (config.hooks[e] ?? []).reduce((m, g) => m + g.hooks.length, 0),
          0,
        )
      } catch {
        errors.push('hooks/hooks.json is not valid JSON')
      }
    let mcpServers: string[] = []
    try {
      mcpServers = Object.keys(this._mcp(dir))
    } catch {
      errors.push('.mcp.json is not valid JSON')
    }
    return {
      name,
      ...(manifest.version ? { version: manifest.version } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.author ? { author: manifest.author } : {}),
      dir,
      enabled,
      skills,
      commands,
      hooks,
      mcpServers,
      ...(extras.server ? { server: extras.server } : {}),
      ...(extras.ui ? { ui: extras.ui } : {}),
      settings: extras.settings,
      ...(errors.length ? { error: errors.join('; ') } : {}),
    }
  }
}
