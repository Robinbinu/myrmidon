import { type FSWatcher, mkdirSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MyrEvent } from '@myrmidon/protocol'
import type { AgentTool, AgentToolResult } from '@oh-my-pi/pi-agent-core'
import type { ChannelKind } from './channels/hub.ts'
import type { PluginInfo, PluginStore } from './plugins.ts'

/**
 * Plugins with code of their own: `server/index.ts` exports `activate(ctx)`, and what it registers through `ctx`
 * (tools, prompt sections, event listeners) is undone when the plugin is switched off or its files change, as
 * DeepSeek Harness's plugins are. The code is bundled with Bun and imported in this process, so it runs as the
 * person, which is why only the person switches a plugin on.
 */

/** A tool a plugin offers agents; it is named `<plugin>_<name>` so it never shadows Myrmidon's own. */
export interface PluginToolDefinition {
  readonly name: string
  readonly description: string
  /** JSON Schema of the arguments (an object schema). */
  readonly parameters?: Record<string, unknown>
  run(args: Record<string, unknown>, call: PluginCall): Promise<PluginToolResult> | PluginToolResult
}

export type PluginToolResult = string | { readonly text: string; readonly isError?: boolean }

/** Where a tool call comes from. */
export interface PluginCall {
  readonly colonyId: string
  readonly agent: string
  readonly signal?: AbortSignal
}

/** Which agents a prompt section reaches: the agent that leads or speaks, workers and peers, or everyone. */
export type PromptScope = 'lead' | 'worker' | 'all'

/** What `activate(ctx)` receives. Everything registered through it is removed when the plugin unloads. */
export interface PluginContext {
  readonly name: string
  /** The plugin's folder. */
  readonly dir: string
  readonly tools: { add(tool: PluginToolDefinition): void }
  readonly prompts: { add(section: string, text: string, scope?: PromptScope): void }
  readonly events: {
    /** Every event appended to any colony's log, `*` for all types. Read-only. */
    on(type: string, listener: (event: MyrEvent, colonyId: string) => void | Promise<void>): void
    /** Adds a `plugin/event` to a colony's log, for the UI and other plugins to see. */
    emit(colonyId: string, type: string, data: Record<string, unknown>): Promise<void>
  }
  /**
   * Messaging platforms the plugin adds (WhatsApp, Discord…), by id: they appear in Settings → Channels and run
   * through Myrmidon's channel hub, which handles who may talk, conversations, approvals and delivery.
   */
  readonly channels: { register(id: string, kind: ChannelKind): void }
  /** The plugin's settings, as the person set them in Settings → Plugins, with the manifest's defaults. */
  readonly settings: { get(): Record<string, unknown> }
  /** A line in the plugin's log, shown in its row in Settings. */
  log(message: string): void
  /** Runs when the plugin unloads: stop timers, close connections. */
  onDispose(dispose: () => void | Promise<void>): void
}

interface Loaded {
  readonly tools: PluginToolDefinition[]
  readonly prompts: { section: string; text: string; scope: PromptScope }[]
  readonly listeners: { type: string; run: (event: MyrEvent, colonyId: string) => void | Promise<void> }[]
  readonly channels: Record<string, ChannelKind>
  readonly disposers: (() => void | Promise<void>)[]
  readonly module?: { deactivate?: () => void | Promise<void> }
}

export interface PluginStatus {
  readonly loaded: boolean
  readonly error?: string
  readonly tools: readonly string[]
  readonly log: readonly string[]
}

const LOG_LINES = 50
/** Saving a file usually touches it more than once; a reload waits for the burst to end. */
const RELOAD_DEBOUNCE_MS = 300

export class PluginHost {
  private readonly _loaded = new Map<string, Loaded>()
  private readonly _errors = new Map<string, string>()
  private readonly _logs = new Map<string, string[]>()
  private readonly _watchers = new Map<string, FSWatcher>()
  private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly _buildDir: string
  /** Tools Myrmidon itself adds through the host (not a plugin's), by owner. */
  private readonly _builtIn = new Map<string, PluginToolDefinition[]>()
  private readonly _changed = new Set<() => void>()
  private _append?: (
    colonyId: string,
    type: string,
    data: Record<string, unknown>,
    plugin: string,
  ) => Promise<void>

  constructor(readonly store: PluginStore) {
    this._buildDir = join(store.dir, '.build')
  }

  /** How plugins add events to a colony's log; set by whoever owns the logs. */
  attach(
    append: (colonyId: string, type: string, data: Record<string, unknown>, plugin: string) => Promise<void>,
  ) {
    this._append = append
  }

  /** Loads every enabled plugin that has code, and reloads one when its files change. */
  async start(): Promise<void> {
    await this.sync()
  }

