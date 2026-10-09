import { useEffect, useRef, useState } from 'react'
import { MASCOT_BEATS as B, MASCOT_GRID, MASCOT_REACTIONS as R } from '../ui-config.ts'
import type { Mood } from './pixel.tsx'

/**
 * Clips: short animations a pixel face plays in its own cells, in the spirit of the bitmap-sequence eyes of small
 * robot displays (see docs/research/2026-10-09-mascot-alive.md). A clip is a list of frames, each held for its own
 * time; a frame either changes how the eyes are drawn or lights cells of its own, or both.
 */

/**
 * A lit cell: where, and its own colour, or how brightly (0–1) it glows in the face's colour. Glowing dots are drawn
 * behind the eyes, so a ripple or a charge passes under them; dots in the face's colour or their own go over them.
 */
export type Dot = readonly [x: number, y: number, ink?: string | number]

/** A shape an eye can take in place of the one its mood gives it. */
export type EyeShape =
  | 'open'
  | 'closed'
  | 'arc'
  | 'heart'
  | 'x'
  | 'star'
  | 'sparkle'
  | 'spiral'
  | 'bang'
  | 'ask'

/** One value for both eyes, or one each (left, right). */
export type PerEye<T extends string | number> = T | readonly [T, T]

export type Look = readonly [number, number]

/** Changes to how a face's eyes are drawn. Anything left out keeps what the mood and the face's props give. */
export interface EyeTweak {
  mood?: Mood
  shape?: PerEye<EyeShape>
  /** Where both eyes look, in cells. */
  look?: Look
  /** Where each eye looks (left, right), for crossing them. */
  looks?: readonly [Look, Look]
  /** How far the top lids have come down, 0 open to 1 shut. */
  lids?: PerEye<number>
  /** How far the lower lids have come up. */
  lower?: PerEye<number>
  /** Moves the pair by whole cells; cells pushed past the screen's edge are not drawn, so eyes can slide in and out. */
  shift?: Look
  /** Stretch (+, narrower and taller) or squash (−, wider and shorter), in cells. */
  stretch?: number
  /** Only rows above this one are drawn, as a scanline reveals the eyes. */
  reveal?: number
  /** Quarter turns of a spiral eye. */
  turn?: number
}

export interface Frame {
  readonly ms: number
  /** How the eyes look for this frame; `null` hides them, for a show that takes the whole screen. */
  readonly eyes?: EyeTweak | null
  /** Cells lit over the eyes, or on their own when the eyes are hidden. */
  readonly dots?: readonly Dot[]
}

export interface Clip {
  readonly name: string
  /** A list, or a generator for long shows that make each frame when it is due. */
  readonly frames: Iterable<Frame>
  /** Starts over when it ends, until something else plays. */
  readonly loop?: boolean
}

/** A clip whose frames come from a generator, made afresh each time it plays. */
export const generated = (name: string, make: () => Iterator<Frame>, loop = false): Clip => ({
  name,
  frames: { [Symbol.iterator]: make },
  loop,
})

/** One clip after another, as one. */
export function chain(name: string, ...clips: readonly Clip[]): Clip {
  return generated(name, function* () {
    for (const c of clips) yield* c.frames
  })
}

/** The value for one eye (0 left, 1 right). */
export function forEye<T extends string | number>(v: PerEye<T> | undefined, eye: 0 | 1): T | undefined {
  return typeof v === 'object' ? v[eye] : v
}

/**
 * Plays `clip` on timers and returns the frame showing (undefined between clips). `id` names one playing of it: a new
 * id starts it again from the first frame. A clip that does not loop calls `onEnd` after its last frame. While
 * `still` (reduced motion), nothing plays.
 */
