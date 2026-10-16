import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CDM_CALL_MS, CDM_START_MS, CDM_VERSION } from './config.ts'
import { leashRunning } from './leashed.ts'

/**
 * chrome-devtools-mcp (CDM), Google's MCP server for Chrome, as the engine under the agents' browser tools. It runs as
 * a Node child (it cannot run on Bun's runtime: it crashes parsing its arguments) attached to the Chrome Myrmidon
 * launched (`--browserUrl`), so the proxy, the leash and the guarded DevTools port stay ours. Agents never see its 32
 * tools: browser-agent.ts calls them for them. The client is the MCP stdio protocol itself (newline-delimited
 * JSON-RPC), which is all CDM needs.
 */

export interface CdmResult {
  readonly text: string
  readonly images: readonly { readonly data: string; readonly mimeType: string }[]
}

/** A tool CDM refused or failed: its own words, which the agent reads (a stale uid says so). */
export class CdmError extends Error {}

/**
 * The Node that runs CDM: MYR_NODE, the one shipped beside the desktop app's server (`node/bin/node` next to it),
 * or the system's. CDM needs Node ^20.19, ^22.12 or 23+.
 */
export function findNode(execPath: string = process.execPath): string | undefined {
  if (process.env.MYR_NODE && existsSync(process.env.MYR_NODE)) return process.env.MYR_NODE
  const exe = process.platform === 'win32' ? 'node.exe' : join('bin', 'node')
  const shipped = join(dirname(execPath), 'node', exe)
  if (existsSync(shipped)) return shipped
  return Bun.which('node') ?? undefined
}

/** CDM's entry script: shipped beside the desktop app's server, or the pinned package in node_modules. */
export function findCdm(execPath: string = process.execPath): string | undefined {
  if (process.env.MYR_CDM && existsSync(process.env.MYR_CDM)) return process.env.MYR_CDM
  const shipped = join(
    dirname(execPath),
    'chrome-devtools-mcp',
    'build',
    'src',
    'bin',
    'chrome-devtools-mcp.js',
  )
  if (existsSync(shipped)) return shipped
  try {
    const pkg = Bun.resolveSync('chrome-devtools-mcp/package.json', import.meta.dir)
    const script = join(dirname(pkg), 'build', 'src', 'bin', 'chrome-devtools-mcp.js')
    return existsSync(script) ? script : undefined
  } catch {
    return undefined
  }
}

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** One CDM process, started on first call and started again after it dies. */
export class CdmClient {
  private _proc?: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  private _leash?: { stdin: { end(): unknown } }
  private _ready?: Promise<void>
  private _ids = 0
  private readonly _pending = new Map<number, Pending>()
  private _stderr = ''
  private _generation = 0

  constructor(
    private readonly args: readonly string[],
    private readonly node = findNode(),
    private readonly script = findCdm(),
  ) {}

  /** Counts the engine's starts: page ids belong to one start, and a new start numbers its pages anew. */
  get generation(): number {
    return this._generation
  }

  /** Why CDM cannot run here, or undefined when it can. */
  get missing(): string | undefined {
    if (!this.node) return 'Node.js is not installed (the browser engine needs Node 20.19 or later)'
    if (!this.script) return `chrome-devtools-mcp ${CDM_VERSION} is not installed`
    return undefined
  }

  private _start(): Promise<void> {
    const missing = this.missing
    if (missing) return Promise.reject(new Error(missing))
    this._ready ??= (async () => {
      // Its stdin is the protocol, so the leash watches it from outside (as it does puppeteer's Chrome); CDM also exits
      // when its stdin closes.
      const proc = Bun.spawn([this.node as string, this.script as string, ...this.args], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
        env: {
          ...process.env,
          CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
          CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
          // CDM's own warnings about Node's experimental storage are noise on its stderr.
          NODE_NO_WARNINGS: '1',
        },
      })
      this._proc = proc
      this._generation++
      this._leash = leashRunning(proc.pid)
      void this._read(proc.stdout)
      void (async () => {
        for await (const chunk of proc.stderr)
          this._stderr = (this._stderr + new TextDecoder().decode(chunk)).slice(-4000)
      })()
      void proc.exited.then(() => {
        if (this._proc !== proc) return
        this._proc = undefined
        this._leash?.stdin.end()
        this._ready = undefined
        const why = new CdmError(
          `the browser engine stopped${this._stderr ? `: ${this._stderr.trim().split('\n').at(-1)}` : ''}`,
        )
        for (const p of this._pending.values()) {
          clearTimeout(p.timer)
          p.reject(why)
        }
        this._pending.clear()
      })
      await this._request(
        'initialize',
        {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'myrmidon', version: '1' },
        },
        CDM_START_MS,
      )
      this._notify('notifications/initialized', {})
    })()
    this._ready.catch(() => {
      this._ready = undefined
      this._proc?.stdin.end()
      this._proc = undefined
    })
    return this._ready
  }

  private async _read(stdout: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (line) this._message(line)
      }
    }
  }

  private _message(line: string) {
    let msg: { id?: number | string; result?: unknown; error?: { message?: string }; method?: string }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    // A request from the server: this client offers none of the capabilities it would ask for.
    if (msg.method && msg.id !== undefined) {
      this._send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } })
      return
    }
    if (typeof msg.id !== 'number') return
    const pending = this._pending.get(msg.id)
    if (!pending) return
    this._pending.delete(msg.id)
    clearTimeout(pending.timer)
    if (msg.error) pending.reject(new CdmError(msg.error.message ?? 'browser engine error'))
    else pending.resolve(msg.result)
  }

  private _send(msg: unknown) {
    this._proc?.stdin.write(`${JSON.stringify(msg)}\n`)
    void this._proc?.stdin.flush()
  }

  private _notify(method: string, params: unknown) {
    this._send({ jsonrpc: '2.0', method, params })
  }

  private _request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = ++this._ids
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(
          new CdmError(`the browser engine did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`),
        )
      }, timeoutMs)
      this._pending.set(id, { resolve, reject, timer })
      this._send({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Calls one CDM tool; a tool error (isError) throws CdmError with CDM's own words. */
  async call(name: string, args: Record<string, unknown>, timeoutMs = CDM_CALL_MS): Promise<CdmResult> {
    await this._start()
    const result = (await this._request('tools/call', { name, arguments: args }, timeoutMs)) as {
      content?: { type: string; text?: string; data?: string; mimeType?: string }[]
      isError?: boolean
    }
    const content = result.content ?? []
    const text = content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')
    if (result.isError) throw new CdmError(text || `${name} failed`)
    return {
      text,
      images: content
        .filter((c) => c.type === 'image' && c.data)
        .map((c) => ({ data: c.data as string, mimeType: c.mimeType ?? 'image/png' })),
    }
  }

  /** The tools CDM offers, for the version check in tests. */
  async tools(): Promise<string[]> {
    await this._start()
    const result = (await this._request('tools/list', {}, CDM_CALL_MS)) as { tools?: { name: string }[] }
    return (result.tools ?? []).map((t) => t.name)
  }

  close(): void {
    const proc = this._proc
    this._proc = undefined
    this._ready = undefined
    proc?.stdin.end()
    this._leash?.stdin.end()
  }
}
