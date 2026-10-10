/**
 * Cua Driver (trycua/cua, MIT) on this Mac: the background computer-use driver agents see and control the person's
 * desktop through. Myrmidon installs it on demand from Settings (or uses one the person installed), runs its daemon
 * in embedded mode as a direct child, so macOS's Screen Recording and Accessibility grants are Myrmidon's (the desktop
 * app, or the terminal running the server) rather than a second app's, and talks to it as an MCP server (`cua-driver
 * mcp`) through the MCP hub. It also keeps who drives which app: one agent per app, one at a time in the foreground.
 */

import { dlopen, FFIType } from 'bun:ffi'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core'
import {
  COMPUTER_CALL_MS,
  COMPUTER_LOCK_WAIT_MS,
  COMPUTER_OVERLAY_SEEN_MS,
  COMPUTER_START_MS,
  CUA_DRIVER_BYTES,
  CUA_DRIVER_FALLBACK_ENV,
  CUA_DRIVER_PATHS,
  CUA_DRIVER_SHA256,
  CUA_DRIVER_URL,
  CUA_DRIVER_VERSION,
} from '../config.ts'
import { spawnLeashed } from '../leashed.ts'
import type { McpHub } from '../mcp.ts'
import { socketPath } from '../voice/stt.ts'
import { DESKTOP_GRANT, DesktopEngine } from './desktop.ts'

/** The internal MCP server's name, so its tools are `mcp__myrmidon_computer_<tool>`. */
export const COMPUTER_SERVER = 'myrmidon-computer'

/** What agents drive the Mac through: Cua Driver (one approved app at a time), or omp's desktop engine (scripts). */
export type ComputerEngine = 'cua' | 'omp'

export type DriverState =
  | { state: 'unsupported' }
  | { state: 'missing' }
  | { state: 'installing'; received: number; total: number }
  | { state: 'ready' }
  | { state: 'starting' }
  | { state: 'running' }
  | { state: 'error'; error: string }

export interface DriverInfo {
  readonly path: string
  readonly version?: string
  /** Installed by Myrmidon (into its home), not by the person. */
  readonly own: boolean
}

/** The macOS privacy grants computer use needs, as macOS answers for Myrmidon's process. */
export interface Grants {
  readonly accessibility: boolean
  readonly screenRecording: boolean
}

/** Who drives an app: one agent of one round. */
export interface Holder {
  readonly colonyId: string
  readonly agent: string
  readonly chatId?: string
}

export interface Control extends Holder {
  readonly app: string
  readonly bundleId: string
  readonly since: number
}

/** Where an agent last acted on the screen, in screen points (origin top-left), for the desktop app's overlay. */
export interface Pointer extends Holder {
  readonly x: number
  readonly y: number
  readonly action: 'move' | 'click' | 'type' | 'scroll' | 'drag'
  readonly at: number
}

/** A driver tool's answer: its text, images and structured content. */
export interface DriverResult {
  readonly text: string
  readonly images: { data: string; mimeType: string }[]
  readonly structured?: Record<string, unknown>
  readonly isError: boolean
}

/** What a wait for the desktop ends with when the person stops computer use (see `beforeControl`). */
export class ComputerStopped extends Error {
  constructor() {
    super('the person stopped computer use')
  }
}

/** One wait for the desktop: `ended` once Stop reached it, even if a new round of its chat has started since. */
export interface Wait {
  readonly ended: boolean
}

const FOREGROUND = '\0foreground'
/** Locks of agents running omp desktop scripts, which hold the whole desktop rather than one app. */
const DESKTOP = '\0desktop'
const same = (a: Holder, b: Holder) => a.colonyId === b.colonyId && a.agent === b.agent

/**
 * The environment a driver gets: Myrmidon's own for the release it pinned, only the basics (CUA_DRIVER_FALLBACK_ENV)
 * for one the person installed, whatever it is.
 */
