import { randomBytes } from 'node:crypto'
import type { Socket } from 'bun'

/** A turn's words as they are heard, for an engine that streams: its audio in as it comes, the words so far out. */
export interface LiveTranscription {
  push(pcm: Int16Array): void
  /** The turn is over (or dropped): what the engine is still decoding for it is not waited for. */
  close(): void
}

const TEXT = 0x1
const BINARY = 0x2
const CLOSE = 0x8

/**
 * Phonon-2's `GET /v1/audio/stream` for one turn: a WebSocket on the server's Unix socket (Bun's WebSocket client
 * cannot reach one, so this speaks RFC 6455 itself, only as much as that endpoint uses: unfragmented text and binary
 * frames). It sends `{"sample_rate", "format": "pcm_s16le"}`, then the audio, and calls `heard` with the turn so far
 * whenever Phonon has a new partial (a re-decode of the phrase in flight, about every 0.5 s of speech) or closes a
 * phrase at a pause (`final`; the partials after it are the next phrase's).
 */
export class PhononStream implements LiveTranscription {
  private _socket?: Socket<undefined>
  private _open = false
  private _closed = false
  /** Audio pushed before the server took the upgrade, sent once it has. */
  private _pending: Int16Array[] = []
  /** Bytes the socket has not taken yet: Bun's writes are unbuffered, and Phonon reads nothing while it decodes. */
  private _unsent = new Uint8Array(0)
  private _received = new Uint8Array(0)
  private readonly _finals: string[] = []

  constructor(
    unix: string,
    private readonly sampleRate: number,
    private readonly heard: (text: string) => void,
    private readonly log: (line: string) => void = () => {},
  ) {
    Bun.connect({
      unix,
      socket: {
        open: (socket) => {
          if (this._closed) return void socket.end()
          this._socket = socket
          const key = randomBytes(16).toString('base64')
          this._write(
            new TextEncoder().encode(
              `GET /v1/audio/stream HTTP/1.1\r\nHost: phonon\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
                `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
            ),
          )
        },
        data: (_socket, chunk) => this._data(chunk),
        drain: () => this._flush(),
        close: () => {
          this._closed = true
        },
        error: (_socket, err) => this._fail(err.message),
      },
    }).catch((err: Error) => this._fail(err.message))
  }

  push(pcm: Int16Array) {
    if (this._closed) return
    if (!this._open) {
      this._pending.push(pcm)
      return
    }
    this._send(BINARY, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
  }

  close() {
    this._closed = true
    this._pending = []
    // A bare end, not `{"type":"end"}` or a close frame: either makes Phonon decode the phrase in flight once more,
    // which would hold the turn's own transcription up behind it (it decodes one thing at a time).
    this._socket?.end()
  }

  private _data(chunk: Uint8Array) {
    // Words still on their way once the turn is over would show after its transcript.
    if (this._closed) return
    const all = new Uint8Array(this._received.length + chunk.length)
    all.set(this._received)
    all.set(chunk, this._received.length)
    this._received = all
    if (!this._open) {
      const head = new TextDecoder().decode(this._received).indexOf('\r\n\r\n')
      if (head < 0) return
      const status = new TextDecoder().decode(this._received.subarray(0, head)).split('\r\n')[0] ?? ''
      if (!status.startsWith('HTTP/1.1 101')) return this._fail(status)
      this._open = true
      this._received = this._received.slice(head + 4)
      const config = JSON.stringify({ sample_rate: this.sampleRate, format: 'pcm_s16le' })
      this._send(TEXT, new TextEncoder().encode(config))
      for (const pcm of this._pending.splice(0)) this.push(pcm)
    }
    for (let frame = this._frame(); frame; frame = this._frame()) {
      if (frame.op === CLOSE) return this.close()
      if (frame.op === TEXT) this._message(new TextDecoder().decode(frame.payload))
    }
  }

  /** The next whole frame the server sent (its frames are never masked), taken off what was received. */
  private _frame(): { op: number; payload: Uint8Array } | undefined {
    const b = this._received
    if (b.length < 2) return undefined
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
    let length = (b[1] ?? 0) & 0x7f
    let at = 2
    if (length === 126) {
      if (b.length < 4) return undefined
      length = v.getUint16(2)
      at = 4
    } else if (length === 127) {
      if (b.length < 10) return undefined
      length = Number(v.getBigUint64(2))
      at = 10
    }
    if (b.length < at + length) return undefined
    this._received = b.slice(at + length)
    return { op: (b[0] ?? 0) & 0x0f, payload: b.subarray(at, at + length) }
  }

  private _message(raw: string) {
    let msg: { type?: unknown; text?: unknown; message?: unknown }
    try {
      msg = JSON.parse(raw)
    } catch {
      return this._fail(`not JSON: ${raw.slice(0, 80)}`)
    }
    const text = typeof msg.text === 'string' ? msg.text.trim() : ''
    if (msg.type === 'partial' && text) this.heard([...this._finals, text].join(' '))
    else if (msg.type === 'final' && text) {
      this._finals.push(text)
      this.heard(this._finals.join(' '))
    } else if (msg.type === 'error') this._fail(String(msg.message))
  }

  /** Masked, as every client frame must be (RFC 6455 §5.3). */
  private _send(op: number, payload: Uint8Array) {
    const mask = randomBytes(4)
    const n = payload.length
    const head = n < 126 ? 2 : n < 65_536 ? 4 : 10
    const frame = new Uint8Array(head + 4 + n)
    const v = new DataView(frame.buffer)
    frame[0] = 0x80 | op
    if (n < 126) frame[1] = 0x80 | n
    else if (n < 65_536) {
      frame[1] = 0x80 | 126
      v.setUint16(2, n)
    } else {
      frame[1] = 0x80 | 127
      v.setBigUint64(2, BigInt(n))
    }
    frame.set(mask, head)
    for (let i = 0; i < n; i++) frame[head + 4 + i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0)
    this._write(frame)
  }

  private _write(bytes: Uint8Array) {
    const all = new Uint8Array(this._unsent.length + bytes.length)
    all.set(this._unsent)
    all.set(bytes, this._unsent.length)
    this._unsent = all
    this._flush()
  }

  private _flush() {
    if (!this._socket || this._closed || !this._unsent.length) return
    const n = this._socket.write(this._unsent)
    if (n < 0) return this._fail('the socket closed')
    this._unsent = this._unsent.slice(n)
  }

  /** No live words for this turn (another call has the stream, say); its transcript still comes as before. */
  private _fail(why: string) {
    if (this._closed) return
    this.log(`phonon stream: ${why}`)
    this.close()
  }
}
