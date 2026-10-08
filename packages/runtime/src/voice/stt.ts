import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { VOICE_PHONON_START_MS } from '../config.ts'
import { wav } from './audio.ts'

/** Speech to text for a call: one finished turn of 16-bit mono audio in, its words out. */
export interface SpeechToText {
  transcribe(pcm: Int16Array, sampleRate: number, signal?: AbortSignal): Promise<string>
}

/** An OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI, Groq, a local whisper server, Phonon's own). */
export class OpenAiCompatibleStt implements SpeechToText {
  constructor(
    private readonly options: {
      /** Up to the API version, e.g. `https://api.groq.com/openai/v1`. */
      readonly baseUrl: string
      readonly model: string
      readonly apiKey?: string
      /** A Unix socket to reach the endpoint through (Phonon's server listens on one). */
      readonly unix?: string
    },
  ) {}

  async transcribe(pcm: Int16Array, sampleRate: number, signal?: AbortSignal): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([wav(pcm, sampleRate)], { type: 'audio/wav' }), 'turn.wav')
    form.append('model', this.options.model)
    form.append('response_format', 'json')
    const res = await fetch(`${this.options.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      body: form,
      ...(this.options.apiKey ? { headers: { authorization: `Bearer ${this.options.apiKey}` } } : {}),
      ...(this.options.unix ? { unix: this.options.unix } : {}),
      ...(signal ? { signal } : {}),
    } as RequestInit)
    if (!res.ok) throw new Error(`transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { text?: unknown }
    return typeof body.text === 'string' ? body.text.trim() : ''
  }
}

/** The speech model omp can call (an OpenAI or Groq key, say), as channel voice notes use it. */
export class FunctionStt implements SpeechToText {
  constructor(private readonly run: (audio: Uint8Array, mimeType: string, name: string) => Promise<string>) {}

  async transcribe(pcm: Int16Array, sampleRate: number): Promise<string> {
    return (await this.run(wav(pcm, sampleRate), 'audio/wav', 'turn.wav')).trim()
  }
}

export type PhononState =
  | { state: 'missing' }
  | { state: 'installing'; line?: string }
  | { state: 'ready' }
  | { state: 'starting'; line?: string }
  | { state: 'running' }
  | { state: 'error'; error: string }

/** The uv tool install that brings Phonon-2's command line, with the Apple-silicon runtime it prefers. */
export const PHONON_INSTALL = [
  'tool',
  'install',
  '--force',
  'fermion-research',
  ...['mlx', 'mlx-audio', 'mlx-lm', 'soundfile', 'scipy', 'zstandard'].flatMap((p) => ['--with', p]),
]

/**
 * Phonon-2 on this machine: Fermion Research's `fermion serve phonon-2`, an OpenAI-compatible transcription server,
 * started on first use on a Unix socket only this user can reach, kept running, and stopped with Myrmidon. Its model
 * (164 MB) lands in `<home>/voice/fermion` the first time it starts.
 */
export class PhononStt implements SpeechToText {
  private _proc?: Bun.Subprocess
  private _ready?: Promise<OpenAiCompatibleStt>
  private _state: PhononState
  private readonly _dir: string
  private readonly _socket: string

  constructor(
    home: string,
    private readonly log: (line: string) => void = () => {},
    /** Where to look for `fermion` and `uv` besides PATH (uv puts tools in ~/.local/bin). */
    private readonly extraPath = join(homedir(), '.local', 'bin'),
  ) {
    this._dir = join(home, 'voice')
    this._socket = socketPath(join(this._dir, 'phonon.sock'))
    this._state = this._binary() ? { state: 'ready' } : { state: 'missing' }
  }

  status(): PhononState {
    if (this._state.state === 'ready' || this._state.state === 'missing')
      this._state = this._binary() ? { state: 'ready' } : { state: 'missing' }
    return this._state
  }

