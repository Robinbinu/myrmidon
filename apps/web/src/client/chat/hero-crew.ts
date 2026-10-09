import { copy } from '../copy.ts'
import { TIP_HEADING, turn } from '../ui/cursor.tsx'
import { agentColor } from '../ui/pixel.tsx'
import {
  add,
  arrive,
  avoidBox,
  type Body,
  type Bounds,
  contain,
  fall,
  flee,
  integrate,
  scale,
  separation,
  speedOf,
  type Vec,
  type WanderState,
  wander,
} from '../ui/steering.ts'
import { CREW_BOLDNESS, CURSOR, MASCOT_CREW as K } from '../ui-config.ts'

/**
 * The crew cursors around the new-chat mascot, each steering itself (ui/steering.ts). Each picks a state the way
 * Reynolds' action selection does, from what the mascot is up to, and in each state adds up a few weighted steering
 * behaviours. Positions are px from the mascot's centre; times are ms on one clock (performance.now()).
 */

/** What the mascot's mood asks of its crew: carry on, run off (it was startled), come close (it is happy), creep up (it sleeps). */
export type CrewSignal = 'roam' | 'scatter' | 'gather' | 'sneak'

export type CrewState =
  | 'roam'
  | 'poke'
  | 'scatter'
  | 'gather'
  | 'sneak'
  /** Stock-still while the mascot looks straight at it. */
  | 'frozen'
  | 'falling'
  | 'dazed'
  | 'rising'

export interface Personality {
  maxSpeed: number
  maxForce: number
  /** 0–1: how often it flies over to poke the mascot. */
  curiosity: number
  /** 0–1, courage: how far it runs, how readily it freezes, how long it lies dazed. */
  nerve: number
  /** How much its wandering wobbles. */
  jitter: number
}

export interface Member {
  readonly name: string
  readonly color: string
  readonly traits: Personality
  readonly body: Body
  readonly wander: WanderState
  state: CrewState
  /** The state to go back to once the mascot looks away. */
  resume: CrewState
  /** The signal it last acted on. */
  heard: CrewSignal
  /** When the current state began, and when its current phase ends. */
  since: number
  until: number
  target: Vec
  /** Where it was headed before it fell, to find its way back to. */
  home: Vec
  /** A poke in three beats: flying there, clicking, lingering before it goes. */
  poke?: 'fly' | 'click' | 'linger'
  clicking: boolean
  /** The arrow's angle in degrees, and how fast it tumbles while it falls. */
  angle: number
  spin: number
}

export interface World {
  now: number
  /** Half the mascot's screen; its centre is the origin. */
  face: { hw: number; hh: number }
  /** Where the crew may go; the bottom is the floor they land on. */
  bounds: Bounds
  signal: CrewSignal
  /** Where the mascot's eyes look, in cells (as `gaze` gives them). */
  look?: readonly [number, number]
  typing: boolean
}

export type CrewEvent = { type: 'poke'; name: string } | { type: 'watch'; x: number; y: number }

type Random = () => number
type Range = readonly [number, number]
const between = ([lo, hi]: Range, r: number) => lo + (hi - lo) * r
const ORIGIN: Vec = { x: 0, y: 0 }

/** `count` names from the list for this visit, each with a colour no other has while the list allows. */
export function pickCrew(
  count: number,
  random: Random = Math.random,
  names: readonly string[] = copy.hero.crewNames,
): { name: string; color: string }[] {
  const pool = [...names]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j] as string, pool[i] as string]
  }
  // The colour is the one the name owns everywhere (agentColor), so the same Kevin is always the same colour.
  const crew = pool.map((name) => ({ name, color: agentColor(name.toLowerCase()) }))
  const picked: typeof crew = []
  for (const c of crew) if (picked.length < count && !picked.some((p) => p.color === c.color)) picked.push(c)
  for (const c of crew) if (picked.length < count && !picked.includes(c)) picked.push(c)
  return picked
}

/**
 * The crew for a visit: `count` cursors named from the person's own names first (their specialists or their list),
 * with Minions filling any places left.
 */
