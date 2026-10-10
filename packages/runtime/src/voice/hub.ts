import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  VOICE_MAX_CALLS,
  VOICE_PHONON_MODEL_BYTES,
  VOICE_SMART_TURN_BYTES,
  VOICE_THRESHOLDS,
  VOICE_TRANSCRIPT_DAYS,
  VOICE_TRANSCRIPT_PRUNE_MS,
  VOICE_VAD_BYTES,
  VOICE_VAD_HYSTERESIS,
  VOICE_VAD_START,
  VOICE_VOICES_CACHE_MS,
} from '../config.ts'
import type { ModelResolver } from '../models.ts'
import { prompts } from '../prompts.ts'
import { type MyrSettings, VOICE_LEGACY_KEYS, type VoiceEndpoint } from '../settings.ts'
import { trimSilence } from './audio.ts'
import { type CallChats, type CallOptions, type CallOutput, CallSession, type CallTurn } from './call.ts'
import { CallGreeter, type CallGreetingFacts } from './greeting.ts'
import {
  ENDPOINT_DEFAULTS,
  endpointVault,
  envKey,
  VOICE_PROVIDERS,
  type VoiceKeys,
  type VoiceOption,
  type VoiceProvider,
  voiceProvider,
} from './providers.ts'
import { RealtimeCallSession } from './realtime/session.ts'
import { SmartTurn } from './smart-turn.ts'
import { FunctionStt, OpenAiCompatibleStt, type PhononState, PhononStt, type SpeechToText } from './stt.ts'
import {
  FunctionTts,
  KITTEN_VOICES,
  type KittenModel,
  type KittenState,
  KittenTts,
  kittenBytes,
  OpenAiCompatibleTts,
  type Speech,
  type TextToSpeech,
} from './tts.ts'
import { SileroVad } from './vad.ts'

export type VoiceSettings = MyrSettings['voice']

/**
 * Why a call cannot start, with the WebSocket close code the person's side reads it by: 4409 voice calls are off,
 * 4423 a call is already on in this chat, 4429 too many calls at once, 4503 the speech engines are not ready.
 */
export class CallRefused extends Error {
  constructor(
    readonly code: 4409 | 4423 | 4429 | 4503,
    message: string,
  ) {
    super(message)
  }
}

/** The speech parts of omp a call can use (its cloud speech models). */
export interface OmpSpeech {
  transcribe(audio: Uint8Array, mimeType: string, fileName: string): Promise<string>
  speak(
    text: string,
    options?: { voice?: string; speed?: number },
  ): Promise<{ audio: Uint8Array; mimeType: string }>
  speechModels(): { stt: string[]; tts: string[] }
}

/** The keys an older Myrmidon kept in `<home>/voice/secrets.json`, moved into the vault (see migrateSecrets). */
interface LegacySecrets {
  sttKey?: string
  ttsKey?: string
}

export interface SavedCall {
  readonly id: string
  readonly chatId: string
  readonly startedAt: string
  readonly endedAt: string
  readonly turns: readonly CallTurn[]
  /** The rounds the call started, so the chat can show the call where its work begins. */
  readonly rounds: readonly { colonyId: string; round?: number }[]
  /** The crew has been given this transcript (with the next message in the chat). */
  readonly told?: boolean
  /** Who the person talked to, when not the call assistant (`lead` or an agent's name). */
  readonly talkTo?: string
  /** The number on the other end, when it was a phone call. */
  readonly phone?: string
}

export interface VoiceStatus {
  readonly enabled: boolean
  readonly callModel?: string
  readonly mode: VoiceSettings['mode']
  readonly stt: {
    provider: string
    phonon: PhononState
    omp: string[]
    /** The chosen cloud provider has its key (always true for the engines on this machine and omp's). */
    keySet: boolean
  }
  readonly tts: {
    provider: string
    kitten: KittenState
    /** Kitten's voices. */
    voices: readonly string[]
    omp: string[]
    keySet: boolean
  }
  /** Whether the speech detector and the turn model are here; both download with the first warm-up. */
  readonly vad: { ready: boolean }
  readonly turn: { ready: boolean }
  /**
   * Bytes each engine downloads the first time it is used, so Settings can say so before it happens: Phonon-2's
   * model (its command line comes from the Install button), each Kitten model, the speech detector, the turn model.
   */
  readonly sizes: { phonon: number; kitten: Record<KittenModel, number>; vad: number; turn: number }
  /** Days a call's transcript is kept. */
  readonly transcriptDays: number
}

