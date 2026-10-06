import {
  AnimatePresence,
  animate,
  motion,
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from 'motion/react'
import { useEffect, useRef } from 'react'
import { inkOn } from './pixel.tsx'

/*
 * Cursor physics, tuned against React Bits Pro's User Cursor:
 * - the arrow rides a stiff spring, the name tag a softer one, so the tag trails behind;
 * - while moving, the arrow turns its tip toward the direction of travel, weighted by speed, on its own
 *   softer spring, then settles back to a resting tilt;
 * - the tag swings by how far it lags behind; the arrow pops in on arrival and dips when it clicks.
 */
const ARROW_SPRING = { stiffness: 380, damping: 32, mass: 0.6 }
const LABEL_SPRING = { stiffness: 220, damping: 26, mass: 0.7 }
const TURN_SPRING = { stiffness: 170, damping: 20, mass: 0.8 }
const SIZE = 22
const REST_TILT = -14
const PRESS_SCALE = 0.92
/** Speed (px/s) at which the arrow points fully along its path. */
const FULL_TURN_SPEED = 1400
const LABEL_TILT_MAX = 8
const LABEL_TILT_PER_PX = 0.11
/** The glyph's tip points up-left, at -135° in screen angles. */
const TIP_HEADING = -135
const LABEL_OFFSET = { x: SIZE * 0.9, y: SIZE * 0.2 + 6 }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
/** Signed difference between two angles in degrees, in (-180, 180]. */
const turn = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180

/** A symmetric arrowhead, tip at the top-left; rotates about its tip. */
function Arrowhead({ color }: { color: string }) {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" aria-hidden className="block">
      <path
        d="M3.6 2.4c-.8-.3-1.5.4-1.2 1.2l6.5 16.6c.3.8 1.4.8 1.7 0l2.6-6.6 6.6-2.6c.8-.3.8-1.4 0-1.7L3.6 2.4Z"
        fill={color}
        stroke="rgb(0 0 0 / 0.22)"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** How long the virtual hand takes to cover a distance, in ms. */
export function tripMs(dist: number): number {
  return clamp(0.55 + dist / 520, 0.6, 1.6) * 1000
}

/**
 * A collaborator's cursor flying to (x, y). A virtual hand moves the pointer along a gently curved
 * path; the arrow and its tag follow on springs.
 */
export function CrewCursor(props: { name: string; color: string; x: number; y: number; clicking: boolean }) {
  const reduce = useReducedMotion()
  const px = useMotionValue(props.x)
  const py = useMotionValue(props.y)
  const ax = useSpring(px, ARROW_SPRING)
  const ay = useSpring(py, ARROW_SPRING)
  const lx = useSpring(px, LABEL_SPRING)
  const ly = useSpring(py, LABEL_SPRING)
  const labelX = useTransform(lx, (v) => v + LABEL_OFFSET.x)
  const labelY = useTransform(ly, (v) => v + LABEL_OFFSET.y)
  const aim = useMotionValue(REST_TILT)
  const rotate = useSpring(aim, TURN_SPRING)
  const swing = useMotionValue(0)
  const bend = useRef(1)

  // The hand: an eased trip along a quadratic curve that bows to alternating sides.
  useEffect(() => {
    const from = { x: px.get(), y: py.get() }
    const to = { x: props.x, y: props.y }
    const dist = Math.hypot(to.x - from.x, to.y - from.y)
    if (reduce || dist < 1) {
      px.set(to.x)
      py.set(to.y)
      return
    }
    bend.current = -bend.current
    const bow = dist * 0.22 * bend.current
    const cx = (from.x + to.x) / 2 + (-(to.y - from.y) / dist) * bow
    const cy = (from.y + to.y) / 2 + ((to.x - from.x) / dist) * bow
    const trip = animate(0, 1, {
      duration: tripMs(dist) / 1000,
      ease: [0.45, 0, 0.2, 1],
      onUpdate: (t) => {
        const u = 1 - t
        px.set(u * u * from.x + 2 * u * t * cx + t * t * to.x)
        py.set(u * u * from.y + 2 * u * t * cy + t * t * to.y)
      },
    })
    return () => trip.stop()
  }, [props.x, props.y, px, py, reduce])

  useAnimationFrame(() => {
    if (reduce) return
    const vx = ax.getVelocity()
    const vy = ay.getVelocity()
    const weight = clamp(Math.hypot(vx, vy) / FULL_TURN_SPEED, 0, 1)
    const pointing = (Math.atan2(vy, vx) * 180) / Math.PI - TIP_HEADING
    const target = REST_TILT + turn(REST_TILT, pointing) * weight
    // Aim relative to where the arrow is now, so it never spins the long way round.
    const current = rotate.get()
    aim.set(current + turn(current, target))
    swing.set(clamp(-(lx.get() - ax.get()) * LABEL_TILT_PER_PX, -LABEL_TILT_MAX, LABEL_TILT_MAX))
  })

  return (
    <>
      <motion.div className="absolute left-0 top-0" style={{ x: ax, y: ay }}>
        <AnimatePresence>
          {props.clicking && (
            <motion.span
              className="absolute -left-3.5 -top-3.5 size-7 rounded-full border-2"
              style={{ borderColor: props.color }}
              initial={{ scale: 0.2, opacity: 0.9 }}
              animate={{ scale: 1.8, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          )}
        </AnimatePresence>
        <motion.div
          className="-ml-[3px] -mt-[2.5px]"
          style={{ rotate, originX: 3 / 24, originY: 2.5 / 24 }}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: props.clicking ? PRESS_SCALE : 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 600, damping: 24 }}
        >
          <Arrowhead color={props.color} />
        </motion.div>
      </motion.div>
      <motion.span
        className="absolute left-0 top-0 inline-flex items-center whitespace-nowrap rounded-full px-3 py-[5px] text-[12.5px] font-medium leading-none shadow-[0_2px_10px_rgb(0_0_0/0.15)]"
        style={{
          x: labelX,
          y: labelY,
          rotate: swing,
          originX: 0,
          originY: 0.5,
          background: props.color,
          color: inkOn(props.color),
        }}
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 500, damping: 26, delay: 0.05 }}
      >
        {props.name}
      </motion.span>
    </>
  )
}
