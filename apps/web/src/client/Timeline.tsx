import type { MyrEvent } from '@myrmidon/protocol'
import { useEffect, useState } from 'react'
import { describeEvent } from './describe.ts'

const SPEEDS = [1, 4, 16, 64]

export function Timeline(props: {
  events: readonly MyrEvent[]
  cursor: number
  head: number
  live: boolean
  setCursor(seq: number): void
  setLive(live: boolean): void
}) {
  const { events, cursor, head, live, setCursor, setLive } = props
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(4)

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      if (cursor >= head) {
        setPlaying(false)
        return
      }
      setCursor(Math.min(head, cursor + 1))
    }, 1000 / speed)
    return () => clearInterval(t)
  }, [playing, speed, cursor, head, setCursor])

  const current = events[cursor - 1]
  return (
    <div className="timeline">
      <div className="timeline-controls">
        <button
          type="button"
          onClick={() => setCursor(Math.max(1, cursor - 1))}
          title="Step back"
          aria-label="Step back"
        >
          ◀
        </button>
        <button
          type="button"
          onClick={() => setPlaying(!playing)}
          disabled={cursor >= head}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          onClick={() => setCursor(Math.min(head, cursor + 1))}
          title="Step forward"
          aria-label="Step forward"
        >
          ▶|
        </button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Replay speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s} ev/s
            </option>
          ))}
        </select>
        <button type="button" className={live ? 'live on' : 'live'} onClick={() => setLive(!live)}>
          ● LIVE
        </button>
      </div>
      <input
        className="scrubber"
        type="range"
        min={0}
        max={Math.max(1, head)}
        value={cursor}
        onChange={(e) => setCursor(Number(e.target.value))}
        aria-label="Replay position"
      />
      <div className="timeline-now">
        <span className="seq">
          #{cursor}/{head}
        </span>
        <span className="mono">
          {current ? `${current.time.slice(11, 19)} ${describeEvent(current)}` : '—'}
        </span>
      </div>
    </div>
  )
}
