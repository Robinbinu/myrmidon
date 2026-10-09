import type { ToolCall } from '@oh-my-pi/pi-ai'
import { VOICE_REALTIME_TRANSCRIPT_MS } from '../../config.ts'
import { prompts } from '../../prompts.ts'
import { Resampler } from '../audio.ts'
import { type CallOptions, type CallOutput, CallSession, callTime, VOICE_TOOLS } from '../call.ts'
import type { SpeechToText } from '../stt.ts'
import type { TextToSpeech } from '../tts.ts'
import type { RealtimeConnection, RealtimeEvent } from './connection.ts'

type Ports = ConstructorParameters<typeof CallSession>[0]

/** A realtime call hears and speaks through its model: the pipeline's engines are never asked. */
const UNUSED_STT: SpeechToText = {
  transcribe: () => Promise.reject(new Error('a realtime call has no speech to text')),
}
const UNUSED_TTS: TextToSpeech = {
  speak: () => Promise.reject(new Error('a realtime call has no text to speech')),
}

/**
 * A call with the call assistant on a realtime speech-to-speech model: the same tools, crew updates and approvals as
 * a pipeline call (CallSession's), with the model hearing the person, finding their turns and speaking itself. Crew
 * updates reach it only as crew_updates results, as in the pipeline: it is told, in Myrmidon's own words, that some
 * are waiting, and calls the tool. A yes or no to an approval counts once its transcript is in (it may come after the
 * model's call to answer_approval, which waits for it).
 */
export class RealtimeCallSession extends CallSession {
  private readonly _in: Resampler
  /** The provider's names for the person's turns, as this call numbers them. */
  private readonly _turnIds = new Map<string, number>()
  /** Turns whose words are in, and checks waiting on one. */
  private readonly _heardTurns = new Set<number>()
  private _waiting: (() => void)[] = []
  private _responding = false
  /** Tool calls whose results have not gone back yet: nothing else is put to the model meanwhile. */
  private _calling = 0
  /** The model was told updates are waiting, at the person's `n`th turn: told again only after another turn. */
  private _noticed?: number
  private _instructions = ''
  private readonly _rt: RealtimeConnection
  private readonly _speaker: { readonly voice: string; readonly speed?: number }

  constructor(
    ports: Omit<Ports, 'stt' | 'tts' | 'detector' | 'judge' | 'fallback'> & {
      readonly realtime: RealtimeConnection
      readonly voice: string
      readonly speed?: number
    },
    options: CallOptions,
    emit: (out: CallOutput) => void,
  ) {
    const { realtime, voice, speed, ...rest } = ports
    super({ ...rest, stt: UNUSED_STT, tts: UNUSED_TTS }, options, emit)
    this._rt = realtime
    this._speaker = { voice, ...(speed ? { speed } : {}) }
    this._in = new Resampler(options.sampleRate, realtime.inputRate)
  }

  private _system(): string {
    return prompts.voice.system({
      name: this.options.name,
      running: this._sent.filter((t) => !t.done && !t.question).map((t) => t.request),
      crew: this.options.crew ?? [],
      now: callTime(),
      realtime: true,
    })
  }

