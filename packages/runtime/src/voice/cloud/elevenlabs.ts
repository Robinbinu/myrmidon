import { wav } from '../audio.ts'
import type { LiveTranscription } from '../phonon-stream.ts'
import type { ListenOptions, SpeechToText, TranscribeOptions } from '../stt.ts'
import {
  base64,
  bytesOf,
  failure,
  HttpPcmTts,
  json,
  timed,
  type WsProtocol,
  WsTranscription,
} from './common.ts'

/**
 * ElevenLabs (after Pipecat's ElevenLabsRealtimeSTTService and ElevenLabsHttpTTSService): Scribe v2 Realtime over its
 * WebSocket (base64 audio in JSON, committed by hand when the turn ends), Scribe v2 as an upload, and its voices over
 * the streaming HTTP endpoint as raw PCM. https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime,
 * /speech-to-text/convert, /text-to-speech/stream, /voices/search
 */
const API = 'https://api.elevenlabs.io'
const WS = 'wss://api.elevenlabs.io'

export interface ElevenLabsSttOptions {
  readonly key: string
  /** The batch model (`scribe_v2`); the live stream uses its realtime twin. */
  readonly model: string
  /** ISO-639-1 (`en`): a region tag (`en-US`) is refused. */
  readonly language?: string
  readonly log?: (line: string) => void
  readonly api?: string
  readonly ws?: string
}

export function elevenLabsProtocol(o: ElevenLabsSttOptions, sampleRate: number): WsProtocol {
  const q = new URLSearchParams({
    model_id: 'scribe_v2_realtime',
    audio_format: `pcm_${sampleRate}`,
    commit_strategy: 'manual',
    language_code: o.language ?? 'en',
  })
  return {
    what: 'ElevenLabs',
    url: () => `${o.ws ?? WS}/v1/speech-to-text/realtime?${q}`,
    headers: { 'xi-api-key': o.key },
    audio: (pcm) =>
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: base64(pcm),
        commit: false,
        sample_rate: sampleRate,
      }),
    finalize: () => [
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: '',
        commit: true,
        sample_rate: sampleRate,
      }),
    ],
    read(message) {
      const m = json(message)
      if (!m) return {}
      const type = String(m.message_type ?? '')
      if (type === 'partial_transcript') return { partial: String(m.text ?? '') }
      // The commit's answer is its committed transcript (empty when nothing was said).
      if (type === 'committed_transcript') return { final: String(m.text ?? ''), done: true }
      if (type === 'session_started' || type.startsWith('committed_transcript_')) return {}
      if ('error' in m || type.endsWith('error') || type.endsWith('exceeded') || type.endsWith('limited'))
        return { error: `${type}: ${String(m.error ?? '')}` }
      return {}
    },
  }
}

export class ElevenLabsStt implements SpeechToText {
  constructor(private readonly o: ElevenLabsSttOptions) {}

  listen(sampleRate: number, heard: (text: string) => void, options: ListenOptions = {}): LiveTranscription {
    return new WsTranscription(
      elevenLabsProtocol(this.o, sampleRate),
      sampleRate,
      heard,
      options.log ?? this.o.log,
    )
  }

  /** Scribe reads 16 kHz raw PCM as it is (`pcm_s16le_16`), quicker than a file it has to decode. */
  async transcribe(pcm: Int16Array, sampleRate: number, options: TranscribeOptions = {}): Promise<string> {
    const form = new FormData()
    if (sampleRate === 16_000) {
      form.append('file', new Blob([bytesOf(pcm) as Uint8Array<ArrayBuffer>]), 'turn.pcm')
      form.append('file_format', 'pcm_s16le_16')
    } else {
      form.append('file', new Blob([wav(pcm, sampleRate)], { type: 'audio/wav' }), 'turn.wav')
    }
    return this._post(form, options.signal)
  }

  transcribeFile(audio: Uint8Array, mimeType: string, name: string): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([audio as Uint8Array<ArrayBuffer>], { type: mimeType }), name)
    return this._post(form)
  }

  private async _post(form: FormData, signal?: AbortSignal): Promise<string> {
    form.append('model_id', this.o.model)
    form.append('language_code', this.o.language ?? 'en')
    form.append('tag_audio_events', 'false')
    const res = await fetch(`${this.o.api ?? API}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': this.o.key },
      body: form,
      signal: timed(signal),
    })
    if (!res.ok) throw await failure('ElevenLabs transcription', res)
    const body = (await res.json()) as { text?: unknown }
    return typeof body.text === 'string' ? body.text.trim() : ''
  }
}

export function elevenLabsTts(o: {
  key: string
  model: string
  voice: string
  speed?: number
  api?: string
}): HttpPcmTts {
  const rate = 24_000
  return new HttpPcmTts('ElevenLabs speech', rate, (text, signal) =>
    fetch(
      `${o.api ?? API}/v1/text-to-speech/${encodeURIComponent(o.voice)}/stream?output_format=pcm_${rate}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': o.key, 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: o.model,
          // ElevenLabs takes 0.7 to 1.2.
          ...(o.speed && o.speed !== 1
            ? { voice_settings: { speed: Math.min(1.2, Math.max(0.7, o.speed)) } }
            : {}),
        }),
        signal,
      },
    ),
  )
}

/** The voices on the person's ElevenLabs account (its premade ones and their own). */
export async function elevenLabsVoices(o: {
  key: string
  api?: string
}): Promise<{ id: string; label: string }[]> {
  const res = await fetch(`${o.api ?? API}/v2/voices?page_size=100`, {
    headers: { 'xi-api-key': o.key },
    signal: timed(),
  })
  if (!res.ok) throw await failure('ElevenLabs voices', res)
  const body = (await res.json()) as { voices?: { voice_id?: string; name?: string }[] }
  return (body.voices ?? []).flatMap((v) =>
    v.voice_id ? [{ id: v.voice_id, label: v.name || v.voice_id }] : [],
  )
}

export const ELEVENLABS_STT_MODELS = [{ id: 'scribe_v2', label: 'Scribe v2' }] as const
export const ELEVENLABS_TTS_MODELS = [
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5' },
  { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5' },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2' },
] as const
/** Premade voices every account has, until the account's own list is fetched. */
export const ELEVENLABS_VOICES = [
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', label: 'George' },
] as const
