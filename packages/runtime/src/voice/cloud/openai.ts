import { GROQ_TTS_MAX_CHARS } from '../../config.ts'
import { OpenAiCompatibleStt } from '../stt.ts'
import type { Speech, TextToSpeech } from '../tts.ts'
import { collect, HttpPcmTts, HttpWavTts } from './common.ts'

/**
 * OpenAI's audio API (after Pipecat's OpenAISTTService and OpenAITTSService): a turn uploaded to
 * `/audio/transcriptions`, and speech from `/audio/speech` as raw 24 kHz PCM, read as it streams in. Groq's Whisper
 * is the same transcription API at another address, and its speech the same request answered with a WAV file.
 * https://developers.openai.com/api/docs/guides/speech-to-text, /guides/text-to-speech,
 * https://console.groq.com/docs/text-to-speech/orpheus
 */
export const OPENAI_API = 'https://api.openai.com/v1'
export const GROQ_API = 'https://api.groq.com/openai/v1'

export function openAiStt(o: {
  key: string
  model: string
  api?: string
  language?: string
}): OpenAiCompatibleStt {
  return new OpenAiCompatibleStt({
    baseUrl: o.api ?? OPENAI_API,
    model: o.model,
    apiKey: o.key,
    language: o.language ?? 'en',
  })
}

export function groqStt(o: {
  key: string
  model: string
  api?: string
  language?: string
}): OpenAiCompatibleStt {
  return new OpenAiCompatibleStt({
    baseUrl: o.api ?? GROQ_API,
    model: o.model,
    apiKey: o.key,
    language: o.language ?? 'en',
  })
}

/** Raw PCM from `/audio/speech` is 24 kHz 16-bit mono, with no header. */
export function openAiTts(o: {
  key: string
  model: string
  voice: string
  speed?: number
  api?: string
}): HttpPcmTts {
  return new HttpPcmTts('OpenAI speech', 24_000, (text, signal) =>
    fetch(`${(o.api ?? OPENAI_API).replace(/\/+$/, '')}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: o.model,
        input: text,
        voice: o.voice,
        response_format: 'pcm',
        ...(o.speed && o.speed !== 1 ? { speed: o.speed } : {}),
      }),
      signal,
    }),
  )
}

/**
 * Groq's speech (Canopy Labs' Orpheus) answers with a whole WAV file and takes at most GROQ_TTS_MAX_CHARS characters,
 * so a longer sentence is made in parts, each played once it is ready. It has no speed setting.
 */
export class GroqTts implements TextToSpeech {
  private readonly _part: HttpWavTts

  constructor(o: { key: string; model: string; voice: string; api?: string }) {
    this._part = new HttpWavTts('Groq speech', (text, signal) =>
      fetch(`${(o.api ?? GROQ_API).replace(/\/+$/, '')}/audio/speech`, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: o.model, input: text, voice: o.voice, response_format: 'wav' }),
        signal,
      }),
    )
  }

  async *stream(text: string, signal?: AbortSignal): AsyncGenerator<Speech> {
    for (const part of speechParts(text, GROQ_TTS_MAX_CHARS)) yield await this._part.speak(part, signal)
  }

  speak(text: string, signal?: AbortSignal): Promise<Speech> {
    return collect(this.stream(text, signal), 24_000)
  }
}

/** `text` in parts of at most `max` characters, ending after a clause's punctuation where one fits, else at a space. */
export function speechParts(text: string, max: number): string[] {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max + 1)
    const clause = Math.max(...[...window.matchAll(/[.!?;:,](?=\s)/g)].map((m) => m.index + 1), 0)
    const space = window.lastIndexOf(' ')
    const at = clause || (space > 0 ? space : max)
    parts.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

export const OPENAI_STT_MODELS = [
  { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe' },
  { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
  { id: 'whisper-1', label: 'Whisper' },
] as const
export const OPENAI_TTS_MODELS = [
  { id: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS' },
  { id: 'tts-1', label: 'TTS-1' },
] as const
/** tts-1 lacks the last four. */
export const OPENAI_VOICES = [
  { id: 'marin', label: 'Marin' },
  { id: 'cedar', label: 'Cedar' },
  { id: 'alloy', label: 'Alloy' },
  { id: 'ash', label: 'Ash' },
  { id: 'coral', label: 'Coral' },
  { id: 'echo', label: 'Echo' },
  { id: 'fable', label: 'Fable' },
  { id: 'nova', label: 'Nova' },
  { id: 'onyx', label: 'Onyx' },
  { id: 'sage', label: 'Sage' },
  { id: 'shimmer', label: 'Shimmer' },
  { id: 'ballad', label: 'Ballad' },
  { id: 'verse', label: 'Verse' },
] as const
export const GROQ_STT_MODELS = [
  { id: 'whisper-large-v3-turbo', label: 'Whisper large v3 turbo' },
  { id: 'whisper-large-v3', label: 'Whisper large v3' },
] as const
export const GROQ_TTS_MODELS = [
  { id: 'canopylabs/orpheus-v1-english', label: 'Orpheus English' },
  { id: 'canopylabs/orpheus-arabic-saudi', label: 'Orpheus Arabic (Saudi)' },
] as const
/** The English model's six, then the Arabic model's six. */
export const GROQ_VOICES = [
  { id: 'autumn', label: 'Autumn' },
  { id: 'diana', label: 'Diana' },
  { id: 'hannah', label: 'Hannah' },
  { id: 'austin', label: 'Austin' },
  { id: 'daniel', label: 'Daniel' },
  { id: 'troy', label: 'Troy' },
  { id: 'abdullah', label: 'Abdullah' },
  { id: 'fahad', label: 'Fahad' },
  { id: 'sultan', label: 'Sultan' },
  { id: 'lulwa', label: 'Lulwa' },
  { id: 'noura', label: 'Noura' },
  { id: 'aisha', label: 'Aisha' },
] as const
