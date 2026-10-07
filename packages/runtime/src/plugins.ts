import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { PluginCommand } from '@myrmidon/protocol'
import { git } from './git.ts'
import { checkedHooks, HOOK_EVENTS, type HookGroup, type HooksConfig } from './hooks.ts'
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
  /** Set when a part could not be read; the rest of the plugin still loads. */
  readonly error?: string
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/

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
  private readonly _state: string

  constructor(home: string) {
    this.dir = join(home, 'plugins')
    this._state = join(home, 'plugins.json')
  }

  list(): PluginInfo[] {
    if (!existsSync(this.dir)) return []
    const disabled = new Set(this._disabled())
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => this._read(join(this.dir, e.name), !disabled.has(e.name)))
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
   * Adds a plugin from a folder (copied) or a git URL (cloned). It is named by its manifest, or else by the folder
   * or repository, and starts enabled: the person chose to add it.
   */
  async install(source: string): Promise<PluginInfo> {
    const from = source.trim()
    if (!from) throw new Error('give a folder or a git URL')
    const isGit = /^(https?:\/\/|git@|ssh:\/\/)/.test(from) || from.endsWith('.git')
    mkdirSync(this.dir, { recursive: true })
    const staging = join(this.dir, `.adding-${Date.now()}`)
    try {
      if (isGit) await git(this.dir, ['clone', '--depth', '1', '--quiet', from, staging])
      else {
        const path = resolve(from.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
        if (!existsSync(path)) throw new Error(`no folder at ${path}`)
        cpSync(path, staging, { recursive: true, filter: (p) => !p.includes(`${join(path, '.git')}`) })
      }
      rmSync(join(staging, '.git'), { recursive: true, force: true })
      const found = this._read(staging, true)
      const name = (
        this._manifest(staging).name ?? basename(from.replace(/\.git$/, '').replace(/\/+$/, ''))
      ).toLowerCase()
      if (!NAME.test(name)) throw new Error(`"${name}" is not a usable plugin name (a-z, 0-9 and -)`)
      if (!found.skills.length && !found.commands.length && !found.hooks && !found.mcpServers.length)
        throw new Error('this has no skills, commands, hooks or MCP servers, so it is not a plugin')
      const target = join(this.dir, name)
      if (existsSync(target)) throw new Error(`a plugin called ${name} is already installed`)
      renameSync(staging, target)
      this.setEnabled(name, true)
      return this._read(target, true)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  setEnabled(name: string, enabled: boolean) {
    this._get(name)
    const disabled = new Set(this._disabled())
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    writeFileSync(this._state, `${JSON.stringify({ disabled: [...disabled].sort() }, null, 2)}\n`)
  }

  remove(name: string) {
    const plugin = this._get(name)
    rmSync(plugin.dir, { recursive: true, force: true })
    // A plugin added again later under this name starts switched on.
    const disabled = this._disabled().filter((n) => n !== name)
    writeFileSync(this._state, `${JSON.stringify({ disabled }, null, 2)}\n`)
  }

  private _get(name: string): PluginInfo {
    const plugin = this.list().find((p) => p.name === name)
    if (!plugin) throw new Error(`no plugin called ${name}`)
    return plugin
  }

  private _on(): PluginInfo[] {
    return this.list().filter((p) => p.enabled)
  }

  private _disabled(): string[] {
    try {
      const raw = readJson(this._state) as { disabled?: unknown }
      return Array.isArray(raw.disabled) ? raw.disabled.filter((n): n is string => typeof n === 'string') : []
    } catch {
      return []
    }
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
    const errors: string[] = manifest.error ? [manifest.error] : []
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
      ...(errors.length ? { error: errors.join('; ') } : {}),
    }
  }
}
