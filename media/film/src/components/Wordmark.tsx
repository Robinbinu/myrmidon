import { type CSSProperties, useId } from 'react'
import { C } from '../theme.ts'
import { dotLayout } from './Led.tsx'

const WORD = 'Myrmidon'
/** Unlit cells around the letters, so the word sits on a patch of the mascot's screen. */
const PAD_X = 2
const PAD_Y = 2

const layout = dotLayout(WORD)
/** The wordmark's grid in cells: the letters plus the unlit margin. */
export const WORDMARK_COLS = layout.width + PAD_X * 2
export const WORDMARK_ROWS = 7 + PAD_Y * 2

/**
 * Centres of the wordmark's lit dots, relative to the wordmark's centre, at a given pitch. Particles that fly into the
 * wordmark aim here.
 */
export function wordmarkDots(pitch: number): [number, number][] {
  return layout.dots.map(([x, y]) => [
    (x + PAD_X + 0.5 - WORDMARK_COLS / 2) * pitch,
    (y + PAD_Y + 0.5 - WORDMARK_ROWS / 2) * pitch,
  ])
}

/**
 * MYRMIDON in the app's dot-matrix lettering: lit amber dots on a faint grid of unlit ones, with a soft bloom, as on
 * the banner. Drawn centred on its box. `lit` (0..1 per lit dot, by index) lets dots arrive one by one; `grid` fades
 * the unlit cells.
 */
export function Wordmark(props: {
  pitch: number
  lit?: (i: number) => number
  grid?: number
  glow?: number
  /** A band of light passing across the lit dots, at this fraction of the width (outside 0..1 it is off screen). */
  sweep?: number
  style?: CSSProperties
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const p = props.pitch
  const d = p * 0.72
  const r = d * 0.28
  const w = WORDMARK_COLS * p
  const h = WORDMARK_ROWS * p
  const grid = props.grid ?? 1
  const unlit = []
  if (grid > 0)
    for (let y = 0; y < WORDMARK_ROWS; y++)
      for (let x = 0; x < WORDMARK_COLS; x++)
        unlit.push(<rect key={`${x},${y}`} x={x * p + (p - d) / 2} y={y * p + (p - d) / 2} width={d} height={d} rx={r} />)
  const on = layout.dots.map(([x, y], i) => {
    const t = props.lit ? props.lit(i) : 1
    return { key: `${x},${y}`, x: (x + PAD_X) * p + (p - d) / 2, y: (y + PAD_Y) * p + (p - d) / 2, t }
  })
  return (
    <svg
      role="img"
      aria-label="Myrmidon"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      overflow="visible"
      style={{ display: 'block', ...props.style }}
    >
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2={h} gradientUnits="userSpaceOnUse">
          <stop offset="0.2" stopColor={C.eyeTop} />
          <stop offset="0.8" stopColor={C.eyeBottom} />
        </linearGradient>
        <filter id={`b${id}`} x="-20%" y="-60%" width="140%" height="220%">
          <feGaussianBlur stdDeviation={p * 0.7} />
        </filter>
      </defs>
      <g fill="#ffffff" opacity={0.06 * grid}>
        {unlit}
      </g>
      <g fill={C.glow} opacity={0.7 * (props.glow ?? 1)} filter={`url(#b${id})`}>
        {on.map((o) => (
          <rect key={o.key} x={o.x} y={o.y} width={d} height={d} rx={r} opacity={o.t} />
        ))}
      </g>
      <g fill={`url(#g${id})`}>
        {on.map((o) => (
          <rect key={o.key} x={o.x} y={o.y} width={d} height={d} rx={r} opacity={o.t} />
        ))}
      </g>
      {props.sweep !== undefined && props.sweep > -0.2 && props.sweep < 1.2 && (
        <g fill={C.eyeLight}>
          {on.map((o) => {
            const band = Math.exp(-(((o.x / w - (props.sweep ?? 0)) / 0.06) ** 2))
            return band > 0.02 ? <rect key={o.key} x={o.x} y={o.y} width={d} height={d} rx={r} opacity={o.t * band * 0.85} /> : null
          })}
        </g>
      )}
    </svg>
  )
}