export function useClip(
  clip: Clip | undefined,
  id: string | number | undefined,
  still: boolean,
  onEnd?: () => void,
  /** Holds the clip on its frame, to carry on from there (for the rest of that frame's time) once let go. */
  paused = false,
): Frame | undefined {
  const [frame, setFrame] = useState<Frame>()
  const ended = useRef(onEnd)
  ended.current = onEnd
  const playing = useRef(clip)
  playing.current = clip
  const held = useRef(paused)
  held.current = paused
  const player = useRef<{ pause(): void; resume(): void }>(undefined)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` names the playing; a new clip object alone does not restart it
  useEffect(() => {
    setFrame(undefined)
    const c = playing.current
    if (!c || still) return
    let it = c.frames[Symbol.iterator]()
    let timer: ReturnType<typeof setTimeout> | undefined
    // When the frame on show is due to end, and how much of it was left when the clip was held.
    let due = 0
    let left = 0
    const wait = (ms: number) => {
      due = performance.now() + ms
      left = ms
      timer = held.current ? undefined : setTimeout(next, ms)
    }
    const next = () => {
      let step = it.next()
      if (step.done && c.loop) {
        it = c.frames[Symbol.iterator]()
        step = it.next()
      }
      if (step.done) {
        setFrame(undefined)
        ended.current?.()
        return
      }
      setFrame(step.value)
      wait(step.value.ms)
    }
    player.current = {
      pause() {
        if (timer === undefined) return
        clearTimeout(timer)
        timer = undefined
        left = Math.max(0, due - performance.now())
      },
      resume() {
        if (timer !== undefined) return
        due = performance.now() + left
        timer = setTimeout(next, left)
      },
    }
    next()
    return () => {
      clearTimeout(timer)
      player.current = undefined
    }
  }, [id, still])
  useEffect(() => {
    if (paused) player.current?.pause()
    else player.current?.resume()
  }, [paused])
  return frame
}

/* ------------------------------------------------------------------ authoring */

const { cols: COLS, rows: ROWS } = MASCOT_GRID
const MID = Math.floor(COLS / 2)

const f = (ms: number, eyes?: EyeTweak | null, dots?: readonly Dot[]): Frame => ({ ms, eyes, dots })
const clip = (name: string, frames: readonly Frame[], loop = false): Clip => ({ name, frames, loop })

/** Cells of a little picture: `#` lit, anything else dark, placed with its top-left at (x, y). */
export function stamp(rows: readonly string[], x: number, y: number, ink?: string | number): Dot[] {
  const out: Dot[] = []
  for (const [dy, row] of rows.entries())
    for (const [dx, ch] of [...row].entries())
      if (ch === '#') out.push(ink === undefined ? [x + dx, y + dy] : [x + dx, y + dy, ink])
  return out
}

/** Its mouth, under the eyes, for a yawn: closed to wide open. */
const MOUTH = [
  stamp(['#'], MID, 6),
  stamp(['.#.', '#.#', '.#.'], MID - 1, 5),
  stamp(['###', '#.#', '###'], MID - 1, 5),
]

/** Spray from a sneeze, in two puffs. */
const SPRAY = [
  [
    [MID - 1, 7, 0.7],
    [MID + 1, 7, 0.7],
    [MID, 6, 0.5],
  ],
  [
    [MID - 3, 7, 0.45],
    [MID + 3, 7, 0.45],
    [MID - 4, 6, 0.3],
    [MID + 4, 6, 0.3],
    [MID, 7, 0.3],
  ],
] as const satisfies readonly (readonly Dot[])[]

const SNEEZE: readonly Frame[] = [
  f(B.glance, { lids: 0.25, look: [0, -1] }),
  f(B.glance, { lids: 0.5, look: [0, -1] }),
  f(B.glance, { lids: 0.75, look: [0, -1] }),
  f(B.step, { shape: 'closed', stretch: -1, shift: [0, 1] }, SPRAY[0]),
  f(B.step * 1.5, { shape: 'closed', shift: [0, 1] }, SPRAY[1]),
  f(B.glance, { shape: 'closed' }),
  f(B.step, {}),
  f(B.blink, { shape: 'closed' }),
  f(B.step, {}),
]

/** A sneeze, as an idle trick or when the screen is double-clicked. */
export const SNEEZE_CLIP = clip('sneeze', SNEEZE)

/**
 * What the mascot's eyes do by themselves when nobody is typing, one picked at random now and then. Drawn for the
 * MASCOT_GRID screen.
 */
export const IDLE_CLIPS: readonly Clip[] = [
  clip('eye roll', [
    f(B.glance, { look: [-1, -1] }),
    f(B.step, { look: [0, -1], lids: 0.25 }),
    f(B.step, { look: [1, -1], lids: 0.25 }),
    f(B.glance, { look: [1, 0], lids: 0.25 }),
    f(B.hold, { lids: 0.4 }),
    f(B.blink, { shape: 'closed' }),
    f(B.step, {}),
  ]),
  clip('squint', [
    f(B.step, { lids: 0.25 }),
    f(B.hold, { lids: 0.3, lower: 0.2 }),
    f(B.glance, { lids: 0.3, lower: 0.2, look: [1, 0] }),
    f(B.glance, { lids: 0.3, lower: 0.2, look: [-1, 0] }),
    f(B.step, { lids: 0.25 }),
  ]),
  clip('look around', [
    f(B.hold, { look: [-2, 0] }),
    f(B.step, { look: [-1, 0] }),
    f(B.step, { look: [0, 0] }),
    f(B.step, { look: [1, 0] }),
    f(B.hold, { look: [2, 0] }),
    f(B.glance, { look: [0, -1] }),
    f(B.step, { look: [0, 0] }),
  ]),
  clip('yawn', [
    f(B.glance, { lids: 0.3 }),
    f(B.glance, { lids: 0.6, look: [0, -1] }, MOUTH[0]),
    f(B.glance, { shape: 'closed', look: [0, -1] }, MOUTH[1]),
    f(B.linger, { shape: 'closed', look: [0, -1], stretch: -1 }, MOUTH[2]),
    f(B.glance, { shape: 'closed', look: [0, -1] }, MOUTH[1]),
    f(B.glance, { lids: 0.5 }, MOUTH[0]),
    f(B.hold, { lids: 0.4 }),
    f(B.blink, { shape: 'closed' }),
    f(B.step * 2, {}),
    f(B.blink, { shape: 'closed' }),
    f(B.step, {}),
  ]),
  clip('sneeze', SNEEZE),
  clip('double blink', [
    f(B.blink, { shape: 'closed' }),
    f(B.step * 1.5, {}),
    f(B.blink, { shape: 'closed' }),
    f(B.step, {}),
  ]),
  clip('side-eye', [
    f(B.glance, { look: [2, 0], lids: 0.45 }),
    f(B.linger, { look: [2, 0], lids: 0.45 }),
    f(B.glance, { look: [-2, 0], lids: 0.45 }),
    f(B.hold, { look: [2, 0], lids: 0.45 }),
    f(B.step, { lids: 0.2 }),
  ]),
  clip('peek', [
    f(B.step, { shift: [-2, 0] }),
    f(B.step, { shift: [-5, 0] }),
    f(B.step, { shift: [-9, 0] }),
    f(B.hold, { shift: [-COLS, 0] }),
    f(B.linger, { shift: [9, 0], look: [-1, 0] }),
    f(B.glance, { shift: [7, 0], look: [-1, 0] }),
    f(B.step, { shift: [4, 0] }),
    f(B.step, { shift: [1, 0] }),
    f(B.step, {}),
  ]),
  clip('bored', [
    f(B.hold, { lids: 0.2 }),
    f(B.hold, { lids: 0.35, look: [0, 1] }),
    f(B.linger, { lids: 0.55, look: [0, 1] }),
    f(B.linger, { lids: 0.7, look: [0, 1] }),
    f(B.step, { stretch: 1 }),
    f(B.glance, {}),
  ]),
  clip('cross-eyed', [
    f(B.step, {
      looks: [
        [1, 0],
        [-1, 0],
      ],
    }),
    f(B.linger, {
      looks: [
        [1, 1],
        [-1, 1],
      ],
    }),
    f(B.step, {
      looks: [
        [1, 0],
        [-1, 0],
      ],
    }),
    f(B.blink, { shape: 'closed' }),
    f(B.step, {}),
  ]),
  clip('wink', [f(B.hold, { shape: ['open', 'closed'] }), f(B.step, {})]),
  clip('beam', [f(B.hold * 1.5, { shape: 'arc' })]),
]

/* ------------------------------------------------------------------ reactions */

const repeat = (n: number, frame: (i: number) => Frame): Frame[] =>
  Array.from({ length: n }, (_, i) => frame(i))

/** Twinkling star eyes, when a crew finishes. */
export const starEyes = (ms: number = R.starsMs): Clip =>
  clip(
    'stars',
    repeat(Math.max(1, Math.round(ms / R.twinkleMs)), (i) =>
      f(R.twinkleMs, { shape: i % 2 ? 'sparkle' : 'star' }),
    ),
  )

/** Spiral eyes turning, when dizzy or confused. */
export const spiralEyes = (ms: number): Clip =>
  clip(
    'spiral',
    repeat(Math.max(1, Math.round(ms / R.spiralStepMs)), (i) =>
      f(R.spiralStepMs, { shape: 'spiral', turn: i }),
    ),
  )

/** "!!" with a jolt, then wide eyes: surprised. */
export const BANG = clip('bang', [
  f(B.step, { shape: 'bang', shift: [0, -1] }),
  f(B.hold * 0.8, { shape: 'bang' }),
  f(B.hold, {}),
])

const TEAR = 'var(--mood-curious)'

/** Downcast eyes with tears running from their outer corners, when a run failed. */
export const tears = (ms: number = R.tearsMs): Clip => {
  // Each tear falls from beside an eye's lower corner to the bottom row, trailing a fainter cell; the right one a
  // beat behind the left.
  const fall = [5, 6, 7, 8]
  const at = (i: number): Dot[] => {
    const out: Dot[] = []
    for (const [k, x] of [1, COLS - 2].entries()) {
      const y = fall[(i + k * 2) % fall.length] ?? 0
      out.push([x, y, TEAR], [x, y - 1, 0.3])
    }
    return out
  }
  return clip(
    'tears',
    repeat(Math.max(1, Math.round(ms / R.dropMs)), (i) => f(R.dropMs, { lids: 0.45, look: [0, 1] }, at(i))),
  )
}

/** A sweat drop sliding down beside its right eye, then a pause, over and over, while it is concerned. */
export const SWEAT = clip(
  'sweat',
  [
    ...[0, 1, 2, 3].map((y) =>
      f(R.sweatStepMs, undefined, [
        [COLS - 1, y, TEAR],
        [COLS - 1, y - 1, 0.35],
      ]),
    ),
    f(R.sweatPauseMs),
  ],
  true,
)

const FLAME = ['#ff6a3d', '#ffb31a', '#ffd34d'] as const

/** Flames flickering along the bottom of the screen, while several crews work at once. */
export const fire = (random: () => number = Math.random): Clip =>
  generated(
    'fire',
    function* () {
      const heights = Array.from({ length: COLS }, () => 0)
      while (true) {
        const dots: Dot[] = []
        for (let x = 1; x < COLS - 1; x++) {
          // Taller toward the middle, and each column only moves a little from frame to frame, so it reads as flame.
          const centre = 1 - Math.abs(x - MID) / MID
          const want = Math.round(random() * 1.6 + centre * 1.6)
          const h = Math.max(0, Math.min(3, (heights[x] ?? 0) + Math.sign(want - (heights[x] ?? 0))))
          heights[x] = h
          for (let k = 0; k < h; k++) dots.push([x, ROWS - 1 - k, FLAME[k] ?? FLAME[2]])
        }
        yield f(R.fireFlickerMs, undefined, dots)
      }
    },
    true,
  )

const Z = ['####', '..#.', '.#..', '####']

/** A Z floating up from its top-right corner while it sleeps, above its shut eyes, fading as it rises. */
export const ZZZ = clip(
  'zzz',
  [
    ...(
      [
        [10, 0, 1],
        [11, -1, 0.75],
        [11, -2, 0.5],
        [12, -3, 0.3],
      ] as const
    ).map(([x, y, level]) => f(R.zzzStepMs, undefined, stamp(Z, x, y, level))),
    f(R.zzzStepMs),
  ],
  true,
)
