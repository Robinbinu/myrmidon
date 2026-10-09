import { useReducedMotionConfig } from 'motion/react'
import { type PointerEvent, useEffect, useRef, useState } from 'react'
import type { Clip, EyeTweak, Look } from '../ui/clips.ts'
import { type EyeStyle, type Mood, PixelFace } from '../ui/pixel.tsx'
import { MASCOT_GRID, MASCOT_TOUCH } from '../ui-config.ts'

const { cols: COLS, rows: ROWS } = MASCOT_GRID
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** Where the eyes look, in cells, to see a cell of their own screen. */
export const lookAt = (x: number, y: number, reach: Look = [2, 1]): Look => [
  clamp(Math.round((x - (COLS - 1) / 2) / 2.5), -reach[0], reach[0]),
  clamp(Math.round((y - (ROWS - 1) / 2) / 2), -reach[1], reach[1]),
]

/**
 * The new-chat mascot's screen as a button: its eyes and clips, and what touching it does. A tap reports the cell it
 * landed on, a double tap and a press held still are their own gestures, and dragging across it is handled here, so
 * the eyes following the drag (and squashing with its speed) redraw only this screen.
 */
export function MascotScreen(props: {
  label: string
  mood: Mood
  color: string
  eyes: EyeStyle
  look?: Look
  text?: string
  tweak?: EyeTweak
  clip?: Clip
  playId?: string | number
  onClipEnd(): void
  /** Clicked with the pointer, on this cell of the screen. */
  onTap(cell: Look): void
  /** Activated from the keyboard. */
  onPress(): void
  onDoubleTap(): void
  /** A press held still long enough to start charging, and its letting go. */
  onHold(): void
  onRelease(): void
}) {
  const reduce = useReducedMotionConfig()
  const screen = useRef<HTMLDivElement>(null)
  const press = useRef<{ x: number; y: number; t: number; held: boolean; dragged: boolean }>(undefined)
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const swallowClick = useRef(false)
  // Whether the click on its way came from a pointer; one from the keyboard has no pointer, and no cell to look at.
  const pointed = useRef(false)
  const [drag, setDrag] = useState<{ look: Look; stretch: number }>()
  useEffect(() => () => clearTimeout(holdTimer.current), [])

  const cellAt = (e: { clientX: number; clientY: number }): Look => {
    const r = (screen.current?.firstElementChild ?? screen.current)?.getBoundingClientRect()
    if (!r || r.width === 0 || r.height === 0) return [Math.floor(COLS / 2), Math.floor(ROWS / 2)]
    return [
      Math.floor(((e.clientX - r.left) / r.width) * COLS),
      Math.floor(((e.clientY - r.top) / r.height) * ROWS),
    ]
  }

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    pointed.current = true
    if (e.button !== 0 || reduce) return
    press.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, held: false, dragged: false }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    clearTimeout(holdTimer.current)
    holdTimer.current = setTimeout(() => {
      if (!press.current || press.current.dragged) return
      press.current.held = true
      props.onHold()
    }, MASCOT_TOUCH.holdMs)
  }
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current
    if (!p || p.held) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    if (!p.dragged && Math.hypot(dx, dy) < MASCOT_TOUCH.dragPx) return
    p.dragged = true
    clearTimeout(holdTimer.current)
    // Squash along a fast sideways drag, stretch along a fast vertical one, a cell per step of speed.
    const dt = Math.max(1, e.timeStamp - p.t)
    const vx = Math.abs(dx) / dt
    const vy = Math.abs(dy) / dt
    const amount = Math.min(2, Math.floor(Math.max(vx, vy) / MASCOT_TOUCH.stretchSpeed))
    const stretch = vx > vy ? -amount : amount
    press.current = { ...p, x: e.clientX, y: e.clientY, t: e.timeStamp }
    const [cx, cy] = cellAt(e)
    const look = lookAt(cx, cy, [3, 2])
    setDrag((d) =>
      d && d.look[0] === look[0] && d.look[1] === look[1] && d.stretch === stretch ? d : { look, stretch },
    )
  }
  const onPointerUp = () => {
    const p = press.current
    press.current = undefined
    clearTimeout(holdTimer.current)
    if (!p) return
    if (p.dragged || p.held) swallowClick.current = true
    if (p.dragged) setDrag(undefined)
    if (p.held) props.onRelease()
  }

  const look = drag?.look ?? props.look
  const tweak = drag ? { ...props.tweak, mood: 'idle' as const, stretch: drag.stretch } : props.tweak
  return (
    <button
      type="button"
      onClick={(e) => {
        if (swallowClick.current) {
          swallowClick.current = false
          pointed.current = false
          return
        }
        if (pointed.current) props.onTap(cellAt(e))
        else props.onPress()
        pointed.current = false
      }}
      onDoubleClick={() => props.onDoubleTap()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-label={props.label}
      className="block touch-none select-none rounded-xl outline-offset-4"
    >
      <div ref={screen}>
        {/* While the person types, the screen spells out their message in its own cells. */}
        <PixelFace
          mood={props.mood}
          color={props.color}
          cols={COLS}
          rows={ROWS}
          cell={20}
          gap={6}
          glow
          eyes={props.eyes}
          {...(look ? { look } : {})}
          {...(props.text !== undefined ? { text: props.text } : {})}
          {...(tweak ? { tweak } : {})}
          {...(props.clip ? { clip: props.clip } : {})}
          {...(props.playId !== undefined ? { playId: props.playId } : {})}
          onClipEnd={props.onClipEnd}
          className="h-auto w-[min(400px,calc(100vw-96px))]"
        />
      </div>
    </button>
  )
}
