import { randomBytes } from 'node:crypto'
import type { MyrEvent } from '@myrmidon/protocol'
import { canonicalZone, clockMinutes, localDate, zoneOffset } from '../clock.ts'
import {
  VOICE_ANSWER_CHARS,
  VOICE_END_MS,
  VOICE_HOTWORDS,
  VOICE_PAUSE_MS,
  VOICE_SMART_END_MS,
  VOICE_SMART_START_MS,
  VOICE_SMART_TURN_DIRECT_THRESHOLD,
  VOICE_SMART_TURN_THRESHOLD,
  VOICE_SPOKEN_SENTENCES,
  VOICE_STEPS,
} from '../config.ts'
import type { ModelResolver } from '../models.ts'
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  streamSimple,
  type Tool,
  type ToolCall,
} from '../omp/ai.ts'
import { prompts } from '../prompts.ts'
import { hideInContext } from '../provider-secrets.ts'
import { trimSilence, trimStart } from './audio.ts'
import type { LiveTranscription } from './phonon-stream.ts'
import type { TurnJudge } from './smart-turn.ts'
import { SpeechSplitter, speakable } from './speech.ts'
import type { SpeechToText } from './stt.ts'
import type { TextToSpeech } from './tts.ts'
import { rms, TurnDetector } from './turns.ts'
import { type SpeechDetector, VAD_CHUNK } from './vad.ts'

/** What a call needs from the chats: the same port the channels use. */
export interface CallChats {
  send(
    text: string,
    chatId: string | undefined,
    options?: { project?: string; voice?: boolean; askAll?: boolean },
  ): Promise<{ chatId: string; colonyId: string; started: boolean; round?: number }>
  onEvents(listener: (colonyId: string, events: readonly MyrEvent[]) => void): () => void
  /**
   * Replies as they are written (`text` is the reply so far), so a direct call speaks them as they come. `plain`: the
   * model's own text rather than a reply tool's, which may be narration before a tool call (see AgentHost.streamed).
   */
  onStream?(
    listener: (colonyId: string, agent: string, text: string, done: boolean, plain: boolean) => void,
  ): () => void
  decideApproval(colonyId: string, id: string, approved: boolean): Promise<void>
}

export interface CallOptions {
  /** The call model, `provider/model`. */
  readonly model: string
  /** The chat the call is in; a call from a new chat makes one with its first task. */
  readonly chatId?: string
  readonly chatTitle?: string
  readonly project?: string
  /** The project's name, for the speech to text to favour (with the crew's names). */
  readonly projectName?: string
  /** What to call the person. */
  readonly name: string
  /** How sure the speech detector must be to start a turn (see VOICE_VAD_START), and how much less to hold one. */
  readonly start: number
  readonly hold: number
  /** The speech level to fall back on without a detector (see VOICE_THRESHOLDS). */
  readonly threshold: number
  /** The sample rate of the audio the person's side sends. */
  readonly sampleRate: number
  /**
   * Who the person talks to: the call assistant (the call model, by default), `lead` (what they say goes to the chat
   * as their message and the lead's replies are spoken), or a crew member by name (written to them directly).
   */
  readonly talkTo?: string
  /** The chat's crew besides the lead, so the call assistant can ask one of them (ask_crew). */
  readonly crew?: readonly { name: string; role?: string }[]
  /**
   * The person is an approved member of a channel (`channel`, its label), not the owner: a phone caller listed under
   * SMS. What they ask reaches the crew marked as theirs and asks before every step that changes something, as their
   * texts do, and approvals are the owner's to decide, never theirs.
   */
  readonly member?: { readonly name: string; readonly channel: string }
  /** The phone number on the other end of a phone call, kept with its transcript. */
  readonly phone?: string
}

export interface CallTurn {
  readonly at: string
  readonly who: 'person' | 'voice' | 'crew'
  readonly text: string
}

type CallState = 'listening' | 'hearing' | 'thinking' | 'speaking'

/** What a call tells the person's side (the app, later a phone line). */
export type CallOutput =
  /** First: who the call reached (`assistant`, `lead` or a crew member's name), and the chat it is in. */
  | { type: 'hello'; talk: string; chatId?: string; chatTitle?: string }
  /** `muted` while the person's microphone is off; unmuting shows the state the call is in. */
  | { type: 'state'; state: 'preparing' | CallState | 'muted' }
  /** The person's turn so far, as it is heard while they speak (with an engine that streams); `heard` once it ends. */
  | { type: 'partial'; text: string }
  | { type: 'heard'; text: string }
  /** A line spoken, and whose it is: `assistant`, `lead` or a crew member's name. */
  | { type: 'said'; text: string; from: string }
  | { type: 'audio'; pcm: Int16Array; sampleRate: number }
  /** Stop playing what was sent: the person talked over it. */
  | { type: 'stop-audio' }
  | { type: 'chat'; chatId: string }
  | { type: 'task'; colonyId: string; request: string }
  /** An approval put to the person (read out), and later how it was decided, on the call or elsewhere. */
  | { type: 'approval'; id: string; summary: string }
  | { type: 'approval-done'; id: string; approved: boolean }
  | { type: 'error'; message: string }
  /**
   * How long the person waited for the answer to start, from when they stopped talking, and where it went: finding
   * the turn had ended and hearing it (`heard`), the first words written (`thought`), the first sound (`voiced`).
   */
  | { type: 'latency'; ms: number; heard: number; thought: number; voiced: number }
  | { type: 'ended'; reason: 'hung-up' | 'agent' | 'error' }

