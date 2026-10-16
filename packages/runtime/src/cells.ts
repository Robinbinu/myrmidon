import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CELL_DISPLAYS,
  CELL_EXIT_DRAIN_MS,
  CELL_IMAGE_CHARS,
  CELL_IMAGES,
  CELL_LINE_MAX,
  CELL_MAX_TIMEOUT_S,
  CELL_OUTPUT_CHARS,
  CELL_START_MS,
  CELL_TIMEOUT_S,
  CELL_WORKER_COMMAND,
} from './config.ts'
import { leashRunning } from './leashed.ts'
import { loadPythonPrelude, loadPythonRunner } from './omp/eval.ts'
import { prompts } from './prompts.ts'
import { killTree } from './sandbox.ts'

/**
 * Code cells for agents (the eval tool): a JavaScript or Python runtime per agent of a round whose state lasts from
 * one call to the next, as in omp's eval. The runtimes are omp's (JsRuntime behind WorkerCore, and runner.py), each
 * run as a process of its own started the way the agent's commands are, in its OS sandbox: inside Myrmidon a cell
 * would have Myrmidon's own reach, past the sandbox, read access and the permission model. Nothing here knows the
 * colony: how to start a confined program comes in as a scope, and the permission check stays in tools.ts. Whatever a
 * runtime writes back is the agent's own code talking, so it is bounded and checked, never trusted.
 */

const say = prompts.cells

export const CELL_LANGUAGES = ['js', 'py'] as const
export type CellLanguage = (typeof CELL_LANGUAGES)[number]

const WORKER = join(import.meta.dir, 'cells-worker.ts')

/**
 * The access a runtime starts with, which it keeps while it runs: whether it is unconfined (full access), and whether
 * the project was read-only to it. A runtime started under looser access than the round has now is stopped.
 */
export interface CellAccess {
  readonly unconfined: boolean
  readonly readOnly: boolean
}

/** Where one agent's cells run, and how its runtimes are started. */
export interface CellScope {
  readonly colonyId: string
  readonly agent: string
  readonly access: CellAccess
  /** Where cells start and relative paths resolve: the agent's working directory. */
  readonly cwd: string
  /** A folder for the runtimes' own files, which the confined runtime may read and not change. */
  readonly filesDir: string
  /** A program started as the agent's commands are: its command line (confined) and environment. */
  launch(
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
  ): { argv: string[]; env: Record<string, string | undefined> }
  /** The python3 the agent's commands would run, if there is one. */
  python(): string | undefined
}

export interface CellArgs {
  readonly language: CellLanguage
  readonly code: string
  readonly timeoutSeconds?: number
  readonly reset?: boolean
}

export interface CellImage {
  readonly data: string
  readonly mimeType: string
}

/**
 * Something display() showed, for the person to see drawn: a JSON value, a picture (an SVG one too, which the model
 * is not sent), or a Vega-Lite chart (Altair's).
 */
export type CellShown =
  | { readonly kind: 'json'; readonly value: unknown }
  | {
      readonly kind: 'image'
      readonly data: string
      readonly mimeType: string
      readonly encoding: 'base64' | 'text'
    }
  | { readonly kind: 'chart'; readonly spec: unknown }

export interface CellResult {
  /** False when the cell threw, ran out of time, or its runtime stopped: the text says which. */
  readonly ok: boolean
  readonly text: string
  readonly images: readonly CellImage[]
  /** What display() showed, in order, up to CELL_DISPLAYS. */
  readonly shown: readonly CellShown[]
}

type Ending =
  | { readonly kind: 'ok' }
  | { readonly kind: 'error'; readonly error: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'crashed'; readonly why: string }
  | { readonly kind: 'stopped' }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
// Python tracebacks may come coloured.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape character is the point
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '')

/** A cell's output, kept up to CELL_OUTPUT_CHARS and CELL_IMAGES; past that it is counted, not held. */
class Output {
  private _text = ''
  private _left = 0
  readonly images: CellImage[] = []
  private _imagesLeft = 0
  readonly shown: CellShown[] = []

