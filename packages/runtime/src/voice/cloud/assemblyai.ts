import type { LiveTranscription } from '../phonon-stream.ts'
import type { ListenOptions, SpeechToText, TranscribeOptions } from '../stt.ts'
import { bytesOf, failure, json, timed, type WsProtocol, WsTranscription } from './common.ts'

/**
 * AssemblyAI (after Pipecat's AssemblyAISTTService): Universal-Streaming v3 over its WebSocket (raw PCM in pieces of
 * 50 ms to 1 s, `ForceEndpoint` when the turn ends, the formatted `Turn` once it is), and its Sync API for a whole turn.
 * https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api, /sync-api/transcribe
 */
const WS = 'wss://streaming.assemblyai.com'
const SYNC = 'https://sync.assemblyai.com'

export interface AssemblyAiOptions {
  readonly key: string
  readonly model: string
  readonly log?: (line: string) => void
  readonly ws?: string
  readonly api?: string
}

export function assemblyAiProtocol(
  o: AssemblyAiOptions,
  sampleRate: number,
  hotwords: readonly string[] = [],
): WsProtocol {
  const q = new URLSearchParams({
    sample_rate: String(sampleRate),
    encoding: 'pcm_s16le',
    speech_model: o.model,
    format_turns: 'true',
  })
  if (hotwords.length) q.set('keyterms_prompt', JSON.stringify(hotwords))
  return {
    what: 'AssemblyAI',
    url: () => `${o.ws ?? WS}/v3/ws?${q}`,
    // The key as it is, with no "Bearer".
    headers: { authorization: o.key },
    audio: (pcm) => bytesOf(pcm),
    chunkMs: 50,
    finalize: () => [JSON.stringify({ type: 'ForceEndpoint' })],
    end: () => [JSON.stringify({ type: 'Terminate' })],
    read(message) {
      const m = json(message)
      if (!m) return {}
      if (m.type === 'Termination') return { done: true }
      if ('error' in m) return { error: String(m.error) }
      if (m.type !== 'Turn') return {}
      const text = String(m.transcript ?? '')
      // A turn's transcript is the whole turn so far; it is settled once it ends and has been formatted.
      if (m.end_of_turn === true && m.turn_is_formatted === true) return { final: text, done: true }
      return { partial: text }
    },
  }
}

export class AssemblyAiStt implements SpeechToText {
  constructor(private readonly o: AssemblyAiOptions) {}

  listen(sampleRate: number, heard: (text: string) => void, options: ListenOptions = {}): LiveTranscription {
    return new WsTranscription(
      assemblyAiProtocol(this.o, sampleRate, options.hotwords),
      sampleRate,
      heard,
      options.log ?? this.o.log,
    )
  }

  /** The Sync API: raw PCM with its rate in the config part; its models are the pre-recorded ones. */
  async transcribe(pcm: Int16Array, sampleRate: number, options: TranscribeOptions = {}): Promise<string> {
    const form = new FormData()
    form.append(
      'audio',
      new Blob([bytesOf(pcm) as Uint8Array<ArrayBuffer>], { type: 'audio/pcm' }),
      'turn.pcm',
    )
    form.append(
      'config',
      new Blob(
        [
          JSON.stringify({
            sample_rate: sampleRate,
            channels: 1,
            ...(options.hotwords?.length ? { keyterms_prompt: options.hotwords } : {}),
          }),
        ],
        { type: 'application/json' },
      ),
    )
    const res = await fetch(`${this.o.api ?? SYNC}/v1/transcribe`, {
      method: 'POST',
      headers: { authorization: this.o.key, 'x-aai-model': 'universal-3-5-pro' },
      body: form,
      signal: timed(options.signal),
    })
    if (!res.ok) throw await failure('AssemblyAI transcription', res)
    const body = (await res.json()) as { text?: unknown }
    return typeof body.text === 'string' ? body.text.trim() : ''
  }
}

export const ASSEMBLYAI_MODELS = [
  { id: 'universal-3-6-pro', label: 'Universal-3.6 Pro' },
  { id: 'universal-streaming-english', label: 'Universal-Streaming (English)' },
  { id: 'universal-streaming-multilingual', label: 'Universal-Streaming (multilingual)' },
] as const
