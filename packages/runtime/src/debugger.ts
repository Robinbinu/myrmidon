import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import type { CellAccess } from './cells.ts'
import {
  DEBUG_END_MS,
  DEBUG_FRAMES,
  DEBUG_MAX_FRAMES,
  DEBUG_MAX_WAIT_S,
  DEBUG_OUTPUT_CHARS,
  DEBUG_OUTPUT_SHOWN,
  DEBUG_REQUEST_MS,
  DEBUG_VALUE_CHARS,
  DEBUG_VARIABLES,
  DEBUG_WAIT_S,
} from './config.ts'
import type {
  DapBreakpoint,
  DapCapabilities,
  DapClient,
  DapEvaluateResponse,
  DapExitedEventBody,
  DapInitializeArguments,
  DapOutputEventBody,
  DapResolvedAdapter,
  DapScope,
  DapStackFrame,
  DapStartDebuggingArguments,
  DapStoppedEventBody,
  DapThread,
  DapVariable,
} from './omp/dap.ts'
import { type Dap, loadDap } from './omp/dap.ts'
import { prompts } from './prompts.ts'
import { killTree } from './sandbox.ts'

/**
 * A debugger for agents (the debug tool): a program run under a Debug Adapter Protocol adapter (debugpy, vscode-js-debug,
 * lldb-dap, gdb and the others omp knows), one session per agent of a round, stopped with the round. The wire client,
 * the adapter defaults and the choice of adapter are omp's (dap/client, dap/config); the session is after omp's
 * DapSessionManager, kept per agent rather than one per process, and it never asks the client to start a program:
 * omp answers an adapter's runInTerminal by spawning the command line it is given, which here would run outside the
 * sandbox. The adapter itself is started as the agent's commands are, so the program it runs is confined with it.
 * Nothing here knows the colony: how an adapter may start, and whether an expression may run, comes in as a scope.
 */

const say = prompts.debugger

export const DEBUG_ACTIONS = [
  'launch',
  'attach',
  'set_breakpoint',
  'remove_breakpoint',
  'continue',
  'step_over',
  'step_in',
  'step_out',
  'pause',
  'stack',
  'variables',
  'evaluate',
  'output',
  'terminate',
  'status',
] as const
export type DebugAction = (typeof DEBUG_ACTIONS)[number]

/** Actions that only read the paused program; the rest start it, run it on, or run code in it. */
const READS: ReadonlySet<string> = new Set(['stack', 'variables', 'output', 'status'])
export const debugReads = (args: { action?: string }) => READS.has(args.action ?? '')

export interface DebugBreakpoint {
  readonly file: string
  readonly line: number
  readonly condition?: string
}

export interface DebugArgs {
  readonly action: DebugAction
  readonly program?: string
  readonly args?: readonly string[]
  readonly adapter?: string
  readonly breakpoints?: readonly DebugBreakpoint[]
  readonly file?: string
  readonly line?: number
  readonly condition?: string
  readonly port?: number
  readonly pid?: number
  readonly frame?: number
  readonly ref?: number
  readonly expression?: string
  readonly timeoutSeconds?: number
}

/** Where one agent debugs, and how its adapters start. */
export interface DebugScope {
  readonly colonyId: string
  readonly agent: string
  /** The access an adapter started now keeps while it runs; a looser one than the round has later is stopped. */
  readonly access: CellAccess
  /** The working directory: programs start here, and relative paths resolve and are shown from here. */
  readonly cwd: string
  /** A path the agent named, for reading; throws when it is outside what the agent may read. */
  resolveRead(path: string): string
  /** The python3 the agent's commands would run, for debugpy where omp's `python` is missing. */
  python(): string | undefined
  /**
   * The adapter as it may run here, once the permission model lets it start what `target` says (the program and
   * its arguments, or what it attaches to): confined like the agent's commands. Throws when it may not.
   */
  start(adapter: DapResolvedAdapter, target: readonly string[]): Promise<DapResolvedAdapter>
  /** An expression to evaluate, decided as a command (it runs code in the program); returns what to run. */
  approve(expression: string): Promise<string>
}

