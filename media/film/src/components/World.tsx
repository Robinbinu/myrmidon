import { CameraMotionBlur } from '@remotion/motion-blur'
import type { ReactNode } from 'react'
import { AbsoluteFill, getInputProps } from 'remotion'
import { C, H, W } from '../theme.ts'

export interface CameraState {
  /** The world point at the centre of the frame. */
  x: number
  y: number
  /** Zoom: 1 shows the world at 1:1. */
  s: number
  /** Roll, and tilts toward or away from the lens, in degrees. */
  rz: number
  rx: number
  ry: number
}

/**
 * The virtual camera: everything inside is the world, and the camera's state decides which part of it fills the
 * frame. Every shot of the film is a move of this one camera, so cuts read as one continuous take.
 */
export function Camera(props: { cam: CameraState; children: ReactNode; opacity?: number; blur?: number }) {
  const { x, y, s, rz, rx, ry } = props.cam
  const blur = props.blur ?? 0
  return (
    <AbsoluteFill style={{ perspective: 2400, opacity: props.opacity ?? 1, filter: blur > 0.3 ? `blur(${blur}px)` : undefined }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: W,
          height: H,
          transformOrigin: `${x}px ${y}px`,
          transform: `translate(${W / 2 - x}px, ${H / 2 - y}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${s})`,
          transformStyle: 'preserve-3d',
        }}
      >
        {props.children}
      </div>
    </AbsoluteFill>
  )
}

/**
 * Motion blur for things in flight (@remotion/motion-blur draws them several times across the shutter). In the
 * overlap check's debug render they are drawn once, sharp, so their text is measured like everything else.
 */
export function MotionBlur(props: { samples: number; children: ReactNode }) {
  if (getInputProps().debug) return <AbsoluteFill>{props.children}</AbsoluteFill>
  return (
    <AbsoluteFill data-mb="">
      <CameraMotionBlur samples={props.samples} shutterAngle={180}>
        {props.children}
      </CameraMotionBlur>
    </AbsoluteFill>
  )
}

/**
 * The black the film plays on: a faint LED dot grid (the mascot's screen, blown up to the whole frame) that slides
 * against the camera for parallax, and a warm pool of amber light that follows the action and breathes.
 */
export function Backdrop(props: { cam: CameraState; glow: { x: number; y: number; strength: number; size: number } }) {
  const { cam, glow } = props
  const pitch = 30 * (0.75 + 0.25 * cam.s)
  return (
    <AbsoluteFill style={{ background: C.black, overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.07) 1.3px, transparent 1.6px)',
          backgroundSize: `${pitch}px ${pitch}px`,
          backgroundPosition: `${-cam.x * 0.22 * cam.s}px ${-cam.y * 0.22 * cam.s}px`,
          maskImage: 'radial-gradient(ellipse 80% 75% at 50% 50%, black 25%, transparent 100%)',
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(${glow.size}px ${glow.size * 0.62}px at ${glow.x}px ${glow.y}px, rgba(255,164,28,${0.15 * glow.strength}) 0%, rgba(255,164,28,${0.045 * glow.strength}) 42%, transparent 72%)`,
        }}
      />
    </AbsoluteFill>
  )
}

/**
 * The lens: a light vignette, and a very fine grain that also dithers the dark gradients so they never band. The grain
 * is fixed, not boiling, so it costs the encoder nothing.
 */
export function Lens() {
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <AbsoluteFill
        style={{ background: 'radial-gradient(ellipse 90% 90% at 50% 48%, transparent 58%, rgba(0,0,0,0.5) 100%)' }}
      />
      <svg width={W} height={H} style={{ position: 'absolute', inset: 0, opacity: 0.05, mixBlendMode: 'overlay' }}>
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width={W} height={H} filter="url(#grain)" />
      </svg>
    </AbsoluteFill>
  )
}