  /** Installs (or updates) Phonon-2's command line with uv; `status()` shows its progress meanwhile. */
  async install(): Promise<void> {
    const uv = this._which('uv')
    if (!uv) throw new Error('uv is not installed: get it from https://docs.astral.sh/uv/ and try again')
    this._state = { state: 'installing' }
    const proc = Bun.spawn([uv, ...PHONON_INSTALL], { stdout: 'pipe', stderr: 'pipe' })
    const tail: string[] = []
    const read = async (stream: ReadableStream<Uint8Array>) => {
      for await (const line of lines(stream)) {
        tail.push(line)
        if (tail.length > 20) tail.shift()
        this._state = { state: 'installing', line }
        this.log(`phonon install: ${line}`)
      }
    }
    await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited])
    if (proc.exitCode !== 0) {
      const error = tail.slice(-3).join(' ').slice(0, 300) || `uv exited with ${proc.exitCode}`
      this._state = { state: 'error', error }
      throw new Error(error)
    }
    this._state = { state: 'ready' }
  }

  async transcribe(pcm: Int16Array, sampleRate: number, signal?: AbortSignal): Promise<string> {
    return (await this.start()).transcribe(pcm, sampleRate, signal)
  }

  /** Starts the server if it is not running, and waits until it answers (the first start also downloads the model). */
  start(): Promise<OpenAiCompatibleStt> {
    this._ready ??= this._start().catch((err) => {
      this._ready = undefined
      this.stop()
      this._state = { state: 'error', error: err instanceof Error ? err.message : String(err) }
      throw err
    })
    return this._ready
  }

  stop() {
    this._proc?.kill()
    this._proc = undefined
    this._ready = undefined
    if (this._state.state === 'running' || this._state.state === 'starting') this._state = { state: 'ready' }
  }

  private async _start(): Promise<OpenAiCompatibleStt> {
    const fermion = this._binary()
    if (!fermion) throw new Error('Phonon-2 is not installed: install it in Settings → Voice')
    mkdirSync(join(this._dir, 'fermion'), { recursive: true, mode: 0o700 })
    rmSync(this._socket, { force: true })
    this._state = { state: 'starting' }
    const proc = Bun.spawn([fermion, 'serve', 'phonon-2', '--unix-socket', this._socket], {
      env: { ...process.env, FERMION_CACHE_DIR: join(this._dir, 'fermion') },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this._proc = proc
    const tail: string[] = []
    const read = async (stream: ReadableStream<Uint8Array>) => {
      for await (const line of lines(stream)) {
        // Request lines are noise; the rest (downloading, errors) is worth keeping.
        if (/"(GET|POST) /.test(line)) continue
        tail.push(line)
        if (tail.length > 20) tail.shift()
        if (this._state.state === 'starting') this._state = { state: 'starting', line }
        this.log(`phonon: ${line}`)
      }
    }
    void read(proc.stdout)
    void read(proc.stderr)
    void proc.exited.then((code) => {
      if (this._proc !== proc) return
      this._proc = undefined
      this._ready = undefined
      this._state = { state: 'error', error: `Phonon-2 stopped (exit ${code}): ${tail.slice(-2).join(' ')}` }
    })
    const client = new OpenAiCompatibleStt({
      baseUrl: 'http://phonon/v1',
      model: 'phonon-2',
      unix: this._socket,
    })
    const deadline = Date.now() + VOICE_PHONON_START_MS
    while (Date.now() < deadline) {
      if (this._proc !== proc) throw new Error(tail.slice(-3).join(' ') || 'Phonon-2 did not start')
      const up = await fetch('http://phonon/health', { unix: this._socket } as RequestInit).then(
        (r) => r.ok,
        () => false,
      )
      if (up) {
        this._state = { state: 'running' }
        return client
      }
      await Bun.sleep(250)
    }
    throw new Error('Phonon-2 took too long to start')
  }

  private _binary(): string | undefined {
    return this._which('fermion')
  }

  private _which(name: string): string | undefined {
    const found = Bun.which(name)
    if (found) return found
    const local = join(this.extraPath, name)
    return existsSync(local) ? local : undefined
  }
}

/**
 * A Unix socket path that fits: macOS allows 104 bytes, so a long home gets a private folder under /tmp instead
 * (owner-only, named for the home so two Myrmidons do not share it).
 */
function socketPath(wanted: string): string {
  if (Buffer.byteLength(wanted) <= 100) return wanted
  const dir = join('/tmp', `myr-${process.getuid?.() ?? 0}-${Bun.hash(wanted).toString(36)}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  return join(dir, 'phonon.sock')
}

/** The lines of a byte stream, as they arrive. */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true })
    const parts = buffered.split(/\r?\n|\r/)
    buffered = parts.pop() ?? ''
    for (const part of parts) if (part.trim()) yield part.trim()
  }
  if (buffered.trim()) yield buffered.trim()
}
