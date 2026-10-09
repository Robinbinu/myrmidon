import { VOICE_REALTIME_CONNECT_MS } from '../../config.ts'
import { base64, json, openSocket } from '../cloud/common.ts'
import {
  geminiSchema,
  pcmFrom,
  type RealtimeConnection,
  type RealtimeEvent,
  type RealtimeSetup,
} from './connection.ts'

/**
 * Gemini Live (after Pipecat's GeminiLiveLLMService): one BidiGenerateContent WebSocket per call, 16 kHz PCM in and
 * 24 kHz out, Gemini's own activity detection finding turns, both sides transcribed, and tool calls answered with
 * `toolResponse`. Its tools are declared BLOCKING (the default on 3.8 is not), so the model waits for their results.
 * It reports no start of speech: a turn of the person's starts with the first words heard after the model's turn, and
 * ends when the model starts answering. A function call it did not make cannot be put in its history (the socket
 * closes), so notices go in as a user turn whose wording is Myrmidon's own (see prompts.voice.realtime).
 * https://ai.google.dev/api/live, https://ai.google.dev/gemini-api/docs/live-api/tools
 */
const WS =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

export class GeminiLive implements RealtimeConnection {
  readonly inputRate = 16_000
  private _ws?: WebSocket
  private _on: (event: RealtimeEvent) => void = () => {}
  private _turns = 0
  /** The person's turn being heard, and its words so far. */
  private _turn?: { id: string; text: string }
  /** The model is answering (between its first output and generationComplete). */
  private _answering = false
  private _said = ''
  private _closed = false

  constructor(
    private readonly o: {
      readonly key: string
      readonly model: string
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
      // The key in a header, not the address (which logs keep).
      const ws = openSocket(this.o.url ?? WS, { 'x-goog-api-key': this.o.key })
      ws.binaryType = 'arraybuffer'
      this._ws = ws
      ws.onopen = () =>
        this._send({
          setup: {
            model: this.o.model.startsWith('models/') ? this.o.model : `models/${this.o.model}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: setup.voice } } },
            },
            systemInstruction: { parts: [{ text: setup.instructions }] },
            tools: [
              {
                functionDeclarations: setup.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  behavior: 'BLOCKING',
                  // Gemini refuses an object with no properties declared as parameters: those take none.
                  ...(Object.keys((t.parameters.properties as object | undefined) ?? {}).length
                    ? { parameters: geminiSchema(t.parameters) }
                    : {}),
                })),
              },
            ],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        })
      ws.onmessage = (e) => {
        const m = json(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer))
        if (!m) return
        if ('setupComplete' in m && !ready) {
          ready = true
          clearTimeout(timer)
          resolve()
          this._on({ type: 'ready' })
          return
        }
        this._message(m)
      }
      ws.onerror = () => fail('the connection to Gemini failed')
      ws.onclose = (e) => {
        clearTimeout(timer)
        if (!ready) return fail(`Gemini closed the connection (${e.code} ${e.reason})`)
        if (!this._closed) this._on({ type: 'closed', reason: e.reason || String(e.code) })
        this._closed = true
      }
    })
  }

  /** Content first, then the end of the turn, then tool calls: Gemini bundles them in one message. */
  private _message(m: Record<string, unknown>) {
    const content = m.serverContent as
      | {
          modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] }
          inputTranscription?: { text?: string }
          outputTranscription?: { text?: string }
          interrupted?: boolean
          generationComplete?: boolean
          turnComplete?: boolean
        }
      | undefined
    if (content) {
      const heard = content.inputTranscription?.text
      // Words of the person's while the model answers, but for a cut-off, are the tail of the turn it is answering.
      if (heard && (!this._answering || content.interrupted)) {
        if (!this._turn) {
          this._turn = { id: String(++this._turns), text: '' }
          this._on({ type: 'speech-started', turn: this._turn.id })
        }
        this._turn.text += heard
        this._on({ type: 'heard', turn: this._turn.id, text: this._turn.text.trim(), final: false })
      }
      if (content.interrupted) {
        this._answering = false
        this._said = ''
        this._on({ type: 'interrupted' })
      }
      for (const part of content.modelTurn?.parts ?? []) {
        const data = part.inlineData?.data
        if (!data) continue
        this._answer()
        this._on({ type: 'audio', pcm: pcmFrom(data), sampleRate: 24_000 })
      }
      if (content.outputTranscription?.text) {
        this._answer()
        this._said += content.outputTranscription.text
      }
      if (content.generationComplete || content.turnComplete) {
        if (this._said.trim()) this._on({ type: 'said', text: this._said.trim() })
        this._said = ''
        if (this._answering) {
          this._answering = false
          this._on({ type: 'done' })
        }
      }
    }
    const calls = (
      m.toolCall as { functionCalls?: { id?: string; name?: string; args?: unknown }[] } | undefined
    )?.functionCalls
    if (calls?.length) {
      this._answer()
      for (const c of calls)
        this._on({
          type: 'tool',
          id: String(c.id ?? ''),
          name: String(c.name ?? ''),
          args: (c.args && typeof c.args === 'object' ? c.args : {}) as Record<string, unknown>,
        })
    }
    if (m.goAway)
      this.o.log?.('gemini live: the session is about to end (its connection lasts about ten minutes)')
  }

  /** The model's answer has begun: the person's turn is over, heard as it was. */
  private _answer() {
    const turn = this._turn
    if (turn) {
      this._turn = undefined
      this._on({ type: 'heard', turn: turn.id, text: turn.text.trim(), final: true })
    }
    this._answering = true
  }

  audio(pcm: Int16Array) {
    this._send({
      realtimeInput: { audio: { data: base64(pcm), mimeType: `audio/pcm;rate=${this.inputRate}` } },
    })
  }

  toolResult(id: string, name: string, output: string) {
    this._send({ toolResponse: { functionResponses: [{ id, name, response: { result: output } }] } })
  }

  notice(text: string) {
    this._send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } })
  }

  /** Gemini stops its own answer when it hears the person; there is nothing to send. */
  interrupt() {
    this._answering = false
    this._said = ''
  }

  private _send(message: unknown) {
    const ws = this._ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(message))
    } catch (err) {
      this.o.log?.(`gemini live: ${err instanceof Error ? err.message : String(err)}`)
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

export const GEMINI_LIVE_MODELS = [
  { id: 'gemini-3.8-live', label: 'Gemini 3.8 Live' },
  { id: 'gemini-2.5-flash-native-audio-preview-12-2025', label: 'Gemini 2.5 Flash native audio' },
] as const
export const GEMINI_VOICES = [
  'Charon',
  'Puck',
  'Kore',
  'Fenrir',
  'Aoede',
  'Leda',
  'Orus',
  'Zephyr',
  'Achernar',
  'Callirrhoe',
  'Despina',
  'Sulafat',
].map((v) => ({ id: v, label: v }))