function driverEnv(
  info: Pick<DriverInfo, 'own'>,
  extra: Record<string, string>,
): Record<string, string | undefined> {
  const base = info.own
    ? process.env
    : Object.fromEntries(
        CUA_DRIVER_FALLBACK_ENV.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
      )
  return { ...base, ...extra }
}

/** The macOS privacy grants of this process, read without asking (bun:ffi), or undefined off macOS. */
export function readGrants(): Grants | undefined {
  if (process.platform !== 'darwin') return undefined
  try {
    const ax = dlopen('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices', {
      AXIsProcessTrusted: { args: [], returns: FFIType.bool },
    })
    const cg = dlopen('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics', {
      CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool },
    })
    const grants = {
      accessibility: !!ax.symbols.AXIsProcessTrusted(),
      screenRecording: !!cg.symbols.CGPreflightScreenCaptureAccess(),
    }
    ax.close()
    cg.close()
    return grants
  } catch {
    return undefined
  }
}

/** Asks macOS for Screen Recording (its own dialog, once); Accessibility has no such request, only its Settings pane. */
export function requestScreenRecording(): boolean {
  if (process.platform !== 'darwin') return false
  const cg = dlopen('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics', {
    CGRequestScreenCaptureAccess: { args: [], returns: FFIType.bool },
  })
  const granted = !!cg.symbols.CGRequestScreenCaptureAccess()
  cg.close()
  return granted
}

/** System Settings' privacy panes, for the person to grant what is missing. */
export const PRIVACY_PANES = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
} as const

export class ComputerHub {
  private readonly _dir: string
  private _state: DriverState
  private _info?: DriverInfo
  private _daemon?: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  private _ready?: Promise<void>
  private readonly _locks = new Map<string, Control>()
  private readonly _stops = new Map<string, () => void>()
  /** Rounds the person stopped: they may not use the computer again. */
  private readonly _stopped = new Set<string>()
  /** Rounds about to drive the desktop (on an app's card, waiting for the app), and how to end each wait. */
  private readonly _waiting = new Map<string, Set<() => void>>()
  /** Where each agent last acted, by `colonyId/agent`. */
  private readonly _pointers = new Map<string, Pointer>()
  /** When the desktop app's overlay last asked for the pointers: while it does, it draws the agents' cursors. */
  private _overlaySeen = 0
  /** Whether the driver draws its own cursor for each session, as last set. */
  private readonly _driverCursor = new Map<string, boolean>()
  /** omp's desktop engine, for Settings → Computer use → Engine set to it. */
  readonly desktop: DesktopEngine

  constructor(
    home: string,
    private readonly options: {
      readonly mcp?: McpHub
      /** Settings → Computer use is switched on. */
      readonly enabled: () => boolean
      readonly log?: (line: string) => void
      /** Where to look for a driver the person installed (tests point this at a stand-in). */
      readonly paths?: readonly string[]
      /** The platform, for tests. */
      readonly platform?: NodeJS.Platform
      /** The bundle id of the app Myrmidon runs in, when known (the desktop app), told to the driver. */
      readonly hostBundleId?: string
      readonly download?: string
      readonly sha256?: string
      /** How macOS's grants are read (tests give a stand-in). */
      readonly grants?: () => Grants | undefined
      /** Settings → Computer use → Engine; Cua Driver when absent. */
      readonly engine?: () => ComputerEngine
      /** omp's desktop engine (tests give one with a stand-in worker). */
      readonly desktop?: DesktopEngine
    },
  ) {
    this._dir = join(home, 'computer')
    this._state = this._found()
    this.desktop = options.desktop ?? new DesktopEngine()
  }

  get engine(): ComputerEngine {
    return this.options.engine?.() ?? 'cua'
  }

  get supported(): boolean {
    return (this.options.platform ?? process.platform) === 'darwin'
  }

  /** Computer use is on and could run here: switched on, on macOS, with a driver. */
  get available(): boolean {
    return this.options.enabled() && this.supported && this.driver() !== undefined
  }

  get enabled(): boolean {
    return this.options.enabled()
  }

