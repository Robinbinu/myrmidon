import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
export const KITTEN_MODELS = {
  nano: 'KittenML/kitten-tts-nano-0.8',
  micro: 'KittenML/kitten-tts-micro-0.8',
  mini: 'KittenML/kitten-tts-mini-0.8',
} as const
export type KittenModel = keyof typeof KITTEN_MODELS
export const KITTEN_VOICES = ['Bella', 'Luna', 'Rosie', 'Kiki', 'Leo', 'Jasper', 'Bruno', 'Hugo'] as const

export type KittenState =
  | { state: 'missing' }
  | { state: 'downloading'; done: number; total: number }
  | { state: 'ready' }
  | { state: 'running' }
  | { state: 'error'; error: string }

const WORKER = join(import.meta.dir, 'kitten-worker.ts')

/**
 * Kitten TTS on this machine: its model downloaded from Hugging Face into `<home>/voice/kitten/<model>`, run in a
 * worker process of its own (see kitten-worker.ts) started on first use and kept for the next sentence.
 */
export class KittenTts implements TextToSpeech {
  private _proc?: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  private _ready?: Promise<void>
  private _next = 1
  private readonly _waiting = new Map<number, { resolve(s: Speech): void; reject(e: Error): void }>()
  private _download?: KittenState

  constructor(
    private readonly home: string,
    private readonly options: () => { model: KittenModel; voice: string; speed: number },
    private readonly log: (line: string) => void = () => {},
    private readonly hub = 'https://huggingface.co',
  ) {}

  private _dir(model: KittenModel) {
    return join(this.home, 'voice', 'kitten', model)
  }

  status(model = this.options().model): KittenState {
    if (this._download && this._download.state !== 'ready') return this._download
    if (!existsSync(join(this._dir(model), 'config.json'))) return { state: 'missing' }
    return this._proc && model === this.options().model ? { state: 'running' } : { state: 'ready' }
  }

  /** Downloads a model's three files (its settings, the network, the voices); a model already here is kept. */
  async download(model = this.options().model): Promise<void> {
    const dir = this._dir(model)
    if (existsSync(join(dir, 'config.json'))) return
    const repo = KITTEN_MODELS[model]
    const get = async (file: string) => {
      const res = await fetch(`${this.hub}/${repo}/resolve/main/${file}`)
      if (!res.ok) throw new Error(`downloading ${file} from ${repo} failed (${res.status})`)
      return new Uint8Array(await res.arrayBuffer())
    }
    try {
      this._download = { state: 'downloading', done: 0, total: 3 }
      const configBytes = await get('config.json')
      const config = JSON.parse(new TextDecoder().decode(configBytes)) as {
        model_file?: string
        voices?: string
      }
      if (!config.model_file) throw new Error(`${repo} has no model_file in its config`)
      this._download = { state: 'downloading', done: 1, total: 3 }
      const network = await get(config.model_file)
      this._download = { state: 'downloading', done: 2, total: 3 }
      const voices = await get(config.voices ?? 'voices.npz')
      // Written to a side folder, then moved, so a half-finished download never looks complete.
      const part = `${dir}.part`
      mkdirSync(part, { recursive: true })
      writeFileSync(join(part, config.model_file), network)
      writeFileSync(join(part, config.voices ?? 'voices.npz'), voices)
      writeFileSync(join(part, 'config.json'), configBytes)
      mkdirSync(join(dir, '..'), { recursive: true })
      renameSync(part, dir)
      this._download = undefined
    } catch (err) {
      this._download = { state: 'error', error: err instanceof Error ? err.message : String(err) }
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
    const proc = Bun.spawn([process.execPath, WORKER, this._dir(model)], {
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
        const msg = JSON.parse(line) as {
          ready?: true
          id?: number
          rate?: number
          pcm?: string
          error?: string
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
