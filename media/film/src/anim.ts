import { Easing, interpolate, type SpringConfig, spring } from 'remotion'
import { FPS } from './theme.ts'

/** The app's own easing curve (--ease in tokens.css). */
export const EASE = Easing.bezier(0.2, 0.8, 0.2, 1)
export const EASE_IN = Easing.bezier(0.55, 0, 0.75, 0.2)
export const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1)

/** GSAP's ease vocabulary, as bezier curves: arrivals, camera moves, wind-ups. */
export const EASES = {
  /** power2.out: UI settling. */
  out: Easing.bezier(0.33, 1, 0.68, 1),
  /** expo.out: a fast arrival that glides to rest. */
  expoOut: Easing.bezier(0.16, 1, 0.3, 1),
  /** power3.inOut: the camera, and anything that travels across the frame. */
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
  /** power2.in: leaving. */
  in: Easing.bezier(0.32, 0, 0.67, 0),
  /** back.in: the wind-up before a throw. */
  backIn: Easing.bezier(0.36, 0, 0.66, -0.56),
  /** back.out: an arrival with a little overshoot. */
  backOut: Easing.bezier(0.34, 1.56, 0.64, 1),
} as const

/** Interpolates `frame` across [a, b] to [from, to], clamped, eased. */
export function tween(frame: number, a: number, b: number, from = 0, to = 1, easing = EASE): number {
  return interpolate(frame, [a, b], [from, to], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing,
  })
}

export const SPRING = {
  /** Settles with no overshoot: UI sliding into place. */
  smooth: { damping: 200, stiffness: 120, mass: 1 },
  /** A small overshoot: things popping in. */
  pop: { damping: 14, stiffness: 180, mass: 0.7 },
  /** Heavy and bouncy: objects landing with weight. */
  heavy: { damping: 11, stiffness: 120, mass: 1.25 },
  /** Quick and firm. */
  snappy: { damping: 22, stiffness: 260, mass: 0.6 },
} satisfies Record<string, Partial<SpringConfig>>

/** A spring from 0 to 1 starting at `delay` frames. */
export function sp(frame: number, delay = 0, config: Partial<SpringConfig> = SPRING.smooth): number {
  return spring({ frame: frame - delay, fps: FPS, config })
}

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** A deterministic pseudo-random number in [0, 1) for a seed. */
export function rand(seed: number): number {
  let t = (seed * 2654435761 + 0x6d2b79f5) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Smooth value noise in [-1, 1], for idle drift and waveforms. */
export function noise(x: number, seed = 0): number {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  const a = rand(i * 131 + seed * 7919) * 2 - 1
  const b = rand((i + 1) * 131 + seed * 7919) * 2 - 1
  return a + (b - a) * u
}

/** Point on a quadratic curve from p0 to p2 bowed through control c. */
export function quad(
  t: number,
  p0: readonly [number, number],
  c: readonly [number, number],
  p2: readonly [number, number],
): [number, number] {
  const u = 1 - t
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p2[1]]
}

/** Number of characters of `text` typed by `frame`, at `cps` characters per second from `start`. */
export function typed(text: string, frame: number, start: number, cps: number): string {
  const n = clamp(Math.floor(((frame - start) / FPS) * cps), 0, text.length)
  return text.slice(0, n)
}

/** One key of a multi-key track: a value at a frame, eased into from the key before. */
export interface Key {
  f: number
  v: number
  ease?: (t: number) => number
}

/** A value along keys, like a GSAP timeline of `to()` tweens: each segment eases with its destination key's ease. */
export function track(frame: number, keys: readonly Key[]): number {
  const first = keys[0]
  if (!first) throw new Error('track needs at least one key')
  if (frame <= first.f) return first.v
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1] as Key
    const b = keys[i] as Key
    if (frame <= b.f) return lerp(a.v, b.v, (b.ease ?? EASES.inOut)((frame - a.f) / Math.max(1, b.f - a.f)))
  }
  return (keys[keys.length - 1] as Key).v
}

/** 0 before `a`, 1 from `a + inF` to `b - outF`, 0 after `b`: a window's presence, eased at both edges. */
export function presence(frame: number, a: number, b: number, inF = 18, outF = 18): number {
  return Math.min(tween(frame, a, a + inF, 0, 1, EASES.out), 1 - tween(frame, b - outF, b, 0, 1, EASES.in))
}

/** A gentle idle wobble in px or degrees: the drift that keeps a held frame alive. */
export function drift(frame: number, seed: number, amp = 1, speed = 0.012): number {
  return noise(frame * speed, seed) * amp
}
