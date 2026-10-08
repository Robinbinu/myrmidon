import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { VOICE_THRESHOLDS } from '../config.ts'
import type { ModelResolver } from '../models.ts'
import type { MyrSettings } from '../settings.ts'
import { trimSilence } from './audio.ts'
import { type CallChats, type CallOutput, CallSession, type CallTurn } from './call.ts'
import { FunctionStt, OpenAiCompatibleStt, type PhononState, PhononStt, type SpeechToText } from './stt.ts'
import {
  FunctionTts,
  KITTEN_VOICES,
  type KittenState,
  KittenTts,
  OpenAiCompatibleTts,
  type Speech,
  type TextToSpeech,
} from './tts.ts'

export type VoiceSettings = MyrSettings['voice']

/** The speech parts of omp a call can use (its cloud speech models). */
export interface OmpSpeech {
  transcribe(audio: Uint8Array, mimeType: string, fileName: string): Promise<string>
  speak(
    text: string,
    options?: { voice?: string; speed?: number },
  ): Promise<{ audio: Uint8Array; mimeType: string }>
  speechModels(): { stt: string[]; tts: string[] }
}

/** Keys for OpenAI-compatible speech endpoints, kept apart from settings.json (which others may read). */
interface VoiceSecrets {
  sttKey?: string
  ttsKey?: string
}

export interface SavedCall {
  readonly id: string
  readonly chatId?: string
  readonly startedAt: string
  readonly endedAt: string
  readonly turns: readonly CallTurn[]
  /** The rounds the call started, so the chat can show the call where its work begins. */
  readonly rounds: readonly { colonyId: string; round?: number }[]
}

export interface VoiceStatus {
  readonly callModel?: string
  readonly stt: {
    provider: VoiceSettings['stt']['provider']
    phonon: PhononState
    omp: string[]
    keySet: boolean
  }
  readonly tts: {
    provider: VoiceSettings['tts']['provider']
    kitten: KittenState
    voices: readonly string[]
    omp: string[]
    keySet: boolean
  }
}

/**
 * Voice calls for this gateway: the engines on this machine (Phonon-2, Kitten TTS) and the providers chosen in
 * Settings → Voice, the calls in progress, and their transcripts (`<home>/calls/<id>.json`).
 */
export class VoiceHub {
  readonly phonon: PhononStt
  readonly kitten: KittenTts
  private readonly _calls = new Map<string, CallSession>()
  private readonly _secretsFile: string
  private readonly _callsDir: string

  constructor(
    private readonly options: {
      readonly home: string
      readonly resolver: ModelResolver
      /** The voice settings now, and the model to fall back on for calls (the lead's). */
      readonly settings: () => { voice: VoiceSettings; fallbackModel?: string }
      readonly omp?: OmpSpeech
      readonly log?: (line: string) => void
    },
  ) {
    const log = options.log ?? (() => {})
    this.phonon = new PhononStt(options.home, log)
    this.kitten = new KittenTts(
      options.home,
      () => {
        const t = options.settings().voice.tts
        return { model: t.kittenModel, voice: t.voice, speed: t.speed }
      },
      log,
    )
    this._secretsFile = join(options.home, 'voice', 'secrets.json')
    this._callsDir = join(options.home, 'calls')
  }

  status(): VoiceStatus {
    const { voice, fallbackModel } = this.options.settings()
    const secrets = this._secrets()
    const omp = this._ompModels()
    const callModel = voice.callModel ?? fallbackModel
    return {
      ...(callModel ? { callModel } : {}),
      stt: {
        provider: voice.stt.provider,
        phonon: this.phonon.status(),
        omp: omp.stt,
        keySet: !!secrets.sttKey,
      },
      tts: {
        provider: voice.tts.provider,
        kitten: this.kitten.status(),
        voices: KITTEN_VOICES,
        omp: omp.tts,
        keySet: !!secrets.ttsKey,
      },
    }
  }

  /** Saves or clears an endpoint's key (an empty string clears it). */
  setKey(which: 'stt' | 'tts', key: string) {
    const secrets = this._secrets()
    if (key.trim()) secrets[which === 'stt' ? 'sttKey' : 'ttsKey'] = key.trim()
    else delete secrets[which === 'stt' ? 'sttKey' : 'ttsKey']
    mkdirSync(join(this.options.home, 'voice'), { recursive: true, mode: 0o700 })
    const tmp = `${this._secretsFile}.tmp`
    writeFileSync(tmp, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this._secretsFile)
  }