  /** Screen Recording and Accessibility, as macOS answers for Myrmidon (whose child the driver's daemon is). */
  grants(): Grants | undefined {
    return (this.options.grants ?? readGrants)()
  }

  /** The driver binary to run: Myrmidon's own install first, then one the person installed. */
  driver(): DriverInfo | undefined {
    if (this._info && existsSync(this._info.path)) return this._info
    const own = join(this._dir, CUA_DRIVER_VERSION, 'cua-driver')
    if (existsSync(own)) {
      this._info = { path: own, version: CUA_DRIVER_VERSION, own: true }
      return this._info
    }
    for (const raw of this.options.paths ?? CUA_DRIVER_PATHS) {
      const path = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
      if (existsSync(path)) {
        const version = driverVersion(path, { own: false })
        this._info = { path, own: false, ...(version ? { version } : {}) }
        return this._info
      }
    }
    this._info = undefined
    return undefined
  }

  private _found(): DriverState {
    if (!this.supported) return { state: 'unsupported' }
    return this.driver() ? { state: 'ready' } : { state: 'missing' }
  }

  status(): DriverState {
    if (this._state.state === 'ready' || this._state.state === 'missing') this._state = this._found()
    return this._state
  }

  /** What an install downloads, and which release, so Settings can say so first. */
  get downloadBytes(): number {
    return CUA_DRIVER_BYTES
  }

  get installVersion(): string {
    return CUA_DRIVER_VERSION
  }

