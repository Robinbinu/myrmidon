import { expect, test } from 'bun:test'
import {
  arrive,
  avoidBox,
  type Body,
  contain,
  fall,
  flee,
  integrate,
  separation,
  speedOf,
  wander,
} from '../src/client/ui/steering.ts'

const DT = 1 / 60
const limits = { maxSpeed: 400, maxForce: 1200 }
const body = (x = 0, y = 0, vx = 0, vy = 0): Body => ({ x, y, vx, vy })

test('arrival slows down near the target and comes to rest on it', () => {
  const b = body()
  const target = { x: 600, y: 0 }
  let farSpeed = 0
  let nearSpeed = Number.POSITIVE_INFINITY
  for (let i = 0; i < 60 * 6; i++) {
    integrate(b, arrive(b, target, limits.maxSpeed, 150), limits, DT)
    const left = target.x - b.x
    if (left > 300 && left < 350) farSpeed = speedOf(b)
    if (left < 30 && left > 20) nearSpeed = Math.min(nearSpeed, speedOf(b))
  }
  expect(farSpeed).toBeGreaterThan(350)
  expect(nearSpeed).toBeLessThan(farSpeed / 2)
  expect(Math.abs(b.x - target.x)).toBeLessThan(2)
  expect(speedOf(b)).toBeLessThan(5)
})

test('fleeing moves away from what it flees, faster and faster up to its top speed', () => {
  const b = body(10, 5)
  const from = { x: 0, y: 0 }
  let last = Math.hypot(b.x, b.y)
  for (let i = 0; i < 60; i++) {
    integrate(b, flee(b, from, limits.maxSpeed), limits, DT)
    const d = Math.hypot(b.x, b.y)
    expect(d).toBeGreaterThan(last)
    last = d
  }
  expect(speedOf(b)).toBeCloseTo(limits.maxSpeed, 0)
  // Away along the line it started on.
  expect(b.x / b.y).toBeCloseTo(2, 1)
})

test('separation pushes close neighbours apart, and ignores far ones', () => {
  const a = body(0, 0)
  const push = separation(a, [{ x: 20, y: 0 }], 100)
  expect(push.x).toBeLessThan(0)
  expect(push.y).toBe(0)
  // Nearer pushes harder.
  expect(Math.abs(separation(a, [{ x: 10, y: 0 }], 100).x)).toBeGreaterThan(Math.abs(push.x))
  expect(separation(a, [{ x: 200, y: 0 }], 100)).toEqual({ x: 0, y: 0 })

  // Two bodies steered only by separation drift apart until they are out of range.
  const b = body(15, 0)
  for (let i = 0; i < 120; i++) {
    const fa = separation(a, [b], 100)
    const fb = separation(b, [a], 100)
    integrate(a, { x: fa.x * 2000 - a.vx * 4, y: fa.y * 2000 - a.vy * 4 }, limits, DT)
    integrate(b, { x: fb.x * 2000 - b.vx * 4, y: fb.y * 2000 - b.vy * 4 }, limits, DT)
  }
  expect(b.x - a.x).toBeGreaterThan(90)
})

test('gravity and bouncing settle a falling body on the floor', () => {
  const b = body(0, -300, 160, -200)
  const opts = {
    gravity: 2600,
    bounds: { left: -400, right: 400, top: -500, bottom: 200 },
    restitution: 0.45,
    friction: 0.8,
    restSpeed: 90,
  }
  let bounces = 0
  let state = 'air'
  let steps = 0
  while (state !== 'rest' && steps++ < 60 * 10) {
    state = fall(b, opts, DT)
    if (state === 'bounce') bounces++
    expect(b.y).toBeLessThanOrEqual(opts.bounds.bottom)
  }
  expect(state).toBe('rest')
  expect(bounces).toBeGreaterThanOrEqual(2)
  expect(b.y).toBe(opts.bounds.bottom)
  expect(b.vx).toBe(0)
  expect(b.vy).toBe(0)
  // Settling took a while, not forever.
  expect(steps).toBeLessThan(60 * 4)
})

test('wander meanders: the steering point moves a little each step, never jumps', () => {
  const b = body(0, 0, 100, 0)
  const state = { angle: 0 }
  let random = 0
  const opts = { distance: 60, radius: 30, jitter: 6 }
  const first = wander(b, state, opts, DT, () => 1)
  expect(first.x).toBeGreaterThan(60)
  for (let i = 0; i < 30; i++) {
    const before = state.angle
    wander(b, state, opts, DT, () => (random = (random + 0.37) % 1))
    expect(Math.abs(state.angle - before)).toBeLessThanOrEqual(opts.jitter * DT + 1e-9)
  }
})

test('obstacle avoidance and containment push the right way', () => {
  const box = { x: 0, y: 0, hw: 100, hh: 60 }
  // Heading into the box from its left: pushed back out to the left.
  expect(avoidBox(body(-150, 0, 300, 0), box, 20, 0.3)).toEqual({ x: -1, y: 0 })
  // Clear of it and not heading in: nothing.
  expect(avoidBox(body(-150, 0, -300, 0), box, 20, 0.3)).toEqual({ x: 0, y: 0 })
  const bounds = { left: -200, right: 200, top: -200, bottom: 200 }
  expect(contain(body(195, 0), bounds, 40).x).toBeLessThan(0)
  expect(contain(body(0, -195), bounds, 40).y).toBeGreaterThan(0)
  expect(contain(body(0, 0), bounds, 40)).toEqual({ x: 0, y: 0 })
})