/** A cloud voice provider as Settings shows it: what it does, and whether it can be used now. */
export interface VoiceProviderStatus {
  readonly id: string
  readonly label: string
  readonly keysUrl: string
  /**
   * Where its key comes from: Myrmidon's vault (`stored`), a model provider's key its API shares (`shared`, from
   * `sharedWith`), the environment (`env`), or nowhere yet (`missing`).
   */
  readonly key: 'stored' | 'shared' | 'env' | 'missing'
  readonly sharedWith?: string
  /** Its key is an AWS access key id and secret. */
  readonly aws?: true
  readonly region?: {
    readonly required: boolean
    readonly default?: string
    readonly options?: readonly string[]
    readonly value?: string
  }
  /** It has its key (and region, where it needs one): it can be chosen. */
  readonly configured: boolean
  readonly stt?: { readonly models: readonly VoiceOption[]; readonly streaming: boolean }
  readonly tts?: {
    readonly models: readonly VoiceOption[]
    readonly voices: readonly VoiceOption[]
    readonly streaming: boolean
    /** Its voices can be fetched from its API (GET /api/voice/providers/:id/voices). */
    readonly voiceList: boolean
  }
  readonly realtime?: { readonly models: readonly VoiceOption[]; readonly voices: readonly VoiceOption[] }
}

/** One of the person's OpenAI-compatible speech services. */
export interface VoiceEndpointStatus extends VoiceEndpoint {
  readonly hasKey: boolean
}

/**
 * Voice calls for this gateway: the engines on this machine (Phonon-2, Kitten TTS) and the providers chosen in
 * Settings → Voice, the calls in progress, and their transcripts (`<home>/calls/<id>.json`, kept with their chat for
 * VOICE_TRANSCRIPT_DAYS).
 */
export class VoiceHub {
  readonly phonon: PhononStt
  readonly kitten: KittenTts
  readonly vad: SileroVad
  readonly turn: SmartTurn
  private readonly _calls = new Map<string, CallSession>()
  private readonly _secretsFile: string
  private readonly _callsDir: string
  private _warm?: { key: string; done: Promise<void> }
  /** Keys of the providers chosen, as last read from the vault (a call is made without waiting on it). */
  private readonly _keys = new Map<string, string | undefined>()
  /** Voice lists fetched from providers, by provider and model, with when. */
  private readonly _voiceLists = new Map<string, { at: number; voices: VoiceOption[] }>()
  private readonly _migrated: Promise<void>
  /** Picks each call's opening line, so calls in a row do not open the same way. */
  private readonly _greeter: CallGreeter
  /** When the person's last call that got as far as its greeting ended (kept transcripts tell it after a restart). */
  private _lastCall?: Date

  constructor(
    private readonly options: {
      readonly home: string
      readonly resolver: ModelResolver
      /** The voice settings now, and the model to fall back on for calls (the lead's). */
      readonly settings: () => { voice: VoiceSettings; fallbackModel?: string }
      readonly omp?: OmpSpeech
      readonly log?: (line: string) => void
      /** The speech detector; Silero VAD in `<home>/voice` unless given (tests give one that stays offline). */
      readonly vad?: SileroVad
      /** The end-of-turn model; Smart Turn in `<home>/voice` unless given. */
      readonly turn?: SmartTurn
      /** Kitten TTS from Hugging Face unless given (tests give one that downloads from a stand-in). */
      readonly kitten?: KittenTts
      /** How often old transcripts are dropped while the gateway runs (VOICE_TRANSCRIPT_PRUNE_MS unless given). */
      readonly pruneMs?: number
      /** Voice providers' keys, in the vault the model providers' are in. */
      readonly keys?: VoiceKeys
    },
  ) {
    const log = options.log ?? (() => {})
    this.phonon = new PhononStt(options.home, log)
    this.kitten =
      options.kitten ??
      new KittenTts(
        options.home,
        () => {
          const t = options.settings().voice.tts
          return { model: t.kittenModel, voice: t.voice, speed: t.speed }
        },
        log,
      )
    this.vad = options.vad ?? new SileroVad(options.home)
    this.turn = options.turn ?? new SmartTurn(options.home)
    this._secretsFile = join(options.home, 'voice', 'secrets.json')
    this._callsDir = join(options.home, 'calls')
    this._greeter = new CallGreeter(options.resolver)
    this._migrated = this._migrateSecrets().catch((err) =>
      log(
        `could not move the voice keys into the vault: ${err instanceof Error ? err.message : String(err)}`,
      ),
    )
    this._prune()
    // A gateway left running for weeks drops old transcripts too, not only when it starts or a call ends.
    setInterval(() => this._prune(), options.pruneMs ?? VOICE_TRANSCRIPT_PRUNE_MS).unref()
  }