  /**
   * Downloads the pinned Cua Driver release into `<home>/computer/<version>` and checks it against its sha256; a
   * partial or mismatching download is thrown away. `status()` shows its progress meanwhile.
   */
  async install(): Promise<void> {
    if (!this.supported) throw new Error('computer use runs on macOS only')
    if (this._state.state === 'installing') return
    this._state = { state: 'installing', received: 0, total: CUA_DRIVER_BYTES }
    const work = join(this._dir, `.install-${process.pid}`)
    try {
      rmSync(work, { recursive: true, force: true })
      mkdirSync(work, { recursive: true, mode: 0o700 })
      const res = await fetch(this.options.download ?? CUA_DRIVER_URL)
      if (!res.ok || !res.body) throw new Error(`downloading Cua Driver failed (HTTP ${res.status})`)
      const archive = join(work, 'cua-driver.tar.gz')
      const file = Bun.file(archive).writer()
      const hash = createHash('sha256')
      let received = 0
      for await (const chunk of res.body) {
        hash.update(chunk)
        file.write(chunk)
        received += chunk.byteLength
        this._state = { state: 'installing', received, total: CUA_DRIVER_BYTES }
      }
      await file.end()
      const got = hash.digest('hex')
      if (got !== (this.options.sha256 ?? CUA_DRIVER_SHA256))
        throw new Error(`the Cua Driver download did not match its sha256 (${got})`)
      const tar = Bun.spawnSync(['tar', '-xzf', archive, '-C', work], { stderr: 'pipe' })
      if (tar.exitCode !== 0) throw new Error(`unpacking Cua Driver failed: ${tar.stderr.toString().trim()}`)
      const binary = findBinary(work)
      if (!binary) throw new Error('the Cua Driver download has no cua-driver binary')
      chmodSync(binary, 0o755)
      const dest = join(this._dir, CUA_DRIVER_VERSION)
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dest, { recursive: true, mode: 0o700 })
      renameSync(binary, join(dest, 'cua-driver'))
      this._info = undefined
      this._state = { state: 'ready' }
    } catch (err) {
      this._state = { state: 'error', error: err instanceof Error ? err.message : String(err) }
      throw err
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  /** Starts the driver's daemon and connects its MCP server, if they are not running. */
  ensure(): Promise<void> {
    this._ready ??= this._start().catch((err) => {
      this._ready = undefined
      void this.stop()
      this._state = { state: 'error', error: err instanceof Error ? err.message : String(err) }
      throw err
    })
    return this._ready
  }

  private async _start(): Promise<void> {
    if (!this.options.enabled()) throw new Error('computer use is switched off in Settings → Computer use')
    const info = this.driver()
    if (!info) throw new Error('Cua Driver is not installed: install it in Settings → Computer use')
    if (!this.options.mcp) throw new Error('computer use needs the MCP hub')
    this._state = { state: 'starting' }
    mkdirSync(this._dir, { recursive: true, mode: 0o700 })
    const socket = socketPath(join(this._dir, 'driver.sock'))
    rmSync(socket, { force: true })
    // Embedded: the daemon stays in Myrmidon's responsibility chain, so macOS asks about and attributes the grants to
    // Myrmidon, and the driver never raises a dialog of its own. Telemetry is off: Myrmidon is local-first.
    const env = {
      CUA_DRIVER_EMBEDDED: '1',
      DO_NOT_TRACK: '1',
      ...(this.options.hostBundleId ? { CUA_DRIVER_HOST_BUNDLE_ID: this.options.hostBundleId } : {}),
    }
    if (!info.own)
      this.options.log?.(
        `cua-driver: running your own install at ${info.path}, not the release Myrmidon pinned, with a minimal environment`,
      )
    const daemon = spawnLeashed([info.path, 'serve', '--embedded', '--socket', socket], {
      env: driverEnv(info, env),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this._daemon = daemon
    let output = ''
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        const text = new TextDecoder().decode(chunk)
        output = (output + text).slice(-2_000)
        for (const line of text.split('\n')) if (line.trim()) this.options.log?.(`cua-driver: ${line.trim()}`)
      }
    }
    void drain(daemon.stdout)
    void drain(daemon.stderr)
    const deadline = Date.now() + COMPUTER_START_MS
    while (!existsSync(socket)) {
      if (daemon.exitCode !== null || daemon.signalCode !== null)
        throw new Error(
          `Cua Driver stopped while starting: ${output.trim().slice(-300) || `exit ${daemon.exitCode}`}`,
        )
      if (Date.now() > deadline) throw new Error('Cua Driver did not start in time')
      await Bun.sleep(50)
    }
    void daemon.exited.then(() => {
      if (this._daemon !== daemon) return
      this._daemon = undefined
      this._ready = undefined
      if (this._state.state === 'running') this._state = { state: 'error', error: 'Cua Driver stopped' }
    })
    await this.options.mcp.setInternal(COMPUTER_SERVER, {
      command: info.path,
      args: ['mcp', '--embedded', '--socket', socket],
      env,
      timeout: COMPUTER_CALL_MS,
    })
    if (!this.options.mcp.internalTool(COMPUTER_SERVER, 'get_window_state'))
      throw new Error(
        `Cua Driver's MCP server did not connect${this.options.mcp.internalError(COMPUTER_SERVER) ? `: ${this.options.mcp.internalError(COMPUTER_SERVER)}` : ''}`,
      )
    this._state = { state: 'running' }
  }

  /** Stops the daemon (macOS answers grants per process: one granted after it started needs a restart). */
  async stop(): Promise<void> {
    await this.desktop.closeAll()
    const daemon = this._daemon
    this._daemon = undefined
    this._ready = undefined
    await this.options.mcp?.setInternal(COMPUTER_SERVER, undefined).catch(() => {})
    if (daemon) {
      daemon.stdin.end()
      await Promise.race([daemon.exited, Bun.sleep(3_000)])
    }
    if (this._state.state === 'running' || this._state.state === 'starting') this._state = this._found()
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.ensure()
  }

  /** The driver tool's input schema accepts this argument (its surface differs between releases). */
  accepts(tool: string, argument: string): boolean {
    const schema = this.options.mcp?.internalTool(COMPUTER_SERVER, tool)?.parameters as
      | { properties?: Record<string, unknown> }
      | undefined
    return !!schema?.properties && argument in schema.properties
  }

  /** Calls one of the driver's tools. */
  async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverResult> {
    await this.ensure()
    const t = this.options.mcp?.internalTool(COMPUTER_SERVER, tool)
    if (!t) throw new Error(`Cua Driver has no ${tool} tool`)
    const result = (await t.execute(
      `computer-${crypto.randomUUID()}`,
      args as never,
      signal,
    )) as AgentToolResult & {
      details?: { structuredContent?: Record<string, unknown> }
    }
    const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
    const images = result.content.flatMap((c) =>
      c.type === 'image' ? [{ data: c.data, mimeType: c.mimeType }] : [],
    )
    return {
      text,
      images,
      ...(result.details?.structuredContent ? { structured: result.details.structuredContent } : {}),
      isError: !!result.isError,
    }
  }

  /**
   * Takes an app for one agent: it is the only one driving that app until it lets go (or its round ends). Another
   * agent waits for it a while, then is told who has it.
   */
  take(app: { name: string; bundleId: string }, holder: Holder, waitMs = COMPUTER_LOCK_WAIT_MS) {
    return this.beforeControl(holder.colonyId, (wait) => this._take(app, holder, waitMs, wait))
  }

  private async _take(app: { name: string; bundleId: string }, holder: Holder, waitMs: number, wait: Wait) {
    const deadline = Date.now() + waitMs
    for (;;) {
      if (wait.ended || this._stopped.has(holder.colonyId)) throw new ComputerStopped()
      const held = this._locks.get(app.bundleId)
      if (!held || same(held, holder)) break
      if (Date.now() >= deadline)
        throw new Error(`${held.agent} is using ${app.name} right now; try again later`)
      await Bun.sleep(200)
    }
    for (const [key, c] of this._locks)
      if (key !== app.bundleId && key !== FOREGROUND && same(c, holder)) this._locks.delete(key)
    const held = this._locks.get(app.bundleId)
    this._locks.set(
      app.bundleId,
      held ?? { ...holder, app: app.name, bundleId: app.bundleId, since: Date.now() },
    )
  }

  /**
   * Runs `work` (an app's approval card, waiting for the app) for a round about to drive the desktop, so the person's
   * Stop reaches it there too: it ends at once with an error, and the round never takes the app after.
   */
  async beforeControl<T>(colonyId: string, work: (wait: Wait) => Promise<T>): Promise<T> {
    const waits = this._waiting.get(colonyId) ?? new Set()
    this._waiting.set(colonyId, waits)
    const wait = { ended: false }
    let end = () => {}
    const stopped = new Promise<never>((_, reject) => {
      end = () => {
        wait.ended = true
        reject(new ComputerStopped())
      }
    })
    waits.add(end)
    try {
      return await Promise.race([work(wait), stopped])
    } finally {
      waits.delete(end)
      if (!waits.size) this._waiting.delete(colonyId)
    }
  }

  /** Runs `work` while holding the foreground: the actions that must bring a window forward go one at a time. */
  async inForeground<T>(holder: Holder, app: string, work: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + COMPUTER_LOCK_WAIT_MS
    while (this._locks.has(FOREGROUND)) {
      if (Date.now() >= deadline)
        throw new Error(
          `${this._locks.get(FOREGROUND)?.agent} is using the foreground right now; try again later`,
        )
      await Bun.sleep(100)
    }
    this._locks.set(FOREGROUND, { ...holder, app, bundleId: FOREGROUND, since: Date.now() })
    try {
      return await work()
    } finally {
      this._locks.delete(FOREGROUND)
    }
  }

  /**
   * An agent runs omp desktop scripts: it shows as controlling the Mac until its round lets go or the person stops it.
   * Returns whether it just started to.
   */
  holdDesktop(holder: Holder, place: string): boolean {
    const key = `${DESKTOP}${holder.colonyId}\0${holder.agent}`
    if (this._locks.has(key)) return false
    this._locks.set(key, { ...holder, app: place, bundleId: DESKTOP_GRANT, since: Date.now() })
    return true
  }

  /** Lets go of everything one agent (or, without `agent`, a whole round that ended) holds; its scripts stop. */
  release(colonyId: string, agent?: string, keepRound = false) {
    for (const [key, c] of this._locks)
      if (c.colonyId === colonyId && (agent === undefined || c.agent === agent)) this._locks.delete(key)
    if (agent === undefined && !keepRound) this._stops.delete(colonyId)
    void this.desktop.close(colonyId, agent)
  }

  /** Which agents control which apps now, for the "controlling your Mac" indicator and Settings. */
  controls(): Control[] {
    return [...this._locks.entries()].filter(([key]) => key !== FOREGROUND).map(([, c]) => c)
  }

  /** An agent acted at a point on the screen. */
  point(holder: Holder, x: number, y: number, action: Pointer['action'], now = Date.now()) {
    this._pointers.set(`${holder.colonyId}/${holder.agent}`, { ...holder, x, y, action, at: now })
  }

  /**
   * Where the agents in control last acted, for the overlay that draws their cursors. Asking counts as the overlay
   * being up (see `overlayShown`).
   */
  pointers(now = Date.now()): Pointer[] {
    this._overlaySeen = now
    const holding = new Set(this.controls().map((c) => `${c.colonyId}/${c.agent}`))
    for (const key of this._pointers.keys()) if (!holding.has(key)) this._pointers.delete(key)
    return [...this._pointers.values()]
  }

  /**
   * Shows or hides the driver's own cursor for a session, once per change, where the driver can: the overlay draws the
   * agents' cursors when it is up. A driver that cannot keeps its cursor, which only means two cursors for a moment.
   */
  async showDriverCursor(session: string, shown: boolean): Promise<void> {
    // The driver shows a session's cursor until told otherwise.
    const now = this._driverCursor.get(session) ?? true
    if (now === shown || !this.accepts('set_agent_cursor_enabled', 'enabled')) return
    this._driverCursor.set(session, shown)
    const r = await this.call('set_agent_cursor_enabled', { session, enabled: shown }).catch(
      (err: Error) => ({
        isError: true,
        text: err.message,
      }),
    )
    if (r.isError) this.options.log?.(`the driver's cursor for ${session} stays as it was: ${r.text}`)
  }

  /** The desktop app's overlay is drawing the agents' cursors, so the driver need not draw its own. */
  overlayShown(now = Date.now()): boolean {
    return now - this._overlaySeen < COMPUTER_OVERLAY_SEEN_MS
  }

  /** A round starts (a chat's colony starts one per message): `stop` is what it does when the person presses Stop. */
  newRound(colonyId: string, stop: () => void) {
    this._stopped.delete(colonyId)
    this._stops.set(colonyId, stop)
  }

  /** The person stopped this round's computer use. */
  stopped(colonyId: string): boolean {
    return this._stopped.has(colonyId)
  }

  /** The person's Stop (or Esc): every round driving the desktop stops doing so for good, and lets go of its apps. */
  stopAll(): number {
    const colonies = new Set([...this.controls().map((c) => c.colonyId), ...this._waiting.keys()])
    for (const id of colonies) {
      this._stopped.add(id)
      this._stops.get(id)?.()
      this.release(id, undefined, true)
      for (const end of this._waiting.get(id) ?? []) end()
    }
    return colonies.size
  }
}

/** The driver's version, from its machine-readable manifest. */
function driverVersion(path: string, info: Pick<DriverInfo, 'own'>): string | undefined {
  try {
    const out = Bun.spawnSync([path, 'manifest'], {
      env: driverEnv(info, { DO_NOT_TRACK: '1' }),
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 5_000,
    })
    const version = (JSON.parse(out.stdout.toString()) as { binary_version?: unknown }).binary_version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/** The `cua-driver` binary in an unpacked release, at its root or one folder down. */
function findBinary(dir: string): string | undefined {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name === 'cua-driver' && statSync(path).isFile()) return path
  }
  for (const name of readdirSync(dir)) {
    const path = join(dir, name, 'cua-driver')
    if (statSync(join(dir, name)).isDirectory() && existsSync(path) && statSync(path).isFile()) return path
  }
  return undefined
}