  /** Speech to text as chosen in Settings → Voice. */
  stt(): SpeechToText {
    const { stt } = this.options.settings().voice
    if (stt.provider === 'omp') {
      const omp = this.options.omp
      if (!omp) throw new Error('cloud speech needs the model runtime')
      return new FunctionStt((audio, mime, name) => omp.transcribe(audio, mime, name))
    }
    if (stt.provider === 'endpoint') {
      if (!stt.baseUrl || !stt.model)
        throw new Error('set the speech-to-text endpoint and model in Settings → Voice')
      const apiKey = this._secrets().sttKey
      return new OpenAiCompatibleStt({
        baseUrl: stt.baseUrl,
        model: stt.model,
        ...(apiKey ? { apiKey } : {}),
      })
    }
    return this.phonon
  }

  /** Text to speech as chosen in Settings → Voice. */
  tts(): TextToSpeech {
    const { tts } = this.options.settings().voice
    if (tts.provider === 'omp') {
      const omp = this.options.omp
      if (!omp) throw new Error('cloud speech needs the model runtime')
      return new FunctionTts((text) => omp.speak(text, { speed: tts.speed }))
    }
    if (tts.provider === 'endpoint') {
      if (!tts.baseUrl || !tts.model)
        throw new Error('set the text-to-speech endpoint and model in Settings → Voice')
      const apiKey = this._secrets().ttsKey
      return new OpenAiCompatibleTts({
        baseUrl: tts.baseUrl,
        model: tts.model,
        voice: tts.endpointVoice ?? 'alloy',
        speed: tts.speed,
        ...(apiKey ? { apiKey } : {}),
      })
    }
    return this.kitten
  }

  /** A sentence in the chosen voice, for "Try it" in Settings. */
  async sample(text: string): Promise<Speech> {
    const speech = await this.tts().speak(text)
    return { pcm: trimSilence(speech.pcm, speech.sampleRate), sampleRate: speech.sampleRate }
  }

  /** Starts a call: the person's side sends audio to `call.audio` and plays what `emit` sends back. */
  call(
    chats: CallChats,
    options: { chatId?: string; chatTitle?: string; project?: string; name: string; sampleRate: number },
    emit: (out: CallOutput) => void,
  ): CallSession {
    const { voice, fallbackModel } = this.options.settings()
    const model = voice.callModel ?? fallbackModel
    if (!model) throw new Error('pick a call model in Settings → Voice')
    const session = new CallSession(
      { chats, resolver: this.options.resolver, stt: this.stt(), tts: this.tts() },
      { ...options, model, threshold: VOICE_THRESHOLDS[voice.sensitivity] },
      (out) => {
        if (out.type === 'ended') {
          this._calls.delete(session.id)
          this._save(session)
        }
        emit(out)
      },
    )
    this._calls.set(session.id, session)
    return session
  }

  /** The calls made in a chat, oldest first. */
  calls(chatId: string): SavedCall[] {
    if (!existsSync(this._callsDir)) return []
    return readdirSync(this._callsDir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          const call = JSON.parse(readFileSync(join(this._callsDir, f), 'utf8')) as SavedCall
          return call.chatId === chatId ? [call] : []
        } catch {
          return []
        }
      })
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }

  /** Hangs up every call and stops the engines on this machine. */
  stop() {
    for (const call of [...this._calls.values()]) call.hangUp()
    this.phonon.stop()
    this.kitten.stop()
  }

  private _save(session: CallSession) {
    const turns = session.transcript()
    if (!turns.some((t) => t.who === 'person')) return
    mkdirSync(this._callsDir, { recursive: true, mode: 0o700 })
    const saved: SavedCall = {
      id: session.id,
      ...(session.chatId ? { chatId: session.chatId } : {}),
      startedAt: session.startedAt,
      endedAt: new Date().toISOString(),
      turns,
      rounds: session.rounds(),
    }
    writeFileSync(join(this._callsDir, `${session.id}.json`), `${JSON.stringify(saved, null, 2)}\n`, {
      mode: 0o600,
    })
  }

  private _secrets(): VoiceSecrets {
    try {
      return JSON.parse(readFileSync(this._secretsFile, 'utf8')) as VoiceSecrets
    } catch {
      return {}
    }
  }

  private _ompModels(): { stt: string[]; tts: string[] } {
    try {
      return this.options.omp?.speechModels() ?? { stt: [], tts: [] }
    } catch {
      return { stt: [], tts: [] }
    }
  }
}