export function crewFor(
  count: number,
  own: readonly string[] = [],
  random: Random = Math.random,
): { name: string; color: string }[] {
  const mine = pickCrew(Math.min(count, own.length), random, own)
  if (mine.length >= count) return mine
  const taken = new Set(own.map((n) => n.toLowerCase()))
  const minions = copy.hero.crewNames.filter((n) => !taken.has(n.toLowerCase()))
  return [...mine, ...pickCrew(count - mine.length, random, minions)]
}

/**
 * A new member at `at`, with a personality drawn from MASCOT_CREW's ranges; how bold the person set the crew decides
 * the ranges its curiosity and nerve come from.
 */
export function makeMember(
  spec: { name: string; color: string },
  at: Vec,
  random: Random = Math.random,
  boldness: keyof typeof CREW_BOLDNESS = 'curious',
): Member {
  const p = { ...K.personality, ...CREW_BOLDNESS[boldness] }
  return {
    ...spec,
    traits: {
      maxSpeed: between(p.maxSpeed, random()),
      maxForce: between(p.maxForce, random()),
      curiosity: between(p.curiosity, random()),
      nerve: between(p.nerve, random()),
      jitter: between(p.jitter, random()),
    },
    body: { x: at.x, y: at.y, vx: 0, vy: 0 },
    wander: { angle: random() * Math.PI * 2 },
    state: 'roam',
    resume: 'roam',
    heard: 'roam',
    since: 0,
    until: 0,
    target: { ...at },
    home: { ...at },
    clicking: false,
    angle: CURSOR.startTilt,
    spin: 0,
  }
}

/** Where member `i` of `n` starts: either side of the screen, staggered top to bottom. */
export function startSpot(i: number, n: number, face: World['face'], random: Random = Math.random): Vec {
  const side = i % 2 === 0 ? -1 : 1
  return {
    x: side * (face.hw + 90 + random() * 100),
    y: -face.hh * 0.5 + (i / Math.max(1, n - 1)) * face.hh * 1.2,
  }
}

/** Knocked off its feet: a hop up and sideways, tumbling, then it falls. */
export function knockDown(m: Member, now: number, random: Random = Math.random): void {
  if (m.state !== 'falling' && m.state !== 'dazed') m.home = { ...m.target }
  m.state = 'falling'
  m.since = now
  m.poke = undefined
  m.clicking = false
  m.body.vy = -between(K.knock.up, random())
  m.body.vx = (random() < 0.5 ? -1 : 1) * between(K.knock.side, random())
  m.spin = (random() < 0.5 ? -1 : 1) * between(K.knock.spin, random())
}

/** Whether the mascot's eyes point at it: within a cone that narrows with its nerve. */
export function lookedAt(m: Member, look: World['look']): boolean {
  if (!look || (look[0] === 0 && look[1] === 0)) return false
  // A look of one cell is about this many px of the pointer away, as `gaze` measures it.
  const gx = look[0] * 110
  const gy = look[1] * 90
  const d = Math.hypot(m.body.x, m.body.y)
  if (d < 1) return false
  const cos = (gx * m.body.x + gy * m.body.y) / (Math.hypot(gx, gy) * d)
  return cos > K.freezeCos + K.freezeNerve * m.traits.nerve
}

const clampTo = (p: Vec, b: Bounds, edge: number): Vec => ({
  x: Math.max(b.left + edge, Math.min(b.right - edge, p.x)),
  y: Math.max(b.top + edge, Math.min(b.bottom - edge, p.y)),
})

/** Somewhere beside the screen, away from where the others are headed. */
function roamSpot(m: Member, crew: readonly Member[], w: World, random: Random): Vec {
  const others = crew.filter((o) => o !== m).map((o) => o.target)
  let best = m.target
  let bestGap = -1
  for (let k = 0; k < 6; k++) {
    const side = random() < 0.5 ? -1 : 1
    const c = clampTo(
      { x: side * (w.face.hw + 50 + random() * 170), y: -w.face.hh * 0.9 + random() * w.face.hh * 1.6 },
      w.bounds,
      K.edge,
    )
    const gap = Math.min(...others.map((o) => Math.hypot(o.x - c.x, o.y - c.y)), Number.POSITIVE_INFINITY)
    if (gap > bestGap) {
      best = c
      bestGap = gap
    }
  }
  return best
}