  status(): VoiceStatus {
    const { voice, fallbackModel } = this.options.settings()
    const omp = this._ompModels()
    const callModel = voice.callModel ?? fallbackModel
    return {
      enabled: voice.enabled,
      ...(callModel ? { callModel } : {}),
      mode: voice.mode,
      stt: {
        provider: voice.stt.provider,
        phonon: this.phonon.status(),
        omp: omp.stt,
        keySet: this._hasKey(voice.stt.provider),
      },
      tts: {
        provider: voice.tts.provider,
        kitten: this.kitten.status(),
        voices: KITTEN_VOICES,
        omp: omp.tts,
        keySet: this._hasKey(voice.tts.provider),
      },
      vad: { ready: this.vad.ready },
      turn: { ready: this.turn.ready },
      sizes: {
        phonon: VOICE_PHONON_MODEL_BYTES,
        kitten: {
          nano: kittenBytes(this.kitten.pins.nano),
          micro: kittenBytes(this.kitten.pins.micro),
          mini: kittenBytes(this.kitten.pins.mini),
        },
        vad: VOICE_VAD_BYTES,
        turn: VOICE_SMART_TURN_BYTES,
      },
      transcriptDays: VOICE_TRANSCRIPT_DAYS,
    }
  }

  /** The cloud voice providers and the person's endpoints, with where each one's key comes from. */
  async providers(): Promise<{ providers: VoiceProviderStatus[]; endpoints: VoiceEndpointStatus[] }> {
    await this._migrated
    const { voice } = this.options.settings()
    const keys = this.options.keys
    const providers = await Promise.all(
      VOICE_PROVIDERS.map(async (p): Promise<VoiceProviderStatus> => {
        const found = await this._lookup(p)
        // A shared key is the model provider's, wherever that one's comes from.
        const key = !found
          ? 'missing'
          : p.key.sharedWith
            ? 'shared'
            : keys?.stored(p.key.vault)
              ? 'stored'
              : 'env'
        const region = voice.regions?.[p.id]
        return {
          id: p.id,
          label: p.label,
          keysUrl: p.keysUrl,
          key,
          ...(p.key.sharedWith ? { sharedWith: p.key.sharedWith } : {}),
          ...(p.key.aws ? { aws: true as const } : {}),
          ...(p.region ? { region: { ...p.region, ...(region ? { value: region } : {}) } } : {}),
          configured: key !== 'missing' && (!p.region?.required || !!(region ?? p.region.default)),
          ...(p.stt ? { stt: { models: p.stt.models, streaming: p.stt.streaming } } : {}),
          ...(p.tts
            ? {
                tts: {
                  models: p.tts.models,
                  voices: p.tts.voices,
                  streaming: p.tts.streaming,
                  voiceList: !!p.tts.listVoices,
                },
              }
            : {}),
          ...(p.realtime ? { realtime: { models: p.realtime.models, voices: p.realtime.voices } } : {}),
        }
      }),
    )
    const endpoints = (voice.endpoints ?? []).map((e) => ({
      ...e,
      hasKey: !!keys?.stored(endpointVault(e.id)),
    }))
    return { providers, endpoints }
  }

  /**
   * Saves a key for a provider (its id) or one of the person's endpoints (`endpoint:<id>`), in the vault. A provider
   * whose API takes a model provider's key saves it as that one's: it is the same key.
   */
  async setKey(id: string, key: string): Promise<void> {
    const keys = this.options.keys
    if (!keys) throw new Error('voice provider keys need the model runtime')
    await keys.set(this._vaultOf(id), key)
    this._keys.clear()
    this._voiceLists.clear()
  }

  /** Removes a provider's or an endpoint's key from the vault; a shared key is the model provider's to remove. */
  async removeKey(id: string): Promise<void> {
    const keys = this.options.keys
    if (!keys) throw new Error('voice provider keys need the model runtime')
    const shared = voiceProvider(id)?.key.sharedWith
    if (shared) throw new Error(prompts.voice.keys.shared(shared))
    await keys.remove(this._vaultOf(id))
    this._keys.clear()
    this._voiceLists.clear()
  }

