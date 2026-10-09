import { VOICE_LANGUAGE } from '../../config.ts'
import { wav } from '../audio.ts'
import type { LiveTranscription } from '../phonon-stream.ts'
import type { ListenOptions, SpeechToText, TranscribeOptions } from '../stt.ts'
import { bytesOf, failure, HttpPcmTts, json, timed, type WsProtocol, WsTranscription } from './common.ts'

/**
 * Deepgram (after Pipecat's DeepgramSTTService and DeepgramTTSService): Nova speech to text over its live WebSocket,
 * asked to finalize when the turn ends, or over a plain upload; Aura voices over HTTP, streamed as raw PCM.
 * https://developers.deepgram.com/reference/speech-to-text/listen-streaming, /docs/finalize, /reference/text-to-speech/speak-request
 */
export interface DeepgramOptions {
  readonly key: string
  readonly model: string
  readonly language?: string
  readonly log?: (line: string) => void
  /** Tests point it at a stand-in: `https://api.deepgram.com` and `wss://api.deepgram.com` by default. */
  readonly api?: string
  readonly ws?: string
}

const API = 'https://api.deepgram.com'
const WS = 'wss://api.deepgram.com'

function listenQuery(
  o: DeepgramOptions,
  sampleRate: number,
  hotwords: readonly string[] = [],
): URLSearchParams {
  const q = new URLSearchParams({
    model: o.model,
    language: o.language ?? VOICE_LANGUAGE,
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1',
    punctuate: 'true',
    smart_format: 'true',
  })
  // Key terms are Nova-3's (the older models took `keywords`, which Nova-3 refuses).
  if (o.model.startsWith('nova-3')) for (const w of hotwords) q.append('keyterm', w)
  return q
}

export function deepgramProtocol(
  o: DeepgramOptions,
  sampleRate: number,
  hotwords?: readonly string[],
): WsProtocol {
  const q = listenQuery(o, sampleRate, hotwords)
  // Interim results for the words so far; the turn's end is ours (the call's turn model), so no endpointing.
  q.set('interim_results', 'true')
  q.set('endpointing', 'false')
  return {
    what: 'Deepgram',
    url: () => `${o.ws ?? WS}/v1/listen?${q}`,
    headers: { authorization: `Token ${o.key}` },
    audio: (pcm) => bytesOf(pcm),
    finalize: () => [JSON.stringify({ type: 'Finalize' })],
    end: () => [JSON.stringify({ type: 'CloseStream' })],
    keepAlive: () => JSON.stringify({ type: 'KeepAlive' }),
    read(message) {
      const m = json(message)
      if (!m) return {}
      if (m.type === 'Error') return { error: String(m.description ?? m.message ?? 'error') }
      if (m.type !== 'Results') return {}
      const channel = m.channel as { alternatives?: { transcript?: string }[] } | undefined
      const text = channel?.alternatives?.[0]?.transcript ?? ''
      // A finalize's answer is marked; Deepgram may send none when it had nothing left, so finish also times out.
      const done = m.from_finalize === true
      return m.is_final === true ? { final: text, done } : { partial: text, done }
    },
  }
}

export class DeepgramStt implements SpeechToText {
  constructor(private readonly o: DeepgramOptions) {}

  listen(sampleRate: number, heard: (text: string) => void, options: ListenOptions = {}): LiveTranscription {
    return new WsTranscription(
      deepgramProtocol(this.o, sampleRate, options.hotwords),
      sampleRate,
      heard,
      options.log ?? this.o.log,
    )
  }

  async transcribe(pcm: Int16Array, sampleRate: number, options: TranscribeOptions = {}): Promise<string> {
    return this._post(
      wav(pcm, sampleRate),
      'audio/wav',
      listenQuery(this.o, sampleRate, options.hotwords),
      options.signal,
    )
  }

  transcribeFile(audio: Uint8Array, mimeType: string): Promise<string> {
    const q = listenQuery(this.o, 16_000)
    q.delete('encoding')
    q.delete('sample_rate')
    q.delete('channels')
    return this._post(audio, mimeType, q)
  }

  private async _post(audio: Uint8Array, type: string, q: URLSearchParams, signal?: AbortSignal) {
    const res = await fetch(`${this.o.api ?? API}/v1/listen?${q}`, {
      method: 'POST',
      headers: { authorization: `Token ${this.o.key}`, 'content-type': type },
      body: audio as Uint8Array<ArrayBuffer>,
      signal: timed(signal),
    })
    if (!res.ok) throw await failure('Deepgram transcription', res)
    const body = (await res.json()) as {
      results?: { channels?: { alternatives?: { transcript?: string }[] }[] }
    }
    return (body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim()
  }
}

/** Aura: the model id names the voice (`aura-2-thalia-en`), so the voice is the model sent. */
export function deepgramTts(o: { key: string; voice: string; speed?: number; api?: string }): HttpPcmTts {
  const rate = 24_000
  return new HttpPcmTts('Deepgram speech', rate, (text, signal) => {
    const q = new URLSearchParams({
      model: o.voice,
      encoding: 'linear16',
      container: 'none',
      sample_rate: String(rate),
    })
    // Aura takes 0.7 to 1.5; 1 is left out, as not every voice takes the parameter.
    if (o.speed && o.speed !== 1) q.set('speed', String(Math.min(1.5, Math.max(0.7, o.speed))))
    return fetch(`${o.api ?? API}/v1/speak?${q}`, {
      method: 'POST',
      headers: { authorization: `Token ${o.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    })
  })
}

export const DEEPGRAM_STT_MODELS = [
  { id: 'nova-3', label: 'Nova-3' },
  { id: 'nova-2', label: 'Nova-2' },
] as const

/** Aura-2's English voices (Deepgram has no voice list API). */
export const DEEPGRAM_VOICES = [
  { id: 'aura-2-thalia-en', label: 'Thalia' },
  { id: 'aura-2-andromeda-en', label: 'Andromeda' },
  { id: 'aura-2-helena-en', label: 'Helena' },
  { id: 'aura-2-asteria-en', label: 'Asteria' },
  { id: 'aura-2-luna-en', label: 'Luna' },
  { id: 'aura-2-apollo-en', label: 'Apollo' },
  { id: 'aura-2-orion-en', label: 'Orion' },
  { id: 'aura-2-zeus-en', label: 'Zeus' },
] as const
