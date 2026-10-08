import { VOICE_END_MS, VOICE_MAX_TURN_MS, VOICE_PRE_ROLL_MS, VOICE_START_MS } from '../config.ts'

export type TurnEvent = { type: 'start' } | { type: 'end'; audio: Int16Array }

export interface TurnOptions {
  readonly sampleRate: number
  /** How sure (0–1) the speech detector must be that a frame is speech for it to start a turn. */
  readonly start: number
  /** Once a turn has started, how sure it must stay to count as still speaking (lower, so a turn does not flicker). */
  readonly hold?: number
  readonly startMs?: number
  readonly endMs?: number
  readonly maxTurnMs?: number
  readonly preRollMs?: number
}

/**
 * Finds where a person's turns start and end in a stream of 16-bit mono frames, from how likely each frame is speech
 * (a speech detector's verdict, or 1/0 by level): enough speech starts a turn, a long enough pause ends it. A pause
 * within the start window resets it, so a click or a cough is not a turn.
 */
export class TurnDetector {
  private readonly _start: number
  private readonly _end: number
  private readonly _max: number
  private readonly _preRoll: number
  /** Samples of loud audio seen while deciding whether a turn starts, and quiet seen since. */
  private _loud = 0
  private _quietInStart = 0
  private _speaking = false
  private _quiet = 0
  private _length = 0
  private _chunks: Int16Array[] = []
  private _recent: Int16Array[] = []

  constructor(private readonly options: TurnOptions) {
    const samples = (ms: number) => Math.round((ms / 1000) * options.sampleRate)
    this._start = samples(options.startMs ?? VOICE_START_MS)
    this._end = samples(options.endMs ?? VOICE_END_MS)
    this._max = samples(options.maxTurnMs ?? VOICE_MAX_TURN_MS)
    this._preRoll = samples(options.preRollMs ?? VOICE_PRE_ROLL_MS)
  }

  /** Whether a turn is in progress. */
  get speaking(): boolean {
    return this._speaking
  }

  /** A frame and how likely it is speech (0–1). */
  push(frame: Int16Array, chance: number): TurnEvent[] {
    const loud = chance >= (this._speaking ? (this.options.hold ?? this.options.start) : this.options.start)
    if (!this._speaking) {
      this._keepRecent(frame)
      if (loud) {
        this._loud += frame.length
        this._quietInStart = 0
      } else {
        this._quietInStart += frame.length
        if (this._quietInStart >= this._start) this._loud = 0
      }
      if (this._loud < this._start) return []
      this._speaking = true
      this._quiet = 0
      this._chunks = this._recent
      this._length = this._chunks.reduce((n, c) => n + c.length, 0)
      this._recent = []
      return [{ type: 'start' }]
    }
    this._chunks.push(frame)
    this._length += frame.length
    this._quiet = loud ? 0 : this._quiet + frame.length
    if (this._quiet < this._end && this._length < this._max) return []
    const audio = concat(this._chunks, this._length)
    this.reset()
    return [{ type: 'end', audio }]
  }

  /** Forgets any turn in progress. */
  reset() {
    this._speaking = false
    this._loud = 0
    this._quietInStart = 0
    this._quiet = 0
    this._length = 0
    this._chunks = []
    this._recent = []
  }

  /** Keeps the last pre-roll's worth of audio, plus whatever has been loud since the start window opened. */
  private _keepRecent(frame: Int16Array) {
    this._recent.push(frame)
    let kept = this._recent.reduce((n, c) => n + c.length, 0)
    while (this._recent.length > 1 && kept - (this._recent[0]?.length ?? 0) >= this._preRoll + this._loud) {
      kept -= this._recent[0]?.length ?? 0
      this._recent.shift()
    }
  }
}

export function rms(frame: Int16Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (const s of frame) sum += s * s
  return Math.sqrt(sum / frame.length)
}

function concat(chunks: readonly Int16Array[], length: number): Int16Array {
  const out = new Int16Array(length)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