  show(item: CellShown) {
    if (this.shown.length < CELL_DISPLAYS) this.shown.push(item)
  }

  add(text: string) {
    const room = Math.max(0, CELL_OUTPUT_CHARS - this._text.length)
    this._text += text.slice(0, room)
    this._left += Math.max(0, text.length - room)
  }

  image(data: unknown, mimeType: unknown) {
    if (typeof data !== 'string' || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) return
    if (this.images.length < CELL_IMAGES && data.length <= CELL_IMAGE_CHARS) {
      this.images.push({ data, mimeType })
      this.show({ kind: 'image', data, mimeType, encoding: 'base64' })
    } else this._imagesLeft += 1
  }

  json(value: unknown) {
    this.show({ kind: 'json', value })
    let text: string
    try {
      text = JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      text = String(value)
    }
    this.add(text.endsWith('\n') ? text : `${text}\n`)
  }

  render(): string {
    const text = this._text.replace(/\n$/, '')
    return [
      `${text}${this._left ? say.cut(this._left) : ''}`,
      ...(this._imagesLeft ? [say.imagesLeft(this._imagesLeft)] : []),
    ]
      .filter(Boolean)
      .join('\n')
  }
}

interface Cell {
  readonly id: string
  readonly out: Output
  /** The error a Python cell reported before its `done`. */
  error?: string
  end(ending: Ending): void
}

/** One runtime process: its pipes, its leash, and the cell it runs now. */
abstract class Runtime {
  private readonly _proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  private readonly _leash: ReturnType<typeof leashRunning>
  private _stderr = ''
  private _count = 0
  protected cell?: Cell
  /** Why it stopped, once it has. */
  why?: string
  /** The access it started with (see CellAccess). */
  access?: CellAccess
  /** Whether a cell's own result already said it stopped, so the next cell need not. */
  told = false

