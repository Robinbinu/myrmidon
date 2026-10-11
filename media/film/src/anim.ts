import { Easing, interpolate, type SpringConfig, spring } from 'remotion'
import { FPS } from './theme.ts'

/** The app's own easing curve (--ease in tokens.css). */
export const EASE = Easing.bezier(0.2, 0.8, 0.2, 1)
export const EASE_IN = Easing.bezier(0.55, 0, 0.75, 0.2)
export const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1)

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
