/**
 * Craig Reynolds' steering behaviours ("Steering Behaviors For Autonomous Characters", GDC 1999), for small things
 * that move about the page by themselves, such as the crew cursors around the mascot. A body is a point with a
 * velocity; each behaviour returns a steering force, the caller adds them up with weights, and `integrate` moves the
 * body as Reynolds' simple vehicle does: the force truncated to a most, then the speed. Units are px and seconds.
 *
 * Bodies are changed in place by `integrate`, `fall` and `keepInside`: they run every frame for a handful of cursors,
 * and nothing else holds on to them. For the same reason each behaviour can write its force into an `out` vector the
 * caller keeps, so a frame allocates nothing.
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

const vec = (out: Vec | undefined, x: number, y: number): Vec => {
  const v = out ?? { x: 0, y: 0 }
  v.x = x
  v.y = y
  return v
}

export const speedOf = (b: Body) => Math.hypot(b.vx, b.vy)

/**
 * How hard flee and arrival pull toward the velocity they want, per second. Reynolds applies "wanted minus current
 * velocity" once a frame; over a time step that is this gain, so the pull does not depend on the frame rate.
 */
export const STEER_GAIN = 8

/** Toward the wanted velocity (ux, uy at `speed`), as a force. */
const toward = (b: Body, ux: number, uy: number, speed: number, gain: number, out?: Vec): Vec =>
  vec(out, (ux * speed - b.vx) * gain, (uy * speed - b.vy) * gain)

/** Flee: head straight away from `from` at full speed. */
export function flee(b: Body, from: Vec, maxSpeed: number, gain = STEER_GAIN, out?: Vec): Vec {
  const dx = b.x - from.x
  const dy = b.y - from.y
  const d = Math.hypot(dx, dy)
  // Standing right on it, any way out will do.
  return d < 1e-6 ? toward(b, 1, 0, maxSpeed, gain, out) : toward(b, dx / d, dy / d, maxSpeed, gain, out)
}

/** Arrival: head for `target`, but within `slowRadius` the wanted speed falls with the distance left, so it stops on the spot. */
export function arrive(
  b: Body,
  target: Vec,
  maxSpeed: number,
  slowRadius: number,
  gain = STEER_GAIN,
  out?: Vec,
): Vec {
  const dx = target.x - b.x
  const dy = target.y - b.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-6) return toward(b, 0, 0, 0, gain, out)
  return toward(b, dx / d, dy / d, maxSpeed * Math.min(1, d / slowRadius), gain, out)
}

export interface WanderState {
  /** Where on the wander circle the steering points, in radians. */
  angle: number
}

/**
 * Wander: a point on a circle `distance` ahead of the body is the way it steers; each step nudges that point by a
 * random amount, so the path meanders without twitching. The nudges are a random walk, whose spread grows with the
 * square root of time: scaling each by √dt (`jitter` is radians per √s) keeps the meander the same at any frame rate,
 * where scaling by dt would make it wobble more the slower the frames. Returns a unit-scaled force for the caller to
 * weight.
 */
export function wander(
  b: Body,
  state: WanderState,
  opts: { distance: number; radius: number; jitter: number },
  dt: number,
  random: () => number = Math.random,
  out?: Vec,
): Vec {
  state.angle += (random() * 2 - 1) * opts.jitter * Math.sqrt(dt)
  const speed = speedOf(b)
  const hx = speed > 1e-3 ? b.vx / speed : 1
  const hy = speed > 1e-3 ? b.vy / speed : 0
  return vec(
    out,
    hx * opts.distance + Math.cos(state.angle) * opts.radius,
    hy * opts.distance + Math.sin(state.angle) * opts.radius,
  )
}

/**
 * Separation: away from every neighbour closer than `radius`, more strongly the closer it is (falling off to nothing
 * at the radius). `others` may hold the body itself, which is skipped. Returns the sum of those unit pushes; the
 * caller weights it.
 */
export function separation(b: Body, others: readonly Vec[], radius: number, out?: Vec): Vec {
  let x = 0
  let y = 0
  for (const o of others) {
    if (o === b) continue
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
  return vec(out, x, y)
}

/**
 * Obstacle avoidance for one box: if the body is inside the box grown by `margin`, or will be within `lookahead`
 * seconds at its speed, a unit push out of it along the axis it is least deep in; otherwise nothing.
 */
export function avoidBox(b: Body, box: Box, margin: number, lookahead: number, out?: Vec): Vec {
  const hw = box.hw + margin
  const hh = box.hh + margin
  let dx = b.x - box.x
  let dy = b.y - box.y
  if (Math.abs(dx) >= hw || Math.abs(dy) >= hh) {
    dx += b.vx * lookahead
    dy += b.vy * lookahead
    if (Math.abs(dx) >= hw || Math.abs(dy) >= hh) return vec(out, 0, 0)
  }
  const deepX = hw - Math.abs(dx)
  const deepY = hh - Math.abs(dy)
  return deepX < deepY ? vec(out, Math.sign(dx) || 1, 0) : vec(out, 0, Math.sign(dy) || 1)
}

const past = (depth: number, margin: number) => Math.max(0, depth) / margin

/** Containment: back inside `bounds`, harder the further past `margin` from an edge the body is. */
export function contain(b: Body, bounds: Bounds, margin: number, out?: Vec): Vec {
  return vec(
    out,
    past(bounds.left + margin - b.x, margin) - past(b.x - (bounds.right - margin), margin),
    past(bounds.top + margin - b.y, margin) - past(b.y - (bounds.bottom - margin), margin),
  )
}

/**
 * Containment's hard stop: a body past an edge of `bounds` is put back on it, and loses the speed that carried it
 * out. Containment alone is a spring, and a strong enough pull the other way (fleeing) stretches it past the edge.
 */
export function keepInside(b: Body, bounds: Bounds): void {
  if (b.x < bounds.left || b.x > bounds.right) {
    b.x = Math.max(bounds.left, Math.min(bounds.right, b.x))
    b.vx = 0
  }
  if (b.y < bounds.top || b.y > bounds.bottom) {
    b.y = Math.max(bounds.top, Math.min(bounds.bottom, b.y))
    b.vy = 0
  }
}

/** One step of Reynolds' vehicle: the force truncated to `maxForce`, the velocity to `maxSpeed`, then the move. */
export function integrate(b: Body, force: Vec, limits: Limits, dt: number): void {
  const f = Math.hypot(force.x, force.y)
  const fk = f > limits.maxForce ? limits.maxForce / f : 1
  let vx = b.vx + force.x * fk * dt
  let vy = b.vy + force.y * fk * dt
  const v = Math.hypot(vx, vy)
  if (v > limits.maxSpeed) {
    vx *= limits.maxSpeed / v
    vy *= limits.maxSpeed / v
  }
  b.vx = vx
  b.vy = vy
  b.x += vx * dt
  b.y += vy * dt
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
