import { motionValue, useReducedMotionConfig } from 'motion/react'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { CursorBody } from '../ui/cursor.tsx'
import type { Bounds } from '../ui/steering.ts'
import { MASCOT_CREW } from '../ui-config.ts'
import {
  type CrewSignal,
  knockDown,
  type Member,
  makeMember,
  pickCrew,
  startSpot,
  stepCrew,
  type World,
} from './hero-crew.ts'

/** Sizes to steer by before the page has been measured (and in a page with no layout). */
const FALLBACK = { face: { hw: 225, hh: 160 }, bounds: { left: -640, right: 640, top: -320, bottom: 420 } }
/** The longest step the physics takes, so a frame after the tab was hidden does not fling anyone off. */
const MAX_STEP_S = 0.05

/** The crew of this visit: who they are and where, kept while the person goes to a chat and back. */
let visit: Member[] | undefined

/**
 * The crew cursors around the new-chat mascot, steering themselves (hero-crew.ts). Their physics runs every frame on
 * requestAnimationFrame and writes straight to motion values, so the page around them never re-renders for it; React
 * hears only of a cursor starting or ending a click. With reduced motion they stand still.
 */
export function HeroCrew(props: {
  signal: CrewSignal
  look?: readonly [number, number]
  typing: boolean
  /** How many times the crew has been knocked down: each new count knocks everyone over. */
  knocked: number
  face: RefObject<HTMLElement | null>
  canvas: RefObject<HTMLElement | null>
  onPoke(): void
  /** A cursor is heading somewhere worth a glance. */
  onWatch(x: number, y: number): void
}) {
  const reduce = useReducedMotionConfig()
  const [crew] = useState(() => {
    if (!visit) {
      const picked = pickCrew(MASCOT_CREW.count)
      visit = picked.map((p, i) => makeMember(p, startSpot(i, picked.length, FALLBACK.face)))
    }
    for (const m of visit) {
      // Back on this screen, nobody is mid-click; anyone who was down is up again.
      m.clicking = false
      m.poke = undefined
      if (m.state !== 'roam') m.state = 'roam'
      m.heard = 'roam'
    }
    return visit
  })
  const values = useMemo(
    () =>
      crew.map((m) => ({ x: motionValue(m.body.x), y: motionValue(m.body.y), rotate: motionValue(m.angle) })),
    [crew],
  )
  const [clicking, setClicking] = useState(() => crew.map(() => false))
  const nodes = useRef<(HTMLDivElement | null)[]>([])
  const live = useRef(props)
  live.current = props

  // Where the screen and the canvas are, relative to the screen's centre: measured on resize, not every frame.
  const space = useRef<Pick<World, 'face' | 'bounds'>>(FALLBACK)
  useEffect(() => {
    const measure = () => {
      const face = props.face.current?.getBoundingClientRect()
      const canvas = props.canvas.current?.getBoundingClientRect()
      if (!face || !canvas || face.width === 0 || canvas.width === 0) return
      const cx = face.left + face.width / 2
      const cy = face.top + face.height / 2
      const bounds: Bounds = {
        left: canvas.left - cx + MASCOT_CREW.edge,
        right: canvas.right - cx - MASCOT_CREW.edge - MASCOT_CREW.tagRoom,
        top: canvas.top - cy,
        bottom: canvas.bottom - cy - MASCOT_CREW.floorPad,
      }
      space.current = { face: { hw: face.width / 2, hh: face.height / 2 }, bounds }
    }
    measure()
    window.addEventListener('resize', measure)
    const t = setInterval(measure, 2000)
    return () => {
      window.removeEventListener('resize', measure)
      clearInterval(t)
    }
  }, [props.face, props.canvas])

  const knockedSeen = useRef(props.knocked)
  useEffect(() => {
    if (props.knocked === knockedSeen.current) return
    knockedSeen.current = props.knocked
    if (reduce) return
    const now = performance.now()
    for (const m of crew) knockDown(m, now)
  }, [props.knocked, reduce, crew])

  useEffect(() => {
    if (reduce) return
    let frame = 0
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      const dt = Math.min(MAX_STEP_S, (now - last) / 1000)
      last = now
      const p = live.current
      const world: World = {
        now,
        ...space.current,
        signal: p.signal,
        ...(p.look ? { look: p.look } : {}),
        typing: p.typing,
      }
      const events = stepCrew(crew, world, dt)
      for (const [i, m] of crew.entries()) {
        const v = values[i]
        v?.x.set(m.body.x)
        v?.y.set(m.body.y)
        v?.rotate.set(m.angle)
        const node = nodes.current[i]
        if (node && node.dataset.crewState !== m.state) node.dataset.crewState = m.state
      }
      setClicking((cs) => (cs.every((c, i) => c === crew[i]?.clicking) ? cs : crew.map((m) => m.clicking)))
      for (const e of events) {
        if (e.type === 'poke') p.onPoke()
        else p.onWatch(e.x, e.y)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [reduce, crew, values])

  return (
    <>
      {crew.map((m, i) => {
        const v = values[i]
        if (!v) return null
        return (
          <div
            key={m.name}
            ref={(el) => {
              nodes.current[i] = el
            }}
            data-crew={m.name}
            data-crew-state={m.state}
            className="absolute left-0 top-0"
          >
            <CursorBody
              name={m.name}
              color={m.color}
              x={v.x}
              y={v.y}
              arrowX={v.x}
              arrowY={v.y}
              rotate={v.rotate}
              clicking={clicking[i] ?? false}
            />
          </div>
        )
      })}
    </>
  )
}