/**
 * omp's DAP modules, loaded on the first debug call: its adapter config reads omp's config folders, which must not
 * load before omp has been pointed at Myrmidon's folder, and most rounds never debug.
 */
type Omp = Dap
let ompModules: Promise<Omp> | undefined
function ompDap(): Promise<Omp> {
  ompModules ??= loadDap()
  return ompModules
}

type State = 'starting' | 'running' | 'stopped' | 'ended'

/** One adapter connection: the session's own, or a child the adapter asked for (js-debug's per-process sessions). */
interface Target {
  readonly client: DapClient
  readonly child: boolean
  caps: DapCapabilities
  ended: boolean
}

class Session {
  readonly targets: Target[] = []
  readonly breakpoints = new Map<string, DebugBreakpoint[]>()
  /** What the adapter said of each breakpoint, by file and line. */
  readonly verified = new Map<string, { ok: boolean; message?: string }>()
  state: State = 'starting'
  focus?: Target
  stop?: DapStoppedEventBody
  /** The innermost frame where the program stopped, once asked for. */
  top?: DapStackFrame
  /** The frames the last stack listing showed, which `frame` counts in. */
  frames: DapStackFrame[] = []
  exitCode?: number
  /** Said when the session was ended from outside (the round ended, access was tightened). */
  why?: string
  closing?: Promise<void>
  private out = ''
  /** Output characters received in all, and how many of them a result has shown. */
  private received = 0
  private shown = 0
  private readonly waiters = new Set<() => void>()

  constructor(
    readonly adapter: DapResolvedAdapter,
    readonly cwd: string,
    readonly access: CellAccess,
  ) {}

  write(text: string) {
    this.received += text.length
    this.out = (this.out + text).slice(-DEBUG_OUTPUT_CHARS)
  }

  /** Output not yet shown, its tail when long. */
  fresh(): string {
    const fresh = Math.min(this.received - this.shown, this.out.length)
    this.shown = this.received
    return fresh > 0 ? tail(this.out.slice(-fresh)) : ''
  }

  /** Everything kept, its tail when long. */
  all(): string {
    this.shown = this.received
    return tail(this.out)
  }

  notify() {
    for (const w of [...this.waiters]) w()
  }

  /** Waits until the program stops or ends, or `ms` pass while it runs. */
  settle(ms: number): Promise<void> {
    if (this.state === 'stopped' || this.state === 'ended') return Promise.resolve()
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer)
        this.waiters.delete(check)
        done()
      }
      const check = () => {
        if (this.state === 'stopped' || this.state === 'ended') finish()
      }
      const timer = setTimeout(finish, ms)
      this.waiters.add(check)
    })
  }
}

function tail(text: string): string {
  if (text.length <= DEBUG_OUTPUT_SHOWN) return text
  return say.outputCut(text.length - DEBUG_OUTPUT_SHOWN) + text.slice(-DEBUG_OUTPUT_SHOWN)
}

const cut = (text: string) =>
  text.length > DEBUG_VALUE_CHARS ? `${text.slice(0, DEBUG_VALUE_CHARS)}…` : text

const shownIn = (root: string) => (path: string) => {
  const rel = relative(root, path)
  return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) ? rel : path
}

const waitMs = (seconds?: number) =>
  Math.min(Math.max(1, Math.round(seconds ?? DEBUG_WAIT_S)), DEBUG_MAX_WAIT_S) * 1000

function whole(name: string, value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(say.badNumber(name, min, max))
  return value
}

/**
 * The client's side of the handshake (after omp's): it never runs programs for the adapter (no runInTerminal), and
 * takes child sessions only where it can reach them, on the adapter's own TCP server.
 */
function initArgs(adapter: DapResolvedAdapter): DapInitializeArguments {
  return {
    clientID: 'myrmidon',
    clientName: 'Myrmidon',
    adapterID: adapter.name,
    locale: 'en-US',
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
    supportsVariableType: true,
    supportsRunInTerminalRequest: false,
    supportsStartDebuggingRequest: adapter.connectMode === 'tcp',
  }
}