  /**
   * A provider's voices: from its API when it has one and its key is here (kept for VOICE_VOICES_CACHE_MS), else the
   * ones it ships with. `model`: the voices of that model (Polly's engines, Rime's models differ).
   */
  async voices(id: string, model?: string): Promise<VoiceOption[]> {
    const p = voiceProvider(id)
    if (!p?.tts) throw new Error(prompts.voice.refused.unknownProvider(id))
    const m = model ?? p.tts.models[0]?.id ?? ''
    const cacheKey = `${id}/${m}`
    const cached = this._voiceLists.get(cacheKey)
    if (cached && Date.now() - cached.at < VOICE_VOICES_CACHE_MS) return cached.voices
    const key = await this._lookup(p)
    if (!p.tts.listVoices || !key) return [...p.tts.voices]
    const region = this._region(p)
    const voices = await p.tts.listVoices({ key, model: m, ...(region ? { region } : {}) })
    const list = voices.length ? voices : [...p.tts.voices]
    this._voiceLists.set(cacheKey, { at: Date.now(), voices: list })
    return list
  }

  private _vaultOf(id: string): string {
    if (id.startsWith('endpoint:')) {
      const name = id.slice('endpoint:'.length)
      if (!(this.options.settings().voice.endpoints ?? []).some((e) => e.id === name))
        throw new Error(prompts.voice.refused.noEndpoint(name))
      return endpointVault(name)
    }
    const p = voiceProvider(id)
    if (!p) throw new Error(prompts.voice.refused.unknownProvider(id))
    return p.key.vault
  }

  /** A provider's key, from the vault, else the environment. */
  private async _lookup(p: VoiceProvider): Promise<string | undefined> {
    await this._migrated
    const fromVault = await this.options.keys?.get(p.key.vault).catch(() => undefined)
    return fromVault || envKey(p)
  }

  private _region(p: VoiceProvider): string | undefined {
    return this.options.settings().voice.regions?.[p.id] ?? p.region?.default
  }

  /** Reads the keys of the providers chosen now (and the realtime model's), for the next call to use. */
  async loadKeys(): Promise<void> {
    await this._migrated
    const { voice } = this.options.settings()
    const ids = [
      voice.stt.provider,
      voice.tts.provider,
      ...(voice.mode === 'realtime' ? [this._realtimeId()] : []),
    ]
    for (const id of new Set(ids)) {
      if (id.startsWith('endpoint:')) {
        const name = id.slice('endpoint:'.length)
        const key = await this.options.keys?.get(endpointVault(name)).catch(() => undefined)
        this._keys.set(id, key || undefined)
        continue
      }
      const p = voiceProvider(id)
      if (p) this._keys.set(id, await this._lookup(p))
    }
  }

  /** Whether a choice has the key it needs, as far as is known (keys are read when voice warms). */
  private _hasKey(id: string): boolean {
    if (!voiceProvider(id)) return true
    return !!this._keys.get(id)
  }

  /** The key and region a cloud choice runs with; throws what the person has to set. */
  private _auth(p: VoiceProvider): { key: string; region?: string } {
    const key = this._keys.get(p.id)
    if (!key) throw new Error(prompts.voice.refused.noKey(p.label))
    const region = this._region(p)
    if (p.region?.required && !region) throw new Error(prompts.voice.refused.noRegion(p.label))
    return { key, ...(region ? { region } : {}) }
  }

  private _endpoint(id: string): VoiceEndpoint {
    const name = id.slice('endpoint:'.length)
    const found = (this.options.settings().voice.endpoints ?? []).find((e) => e.id === name)
    if (!found) throw new Error(prompts.voice.refused.noEndpoint(name))
    return found
  }

  private _realtimeId(): string {
    return this.options.settings().voice.realtime?.provider ?? 'openai'
  }

  /**
   * Moves the keys an older Myrmidon kept in `voice/secrets.json` into the vault, under the endpoints the settings
   * made of its old addresses (settings.ts, legacyVoice), then deletes the file. Without the vault (no model
   * runtime) the file is left as it is.
   */
  private async _migrateSecrets(): Promise<void> {
    const keys = this.options.keys
    if (!keys || !existsSync(this._secretsFile)) return
    let secrets: LegacySecrets
    try {
      secrets = JSON.parse(readFileSync(this._secretsFile, 'utf8')) as LegacySecrets
    } catch {
      secrets = {}
    }
    const endpoints = new Set((this.options.settings().voice.endpoints ?? []).map((e) => e.id))
    const moves: [string, string | undefined][] = endpoints.has(VOICE_LEGACY_KEYS.shared)
      ? [[VOICE_LEGACY_KEYS.shared, secrets.sttKey ?? secrets.ttsKey]]
      : [
          [VOICE_LEGACY_KEYS.stt, secrets.sttKey],
          [VOICE_LEGACY_KEYS.tts, secrets.ttsKey],
        ]
    for (const [id, key] of moves) if (key?.trim()) await keys.set(endpointVault(id), key.trim())
    rmSync(this._secretsFile, { force: true })
    this.options.log?.('moved the voice endpoint keys from voice/secrets.json into the credential vault')
  }

