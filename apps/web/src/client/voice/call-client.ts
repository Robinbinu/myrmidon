import { callSocket } from '../api.ts'
import { CALL_FRAME, CALL_RATE } from '../ui-config.ts'

export type CallState =
  | 'connecting'
  | 'preparing'
  | 'listening'
  | 'hearing'
  | 'thinking'
  | 'speaking'
  | 'ended'

export interface CallHandlers {
  state(state: CallState): void
  /** A line of the transcript: what the person said, or what the call said. */
  line(who: 'person' | 'voice', text: string): void
  /** The mic's level, 0–1, for the meter. */
  level(level: number): void
  /** The call started its first task in a new chat. */
  chat(chatId: string): void
  task(request: string): void
  error(message: string): void
  ended(reason: string): void
}

/**
 * Downsamples the mic to CALL_RATE in the audio thread and posts 16-bit frames of CALL_FRAME samples, with their level.
 * Averaging each step's samples is a crude low-pass, enough for speech recognition.
 */
const WORKLET = `
class MyrMic extends AudioWorkletProcessor {
  constructor() { super(); this.step = sampleRate / ${CALL_RATE}; this.pos = 0; this.acc = 0; this.n = 0; this.out = new Float32Array(${CALL_FRAME}); this.k = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.n++; this.pos += 1
      if (this.pos < this.step) continue
      this.pos -= this.step
      this.out[this.k++] = this.acc / this.n
      this.acc = 0; this.n = 0
      if (this.k < ${CALL_FRAME}) continue
      const frame = new Int16Array(${CALL_FRAME}); let sum = 0
      for (let j = 0; j < ${CALL_FRAME}; j++) { const v = Math.max(-1, Math.min(1, this.out[j])); frame[j] = v * 32767; sum += v * v }
      this.port.postMessage({ frame, level: Math.sqrt(sum / ${CALL_FRAME}) }, [frame.buffer])
      this.k = 0
    }
    return true
  }
}
registerProcessor('myr-mic', MyrMic)
`

/**
 * One voice call from this window: the mic (with the browser's echo cancellation, so the call's own voice is not
 * heard as the person talking over it) goes up the call socket; the call's speech comes down as binary frames and is
 * played back to back, and stopped at once when the person talks over it.
 */
export class CallClient {
  private _ws?: WebSocket
  private _ctx?: AudioContext
  private _stream?: MediaStream
  private _node?: AudioWorkletNode
  private _playing: AudioBufferSourceNode[] = []
  private _playAt = 0
  private _muted = false
  private _ended = false

  constructor(
    private readonly chatId: string | undefined,
    private readonly on: CallHandlers,
    /** `lead` or a crew member's name to talk to them directly; the call assistant otherwise. */
    private readonly talk?: string,
  ) {}

  async start() {
    this.on.state('connecting')
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    const ctx = new AudioContext()
    this._ctx = ctx
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    await ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    const node = new AudioWorkletNode(ctx, 'myr-mic')
    this._node = node
    ctx.createMediaStreamSource(this._stream).connect(node)
    const ws = callSocket(this.chatId, CALL_RATE, this.talk)
    this._ws = ws
    node.port.onmessage = (e: MessageEvent<{ frame: Int16Array<ArrayBuffer>; level: number }>) => {
      this.on.level(this._muted ? 0 : e.data.level)
      if (!this._muted && ws.readyState === WebSocket.OPEN) ws.send(e.data.frame)
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return this._play(e.data as ArrayBuffer)
      const msg = JSON.parse(e.data) as {
        type: string
        state?: CallState
        text?: string
        chatId?: string
        request?: string
        message?: string
        reason?: string
      }
      if (msg.type === 'state' && msg.state) this.on.state(msg.state)
      else if (msg.type === 'heard' && msg.text) this.on.line('person', msg.text)
      else if (msg.type === 'said' && msg.text) this.on.line('voice', msg.text)
      else if (msg.type === 'stop-audio') this._stopPlayback()
      else if (msg.type === 'chat' && msg.chatId) this.on.chat(msg.chatId)
      else if (msg.type === 'task' && msg.request) this.on.task(msg.request)
      else if (msg.type === 'error' && msg.message) this.on.error(msg.message)
      else if (msg.type === 'ended') this._end(msg.reason ?? 'hung-up')
    }
    ws.onclose = (e) => {
      if (!this._ended) {
        if (e.code !== 1000 && e.reason) this.on.error(e.reason)
        this._end(e.code === 1000 ? 'hung-up' : 'error')
      }
    }
  }

  mute(muted: boolean) {
    this._muted = muted
    if (this._ws?.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify({ type: 'mute', muted }))
  }

  hangUp() {
    if (this._ws?.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify({ type: 'hangup' }))
    this._end('hung-up')
  }

  /** A frame of the call's speech: its sample rate (4 bytes), then 16-bit mono samples. */
  private _play(data: ArrayBuffer) {
    const ctx = this._ctx
    if (!ctx || data.byteLength < 6) return
    const rate = new DataView(data).getUint32(0, true)
    const pcm = new Int16Array(data, 4, (data.byteLength - 4) >> 1)
    const buffer = ctx.createBuffer(1, pcm.length, rate)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] ?? 0) / 32768
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    this._playAt = Math.max(this._playAt, ctx.currentTime + 0.02)
    source.start(this._playAt)
    this._playAt += buffer.duration
    this._playing.push(source)
    source.onended = () => {
      this._playing = this._playing.filter((s) => s !== source)
    }
  }

  private _stopPlayback() {
    for (const s of this._playing) s.stop()
    this._playing = []
    this._playAt = 0
  }

  private _end(reason: string) {
    if (this._ended) return
    this._ended = true
    this._stopPlayback()
    this._node?.disconnect()
    for (const t of this._stream?.getTracks() ?? []) t.stop()
    void this._ctx?.close()
    if (this._ws && this._ws.readyState <= WebSocket.OPEN) this._ws.close(1000)
    this.on.state('ended')
    this.on.ended(reason)
  }
}
