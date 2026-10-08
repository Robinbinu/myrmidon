import { randomBytes } from 'node:crypto'
import type { MyrEvent } from '@myrmidon/protocol'
import {
  type AssistantMessageEventStream,
  type Message,
  streamSimple,
  type Tool,
  type ToolCall,
} from '@oh-my-pi/pi-ai'
import { VOICE_ANSWER_CHARS, VOICE_STEPS } from '../config.ts'
import type { ModelResolver } from '../models.ts'
import { prompts } from '../prompts.ts'
import { trimSilence } from './audio.ts'
import type { SpeechToText } from './stt.ts'
import type { TextToSpeech } from './tts.ts'
import { rms, TurnDetector } from './turns.ts'
import { type SpeechDetector, VAD_CHUNK } from './vad.ts'

/** What a call needs from the chats: the same port the channels use. */
export interface CallChats {
  send(
    text: string,
    chatId: string | undefined,
    options?: { project?: string },
  ): Promise<{ chatId: string; colonyId: string; started: boolean; round?: number }>
  onEvents(listener: (colonyId: string, events: readonly MyrEvent[]) => void): () => void
  decideApproval(colonyId: string, id: string, approved: boolean): Promise<void>
}

export interface CallOptions {
  /** The call model, `provider/model`. */
  readonly model: string
  /** The chat the call is in; a call from a new chat makes one with its first task. */
  readonly chatId?: string
  readonly chatTitle?: string
  readonly project?: string
  /** What to call the person. */
  readonly name: string
  /** How sure the speech detector must be to start a turn (see VOICE_VAD_START), and how much less to hold one. */
  readonly start: number
  readonly hold: number
  /** The speech level to fall back on without a detector (see VOICE_THRESHOLDS). */
  readonly threshold: number
  /** The sample rate of the audio the person's side sends. */
  readonly sampleRate: number
}

export interface CallTurn {
  readonly at: string
  readonly who: 'person' | 'voice' | 'crew'
  readonly text: string
}

/** What a call tells the person's side (the app, later a phone line). */
export type CallOutput =
  | { type: 'state'; state: 'preparing' | 'listening' | 'hearing' | 'thinking' | 'speaking' }
  | { type: 'heard'; text: string }
  | { type: 'said'; text: string }
  | { type: 'audio'; pcm: Int16Array; sampleRate: number }
  /** Stop playing what was sent: the person talked over it. */
  | { type: 'stop-audio' }
  | { type: 'chat'; chatId: string }
  | { type: 'task'; colonyId: string; request: string }
  | { type: 'error'; message: string }
  | { type: 'ended'; reason: 'hung-up' | 'agent' | 'error' }

interface Task {
  readonly request: string
  readonly round?: number
  answer?: string
  done?: boolean
}