  /** Brings loaded plugins in line with the store: loads what is on, unloads what is off or gone. */
  async sync(): Promise<void> {
    const plugins = this.store.list()
    const wanted = new Map(plugins.filter((p) => p.enabled && p.server).map((p) => [p.name, p]))
    for (const name of [...this._loaded.keys(), ...this._watchers.keys()])
      if (!wanted.has(name)) await this.unload(name)
    for (const plugin of wanted.values()) {
      if (!this._loaded.has(plugin.name) && !this._errors.has(plugin.name)) await this.load(plugin)
      this._watch(plugin)
    }
  }

  async load(plugin: PluginInfo): Promise<void> {
    await this._dispose(plugin.name)
    this._errors.delete(plugin.name)
    if (!plugin.server) return
    const loaded: Loaded & { module?: Loaded['module'] } = {
      tools: [],
      prompts: [],
      listeners: [],
      channels: {},
      disposers: [],
    }
    const ctx = this._context(plugin, loaded)
    try {
      const module = (await import(await this._bundle(plugin))) as {
        activate?: (ctx: PluginContext) => unknown
        deactivate?: () => void | Promise<void>
      }
      if (typeof module.activate !== 'function') throw new Error('server/index.ts must export activate(ctx)')
      await module.activate(ctx)
      this._loaded.set(plugin.name, { ...loaded, module })
      this._notify()
      this._log(
        plugin.name,
        `loaded: ${loaded.tools.length} tool(s), ${loaded.prompts.length} prompt section(s)`,
      )
    } catch (err) {
      for (const dispose of loaded.disposers) await Promise.resolve(dispose()).catch(() => {})
      const message = err instanceof Error ? err.message : String(err)
      this._errors.set(plugin.name, message)
      this._log(plugin.name, `failed to load: ${message}`)
    }
  }

  async unload(name: string): Promise<void> {
    this._watchers.get(name)?.close()
    this._watchers.delete(name)
    clearTimeout(this._timers.get(name))
    this._timers.delete(name)
    this._errors.delete(name)
    await this._dispose(name)
  }

  async stop(): Promise<void> {
    for (const name of new Set([...this._loaded.keys(), ...this._watchers.keys()])) await this.unload(name)
  }

  /** The loaded plugins' tools, and Myrmidon's own added here, bound to the colony and agent that will call them. */
  tools(call: Omit<PluginCall, 'signal'>): AgentTool[] {
    return [
      ...[...this._builtIn].flatMap(([owner, tools]) =>
        tools.map((tool) => this._agentTool(owner, tool, call, true)),
      ),
      ...[...this._loaded].flatMap(([plugin, loaded]) =>
        loaded.tools.map((tool) => this._agentTool(plugin, tool, call)),
      ),
    ]
  }

  /** Adds Myrmidon's own tools under an owner's name (`<owner>_<tool>`), e.g. the channels' send tool. */
  addBuiltIn(owner: string, tools: PluginToolDefinition[]) {
    this._builtIn.set(owner, tools)
  }

  /** Messaging platforms the loaded plugins add, by id. */
  channelKinds(): Record<string, ChannelKind> {
    return Object.assign({}, ...[...this._loaded.values()].map((l) => l.channels))
  }

  /** Runs `listener` whenever plugins load or unload; returns the undo. */
  onChange(listener: () => void): () => void {
    this._changed.add(listener)
    return () => this._changed.delete(listener)
  }

  private _notify() {
    for (const listener of this._changed) listener()
  }

  /** Prompt sections for an agent that leads (or speaks) or one that works. */
  prompts(role: 'lead' | 'worker'): string[] {
    return [...this._loaded.values()].flatMap((l) =>
      l.prompts.filter((p) => p.scope === 'all' || p.scope === role).map((p) => `## ${p.section}\n${p.text}`),
    )
  }

  /** Hands new log events to the plugins listening for them; a listener's failure stays in its plugin's log. */
  dispatch(colonyId: string, events: readonly MyrEvent[]) {
    for (const [plugin, loaded] of this._loaded)
      for (const event of events)
        for (const l of loaded.listeners)
          if (l.type === '*' || l.type === event.type)
            Promise.resolve()
              .then(() => l.run(event, colonyId))
              .catch((err) => this._log(plugin, `listener for ${event.type} failed: ${String(err)}`))
  }

  status(name: string): PluginStatus {
    const loaded = this._loaded.get(name)
    const error = this._errors.get(name)
    return {
      loaded: loaded !== undefined,
      ...(error ? { error } : {}),
      tools: loaded?.tools.map((t) => `${name}_${t.name}`) ?? [],
      log: this._logs.get(name) ?? [],
    }
  }