/** Something the call sent the crew: a task, or a question to the lead or one agent; and what came of it. */
interface Sent {
  readonly colonyId: string
  readonly request: string
  readonly round?: number
  /** A question rather than work: answered by the first reply from `to` (the lead when unset). */
  readonly question?: boolean
  readonly to?: string
  answer?: string
  done?: boolean
}

/** On a direct call, something to read aloud: a finished text, or a reply still being written (not yet `done`). */
interface Utterance {
  readonly from: string
  readonly pieces: string[]
  done: boolean
  /** Called with when its last piece finishes playing, once that piece is on its way. */
  readonly said?: (until: number) => void
}

/** Whole answers that decide an approval; anything more ("okay, what does it want?") is not one. */
const YES = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'sure',
  'allow',
  'allow it',
  'approve',
  'approve it',
  'go ahead',
  'do it',
  'yes please',
  'yes go ahead',
  'yes do it',
  'yeah go ahead',
  'okay go ahead',
  'sure go ahead',
])
const NO = new Set([
  'no',
  'nope',
  'nah',
  'no thanks',
  'deny',
  'deny it',
  'refuse',
  'refuse it',
  'cancel',
  'stop',
  "don't",
  'do not',
  "don't do it",
  'do not do it',
  'no stop',
  "no don't",
])

/** A turn that is a plain yes (true) or no (false) and nothing else, whatever its case and punctuation. */
export function spokenAnswer(text: string): boolean | undefined {
  const said = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return YES.has(said) ? true : NO.has(said) ? false : undefined
}

/** The date and time as the call assistant is told them, in the person's zone. */
export function callTime() {
  const now = new Date()
  return {
    date: localDate(now),
    weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
    time: clockMinutes(now),
    zone: `${canonicalZone()} (${zoneOffset(now)})`,
  }
}

/** The call assistant's tools (exported for the prompt lint's parameter check). */
export const VOICE_TOOLS: Tool[] = [
  {
    name: 'start_task',
    description: prompts.voice.tools.startTask.description,
    parameters: {
      type: 'object',
      properties: { request: { type: 'string', description: prompts.voice.tools.startTask.request } },
      required: ['request'],
    } as never,
  },
  {
    name: 'ask_crew',
    description: prompts.voice.tools.askCrew.description,
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: prompts.voice.tools.askCrew.question },
        to: { type: 'string', description: prompts.voice.tools.askCrew.to },
      },
      required: ['question'],
    } as never,
  },
  {
    name: 'task_status',
    description: prompts.voice.tools.taskStatus.description,
    parameters: { type: 'object', properties: {} } as never,
  },
  {
    name: 'crew_updates',
    description: prompts.voice.tools.crewUpdates.description,
    parameters: { type: 'object', properties: {} } as never,
  },
  {
    name: 'answer_approval',
    description: prompts.voice.tools.answerApproval.description,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: prompts.voice.tools.answerApproval.id },
        approve: { type: 'boolean', description: prompts.voice.tools.answerApproval.approve },
      },
      required: ['id', 'approve'],
    } as never,
  },
  {
    name: 'end_call',
    description: prompts.voice.tools.endCall.description,
    parameters: { type: 'object', properties: {} } as never,
  },
]

/**
 * A voice call. The person's turns (found in their audio, then transcribed) go either to the call assistant, a fast
 * model that answers small things itself, hands real work to the crew as ordinary runs in the chat (start_task) and
 * can ask the lead or one agent a question (ask_crew); or straight to the lead or one crew member, as the person's own
 * messages in the chat, whose replies are read aloud. Speech is a sentence at a time as it is ready. While the crew
 * works the call goes on; when a run finishes, fails, asks a question or needs approval, the person hears at the
 * next pause. Talking over the call stops it at once (barge-in).
 */
export class CallSession {
  readonly id = randomBytes(6).toString('hex')
  readonly startedAt = new Date().toISOString()
  private _chatId?: string
  private readonly _messages: Message[] = []
  private readonly _turns: CallTurn[] = []
  private readonly _detector: TurnDetector
  protected readonly _sent: Sent[] = []
  /** Approvals the crew is waiting on in this call's runs, in the order they were asked for. */
  private readonly _approvals = new Map<string, { colonyId: string; tool: string; summary: string }>()
  /**
   * The approval put to the person, the one their yes or no decides; the others wait their turn. `heard`: the turns
   * begun before it was read out to the end (handed to the call assistant), none of which can answer it; `until`:
   * when its reading finishes playing.
   */
  private _asking?: { id: string; heard?: number; until?: number }
  /** The person's latest turn as a plain yes or no, and which turn it was. */
  protected _answer?: { approved: boolean; turn: number }
  /** Turns the person has begun, so a yes can be placed before or after an approval was heard. */
  protected _begun = 0
  /** The turn in progress (its number), carried to where it ends. */
  private _turn = 0
  /** Crew updates for the call assistant, how the transcript shows each to the person, and the approval it puts. */
  protected readonly _updates: { text: string; note: string; approval?: string }[] = []
  protected _reply?: AbortController
  private _replying?: Promise<void>
  private _speech: Promise<void> = Promise.resolve()
  /** When the audio sent so far finishes playing on the person's side. */
  protected _playingUntil = 0
  protected _muted = false
  protected _ended = false
  /** Aborted when the call ends, calling off what it still had to say (the greeting, a fallback notice). */
  private readonly _life = new AbortController()
  /** The state the call is in, shown again when the person unmutes. */
  protected _current: CallState = 'listening'
  private _vad?: { chance(chunk: Float32Array): Promise<number> }
  /** The end-of-turn model, until it fails; then turns end on quiet alone. */
  private _judge?: TurnJudge
  /** Audio not yet scored, and the scoring in progress (chunks are scored in order). */
  private _unscored = new Int16Array(0)
  private _scoring: Promise<void> = Promise.resolve()
  protected _hangUpAfterSpeech = false
  private readonly _off: () => void
  private _offStream?: () => void
  /** Who says the call's own lines: the call assistant, or whoever a direct call reached. */
  protected readonly _voice: string
  /** On a direct call, what is to be read aloud, in order: a reply still being written holds the rest back. */
  private readonly _queue: Utterance[] = []
  /** Replies being written, by colony and agent. */
  private readonly _streams = new Map<string, Utterance & { split: SpeechSplitter }>()
  /** Agents whose last reply was spoken from its stream, so its finished copy is not spoken again. */
  private readonly _streamed = new Set<string>()
  /** The current turn's timings (ms since epoch): when the person stopped, was heard, first words, first sound. */
  protected _clock?: { stopped: number; heard: number; thought?: number }
  /**
   * Names the speech to text favours: the project's and the crew's, which it would otherwise spell as it hears them
   * (and an @name has to match). Not the lead's: it is "lead", a word the engine already knows.
   */
  protected readonly _hotwords: readonly string[]
  /** The turn in progress as it is heard, while the engine streams one. */
  private _live?: LiveTranscription
  /** The speech engines in use: the chosen ones, until one fails and the call goes on with the fallback. */
  private _stt: SpeechToText
  private _tts: TextToSpeech

