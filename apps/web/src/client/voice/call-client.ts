import { callSocket } from '../api.ts'
import { copy } from '../copy.ts'
import { CALL_FRAME, CALL_RATE } from '../ui-config.ts'

export type CallState =
  | 'connecting'
  | 'preparing'
  | 'listening'
  | 'hearing'
  | 'thinking'
  | 'speaking'
  | 'muted'
  | 'ended'

/** Who the call reached, as the server says once it answers. */
export interface CallHello {
  /** `assistant`, `lead`, or a crew member's name. */
  talk: string
  chatId?: string
  chatTitle?: string
}

export interface CallHandlers {
  state(state: CallState): void
  hello(hello: CallHello): void
  /** A line of the transcript: what the person said, or what the call said (`from` says who spoke). */
  line(who: 'person' | 'voice', text: string, from?: string): void
  /** The mic's level, 0–1, for the meter. */
  level(level: number): void
  /** The call started its first task in a new chat. */
  chat(chatId: string): void
  task(request: string): void
  error(message: string): void
  /** How long the last answer took to start after the person stopped talking. */
  latency(ms: number): void
  /** Something waits for the person's yes or no; `approvalDone` once it is answered. */
  approval(id: string, summary: string): void
  approvalDone(id: string): void
  ended(reason: string): void
}

/**
 * Why a call's socket closed, in words for the person. A refusal (4xxx: not signed in, voice off, already on a call,
 * too many calls, an engine not ready…) carries the server's own reason; an error inside the server (1011) or input it
 * would not take (1009) is said plainly, its technical reason left out. A socket that closed otherwise lost the server,
 * or never reached it (an older server refuses with HTTP, which reaches the page as a bare 1006).
 */
export function closeMessage(code: number, reason: string, opened: boolean): string {
  if (code >= 4000 && code < 5000 && reason) return reason
  if (code === 1009 || code === 1011) return copy.call.failed
  return opened ? copy.call.dropped : copy.call.couldNotStart
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
  private _opened = false

  constructor(
    private readonly chatId: string | undefined,
    private readonly on: CallHandlers,
    /** `lead` or a crew member's name to talk to them directly; the call assistant otherwise. */
    private readonly talk?: string,
  ) {}

  async start() {
    this.on.state('connecting')
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    this._stream = stream
    // Hung up while the browser asked for the mic: nothing may start after that.
    if (this._ended) return this._release()
    this._applyMute()
    const ctx = new AudioContext()
    this._ctx = ctx
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    if (this._ended) return this._release()
    const node = new AudioWorkletNode(ctx, 'myr-mic')
    this._node = node
    ctx.createMediaStreamSource(stream).connect(node)
    const ws = callSocket(this.chatId, CALL_RATE, this.talk)
    this._ws = ws
    node.port.onmessage = (e: MessageEvent<{ frame: Int16Array<ArrayBuffer>; level: number }>) => {
      this.on.level(this._muted ? 0 : e.data.level)
      if (!this._muted && ws.readyState === WebSocket.OPEN) ws.send(e.data.frame)
    }
    ws.onopen = () => {
      this._opened = true
      if (this._muted) ws.send(JSON.stringify({ type: 'mute', muted: true }))
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return this._play(e.data as ArrayBuffer)
      const msg = JSON.parse(e.data) as {
        ms?: number
        type: string
        state?: CallState
        text?: string
        from?: string
        talk?: string
        chatId?: string
        chatTitle?: string
        request?: string
        message?: string
        reason?: string
        id?: string
        summary?: string
      }
      if (msg.type === 'state' && msg.state) this.on.state(msg.state)
      else if (msg.type === 'hello' && msg.talk)
        this.on.hello({
          talk: msg.talk,
          ...(msg.chatId ? { chatId: msg.chatId } : {}),
          ...(msg.chatTitle ? { chatTitle: msg.chatTitle } : {}),
        })
      else if (msg.type === 'heard' && msg.text) this.on.line('person', msg.text)
      else if (msg.type === 'said' && msg.text) this.on.line('voice', msg.text, msg.from)
      else if (msg.type === 'stop-audio') this._stopPlayback()
      else if (msg.type === 'chat' && msg.chatId) this.on.chat(msg.chatId)
      else if (msg.type === 'task' && msg.request) this.on.task(msg.request)
      else if (msg.type === 'error' && msg.message) this.on.error(msg.message)
      else if (msg.type === 'latency' && typeof msg.ms === 'number') this.on.latency(msg.ms)
      else if (msg.type === 'approval' && msg.id && msg.summary) this.on.approval(msg.id, msg.summary)
      else if (msg.type === 'approval-done' && msg.id) this.on.approvalDone(msg.id)
      else if (msg.type === 'ended') this._end(msg.reason ?? 'hung-up')
    }
    ws.onclose = (e) => {
      if (this._ended) return
      if (e.code !== 1000) this.on.error(closeMessage(e.code, e.reason, this._opened))
      this._end(e.code === 1000 ? 'hung-up' : 'error')
    }
  }

  mute(muted: boolean) {
    this._muted = muted
    this._applyMute()
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

  /** A muted call turns the mic's track off too, so the browser shows the mic as not in use. */
  private _applyMute() {
    for (const t of this._stream?.getAudioTracks() ?? []) t.enabled = !this._muted
  }

  /** Lets go of the mic and the audio context; safe to call again. */
  private _release() {
    this._node?.disconnect()
    for (const t of this._stream?.getTracks() ?? []) t.stop()
    if (this._ctx && this._ctx.state !== 'closed') void this._ctx.close()
  }

  private _end(reason: string) {
    if (this._ended) return
    this._ended = true
    this._stopPlayback()
    this._release()
    if (this._ws && this._ws.readyState <= WebSocket.OPEN) this._ws.close(1000)
    this.on.state('ended')
    this.on.ended(reason)
  }
}
