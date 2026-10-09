import {
  VOICE_CLOUD_TIMEOUT_MS,
  VOICE_STT_CHUNK_MS,
  VOICE_STT_FINISH_MS,
  VOICE_STT_KEEPALIVE_MS,
  VOICE_TTS_CHUNK_MS,
} from '../../config.ts'
import { parseWav, wav } from '../audio.ts'
import type { LiveTranscription } from '../phonon-stream.ts'
import type { ListenOptions, SpeechToText, TranscribeOptions } from '../stt.ts'
import type { Speech, TextToSpeech } from '../tts.ts'

/** A provider's error, with its status and its own words (never the request, which carries the key). */
export async function failure(what: string, res: Response): Promise<Error> {
  const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim()
  return new Error(`${what} failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`)
}

/** A request's signal: the caller's, and a timeout so a provider that never answers does not hold a call up. */
export function timed(signal?: AbortSignal, ms = VOICE_CLOUD_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Raw 16-bit little-endian mono bytes as they arrive, as samples: an odd byte waits for its other half. */
export class PcmBytes {
  private _odd?: number

  push(bytes: Uint8Array): Int16Array {
    const all = this._odd === undefined ? bytes : new Uint8Array([this._odd, ...bytes])
    this._odd = all.length % 2 ? all[all.length - 1] : undefined
    const n = Math.floor(all.length / 2)
    const out = new Int16Array(n)
    const v = new DataView(all.buffer, all.byteOffset, n * 2)
    for (let i = 0; i < n; i++) out[i] = v.getInt16(i * 2, true)
    return out
  }
}

/**
 * A response body of raw 16-bit mono PCM as it arrives, in pieces of at least VOICE_TTS_CHUNK_MS (a provider sends
 * its body in small parts, and each piece becomes a frame to the person's side).
 */
export async function* pcmBody(
  res: Response,
  sampleRate: number,
  minMs = VOICE_TTS_CHUNK_MS,
): AsyncGenerator<Speech> {
  if (!res.body) return
  const bytes = new PcmBytes()
  const min = Math.round((minMs / 1000) * sampleRate)
  let held: Int16Array[] = []
  let length = 0
  const take = () => {
    const pcm = new Int16Array(length)
    let at = 0
    for (const h of held) {
      pcm.set(h, at)
      at += h.length
    }
    held = []
    length = 0
    return { pcm, sampleRate }
  }
  for await (const part of res.body) {
    const pcm = bytes.push(part)
    if (!pcm.length) continue
    held.push(pcm)
    length += pcm.length
    if (length >= min) yield take()
  }
  if (length) yield take()
}

/** A stream of speech as one clip. */
export async function collect(chunks: AsyncIterable<Speech>, fallbackRate: number): Promise<Speech> {
  const parts: Int16Array[] = []
  let sampleRate = fallbackRate
  for await (const c of chunks) {
    parts.push(c.pcm)
    sampleRate = c.sampleRate
  }
  const pcm = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    pcm.set(p, at)
    at += p.length
  }
  return { pcm, sampleRate }
}

/**
 * Text to speech over HTTP whose answer is raw 16-bit PCM at `sampleRate`, read as it streams in, so the first words
 * play while the rest of the sentence is still being made.
 */
export class HttpPcmTts implements TextToSpeech {
  constructor(
    private readonly what: string,
    readonly sampleRate: number,
    private readonly request: (text: string, signal: AbortSignal) => Promise<Response>,
  ) {}

  async *stream(text: string, signal?: AbortSignal): AsyncGenerator<Speech> {
    const res = await this.request(text, timed(signal))
    if (!res.ok) throw await failure(this.what, res)
    yield* pcmBody(res, this.sampleRate)
  }

  speak(text: string, signal?: AbortSignal): Promise<Speech> {
    return collect(this.stream(text, signal), this.sampleRate)
  }
}

/** Text to speech over HTTP that answers with a whole WAV file (or one in base64 JSON, which `read` unwraps). */
export class HttpWavTts implements TextToSpeech {
  constructor(
    private readonly what: string,
    private readonly request: (text: string, signal: AbortSignal) => Promise<Response>,
    private readonly read: (res: Response) => Promise<Uint8Array> = async (res) =>
      new Uint8Array(await res.arrayBuffer()),
  ) {}

  async speak(text: string, signal?: AbortSignal): Promise<Speech> {
    const res = await this.request(text, timed(signal))
    if (!res.ok) throw await failure(this.what, res)
    return parseWav(await this.read(res))
  }
}

/** What a streaming speech-to-text server's message means for the turn's words. */
export interface WsRead {
  /** The words of the phrase in flight, so far (replacing what came before for it). */
  readonly partial?: string
  /** A phrase is settled: these are its words (the phrase in flight is done). */
  readonly final?: string
  /** Everything sent so far has been transcribed: a finish can return. */
  readonly done?: boolean
  /** The server took the session's start and wants audio now. */
  readonly ready?: boolean
  readonly error?: string
}

