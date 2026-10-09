import { OpenAiCompatibleStt } from '../stt.ts'
import { HttpPcmTts } from './common.ts'

/**
 * OpenAI's audio API (after Pipecat's OpenAISTTService and OpenAITTSService): a turn uploaded to
 * `/audio/transcriptions`, and speech from `/audio/speech` as raw 24 kHz PCM, read as it streams in. Groq's Whisper
 * is the same transcription API at another address. https://developers.openai.com/api/docs/guides/speech-to-text,
 * /guides/text-to-speech
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