  constructor(
    protected readonly ports: {
      readonly chats: CallChats
      readonly resolver: ModelResolver
      readonly stt: SpeechToText
      readonly tts: TextToSpeech
      /** Silero VAD; without it (or if it fails) turns are found by level. */
      readonly detector?: SpeechDetector
      /** Smart Turn: with it a short pause can end a finished turn; without it, a turn ends after a longer quiet. */
      readonly judge?: TurnJudge
      readonly log?: (line: string) => void
      /**
       * The engines on this machine to go on with when a cloud one fails mid-call (when they are here): the call says
       * so, shows the error, and carries on with them.
       */
      readonly fallback?: { readonly stt?: SpeechToText; readonly tts?: TextToSpeech }
      /**
       * The line the call opens with, asked for as it starts (so a call that ended first takes none) and at once: it
       * must not wait on anything. Without it, the plain hello.
       */
      readonly greet?: () => string
    },
    protected readonly options: CallOptions,
    protected readonly emit: (out: CallOutput) => void,
  ) {
    this._stt = ports.stt
    this._tts = ports.tts
    this._chatId = options.chatId
    this._voice = options.talkTo ?? 'assistant'
    this._hotwords = [
      ...new Set(
        [options.projectName, ...(options.crew ?? []).map((c) => c.name)].flatMap((n) => n?.trim() || []),
      ),
    ].slice(0, VOICE_HOTWORDS)
    this._judge = ports.judge
    this._detector = new TurnDetector({
      sampleRate: options.sampleRate,
      start: options.start,
      hold: options.hold,
      ...(ports.judge
        ? {
            startMs: VOICE_SMART_START_MS,
            pauseMs: [VOICE_PAUSE_MS, VOICE_END_MS],
            endMs: VOICE_SMART_END_MS,
          }
        : {}),
    })
    // Silero's model here is for 16 kHz; other rates (a phone line's 8 kHz) are scored by level.
    if (ports.detector && options.sampleRate === 16_000) this._vad = ports.detector.stream()
    this._off = ports.chats.onEvents((colonyId, events) => this._onEvents(colonyId, events))
    if (options.talkTo && ports.chats.onStream)
      this._offStream = ports.chats.onStream((colonyId, agent, text, done, plain) =>
        this._onStream(colonyId, agent, text, done, plain),
      )
  }

  get chatId(): string | undefined {
    return this._chatId
  }

  transcript(): readonly CallTurn[] {
    return this._turns
  }

  /** The rounds this call started, in order. */
  rounds(): { colonyId: string; round?: number }[] {
    return this._sent
      .filter((t) => t.round)
      .map((t) => ({ colonyId: t.colonyId, ...(t.round ? { round: t.round } : {}) }))
  }

  /** Who the person is talking to, when it is not the call assistant. */
  get direct(): string | undefined {
    return this.options.talkTo
  }

  /** The number on the other end, on a phone call. */
  get phone(): string | undefined {
    return this.options.phone
  }

  /** A message from the person to the crew, marked as a member's when they are one. */
  private _send(text: string, voice = false) {
    const member = this.options.member
    return this.ports.chats.send(
      member ? prompts.channels.member(member.name, member.channel, text) : text,
      this._chatId,
      {
        ...(voice ? { voice: true } : {}),
        ...(this.options.project ? { project: this.options.project } : {}),
        ...(member ? { askAll: true } : {}),
      },
    )
  }

  /** Says who answered, greets the person; the call is then listening. */
  async start() {
    // Hung up before it started (the person's side closed while the engines warmed up): nothing is said or readied.
    if (this._ended) return
    // While the greeting plays, so the person's first turn is not the one to pay for them.
    this._stt
      .prepare?.(this._hotwords)
      .catch((err) => this.ports.log?.(`speech to text: ${err instanceof Error ? err.message : String(err)}`))
    this.emit({
      type: 'hello',
      talk: this._voice,
      ...(this._chatId ? { chatId: this._chatId } : {}),
      ...(this.options.chatTitle ? { chatTitle: this.options.chatTitle } : {}),
    })
    const hello =
      this.ports.greet?.() ??
      (this.direct
        ? prompts.voice.direct.hello(this.options.name, this.direct)
        : prompts.voice.hello(this.options.name))
    await this._say(hello, this._life.signal, this._voice)
    await this._speech
    this._state('listening')
  }