  private _context(plugin: PluginInfo, loaded: Loaded): PluginContext {
    return {
      name: plugin.name,
      dir: plugin.dir,
      tools: {
        add: (tool) => {
          if (!/^[a-z][a-z0-9_]{0,40}$/.test(tool.name))
            throw new Error(`tool name ${JSON.stringify(tool.name)} must be a-z, 0-9 and _`)
          if (typeof tool.run !== 'function') throw new Error(`tool ${tool.name} needs a run function`)
          loaded.tools.push(tool)
        },
      },
      prompts: { add: (section, text, scope = 'all') => loaded.prompts.push({ section, text, scope }) },
      events: {
        on: (type, run) => loaded.listeners.push({ type, run }),
        emit: async (colonyId, type, data) => {
          if (!this._append) throw new Error('events cannot be emitted here')
          await this._append(colonyId, type, data, plugin.name)
        },
      },
      channels: {
        register: (id, kind) => {
          if (!/^[a-z][a-z0-9-]{1,30}$/.test(id))
            throw new Error(`channel id ${JSON.stringify(id)} must be a-z, 0-9 and -`)
          if (typeof kind?.make !== 'function') throw new Error(`channel ${id} needs a make function`)
          loaded.channels[id] = kind
        },
      },
      settings: { get: () => this.store.settings(plugin.name) },
      log: (message) => this._log(plugin.name, message),
      onDispose: (dispose) => loaded.disposers.push(dispose),
    }
  }

  private _agentTool(
    plugin: string,
    tool: PluginToolDefinition,
    call: Omit<PluginCall, 'signal'>,
    builtIn = false,
  ): AgentTool {
    const name = `${plugin}_${tool.name}`
    return {
      name,
      label: name,
      description: builtIn ? tool.description : `${tool.description} (from the ${plugin} plugin)`,
      parameters: (tool.parameters ?? { type: 'object', properties: {} }) as never,
      intent: 'omit',
      approval: 'write',
      execute: async (_callId: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult> => {
        const out = await tool.run((params ?? {}) as Record<string, unknown>, {
          ...call,
          ...(signal ? { signal } : {}),
        })
        const r = typeof out === 'string' ? { text: out } : out
        return { content: [{ type: 'text', text: r.text }], isError: r.isError === true } as AgentToolResult
      },
    } as AgentTool
  }

  /**
   * Bundles the plugin's code into one module, in a folder of its own per build: Bun remembers a folder's files once
   * it has resolved an import there, so a new file in an old folder can look missing, and a new path is never a
   * stale cache.
   */
  private async _bundle(plugin: PluginInfo): Promise<string> {
    const built = await Bun.build({ entrypoints: [join(plugin.dir, plugin.server ?? '')], target: 'bun' })
    if (!built.success) throw new Error(built.logs.map((l) => l.message).join('\n') || 'the build failed')
    const out = built.outputs[0]
    if (!out) throw new Error('the build produced nothing')
    mkdirSync(this._buildDir, { recursive: true })
    for (const old of readdirSync(this._buildDir))
      if (old.startsWith(`${plugin.name}-`))
        rmSync(join(this._buildDir, old), { recursive: true, force: true })
    const folder = join(this._buildDir, `${plugin.name}-${Date.now()}`)
    mkdirSync(folder)
    const file = join(folder, 'index.js')
    writeFileSync(file, await out.text())
    return file
  }

  private async _dispose(name: string) {
    const loaded = this._loaded.get(name)
    if (!loaded) return
    this._loaded.delete(name)
    this._notify()
    for (const dispose of [
      ...loaded.disposers,
      ...(loaded.module?.deactivate ? [loaded.module.deactivate] : []),
    ])
      await Promise.resolve()
        .then(dispose)
        .catch((err) => this._log(name, `cleanup failed: ${String(err)}`))
  }

  private _watch(plugin: PluginInfo) {
    if (this._watchers.has(plugin.name)) return
    try {
      const watcher = watch(plugin.dir, { recursive: true }, (_event, file) => {
        if (String(file ?? '').startsWith('.')) return
        clearTimeout(this._timers.get(plugin.name))
        this._timers.set(
          plugin.name,
          setTimeout(() => {
            const fresh = this.store.list().find((p) => p.name === plugin.name)
            if (fresh?.enabled) void this.load(fresh)
          }, RELOAD_DEBOUNCE_MS),
        )
      })
      this._watchers.set(plugin.name, watcher)
    } catch (err) {
      this._log(plugin.name, `cannot watch for changes: ${String(err)}`)
    }
  }

  private _log(name: string, message: string) {
    const lines = this._logs.get(name) ?? []
    lines.push(`${new Date().toISOString().slice(11, 19)} ${message}`)
    this._logs.set(name, lines.slice(-LOG_LINES))
  }
}
