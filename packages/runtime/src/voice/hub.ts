import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
} from '../config.ts'
import type { ModelResolver } from '../models.ts'
import { prompts } from '../prompts.ts'
import type { MyrSettings } from '../settings.ts'
import { trimSilence } from './audio.ts'
import { type CallChats, type CallOptions, type CallOutput, CallSession, type CallTurn } from './call.ts'
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

/** Keys for OpenAI-compatible speech endpoints, kept apart from settings.json (which others may read). */
interface VoiceSecrets {
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
    this._prune()
    // A gateway left running for weeks drops old transcripts too, not only when it starts or a call ends.
    setInterval(() => this._prune(), options.pruneMs ?? VOICE_TRANSCRIPT_PRUNE_MS).unref()
  }

  status(): VoiceStatus {
    const { voice, fallbackModel } = this.options.settings()
    const secrets = this._secrets()
    const omp = this._ompModels()
    const callModel = voice.callModel ?? fallbackModel
    return {
      enabled: voice.enabled,
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

  /**
   * Downloads and warms the engines the settings choose (the speech detector, the turn model, Kitten's model, Phonon-2
   * once installed), so turning voice on fetches them then, with progress in `status()`, rather than in the middle of
   * a "Try it" or a call's first sentence. Shared: a call starting meanwhile waits for the same work, and once warm it
   * returns at once until the choice changes.
   */
  warm(): Promise<void> {
    const { voice } = this.options.settings()
    // Off means nothing is downloaded or started.
    if (!voice.enabled) {
      this._warm = undefined
      return Promise.resolve()
    }
    const phonon = voice.stt.provider === 'phonon' && this.phonon.status().state !== 'missing'
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
    const stt = this.stt()
    return stt.transcribeFile ? (await stt.transcribeFile(audio, mimeType, name)).trim() : undefined
  }

  /** A sentence in the chosen voice, for "Try it" in Settings. */
  async sample(text: string): Promise<Speech> {
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
    },
    emit: (out: CallOutput) => void,
  ): CallSession {
    const refused = this.refusal(options.chatId)
    if (refused) throw refused
    const { voice, fallbackModel } = this.options.settings()
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
  refusal(chatId?: string): CallRefused | undefined {
    const { voice, fallbackModel } = this.options.settings()
    const r = prompts.voice.refused
    if (!voice.enabled) return new CallRefused(4409, r.off)
    const calls = [...this._calls.values()]
    if (chatId && calls.some((c) => c.chatId === chatId)) return new CallRefused(4423, r.busy)
    if (calls.length >= VOICE_MAX_CALLS) return new CallRefused(4429, r.full(VOICE_MAX_CALLS))
    if (!(voice.callModel ?? fallbackModel)) return new CallRefused(4503, r.noModel)
    const unready = this._unready()
    return unready ? new CallRefused(4503, unready) : undefined
  }

  /** Why the chosen engines on this machine cannot take a call now (after warm(), which fetches what it can). */
  private _unready(): string | undefined {
    const { voice } = this.options.settings()
    const r = prompts.voice.refused
    if (voice.stt.provider === 'phonon') {
      const phonon = this.phonon.status()
      if (phonon.state === 'missing') return r.phononMissing
      if (phonon.state === 'installing') return r.phononInstalling
      if (phonon.state === 'error') return r.failed('Phonon-2', phonon.error)
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
    for (const { file, call } of this._saved()) if (call.endedAt < before) rmSync(file, { force: true })
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
