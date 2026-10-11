import { useId } from 'react'
import { clamp, lerp, noise } from '../anim.ts'
import { SPACE } from '../design.ts'
import { C } from '../theme.ts'
import { T } from './Text.tsx'

const POINTS = 48
/** The hour the 21:40 deploy lands at, as an index into the series. */
export const DEPLOY_AT = 30
const FIX_AT = 41

/** Checkout conversion for the night, in %: steady, a cliff at the deploy, and (once fixed) the climb back. */
export function conversion(i: number, recovered: number): number {
  const base = 3.4 + noise(i * 0.7, 4) * 0.12
  const drop = i >= DEPLOY_AT ? clamp((i - DEPLOY_AT + 1) / 2, 0, 1) * 0.62 : 0
  const back = i >= FIX_AT ? clamp((i - FIX_AT + 1) / 3, 0, 1) * 0.62 * recovered : 0
  return base - drop + back
}

/**
 * The conversion chart: one object that runs through the film. It drops on Robin's phone, nova finds its cliff at the
 * deploy, and it climbs back on the call. `draw` reveals the line left to right; `recovered` lifts the tail back up.
 */
export function ConversionChart(props: {
  width: number
  height: number
  draw?: number
  recovered?: number
  marker?: number
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const w = props.width
  const h = props.height
  const recovered = props.recovered ?? 0
  const pad = 6
  const xs = (i: number) => pad + (i / (POINTS - 1)) * (w - pad * 2)
  const ys = (v: number) => lerp(h - pad, pad, (v - 2.5) / 1.2)
  const pts = Array.from({ length: POINTS }, (_, i) => [xs(i), ys(conversion(i, recovered))] as const)
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const draw = props.draw ?? 1
  const clipW = pad + draw * (w - pad * 2)
  const deployX = xs(DEPLOY_AT - 0.5)
  const marker = props.marker ?? 0
  const end = pts[Math.max(0, Math.round(draw * (POINTS - 1)))] ?? [0, 0]
  return (
    <div style={{ position: 'relative', width: w, height: h }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id={`a${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={C.accent} stopOpacity="0.28" />
            <stop offset="1" stopColor={C.accent} stopOpacity="0" />
          </linearGradient>
          <clipPath id={`c${id}`}>
            <rect x="0" y="-20" width={clipW} height={h + 40} />
          </clipPath>
        </defs>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={0} x2={w} y1={h * g} y2={h * g} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
        ))}
        <g clipPath={`url(#c${id})`}>
          <path d={`${line} L${xs(POINTS - 1)} ${h} L${xs(0)} ${h} Z`} fill={`url(#a${id})`} />
          <path d={line} fill="none" stroke={C.accent} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
        </g>
        {marker > 0 && (
          <line
            x1={deployX}
            x2={deployX}
            y1={lerp(h, 0, marker)}
            y2={h}
            stroke={C.bad}
            strokeWidth={2}
            strokeDasharray="6 6"
          />
        )}
        {draw > 0.02 && <circle cx={end[0]} cy={end[1]} r={6} fill={C.accent} stroke={C.black} strokeWidth={2} />}
      </svg>
      {marker > 0.6 && (
        <div style={{ position: 'absolute', left: deployX + SPACE[2], top: 0, opacity: (marker - 0.6) / 0.4 }}>
          <T role="label" mono color={C.bad}>
            21:40 deploy
          </T>
        </div>
      )}
    </div>
  )
}