/** omp's debugpy entry runs `python`, which macOS and many Linux systems only have as python3. */
function debugpyWith(omp: Omp, scope: DebugScope): DapResolvedAdapter | undefined {
  const python = scope.python()
  const c = omp.config.getAdapterConfigs(scope.cwd).debugpy
  if (!python || !c) return undefined
  return {
    name: 'debugpy',
    command: 'python3',
    args: c.args ?? [],
    resolvedCommand: python,
    languages: c.languages ?? [],
    fileTypes: c.fileTypes ?? [],
    rootMarkers: c.rootMarkers ?? [],
    launchDefaults: c.launchDefaults ?? {},
    attachDefaults: c.attachDefaults ?? {},
    connectMode: c.connectMode ?? 'stdio',
    acceptsDirectoryProgram: c.acceptsDirectoryProgram === true,
  }
}

/** Adapters installed for this folder, by name, debugpy on python3 included. */
function installed(omp: Omp, scope: DebugScope): string[] {
  const names = omp.config.getAvailableAdapters(scope.cwd).map((a) => a.name)
  if (!names.includes('debugpy') && debugpyWith(omp, scope)) names.push('debugpy')
  return names
}

/** The debug sessions of every round: one per agent, made by launch or attach, ended with the round. */
export class DebugSessions {
  private readonly _sessions = new Map<string, Session>()
  private readonly _queues = new Map<string, Promise<unknown>>()

  /** Runs one call; one agent's calls run one after another. */
  run(scope: DebugScope, args: DebugArgs): Promise<string> {
    const key = `${scope.colonyId}\0${scope.agent}`
    const next = (this._queues.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this._run(key, scope, args))
    this._queues.set(key, next)
    return next
  }

  private async _run(key: string, scope: DebugScope, args: DebugArgs): Promise<string> {
    const s = this._sessions.get(key)
    if (args.action === 'launch' || args.action === 'attach') {
      if (s && s.state !== 'ended') throw new Error(say.alreadyRunning)
      this._sessions.delete(key)
      return this._begin(key, scope, args)
    }
    if (args.action === 'status')
      return s ? this._status(s, scope) : say.noSessionYet(installed(await ompDap(), scope))
    if (!s) throw new Error(say.noSession)
    if (args.action === 'terminate') {
      await end(s)
      this._sessions.delete(key)
      return report(s, scope, say.terminated)
    }
    if (args.action === 'output') return s.all() || say.noOutput
    if (s.state === 'ended') throw new Error(report(s, scope, s.why ?? say.notRunning))
    switch (args.action) {
      case 'set_breakpoint':
        return this._setBreakpoint(s, scope, args)
      case 'remove_breakpoint':
        return this._removeBreakpoint(s, scope, args)
      case 'continue':
        return this._resume(s, scope, 'continue', args)
      case 'step_over':
        return this._resume(s, scope, 'next', args)
      case 'step_in':
        return this._resume(s, scope, 'stepIn', args)
      case 'step_out':
        return this._resume(s, scope, 'stepOut', args)
      case 'pause':
        return this._pause(s, scope, args)
      case 'stack':
        return this._stack(s, scope)
      case 'variables':
        return this._variables(s, args)
      case 'evaluate':
        return this._evaluate(s, scope, args)
    }
  }