/**
 * Close by the screen's edge, on its own side and height: `gap` px out. On the left the name tag, which trails to the
 * arrow's right, needs its room too, or it would cover the screen.
 */
function edgeSpot(i: number, n: number, w: World, gap: number): Vec {
  const left = i % 2 === 0
  const row = n > 1 ? i / (n - 1) - 0.5 : 0
  return { x: left ? -(w.face.hw + gap + K.tagRoom) : w.face.hw + gap, y: row * w.face.hh * 1.2 }
}

function enter(m: Member, state: CrewState, i: number, crew: readonly Member[], w: World, random: Random) {
  m.state = state
  m.since = w.now
  m.poke = undefined
  m.clicking = false
  if (state === 'roam') {
    m.target = roamSpot(m, crew, w, random)
    m.until = w.now + between(K.roamMs, random())
  } else if (state === 'scatter') m.until = w.now + K.scatterMs * (1.4 - m.traits.nerve * 0.8)
  else if (state === 'gather') m.target = edgeSpot(i, crew.length, w, 44)
  else if (state === 'sneak') m.target = edgeSpot(i, crew.length, w, 8)
}

/**
 * Moves the crew on by `dt` seconds: each member hears the signal, freezes if looked at, picks its next spot or poke,
 * and steers there. Returns what the mascot should know of: a poke landing, a spot worth a glance.
 */
