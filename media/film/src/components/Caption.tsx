import type { CSSProperties } from 'react'
import { useCurrentFrame } from 'remotion'
import { EASE_IN, SPRING, sp, tween } from '../anim.ts'
import { C, FONT } from '../theme.ts'

/** Words of `text`; a run wrapped in *asterisks* is set in amber (the asterisks may sit inside quotes). */
function words(text: string): { word: string; accent: boolean }[] {
  let accent = false
  return text.split(' ').map((raw) => {
    const open = raw.indexOf('*')
    const close = raw.lastIndexOf('*')
    const opens = open >= 0 && open <= 1 && !accent
    if (opens) accent = true
    const on = accent
    if (close >= 0 && (close > open || !opens)) accent = false
    return { word: raw.replaceAll('*', ''), accent: on }
  })
}

/**
 * Kinetic type: each word rises out of a soft blur on a spring, a beat after the one before, and leaves upward the
 * same way. Shown from `start` to `end` (frames, relative to the scene).
 */
export function Caption(props: {
  text: string
  start: number
  end: number
  size?: number
  weight?: number
  color?: string
  align?: 'center' | 'left'
  stagger?: number
  style?: CSSProperties
  /** Max width in px before the line wraps. */
  width?: number
}) {
  const frame = useCurrentFrame()
  if (frame < props.start - 1 || frame > props.end + 30) return null
  const size = props.size ?? 76
  const stagger = props.stagger ?? 4
  const list = words(props.text)
  return (
    <div
      style={{
        fontFamily: FONT,
        fontSize: size,
        fontWeight: props.weight ?? 620,
        letterSpacing: '-0.035em',
        lineHeight: 1.08,
        color: props.color ?? C.label,
        textAlign: props.align ?? 'center',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: props.align === 'left' ? 'flex-start' : 'center',
        columnGap: size * 0.26,
        maxWidth: props.width,
        ...props.style,
      }}
    >
      {list.map((w, i) => {
        const inT = sp(frame, props.start + i * stagger, SPRING.snappy)
        const outT = tween(frame, props.end + i * 1.5, props.end + i * 1.5 + 14, 0, 1, EASE_IN)
        const y = (1 - inT) * size * 0.55 - outT * size * 0.4
        const blur = (1 - Math.min(1, inT * 1.15)) * 12 + outT * 10
        return (
          <span
            key={`${w.word}-${i}`}
            style={{
              display: 'inline-block',
              opacity: Math.min(1, inT * 1.3) * (1 - outT),
              transform: `translateY(${y}px)`,
              filter: blur > 0.2 ? `blur(${blur}px)` : undefined,
              color: w.accent ? C.accent : undefined,
            }}
          >
            {w.word}
          </span>
        )
      })}
    </div>
  )
}
