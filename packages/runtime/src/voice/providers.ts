import { ASSEMBLYAI_MODELS, AssemblyAiStt } from './cloud/assemblyai.ts'
import { awsStt, POLLY_ENGINES, POLLY_VOICES, pollyTts, pollyVoices, TRANSCRIBE_MODELS } from './cloud/aws.ts'
import { AZURE_STT_MODELS, AZURE_VOICES, AzureStt, azureTts, azureVoices } from './cloud/azure.ts'
import {
  CARTESIA_STT_MODELS,
  CARTESIA_TTS_MODELS,
  CARTESIA_VOICES,
  CartesiaStt,
  cartesiaTts,
  cartesiaVoices,
} from './cloud/cartesia.ts'
import { DEEPGRAM_STT_MODELS, DEEPGRAM_VOICES, DeepgramStt, deepgramTts } from './cloud/deepgram.ts'
import {
  ELEVENLABS_STT_MODELS,
  ELEVENLABS_TTS_MODELS,
  ELEVENLABS_VOICES,
  ElevenLabsStt,
  elevenLabsTts,
  elevenLabsVoices,
} from './cloud/elevenlabs.ts'
import { FISH_MODELS, FISH_VOICES, fishTts, fishVoices } from './cloud/fish.ts'
import { GOOGLE_STT_MODELS, GOOGLE_VOICES, GoogleStt, googleTts, googleVoices } from './cloud/google.ts'
import {
  GROQ_STT_MODELS,
  GROQ_TTS_MODELS,
  GROQ_VOICES,
  GroqTts,
  groqStt,
  OPENAI_STT_MODELS,
  OPENAI_TTS_MODELS,
  OPENAI_VOICES,
  openAiStt,
  openAiTts,
} from './cloud/openai.ts'
import { RIME_MODELS, RIME_VOICES, rimeTts, rimeVoices } from './cloud/rime.ts'
import { SPEECHMATICS_MODELS, SPEECHMATICS_REGIONS, speechmaticsStt } from './cloud/speechmatics.ts'
import type { RealtimeConnection } from './realtime/connection.ts'
import { GEMINI_LIVE_MODELS, GEMINI_VOICES, GeminiLive } from './realtime/gemini.ts'
import { OPENAI_REALTIME_MODELS, OPENAI_REALTIME_VOICES, OpenAiRealtime } from './realtime/openai.ts'
import type { SpeechToText } from './stt.ts'
import type { TextToSpeech } from './tts.ts'

/**
 * Cloud voice providers: speech to text, text to speech and realtime speech-to-speech models, each behind one
 * adapter interface (SpeechToText, TextToSpeech, RealtimeConnection), ported from Pipecat's services (BSD-2-Clause,
 * see THIRD_PARTY_NOTICES.md) and checked against each provider's own documentation. Adding a provider is one entry
 * here and an adapter in cloud/ or realtime/.
 *
 * Keys live in omp's credential vault with the model providers' (`VoiceKeys`): a provider whose API takes a model
 * provider's key (OpenAI, Groq, Gemini) reads that key, so the person adds it once.
 */
export interface VoiceOption {
  readonly id: string
  readonly label: string
}

/** Voice providers' keys in the credential vault (omp/runtime.ts). */
export interface VoiceKeys {
  /** The key, from the vault or the provider's environment variable that omp knows. */
  get(id: string): Promise<string | undefined>
  /** Myrmidon holds a key for it in the vault. */
  stored(id: string): boolean
  set(id: string, key: string): Promise<void>
  remove(id: string): Promise<void>
}

export interface MakeOptions {
  readonly key: string
  readonly model: string
  readonly region?: string
  readonly log?: (line: string) => void
}

export interface VoiceProvider {
  readonly id: string
  readonly label: string
  /** Where the person gets a key. */
  readonly keysUrl: string
  readonly key: {
    /** Its id in the vault: its own, or the model provider's whose key its API takes (`sharedWith`). */
    readonly vault: string
    readonly sharedWith?: string
    /** Environment variables read when the vault has none (omp already reads the model providers'). */
    readonly env?: readonly string[]
    /** AWS's key is an access key id and a secret, kept together. */
    readonly aws?: true
  }
  /** A region it needs (`required`) or may be given. */
  readonly region?: {
    readonly required: boolean
    readonly default?: string
    readonly options?: readonly string[]
  }
  readonly stt?: {
    readonly models: readonly VoiceOption[]
    /** Its words come as they are said, over a stream; otherwise a turn is sent once it ends. */
    readonly streaming: boolean
    make(o: MakeOptions): SpeechToText
  }
  readonly tts?: {
    readonly models: readonly VoiceOption[]
    /** Its voices until (or without) a list from the provider. */
    readonly voices: readonly VoiceOption[]
    /** Its speech comes in pieces as it is made; otherwise a sentence at a time. */
    readonly streaming: boolean
    make(o: MakeOptions & { readonly voice: string; readonly speed: number }): TextToSpeech
    /** The voices on the person's account, from the provider's API. */
    listVoices?(o: MakeOptions): Promise<VoiceOption[]>
  }
  readonly realtime?: {
    readonly models: readonly VoiceOption[]
    readonly voices: readonly VoiceOption[]
    make(o: MakeOptions): RealtimeConnection
  }
}

