import { bytesOf, json, StreamingStt, type WsProtocol, WsTranscription } from './common.ts'

/**
 * Speechmatics real-time (its documented `/v2` protocol; Pipecat goes through Speechmatics' SDK): `StartRecognition`,
 * then raw PCM frames, each acknowledged; `EndOfStream` with the count of frames sent when the turn ends, and
 * `EndOfTranscript` once all of it is said. Each `AddTranscript` adds to the words before it.
 * https://docs.speechmatics.com/api-ref/realtime-transcription-websocket
 */
export interface SpeechmaticsOptions {
  readonly key: string
  readonly model: string
  /** `eu`, `us`, `au`, or `global` (the nearest). */
  readonly region?: string
  readonly language?: string
  readonly log?: (line: string) => void
  readonly ws?: string
}

export const SPEECHMATICS_REGIONS = ['global', 'eu', 'us', 'au'] as const

export function speechmaticsProtocol(
  o: SpeechmaticsOptions,
  sampleRate: number,
  hotwords: readonly string[] = [],
): WsProtocol {
  let sent = 0
  return {
    what: 'Speechmatics',
    url: () => o.ws ?? `wss://${o.region ?? 'global'}.rt.speechmatics.com/v2`,
    headers: { authorization: `Bearer ${o.key}` },
    waitReady: true,
    start: () => [
      JSON.stringify({
        message: 'StartRecognition',
        audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: sampleRate },
        transcription_config: {
          language: o.language ?? 'en',
          model: o.model,
          enable_partials: true,
          max_delay: 1,
          ...(hotwords.length ? { additional_vocab: hotwords.map((content) => ({ content })) } : {}),
        },
      }),
    ],
    audio(pcm) {
      sent += 1
      return bytesOf(pcm)
    },
    // Ending the stream is how to ask for the rest; the server says EndOfTranscript once it has sent it.
    end: () => [JSON.stringify({ message: 'EndOfStream', last_seq_no: sent })],
    read(message) {
      const m = json(message)
      if (!m) return {}
      const meta = m.metadata as { transcript?: string } | undefined
      if (m.message === 'RecognitionStarted') return { ready: true }
      if (m.message === 'AddPartialTranscript') return { partial: meta?.transcript ?? '' }
      if (m.message === 'AddTranscript') return { final: meta?.transcript ?? '' }
      if (m.message === 'EndOfTranscript') return { done: true }
      if (m.message === 'Error') return { error: String(m.reason ?? m.type ?? 'error') }
      return {}
    },
  }
}

/** Speechmatics' batch API is a job queue, too slow for a turn: a whole turn goes through a stream of its own. */
export function speechmaticsStt(o: SpeechmaticsOptions): StreamingStt {
  return new StreamingStt(
    (sampleRate, heard, options) =>
      new WsTranscription(
        speechmaticsProtocol(o, sampleRate, options.hotwords),
        sampleRate,
        heard,
        options.log,
      ),
    o.log,
  )
}

export const SPEECHMATICS_MODELS = [
  { id: 'enhanced', label: 'Enhanced' },
  { id: 'standard', label: 'Standard' },
] as const