/** A WebSocket message to send: text (JSON or a word) or binary. */
export type WsSend = string | Uint8Array<ArrayBuffer>

/**
 * A WebSocket to a provider, with headers (its key): Bun's WebSocket takes them (Bun.WebSocketOptions), though the DOM
 * typings this project also loads know only subprotocols.
 */
export function openSocket(url: string, headers?: Record<string, string>): WebSocket {
  return new WebSocket(url, (headers ? { headers } : {}) as unknown as string[])
}

/** One provider's streaming speech-to-text protocol, as WsTranscription speaks it. */
export interface WsProtocol {
  readonly what: string
  /** Where to connect, signed or with the key in it where the provider wants that (AWS). */
  url(): string | Promise<string>
  readonly headers?: Record<string, string>
  /** Sent once the socket opens, before any audio (a provider's start or config message). */
  start?(): WsSend[]
  /** Whether audio waits for the server's `ready` (Speechmatics wants its start acknowledged first). */
  readonly waitReady?: boolean
  /** A piece of audio as the provider takes it: binary PCM, or base64 in JSON. */
  audio(pcm: Int16Array): WsSend
  /** Asks for the words of all audio sent so far; undefined when ending the stream is how to ask (`end`). */
  finalize?(): WsSend[]
  /** Ends the stream: the server sends what is left, then closes. */
  end?(): WsSend[]
  /** Keeps a stream open through a quiet stretch (Deepgram's KeepAlive). */
  keepAlive?(): WsSend
  read(message: string | Uint8Array): WsRead
  /** The smallest piece of audio the provider takes in one message, in ms. */
  readonly chunkMs?: number
  /** Its settled pieces are to be joined as sent, spaces and all (Cartesia's), not as words. */
  readonly concat?: boolean
}

/**
 * A turn's words as they are heard, over a provider's WebSocket (after Pipecat's websocket STT services): audio pushed
 * before the socket opens waits for it, the words so far go to `heard`, and `finish` asks for the rest once the turn is
 * over and returns all of it. The socket is the turn's own: the provider is sent (and bills) only what was said.
 */
export class WsTranscription implements LiveTranscription {
  private _ws?: WebSocket
  private _open = false
  private _ready = false
  private _closed = false
  /** The stream was ended (to ask for the rest, where ending is how to ask): it is not ended twice. */
  private _ended = false
  private _pending: WsSend[] = []
  private _held: Int16Array[] = []
  private _heldLength = 0
  private readonly _finals: string[] = []
  private _partial = ''
  private _done?: () => void
  private _failed?: (err: Error) => void
  private _error?: Error
  private _keepAlive?: ReturnType<typeof setInterval>
  private _lastSent = Date.now()

  constructor(
    private readonly protocol: WsProtocol,
    private readonly sampleRate: number,
    private readonly heard: (text: string) => void = () => {},
    private readonly log: (line: string) => void = () => {},
  ) {
    void this._connect()
  }

