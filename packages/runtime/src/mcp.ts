import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentTool } from '@oh-my-pi/pi-agent-core'
import { MCP_STARTUP_MS } from './config.ts'

/**
 * MCP servers as colony tools. omp's own MCP client does the work (stdio, streamable HTTP, SSE, OAuth, tool
 * naming and result conversion); this hub owns the configuration in `<agentDir>/mcp.json` (omp's format, so an
 * imported omp setup just works), keeps one connection per enabled server for the whole process, and hands the
 * tools to colonies.
 */

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServerConfig {
  readonly type?: McpTransport
  readonly command?: string
  readonly args?: string[]
  readonly env?: Record<string, string>
  readonly cwd?: string
  readonly url?: string
  readonly headers?: Record<string, string>
  readonly enabled?: boolean
  readonly timeout?: number
}

interface McpFile {
  mcpServers?: Record<string, McpServerConfig>
  disabledServers?: string[]
  [key: string]: unknown
}

export interface McpServerInfo {
  readonly name: string
  readonly transport: McpTransport
  /** The command line or URL, for display. */
  readonly target: string
  readonly enabled: boolean
  readonly status: 'connected' | 'connecting' | 'disconnected' | 'disabled' | 'error'
  readonly tools: string[]
  readonly error?: string
  /** Set for a server an enabled plugin adds; it is switched with its plugin, not on its own. */
  readonly plugin?: boolean
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/
/** Environment variables that look like credentials; MCP server processes do not inherit them. */
const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i

type Manager = {
  connectServers(
    configs: Record<string, unknown>,
    sources: Record<string, unknown>,
  ): Promise<{ errors: Map<string, string>; connectedServers: string[] }>
  getTools(): { name: string; label?: string; description: string }[]
  setOnToolsChanged(handler: () => void): void
  waitForStartup(timeoutMs: number): Promise<unknown>
  getConnectionStatus(name: string): 'connected' | 'connecting' | 'disconnected'
  disconnectServer(name: string): Promise<void>
  disconnectAll(): Promise<void>
}

export class McpHub {
  private readonly _file: string
  private _manager?: Manager
  private _adapters = new Map<string, AgentTool>()
  private readonly _errors = new Map<string, string>()
  private _starting?: Promise<void>

  /** Servers connected by the last start, so ones that went away (a plugin switched off) can be dropped. */
  private _connected = new Set<string>()

  constructor(
    readonly agentDir: string,
    /** Servers the person's enabled plugins add, already named apart from their own. */
    private readonly plugins: () => Record<string, McpServerConfig> = () => ({}),
  ) {
    this._file = join(agentDir, 'mcp.json')
  }

