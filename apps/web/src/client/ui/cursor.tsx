import {
  AnimatePresence,
  animate,
  type MotionValue,
  motion,
  useAnimationFrame,
  useMotionValue,
  useReducedMotionConfig,
  useSpring,
  useTransform,
} from 'motion/react'
import { useEffect, useRef } from 'react'
import { CURSOR } from '../ui-config.ts'
import { inkOn } from './pixel.tsx'

/** The glyph's tip points up-left, at -135° in screen angles. */
export const TIP_HEADING = -135
const LABEL_OFFSET = { x: CURSOR.size * 0.9, y: CURSOR.size * 0.2 + 6 }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
/** Signed difference between two angles in degrees, in (-180, 180]. */
export const turn = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180

/** Each cursor's last angle by name, so one that comes back into view faces the way it did, not a default. */
const lastAngle = new Map<string, number>()

/** A symmetric arrowhead, tip at the top-left; rotates about its tip. */
function Arrowhead({ color }: { color: string }) {
  return (
    <svg width={CURSOR.size} height={CURSOR.size} viewBox="0 0 24 24" aria-hidden className="block">
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
  const reduce = useReducedMotionConfig()
  const px = useMotionValue(props.x)
  const py = useMotionValue(props.y)
  const ax = useSpring(px, CURSOR.arrowSpring)
  const ay = useSpring(py, CURSOR.arrowSpring)
  const aim = useMotionValue(lastAngle.get(props.name) ?? CURSOR.startTilt)
  const rotate = useSpring(aim, CURSOR.turnSpring)
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
    const weight = clamp(Math.hypot(vx, vy) / CURSOR.fullTurnSpeed, 0, 1)
    const pointing = (Math.atan2(vy, vx) * 180) / Math.PI - TIP_HEADING
    // Aim relative to where the arrow is now, so it never spins the long way round; at rest it holds still.
    const current = rotate.get()
    aim.set(current + turn(current, pointing) * weight)
    lastAngle.set(props.name, current)
  })

  return (
    <CursorBody
      name={props.name}
      color={props.color}
      x={px}
      y={py}
      arrowX={ax}
      arrowY={ay}
      rotate={rotate}
      clicking={props.clicking}
    />
  )
}

/**
 * How a crew cursor looks wherever it is moved from: the arrow at (arrowX, arrowY) turned by `rotate`, a ring when it
 * clicks, and its name tag following (x, y) on a softer spring, so the tag trails and swings by how far it lags.
 */
export function CursorBody(props: {
  name: string
  color: string
  x: MotionValue<number>
  y: MotionValue<number>
  arrowX: MotionValue<number>
  arrowY: MotionValue<number>
  rotate: MotionValue<number>
  clicking: boolean
}) {
  const reduce = useReducedMotionConfig()
  const lx = useSpring(props.x, CURSOR.labelSpring)
  const ly = useSpring(props.y, CURSOR.labelSpring)
  const labelX = useTransform(lx, (v) => v + LABEL_OFFSET.x)
  const labelY = useTransform(ly, (v) => v + LABEL_OFFSET.y)
  const swing = useMotionValue(0)

  useAnimationFrame(() => {
    if (reduce) return
    swing.set(
      clamp(
        -(lx.get() - props.arrowX.get()) * CURSOR.labelTiltPerPx,
        -CURSOR.labelTiltMax,
        CURSOR.labelTiltMax,
      ),
    )
  })

  return (
    <>
      <motion.div className="absolute left-0 top-0" style={{ x: props.arrowX, y: props.arrowY }}>
        <AnimatePresence>
          {props.clicking && (
            <motion.span
              className="absolute -left-3.5 -top-3.5 size-7 rounded-full border-2"
              style={{ borderColor: props.color }}
              initial={{ scale: 0.2, opacity: 0.9 }}
              animate={{ scale: 1.8, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={CURSOR.clickRing}
            />
          )}
        </AnimatePresence>
        <motion.div
          className="-ml-[3px] -mt-[2.5px]"
          style={{ rotate: props.rotate, originX: 3 / 24, originY: 2.5 / 24 }}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: props.clicking ? CURSOR.pressScale : 1, opacity: 1 }}
          transition={CURSOR.arrowPop}
        >
          <Arrowhead color={props.color} />
        </motion.div>
      </motion.div>
      <motion.span
        className="absolute left-0 top-0 inline-flex items-center whitespace-nowrap rounded-full px-3 py-[5px] text-callout font-medium leading-none shadow-[0_2px_10px_rgb(0_0_0/0.15)]"
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
        transition={CURSOR.labelPop}
      >
        {props.name}
      </motion.span>
    </>
  )
}