  private async _connect() {
    try {
      const url = await this.protocol.url()
      if (this._closed) return
      const ws = openSocket(url, this.protocol.headers)
      ws.binaryType = 'arraybuffer'
      this._ws = ws
      ws.onopen = () => {
        this._open = true
        for (const m of this.protocol.start?.() ?? []) ws.send(m)
        if (!this.protocol.waitReady) this._becomeReady()
        if (this.protocol.keepAlive)
          this._keepAlive = setInterval(() => {
            const k = this.protocol.keepAlive?.()
            if (k && this._ready && Date.now() - this._lastSent >= VOICE_STT_KEEPALIVE_MS) this._send(k)
          }, VOICE_STT_KEEPALIVE_MS)
      }
      ws.onmessage = (e) => {
        const data = typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer)
        let read: WsRead
        try {
          read = this.protocol.read(data)
        } catch (err) {
          return this._fail(err instanceof Error ? err.message : String(err))
        }
        this._read(read)
      }
      ws.onerror = () => this._fail(`${this.protocol.what}: the connection failed`)
      ws.onclose = (e) => {
        clearInterval(this._keepAlive)
        // A close before anything was heard back is the provider refusing (a bad key closes with a reason).
        if (!this._closed && !this._open) this._fail(`${this.protocol.what}: closed (${e.code} ${e.reason})`)
        this._closed = true
        this._done?.()
      }
    } catch (err) {
      this._fail(err instanceof Error ? err.message : String(err))
    }
  }

  private _becomeReady() {
    this._ready = true
    for (const m of this._pending.splice(0)) this._send(m)
  }

  private _read(read: WsRead) {
    if (read.error) return this._fail(`${this.protocol.what}: ${read.error}`)
    if (read.ready && !this._ready) this._becomeReady()
    if (read.final !== undefined) {
      if (this.protocol.concat) this._finals.push(read.final)
      else if (read.final.trim()) this._finals.push(read.final.trim())
      this._partial = ''
      this.heard(this.text())
    } else if (read.partial !== undefined) {
      this._partial = read.partial.trim()
      this.heard(this.text())
    }
    if (read.done) this._done?.()
  }

  /** The words heard so far: the settled phrases, then the one in flight. */
  text(): string {
    if (this.protocol.concat)
      return `${this._finals.join('')}${this._partial ? ` ${this._partial}` : ''}`.trim()
    return [...this._finals, this._partial].filter(Boolean).join(' ')
  }

  push(pcm: Int16Array) {
    if (this._closed || this._error) return
    this._held.push(pcm)
    this._heldLength += pcm.length
    const min = Math.round(((this.protocol.chunkMs ?? VOICE_STT_CHUNK_MS) / 1000) * this.sampleRate)
    if (this._heldLength >= min) this._sendHeld()
  }

  private _sendHeld(pad = false) {
    if (!this._heldLength) return
    const min = Math.round(((this.protocol.chunkMs ?? VOICE_STT_CHUNK_MS) / 1000) * this.sampleRate)
    // The last piece is padded with quiet up to the smallest a provider takes.
    const pcm = new Int16Array(pad ? Math.max(min, this._heldLength) : this._heldLength)
    let at = 0
    for (const h of this._held) {
      pcm.set(h, at)
      at += h.length
    }
    this._held = []
    this._heldLength = 0
    this._send(this.protocol.audio(pcm))
  }

  private _send(message: WsSend) {
    if (!this._ready || !this._ws) {
      this._pending.push(message)
      return
    }
    try {
      this._ws.send(message)
      this._lastSent = Date.now()
    } catch (err) {
      this._fail(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * The turn is over: what is still held goes out, the provider is asked for the rest, and the turn's words come back
   * once it says it is done (or closes), or after VOICE_STT_FINISH_MS with what it had. Rejects when the stream failed,
   * so the turn can be transcribed another way.
   */
  finish(): Promise<string> {
    if (this._error) return Promise.reject(this._error)
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => done(), VOICE_STT_FINISH_MS)
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const text = this.text()
        this.close()
        resolve(text)
      }
      this._done = done
      this._failed = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.close()
        reject(err)
      }
      if (this._closed) return done()
      this._sendHeld(true)
      const ask = this.protocol.finalize?.()
      if (!ask) this._ended = true
      for (const m of ask ?? this.protocol.end?.() ?? []) this._send(m)
    })
  }

  close() {
    if (this._closed) return
    this._closed = true
    clearInterval(this._keepAlive)
    this._pending = []
    const ws = this._ws
    if (!ws) return
    try {
      if (ws.readyState === WebSocket.OPEN && this.protocol.end && this._ready && !this._ended)
        for (const m of this.protocol.end()) ws.send(m)
      ws.close(1000)
    } catch {
      // Already closed.
    }
  }

  private _fail(why: string) {
    if (this._error) return
    this._error = new Error(why)
    this.log(why)
    this._failed?.(this._error)
    this.close()
  }
}

/**
 * Speech to text over a provider's stream only (AssemblyAI, Speechmatics, AWS Transcribe): a turn as it is heard, and
 * a whole turn by sending it through a stream of its own.
 */
export class StreamingStt implements SpeechToText {
  constructor(
    private readonly open: (
      sampleRate: number,
      heard: (text: string) => void,
      options: ListenOptions,
    ) => WsTranscription,
    private readonly log: (line: string) => void = () => {},
  ) {}

  listen(sampleRate: number, heard: (text: string) => void, options: ListenOptions = {}): LiveTranscription {
    return this.open(sampleRate, heard, { ...options, log: options.log ?? this.log })
  }

  async transcribe(pcm: Int16Array, sampleRate: number, options: TranscribeOptions = {}): Promise<string> {
    const live = this.open(sampleRate, () => {}, {
      ...(options.hotwords ? { hotwords: options.hotwords } : {}),
      log: this.log,
    })
    live.push(pcm)
    return live.finish()
  }
}

/** A turn as base64 (WebSocket JSON audio and REST bodies take it so). */
export function base64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')
}

/** A turn as the bytes of its samples. */
export function bytesOf(pcm: Int16Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(pcm.buffer as ArrayBuffer, pcm.byteOffset, pcm.byteLength)
}

/** A turn as a WAV file in a form field, for the batch endpoints that take an upload. */
export function wavBlob(pcm: Int16Array, sampleRate: number): Blob {
  return new Blob([wav(pcm, sampleRate)], { type: 'audio/wav' })
}

/** JSON from a message that may come as text or bytes; undefined when it is not JSON. */
export function json(message: string | Uint8Array): Record<string, unknown> | undefined {
  try {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** XML-escaped text, for SSML. */
export function xmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