  /** Speech to text as chosen in Settings → Voice (a cloud choice's key is read by warm()). */
  stt(): SpeechToText {
    const { stt } = this.options.settings().voice
    const log = this.options.log
    if (stt.provider === 'phonon') return this.phonon
    if (stt.provider === 'omp') {
      const omp = this.options.omp
      if (!omp) throw new Error('cloud speech needs the model runtime')
      return new FunctionStt((audio, mime, name) => omp.transcribe(audio, mime, name))
    }
    if (stt.provider.startsWith('endpoint:')) {
      const e = this._endpoint(stt.provider)
      const apiKey = this._keys.get(stt.provider)
      return new OpenAiCompatibleStt({
        baseUrl: e.baseUrl,
        model: stt.model ?? ENDPOINT_DEFAULTS.stt,
        ...(apiKey ? { apiKey } : {}),
      })
    }
    const p = voiceProvider(stt.provider)
    if (!p?.stt) throw new Error(prompts.voice.refused.unknownProvider(stt.provider))
    return p.stt.make({
      ...this._auth(p),
      model: stt.model ?? p.stt.models[0]?.id ?? '',
      ...(log ? { log } : {}),
    })
  }

  /** Text to speech as chosen in Settings → Voice. */
  tts(): TextToSpeech {
    const { tts } = this.options.settings().voice
    if (tts.provider === 'kitten') return this.kitten
    if (tts.provider === 'omp') {
      const omp = this.options.omp
      if (!omp) throw new Error('cloud speech needs the model runtime')
      return new FunctionTts((text) => omp.speak(text, { speed: tts.speed }))
    }
    if (tts.provider.startsWith('endpoint:')) {
      const e = this._endpoint(tts.provider)
      const apiKey = this._keys.get(tts.provider)
      return new OpenAiCompatibleTts({
        baseUrl: e.baseUrl,
        model: tts.model ?? ENDPOINT_DEFAULTS.tts,
        voice: tts.voiceId ?? ENDPOINT_DEFAULTS.voice,
        speed: tts.speed,
        ...(apiKey ? { apiKey } : {}),
      })
    }
    const p = voiceProvider(tts.provider)
    if (!p?.tts) throw new Error(prompts.voice.refused.unknownProvider(tts.provider))
    const log = this.options.log
    return p.tts.make({
      ...this._auth(p),
      model: tts.model ?? p.tts.models[0]?.id ?? '',
      voice: tts.voiceId ?? p.tts.voices[0]?.id ?? '',
      speed: tts.speed,
      ...(log ? { log } : {}),
    })
  }

  /** The engines on this machine a call goes on with if a cloud one fails: those that are here. */
  private _fallback(): { stt?: SpeechToText; tts?: TextToSpeech } {
    const { voice } = this.options.settings()
    const phonon = this.phonon.status().state
    const kitten = this.kitten.status().state
    return {
      ...(voice.stt.provider !== 'phonon' && ['ready', 'running', 'starting'].includes(phonon)
        ? { stt: this.phonon }
        : {}),
      ...(voice.tts.provider !== 'kitten' && (kitten === 'ready' || kitten === 'running')
        ? { tts: this.kitten }
        : {}),
    }
  }

  /**
   * Downloads and warms the engines the settings choose (the speech detector, the turn model, Kitten's model, Phonon-2
   * once installed), so turning voice on fetches them then, with progress in `status()`, rather than in the middle of
   * a "Try it" or a call's first sentence. Shared: a call starting meanwhile waits for the same work, and once warm it
   * returns at once until the choice changes. The chosen cloud providers' keys are read again each time, so a key
   * added since is the next call's.
   */
  warm(): Promise<void> {
    const { voice } = this.options.settings()
    // Off means nothing is downloaded or started.
    if (!voice.enabled) {
      this._warm = undefined
      return Promise.resolve()
    }
    const keys = this.loadKeys().catch((err) =>
      this.options.log?.(`voice keys: ${err instanceof Error ? err.message : String(err)}`),
    )
    return Promise.all([this._warmEngines(voice), keys]).then(() => {})
  }

