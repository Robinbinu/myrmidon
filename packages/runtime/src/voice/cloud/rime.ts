import { failure, HttpPcmTts, timed } from './common.ts'

/**
 * Rime (after Pipecat's RimeHttpTTSService): `/v1/rime-tts` asked for `audio/L16`, raw 16-bit PCM that streams in.
 * https://docs.rime.ai/api-reference/endpoint/streaming-pcm, /api-reference/data/voices-v2
 */
const API = 'https://users.rime.ai'

export function rimeTts(o: {
  key: string
  model: string
  voice: string
  speed?: number
  api?: string
}): HttpPcmTts {
  const rate = 24_000
  return new HttpPcmTts('Rime speech', rate, (text, signal) =>
    fetch(`${o.api ?? API}/v1/rime-tts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${o.key}`,
        'content-type': 'application/json',
        accept: 'audio/L16',
      },
      body: JSON.stringify({
        speaker: o.voice,
        text,
        modelId: o.model,
        lang: 'eng',
        samplingRate: rate,
        // Coda and Mist v3 read speedAlpha as a speed (above 1 is faster); Mist v2 the other way round.
        ...(o.speed && o.speed !== 1 ? { speedAlpha: o.model === 'mistv2' ? 1 / o.speed : o.speed } : {}),
      }),
      signal,
    }),
  )
}

/** Rime's public list of speakers, by model and language (no key needed). */
export async function rimeVoices(o: {
  model: string
  api?: string
}): Promise<{ id: string; label: string }[]> {
  const res = await fetch(`${o.api ?? API}/data/voices/all-v2.json`, { signal: timed() })
  if (!res.ok) throw await failure('Rime voices', res)
  const body = (await res.json()) as Record<string, Record<string, string[]>>
  const speakers = body[o.model]?.eng ?? []
  return speakers.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) }))
}

/** Arcana was retired on 2026-08-15 (Rime's migration guide). */
export const RIME_MODELS = [
  { id: 'coda', label: 'Coda' },
  { id: 'mistv3', label: 'Mist v3' },
  { id: 'mistv2', label: 'Mist v2' },
] as const
export const RIME_VOICES = [
  { id: 'astra', label: 'Astra' },
  { id: 'celeste', label: 'Celeste' },
  { id: 'albion', label: 'Albion' },
] as const
