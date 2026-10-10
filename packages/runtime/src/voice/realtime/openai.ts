import { VOICE_REALTIME_CONNECT_MS } from '../../config.ts'
import { base64, json, openSocket } from '../cloud/common.ts'
import { pcmFrom, type RealtimeConnection, type RealtimeEvent, type RealtimeSetup } from './connection.ts'

/**
 * OpenAI Realtime (GA), after Pipecat's OpenAIRealtimeLLMService: one WebSocket per call, 24 kHz PCM both ways, the
 * server's semantic VAD finding turns (and cutting the model off when the person talks over it), the person's words
 * transcribed beside it, and function calls answered with `function_call_output` items and a new `response.create`
 * once every call of the answer has its result. A function call can arrive before the person's transcript: they are
 * matched by item id. https://developers.openai.com/api/docs/guides/realtime-websocket, /realtime-function-calling
 */
const WS = 'wss://api.openai.com/v1/realtime'

export class OpenAiRealtime implements RealtimeConnection {
  readonly inputRate = 24_000
  private _ws?: WebSocket
  private _on: (event: RealtimeEvent) => void = () => {}
  private _responding = false
  /** A response is owed (tool results or a notice went in) once the current one is done. */
  private _owed = false
  /** Function calls of the current answer still waiting for their results. */
  private readonly _pending = new Set<string>()
  private readonly _heard = new Map<string, string>()
  /** The answer's audio item being played, for cutting it where the person talked over it. */
  private _playing?: { item: string; since: number; bytes: number }
  private _closed = false

  constructor(
    private readonly o: {
      readonly key: string
      readonly model: string
      /** The model that writes down what the person says. */
      readonly transcribe?: string
      readonly log?: (line: string) => void
      readonly url?: string
    },
  ) {}