  private async _begin(key: string, scope: DebugScope, args: DebugArgs): Promise<string> {
    const omp = await ompDap()
    const shown = shownIn(scope.cwd)
    const breakpoints = (args.breakpoints ?? []).map((b) => resolveBreakpoint(scope, b))
    let adapter: DapResolvedAdapter
    let target: string[]
    let request: 'launch' | 'attach'
    let config: Record<string, unknown>
    if (args.action === 'launch') {
      if (!args.program?.trim()) throw new Error(say.needsProgram)
      const program = scope.resolveRead(args.program)
      if (!existsSync(program)) throw new Error(say.notFound(args.program))
      const kind = statSync(program).isDirectory() ? 'directory' : 'file'
      const chosen = omp.config.selectLaunchAdapter(program, scope.cwd, args.adapter, kind)
      const python =
        (chosen.kind === 'unavailable' && chosen.adapterName === 'debugpy') || args.adapter === 'debugpy'
      const found = chosen.kind === 'adapter' ? chosen.adapter : python ? debugpyWith(omp, scope) : undefined
      if (!found)
        throw new Error(
          chosen.kind === 'unavailable'
            ? say.adapterMissing(chosen.adapterName, chosen.command)
            : say.noAdapter(shown(program), installed(omp, scope)),
        )
      if (kind === 'directory' && !found.acceptsDirectoryProgram) throw new Error(say.directory(found.name))
      adapter = found
      const programArgs = [...(args.args ?? [])]
      target = [program, ...programArgs]
      request = 'launch'
      config = {
        ...adapter.launchDefaults,
        ...omp.config.resolveLaunchOverrides(adapter, program, kind),
        program,
        cwd: scope.cwd,
        args: programArgs,
        // The adapter runs the program itself, inside the sandbox, never through the client.
        console: 'internalConsole',
        // With breakpoints it runs to the first; without, it waits at the start for some to be set.
        stopOnEntry: breakpoints.length === 0,
      }
    } else {
      const port = whole('port', args.port, 1, 65_535)
      const pid = whole('pid', args.pid, 1, 2 ** 31 - 1)
      if (port === undefined && pid === undefined) throw new Error(say.needsPort)
      const chosen =
        omp.config.selectAttachAdapter(scope.cwd, args.adapter, port) ??
        ((args.adapter ?? 'debugpy') === 'debugpy' && port !== undefined
          ? debugpyWith(omp, scope)
          : undefined)
      if (!chosen) throw new Error(say.noAttachAdapter(args.adapter, installed(omp, scope)))
      adapter = chosen
      target = port !== undefined ? ['--attach', `127.0.0.1:${port}`] : ['--attach', `pid ${pid}`]
      request = 'attach'
      config = {
        ...adapter.attachDefaults,
        cwd: scope.cwd,
        ...(pid !== undefined ? { pid, processId: pid } : {}),
        // Only this computer: a debugger port elsewhere is someone else's program.
        ...(port !== undefined ? { port, host: '127.0.0.1', connect: { host: '127.0.0.1', port } } : {}),
      }
    }
    const started = await scope.start(adapter, target)
    const s = new Session(started, scope.cwd, scope.access)
    for (const b of breakpoints) addBreakpoint(s, b)
    this._sessions.set(key, s)
    try {
      const client = await omp.client.DapClient.spawn({ adapter: started, cwd: scope.cwd })
      const root = this._track(s, client, false, omp)
      await configure(s, root, request, config)
    } catch (err) {
      await end(s)
      this._sessions.delete(key)
      const why = err instanceof Error ? err.message : String(err)
      throw new Error(
        /No module named ['"]?debugpy/.test(why) ? say.noDebugpy : say.startFailed(adapter.name, why),
      )
    }
    await s.settle(waitMs(args.timeoutSeconds))
    const head =
      request === 'launch'
        ? say.launched(adapter.name, shown(target[0] ?? ''), breakpointLines(s, scope))
        : say.attached(adapter.name, target[1] ?? '')
    return report(s, scope, head, await topFrame(s))
  }

  /** Follows one adapter connection's events into the session. */
  private _track(s: Session, client: DapClient, child: boolean, omp: Omp): Target {
    const t: Target = { client, child, caps: {}, ended: false }
    s.targets.push(t)
    s.focus ??= t
    client.onEvent('output', (body) => {
      const o = body as DapOutputEventBody | undefined
      if (o?.output && o.category !== 'telemetry') s.write(o.output)
    })
    client.onEvent('stopped', (body) => {
      s.state = 'stopped'
      s.focus = t
      s.stop = body as DapStoppedEventBody
      s.top = undefined
      s.frames = []
      s.notify()
    })
    client.onEvent('continued', () => {
      if (s.focus !== t || s.state === 'ended') return
      s.state = 'running'
      s.stop = undefined
    })
    client.onEvent('exited', (body) => {
      s.exitCode = (body as DapExitedEventBody | undefined)?.exitCode ?? s.exitCode
    })
    const ended = () => {
      t.ended = true
      settleEnd(s)
    }
    client.onEvent('terminated', ended)
    void client.proc.exited.then(ended, ended)
    client.onReverseRequest('runInTerminal', () => {
      throw new Error(say.noTerminal)
    })
    if (!child)
      client.onReverseRequest('startDebugging', async (raw) => {
        const a = (raw ?? {}) as Partial<DapStartDebuggingArguments>
        if (s.adapter.connectMode !== 'tcp' || client.port === undefined) throw new Error(say.noChildSessions)
        const childClient = await omp.client.DapClient.connect({
          adapter: s.adapter,
          cwd: s.cwd,
          host: '127.0.0.1',
          port: client.port,
        })
        const kid = this._track(s, childClient, true, omp)
        await configure(s, kid, a.request === 'attach' ? 'attach' : 'launch', {
          ...(a.configuration ?? {}),
          cwd: s.cwd,
        })
        return {}
      })
    return t
  }

  private _status(s: Session, scope: DebugScope): string {
    const lines = [say.status(s.adapter.name, s.state), ...breakpointLines(s, scope)]
    return report(s, scope, lines.join('\n'))
  }

  private async _setBreakpoint(s: Session, scope: DebugScope, args: DebugArgs): Promise<string> {
    if (!args.file || args.line === undefined) throw new Error(say.needsFileLine)
    const b = resolveBreakpoint(scope, {
      file: args.file,
      line: args.line,
      ...(args.condition ? { condition: args.condition } : {}),
    })
    addBreakpoint(s, b)
    await sendBreakpoints(s, b.file)
    return [say.breakpointSet, ...breakpointLines(s, scope, b.file)].join('\n')
  }

  private async _removeBreakpoint(s: Session, scope: DebugScope, args: DebugArgs): Promise<string> {
    if (!args.file || args.line === undefined) throw new Error(say.needsFileLine)
    const file = scope.resolveRead(args.file)
    const list = s.breakpoints.get(file) ?? []
    const kept = list.filter((b) => b.line !== args.line)
    if (kept.length === list.length) throw new Error(say.noBreakpoint(shownIn(scope.cwd)(file), args.line))
    s.breakpoints.set(file, kept)
    s.verified.delete(`${file}:${args.line}`)
    await sendBreakpoints(s, file)
    return say.breakpointRemoved(shownIn(scope.cwd)(file), args.line)
  }

  /** continue, or a step: runs the stopped program on and waits for it to stop again or end. */
  private async _resume(
    s: Session,
    scope: DebugScope,
    command: 'continue' | 'next' | 'stepIn' | 'stepOut',
    args: DebugArgs,
  ): Promise<string> {
    if (s.state !== 'stopped') throw new Error(say.notStopped)
    const t = live(s)
    const threadId = await threadOf(s, t)
    s.state = 'running'
    s.stop = undefined
    s.top = undefined
    s.frames = []
    await t.client.sendRequest(command, { threadId }, undefined, DEBUG_REQUEST_MS)
    await s.settle(waitMs(args.timeoutSeconds))
    return report(s, scope, undefined, await topFrame(s))
  }

  private async _pause(s: Session, scope: DebugScope, args: DebugArgs): Promise<string> {
    if (s.state === 'stopped') return report(s, scope, say.alreadyStopped, await topFrame(s))
    const t = live(s)
    await t.client.sendRequest('pause', { threadId: await threadOf(s, t) }, undefined, DEBUG_REQUEST_MS)
    await s.settle(waitMs(args.timeoutSeconds))
    return report(s, scope, undefined, await topFrame(s))
  }

  private async _stack(s: Session, scope: DebugScope): Promise<string> {
    if (s.state !== 'stopped') throw new Error(say.notStopped)
    const t = live(s)
    const threads = (
      await t.client.sendRequest<{ threads?: DapThread[] }>('threads', undefined, undefined, DEBUG_REQUEST_MS)
    ).threads
    const threadId = await threadOf(s, t)
    const res = await t.client.sendRequest<{ stackFrames?: DapStackFrame[]; totalFrames?: number }>(
      'stackTrace',
      { threadId, startFrame: 0, levels: DEBUG_FRAMES },
      undefined,
      DEBUG_REQUEST_MS,
    )
    s.frames = res.stackFrames ?? []
    const shown = shownIn(scope.cwd)
    const thread = threads?.find((x) => x.id === threadId)
    const lines = s.frames.map((f, i) => `#${i} ${f.name}${place(f, shown)}`)
    const total = res.totalFrames ?? s.frames.length
    return [
      say.stackOf(thread?.name ?? String(threadId), threads?.length ?? 1),
      ...lines,
      ...(total > s.frames.length ? [say.moreFrames(total - s.frames.length)] : []),
    ].join('\n')
  }

  private async _variables(s: Session, args: DebugArgs): Promise<string> {
    if (s.state !== 'stopped') throw new Error(say.notStopped)
    const t = live(s)
    if (args.ref !== undefined) {
      const ref = whole('ref', args.ref, 1, 2 ** 31 - 1) ?? 0
      return variableLines(await variablesOf(t, ref)).join('\n') || say.noVariables
    }
    const frame = await frameAt(s, t, args.frame)
    const scopes =
      (
        await t.client.sendRequest<{ scopes?: DapScope[] }>(
          'scopes',
          { frameId: frame.id },
          undefined,
          DEBUG_REQUEST_MS,
        )
      ).scopes ?? []
    const out: string[] = [say.frame(frame.name)]
    for (const sc of scopes) {
      if (sc.expensive) {
        out.push(say.expensiveScope(sc.name, sc.variablesReference))
        continue
      }
      out.push(`${sc.name}:`)
      out.push(...variableLines(await variablesOf(t, sc.variablesReference)).map((l) => `  ${l}`))
    }
    return out.join('\n')
  }

  private async _evaluate(s: Session, scope: DebugScope, args: DebugArgs): Promise<string> {
    if (!args.expression?.trim()) throw new Error(say.needsExpression)
    if (s.state !== 'stopped') throw new Error(say.notStopped)
    const t = live(s)
    const frame = await frameAt(s, t, args.frame)
    const expression = await scope.approve(args.expression)
    const r = await t.client.sendRequest<DapEvaluateResponse>(
      'evaluate',
      { expression, frameId: frame.id, context: 'repl' },
      undefined,
      DEBUG_REQUEST_MS,
    )
    const value = `${cut(r.result)}${r.type ? ` (${r.type})` : ''}${r.variablesReference > 0 ? ` [ref ${r.variablesReference}]` : ''}`
    const output = s.fresh()
    return output ? `${value}\n${say.newOutput}\n${output}` : value
  }

  /** Ends the sessions of a round (or of one agent in it), stopping the programs they run. */
  async close(colonyId: string, agent?: string): Promise<void> {
    const prefix = agent === undefined ? `${colonyId}\0` : `${colonyId}\0${agent}`
    const ending: Promise<void>[] = []
    for (const [key, s] of [...this._sessions])
      if (agent === undefined ? key.startsWith(prefix) : key === prefix) {
        this._sessions.delete(key)
        s.why ??= say.roundEnded
        ending.push(end(s))
      }
    await Promise.all(ending)
  }

  /**
   * Ends the sessions of a round started with looser access than it has `now` (full access since taken back, a
   * project since made read-only): a running adapter and its program keep the sandbox they started in. They stay
   * listed, so the agent's next call says why.
   */
  stopLooser(colonyId: string, now: CellAccess): void {
    for (const [key, s] of this._sessions) {
      const was = s.access
      if (
        key.startsWith(`${colonyId}\0`) &&
        s.state !== 'ended' &&
        ((was.unconfined && !now.unconfined) || (!was.readOnly && now.readOnly))
      ) {
        s.why = say.looser
        void end(s)
      }
    }
  }

  /** How many sessions are kept (running, or ended and not yet replaced). */
  get size(): number {
    return this._sessions.size
  }
}

function resolveBreakpoint(scope: DebugScope, b: DebugBreakpoint): DebugBreakpoint {
  const line = whole('line', b.line, 1, 10_000_000) ?? 1
  const file = scope.resolveRead(b.file)
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(say.notFound(b.file))
  return { file, line, ...(b.condition?.trim() ? { condition: b.condition.trim() } : {}) }
}

function addBreakpoint(s: Session, b: DebugBreakpoint) {
  const list = (s.breakpoints.get(b.file) ?? []).filter((x) => x.line !== b.line)
  s.breakpoints.set(
    b.file,
    [...list, b].sort((x, y) => x.line - y.line),
  )
}

/** A file's breakpoints, sent to every live connection (DAP replaces a file's list whole). */
async function sendBreakpoints(s: Session, file: string, only?: Target): Promise<void> {
  const list = s.breakpoints.get(file) ?? []
  for (const t of only ? [only] : s.targets) {
    if (t.ended) continue
    const res = await t.client.sendRequest<{ breakpoints?: DapBreakpoint[] }>(
      'setBreakpoints',
      {
        source: { path: file },
        breakpoints: list.map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}) })),
      },
      undefined,
      DEBUG_REQUEST_MS,
    )
    if (t.child && !res.breakpoints?.some((b) => b.verified)) continue
    list.forEach((b, i) => {
      const r = res.breakpoints?.[i]
      s.verified.set(`${file}:${b.line}`, {
        ok: r?.verified ?? false,
        ...(r?.message ? { message: r.message } : {}),
      })
    })
  }
}

