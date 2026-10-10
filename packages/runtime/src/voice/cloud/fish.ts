import { failure, HttpPcmTts, timed } from './common.ts'

/**
 * Fish Audio (after LiveKit's fishaudio TTS): `/v1/tts` with a JSON body and the model in a `model` header, asked for
 * PCM at 24 kHz in short chunks (its default of 300 arrives in bursts with gaps between). The voice is a voice model's
 * id (`reference_id`). https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech, /model/list-models
 */
const API = 'https://api.fish.audio'

export function fishTts(o: {
  key: string
  model: string
  voice: string
  speed?: number
  api?: string
}): HttpPcmTts {
  const rate = 24_000
  return new HttpPcmTts('Fish Audio speech', rate, (text, signal) =>
    fetch(`${o.api ?? API}/v1/tts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json', model: o.model },
      body: JSON.stringify({
        text,
        reference_id: o.voice,
        format: 'pcm',
        sample_rate: rate,
        latency: 'balanced',
        chunk_length: 100,
        normalize: true,
        ...(o.speed && o.speed !== 1 ? { prosody: { speed: o.speed, volume: 0 } } : {}),
      }),
      signal,
    }),
  )
}

/** The voice models on the person's Fish Audio account. */
export async function fishVoices(o: { key: string; api?: string }): Promise<{ id: string; label: string }[]> {
  const res = await fetch(`${o.api ?? API}/model?page_size=50&self=true`, {
    headers: { authorization: `Bearer ${o.key}` },
    signal: timed(),
  })
  if (!res.ok) throw await failure('Fish Audio voices', res)
  const body = (await res.json()) as { items?: { _id?: string; title?: string }[] }
  return (body.items ?? []).flatMap((v) => (v._id ? [{ id: v._id, label: v.title || v._id }] : []))
}

export const FISH_MODELS = [
  { id: 's2.1-pro', label: 'S2.1 Pro' },
  { id: 's1', label: 'S1' },
] as const
/** A public voice model Fish Audio's examples use, until the account's own are fetched. */
export const FISH_VOICES = [{ id: '933563129e564b19a115bedd57b7406a', label: 'Example voice' }] as const