  constructor(
    launch: { argv: readonly string[]; env: Record<string, string | undefined> },
    cwd: string,
    /** What starts each frame on stdout (JavaScript); without one every line that parses is a frame (Python). */
    private readonly _marker?: string,
  ) {
    this._proc = Bun.spawn([...launch.argv], {
      cwd,
      env: launch.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      // Its own process group, so what a cell starts in the background is found and stopped with it.
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    // When Myrmidon dies, however it dies, the runtime and what it started go too.
    this._leash = leashRunning(this._proc.pid)
    const reading = this._read()
    void this._drainStderr()
    void this._proc.exited.then(async (code) => {
      // The last frames (a traceback, the error that ended it) may still be in the pipe.
      await Promise.race([reading, Bun.sleep(CELL_EXIT_DRAIN_MS)])
      const tail = this._stderr.trim().split('\n').slice(-5).join('\n').slice(-600)
      const why = say.exited(this._proc.signalCode ? null : code, tail)
      this._stopped(why, (cell) => cell.end({ kind: 'crashed', why }))
    })
  }

  get alive(): boolean {
    return this.why === undefined
  }

  /** Starts what the runtime needs before its first cell; throws when it cannot. */
  abstract boot(cwd: string): Promise<void>
  protected abstract request(id: string, code: string, silent: boolean): unknown
  protected abstract frame(frame: Record<string, unknown>): void

  /** Runs one cell and resolves with how it ended; past `timeoutMs` the runtime is stopped with it. */
  exec(code: string, timeoutMs: number, out: Output, silent = false): Promise<Ending> {
    if (!this.alive) return Promise.resolve({ kind: 'crashed', why: this.why ?? '' })
    const id = `cell-${++this._count}`
    const { promise, resolve } = Promise.withResolvers<Ending>()
    const timer = setTimeout(() => this.stop('timeout'), timeoutMs)
    this.cell = {
      id,
      out,
      end: (ending) => {
        clearTimeout(timer)
        if (this.cell?.id === id) this.cell = undefined
        resolve(ending)
      },
    }
    this.send(this.request(id, code, silent))
    return promise
  }

  /**
   * Stops the runtime and everything it started: a running cell ends as timed out or stopped, or as crashed when the
   * runtime wrote past CELL_LINE_MAX or its access was taken back.
   */
  stop(how: 'timeout' | 'stopped' | 'runaway' | 'looser') {
    const why = how === 'runaway' ? say.runaway : how === 'looser' ? say.looser : say.stopped
    this._stopped(why, (cell) =>
      cell.end(how === 'runaway' || how === 'looser' ? { kind: 'crashed', why } : { kind: how }),
    )
    // A pid that has exited may already name another process.
    if (this._proc.exitCode !== null || this._proc.signalCode) return
    const pid = this._proc.pid
    killTree(pid, 'SIGKILL')
    if (process.platform !== 'win32')
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // The group is already gone.
      }
  }

  private _stopped(why: string, endCell: (cell: Cell) => void) {
    if (this.why !== undefined) return
    this.why = why
    const cell = this.cell
    this.cell = undefined
    if (cell) {
      this.told = true
      endCell(cell)
    }
    this.failBoot(why)
    // The leash sweeps whatever is left and exits.
    this._leash.stdin.end()
  }

  /** A start that is still waiting hears why the runtime stopped. */
  protected failBoot(_why: string): void {}

  protected send(message: unknown) {
    try {
      this._proc.stdin.write(`${JSON.stringify(message)}\n`)
      void Promise.resolve(this._proc.stdin.flush()).catch(() => {})
    } catch {
      // It has exited; the exit handler says so.
    }
  }

  /** Output the runtime did not frame (a cell writing to stdout itself, a child process) is the cell's output. */
  protected stray(text: string) {
    this.cell?.out.add(text)
  }

  private _line(line: string) {
    const at = this._marker === undefined ? (line.startsWith('{') ? 0 : -1) : line.indexOf(this._marker)
    if (at < 0) return this.stray(`${line}\n`)
    if (at > 0) this.stray(line.slice(0, at))
    const body = line.slice(at + (this._marker?.length ?? 0))
    let frame: unknown
    try {
      frame = JSON.parse(body)
    } catch {
      return this.stray(`${body}\n`)
    }
    if (isRecord(frame)) this.frame(frame)
  }

  private async _read() {
    const decoder = new TextDecoder()
    let pending = ''
    try {
      for await (const chunk of this._proc.stdout) {
        pending += decoder.decode(chunk, { stream: true })
        for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
          this._line(pending.slice(0, at))
          pending = pending.slice(at + 1)
        }
        if (pending.length > CELL_LINE_MAX) return this.stop('runaway')
      }
    } catch {
      // The pipe broke as the runtime died; the exit handler says so.
    }
    if (pending) this._line(pending)
  }

  private async _drainStderr() {
    const decoder = new TextDecoder()
    try {
      for await (const chunk of this._proc.stderr)
        this._stderr = (this._stderr + decoder.decode(chunk, { stream: true })).slice(-4096)
    } catch {
      // As above.
    }
  }
}

/** omp's JsRuntime behind its WorkerCore (cells-worker.ts), spoken to in its own worker protocol. */
class JsCells extends Runtime {
  private _ready?: { resolve(): void; reject(err: Error): void }

  constructor(
    launch: { argv: readonly string[]; env: Record<string, string | undefined> },
    private readonly _snapshot: { cwd: string; sessionId: string },
    marker: string,
  ) {
    super(launch, _snapshot.cwd, marker)
  }

  async boot(): Promise<void> {
    const ready = Promise.withResolvers<void>()
    this._ready = ready
    const timer = setTimeout(() => {
      ready.reject(new Error(say.slowStart(CELL_START_MS / 1000)))
      this.stop('stopped')
    }, CELL_START_MS)
    this.send({ type: 'init', snapshot: this._snapshot })
    try {
      await ready.promise
    } finally {
      clearTimeout(timer)
      this._ready = undefined
    }
  }

  protected override failBoot(why: string) {
    this._ready?.reject(new Error(why))
  }

  protected request(id: string, code: string) {
    return { type: 'run', runId: id, code, filename: `${id}.js`, snapshot: this._snapshot }
  }

