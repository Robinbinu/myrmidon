/**
 * Craig Reynolds' steering behaviours ("Steering Behaviors For Autonomous Characters", GDC 1999), for small things
 * that move about the page by themselves, such as the crew cursors around the mascot. A body is a point with a
 * velocity; each behaviour returns a steering force, the caller adds them up with weights, and `integrate` moves the
 * body as Reynolds' simple vehicle does: the force truncated to a most, then the speed. Units are px and seconds.
 *
 * Bodies are changed in place by `integrate` and `fall`: they run every frame for a handful of cursors, and nothing
 * else holds on to them.
 */

export interface Vec {
  x: number
  y: number
}

export interface Body {
  x: number
  y: number
  vx: number
  vy: number
}

export interface Limits {
  maxSpeed: number
  maxForce: number
}

/** A rectangle by its centre and half sizes. */
export interface Box {
  x: number
  y: number
  hw: number
  hh: number
}

export interface Bounds {
  left: number
  right: number
  top: number
  bottom: number
}

export const ZERO: Readonly<Vec> = { x: 0, y: 0 }

export const length = (v: Vec) => Math.hypot(v.x, v.y)
export const add = (...vs: Vec[]): Vec =>
  vs.reduce((a, v) => ({ x: a.x + v.x, y: a.y + v.y }), { x: 0, y: 0 })
export const scale = (v: Vec, k: number): Vec => ({ x: v.x * k, y: v.y * k })
export const speedOf = (b: Body) => Math.hypot(b.vx, b.vy)

/** The same direction, at most `max` long. */
export function truncate(v: Vec, max: number): Vec {
  const n = length(v)
  return n > max && n > 0 ? scale(v, max / n) : v
}

/**
 * How hard seek, flee and arrival pull toward the velocity they want, per second. Reynolds applies "wanted minus
 * current velocity" once a frame; over a time step that is this gain, so the pull does not depend on the frame rate.
 */
export const STEER_GAIN = 8

/** Toward the wanted velocity (ux, uy at `speed`), as a force. */
const toward = (b: Body, ux: number, uy: number, speed: number, gain: number): Vec => ({
  x: (ux * speed - b.vx) * gain,
  y: (uy * speed - b.vy) * gain,
})

/** Seek: head straight for `target` at full speed. */
export function seek(b: Body, target: Vec, maxSpeed: number, gain = STEER_GAIN): Vec {
  const dx = target.x - b.x
  const dy = target.y - b.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-6) return toward(b, 0, 0, 0, gain)
  return toward(b, dx / d, dy / d, maxSpeed, gain)
}

/** Flee: head straight away from `from` at full speed. */
export function flee(b: Body, from: Vec, maxSpeed: number, gain = STEER_GAIN): Vec {
  const dx = b.x - from.x
  const dy = b.y - from.y
  const d = Math.hypot(dx, dy)
  // Standing right on it, any way out will do.
  return d < 1e-6 ? toward(b, 1, 0, maxSpeed, gain) : toward(b, dx / d, dy / d, maxSpeed, gain)
}

/** Arrival: seek, but within `slowRadius` the wanted speed falls with the distance left, so it stops on the spot. */
export function arrive(b: Body, target: Vec, maxSpeed: number, slowRadius: number, gain = STEER_GAIN): Vec {
  const dx = target.x - b.x
  const dy = target.y - b.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-6) return toward(b, 0, 0, 0, gain)
  return toward(b, dx / d, dy / d, maxSpeed * Math.min(1, d / slowRadius), gain)
}

export interface WanderState {
  /** Where on the wander circle the steering points, in radians. */
  angle: number
}

/**
 * Wander: a point on a circle `distance` ahead of the body is the way it steers; each step nudges that point by a
 * random amount (up to `jitter` radians a second), so the path meanders without twitching. Returns a unit-scaled
 * force for the caller to weight.
 */
export function wander(
  b: Body,
  state: WanderState,
  opts: { distance: number; radius: number; jitter: number },
  dt: number,
  random: () => number = Math.random,
): Vec {
  state.angle += (random() * 2 - 1) * opts.jitter * dt
  const speed = speedOf(b)
  const heading = speed > 1e-3 ? { x: b.vx / speed, y: b.vy / speed } : { x: 1, y: 0 }
  return {
    x: heading.x * opts.distance + Math.cos(state.angle) * opts.radius,
    y: heading.y * opts.distance + Math.sin(state.angle) * opts.radius,
  }
}

