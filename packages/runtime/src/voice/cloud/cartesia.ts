import type { LiveTranscription } from '../phonon-stream.ts'
import type { ListenOptions, SpeechToText, TranscribeOptions } from '../stt.ts'
import { bytesOf, failure, HttpPcmTts, json, timed, type WsProtocol, WsTranscription } from './common.ts'

/**
 * Cartesia (after Pipecat's CartesiaSTTService and CartesiaHttpTTSService): Ink speech to text over its WebSocket
 * (raw PCM, a `finalize` word when the turn ends, `flush_done` once it is all said), or as an upload; Sonic voices
 * over `/tts/bytes` as raw PCM, streamed. https://docs.cartesia.ai/api-reference/stt/stt, /stt/transcribe,
 * /tts/bytes, /voices/list
 */
const API = 'https://api.cartesia.ai'
const WS = 'wss://api.cartesia.ai'
/** The API version Myrmidon speaks (Cartesia-Version); later ones may change the shapes below. */
export const CARTESIA_VERSION = '2026-08-14'

export interface CartesiaSttOptions {
  readonly key: string
  readonly model: string
  readonly language?: string
  readonly log?: (line: string) => void
  readonly api?: string
  readonly ws?: string
}

export function cartesiaProtocol(o: CartesiaSttOptions, sampleRate: number): WsProtocol {
  const q = new URLSearchParams({
    model: o.model,
    encoding: 'pcm_s16le',
    sample_rate: String(sampleRate),
    language: o.language ?? 'en',
    cartesia_version: CARTESIA_VERSION,
  })
  return {
    what: 'Cartesia',
    url: () => `${o.ws ?? WS}/stt/websocket?${q}`,
    headers: { 'x-api-key': o.key, 'cartesia-version': CARTESIA_VERSION },
    audio: (pcm) => bytesOf(pcm),
    concat: true,
    // Plain words, not JSON.
    finalize: () => ['finalize'],
    end: () => ['close'],
    read(message) {
      const m = json(message)
      if (!m) return {}
      if (m.type === 'error') return { error: String(m.message ?? m.title ?? 'error') }
      if (m.type === 'flush_done') return { done: true }
      if (m.type !== 'transcript') return {}
      // Each final piece is what came since the last one, spaces and all: the phrase is their concatenation.
      if (m.is_final === true) return { final: String(m.text ?? '') }
      return { partial: String(m.text ?? '') }
    },
  }
}

export class CartesiaStt implements SpeechToText {
  constructor(private readonly o: CartesiaSttOptions) {}

  listen(sampleRate: number, heard: (text: string) => void, options: ListenOptions = {}): LiveTranscription {
    return new WsTranscription(
      cartesiaProtocol(this.o, sampleRate),
      sampleRate,
      heard,
      options.log ?? this.o.log,
    )
  }

  /** The batch endpoint reads raw PCM when told its encoding and rate (it takes `ink-whisper` only). */
  async transcribe(pcm: Int16Array, sampleRate: number, options: TranscribeOptions = {}): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([bytesOf(pcm) as Uint8Array<ArrayBuffer>]), 'turn.pcm')
    return this._post(form, `?encoding=pcm_s16le&sample_rate=${sampleRate}`, options.signal)
  }

  transcribeFile(audio: Uint8Array, mimeType: string, name: string): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([audio as Uint8Array<ArrayBuffer>], { type: mimeType }), name)
    return this._post(form, '')
  }

  private async _post(form: FormData, query: string, signal?: AbortSignal): Promise<string> {
    form.append('model', 'ink-whisper')
    form.append('language', this.o.language ?? 'en')
    const res = await fetch(`${this.o.api ?? API}/stt${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.o.key}`, 'cartesia-version': CARTESIA_VERSION },
      body: form,
      signal: timed(signal),
    })
    if (!res.ok) throw await failure('Cartesia transcription', res)
    const body = (await res.json()) as { text?: unknown }
    return typeof body.text === 'string' ? body.text.trim() : ''
  }
}

export function cartesiaTts(o: {
  key: string
  model: string
  voice: string
  speed?: number
  language?: string
  api?: string
}): HttpPcmTts {
  const rate = 24_000
  return new HttpPcmTts('Cartesia speech', rate, (text, signal) =>
    fetch(`${o.api ?? API}/tts/bytes`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${o.key}`,
        'cartesia-version': CARTESIA_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model_id: o.model,
        transcript: text,
        voice: { id: o.voice },
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: rate },
        language: o.language ?? 'en',
        // Sonic 3 takes 0.6 to 1.5.
        ...(o.speed && o.speed !== 1
          ? { generation_config: { speed: Math.min(1.5, Math.max(0.6, o.speed)) } }
          : {}),
      }),
      signal,
    }),
  )
}

export async function cartesiaVoices(o: {
  key: string
  api?: string
}): Promise<{ id: string; label: string }[]> {
  const res = await fetch(`${o.api ?? API}/voices?limit=100&language=en`, {
    headers: { authorization: `Bearer ${o.key}`, 'cartesia-version': CARTESIA_VERSION },
    signal: timed(),
  })
  if (!res.ok) throw await failure('Cartesia voices', res)
  const body = (await res.json()) as { data?: { id?: string; name?: string }[] }
  return (body.data ?? []).flatMap((v) => (v.id ? [{ id: v.id, label: v.name || v.id }] : []))
}

export const CARTESIA_STT_MODELS = [{ id: 'ink-whisper', label: 'Ink Whisper' }] as const
/** Sonic 2 and Turbo stop working on 2026-10-20 (Cartesia's changelog), so they are not offered. */
export const CARTESIA_TTS_MODELS = [
  { id: 'sonic-3.6', label: 'Sonic 3.6' },
  { id: 'sonic-3', label: 'Sonic 3' },
] as const
export const CARTESIA_VOICES = [{ id: 'f786b574-daa5-4673-aa0c-cbe3e8534c02', label: 'Katie' }] as const
