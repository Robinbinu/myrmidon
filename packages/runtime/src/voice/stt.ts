import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { VOICE_PHONON_START_MS, VOICE_PHONON_VERSION } from '../config.ts'
import { spawnLeashed } from '../leashed.ts'
import { parseWav, wav } from './audio.ts'
import { type LiveTranscription, PhononStream } from './phonon-stream.ts'

/** "Testing, one two three." (2 s, 16 kHz, spoken by Kitten TTS), for warming Phonon-2 up. */
const WARM_CLIP = join(import.meta.dir, 'warm-speech.wav')

export interface TranscribeOptions {
  readonly signal?: AbortSignal
  /** Names to favour (a call's crew and project), for an engine that takes them; others ignore them. */
  readonly hotwords?: readonly string[]
}

/** Speech to text for a call: one finished turn of 16-bit mono audio in, its words out. */
export interface SpeechToText {
  transcribe(pcm: Int16Array, sampleRate: number, options?: TranscribeOptions): Promise<string>
  /** A whole recording as it came (a channel's voice note: OGG/Opus, MP3, M4A…), when the engine reads it as is. */
  transcribeFile?(audio: Uint8Array, mimeType: string, name: string): Promise<string>
  /**
   * A turn's words as it is spoken, for an engine that streams; undefined when it cannot now (the turn is then only
   * transcribed once it has ended, as without this).
   */
  listen?(sampleRate: number, heard: (text: string) => void): LiveTranscription | undefined
  /** Readies the engine for these hotwords, so the first turn that uses them does not pay for it. */
  prepare?(hotwords: readonly string[]): Promise<void>
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
      /** The endpoint takes a `hotwords` field (Phonon-2's server does; OpenAI's would refuse it). */
      readonly hotwords?: boolean
    },
  ) {}

  transcribe(pcm: Int16Array, sampleRate: number, options: TranscribeOptions = {}): Promise<string> {
    return this._post(wav(pcm, sampleRate), 'audio/wav', 'turn.wav', options)
  }

  transcribeFile(audio: Uint8Array, mimeType: string, name: string): Promise<string> {
    return this._post(audio, mimeType, name)
  }

  private async _post(
    audio: Uint8Array,
    mimeType: string,
    name: string,
    { signal, hotwords }: TranscribeOptions = {},
  ): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([audio as Uint8Array<ArrayBuffer>], { type: mimeType }), name)
    form.append('model', this.options.model)
    form.append('response_format', 'json')
    // A JSON list, which Phonon reads as one term per item, so a name with a comma in it stays one name.
    if (this.options.hotwords && hotwords?.length) form.append('hotwords', JSON.stringify(hotwords))
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

  async transcribeFile(audio: Uint8Array, mimeType: string, name: string): Promise<string> {
    return (await this.run(audio, mimeType, name)).trim()
  }
}

export type PhononState =
  | { state: 'missing' }
  | { state: 'installing'; line?: string }
  | { state: 'ready' }
  | { state: 'starting'; line?: string }
  | { state: 'running' }
  | { state: 'error'; error: string }

/**
 * The uv tool install that brings Phonon-2's command line, with the Apple-silicon runtime it prefers: a pinned
 * release, so an install (or a reinstall) is the version Myrmidon was tried with, not whatever was published since.
 */
export const PHONON_INSTALL = [
  'tool',
  'install',
  '--force',
  `fermion-research==${VOICE_PHONON_VERSION}`,
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

  async transcribe(pcm: Int16Array, sampleRate: number, options?: TranscribeOptions): Promise<string> {
    return (await this.start()).transcribe(pcm, sampleRate, options)
  }

  /**
   * Phonon's live stream for a turn, once the server is up (a turn does not wait on it starting). It takes 16 kHz only,
   * and one stream at a time: a second call's turn gets no live words, only its transcript.
   */
  listen(sampleRate: number, heard: (text: string) => void): LiveTranscription | undefined {
    if (this._state.state !== 'running' || sampleRate !== 16_000) return undefined
    return new PhononStream(this._socket, sampleRate, heard, this.log)
  }

  /**
   * Transcribes the warm-up clip with these hotwords: Phonon builds what a set needs the first time it is used
   * (measured: 0.2 s to 1.5 s more on that turn), and a call's set is new to it.
   */
  async prepare(hotwords: readonly string[]): Promise<void> {
    if (!hotwords.length) return
    const { pcm, sampleRate } = parseWav(new Uint8Array(readFileSync(WARM_CLIP)))
    await this.transcribe(pcm, sampleRate, { hotwords })
  }

  /** Phonon-2's server reads WAV, FLAC, OGG (Opus, as Telegram sends voice notes) and AIFF as they are. */
  async transcribeFile(audio: Uint8Array, mimeType: string, name: string): Promise<string> {
    return (await this.start()).transcribeFile(audio, mimeType, name)
  }

  /**
   * Starts the server and transcribes a short spoken clip, so the model is downloaded and its runtime compiled before
   * anyone is waiting on a call. Speech, not silence: silence decodes no words, which leaves the decoder to compile on
   * the first real turn (measured: 3.3 s then, against 0.2 s once warmed with speech).
   */
  async warm(): Promise<void> {
    const client = await this.start()
    this._state = { state: 'starting', line: 'warming up' }
    try {
      const { pcm, sampleRate } = parseWav(new Uint8Array(readFileSync(WARM_CLIP)))
      await client.transcribe(pcm, sampleRate)
    } finally {
      if (this._proc) this._state = { state: 'running' }
    }
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
    // The server is leashed, so it stops when Myrmidon does however Myrmidon ends; one left by an older Myrmidon would
    // still hold its socket and the model in memory, so it is stopped first.
    await stopLeftovers(this._socket)
    rmSync(this._socket, { force: true })
    this._state = { state: 'starting' }
    const proc = spawnLeashed([fermion, 'serve', 'phonon-2', '--unix-socket', this._socket], {
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
      hotwords: true,
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

/**
 * Stops Phonon servers still serving `socket` from an earlier run of Myrmidon. The socket sits in this home's private
 * voice folder, so any server on it is ours; it is asked to stop, then killed if it has not after a moment.
 */
export async function stopLeftovers(socket: string, waitMs = 2000): Promise<number[]> {
  const ps = Bun.spawnSync(['ps', '-Ao', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' })
  const pids = new TextDecoder()
    .decode(ps.stdout)
    .split('\n')
    .flatMap((line) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (!m?.[1] || !m[2]) return []
      const pid = Number(m[1])
      const words = m[2].split(/\s+/)
      const at = words.indexOf('--unix-socket')
      const serving = words.includes('serve') && words.includes('phonon-2') && words[at + 1] === socket
      return serving && at >= 0 && pid !== process.pid ? [pid] : []
    })
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  // It may exit on its own between the listing and the signal; that is the outcome wanted.
  const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
    }
  }
  for (const pid of pids) signal(pid, 'SIGTERM')
  const deadline = Date.now() + waitMs
  while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(50)
  for (const pid of pids.filter(alive)) signal(pid, 'SIGKILL')
  return pids
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