  private _warmEngines(voice: VoiceSettings): Promise<void> {
    const phonon =
      voice.stt.provider === 'phonon' && !['missing', 'unsupported'].includes(this.phonon.status().state)
    const kitten = voice.tts.provider === 'kitten'
    const key = JSON.stringify([phonon, kitten, voice.tts.kittenModel, voice.tts.voice])
    if (this._warm?.key === key) return this._warm.done
    const log = this.options.log ?? (() => {})
    const jobs: [string, Promise<unknown>][] = [
      ['speech detector', this.vad.load()],
      ['turn model', this.turn.load()],
    ]
    if (phonon) jobs.push(['Phonon-2', this.phonon.warm()])
    // Speaking starts the worker, which downloads the model first if it is not here.
    if (kitten) jobs.push(['Kitten TTS', this.kitten.speak('Ready.')])
    const done = Promise.allSettled(jobs.map(([, job]) => job)).then((results) => {
      results.forEach((r, i) => {
        if (r.status === 'rejected')
          log(`${jobs[i]?.[0]} did not start: ${r.reason instanceof Error ? r.reason.message : r.reason}`)
      })
      // A failure is tried again next time.
      if (results.some((r) => r.status === 'rejected') && this._warm?.done === done) this._warm = undefined
    })
    this._warm = { key, done }
    return done
  }

  /**
   * A recording as text with the speech to text chosen in Settings → Voice (a channel's voice note), while voice is
   * on; undefined when it is off or the engine cannot read a whole file, so the caller can try something else.
   */
  async transcribeFile(audio: Uint8Array, mimeType: string, name: string): Promise<string | undefined> {
    if (!this.enabled) return undefined
    await this.loadKeys()
    const stt = this.stt()
    return stt.transcribeFile ? (await stt.transcribeFile(audio, mimeType, name)).trim() : undefined
  }

  /** A sentence in the chosen voice, for "Try it" in Settings. */
  async sample(text: string): Promise<Speech> {
    await this.loadKeys()
    const speech = await this.tts().speak(text)
    return { pcm: trimSilence(speech.pcm, speech.sampleRate), sampleRate: speech.sampleRate }
  }

  /** Whether voice calls are on in Settings → Voice. */
  get enabled(): boolean {
    return this.options.settings().voice.enabled
  }

  /**
   * Starts a call: the person's side sends audio to `call.audio` and plays what `emit` sends back. Throws
   * CallRefused when it cannot: voice off, a call already in the chat, too many calls, or engines not ready.
   */
  call(
    chats: CallChats,
    options: {
      chatId?: string
      chatTitle?: string
      project?: string
      projectName?: string
      name: string
      sampleRate: number
      talkTo?: string
      crew?: readonly { name: string; role?: string }[]
      member?: CallOptions['member']
      phone?: string
      /**
       * What the call's greeting is drawn from: the chats as the chat list shows them (no more than the caller already
       * has, so greeting costs no wait) and the model that may write fresher lines for a later call.
       */
      greeting?: { chats: CallGreetingFacts['chats']; model?: string }
    },
    emit: (out: CallOutput) => void,
  ): CallSession {
    const refused = this.refusal(options.chatId, options.talkTo)
    if (refused) throw refused
    // The greeting is the hub's to draw; the call is given only the line.
    const { greeting, ...rest } = options
    options = rest
    const { voice, fallbackModel } = this.options.settings()
    if (voice.mode === 'realtime' && !options.talkTo) return this._realtimeCall(chats, options, emit)
    const model = voice.callModel ?? fallbackModel
    if (!model) throw new CallRefused(4503, prompts.voice.refused.noModel)
    let stt: SpeechToText
    let tts: TextToSpeech
    try {
      stt = this.stt()
      tts = this.tts()
    } catch (err) {
      throw new CallRefused(4503, err instanceof Error ? err.message : String(err))
    }
    const session = new CallSession(
      {
        chats,
        resolver: this.options.resolver,
        stt,
        tts,
        // Downloaded by warm(); until then turns are found by level, and end after a longer quiet.
        ...(this.vad.ready ? { detector: this.vad } : {}),
        ...(this.turn.ready ? { judge: this.turn } : {}),
        ...(this.options.log ? { log: this.options.log } : {}),
        fallback: this._fallback(),
        // A member calling in hears the plain hello: the owner's chats are not theirs to hear about.
        ...(options.member ? {} : { greet: () => this._greet(options, greeting) }),
      },
      {
        ...options,
        model,
        start: VOICE_VAD_START[voice.sensitivity],
        hold: VOICE_VAD_START[voice.sensitivity] - VOICE_VAD_HYSTERESIS,
        threshold: VOICE_THRESHOLDS[voice.sensitivity],
      },
      (out) => {
        if (out.type === 'ended') {
          this._calls.delete(session.id)
          if (session.transcript().length) this._lastCall = new Date()
          this._save(session)
        }
        emit(out)
      },
    )
    this._calls.set(session.id, session)
    return session
  }

