import { motionValue, useReducedMotionConfig } from 'motion/react'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { CursorBody } from '../ui/cursor.tsx'
import { MASCOT_CREW as K } from '../ui-config.ts'
import {
  type CrewSignal,
  keptCrew,
  knockDown,
  type Member,
  makeMember,
  settled,
  startSpot,
  stepCrew,
  type World,
} from './hero-crew.ts'

/** The crew of this visit: who they are and where, kept while the person goes to a chat and back. */
let visit: Member[] | undefined

/**
 * The crew cursors around the new-chat mascot, steering themselves (hero-crew.ts). Their physics runs every frame on
 * requestAnimationFrame and writes straight to motion values, so the page around them never re-renders for it; React
 * hears only of a cursor starting or ending a click. The physics stops while the mascot is not `active` (out of sight,
 * the window in the background) and once the crew has settled with nobody about; with reduced motion they stand still.
 */
export function HeroCrew(props: {
  signal: CrewSignal
  look?: readonly [number, number]
  typing: boolean
  /** How many times the crew has been knocked down: each new count knocks everyone over. */
  knocked: number
  /** Whether the mascot can be seen in the window in use; while it cannot, nobody moves. */
  active: boolean
  face: RefObject<HTMLElement | null>
  canvas: RefObject<HTMLElement | null>
  onPoke(): void
  /** A cursor is heading somewhere worth a glance. */
  onWatch(x: number, y: number): void
}) {
  const reduce = useReducedMotionConfig()
  const [crew] = useState(() => {
    if (!visit) {
      const picked = keptCrew(K.count)
      visit = picked.map((p, i) => makeMember(p, startSpot(i, picked.length, K.fallback.face)))
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

  // The world the physics steps through, changed in place each frame. Where the screen and the canvas are, relative
  // to the screen's centre, is measured when either changes size or the canvas scrolls, not every frame.
  const world = useRef<World>({
    now: 0,
    face: { ...K.fallback.face },
    bounds: { ...K.fallback.bounds },
    signal: 'roam',
    typing: false,
  })
  useEffect(() => {
    const measure = () => {
      const face = props.face.current?.getBoundingClientRect()
      const canvas = props.canvas.current?.getBoundingClientRect()
      if (!face || !canvas || face.width === 0 || canvas.width === 0) return
      const cx = face.left + face.width / 2
      const cy = face.top + face.height / 2
      const w = world.current
      w.face = { hw: face.width / 2, hh: face.height / 2 }
      w.bounds = {
        left: canvas.left - cx + K.edge,
        right: canvas.right - cx - K.edge - K.tagRoom,
        top: canvas.top - cy,
        bottom: canvas.bottom - cy - K.floorPad,
      }
    }
    measure()
    const canvas = props.canvas.current
    window.addEventListener('resize', measure)
    canvas?.addEventListener('scroll', measure, { passive: true })
    // The screen moves within the canvas as what is under it grows or shrinks (the latest chats arriving).
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    for (const el of [props.face.current, canvas, canvas?.firstElementChild]) if (el) observer?.observe(el)
    return () => {
      window.removeEventListener('resize', measure)
      canvas?.removeEventListener('scroll', measure)
      observer?.disconnect()
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

  // Starts the physics again after it stopped; `stir` also counts as someone being about, so it does not settle.
  const wake = useRef(() => {})
  const stir = useRef(() => {})
  useEffect(() => {
    if (reduce || !props.active) return
    let frame = 0
    let last = 0
    let stirred = performance.now()
    let clickingNow = crew.map((m) => m.clicking)
    const tick = () => {
      const now = performance.now()
      const dt = Math.min(K.maxStepS, (now - last) / 1000)
      last = now
      const p = live.current
      const w = world.current
      w.now = now
      w.signal = p.signal
      w.look = p.look
      w.typing = p.typing
      w.quiet = now - stirred > K.settleMs
      const events = stepCrew(crew, w, dt)
      let changed = false
      for (let i = 0; i < crew.length; i++) {
        const m = crew[i] as Member
        const v = values[i]
        v?.x.set(m.body.x)
        v?.y.set(m.body.y)
        v?.rotate.set(m.angle)
        const node = nodes.current[i]
        if (node && node.dataset.crewState !== m.state) node.dataset.crewState = m.state
        if (m.clicking !== clickingNow[i]) changed = true
      }
      if (changed) {
        clickingNow = crew.map((m) => m.clicking)
        setClicking(clickingNow)
      }
      for (const e of events) {
        if (e.type === 'poke') p.onPoke()
        else p.onWatch(e.x, e.y)
      }
      // Nothing left to do and nobody about: stop until someone is.
      frame = w.quiet && settled(crew) ? 0 : requestAnimationFrame(tick)
    }
    const start = () => {
      if (frame) return
      last = performance.now()
      frame = requestAnimationFrame(tick)
    }
    const someone = () => {
      stirred = performance.now()
      start()
    }
    wake.current = start
    stir.current = someone
    window.addEventListener('pointermove', someone, { passive: true })
    window.addEventListener('keydown', someone)
    start()
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', someone)
      window.removeEventListener('keydown', someone)
      wake.current = () => {}
      stir.current = () => {}
    }
  }, [reduce, props.active, crew, values])

  // What the mascot is up to changed, so the crew has something to do (a knock is the person clicking, so it stirs).
  const [lookX, lookY] = props.look ?? []
  // biome-ignore lint/correctness/useExhaustiveDependencies: each of these is a reason to move again
  useEffect(() => wake.current(), [props.signal, lookX, lookY, props.typing])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a knock is the person clicking
  useEffect(() => stir.current(), [props.knocked])

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
