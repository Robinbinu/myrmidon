import { fitText } from '@remotion/layout-utils'
import type { CSSProperties, ReactNode } from 'react'
import { useCurrentFrame } from 'remotion'
import { EASES, sp, SPRING, tween } from '../anim.ts'
import { SAFE, TYPE, type TypeRole, WEIGHT } from '../design.ts'
import { C, MONO, W } from '../theme.ts'

/** The size a line of `role` type is set at: the scale's size, or smaller if that would not fit `width`. */
export function fitSize(text: string, role: TypeRole, width: number, weight?: number, mono?: boolean): number {
  const t = TYPE[role]
  const { fontSize } = fitText({
    text,
    withinWidth: width,
    fontFamily: mono ? MONO : t.fontFamily,
    fontWeight: weight ?? t.fontWeight,
    letterSpacing: t.letterSpacing,
    validateFontIsLoaded: true,
  })
  return Math.min(t.fontSize, Math.floor(fontSize))
}

/**
 * Text, set in one role of the type scale. `fit` is the width the line must stay inside: if the scale's size would
 * overflow it, the line is set smaller (measured with @remotion/layout-utils), never clipped. Every T is tagged for
 * scripts/check-overlaps.mjs; `deco` marks background texture the check leaves alone.
 */
export function T(props: {
  role: TypeRole
  children: ReactNode
  color?: string
  weight?: keyof typeof WEIGHT
  mono?: boolean
  fit?: number
  wrap?: boolean
  deco?: boolean
  style?: CSSProperties
}) {
  const t = TYPE[props.role]
  const fontFamily = props.mono ? MONO : t.fontFamily
  const fontWeight = props.weight ? WEIGHT[props.weight] : t.fontWeight
  const fontSize =
    props.fit && typeof props.children === 'string'
      ? fitSize(props.children, props.role, props.fit, fontWeight, props.mono)
      : t.fontSize
  return (
    <span
      data-t={props.deco ? undefined : ''}
      style={{
        display: 'inline-block',
        fontFamily,
        fontSize,
        fontWeight,
        letterSpacing: props.mono ? 0 : t.letterSpacing,
        lineHeight: t.lineHeight,
        color: props.color ?? C.label,
        whiteSpace: props.wrap ? 'normal' : 'nowrap',
        maxWidth: props.fit,
        ...props.style,
      }}
    >
      {props.children}
    </span>
  )
}

/** Words of `text`; a run wrapped in *asterisks* is set in amber. */
function words(text: string): { word: string; accent: boolean }[] {
  let accent = false
  return text.split(' ').map((raw) => {
    const opens = raw.startsWith('*')
    if (opens) accent = true
    const on = accent
    if (raw.endsWith('*')) accent = false
    return { word: raw.replaceAll('*', ''), accent: on }
  })
}

const CAPTION_WIDTH = W - SAFE.x * 2

/**
 * A line of the film, in screen space in the caption band at the top. Each word rises out of a soft blur, a beat after
 * the one before, and leaves upward the same way. The line is fitted to the title-safe width.
 */
export function Caption(props: { text: string; start: number; end: number; stagger?: number }) {
  const frame = useCurrentFrame()
  if (frame < props.start - 1 || frame > props.end + 40) return null
  const list = words(props.text)
  const plain = list.map((w) => w.word).join(' ')
  // Word gaps are flex gaps, a little wider than a space, so the line is fitted with some room to spare.
  const size = fitSize(plain, 'caption', CAPTION_WIDTH - 64)
  const stagger = props.stagger ?? 4
  return (
    <div
      data-caption=""
      style={{
        position: 'absolute',
        left: SAFE.x,
        right: SAFE.x,
        top: SAFE.top,
        height: SAFE.captionBottom - SAFE.top,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        columnGap: size * 0.26,
        ...TYPE.caption,
        fontSize: size,
        color: C.label,
        whiteSpace: 'nowrap',
      }}
    >
      {list.map((w, i) => {
        const inT = sp(frame, props.start + i * stagger, SPRING.snappy)
        const outT = tween(frame, props.end + i * 2, props.end + i * 2 + 16, 0, 1, EASES.in)
        const y = (1 - inT) * size * 0.5 - outT * size * 0.35
        const blur = (1 - Math.min(1, inT * 1.15)) * 12 + outT * 10
        return (
          <span
            key={`${w.word}-${i}`}
            data-t=""
            data-caption-word=""
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
