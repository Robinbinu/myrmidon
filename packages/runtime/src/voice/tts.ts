import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { VOICE_KITTEN_MODELS } from '../config.ts'
import { parseWav } from './audio.ts'
import { lines } from './stt.ts'

/** Speech for one sentence: 16-bit mono samples and their rate. */
export interface Speech {
  readonly pcm: Int16Array
  readonly sampleRate: number
}

/** Text to speech for a call, a sentence at a time so the first one plays while the rest are written. */
export interface TextToSpeech {
  speak(text: string, signal?: AbortSignal): Promise<Speech>
  /**
   * The sentence's speech in pieces as it is made, for an engine that streams (a cloud provider's), so its first words
   * play before the rest of it is made.
   */
  stream?(text: string, signal?: AbortSignal): AsyncIterable<Speech>
}

/** An OpenAI-compatible `/audio/speech` endpoint (OpenAI, a local Kokoro or Piper server…), asked for WAV. */
export class OpenAiCompatibleTts implements TextToSpeech {
  constructor(
    private readonly options: {
      readonly baseUrl: string
      readonly model: string
      readonly voice: string
      readonly speed?: number
      readonly apiKey?: string
    },
  ) {}

  async speak(text: string, signal?: AbortSignal): Promise<Speech> {
    const res = await fetch(`${this.options.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.options.model,
        input: text,
        voice: this.options.voice,
        response_format: 'wav',
        ...(this.options.speed ? { speed: this.options.speed } : {}),
      }),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) throw new Error(`speech failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
    const { pcm, sampleRate } = parseWav(new Uint8Array(await res.arrayBuffer()))
    return { pcm, sampleRate }
  }
}

/** Speech from a function returning a WAV file: the speech model omp can call. */
export class FunctionTts implements TextToSpeech {
  constructor(private readonly run: (text: string) => Promise<{ audio: Uint8Array; mimeType: string }>) {}

  async speak(text: string): Promise<Speech> {
    const { audio } = await this.run(text)
    const { pcm, sampleRate } = parseWav(audio)
    return { pcm, sampleRate }
  }
}

/** Kitten TTS's models (KittenML, Apache-2.0): smaller is faster, larger sounds better. */
export type KittenModel = keyof typeof VOICE_KITTEN_MODELS
/** Where a model comes from: a repo at a fixed revision, and each of its files' sha256 and size. */
export interface KittenPin {
  readonly repo: string
  readonly revision: string
  readonly files: Readonly<Record<string, { readonly sha256: string; readonly bytes: number }>>
}
export const KITTEN_VOICES = ['Bella', 'Luna', 'Rosie', 'Kiki', 'Leo', 'Jasper', 'Bruno', 'Hugo'] as const

/** The bytes a model downloads. */
export function kittenBytes(pin: KittenPin): number {
  return Object.values(pin.files).reduce((n, f) => n + f.bytes, 0)
}

export type KittenState =
  | { state: 'missing' }
  /** Files `done` of `total`, and bytes `received` of `size`. */
  | { state: 'downloading'; done: number; total: number; received: number; size: number }
  | { state: 'ready' }
  | { state: 'running' }
  | { state: 'error'; error: string }

/** The command that makes a compiled Myrmidon run the worker it carries (see apps/desktop/src/sidecar.ts). */
export const KITTEN_WORKER_COMMAND = 'kitten-worker'
const WORKER = join(import.meta.dir, 'kitten-worker.ts')
// A compiled Myrmidon (the desktop app's server) has no kitten-worker.ts on disk to run, so it starts itself.
const WORKER_ARGV = [process.execPath, existsSync(WORKER) ? WORKER : KITTEN_WORKER_COMMAND]
/** In a model's folder: the pinned revision its files were checked against. */
const PINNED = '.pinned'

/**
 * Kitten TTS on this machine: its model downloaded from Hugging Face into `<home>/voice/kitten/<model>` (each file
 * checked against its pinned hash), run in a worker process of its own (see kitten-worker.ts) started on first use
 * and kept for the next sentence.
 */
export class KittenTts implements TextToSpeech {
  private _proc?: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  private _ready?: Promise<void>
  private _next = 1
  private readonly _waiting = new Map<number, { resolve(s: Speech): void; reject(e: Error): void }>()
  /** Each model's download, while it runs or once it failed. */
  private readonly _download = new Map<KittenModel, KittenState>()
  /** Downloads under way, so a warm-up and the Download button share one. */
  private readonly _downloads = new Map<KittenModel, Promise<void>>()