/**
 * One connection's start, in the order adapters expect (after omp's): initialize, launch or attach (which many
 * answer only after configuration), then once the adapter says it is initialized, the breakpoints and
 * configurationDone.
 */
async function configure(
  s: Session,
  t: Target,
  request: 'launch' | 'attach',
  config: Record<string, unknown>,
): Promise<void> {
  t.caps = await t.client.initialize(initArgs(s.adapter), undefined, DEBUG_REQUEST_MS)
  const initialized = t.client.waitForEvent('initialized', undefined, undefined, DEBUG_REQUEST_MS)
  initialized.catch(() => {})
  const started = t.client.sendRequest(request, config, undefined, DEBUG_REQUEST_MS)
  started.catch(() => {})
  try {
    await initialized
  } catch {
    // No initialized event: the launch or attach answer says why.
    await started
    return
  }
  for (const file of s.breakpoints.keys()) await sendBreakpoints(s, file, t)
  if (t.caps.supportsConfigurationDoneRequest)
    await t.client.sendRequest('configurationDone', {}, undefined, DEBUG_REQUEST_MS)
  await started
  if (s.state === 'starting') s.state = 'running'
}

/** The session is over when its own connection is, or when every child connection it had is. */
function settleEnd(s: Session) {
  const [root, ...children] = s.targets
  if (root?.ended || (children.length > 0 && children.every((c) => c.ended))) {
    s.state = 'ended'
    s.notify()
  } else if (s.focus?.ended) s.focus = s.targets.find((t) => !t.ended)
}