/**
 * Separation: away from every neighbour closer than `radius`, more strongly the closer it is (falling off to nothing
 * at the radius). Returns the sum of those unit pushes; the caller weights it.
 */
export function separation(b: Body, others: readonly Vec[], radius: number): Vec {
  let x = 0
  let y = 0
  for (const o of others) {
    const dx = b.x - o.x
    const dy = b.y - o.y
    const d = Math.hypot(dx, dy)
    if (d >= radius) continue
    // Two on the same spot still part, sideways.
    if (d < 1e-6) {
      x += 1
      continue
    }
    const k = 1 - d / radius
    x += (dx / d) * k
    y += (dy / d) * k
  }
  return { x, y }
}

/**
 * Obstacle avoidance for one box: if the body is inside the box grown by `margin`, or will be within `lookahead`
 * seconds at its speed, a unit push out of it along the axis it is least deep in; otherwise nothing.
 */
export function avoidBox(b: Body, box: Box, margin: number, lookahead: number): Vec {
  const hw = box.hw + margin
  const hh = box.hh + margin
  const inside = (p: Vec) => Math.abs(p.x - box.x) < hw && Math.abs(p.y - box.y) < hh
  const ahead = { x: b.x + b.vx * lookahead, y: b.y + b.vy * lookahead }
  const p = inside(b) ? b : inside(ahead) ? ahead : undefined
  if (!p) return { x: 0, y: 0 }
  const dx = p.x - box.x
  const dy = p.y - box.y
  const deepX = hw - Math.abs(dx)
  const deepY = hh - Math.abs(dy)
  return deepX < deepY ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) || 1 }
}

/** Containment: back inside `bounds`, harder the further past `margin` from an edge the body is. */
export function contain(b: Body, bounds: Bounds, margin: number): Vec {
  const push = (depth: number) => Math.max(0, depth) / margin
  return {
    x: push(bounds.left + margin - b.x) - push(b.x - (bounds.right - margin)),
    y: push(bounds.top + margin - b.y) - push(b.y - (bounds.bottom - margin)),
  }
}

/** One step of Reynolds' vehicle: the force truncated to `maxForce`, the velocity to `maxSpeed`, then the move. */
export function integrate(b: Body, force: Vec, limits: Limits, dt: number): void {
  const f = truncate(force, limits.maxForce)
  const v = truncate({ x: b.vx + f.x * dt, y: b.vy + f.y * dt }, limits.maxSpeed)
  b.vx = v.x
  b.vy = v.y
  b.x += v.x * dt
  b.y += v.y * dt
}

export interface FallOptions {
  /** Downward pull, px/s². */
  gravity: number
  /** The floor and walls it lands on and bounces off. */
  bounds: Bounds
  /** The share of its speed a bounce keeps. */
  restitution: number
  /** The share of its sideways speed it keeps on each bounce, and per second while sliding on the floor. */
  friction: number
  /** Landing slower than this, it stops bouncing and lies on the floor. */
  restSpeed: number
}

/**
 * One step of falling under gravity, bouncing off the floor and the walls. Says whether it is still in the `air`, has
 * just bounced, is sliding to a stop along the floor, or lies at `rest` on it.
 */
export function fall(b: Body, opts: FallOptions, dt: number): 'air' | 'bounce' | 'slide' | 'rest' {
  const { bounds } = opts
  b.vy += opts.gravity * dt
  b.x += b.vx * dt
  b.y += b.vy * dt
  if (b.x < bounds.left || b.x > bounds.right) {
    b.x = Math.max(bounds.left, Math.min(bounds.right, b.x))
    b.vx = -b.vx * opts.restitution
  }
  if (b.y < bounds.bottom) return 'air'
  b.y = bounds.bottom
  if (b.vy > opts.restSpeed) {
    b.vy = -b.vy * opts.restitution
    b.vx *= opts.friction
    return 'bounce'
  }
  b.vy = 0
  b.vx *= opts.friction ** (dt * 8)
  if (Math.abs(b.vx) < opts.restSpeed / 4) {
    b.vx = 0
    return 'rest'
  }
  return 'slide'
}
