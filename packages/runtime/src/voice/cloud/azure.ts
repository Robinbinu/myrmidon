import { VOICE_LANGUAGE } from '../../config.ts'
import { wav } from '../audio.ts'
import type { SpeechToText, TranscribeOptions } from '../stt.ts'
import { failure, HttpPcmTts, timed, xmlText } from './common.ts'

/**
 * Azure AI Speech with a resource key and its region, over REST (after LiveKit's azure TTS; its streaming STT is the
 * Speech SDK's own protocol): speech to text for short audio (a turn, under 60 s), and text to speech from SSML as raw
 * 24 kHz PCM, which streams. https://learn.microsoft.com/azure/ai-services/speech-service/rest-speech-to-text-short,
 * /rest-text-to-speech
 */
export interface AzureOptions {
  readonly key: string
  readonly region: string
  readonly language?: string
  /** Tests point it at a stand-in in place of `https://<region>.stt.speech.microsoft.com` (and `.tts.`). */
  readonly api?: string
}

const host = (o: AzureOptions, kind: 'stt' | 'tts') =>
  o.api ?? `https://${o.region}.${kind}.speech.microsoft.com`

export class AzureStt implements SpeechToText {
  constructor(private readonly o: AzureOptions) {}

  async transcribe(pcm: Int16Array, sampleRate: number, options: TranscribeOptions = {}): Promise<string> {
    const q = new URLSearchParams({ language: this.o.language ?? VOICE_LANGUAGE, format: 'simple' })
    const res = await fetch(
      `${host(this.o, 'stt')}/speech/recognition/conversation/cognitiveservices/v1?${q}`,
      {
        method: 'POST',
        headers: {
          'ocp-apim-subscription-key': this.o.key,
          'content-type': `audio/wav; codecs=audio/pcm; samplerate=${sampleRate}`,
          accept: 'application/json',
        },
        body: wav(pcm, sampleRate),
        signal: timed(options.signal),
      },
    )
    if (!res.ok) throw await failure('Azure transcription', res)
    const body = (await res.json()) as { RecognitionStatus?: string; DisplayText?: string }
    // NoMatch, a silence timeout: nothing was said.
    if (body.RecognitionStatus === 'Success') return (body.DisplayText ?? '').trim()
    if (body.RecognitionStatus === 'Error') throw new Error('Azure transcription failed')
    return ''
  }
}

export function azureTts(o: AzureOptions & { voice: string; speed?: number }): HttpPcmTts {
  // A voice's name starts with its locale (`en-US-AvaMultilingualNeural`).
  const lang = /^[a-z]{2,3}-[A-Z]{2}/.exec(o.voice)?.[0] ?? o.language ?? VOICE_LANGUAGE
  // A plain number is a multiple of the voice's own rate.
  const rate = o.speed && o.speed !== 1 ? String(o.speed) : undefined
  return new HttpPcmTts('Azure speech', 24_000, (text, signal) =>
    fetch(`${host(o, 'tts')}/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'ocp-apim-subscription-key': o.key,
        'content-type': 'application/ssml+xml',
        'x-microsoft-outputformat': 'raw-24khz-16bit-mono-pcm',
        // Azure refuses a request without one.
        'user-agent': 'Myrmidon',
      },
      body:
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
        `<voice name="${xmlText(o.voice)}">${rate ? `<prosody rate="${rate}">` : ''}${xmlText(text)}` +
        `${rate ? '</prosody>' : ''}</voice></speak>`,
      signal,
    }),
  )
}

export async function azureVoices(o: AzureOptions): Promise<{ id: string; label: string }[]> {
  const res = await fetch(`${host(o, 'tts')}/cognitiveservices/voices/list`, {
    headers: { 'ocp-apim-subscription-key': o.key },
    signal: timed(),
  })
  if (!res.ok) throw await failure('Azure voices', res)
  const body = (await res.json()) as { ShortName?: string; DisplayName?: string; Locale?: string }[]
  const lang = (o.language ?? VOICE_LANGUAGE).slice(0, 2)
  return body
    .filter((v) => v.ShortName && v.Locale?.startsWith(lang))
    .map((v) => ({ id: v.ShortName as string, label: `${v.DisplayName ?? v.ShortName} (${v.Locale})` }))
}

export const AZURE_VOICES = [
  { id: 'en-US-AvaMultilingualNeural', label: 'Ava (en-US)' },
  { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew (en-US)' },
  { id: 'en-US-JennyNeural', label: 'Jenny (en-US)' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia (en-GB)' },
] as const
/** Short-audio recognition has one model; the choice is only there for the picker to show. */
export const AZURE_STT_MODELS = [{ id: 'conversation', label: 'Conversation' }] as const
