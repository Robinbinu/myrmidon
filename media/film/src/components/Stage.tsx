import type { CSSProperties, ReactNode } from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import { EASE_IN, tween } from '../anim.ts'
import { C } from '../theme.ts'

/**
 * The black stage every scene plays on: a faint LED dot grid drifting slowly (the mascot's screen, blown up to the
 * whole frame), a warm pool of amber light, and a vignette.
 */
export function Stage(props: {
  children?: ReactNode
  glow?: { x: number; y: number; strength?: number; size?: number }
  /** How far the dot grid has drifted, in px, for parallax against the foreground. */
  drift?: number
  grid?: number
}) {
  const frame = useCurrentFrame()
  const drift = props.drift ?? frame * 0.12
  const g = props.glow
  return (
    <AbsoluteFill style={{ background: C.black, overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.075) 1.4px, transparent 1.6px)',
          backgroundSize: '28px 28px',
          backgroundPosition: `${-drift * 0.6}px ${-drift}px`,
          opacity: props.grid ?? 1,
          maskImage: 'radial-gradient(ellipse 75% 70% at 50% 50%, black 30%, transparent 100%)',
        }}
      />
      {g && (
        <AbsoluteFill
          style={{
            background: `radial-gradient(${g.size ?? 900}px ${(g.size ?? 900) * 0.62}px at ${g.x}px ${g.y}px, rgba(255,164,28,${0.16 * (g.strength ?? 1)}) 0%, rgba(255,164,28,${0.05 * (g.strength ?? 1)}) 40%, transparent 72%)`,
          }}
        />
      )}
      {props.children}
      <AbsoluteFill
        style={{
          pointerEvents: 'none',
          background: 'radial-gradient(ellipse 85% 85% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)',
        }}
      />
    </AbsoluteFill>
  )
}

/**
 * A scene's frame: it fades and drifts in from a slight zoom, and out to a slight zoom the other way, so cuts between
 * scenes read as one continuous camera.
 */
export function Shot(props: { dur: number; children: ReactNode; inFrames?: number; outFrames?: number; style?: CSSProperties }) {
  const frame = useCurrentFrame()
  const inF = props.inFrames ?? 18
  const outF = props.outFrames ?? 18
  const fadeIn = inF === 0 ? 1 : tween(frame, 0, inF)
  const fadeOut = outF === 0 ? 1 : 1 - tween(frame, props.dur - outF, props.dur, 0, 1, EASE_IN)
  const scale = (inF === 0 ? 1 : 1.04 - 0.04 * fadeIn) * (outF === 0 ? 1 : 1 - 0.03 * (1 - fadeOut))
  const blur = (1 - fadeIn) * 10 + (1 - fadeOut) * 8
  return (
    <AbsoluteFill
      style={{
        opacity: Math.min(fadeIn, fadeOut),
        transform: `scale(${scale})`,
        filter: blur > 0.3 ? `blur(${blur}px)` : undefined,
        ...props.style,
      }}
    >
      {props.children}
    </AbsoluteFill>
  )
}