  protected frame(f: Record<string, unknown>) {
    const cell = this.cell
    switch (f.type) {
      case 'ready':
        return this._ready?.resolve()
      case 'init-failed':
        return this._ready?.reject(
          new Error(str(isRecord(f.error) ? f.error.message : undefined) ?? 'failed'),
        )
      case 'text':
        if (cell && f.runId === cell.id) cell.out.add(str(f.chunk) ?? '')
        return
      case 'display': {
        const o = f.output
        if (!cell || f.runId !== cell.id || !isRecord(o)) return
        if (o.type === 'image') cell.out.image(o.data, o.mimeType)
        else if (o.type === 'json') cell.out.json(o.data)
        return
      }
      case 'result':
        if (!cell || f.runId !== cell.id) return
        return cell.end(f.ok === true ? { kind: 'ok' } : { kind: 'error', error: jsError(f.error) })
      case 'tool-call': {
        // `tool.*`, `agent()`, `completion()`: omp's host answers these; here they fail inside the cell.
        const name = str(f.name) ?? 'this helper'
        return this.send({
          type: 'tool-reply',
          id: str(f.id) ?? '',
          reply: {
            ok: false,
            error: { name: 'ToolError', message: say.noHostTools(name), isToolError: true },
          },
        })
      }
    }
  }
}

/** An error a JavaScript cell threw: its message, and where in the cell (not in the runtime) it came from. */
function jsError(error: unknown): string {
  if (!isRecord(error)) return 'Error'
  const head = `${str(error.name) ?? 'Error'}: ${str(error.message) ?? ''}`
  const frames = (str(error.stack) ?? '')
    .split('\n')
    .filter((l) => /^\s+at /.test(l) && l.includes('cell-'))
    .slice(0, 5)
  return [head, ...frames].join('\n')
}

/** omp's runner.py, the plain-Python runtime omp's eval uses, spoken to in its NDJSON protocol. */
class PyCells extends Runtime {
  private _cwd = ''

  async boot(cwd: string): Promise<void> {
    this._cwd = cwd
    const prelude = await loadPythonPrelude()
    // As omp's kernel starts: in the working directory, which imports also look in, then its helpers.
    const init = [
      'import os, sys',
      `os.chdir(${JSON.stringify(cwd)})`,
      `if ${JSON.stringify(cwd)} not in sys.path:\n    sys.path.insert(0, ${JSON.stringify(cwd)})`,
    ].join('\n')
    for (const code of [init, prelude]) {
      const out = new Output()
      const ending = await this.exec(code, CELL_START_MS, out, true)
      if (ending.kind === 'ok') continue
      throw new Error(
        ending.kind === 'error'
          ? ending.error
          : ending.kind === 'crashed'
            ? ending.why
            : ending.kind === 'timeout'
              ? say.slowStart(CELL_START_MS / 1000)
              : say.stopped,
      )
    }
  }

  protected request(id: string, code: string, silent: boolean) {
    return { id, code, cwd: this._cwd, silent, storeHistory: !silent }
  }

  protected frame(f: Record<string, unknown>) {
    const cell = this.cell
    if (!cell || f.id !== cell.id) return
    switch (f.type) {
      case 'stdout':
      case 'stderr':
        return cell.out.add(str(f.data) ?? '')
      case 'display':
      case 'result':
        if (isRecord(f.bundle)) pyDisplay(cell.out, f.bundle)
        return
      case 'error': {
        const trace = Array.isArray(f.traceback) ? f.traceback.filter((l) => typeof l === 'string') : []
        cell.error = plain(
          trace.length ? trace.join('\n') : `${str(f.ename) ?? 'Error'}: ${str(f.evalue) ?? ''}`,
        ).trim()
        return
      }
      case 'done':
        return cell.end(
          f.status === 'error' ? { kind: 'error', error: cell.error ?? 'error' } : { kind: 'ok' },
        )
    }
  }
}