  /** The line a call starting now opens with, from the moment and what the chats are doing. */
  private _greet(
    options: { name: string; chatId?: string; talkTo?: string },
    greeting?: { chats: CallGreetingFacts['chats']; model?: string },
  ): string {
    return this._greeter.line(
      {
        name: options.name,
        now: new Date(),
        ...(this._lastCall ? { lastSeen: this._lastCall } : {}),
        chats: greeting?.chats ?? [],
        ...(options.chatId ? { chatId: options.chatId } : {}),
        ...(options.talkTo ? { talkTo: options.talkTo } : {}),
      },
      greeting?.model,
    )
  }

  /** A call with the call assistant on the realtime model chosen in Settings → Voice. */
  private _realtimeCall(
    chats: CallChats,
    options: Parameters<VoiceHub['call']>[1],
    emit: (out: CallOutput) => void,
  ): CallSession {
    const { voice } = this.options.settings()
    const p = voiceProvider(this._realtimeId())
    if (!p?.realtime) throw new CallRefused(4503, prompts.voice.refused.noRealtime)
    let auth: { key: string; region?: string }
    try {
      auth = this._auth(p)
    } catch (err) {
      throw new CallRefused(4503, err instanceof Error ? err.message : String(err))
    }
    const log = this.options.log
    const model = voice.realtime?.model ?? p.realtime.models[0]?.id ?? ''
    const session: CallSession = new RealtimeCallSession(
      {
        chats,
        resolver: this.options.resolver,
        realtime: p.realtime.make({ ...auth, model, ...(log ? { log } : {}) }),
        voice: voice.realtime?.voice ?? p.realtime.voices[0]?.id ?? '',
        ...(voice.tts.speed !== 1 ? { speed: voice.tts.speed } : {}),
        ...(log ? { log } : {}),
      },
      {
        ...options,
        model: `${p.id}/${model}`,
        start: VOICE_VAD_START[voice.sensitivity],
        hold: VOICE_VAD_START[voice.sensitivity] - VOICE_VAD_HYSTERESIS,
        threshold: VOICE_THRESHOLDS[voice.sensitivity],
      },
      (out) => {
        if (out.type === 'ended') {
          this._calls.delete(session.id)
          if (session.transcript().length) this._lastCall = new Date()
          this._save(session)
        }
        emit(out)
      },
    )
    this._calls.set(session.id, session)
    return session
  }

  /**
   * Why a call cannot start now (in this chat), or undefined when it can: what call() checks, asked first by a phone
   * line so the caller hears it before the call is answered.
   */
  refusal(chatId?: string, talkTo?: string): CallRefused | undefined {
    const { voice, fallbackModel } = this.options.settings()
    const r = prompts.voice.refused
    if (!voice.enabled) return new CallRefused(4409, r.off)
    const calls = [...this._calls.values()]
    if (chatId && calls.some((c) => c.chatId === chatId)) return new CallRefused(4423, r.busy)
    if (calls.length >= VOICE_MAX_CALLS) return new CallRefused(4429, r.full(VOICE_MAX_CALLS))
    // A realtime call's model is the realtime one; a call straight to the crew has none either way.
    const realtime = voice.mode === 'realtime' && !talkTo
    if (!realtime && !(voice.callModel ?? fallbackModel)) return new CallRefused(4503, r.noModel)
    const unready = realtime ? this._missingKey(this._realtimeId()) : this._unready()
    return unready ? new CallRefused(4503, unready) : undefined
  }

  /** A cloud choice whose key is known (since warm()) to be missing: what to do about it. */
  private _missingKey(id: string): string | undefined {
    const p = voiceProvider(id)
    if (!p || !this._keys.has(id)) return undefined
    return this._keys.get(id) ? undefined : prompts.voice.refused.noKey(p.label)
  }