  override async start() {
    this.emit({
      type: 'hello',
      talk: this._voice,
      ...(this.chatId ? { chatId: this.chatId } : {}),
      ...(this.options.chatTitle ? { chatTitle: this.options.chatTitle } : {}),
    })
    this._instructions = this._system()
    try {
      await this._rt.connect(
        {
          instructions: this._instructions,
          tools: VOICE_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters as unknown as Record<string, unknown>,
          })),
          ...this._speaker,
        },
        (e) => this._event(e),
      )
    } catch (err) {
      if (this._ended) return
      this.emit({
        type: 'error',
        message: prompts.voice.realtime.failed(err instanceof Error ? err.message : String(err)),
      })
      return this.hangUp('error')
    }
    if (this._ended) return this._rt.close()
    this._state('listening')
    this._responding = true
    this._rt.notice(prompts.voice.realtime.greet(this.options.name))
  }

  override audio(frame: Int16Array) {
    if (this._ended || this._muted) return
    const pcm = this._in.push(frame)
    if (pcm.length) this._rt.audio(pcm)
  }

  override interrupt() {
    this._rt.interrupt()
    this._playingUntil = 0
    this.emit({ type: 'stop-audio' })
  }

  override hangUp(reason: 'hung-up' | 'agent' | 'error' = 'hung-up') {
    if (this._ended) return
    this._rt.close()
    for (const wake of this._waiting.splice(0)) wake()
    super.hangUp(reason)
  }

  private _event(e: RealtimeEvent) {
    if (this._ended) return
    switch (e.type) {
      case 'speech-started':
        this._begun += 1
        this._turnIds.set(e.turn, this._begun)
        this._clock = undefined
        return this._state('hearing')
      case 'speech-stopped':
        this._clock = { stopped: Date.now(), heard: Date.now() }
        return this._state('thinking')
      case 'heard': {
        let turn = this._turnIds.get(e.turn)
        if (turn === undefined) {
          this._begun += 1
          turn = this._begun
          this._turnIds.set(e.turn, turn)
        }
        if (!e.final) return this.emit({ type: 'partial', text: e.text })
        this._turnIds.delete(e.turn)
        if (e.text) this._personSaid(e.text, turn)
        this._heardTurns.add(turn)
        for (const wake of this._waiting.splice(0)) wake()
        return
      }
      case 'audio':
        return this._play(e.pcm, e.sampleRate, undefined, this._voice)
      case 'said':
        this.emit({ type: 'said', text: e.text, from: this._voice })
        return this._note('voice', e.text)
      case 'interrupted':
        this._playingUntil = 0
        return this.emit({ type: 'stop-audio' })
      case 'tool':
        this._responding = true
        return void this._call(e.id, e.name, e.args)
      case 'done':
        return void this._answered()
      case 'error':
        return this.emit({ type: 'error', message: e.message })
      case 'closed':
        this.emit({ type: 'error', message: prompts.voice.realtime.failed(e.reason) })
        return this.hangUp('error')
      case 'ready':
        return
    }
  }

  private async _call(id: string, name: string, args: Record<string, unknown>) {
    const call: ToolCall = { type: 'toolCall', id, name, arguments: args }
    let output: string
    this._calling += 1
    try {
      output = await this._tool(call)
    } catch (err) {
      output = `failed: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      this._calling -= 1
    }
    if (!this._ended) this._rt.toolResult(id, name, output)
  }

  /** The model's answer is over: hang up after a goodbye, keep its instructions current, tell it of crew news. */
  private async _answered() {
    this._responding = false
    if (this._hangUpAfterSpeech) {
      await Bun.sleep(Math.max(0, this._playingUntil - Date.now()))
      return this.hangUp('agent')
    }
    this._state('listening')
    const system = this._system()
    if (system !== this._instructions && this._rt.instructions) {
      this._instructions = system
      this._rt.instructions(system)
    }
    if (this._updates.length) this._tellUpdates()
  }

  protected override _tellUpdates() {
    if (this._ended || this._responding || this._calling || !this._updates.length) return
    if (this._noticed !== undefined && this._noticed >= this._begun) return
    this._noticed = this._begun
    this._responding = true
    this._rt.notice(prompts.voice.realtime.updates)
  }

  protected override _takeUpdates(): string {
    this._noticed = undefined
    return super._takeUpdates()
  }

  protected override async _turnHeard(): Promise<void> {
    const turn = this._begun
    if (!turn || this._heardTurns.has(turn)) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, VOICE_REALTIME_TRANSCRIPT_MS)
      function done() {
        clearTimeout(timer)
        resolve()
      }
      const check = () => {
        if (this._heardTurns.has(turn) || this._ended) done()
        else this._waiting.push(check)
      }
      this._waiting.push(check)
    })
  }
}