/** Ends a session: asks each adapter to stop its program, then stops the adapters and anything they left. */
function end(s: Session): Promise<void> {
  s.closing ??= (async () => {
    // Over from now: no call reaches an adapter that is being stopped.
    s.state = 'ended'
    s.notify()
    for (const t of [...s.targets].reverse()) {
      if (t.ended) continue
      await Promise.race([
        t.client
          .sendRequest('disconnect', { terminateDebuggee: true }, undefined, DEBUG_END_MS)
          .catch(() => {}),
        Bun.sleep(DEBUG_END_MS),
      ])
    }
    const root = s.targets[0]?.client
    if (root?.isAlive() && root.proc.pid) killTree(root.proc.pid, 'SIGKILL')
    await Promise.all(s.targets.map((t) => t.client.dispose().catch(() => {})))
  })()
  return s.closing
}

function live(s: Session): Target {
  const t = s.focus && !s.focus.ended ? s.focus : s.targets.find((x) => !x.ended)
  if (!t) throw new Error(say.notRunning)
  return t
}

async function threadOf(s: Session, t: Target): Promise<number> {
  if (s.stop?.threadId !== undefined) return s.stop.threadId
  const threads = (
    await t.client.sendRequest<{ threads?: DapThread[] }>('threads', undefined, undefined, DEBUG_REQUEST_MS)
  ).threads
  const id = threads?.[0]?.id
  if (id === undefined) throw new Error(say.noThreads)
  return id
}