  /** Why the chosen engines cannot take a call now (after warm(), which fetches what it can). */
  private _unready(): string | undefined {
    const { voice } = this.options.settings()
    const r = prompts.voice.refused
    const missing = this._missingKey(voice.stt.provider) ?? this._missingKey(voice.tts.provider)
    if (missing) return missing
    if (voice.stt.provider === 'phonon') {
      const phonon = this.phonon.status()
      if (phonon.state === 'missing') return r.phononMissing
      if (phonon.state === 'installing') return r.phononInstalling
      if (phonon.state === 'error' || phonon.state === 'unsupported')
        return r.failed('Phonon-2', phonon.error)
    }
    if (voice.tts.provider === 'kitten') {
      const kitten = this.kitten.status()
      if (kitten.state === 'missing' || kitten.state === 'downloading') return r.kittenMissing
      if (kitten.state === 'error') return r.failed('Kitten TTS', kitten.error)
    }
    return undefined
  }

  /** The calls made in a chat, oldest first. */
  calls(chatId: string): SavedCall[] {
    return this._saved()
      .flatMap(({ call }) => (call.chatId === chatId ? [call] : []))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }

  /** A chat was deleted: its calls end, and their transcripts go with it. */
  forget(chatId: string) {
    for (const call of [...this._calls.values()]) if (call.chatId === chatId) call.hangUp()
    for (const { file, call } of this._saved()) if (call.chatId === chatId) rmSync(file, { force: true })
  }

  /**
   * The transcripts of calls in a chat the crew has not been told about, for the next message to carry (the lead
   * cannot answer "how did the call go" otherwise). `tell` marks them told once that message is sent.
   */
  untold(chatId: string): { context: string; tell(): void } | undefined {
    const calls = this.calls(chatId).filter((c) => !c.told)
    if (!calls.length) return undefined
    const time = (iso: string) => iso.slice(11, 16)
    const lines = calls.map((c) =>
      c.turns
        .map(
          (t) =>
            `[${time(t.at)}] ${t.who === 'person' ? 'Person' : t.who === 'voice' ? 'Call assistant' : 'Crew update'}: ${t.text}`,
        )
        .join('\n'),
    )
    return {
      context: prompts.voice.transcripts(lines),
      tell: () => {
        // A transcript deleted meanwhile (its chat was) is not written back.
        for (const c of calls) if (existsSync(this._file(c.id))) this._write({ ...c, told: true })
      },
    }
  }

  /** Hangs up every call and stops the engines on this machine (they start again when warmed). */
  stop() {
    for (const call of [...this._calls.values()]) call.hangUp()
    this.phonon.stop()
    this.kitten.stop()
    this._warm = undefined
  }

  private _save(session: CallSession) {
    const turns = session.transcript()
    // A call that made no chat (it started no work) has nowhere to be shown or deleted with: it is not kept.
    if (!session.chatId || !turns.some((t) => t.who === 'person')) return
    const saved: SavedCall = {
      id: session.id,
      chatId: session.chatId,
      startedAt: session.startedAt,
      endedAt: new Date().toISOString(),
      turns,
      rounds: session.rounds(),
      // A direct call's words are the chat's own messages: the crew already has them.
      ...(session.direct ? { talkTo: session.direct, told: true } : {}),
      ...(session.phone ? { phone: session.phone } : {}),
    }
    this._write(saved)
    this._prune()
  }

  /** Every saved call, with its file; one that cannot be read is skipped. */
  private _saved(): { file: string; call: SavedCall }[] {
    if (!existsSync(this._callsDir)) return []
    return readdirSync(this._callsDir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        const file = join(this._callsDir, f)
        try {
          return [{ file, call: JSON.parse(readFileSync(file, 'utf8')) as SavedCall }]
        } catch {
          return []
        }
      })
  }

  /** Drops transcripts older than VOICE_TRANSCRIPT_DAYS. */
  private _prune() {
    const before = new Date(Date.now() - VOICE_TRANSCRIPT_DAYS * 86_400_000).toISOString()
    for (const { file, call } of this._saved()) {
      if (call.endedAt < before) rmSync(file, { force: true })
      else if (!(this._lastCall && this._lastCall.toISOString() >= call.endedAt))
        this._lastCall = new Date(call.endedAt)
    }
  }

  private _file(id: string): string {
    return join(this._callsDir, `${id}.json`)
  }

  private _write(call: SavedCall) {
    mkdirSync(this._callsDir, { recursive: true, mode: 0o700 })
    writeFileSync(this._file(call.id), `${JSON.stringify(call, null, 2)}\n`, {
      mode: 0o600,
    })
  }

  private _ompModels(): { stt: string[]; tts: string[] } {
    try {
      return this.options.omp?.speechModels() ?? { stt: [], tts: [] }
    } catch {
      return { stt: [], tts: [] }
    }
  }
}
