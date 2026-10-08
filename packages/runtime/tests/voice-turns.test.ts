import { expect, test } from 'bun:test'
import { rms, TurnDetector, type TurnEvent } from '../src/voice/turns.ts'

const RATE = 16_000
/** 20 ms frames of a tone at `level` (int16 amplitude) or silence. */
const frames = (ms: number, level = 0) =>
  Array.from({ length: ms / 20 }, () =>
    Int16Array.from({ length: RATE / 50 }, (_, i) => Math.round(level * Math.sin(i / 3))),
  )
/** Frames scored by level, as the call does when no speech detector is loaded. */
const feed = (d: TurnDetector, list: Int16Array[]) => list.flatMap((f) => d.push(f, rms(f) >= 400 ? 1 : 0))

test('a turn starts once speech holds and ends after a pause; the audio keeps what came just before', () => {
  const d = new TurnDetector({ sampleRate: RATE, start: 0.5 })
  expect(feed(d, frames(500))).toEqual([])
  // A click shorter than the start time is not speech.
  expect(feed(d, [...frames(100, 3000), ...frames(400)])).toEqual([])
  const started = feed(d, frames(400, 3000))
  expect(started).toEqual([{ type: 'start' }])
  // A short pause inside a sentence does not end the turn.
  expect(feed(d, [...frames(300), ...frames(300, 3000)])).toEqual([])
  const ended = feed(d, frames(1000)) as Extract<TurnEvent, { type: 'end' }>[]
  expect(ended.map((e) => e.type)).toEqual(['end'])
  const seconds = (ended[0]?.audio.length ?? 0) / RATE
  // Pre-roll (0.3 s) + speech and the short pause (1 s) + the silence that ended it (0.8 s).
  expect(seconds).toBeGreaterThan(1.9)
  expect(seconds).toBeLessThan(2.3)
})

test('a turn that runs past the longest allowed is cut there, and speech going on starts the next', () => {
  const d = new TurnDetector({ sampleRate: RATE, start: 0.5, maxTurnMs: 2000 })
  const events = feed(d, frames(3000, 3000))
  expect(events.map((e) => e.type)).toEqual(['start', 'end', 'start'])
})

test('reset drops a turn in progress (the call was muted)', () => {
  const d = new TurnDetector({ sampleRate: RATE, start: 0.5 })
  expect(feed(d, frames(400, 3000))).toEqual([{ type: 'start' }])
  d.reset()
  expect(feed(d, frames(1000))).toEqual([])
})

test("a turn holds through a dip in the detector's certainty that would not have started one", () => {
  const d = new TurnDetector({ sampleRate: RATE, start: 0.5, hold: 0.35 })
  const frame = new Int16Array(320)
  const run = (ms: number, chance: number) =>
    Array.from({ length: ms / 20 }).flatMap(() => d.push(frame, chance))
  expect(run(400, 0.9)).toEqual([{ type: 'start' }])
  // 0.4 is below the start but above the hold: still speaking, for longer than a turn's pause.
  expect(run(1200, 0.4)).toEqual([])
  expect(run(1000, 0.1).map((e) => e.type)).toEqual(['end'])
})