/** A Jupyter-style display bundle as text and pictures, the richest text form first. */
function pyDisplay(out: Output, bundle: Record<string, unknown>) {
  if (bundle['application/x-omp-status'] !== undefined) return
  const image = bundle['application/x-omp-image']
  if (isRecord(image)) out.image(image.data, image.mimeType)
  for (const type of ['image/png', 'image/jpeg'])
    if (typeof bundle[type] === 'string') out.image(bundle[type], type)
  // Shown to the person only: the model reads the bundle's text, as before.
  const svg = bundle['image/svg+xml']
  if (typeof svg === 'string' && svg.length <= CELL_IMAGE_CHARS)
    out.show({ kind: 'image', data: svg, mimeType: 'image/svg+xml', encoding: 'text' })
  const chart = Object.keys(bundle).find((k) => /^application\/vnd\.vegalite\.v\d+\+json$/.test(k))
  if (chart && isRecord(bundle[chart])) out.show({ kind: 'chart', spec: bundle[chart] })
  const text = str(bundle['text/markdown']) ?? str(bundle['text/plain'])
  if (text !== undefined) out.add(text.endsWith('\n') ? text : `${text}\n`)
  else if (bundle['application/json'] !== undefined) out.json(bundle['application/json'])
}

/** A runtime's own file in `dir`, named by its content so a changed Myrmidon writes a new one. */
function staged(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name.replace('.', `-${Bun.hash(text).toString(36)}.`)}`)
  if (!existsSync(path)) writeFileSync(path, text)
  return path
}

let bundled: Promise<string> | undefined

/**
 * The JavaScript runtime's program. From source it is bundled into one file (omp and its dependencies included),
 * since the confined runtime cannot read Myrmidon's node_modules in the person's home; a compiled Myrmidon carries it
 * and runs itself (see CELL_WORKER_COMMAND).
 */
async function jsProgram(dir: string): Promise<string[]> {
  if (!existsSync(WORKER)) return [process.execPath, CELL_WORKER_COMMAND]
  bundled ??= Bun.build({ entrypoints: [WORKER], target: 'bun' }).then(async (r) => {
    const out = r.outputs[0]
    if (!r.success || !out) throw new Error(r.logs.map(String).join('\n') || 'the cell runtime did not build')
    return out.text()
  })
  const text = await bundled.catch((err) => {
    bundled = undefined
    throw err
  })
  return [process.execPath, staged(dir, 'js-cells.js', text)]
}

/** omp's runner script, loaded on the first Python cell; a compiled Myrmidon carries it. */
async function pyRunner(dir: string): Promise<string> {
  return staged(dir, 'py-cells.py', await loadPythonRunner())
}

/** Starts a runtime's process, confined as the scope says (its boot comes next), or says why it cannot. */
async function start(scope: CellScope, language: CellLanguage, cancelled: () => boolean): Promise<Runtime> {
  const name = say.language(language)
  let runtime: Runtime
  try {
    if (language === 'js') {
      const program = await jsProgram(scope.filesDir)
      if (cancelled()) throw new Error(say.stopped)
      const marker = `\u001e${randomBytes(12).toString('hex')}`
      runtime = new JsCells(
        scope.launch(program, { MYR_CELL_FRAME: marker }),
        { cwd: scope.cwd, sessionId: `${scope.colonyId}/${scope.agent}` },
        marker,
      )
    } else {
      const python = scope.python()
      if (!python) throw new Error(say.noPython)
      const runner = await pyRunner(scope.filesDir)
      if (cancelled()) throw new Error(say.stopped)
      runtime = new PyCells(
        scope.launch([python, '-u', runner], { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }),
        scope.cwd,
      )
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(why === say.noPython || why === say.stopped ? why : say.startFailed(name, why))
  }
  return runtime
}

const keyOf = (colonyId: string, agent: string, language: CellLanguage) =>
  `${colonyId}\0${agent}\0${language}`

/** The cell runtimes of every round: one per agent and language, made on its first cell, stopped with the round. */
export class CellKernels {
  private readonly _runtimes = new Map<string, Runtime>()
  private readonly _queues = new Map<string, Promise<unknown>>()
  /** Starts under way, so a round that ends meanwhile stops them too. */
  private readonly _starting = new Map<string, { cancelled: boolean }>()

  /** Runs one cell; cells of one agent and language run one after another. */
  run(scope: CellScope, args: CellArgs): Promise<CellResult> {
    const key = keyOf(scope.colonyId, scope.agent, args.language)
    const next = (this._queues.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this._run(key, scope, args))
    this._queues.set(key, next)
    return next
  }

  private async _run(key: string, scope: CellScope, args: CellArgs): Promise<CellResult> {
    const name = say.language(args.language)
    const notes: string[] = []
    let runtime = this._runtimes.get(key)
    if (runtime && args.reset) {
      this._runtimes.delete(key)
      runtime.stop('stopped')
      runtime = undefined
      notes.push(say.reset(name))
    }
    if (runtime && !runtime.alive) {
      this._runtimes.delete(key)
      if (!runtime.told) notes.push(say.lost(name, runtime.why ?? ''))
      runtime = undefined
    }
    if (!runtime) runtime = await this._start(key, scope, args.language)
    const seconds = Math.min(
      Math.max(1, Math.round(args.timeoutSeconds ?? CELL_TIMEOUT_S)),
      CELL_MAX_TIMEOUT_S,
    )
    const out = new Output()
    const ending = await runtime.exec(args.code, seconds * 1000, out)
    const body = out.render()
    const text = (...parts: string[]) => [...notes, ...parts].filter(Boolean).join('\n')
    const { images, shown } = out
    switch (ending.kind) {
      case 'ok':
        return { ok: true, text: text(body || say.noOutput), images, shown }
      case 'error':
        return { ok: false, text: text(body, ending.error), images, shown }
      case 'timeout':
        return { ok: false, text: text(body, say.timedOut(seconds)), images, shown }
      case 'crashed':
        return { ok: false, text: text(body, say.crashed(ending.why)), images, shown }
      case 'stopped':
        return { ok: false, text: text(body, say.stopped), images, shown }
    }
  }

  private async _start(key: string, scope: CellScope, language: CellLanguage): Promise<Runtime> {
    const token = { cancelled: false }
    this._starting.set(key, token)
    try {
      const runtime = await start(scope, language, () => token.cancelled)
      runtime.access = scope.access
      this._runtimes.set(key, runtime)
      try {
        await runtime.boot(scope.cwd)
      } catch (err) {
        if (this._runtimes.get(key) === runtime) this._runtimes.delete(key)
        runtime.stop('stopped')
        const why = err instanceof Error ? err.message : String(err)
        throw new Error(token.cancelled ? say.stopped : say.startFailed(say.language(language), why))
      }
      return runtime
    } finally {
      if (this._starting.get(key) === token) this._starting.delete(key)
    }
  }

  /** Stops the runtimes of a round (or of one agent in it), cells running in them included. */
  close(colonyId: string, agent?: string): void {
    const prefix = agent === undefined ? `${colonyId}\0` : `${colonyId}\0${agent}\0`
    for (const [key, token] of this._starting) if (key.startsWith(prefix)) token.cancelled = true
    for (const [key, runtime] of [...this._runtimes])
      if (key.startsWith(prefix)) {
        this._runtimes.delete(key)
        runtime.stop('stopped')
      }
  }

  /**
   * Stops the runtimes of a round that started with looser access than it has `now` (full access since taken back, a
   * project since made read-only): a running process keeps the sandbox it started in. Their agents hear of it with
   * their next cell.
   */
  stopLooser(colonyId: string, now: CellAccess): void {
    for (const [key, runtime] of this._runtimes) {
      const was = runtime.access
      if (
        key.startsWith(`${colonyId}\0`) &&
        was &&
        ((was.unconfined && !now.unconfined) || (!was.readOnly && now.readOnly))
      )
        runtime.stop('looser')
    }
  }

  /** How many runtimes are kept (running, or stopped and not yet asked for again). */
  get size(): number {
    return this._runtimes.size
  }
}

/** Every round's cells, in this process. */
export const cellKernels = new CellKernels()