/** The innermost frame of a stopped program, for saying where it stopped. */
async function topFrame(s: Session): Promise<DapStackFrame | undefined> {
  if (s.state !== 'stopped') return undefined
  if (s.top) return s.top
  try {
    const t = live(s)
    const res = await t.client.sendRequest<{ stackFrames?: DapStackFrame[] }>(
      'stackTrace',
      { threadId: await threadOf(s, t), startFrame: 0, levels: 1 },
      undefined,
      DEBUG_REQUEST_MS,
    )
    s.top = res.stackFrames?.[0]
  } catch {
    // Where it stopped is a nicety; the stop itself is reported either way.
  }
  return s.top
}

/** The frame `index` counts to, innermost first as stack lists them (default the innermost). */
async function frameAt(s: Session, t: Target, index = 0): Promise<DapStackFrame> {
  const i = whole('frame', index, 0, DEBUG_MAX_FRAMES - 1) ?? 0
  if (s.frames.length <= i) {
    const res = await t.client.sendRequest<{ stackFrames?: DapStackFrame[] }>(
      'stackTrace',
      { threadId: await threadOf(s, t), startFrame: 0, levels: Math.max(i + 1, DEBUG_FRAMES) },
      undefined,
      DEBUG_REQUEST_MS,
    )
    s.frames = res.stackFrames ?? []
  }
  const frame = s.frames[i]
  if (!frame) throw new Error(say.noFrame(i, s.frames.length))
  return frame
}