  constructor(
    private readonly home: string,
    private readonly options: () => { model: KittenModel; voice: string; speed: number },
    private readonly log: (line: string) => void = () => {},
    private readonly hub = 'https://huggingface.co',
    readonly pins: Readonly<Record<KittenModel, KittenPin>> = VOICE_KITTEN_MODELS,
  ) {}

  private _dir(model: KittenModel) {
    return join(this.home, 'voice', 'kitten', model)
  }

  status(model = this.options().model): KittenState {
    const download = this._download.get(model)
    if (download) return download
    if (!existsSync(join(this._dir(model), 'config.json'))) return { state: 'missing' }
    return this._proc && model === this.options().model ? { state: 'running' } : { state: 'ready' }
  }

  /**
   * Downloads a model's three files (its settings, the network, the voices). A model already here is kept if it is
   * the pinned one: checked by hash the first time (it may predate the pins, or the pin may have moved), then
   * known by the revision noted in its folder. One that is not is downloaded again.
   */
  download(model = this.options().model): Promise<void> {
    let job = this._downloads.get(model)
    if (!job) {
      job = this._ensure(model).finally(() => this._downloads.delete(model))
      this._downloads.set(model, job)
    }
    return job
  }

  private async _ensure(model: KittenModel): Promise<void> {
    const dir = this._dir(model)
    if (existsSync(join(dir, 'config.json'))) {
      if (await this._pinned(model)) return
      this.log(`kitten: the ${model} model here is not the pinned one; downloading it again`)
      rmSync(dir, { recursive: true, force: true })
    }
    await this._fetch(model)
  }

  /** Whether the model in its folder is the pinned one. */
  private async _pinned(model: KittenModel): Promise<boolean> {
    const dir = this._dir(model)
    const pin = this.pins[model]
    const stamp = join(dir, PINNED)
    if (existsSync(stamp) && readFileSync(stamp, 'utf8') === pin.revision) return true
    for (const [name, want] of Object.entries(pin.files)) {
      const file = Bun.file(join(dir, name))
      if (!(await file.exists())) return false
      if (
        createHash('sha256')
          .update(await file.bytes())
          .digest('hex') !== want.sha256
      )
        return false
    }
    writeFileSync(stamp, pin.revision)
    return true
  }