const TOOLS: Tool[] = [
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
    name: 'task_status',
    description: prompts.voice.tools.taskStatus.description,
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
 * A voice call: the person's turns (found in their audio, then transcribed) go to the call agent, a fast model that
 * answers small things itself and hands real work to the crew as ordinary rounds in the chat (start_task). Its reply
 * is spoken a sentence at a time as it is written. While the crew works the call goes on; when a round finishes,
 * fails, asks a question or needs approval, the call agent is told and says so at the next pause. Talking over it
 * stops it at once (barge-in).
 */
export class CallSession {
  readonly id = randomBytes(6).toString('hex')
  readonly startedAt = new Date().toISOString()
  private _chatId?: string
  private readonly _messages: Message[] = []
  private readonly _turns: CallTurn[] = []
  private readonly _detector: TurnDetector
  private readonly _tasks = new Map<string, Task>()
  /** Approvals the crew is waiting on in this call's rounds: approval id → colony. */
  private readonly _approvals = new Map<string, string>()
  private readonly _updates: string[] = []
  private _reply?: AbortController
  private _replying?: Promise<void>
  private _speech: Promise<void> = Promise.resolve()
  /** When the audio sent so far finishes playing on the person's side. */
  private _playingUntil = 0
  private _muted = false
  private _ended = false
  private _vad?: { chance(chunk: Float32Array): Promise<number> }
  /** Audio not yet scored, and the scoring in progress (chunks are scored in order). */
  private _unscored = new Int16Array(0)
  private _scoring: Promise<void> = Promise.resolve()
  private _hangUpAfterSpeech = false
  private readonly _off: () => void

  constructor(
    private readonly ports: {
      readonly chats: CallChats
      readonly resolver: ModelResolver
      readonly stt: SpeechToText
      readonly tts: TextToSpeech
      /** Silero VAD; without it (or if it fails) turns are found by level. */
      readonly detector?: SpeechDetector
    },
    private readonly options: CallOptions,
    private readonly emit: (out: CallOutput) => void,
  ) {
    this._chatId = options.chatId
    this._detector = new TurnDetector({
      sampleRate: options.sampleRate,
      start: options.start,
      hold: options.hold,
    })
    // Silero's model here is for 16 kHz; other rates (a phone line's 8 kHz) are scored by level.
    if (ports.detector && options.sampleRate === 16_000) this._vad = ports.detector.stream()
    this._off = ports.chats.onEvents((colonyId, events) => this._onEvents(colonyId, events))
  }

  get chatId(): string | undefined {
    return this._chatId
  }

  transcript(): readonly CallTurn[] {
    return this._turns
  }

  /** The rounds this call started, in order. */
  rounds(): { colonyId: string; round?: number }[] {
    return [...this._tasks].map(([colonyId, t]) => ({ colonyId, ...(t.round ? { round: t.round } : {}) }))
  }

  /** Greets the person; the call is then listening. */
  async start() {
    await this._say(prompts.voice.hello(this.options.name), new AbortController().signal)
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
    for (const event of this._detector.push(chunk, chance)) {
      if (event.type === 'start') {
        if (this._reply || this._playingUntil > Date.now()) this.interrupt()
        this._state('hearing')
      } else void this._heard(event.audio)
    }
  }

  /** The person talked over the call agent (found here or by their side): stop speaking and listen. */
  interrupt() {
    this._reply?.abort()
    this._reply = undefined
    this._playingUntil = 0
    this.emit({ type: 'stop-audio' })
  }

  mute(muted: boolean) {
    this._muted = muted
    if (muted) {
      this._detector.reset()
      this._unscored = new Int16Array(0)
    }
  }

  hangUp(reason: 'hung-up' | 'agent' | 'error' = 'hung-up') {
    if (this._ended) return
    this._ended = true
    this._reply?.abort()
    this._off()
    this.emit({ type: 'ended', reason })
  }

  private _state(state: 'listening' | 'hearing' | 'thinking' | 'speaking') {
    if (!this._ended) this.emit({ type: 'state', state })
  }

  private _note(who: CallTurn['who'], text: string) {
    this._turns.push({ at: new Date().toISOString(), who, text })
  }

  private async _heard(audio: Int16Array) {
    let text: string
    try {
      text = await this.ports.stt.transcribe(audio, this.options.sampleRate)
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      this._state('listening')
      return
    }
    if (this._ended) return
    if (!text) {
      this._state('listening')
      return
    }
    this._note('person', text)
    this.emit({ type: 'heard', text })
    this._messages.push({ role: 'user', content: text, timestamp: Date.now() })
    void this._respond()
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
            ...(this.options.chatTitle ? { chatTitle: this.options.chatTitle } : {}),
            running: [...this._tasks.values()].filter((t) => !t.done).map((t) => t.request),
          }),
        ],
        messages: this._messages,
        tools: TOOLS,
      }
      const stream: AssistantMessageEventStream = resolved.streamFn
        ? await resolved.streamFn(resolved.model, context, { apiKey, signal })
        : streamSimple(resolved.model, context, { apiKey, signal })
      let pending = ''
      let spoken = ''
      for await (const event of stream) {
        if (signal.aborted) break
        if (event.type !== 'text_delta') continue
        pending += event.delta
        const { sentences, rest } = splitSentences(pending)
        pending = rest
        for (const s of sentences) {
          spoken += `${s} `
          void this._say(s, signal)
        }
      }
      const message = await stream.result().catch(() => undefined)
      if (signal.aborted) {
        // What the person heard before cutting in stays in the history; the rest was never said.
        if (message && spoken.trim())
          this._messages.push({ ...message, content: [{ type: 'text', text: `${spoken.trim()} …` }] })
        return
      }
      if (pending.trim()) void this._say(pending.trim(), signal)
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

  private async _tool(call: ToolCall): Promise<string> {
    const r = prompts.voice.results
    const args = call.arguments as Record<string, unknown>
    if (call.name === 'start_task') {
      const request = String(args.request ?? '').trim()
      if (!request) return 'request is required'
      const sent = await this.ports.chats.send(request, this._chatId, {
        ...(this.options.project ? { project: this.options.project } : {}),
      })
      if (!this._chatId) {
        this._chatId = sent.chatId
        this.emit({ type: 'chat', chatId: sent.chatId })
      }
      this._tasks.set(sent.colonyId, { request, ...(sent.round ? { round: sent.round } : {}) })
      this.emit({ type: 'task', colonyId: sent.colonyId, request })
      return r.started
    }
    if (call.name === 'task_status') {
      const lines = [...this._tasks.values()].map((t) =>
        t.done ? `Finished: ${t.request}` : `Working on: ${t.request}`,
      )
      return lines.length ? lines.join('\n') : r.idle
    }
    if (call.name === 'answer_approval') {
      const id = String(args.id ?? '')
      const colonyId = this._approvals.get(id)
      if (!colonyId) return r.noApproval(id)
      const approved = args.approve === true
      await this.ports.chats.decideApproval(colonyId, id, approved)
      this._approvals.delete(id)
      return r.decided(approved)
    }
    if (call.name === 'end_call') {
      this._hangUpAfterSpeech = true
      return r.ending
    }
    return `no tool called ${call.name}`
  }

  /** Queues a sentence to be spoken after the ones before it. */
  private _say(text: string, signal: AbortSignal): Promise<void> {
    this._speech = this._speech.then(async () => {
      if (signal.aborted || this._ended) return
      try {
        const speech = await this.ports.tts.speak(text, signal)
        if (signal.aborted || this._ended) return
        const pcm = trimSilence(speech.pcm, speech.sampleRate)
        this._state('speaking')
        this.emit({ type: 'audio', pcm, sampleRate: speech.sampleRate })
        this.emit({ type: 'said', text })
        this._note('voice', text)
        const ms = (pcm.length / speech.sampleRate) * 1000
        this._playingUntil = Math.max(Date.now(), this._playingUntil) + ms
      } catch (err) {
        if (!signal.aborted)
          this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    })
    return this._speech
  }

  /** Crew updates go to the call agent as a turn of their own, spoken at the next pause. */
  private _tellUpdates() {
    const text = this._updates.splice(0).join('\n\n')
    this._note('crew', text)
    this._messages.push({ role: 'user', content: text, timestamp: Date.now() })
    void this._respond()
  }

  private _onEvents(colonyId: string, events: readonly MyrEvent[]) {
    const task = this._tasks.get(colonyId)
    if (!task || this._ended) return
    const u = prompts.voice.updates
    for (const e of events) {
      const p = e.payload as Record<string, unknown>
      if (e.type === 'chat/reply' && typeof p.text === 'string') {
        if (p.question === true) this._updates.push(u.question(p.text))
        else task.answer = p.text
      } else if (e.type === 'approval/requested' && typeof p.id === 'string') {
        this._approvals.set(p.id, colonyId)
        this._updates.push(u.approval(p.id, String(p.tool ?? ''), String(p.summary ?? '')))
      } else if (e.type === 'approval/decided' && typeof p.id === 'string') {
        this._approvals.delete(p.id)
      } else if (e.type === 'colony/completed' && !task.done) {
        task.done = true
        this._updates.push(u.done(task.request, (task.answer ?? '').slice(0, VOICE_ANSWER_CHARS)))
      } else if (e.type === 'colony/failed' && !task.done) {
        task.done = true
        this._updates.push(u.failed(task.request, String(p.reason ?? '')))
      }
    }
    // Spoken now when the call is quiet; otherwise at the end of the current reply or the person's turn.
    if (this._updates.length && !this._reply && !this._detector.speaking) this._tellUpdates()
  }
}

/** Complete sentences so far, and what is left of the one still being written. */
export function splitSentences(text: string): { sentences: string[]; rest: string } {
  const parts = text.split(/(?<=[.!?…])\s+|\n+/)
  const rest = parts.pop() ?? ''
  return { sentences: parts.map((s) => s.trim()).filter(Boolean), rest }
}