  private _read(): McpFile {
    if (!existsSync(this._file)) return {}
    try {
      return JSON.parse(readFileSync(this._file, 'utf8')) as McpFile
    } catch (err) {
      throw new Error(`mcp.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private _write(doc: McpFile) {
    mkdirSync(this.agentDir, { recursive: true, mode: 0o700 })
    const tmp = `${this._file}.${process.pid}.tmp`
    // May hold API keys in env or headers.
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this._file)
  }

  private _enabled(doc: McpFile, name: string): boolean {
    return doc.mcpServers?.[name]?.enabled !== false && !doc.disabledServers?.includes(name)
  }

  /**
   * The config handed to omp for one server. Stdio servers would otherwise inherit this process's whole
   * environment, provider API keys included; credential-looking variables are blanked unless the server's own
   * `env` sets them.
   */
  private _launchConfig(config: McpServerConfig): McpServerConfig {
    if ((config.type ?? 'stdio') !== 'stdio') return config
    const hidden = Object.keys(process.env).filter((k) => SECRET.test(k) && !(config.env && k in config.env))
    // omp drops empty env values unless they are marked literal, which would let the inherited value through.
    return {
      ...config,
      env: { ...Object.fromEntries(hidden.map((k) => [k, ''])), ...(config.env ?? {}) },
      envLiteralKeys: hidden,
    } as McpServerConfig
  }

  /** Connects every enabled server. Safe to call again; it reconnects only what changed. */
  start(): Promise<void> {
    this._starting ??= this._connect().finally(() => {
      this._starting = undefined
    })
    return this._starting
  }

  private async _connect() {
    const { MCPManager } = await import('@oh-my-pi/pi-coding-agent/mcp/manager')
    const { CustomToolAdapter } = await import('@oh-my-pi/pi-coding-agent/extensibility/custom-tools/wrapper')
    // No discovery: Myrmidon connects exactly the servers in its own mcp.json.
    this._manager ??= new MCPManager(this.agentDir, null, async () => ({
      configs: {},
      sources: {},
      exaApiKeys: [],
    })) as unknown as Manager
    // Slow servers finish loading their tools after connectServers returns; rebuild when they do.
    this._manager.setOnToolsChanged(() => this._rebuild(CustomToolAdapter))
    const doc = this._read()
    const configs: Record<string, unknown> = {}
    const sources: Record<string, unknown> = {}
    for (const [name, config] of Object.entries(doc.mcpServers ?? {})) {
      if (!this._enabled(doc, name)) continue
      configs[name] = this._launchConfig(config)
      sources[name] = { provider: 'myrmidon', providerName: 'Myrmidon', path: this._file, level: 'user' }
    }
    for (const [name, config] of Object.entries(this.plugins())) {
      if (name in configs || config.enabled === false) continue
      configs[name] = this._launchConfig(config)
      sources[name] = {
        provider: 'myrmidon',
        providerName: 'Myrmidon plugin',
        path: this._file,
        level: 'user',
      }
    }
    for (const gone of [...this._connected].filter((n) => !(n in configs)))
      await this._manager.disconnectServer(gone)
    this._connected = new Set(Object.keys(configs))
    this._errors.clear()
    if (Object.keys(configs).length > 0) {
      const result = await this._manager.connectServers(configs, sources)
      for (const [name, error] of result.errors) this._errors.set(name, error)
      await this._manager.waitForStartup(MCP_STARTUP_MS)
    }
    this._rebuild(CustomToolAdapter)
  }

  private _rebuild(Adapter: new (tool: never, context: () => never) => unknown) {
    if (!this._manager) return
    const context = () =>
      ({
        sessionManager: undefined,
        modelRegistry: undefined,
        model: undefined,
        isIdle: () => true,
        hasQueuedMessages: () => false,
        abort: () => {},
      }) as never
    this._adapters = new Map(
      this._manager.getTools().map((t) => [t.name, new Adapter(t as never, context) as unknown as AgentTool]),
    )
  }

  /** The connected servers' tools, ready for an agent. */
  tools(): AgentTool[] {
    return [...this._adapters.values()]
  }

  servers(): McpServerInfo[] {
    const doc = this._read()
    const toolNames = [...this._adapters.keys()]
    const fromPlugins = Object.entries(this.plugins()).filter(([name]) => !doc.mcpServers?.[name])
    const all = [...Object.entries(doc.mcpServers ?? {}), ...fromPlugins]
    const plugin = new Set(fromPlugins.map(([name]) => name))
    return all.map(([name, config]) => {
      const transport = config.type ?? 'stdio'
      const enabled = plugin.has(name) ? config.enabled !== false : this._enabled(doc, name)
      const error = this._errors.get(name)
      const live = this._manager?.getConnectionStatus(name) ?? 'disconnected'
      const prefix = `mcp__${name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_`
      return {
        name,
        transport,
        target:
          transport === 'stdio' ? [config.command, ...(config.args ?? [])].join(' ') : (config.url ?? ''),
        enabled,
        status: !enabled ? 'disabled' : error ? 'error' : live,
        tools: toolNames.filter((t) => t.startsWith(prefix)),
        ...(error ? { error } : {}),
        ...(plugin.has(name) ? { plugin: true } : {}),
      }
    })
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const doc = this._read()
    const config = doc.mcpServers?.[name]
    if (!config) throw new Error(`no MCP server named ${name}`)
    const { enabled: _was, ...rest } = config
    doc.mcpServers = { ...doc.mcpServers, [name]: enabled ? rest : { ...rest, enabled: false } }
    doc.disabledServers = (doc.disabledServers ?? []).filter((n) => n !== name)
    if (doc.disabledServers.length === 0) delete doc.disabledServers
    this._write(doc)
    if (!enabled) await this._manager?.disconnectServer(name)
    await this.start()
  }

  async add(name: string, config: McpServerConfig): Promise<void> {
    if (!SERVER_NAME.test(name))
      throw new Error('server name must be letters, digits, dot, dash or underscore')
    const transport = config.type ?? 'stdio'
    if (transport === 'stdio' && !config.command?.trim()) throw new Error('a stdio server needs a command')
    if (transport !== 'stdio' && !/^https?:\/\//.test(config.url ?? ''))
      throw new Error('an HTTP server needs an http(s) URL')
    const doc = this._read()
    if (doc.mcpServers?.[name]) throw new Error(`an MCP server named ${name} already exists`)
    doc.mcpServers = { ...doc.mcpServers, [name]: config }
    this._write(doc)
    await this.start()
  }

  async remove(name: string): Promise<void> {
    const doc = this._read()
    if (!doc.mcpServers?.[name]) throw new Error(`no MCP server named ${name}`)
    const { [name]: _gone, ...rest } = doc.mcpServers
    doc.mcpServers = rest
    this._write(doc)
    await this._manager?.disconnectServer(name)
    await this.start()
  }

  async close(): Promise<void> {
    await this._manager?.disconnectAll()
  }
}