async function variablesOf(t: Target, ref: number): Promise<DapVariable[]> {
  const res = await t.client.sendRequest<{ variables?: DapVariable[] }>(
    'variables',
    { variablesReference: ref },
    undefined,
    DEBUG_REQUEST_MS,
  )
  return res.variables ?? []
}

function variableLines(vars: readonly DapVariable[]): string[] {
  const lines = vars
    .slice(0, DEBUG_VARIABLES)
    .map(
      (v) =>
        `${v.name} = ${cut(v.value)}${v.type ? ` (${v.type})` : ''}${v.variablesReference > 0 ? ` [ref ${v.variablesReference}]` : ''}`,
    )
  return vars.length > DEBUG_VARIABLES ? [...lines, say.moreVariables(vars.length - DEBUG_VARIABLES)] : lines
}

const place = (f: DapStackFrame, shown: (p: string) => string) =>
  f.source?.path
    ? ` at ${shown(f.source.path)}:${f.line}`
    : f.source?.name
      ? ` at ${f.source.name}:${f.line}`
      : ''

function breakpointLines(s: Session, scope: DebugScope, only?: string): string[] {
  const shown = shownIn(scope.cwd)
  return [...s.breakpoints].flatMap(([file, list]) =>
    file !== only && only !== undefined
      ? []
      : list.map((b) => {
          const v = s.verified.get(`${file}:${b.line}`)
          return say.breakpoint(shown(file), b.line, b.condition, v?.ok, v?.message)
        }),
  )
}

/** Where the program is now, with its output since the last call. */
function report(s: Session, scope: DebugScope, head?: string, top?: DapStackFrame): string {
  const shown = shownIn(scope.cwd)
  const state =
    s.state === 'stopped'
      ? say.stopped(
          s.stop?.reason ?? 'pause',
          top ? `${top.name}${place(top, shown)}` : undefined,
          s.stop?.text ?? s.stop?.description,
        )
      : s.state === 'ended'
        ? say.ended(s.exitCode)
        : say.running
  const output = s.fresh()
  return [head, state, ...(output ? [say.newOutput, output] : [])].filter(Boolean).join('\n')
}

/** Every round's debug sessions, in this process. */
export const debugSessions = new DebugSessions()