  private async _fetch(model: KittenModel): Promise<void> {
    const dir = this._dir(model)
    const pin = this.pins[model]
    const total = Object.keys(pin.files).length
    const size = kittenBytes(pin)
    let done = 0
    let received = 0
    const progress = () => {
      this._download.set(model, { state: 'downloading', done, total, received, size })
    }
    const get = async (file: string) => {
      const want = pin.files[file]
      if (!want) throw new Error(`${file} is not one of ${pin.repo}'s pinned files`)
      const res = await fetch(`${this.hub}/${pin.repo}/resolve/${pin.revision}/${file}`)
      if (!res.ok || !res.body) throw new Error(`downloading ${file} from ${pin.repo} failed (${res.status})`)
      const hash = createHash('sha256')
      const parts: Uint8Array[] = []
      for await (const part of res.body) {
        hash.update(part)
        parts.push(part)
        received += part.byteLength
        progress()
      }
      if (hash.digest('hex') !== want.sha256)
        throw new Error(`${file} from ${pin.repo} did not match its pinned hash`)
      done += 1
      progress()
      return Buffer.concat(parts)
    }
    try {
      progress()
      const configBytes = await get('config.json')
      const config = JSON.parse(new TextDecoder().decode(configBytes)) as {
        model_file?: unknown
        voices?: unknown
      }
      const networkFile = pinnedName(config.model_file, pin)
      const voicesFile = pinnedName(config.voices ?? 'voices.npz', pin)
      const network = await get(networkFile)
      const voices = await get(voicesFile)
      // Written to a side folder, then moved, so a half-finished download never looks complete.
      const part = `${dir}.part`
      mkdirSync(part, { recursive: true })
      writeFileSync(join(part, networkFile), network)
      writeFileSync(join(part, voicesFile), voices)
      writeFileSync(join(part, 'config.json'), configBytes)
      writeFileSync(join(part, PINNED), pin.revision)
      mkdirSync(join(dir, '..'), { recursive: true })
      renameSync(part, dir)
      this._download.delete(model)
    } catch (err) {
      this._download.set(model, { state: 'error', error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  async speak(text: string, signal?: AbortSignal): Promise<Speech> {
    await this._start()
    const proc = this._proc
    if (!proc) throw new Error('Kitten TTS stopped')
    const id = this._next++
    const { voice, speed } = this.options()
    const done = new Promise<Speech>((resolve, reject) => this._waiting.set(id, { resolve, reject }))
    proc.stdin.write(`${JSON.stringify({ id, text, voice, speed })}\n`)
    proc.stdin.flush()
    signal?.addEventListener('abort', () => {
      // The worker finishes the sentence anyway; the answer is dropped.
      this._waiting.get(id)?.reject(new Error('aborted'))
      this._waiting.delete(id)
    })
    return done
  }

  stop() {
    this._proc?.kill()
    this._proc = undefined
    this._ready = undefined
    for (const w of this._waiting.values()) w.reject(new Error('Kitten TTS stopped'))
    this._waiting.clear()
  }

  private _start(): Promise<void> {
    this._ready ??= this._spawn().catch((err) => {
      this.stop()
      throw err
    })
    return this._ready
  }

  private async _spawn(): Promise<void> {
    const { model } = this.options()
    await this.download(model)
    const proc = Bun.spawn([...WORKER_ARGV, this._dir(model)], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this._proc = proc
    const tail: string[] = []
    void (async () => {
      for await (const line of lines(proc.stderr)) {
        tail.push(line)
        if (tail.length > 10) tail.shift()
        this.log(`kitten: ${line.slice(0, 300)}`)
      }
    })()
    let ready: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    void (async () => {
      for await (const line of lines(proc.stdout)) {
        let msg: { ready?: true; id?: number; rate?: number; pcm?: string; error?: string }
        try {
          msg = JSON.parse(line)
        } catch {
          // Not an answer (what else printed to stdout); thrown here it would be unhandled and end the server.
          this.log(`kitten: ${line.slice(0, 300)}`)
          continue
        }
        if (msg.ready) {
          ready()
          continue
        }
        const waiting = msg.id === undefined ? undefined : this._waiting.get(msg.id)
        if (!waiting || msg.id === undefined) continue
        this._waiting.delete(msg.id)
        if (msg.error || !msg.pcm || !msg.rate) waiting.reject(new Error(msg.error ?? 'no audio'))
        else {
          const bytes = Buffer.from(msg.pcm, 'base64')
          waiting.resolve({
            pcm: new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2).slice(),
            sampleRate: msg.rate,
          })
        }
      }
    })()
    const exited = proc.exited.then((code) => {
      if (this._proc === proc) this.stop()
      throw new Error(`Kitten TTS stopped (exit ${code}): ${tail.slice(-2).join(' ')}`)
    })
    // Only a worker that dies before it is ready is an error here; one stopped later just ends.
    exited.catch(() => {})
    await Promise.race([started, exited])
  }
}

/**
 * A file a model's config names, as a plain name in the model's folder: no path (the config comes from the network,
 * and a name like `../../x` would be written outside it), and one of the files pinned for it.
 */
function pinnedName(name: unknown, pin: KittenPin): string {
  if (
    typeof name !== 'string' ||
    name !== basename(name) ||
    /[\\/]/.test(name) ||
    name === '.' ||
    name === '..' ||
    !Object.hasOwn(pin.files, name)
  )
    throw new Error(`${pin.repo}'s config names an unexpected file: ${String(name).slice(0, 80)}`)
  return name
}
