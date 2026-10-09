import { VOICE_LANGUAGE } from '../../config.ts'
import type { SpeechToText, TranscribeOptions } from '../stt.ts'
import { base64, failure, HttpWavTts, timed } from './common.ts'

/**
 * Google Cloud Speech-to-Text and Text-to-Speech over REST with an API key (`x-goog-api-key`): v1 `speech:recognize`
 * for a whole turn (streaming is gRPC only), and `text:synthesize` as LINEAR16, which comes as a WAV file in base64.
 * https://docs.cloud.google.com/speech-to-text/docs/reference/rest/v1/speech/recognize,
 * https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize
 */
const STT = 'https://speech.googleapis.com'
const TTS = 'https://texttospeech.googleapis.com'

export class GoogleStt implements SpeechToText {
  constructor(private readonly o: { key: string; model: string; language?: string; api?: string }) {}

  async transcribe(pcm: Int16Array, sampleRate: number, options: TranscribeOptions = {}): Promise<string> {
    const res = await fetch(`${this.o.api ?? STT}/v1/speech:recognize`, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.o.key, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: sampleRate,
          languageCode: this.o.language ?? VOICE_LANGUAGE,
          model: this.o.model,
          enableAutomaticPunctuation: true,
          ...(options.hotwords?.length ? { speechContexts: [{ phrases: options.hotwords }] } : {}),
        },
        audio: { content: base64(pcm) },
      }),
      signal: timed(options.signal),
    })
    if (!res.ok) throw await failure('Google transcription', res)
    const body = (await res.json()) as { results?: { alternatives?: { transcript?: string }[] }[] }
    // No speech: no results at all.
    return (body.results ?? [])
      .map((r) => r.alternatives?.[0]?.transcript?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
  }
}

export function googleTts(o: {
  key: string
  voice: string
  speed?: number
  language?: string
  api?: string
}): HttpWavTts {
  // The voice's name starts with its locale (`en-US-Chirp3-HD-Charon`).
  const languageCode = /^[a-z]{2,3}-[A-Z]{2}/.exec(o.voice)?.[0] ?? o.language ?? VOICE_LANGUAGE
  return new HttpWavTts(
    'Google speech',
    (text, signal) =>
      fetch(`${o.api ?? TTS}/v1/text:synthesize`, {
        method: 'POST',
        headers: { 'x-goog-api-key': o.key, 'content-type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode, name: o.voice },
          audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24_000, speakingRate: o.speed ?? 1 },
        }),
        signal,
      }),
    async (res) => {
      const body = (await res.json()) as { audioContent?: string }
      return new Uint8Array(Buffer.from(body.audioContent ?? '', 'base64'))
    },
  )
}

export async function googleVoices(o: {
  key: string
  api?: string
}): Promise<{ id: string; label: string }[]> {
  const res = await fetch(`${o.api ?? TTS}/v1/voices?languageCode=${VOICE_LANGUAGE}`, {
    headers: { 'x-goog-api-key': o.key },
    signal: timed(),
  })
  if (!res.ok) throw await failure('Google voices', res)
  const body = (await res.json()) as { voices?: { name?: string }[] }
  return (body.voices ?? [])
    .flatMap((v) => (v.name ? [v.name] : []))
    .sort((a, b) => Number(b.includes('Chirp3-HD')) - Number(a.includes('Chirp3-HD')) || a.localeCompare(b))
    .map((name) => ({ id: name, label: name.replace(/^[a-z]{2,3}-[A-Z]{2}-/, '') }))
}

/** v1's models (Chirp is v2's, which wants a project and a location). */
export const GOOGLE_STT_MODELS = [
  { id: 'latest_short', label: 'Latest short' },
  { id: 'latest_long', label: 'Latest long' },
  { id: 'phone_call', label: 'Phone call' },
] as const
export const GOOGLE_VOICES = [
  { id: 'en-US-Chirp3-HD-Charon', label: 'Chirp3-HD-Charon' },
  { id: 'en-US-Chirp3-HD-Kore', label: 'Chirp3-HD-Kore' },
  { id: 'en-US-Chirp3-HD-Puck', label: 'Chirp3-HD-Puck' },
  { id: 'en-US-Chirp3-HD-Aoede', label: 'Chirp3-HD-Aoede' },
  { id: 'en-US-Neural2-F', label: 'Neural2-F' },
] as const