  /** A frame of the person's audio (16-bit mono at the call's sample rate), any length. */
  audio(frame: Int16Array) {
    if (this._ended || this._muted) return
    const all = new Int16Array(this._unscored.length + frame.length)
    all.set(this._unscored)
    all.set(frame, this._unscored.length)
    let at = 0
    for (; at + VAD_CHUNK <= all.length; at += VAD_CHUNK) {
      const chunk = all.slice(at, at + VAD_CHUNK)
      this._scoring = this._scoring.then(() => this._score(chunk))
    }
    this._unscored = all.slice(at)
  }

  /** How likely a chunk is speech, then what that means for the person's turn. */
  private async _score(chunk: Int16Array) {
    if (this._ended || this._muted) return
    let chance = rms(chunk) >= this.options.threshold ? 1 : 0
    if (this._vad) {
      try {
        chance = await this._vad.chance(Float32Array.from(chunk, (x) => x / 32768))
      } catch (err) {
        this._vad = undefined
        this.emit({
          type: 'error',
          message: `speech detector: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
    if (this._ended || this._muted) return
    if (this._detector.speaking) this._live?.push(chunk)
    for (const event of this._detector.push(chunk, chance)) {
      if (event.type === 'start') {
        if (this._reply || this._playingUntil > Date.now()) this.interrupt()
        this._begun += 1
        this._turn = this._begun
        this._state('hearing')
        this._listen()
      } else if (event.type === 'pause') void this._pause(event.id, event.quietMs, event.audio, this._turn)
      else
        void this._heard(
          this._transcribe(event.audio),
          this.ports.judge ? VOICE_SMART_END_MS : VOICE_END_MS,
          this._turn,
        )
    }
  }

  /** Follows the turn just begun as it is heard, from what came just before it, when the engine streams. */
  private _listen() {
    this._live?.close()
    this._live = this._stt.listen?.(
      this.options.sampleRate,
      (text) => {
        if (!this._ended) this.emit({ type: 'partial', text })
      },
      { hotwords: this._hotwords, ...(this.ports.log ? { log: this.ports.log } : {}) },
    )
    this._live?.push(this._detector.soFar())
  }

  /**
   * A turn that has ended: an engine whose stream gives the transcript is asked for the rest of it; otherwise (or if
   * that fails) the turn's whole audio is transcribed. A cloud engine that fails hands the call to the one on this
   * machine, when it is here.
   */
  private async _transcribe(audio: Int16Array): Promise<string> {
    const live = this._live
    this._live = undefined
    if (live?.finish) {
      try {
        return await live.finish()
      } catch (err) {
        this.ports.log?.(`speech to text stream: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else live?.close()
    const stt = this._stt
    try {
      return await stt.transcribe(audio, this.options.sampleRate, { hotwords: this._hotwords })
    } catch (err) {
      const backup = this.ports.fallback?.stt
      if (!backup || stt === backup || this._ended) throw err
      if (this._stt === stt) {
        this._stt = backup
        this._fellBack('stt', err)
      }
      return backup.transcribe(audio, this.options.sampleRate, { hotwords: this._hotwords })
    }
  }

  /** A cloud engine failed and the call goes on with the one on this machine: the person sees why and hears so. */
  private _fellBack(which: 'stt' | 'tts', err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    this.emit({ type: 'error', message: prompts.voice.fallback.error(which, message) })
    this.ports.log?.(
      `${which === 'stt' ? 'speech to text' : 'text to speech'} failed, using this machine's: ${message}`,
    )
    if (which === 'stt') void this._say(prompts.voice.fallback.said(which), this._life.signal, this._voice)
  }

  /**
   * A pause in the person's turn: Smart Turn hears whether they have finished, and if so the turn ends here and is
   * transcribed (only then: a cloud speech-to-text is paid per request). Without the model, or while an approval is
   * put to them ("Yes… wait, no" must not end at "yes"), only a pause of VOICE_END_MS ends the turn.
   */
  private async _pause(id: number, quietMs: number, audio: Int16Array, turn: number) {
    const judge = this._asking === undefined ? this._judge : undefined
    if (judge) {
      try {
        const finished = await judge.finished(audio)
        const threshold = this.direct ? VOICE_SMART_TURN_DIRECT_THRESHOLD : VOICE_SMART_TURN_THRESHOLD
        if (finished < threshold) return
      } catch (err) {
        // One failure is enough to know: the rest of the call ends turns on quiet, and the person is not told each time.
        if (this._judge) {
          this._judge = undefined
          this.ports.log?.(
            `turn model failed, ending turns on quiet instead: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        if (quietMs < VOICE_END_MS) return
      }
    } else if (quietMs < VOICE_END_MS) return
    if (this._ended) return
    const ended = this._detector.end(id)
    if (ended) void this._heard(this._transcribe(ended), quietMs, turn)
  }

  /** The person talked over the call agent (found here or by their side): stop speaking and listen. */
  interrupt() {
    this._reply?.abort()
    this._reply = undefined
    // What was still to be read is dropped; a reply still being written is followed to its end, unspoken.
    this._queue.length = 0
    this._playingUntil = 0
    // An approval cut off before it was heard to the end is put again once the person's turn is over.
    const asking = this._asking
    if (this.direct && asking && (asking.until === undefined || asking.until > Date.now()))
      this._asking = undefined
    this.emit({ type: 'stop-audio' })
  }

  mute(muted: boolean) {
    this._muted = muted
    if (muted) {
      this._detector.reset()
      this._live?.close()
      this._live = undefined
      this._unscored = new Int16Array(0)
      if (this._current === 'hearing') this._current = 'listening'
    }
    if (!this._ended) this.emit({ type: 'state', state: muted ? 'muted' : this._current })
  }

  hangUp(reason: 'hung-up' | 'agent' | 'error' = 'hung-up') {
    if (this._ended) return
    this._ended = true
    this._reply?.abort()
    this._life.abort()
    this._live?.close()
    this._off()
    this._offStream?.()
    this.emit({ type: 'ended', reason })
  }

  protected _state(state: CallState) {
    this._current = state
    if (!this._ended && !this._muted) this.emit({ type: 'state', state })
  }

  protected _note(who: CallTurn['who'], text: string) {
    this._turns.push({ at: new Date().toISOString(), who, text })
  }

  /** A finished turn (the `turn`th): its transcript (on its way) and how long the person had already been quiet. */
  private async _heard(transcript: Promise<string>, quietMs: number, turn: number) {
    const stopped = Date.now() - quietMs
    let text: string
    try {
      text = await transcript
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      this._state('listening')
      return this._askNext()
    }
    if (this._ended) return
    if (!text) {
      this._state('listening')
      return this._askNext()
    }
    this._clock = { stopped, heard: Date.now() }
    this._personSaid(text, turn)
    if (this.direct) return this._toCrew(text)
    this._messages.push({ role: 'user', content: text, timestamp: Date.now() })
    void this._respond()
  }

  /** The person's `turn`th turn, heard: kept in the transcript, shown, and noted when it is a plain yes or no. */
  protected _personSaid(text: string, turn: number) {
    this._note('person', text)
    this.emit({ type: 'heard', text })
    const answer = spokenAnswer(text)
    this._answer = answer === undefined ? undefined : { approved: answer, turn }
  }

  /**
   * Waits until the person's latest turn has been heard, before an answer is checked against it: a pipeline call's
   * turns are heard before the call assistant runs, a realtime model's transcript may come after its tool call.
   */
  protected async _turnHeard(): Promise<void> {}

  /**
   * The person's latest turn, if it was a plain yes or no to the approval put to them: begun after they had heard it
   * (not a yes meant for something else, nor one said over it).
   */
  private _answers(id: string): boolean | undefined {
    const asking = this._asking
    const answer = this._answer
    if (asking?.id !== id || asking.heard === undefined || !answer || answer.turn <= asking.heard)
      return undefined
    return answer.approved
  }

  /**
   * A direct call: what the person said goes to the chat as their message (to the lead, or to one agent with
   * @name), marked as said aloud so the answer comes short and plain. A plain yes or no answers the approval put to
   * them.
   */
  private async _toCrew(text: string) {
    const id = this._asking?.id
    const answer = id === undefined ? undefined : this._answers(id)
    if (id !== undefined && answer !== undefined) {
      this._answer = undefined
      try {
        this._speak(await this._decide(id, answer), this._voice)
      } catch (err) {
        this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        this._state('listening')
      }
      this._askNext()
      return
    }
    // Not an answer: the approval it was said over (if any) is put again after.
    this._askNext()
    this._state('thinking')
    try {
      const sent = await this._send(this.direct === 'lead' ? text : `@${this.direct} ${text}`, true)
      this._track(sent, text, { question: true, ...(this.direct === 'lead' ? {} : { to: this.direct }) })
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      this._state('listening')
    }
  }

  /** Decides an approval on the person's word; returns what was decided, to read back to them. */
  private async _decide(id: string, approved: boolean): Promise<string> {
    const waiting = this._approvals.get(id)
    if (!waiting) return prompts.voice.results.noApproval(id)
    // Off the list first, so the crew's own record of this decision, arriving meanwhile, is not taken for another.
    this._approvals.delete(id)
    try {
      await this.ports.chats.decideApproval(waiting.colonyId, id, approved)
    } catch (err) {
      this._approvals.set(id, waiting)
      throw err
    }
    this._settled(id, approved)
    return prompts.voice.decided(approved, waiting.summary)
  }

  private _settled(id: string, approved: boolean) {
    this.emit({ type: 'approval-done', id, approved })
    if (this._asking?.id === id) this._asking = undefined
  }

  /** Puts the next waiting approval to the person, one at a time, so their yes or no decides the one they heard. */
  protected _askNext() {
    if (this._asking || this._ended) return
    const next = this._approvals.entries().next()
    if (next.done) return
    const [id, { tool, summary }] = next.value
    const asking: { id: string; heard?: number; until?: number } = { id }
    this._asking = asking
    this.emit({ type: 'approval', id, summary })
    if (this.direct)
      this._queue.push({
        from: this._voice,
        pieces: speakable(prompts.voice.direct.approval(tool, summary)),
        done: true,
        said: (until) => {
          asking.heard = this._begun
          asking.until = until
        },
      })
    else
      this._updates.push({
        text: prompts.voice.updates.approval(id, tool, summary),
        note: prompts.voice.notes.approval(summary),
        approval: id,
      })
    this._feed()
  }

  private _track(
    sent: { chatId: string; colonyId: string; round?: number },
    request: string,
    extra: { question?: boolean; to?: string } = {},
  ) {
    if (!this._chatId) {
      this._chatId = sent.chatId
      this.emit({ type: 'chat', chatId: sent.chatId })
    }
    this._sent.push({
      colonyId: sent.colonyId,
      request,
      ...(sent.round ? { round: sent.round } : {}),
      ...extra,
    })
    if (!extra.question) this.emit({ type: 'task', colonyId: sent.colonyId, request })
  }

  /** On a direct call, reads text aloud (an agent's reply, an approval) after whatever is already to be read. */
  private _speak(text: string, from: string) {
    this._queue.push({ from, pieces: speakable(text), done: true })
    this._feed()
  }

  /**
   * Hands what is queued to the speech engine, a reply still being written last, and then listens once it has been
   * said. The whole of it is one reply the person can talk over.
   */
  private _feed() {
    if (this._ended || !this._queue.length) return
    this._reply ??= new AbortController()
    const reply = this._reply
    for (let head = this._queue[0]; head; head = this._queue[0]) {
      const pieces = head.pieces.splice(0)
      pieces.forEach((piece, i) => {
        const last = head.done && i === pieces.length - 1
        void this._say(piece, reply.signal, head.from, last ? head.said : undefined)
      })
      if (!head.done) return
      this._queue.shift()
    }
    const speech = this._speech
    void speech.then(() => {
      if (this._speech !== speech || this._reply !== reply || this._queue.length) return
      this._reply = undefined
      if (!reply.signal.aborted) this._state('listening')
    })
  }

  /** Runs the call agent on what it has been told so far, after any reply already under way stops. */
  private async _respond(): Promise<void> {
    this._reply?.abort()
    const reply = new AbortController()
    this._reply = reply
    const before = this._replying
    const run = (async () => {
      await before?.catch(() => {})
      if (reply.signal.aborted || this._ended) return
      try {
        await this._run(reply.signal)
      } catch (err) {
        if (!reply.signal.aborted)
          this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
      // The reply lasts until its last sentence is out, so talking over any of it interrupts.
      await this._speech
      if (this._reply === reply) this._reply = undefined
      if (reply.signal.aborted || this._ended) return
      if (this._hangUpAfterSpeech) {
        // Let the goodbye finish playing first.
        await Bun.sleep(Math.max(0, this._playingUntil - Date.now()))
        return this.hangUp('agent')
      }
      this._state('listening')
      if (this._updates.length && !this._detector.speaking) this._tellUpdates()
    })()
    this._replying = run
    return run
  }

  private async _run(signal: AbortSignal) {
    this._state('thinking')
    const resolved = this.ports.resolver.resolve(this.options.model)
    const apiKey = await this.ports.resolver.requireApiKey(resolved.model)
    for (let step = 0; step < VOICE_STEPS; step++) {
      const context = {
        systemPrompt: [
          prompts.voice.system({
            name: this.options.name,
            running: this._sent.filter((t) => !t.done && !t.question).map((t) => t.request),
            crew: this.options.crew ?? [],
            now: callTime(),
          }),
        ],
        messages: this._messages,
        tools: VOICE_TOOLS,
      }
      const stream: AssistantMessageEventStream = resolved.streamFn
        ? await resolved.streamFn(resolved.model, hideInContext(context), { apiKey, signal })
        : streamSimple(resolved.model, hideInContext(context), { apiKey, signal })
      // Spoken as it is written: each sentence once it ends, the first clause sooner.
      const split = new SpeechSplitter({ firstClause: true })
      let written = ''
      let spoken = ''
      for await (const event of stream) {
        if (signal.aborted) break
        if (event.type !== 'text_delta') continue
        written += event.delta
        this._thought()
        for (const s of split.push(written, false)) {
          spoken += `${s} `
          void this._say(s, signal, this._voice)
        }
      }
      const message = await stream.result().catch(() => undefined)
      if (signal.aborted) {
        // What the person heard before cutting in stays in the history; the rest was never said.
        if (message && spoken.trim())
          this._messages.push({ ...message, content: [{ type: 'text', text: `${spoken.trim()} …` }] })
        return
      }
      if (!signal.aborted) for (const s of split.push(written, true)) void this._say(s, signal, this._voice)
      if (!message) return
      if (message.stopReason === 'error') throw new Error(message.errorMessage ?? 'the call model failed')
      this._messages.push(message)
      const calls = message.content.filter((c): c is ToolCall => c.type === 'toolCall')
      if (calls.length === 0) return
      for (const call of calls) {
        const text = await this._tool(call)
        this._messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text }],
          isError: false,
          timestamp: Date.now(),
        })
      }
      if (this._hangUpAfterSpeech) return
    }
  }

  protected async _tool(call: ToolCall): Promise<string> {
    const r = prompts.voice.results
    const args = call.arguments as Record<string, unknown>
    if (call.name === 'start_task') {
      const request = String(args.request ?? '').trim()
      if (!request) return 'request is required'
      const sent = await this._send(request)
      this._track(sent, request)
      return r.started
    }
    if (call.name === 'ask_crew') {
      const question = String(args.question ?? '').trim()
      if (!question) return 'question is required'
      const to =
        typeof args.to === 'string' && args.to.trim() && args.to !== 'lead' ? args.to.trim() : undefined
      if (to && !(this.options.crew ?? []).some((c) => c.name === to)) return r.noSuchAgent(to)
      const sent = await this._send(to ? `@${to} ${question}` : question)
      this._track(sent, question, { question: true, ...(to ? { to } : {}) })
      return r.asked(to ?? 'the lead')
    }
    if (call.name === 'task_status') {
      const lines = this._sent
        .filter((t) => !t.question)
        .map((t) => (t.done ? `Finished: ${t.request}` : `Working on: ${t.request}`))
      return lines.length ? lines.join('\n') : r.idle
    }
    if (call.name === 'crew_updates') return this._takeUpdates() || r.noUpdates
    if (call.name === 'answer_approval') {
      const id = String(args.id ?? '')
      if (id !== this._asking?.id) return r.noApproval(id)
      const approved = args.approve === true
      await this._turnHeard()
      // Only the person decides: their latest turn, begun after the assistant was told of it, must have been that
      // plain yes or no, whatever else was said.
      if (this._answers(id) !== approved) return r.notAnswered
      this._answer = undefined
      const line = await this._decide(id, approved)
      this._askNext()
      return r.decided(line)
    }
    if (call.name === 'end_call') {
      this._hangUpAfterSpeech = true
      return r.ending
    }
    return `no tool called ${call.name}`
  }

  /**
   * Queues a sentence to be spoken after the ones before it; `said` hears when it will have finished playing. An engine
   * that streams plays each piece as it comes. When a cloud engine fails before any of the sentence was heard, the
   * call says so and goes on with the one on this machine (when it is here), this sentence included.
   */
  private _say(
    text: string,
    signal: AbortSignal,
    from: string,
    said?: (until: number) => void,
  ): Promise<void> {
    this._speech = this._speech.then(async () => {
      if (signal.aborted || this._ended) return
      const tts = this._tts
      let played = false
      try {
        played = await this._voiceWith(tts, text, signal, from)
      } catch (err) {
        if (signal.aborted) return
        const backup = this.ports.fallback?.tts
        if (!backup || backup === tts || played || this._ended) {
          this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
          return
        }
        if (this._tts === tts) {
          this._tts = backup
          this._fellBack('tts', err)
          await this._voiceWith(backup, prompts.voice.fallback.said('tts'), signal, this._voice).catch(
            () => false,
          )
        }
        try {
          await this._voiceWith(backup, text, signal, from)
        } catch (again) {
          if (!signal.aborted)
            this.emit({ type: 'error', message: again instanceof Error ? again.message : String(again) })
          return
        }
      }
      said?.(this._playingUntil)
    })
    return this._speech
  }

  /** Speaks one sentence with `tts`, a piece at a time when it streams; whether any of it went out. */
  private async _voiceWith(
    tts: TextToSpeech,
    text: string,
    signal: AbortSignal,
    from: string,
  ): Promise<boolean> {
    if (!tts.stream) {
      const speech = await tts.speak(text, signal)
      if (signal.aborted || this._ended) return false
      this._play(trimSilence(speech.pcm, speech.sampleRate), speech.sampleRate, text, from)
      return true
    }
    let first = true
    for await (const piece of tts.stream(text, signal)) {
      if (signal.aborted || this._ended) return !first
      // The quiet a voice starts with is cut; the rest of the sentence is played as it comes.
      const pcm = first ? trimStart(piece.pcm, piece.sampleRate) : piece.pcm
      if (!pcm.length) continue
      this._play(pcm, piece.sampleRate, first ? text : undefined, from)
      first = false
    }
    return !first
  }

  /** Sends audio to the person's side; `text` once per sentence, with its first piece, for the transcript. */
  protected _play(pcm: Int16Array, sampleRate: number, text: string | undefined, from: string) {
    // Said once, not for every piece of a sentence that streams in.
    if (this._current !== 'speaking') this._state('speaking')
    this.emit({ type: 'audio', pcm, sampleRate })
    this._voiced()
    if (text !== undefined) {
      this.emit({ type: 'said', text, from })
      this._note('voice', text)
    }
    const ms = (pcm.length / sampleRate) * 1000
    this._playingUntil = Math.max(Date.now(), this._playingUntil) + ms
  }

  /** The crew updates waiting, as the call assistant reads them; the transcript notes each for the person. */
  protected _takeUpdates(): string {
    const updates = this._updates.splice(0)
    for (const u of updates) this._note('crew', u.note)
    // The assistant now knows of the approval: a turn begun before this cannot answer it.
    if (this._asking && updates.some((u) => u.approval === this._asking?.id)) this._asking.heard = this._begun
    return updates.map((u) => u.text).join('\n\n')
  }

  /**
   * Crew updates reach the call assistant as the result of a crew_updates call it did not make, never as a turn of
   * the person's: the crew's text (an approval's summary, an agent's answer) may carry instructions, and the person's
   * turns are what the assistant acts on. Spoken at the next pause.
   */
  protected _tellUpdates() {
    const call: ToolCall = {
      type: 'toolCall',
      id: `crew_${randomBytes(6).toString('hex')}`,
      name: 'crew_updates',
      arguments: {},
    }
    const last = this._messages.at(-1)
    // Added to the assistant's last message when it has the last word, so two of its messages never follow each other.
    if (last?.role === 'assistant')
      this._messages[this._messages.length - 1] = { ...last, content: [...last.content, call] }
    else this._messages.push(this._asked(call))
    this._messages.push({
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: this._takeUpdates() }],
      isError: false,
      timestamp: Date.now(),
    })
    void this._respond()
  }

  /** A message of the call assistant's making the call `call` (it was cut off before it had the last word). */
  private _asked(call: ToolCall): AssistantMessage {
    const { model } = this.ports.resolver.resolve(this.options.model)
    return {
      role: 'assistant',
      content: [call],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: Date.now(),
    }
  }

  private _onEvents(colonyId: string, events: readonly MyrEvent[]) {
    const mine = this._sent.filter((t) => t.colonyId === colonyId)
    if (!mine.length || this._ended) return
    if (this.direct) return this._directEvents(colonyId, events)
    const u = prompts.voice.updates
    const n = prompts.voice.notes
    for (const e of events) {
      const p = e.payload as Record<string, unknown>
      if (e.type === 'chat/reply' && typeof p.text === 'string') {
        const from = String(p.agent ?? '')
        // A question the call put is answered by the first reply from whoever it went to (the lead: anyone).
        const asked = mine.find((t) => t.question && !t.done && (!t.to || t.to === from))
        if (asked) {
          asked.done = true
          const answer = p.text.slice(0, VOICE_ANSWER_CHARS)
          this._updates.push({ text: u.answer(from, answer), note: n.answer(from, answer) })
        } else if (p.question === true)
          this._updates.push({ text: u.question(p.text), note: n.question(p.text) })
        else for (const t of mine) if (!t.question && !t.done) t.answer = p.text
      } else if (e.type === 'approval/requested' && typeof p.id === 'string') {
        if (this.options.member)
          this._updates.push({
            text: u.ownerApproval(String(p.tool ?? ''), String(p.summary ?? '')),
            note: n.approval(String(p.summary ?? '')),
          })
        else this._requested(colonyId, p)
      } else if (e.type === 'approval/decided' && typeof p.id === 'string') {
        if (this._approvals.delete(p.id)) {
          this._settled(p.id, p.approved === true)
          this._askNext()
        }
      } else if (e.type === 'colony/completed' || e.type === 'colony/failed') {
        for (const t of mine) {
          if (t.done || t.question) continue
          t.done = true
          const reason = String(p.reason ?? '')
          this._updates.push(
            e.type === 'colony/completed'
              ? {
                  text: u.done(t.request, (t.answer ?? '').slice(0, VOICE_ANSWER_CHARS)),
                  note: n.done(t.request),
                }
              : { text: u.failed(t.request, reason), note: n.failed(t.request, reason) },
          )
        }
      }
    }
    // Spoken now when the call is quiet; otherwise at the end of the current reply or the person's turn.
    if (this._updates.length && !this._reply && !this._detector.speaking) this._tellUpdates()
  }

  /**
   * On a direct call, a reply is spoken while the lead (or the agent) is still writing it. Only a reply tool's text:
   * the model's own text may be narration before a tool call ("Let me look…"), so a plain answer is spoken when it
   * arrives finished, as chat/reply. A reply cut off is not marked spoken, so the next chat/reply is read.
   */
  private _onStream(colonyId: string, agent: string, text: string, done: boolean, plain: boolean) {
    if (this._ended || !this._sent.some((t) => t.colonyId === colonyId)) return
    if (this.direct !== 'lead' && agent !== this.direct) return
    const key = `${colonyId}:${agent}`
    let stream = this._streams.get(key)
    if (plain) {
      // A reply cut off (its reply tool call aborted) ends with none in it: what was said stands, and the stream
      // must end, or it would hold back everything queued after it for the rest of the call.
      if (!stream || !done) return
      stream.done = true
      this._streams.delete(key)
      this._feed()
      return
    }
    if (!stream) {
      stream = {
        from: agent,
        pieces: [],
        done: false,
        split: new SpeechSplitter({ firstClause: true, limit: VOICE_SPOKEN_SENTENCES }),
      }
      this._streams.set(key, stream)
      // After whatever is already being said: two replies at once are read one after the other.
      this._queue.push(stream)
    }
    this._thought()
    stream.pieces.push(...stream.split.push(text, done))
    if (done) {
      stream.done = true
      this._streams.delete(key)
      this._streamed.add(agent)
    }
    this._feed()
  }

  /** The first words of the answer are written. */
  protected _thought() {
    if (this._clock && !this._clock.thought) this._clock.thought = Date.now()
  }

  /** The answer's first sound went out: how long the person waited, and where it went. */
  protected _voiced() {
    const c = this._clock
    if (!c) return
    this._clock = undefined
    const now = Date.now()
    const thought = c.thought ?? now
    this.emit({
      type: 'latency',
      ms: now - c.stopped,
      heard: c.heard - c.stopped,
      thought: thought - c.heard,
      voiced: now - thought,
    })
  }

  /** An approval the crew asks for, to be put to the person in its turn. */
  private _requested(colonyId: string, p: Record<string, unknown>) {
    this._approvals.set(String(p.id), {
      colonyId,
      tool: String(p.tool ?? ''),
      summary: String(p.summary ?? ''),
    })
    this._askNext()
  }

  /** On a direct call, the replies of whoever the person talks to are read aloud, and approvals put to them. */
  private _directEvents(colonyId: string, events: readonly MyrEvent[]) {
    for (const e of events) {
      const p = e.payload as Record<string, unknown>
      if (e.type === 'chat/reply' && typeof p.text === 'string') {
        const agent = String(p.agent ?? '')
        if (this.direct !== 'lead' && agent !== this.direct) continue
        // Already spoken as it was written.
        if (this._streamed.delete(agent)) continue
        this._thought()
        this._speak(p.text, agent)
      } else if (e.type === 'approval/requested' && typeof p.id === 'string') {
        if (this.options.member)
          this._speak(prompts.voice.direct.ownerApproval(String(p.summary ?? '')), this._voice)
        else this._requested(colonyId, p)
      } else if (e.type === 'approval/decided' && typeof p.id === 'string') {
        if (this._approvals.delete(p.id)) {
          this._settled(p.id, p.approved === true)
          this._askNext()
        }
      } else if (e.type === 'colony/failed') {
        this._speak(prompts.voice.direct.failed(String(p.reason ?? '')), this._voice)
      }
    }
  }
}

/** Complete sentences so far, and what is left of the one still being written. */
export function splitSentences(text: string): { sentences: string[]; rest: string } {
  const parts = text.split(/(?<=[.!?…])\s+|\n+/)
  const rest = parts.pop() ?? ''
  return { sentences: parts.map((s) => s.trim()).filter(Boolean), rest }
}