  connect(setup: RealtimeSetup, on: (event: RealtimeEvent) => void): Promise<void> {
    this._on = on
    return new Promise<void>((resolve, reject) => {
      let ready = false
      const timer = setTimeout(() => fail('the realtime model did not answer'), VOICE_REALTIME_CONNECT_MS)
      const fail = (why: string) => {
        clearTimeout(timer)
        if (!ready) {
          ready = true
          reject(new Error(why))
          this.close()
        } else this._on({ type: 'error', message: why })
      }
      const ws = openSocket(`${this.o.url ?? WS}?model=${encodeURIComponent(this.o.model)}`, {
        authorization: `Bearer ${this.o.key}`,
      })
      this._ws = ws
      ws.onopen = () =>
        this._send({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: setup.instructions,
            output_modalities: ['audio'],
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: this.inputRate },
                transcription: { model: this.o.transcribe ?? 'gpt-4o-mini-transcribe' },
                turn_detection: {
                  type: 'semantic_vad',
                  eagerness: 'auto',
                  create_response: true,
                  interrupt_response: true,
                },
              },
              output: {
                format: { type: 'audio/pcm', rate: 24_000 },
                voice: setup.voice,
                ...(setup.speed && setup.speed !== 1 ? { speed: setup.speed } : {}),
              },
            },
            tools: setup.tools.map((t) => ({
              type: 'function',
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
            tool_choice: 'auto',
          },
        })
      ws.onmessage = (e) => {
        const m = json(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer))
        if (!m) return
        if (m.type === 'session.updated' && !ready) {
          ready = true
          clearTimeout(timer)
          resolve()
          this._on({ type: 'ready' })
          return
        }
        if (m.type === 'error') {
          const err = m.error as { message?: string; code?: string } | undefined
          // A cancel with nothing to cancel (the answer had just ended) is not a failure.
          if (err?.code === 'response_cancel_not_active') return
          return fail(err?.message ?? 'error')
        }
        this._message(m)
      }
      ws.onerror = () => fail('the connection to OpenAI failed')
      ws.onclose = (e) => {
        clearTimeout(timer)
        if (!ready) return fail(`OpenAI closed the connection (${e.code} ${e.reason})`)
        if (!this._closed) this._on({ type: 'closed', reason: e.reason || String(e.code) })
        this._closed = true
      }
    })
  }

  private _message(m: Record<string, unknown>) {
    const item = typeof m.item_id === 'string' ? m.item_id : ''
    switch (m.type) {
      case 'input_audio_buffer.speech_started': {
        // The server cuts its own answer off; what was played of it is what the conversation keeps.
        const playing = this._playing
        // 48 bytes are a millisecond of 24 kHz 16-bit audio: an answer still playing is cut where it was.
        if (playing && Date.now() - playing.since < playing.bytes / 48) {
          const audioEndMs = Math.min(Date.now() - playing.since, Math.floor(playing.bytes / 48))
          this._send({
            type: 'conversation.item.truncate',
            item_id: playing.item,
            content_index: 0,
            audio_end_ms: audioEndMs,
          })
          this._on({ type: 'interrupted' })
        }
        this._playing = undefined
        this._on({ type: 'speech-started', turn: item })
        return
      }
      case 'input_audio_buffer.speech_stopped':
        return this._on({ type: 'speech-stopped' })
      case 'conversation.item.input_audio_transcription.delta': {
        const text = (this._heard.get(item) ?? '') + String(m.delta ?? '')
        this._heard.set(item, text)
        return this._on({ type: 'heard', turn: item, text, final: false })
      }
      case 'conversation.item.input_audio_transcription.completed':
        this._heard.delete(item)
        return this._on({ type: 'heard', turn: item, text: String(m.transcript ?? '').trim(), final: true })
      case 'conversation.item.input_audio_transcription.failed':
        this._heard.delete(item)
        return this._on({ type: 'heard', turn: item, text: '', final: true })
      case 'response.created':
        this._responding = true
        return
      case 'response.output_audio.delta': {
        const pcm = pcmFrom(String(m.delta ?? ''))
        if (this._playing?.item !== item) this._playing = { item, since: Date.now(), bytes: 0 }
        this._playing.bytes += pcm.length * 2
        return this._on({ type: 'audio', pcm, sampleRate: 24_000 })
      }
      case 'response.output_audio_transcript.done':
        if (typeof m.transcript === 'string' && m.transcript.trim())
          this._on({ type: 'said', text: m.transcript.trim() })
        return
      case 'response.function_call_arguments.done': {
        const id = String(m.call_id ?? '')
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(String(m.arguments ?? '{}')) as Record<string, unknown>
        } catch {
          // A call whose arguments are not JSON runs with none, and its tool says what is missing.
        }
        this._pending.add(id)
        return this._on({ type: 'tool', id, name: String(m.name ?? ''), args })
      }
      case 'response.done': {
        this._responding = false
        const response = m.response as
          | { status?: string; status_details?: { error?: { message?: string } } }
          | undefined
        if (response?.status === 'failed')
          this._on({ type: 'error', message: response.status_details?.error?.message ?? 'the answer failed' })
        this._on({ type: 'done' })
        this._respond()
        return
      }
    }
  }

  audio(pcm: Int16Array) {
    this._send({ type: 'input_audio_buffer.append', audio: base64(pcm) })
  }

  toolResult(id: string, _name: string, output: string) {
    this._pending.delete(id)
    this._send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: id, output },
    })
    this._owed = true
    this._respond()
  }

  /** A system message, so the model never takes it for the person's words. */
  notice(text: string) {
    this._send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    })
    this._owed = true
    this._respond()
  }

  instructions(text: string) {
    this._send({ type: 'session.update', session: { type: 'realtime', instructions: text } })
  }

  interrupt() {
    if (this._responding) this._send({ type: 'response.cancel' })
    const playing = this._playing
    if (playing)
      this._send({
        type: 'conversation.item.truncate',
        item_id: playing.item,
        content_index: 0,
        audio_end_ms: Math.min(Date.now() - playing.since, Math.floor(playing.bytes / 48)),
      })
    this._playing = undefined
  }

  /** One answer at a time: an answer owed waits for the current one, and for every call of it to have its result. */
  private _respond() {
    if (!this._owed || this._responding || this._pending.size) return
    this._owed = false
    this._responding = true
    this._send({ type: 'response.create' })
  }

  private _send(message: unknown) {
    const ws = this._ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(message))
    } catch (err) {
      this.o.log?.(`openai realtime: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  close() {
    if (this._closed) return
    this._closed = true
    try {
      this._ws?.close(1000)
    } catch {
      // Already closed.
    }
  }
}

export const OPENAI_REALTIME_MODELS = [
  { id: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1' },
  { id: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 mini' },
  { id: 'gpt-realtime', label: 'GPT Realtime' },
  { id: 'gpt-realtime-mini', label: 'GPT Realtime mini' },
] as const
export const OPENAI_REALTIME_VOICES = [
  { id: 'marin', label: 'Marin' },
  { id: 'cedar', label: 'Cedar' },
  { id: 'alloy', label: 'Alloy' },
  { id: 'ash', label: 'Ash' },
  { id: 'ballad', label: 'Ballad' },
  { id: 'coral', label: 'Coral' },
  { id: 'echo', label: 'Echo' },
  { id: 'sage', label: 'Sage' },
  { id: 'shimmer', label: 'Shimmer' },
  { id: 'verse', label: 'Verse' },
] as const