export function stepCrew(crew: Member[], w: World, dt: number, random: Random = Math.random): CrewEvent[] {
  const events: CrewEvent[] = []
  const faceBox = { x: 0, y: 0, hw: w.face.hw, hh: w.face.hh }
  for (const [i, m] of crew.entries()) {
    const t = m.traits
    const b = m.body
    const down = m.state === 'falling' || m.state === 'dazed' || m.state === 'rising'
    if (!down && w.signal !== m.heard) {
      m.heard = w.signal
      enter(m, w.signal, i, crew, w, random)
    }
    if (!down && m.state !== 'poke' && m.state !== 'scatter') {
      const seen = lookedAt(m, w.look)
      if (seen && m.state !== 'frozen') {
        m.resume = m.state
        m.state = 'frozen'
      } else if (!seen && m.state === 'frozen') m.state = m.resume
    }

    const others = crew.filter((o) => o !== m).map((o) => o.body)
    const apart = () => scale(separation(b, others, K.separationRadius), K.weights.separation)
    const clear = () => scale(avoidBox(b, faceBox, K.faceMargin, K.lookahead), K.weights.avoid)
    const inside = () => scale(contain(b, w.bounds, K.edge), K.weights.contain)
    const meander = () =>
      scale(
        wander(b, m.wander, { ...K.wander, jitter: K.wander.jitter * t.jitter }, dt, random),
        K.weights.wander,
      )
    let speed = t.maxSpeed
    let force: Vec = { x: 0, y: 0 }

    switch (m.state) {
      case 'roam': {
        if (Math.hypot(m.target.x - b.x, m.target.y - b.y) < 24 && w.now > m.until) {
          enter(m, 'roam', i, crew, w, random)
          if (random() < 0.5) events.push({ type: 'watch', x: m.target.x, y: m.target.y })
        }
        const someonePoking = crew.some((o) => o.state === 'poke')
        if (
          !w.typing &&
          w.signal === 'roam' &&
          !someonePoking &&
          random() < K.pokePerSecond * t.curiosity * dt
        ) {
          m.state = 'poke'
          m.poke = 'fly'
          m.target = {
            x: (random() * 2 - 1) * w.face.hw * 0.55,
            y: (random() * 2 - 1) * w.face.hh * 0.45,
          }
          events.push({ type: 'watch', x: m.target.x, y: m.target.y })
        }
        force = add(arrive(b, m.target, speed, K.slowRadius, K.gain), meander(), apart(), clear(), inside())
        break
      }
      case 'poke': {
        force = add(arrive(b, m.target, speed, K.slowRadius * 0.6, K.gain), scale(apart(), 0.3), inside())
        if (m.poke === 'fly' && Math.hypot(m.target.x - b.x, m.target.y - b.y) < 4 && speedOf(b) < 40) {
          m.poke = 'click'
          m.clicking = true
          m.until = w.now + K.clickMs
          events.push({ type: 'poke', name: m.name })
        } else if (m.poke === 'click' && w.now > m.until) {
          m.poke = 'linger'
          m.clicking = false
          m.until = w.now + K.lingerMs
        } else if (m.poke === 'linger' && w.now > m.until) enter(m, 'roam', i, crew, w, random)
        break
      }
      case 'scatter':
        speed = t.maxSpeed * K.scatterBoost
        force = add(flee(b, ORIGIN, speed, K.gain), apart(), inside())
        if (w.now > m.until) enter(m, 'roam', i, crew, w, random)
        break
      case 'gather':
        speed = t.maxSpeed * K.gatherSpeed
        force = add(arrive(b, m.target, speed, K.slowRadius, K.gain), apart(), clear(), inside())
        break
      case 'sneak':
        // Creeping right up to the screen's edge, so no keeping clear of it.
        speed = t.maxSpeed * K.sneakSpeed
        force = add(arrive(b, m.target, speed, K.slowRadius * 0.5, K.gain), apart(), inside())
        break
      case 'frozen':
        force = { x: -b.vx * K.gain * 2, y: -b.vy * K.gain * 2 }
        break
      case 'falling': {
        const landed = fall(
          b,
          {
            gravity: K.gravity,
            bounds: w.bounds,
            restitution: K.restitution,
            friction: K.friction,
            restSpeed: K.restSpeed,
          },
          dt,
        )
        m.angle += m.spin * dt
        if (landed === 'bounce') m.spin *= 0.5
        else if (landed === 'slide') m.spin *= 0.9
        else if (landed === 'rest') {
          m.state = 'dazed'
          m.since = w.now
          m.until = w.now + K.dazedMs * (1.4 - t.nerve * 0.8)
          m.spin = 0
        }
        continue
      }
      case 'dazed':
        // Lying there, wobbling less and less.
        m.angle += Math.sin((w.now - m.since) / 90) * 40 * dt * Math.max(0, 1 - (w.now - m.since) / K.dazedMs)
        if (w.now > m.until) {
          m.state = 'rising'
          m.since = w.now
          m.target = clampTo(m.home, w.bounds, K.edge)
        }
        continue
      case 'rising': {
        // Slowly at first, then finding its feet.
        const ramp = Math.min(1, (w.now - m.since) / K.riseMs)
        speed = t.maxSpeed * K.riseSpeed * (0.15 + 0.85 * ramp * ramp)
        force = add(arrive(b, m.target, speed, K.slowRadius, K.gain), apart(), clear(), inside())
        m.angle += turn(m.angle, CURSOR.startTilt) * Math.min(1, 2 * dt)
        if (Math.hypot(m.target.x - b.x, m.target.y - b.y) < 20) {
          m.heard = 'roam'
          enter(m, 'roam', i, crew, w, random)
        }
        break
      }
    }
    integrate(b, force, { maxSpeed: speed, maxForce: t.maxForce }, dt)
    // The arrow turns its tip toward where it is going, more the faster it goes; at rest it holds its heading.
    const pointing = (Math.atan2(b.vy, b.vx) * 180) / Math.PI - TIP_HEADING
    const weight = Math.min(1, speedOf(b) / K.fullTurnSpeed)
    m.angle += turn(m.angle, pointing) * weight * Math.min(1, K.turnRate * dt)
  }
  return events
}