export const VOICE_PROVIDERS: readonly VoiceProvider[] = [
  {
    id: 'deepgram',
    label: 'Deepgram',
    keysUrl: 'https://console.deepgram.com',
    key: { vault: 'deepgram', env: ['DEEPGRAM_API_KEY'] },
    stt: {
      models: DEEPGRAM_STT_MODELS,
      streaming: true,
      make: (o) => new DeepgramStt({ key: o.key, model: o.model, ...(o.log ? { log: o.log } : {}) }),
    },
    tts: {
      // Aura's model id is the voice.
      models: [{ id: 'aura-2', label: 'Aura-2' }],
      voices: DEEPGRAM_VOICES,
      streaming: true,
      make: (o) => deepgramTts({ key: o.key, voice: o.voice, speed: o.speed }),
    },
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    keysUrl: 'https://elevenlabs.io/app/settings/api-keys',
    key: { vault: 'elevenlabs', env: ['ELEVENLABS_API_KEY'] },
    stt: {
      models: ELEVENLABS_STT_MODELS,
      streaming: true,
      make: (o) => new ElevenLabsStt({ key: o.key, model: o.model, ...(o.log ? { log: o.log } : {}) }),
    },
    tts: {
      models: ELEVENLABS_TTS_MODELS,
      voices: ELEVENLABS_VOICES,
      streaming: true,
      make: (o) => elevenLabsTts({ key: o.key, model: o.model, voice: o.voice, speed: o.speed }),
      listVoices: (o) => elevenLabsVoices({ key: o.key }),
    },
  },
  {
    id: 'cartesia',
    label: 'Cartesia',
    keysUrl: 'https://play.cartesia.ai/keys',
    key: { vault: 'cartesia', env: ['CARTESIA_API_KEY'] },
    stt: {
      models: CARTESIA_STT_MODELS,
      streaming: true,
      make: (o) => new CartesiaStt({ key: o.key, model: o.model, ...(o.log ? { log: o.log } : {}) }),
    },
    tts: {
      models: CARTESIA_TTS_MODELS,
      voices: CARTESIA_VOICES,
      streaming: true,
      make: (o) => cartesiaTts({ key: o.key, model: o.model, voice: o.voice, speed: o.speed }),
      listVoices: (o) => cartesiaVoices({ key: o.key }),
    },
  },
  {
    id: 'assemblyai',
    label: 'AssemblyAI',
    keysUrl: 'https://www.assemblyai.com/app/api-keys',
    key: { vault: 'assemblyai', env: ['ASSEMBLYAI_API_KEY'] },
    stt: {
      models: ASSEMBLYAI_MODELS,
      streaming: true,
      make: (o) => new AssemblyAiStt({ key: o.key, model: o.model, ...(o.log ? { log: o.log } : {}) }),
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    keysUrl: 'https://platform.openai.com/api-keys',
    key: { vault: 'openai', sharedWith: 'openai' },
    stt: {
      models: OPENAI_STT_MODELS,
      streaming: false,
      make: (o) => openAiStt({ key: o.key, model: o.model }),
    },
    tts: {
      models: OPENAI_TTS_MODELS,
      voices: OPENAI_VOICES,
      streaming: true,
      make: (o) => openAiTts({ key: o.key, model: o.model, voice: o.voice, speed: o.speed }),
    },
    realtime: {
      models: OPENAI_REALTIME_MODELS,
      voices: OPENAI_REALTIME_VOICES,
      make: (o) => new OpenAiRealtime({ key: o.key, model: o.model, ...(o.log ? { log: o.log } : {}) }),
    },
  },
  {
    id: 'gemini',
    label: 'Gemini',
    keysUrl: 'https://aistudio.google.com/apikey',
    key: { vault: 'google', sharedWith: 'google' },
    realtime: {
      models: GEMINI_LIVE_MODELS,
      voices: GEMINI_VOICES,
      make: (o) => new GeminiLive({ key: o.key, model: o.model, ...(o.log ? { log: o.log } : {}) }),
    },
  },
  {
    id: 'groq',
    label: 'Groq',
    keysUrl: 'https://console.groq.com/keys',
    key: { vault: 'groq', sharedWith: 'groq' },
    stt: { models: GROQ_STT_MODELS, streaming: false, make: (o) => groqStt({ key: o.key, model: o.model }) },
    tts: {
      models: GROQ_TTS_MODELS,
      voices: GROQ_VOICES,
      streaming: false,
      make: (o) => new GroqTts({ key: o.key, model: o.model, voice: o.voice }),
    },
  },
  {
    id: 'google-cloud',
    label: 'Google Cloud',
    keysUrl: 'https://console.cloud.google.com/apis/credentials',
    key: { vault: 'google-cloud', env: ['GOOGLE_CLOUD_API_KEY'] },
    stt: {
      models: GOOGLE_STT_MODELS,
      streaming: false,
      make: (o) => new GoogleStt({ key: o.key, model: o.model }),
    },
    tts: {
      // The voice names its model family (Chirp 3 HD, Neural2…).
      models: [{ id: 'voices', label: 'By voice' }],
      voices: GOOGLE_VOICES,
      streaming: false,
      make: (o) => googleTts({ key: o.key, voice: o.voice, speed: o.speed }),
      listVoices: (o) => googleVoices({ key: o.key }),
    },
  },
  {
    id: 'azure',
    label: 'Azure AI Speech',
    keysUrl: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices',
    key: { vault: 'azure-speech', env: ['AZURE_SPEECH_KEY'] },
    region: { required: true },
    stt: {
      models: AZURE_STT_MODELS,
      streaming: false,
      make: (o) => new AzureStt({ key: o.key, region: o.region ?? '' }),
    },
    tts: {
      models: [{ id: 'neural', label: 'Neural' }],
      voices: AZURE_VOICES,
      streaming: true,
      make: (o) => azureTts({ key: o.key, region: o.region ?? '', voice: o.voice, speed: o.speed }),
      listVoices: (o) => azureVoices({ key: o.key, region: o.region ?? '' }),
    },
  },
  {
    id: 'aws',
    label: 'AWS (Transcribe, Polly)',
    keysUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    key: { vault: 'aws-voice', aws: true },
    region: { required: true, default: 'us-east-1' },
    stt: {
      models: TRANSCRIBE_MODELS,
      streaming: true,
      make: (o) => awsStt({ key: o.key, region: o.region ?? 'us-east-1', ...(o.log ? { log: o.log } : {}) }),
    },
    tts: {
      models: POLLY_ENGINES,
      voices: POLLY_VOICES,
      streaming: true,
      make: (o) =>
        pollyTts({
          key: o.key,
          region: o.region ?? 'us-east-1',
          voice: o.voice,
          engine: o.model,
          speed: o.speed,
        }),
      listVoices: (o) => pollyVoices({ key: o.key, region: o.region ?? 'us-east-1', engine: o.model }),
    },
  },
  {
    id: 'speechmatics',
    label: 'Speechmatics',
    keysUrl: 'https://portal.speechmatics.com/settings/api-keys',
    key: { vault: 'speechmatics', env: ['SPEECHMATICS_API_KEY'] },
    region: { required: false, default: 'global', options: SPEECHMATICS_REGIONS },
    stt: {
      models: SPEECHMATICS_MODELS,
      streaming: true,
      make: (o) =>
        speechmaticsStt({
          key: o.key,
          model: o.model,
          ...(o.region ? { region: o.region } : {}),
          ...(o.log ? { log: o.log } : {}),
        }),
    },
  },
  {
    id: 'rime',
    label: 'Rime',
    keysUrl: 'https://app.rime.ai/tokens',
    key: { vault: 'rime', env: ['RIME_API_KEY'] },
    tts: {
      models: RIME_MODELS,
      voices: RIME_VOICES,
      streaming: true,
      make: (o) => rimeTts({ key: o.key, model: o.model, voice: o.voice, speed: o.speed }),
      listVoices: (o) => rimeVoices({ model: o.model }),
    },
  },
  {
    id: 'fish-audio',
    label: 'Fish Audio',
    keysUrl: 'https://fish.audio/app/api-keys',
    key: { vault: 'fish-audio', env: ['FISH_API_KEY'] },
    tts: {
      models: FISH_MODELS,
      voices: FISH_VOICES,
      streaming: true,
      make: (o) => fishTts({ key: o.key, model: o.model, voice: o.voice, speed: o.speed }),
      listVoices: (o) => fishVoices({ key: o.key }),
    },
  },
]

export function voiceProvider(id: string): VoiceProvider | undefined {
  return VOICE_PROVIDERS.find((p) => p.id === id)
}

/** The vault id of one of the person's OpenAI-compatible endpoints. */
export function endpointVault(id: string): string {
  return `voice-endpoint-${id}`
}

/** The model an endpoint is asked for when none is set (as Whisper and OpenAI's speech API name theirs). */
export const ENDPOINT_DEFAULTS = { stt: 'whisper-1', tts: 'tts-1', voice: 'alloy' } as const

/** A provider's key from the environment, for the providers omp does not know (AWS's two parts as one). */
export function envKey(p: VoiceProvider): string | undefined {
  if (p.key.aws) {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
    if (!accessKeyId || !secretAccessKey) return undefined
    const sessionToken = process.env.AWS_SESSION_TOKEN
    return JSON.stringify({ accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) })
  }
  for (const name of p.key.env ?? []) if (process.env[name]) return process.env[name]
  return undefined
}
