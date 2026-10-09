import { identityOf } from '@myrmidon/protocol'
import { motion, useReducedMotionConfig } from 'motion/react'
import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { copy } from '../copy.ts'
import { AGENT_DOZE_MS, MASCOT_TYPING, popSpring } from '../ui-config.ts'
import { type Clip, type Dot, type EyeTweak, forEye, useClip } from './clips.ts'
import { AgentCharacter } from './crew.tsx'
import { cn } from './primitives.tsx'

export { JUDGE_COLOR, LEAD_COLOR, USER_COLOR } from '@myrmidon/protocol'

/* ------------------------------------------------------------------ identity */

/** Lead is signal amber, the judge lime, the user ultramarine; each worker owns a palette colour. */
export function agentColor(name: string): string {
  return identityOf(name).color
}

/**
 * Dark or light text, whichever has more contrast on the given fill by WCAG's relative luminance. A brightness cut-off
 * put white on mid blues and violets at under 4:1.
 */
export function inkOn(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lum =
    0.2126 * channel(((n >> 16) & 255) / 255) +
    0.7152 * channel(((n >> 8) & 255) / 255) +
    0.0722 * channel((n & 255) / 255)
  // --on-bright (#0b0b0d) has a luminance of about 0.0034, --on-deep (white) 1.
  return (lum + 0.05) / 0.0534 > 1.05 / (lum + 0.05) ? 'var(--on-bright)' : 'var(--on-deep)'
}

/* ------------------------------------------------------------------ pixel face */

/**
 * `listening`: eyes lowered toward the message box while the user types. `wink`, `surprised`, and
 * `love` are short reactions the mascot plays when poked.
 */
export type Mood =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'working'
  | 'happy'
  | 'error'
  | 'sleep'
  | 'waiting'
  | 'wink'
  | 'surprised'
  | 'love'

export function moodFor(status: string): Mood {
  switch (status) {
    case 'working':
    case 'running':
      return 'working'
    case 'provisioning':
    case 'created':
      return 'thinking'
    case 'completed':
    case 'verified':
      return 'happy'
    case 'failed':
    case 'rejected':
      return 'error'
    case 'stopped':
    case 'done':
    case 'resting':
      return 'sleep'
    case 'waiting':
      return 'waiting'
    default:
      return 'idle'
  }
}

/**
 * The mood an agent's face shows: its status, except that an agent left idle for a while falls asleep.
 * `awake` keeps the face open for avatars used as static icons rather than live agents.
 */
export function useAgentMood(status: string, awake = false): Mood {
  const mood = moodFor(status)
  const resting = !awake && mood === 'idle'
  const [dozing, setDozing] = useState(false)
  useEffect(() => {
    setDozing(false)
    if (!resting) return
    const t = setTimeout(() => setDozing(true), AGENT_DOZE_MS)
    return () => clearTimeout(t)
  }, [resting])
  return resting && dozing ? 'sleep' : mood
}

/**
 * A small "z" drifting up from a sleeping face. The glyph is drawn by CSS, not text, so it stays out of the text
 * (and any name computed from text) of the row or button the avatar sits in.
 */
export function Snore(props: { size: number }) {
  const reduce = useReducedMotionConfig()
  const font = Math.max(8, Math.round(props.size * 0.26))
  return (
    <motion.span
      className="pointer-events-none absolute select-none font-semibold leading-none text-muted after:content-['z']"
      style={{ right: -font * 0.35, top: -font * 0.55, fontSize: font }}
      initial={reduce ? { opacity: 0.6 } : { opacity: 0, x: 0, y: 2 }}
      animate={reduce ? { opacity: 0.6 } : { opacity: [0, 0.7, 0], x: [0, 2, 4], y: [2, -3, -8] }}
      transition={reduce ? undefined : { duration: 2.6, repeat: Number.POSITIVE_INFINITY, ease: 'easeOut' }}
      aria-hidden
    />
  )
}

export type Cell = readonly [number, number]

/**
 * The resting shape of the mascot's eyes, chosen in Settings: `happy` rests as arcs, `tall` as narrow ovals, `sleepy`
 * half-lidded, `lashes` round with a lash at each outer corner. Moods still change them.
 */
export type EyeStyle = 'round' | 'happy' | 'tall' | 'sleepy' | 'lashes'

const HEART = ['.#.#.', '#####', '.###.', '..#..']

/** Moods whose eyes are open and can follow something. */
const OPEN: ReadonlySet<Mood> = new Set(['idle', 'listening', 'waiting', 'wink', 'surprised', 'love'])

/** A star and a twinkle, five cells across like the hearts. */
const STAR = ['..#..', '.###.', '#####', '.###.', '.#.#.']
const SPARKLE = ['..#..', '..#..', '##.##', '..#..', '..#..']
/** A square spiral from its rim in to its middle; it turns a quarter at a time. */
const SPIRAL = ['#####', '....#', '###.#', '#...#', '#####']
const BANG = ['##', '##', '##', '##', '..', '##']
const ASK = ['.##.', '#..#', '...#', '..#.', '....', '..#.']

/** Turns a square picture a quarter clockwise `turns` times (counter-clockwise when negative). */
function rotate(rows: readonly string[], turns: number): string[] {
  let out = [...rows]
  const n = out.length
  for (let t = 0; t < ((turns % 4) + 4) % 4; t++)
    out = Array.from({ length: n }, (_, r) =>
      Array.from({ length: n }, (_, c) => out[n - 1 - c]?.[r] ?? '.').join(''),
    )
  return out
}

const stampInto = (out: Cell[], rows: readonly string[], x: number, y: number) => {
  for (const [dy, row] of rows.entries())
    for (const [dx, ch] of [...row].entries()) if (ch === '#') out.push([x + dx, y + dy])
}

/** Brings an eye's lids in: drops its top `lids` share of rows and its bottom `lower` share, shut to a line at most. */
function lidded(cells: Cell[], lids: number, lower: number): Cell[] {
  if (cells.length === 0 || (lids <= 0 && lower <= 0)) return cells
  const ys = cells.map(([, y]) => y)
  const xs = cells.map(([x]) => x)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  const h = bottom - top + 1
  const from = top + Math.round(Math.max(0, lids) * h)
  const to = bottom - Math.round(Math.max(0, lower) * h)
  const kept = cells.filter(([, y]) => y >= from && y <= to)
  if (kept.length > 0) return kept
  const line: Cell[] = []
  const y = Math.min(bottom, Math.max(top, from))
  for (let x = Math.min(...xs); x <= Math.max(...xs); x++) line.push([x, y])
  return line
}

/**
 * The cells a face's two eyes light, for a mood. `tweak` changes them for a frame of a clip or a touch: their shape,
 * where each looks, their lids, a squash or stretch, a shift past the edges, or only the rows a scanline has reached.
 */
export function eyeCells(
  mood: Mood,
  cols: number,
  rows: number,
  frame: number,
  blinking: boolean,
  look: readonly [number, number],
  style: EyeStyle = 'round',
  tweak: EyeTweak = {},
): Cell[] {
  const m = tweak.mood ?? mood
  const ew = Math.max(1, Math.round(cols * 0.24))
  const eh = Math.max(2, Math.round(rows * 0.46))
  // Keep the pair dead center: the leftover columns must split evenly on both sides.
  const spread = Math.max(1, Math.round(cols * 0.16))
  const between = (cols - ew * 2 - spread) % 2 === 0 ? spread : spread + 1
  const top = Math.round((rows - eh) / 2)
  const left = Math.floor((cols - (ew * 2 + between)) / 2)
  const scan = {
    thinking: [0, 0, -1, -1, 0, 1, 1, 0][frame % 8] ?? 0,
    working: [-1, 0, 1, 0][frame % 4] ?? 0,
  }
  const open = OPEN.has(m)
  const stretch = Math.max(-(eh - 1), Math.min(ew - 1, Math.round(tweak.stretch ?? 0)))
  const w = ew - stretch
  const shift = tweak.shift ?? [0, 0]
  const out: Cell[] = []
  // Narrow eyes stand a cell taller, so they read as ovals rather than slits.
  const narrow = style === 'tall' && w >= 3
  for (const [eye, base] of [left, left + ew + between].entries()) {
    const side = eye as 0 | 1
    const l = tweak.looks?.[side] ?? tweak.look ?? look
    const dx = m === 'thinking' ? scan.thinking : m === 'working' ? scan.working : open ? l[0] : 0
    const dy =
      m === 'thinking'
        ? -Math.min(1, Math.floor(rows / 8))
        : m === 'listening'
          ? Math.min(1, Math.floor(rows / 6)) + Math.min(0, l[1])
          : open
            ? l[1]
            : 0
    // A squashed or stretched eye stays centred on its pair's middle: the odd cell goes to the inner side.
    const x0 = base + dx + shift[0] + (side === 0 ? Math.ceil(stretch / 2) : Math.floor(stretch / 2))
    const y0 = top + dy + shift[1] - Math.ceil(stretch / 2)
    const h = eh + stretch
    const mid = y0 + Math.floor(h / 2)
    const cells: Cell[] = []
    const line = (y: number) => {
      for (let i = 0; i < w; i++) cells.push([x0 + i, y])
    }
    const blob = (yStart: number, yEnd: number) => {
      const xs = narrow ? x0 + 1 : x0
      const xe = narrow ? x0 + w - 1 : x0 + w
      const ys = narrow ? yStart - 1 : yStart
      for (let y = ys; y < yEnd; y++) {
        for (let x = xs; x < xe; x++) {
          const corner =
            xe - xs >= 4 && yEnd - ys >= 4 && (x === xs || x === xe - 1) && (y === ys || y === yEnd - 1)
          if (!corner) cells.push([x, y])
        }
      }
      if (style === 'lashes') cells.push(side === 0 ? [xs - 1, ys - 1] : [xe, ys - 1])
    }
    const arc = () => {
      // ^ ^ : each eye becomes an upturned arc.
      const aw = Math.max(3, w)
      for (let i = 0; i < aw; i++) cells.push([x0 + i, mid - Math.min(i, aw - 1 - i)])
    }
    const cross = () => {
      const s = Math.max(3, Math.min(w + 1, h))
      const sy = mid - Math.floor(s / 2)
      for (let i = 0; i < s; i++) cells.push([x0 + i, sy + i], [x0 + s - 1 - i, sy + i])
    }
    // Pictures one cell wider than an eye shift outward, so the pair stays symmetric.
    const wide = (pic: readonly string[], y = y0) => stampInto(cells, pic, side === 0 ? x0 - 1 : x0, y)
    const shape = forEye(tweak.shape, side)
    const resting = m === 'idle' || m === 'listening'
    if (shape === 'open') blob(y0, y0 + h)
    else if (shape === 'closed') line(mid)
    else if (shape === 'arc') arc()
    else if (shape === 'x') cross()
    else if (shape === 'heart') wide(HEART)
    else if (shape === 'star') wide(STAR, y0 - 1)
    else if (shape === 'sparkle') wide(SPARKLE, y0 - 1)
    // The left eye turns clockwise, the right the other way, as cartoon dizzy eyes do.
    else if (shape === 'spiral')
      wide(rotate(SPIRAL, side === 0 ? (tweak.turn ?? 0) : -(tweak.turn ?? 0)), y0 - 1)
    else if (shape === 'bang') stampInto(cells, BANG, x0 + Math.floor((w - 2) / 2), y0 - 1)
    else if (shape === 'ask') stampInto(cells, ASK, x0, y0 - 1)
    else if (m === 'happy' || (m === 'love' && ew < 4) || (style === 'happy' && resting && !blinking)) arc()
    else if (m === 'error') cross()
    else if (m === 'sleep') line(y0 + h - 2)
    else if (m === 'love') wide(HEART)
    else if (blinking || (m === 'wink' && side === 1)) line(mid)
    else if (m === 'surprised') blob(y0 - 1, y0 + h + 1)
    else if (m === 'working') {
      const hh = Math.max(2, Math.round(h * 0.62))
      const ys = y0 + Math.floor((h - hh) / 2)
      blob(ys, ys + hh)
    } else if (m === 'waiting' || (style === 'sleepy' && m === 'idle')) blob(mid, y0 + h)
    else blob(y0, y0 + h)
    out.push(...lidded(cells, forEye(tweak.lids, side) ?? 0, forEye(tweak.lower, side) ?? 0))
  }
  return tweak.reveal === undefined ? out : out.filter(([, y]) => y < (tweak.reveal ?? rows))
}

/** Letters five cells tall, for spelling in a face's own screen cells; most are three wide. */
const SCREEN_GLYPHS: Record<string, readonly string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],
  ' ': ['..', '..', '..', '..', '..'],
  '.': ['.', '.', '.', '.', '#'],
  ',': ['..', '..', '..', '.#', '#.'],
  ':': ['.', '#', '.', '#', '.'],
  ';': ['..', '.#', '..', '.#', '#.'],
  '!': ['#', '#', '#', '.', '#'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
  "'": ['#', '#', '.', '.', '.'],
  '"': ['#.#', '#.#', '...', '...', '...'],
  '-': ['...', '...', '###', '...', '...'],
  _: ['...', '...', '...', '...', '###'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  '=': ['...', '###', '...', '###', '...'],
  '*': ['...', '#.#', '.#.', '#.#', '...'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  '(': ['.#', '#.', '#.', '#.', '.#'],
  ')': ['#.', '.#', '.#', '.#', '#.'],
  '#': ['#.#', '###', '#.#', '###', '#.#'],
  '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  '@': ['.#.', '#.#', '#.#', '#..', '.##'],
}
const SCREEN_GLYPH_ROWS = 5

/**
 * The cells that spell `text` on a face's screen, letter by letter in its own cells, then the cursor bar: only the
 * last letters that fit inside a one-cell margin, never scrolled or shrunk. Accents are dropped; other characters
 * read as spaces.
 */
export function textCells(text: string, cols: number, rows: number, cursor: boolean): Cell[] {
  const room = cols - 2
  const shown: (readonly string[])[] = []
  let used = 1
  const chars = [...text.toUpperCase()]
  for (let i = chars.length - 1; i >= 0; i--) {
    const base = chars[i]?.normalize('NFD')[0] ?? ' '
    const glyph = SCREEN_GLYPHS[base] ?? (SCREEN_GLYPHS[' '] as readonly string[])
    const width = (glyph[0]?.length ?? 0) + 1
    if (used + width > room) break
    shown.unshift(glyph)
    used += width
  }
  const top = Math.floor((rows - SCREEN_GLYPH_ROWS) / 2)
  const out: Cell[] = []
  let x = 1
  for (const glyph of shown) {
    for (const [y, row] of glyph.entries())
      for (const [dx, ch] of [...row].entries()) if (ch === '#') out.push([x + dx, top + y])
    x += (glyph[0]?.length ?? 0) + 1
  }
  if (cursor) for (let y = 0; y < SCREEN_GLYPH_ROWS; y++) out.push([x, top + y])
  return out
}

const TICK: Record<Mood, number> = {
  idle: 0,
  wink: 0,
  surprised: 0,
  love: 0,
  listening: 0,
  waiting: 0,
  sleep: 0,
  happy: 0,
  error: 0,
  thinking: 520,
  working: 260,
}

/**
 * The agent "personality": two eyes on a dot-matrix screen, expressing what the agent is doing.
 * Rendered as SVG cells so it stays crisp at any size.
 */
export function PixelFace(props: {
  mood: Mood
  color: string
  cols?: number
  rows?: number
  /** Cell size in px. */
  cell?: number
  gap?: number
  className?: string
  glow?: boolean
  /** Where the eyes look, in cells (x, y). Omit to let an idle face glance around on its own. */
  look?: readonly [number, number]
  eyes?: EyeStyle
  /** Spells this on the screen in place of the eyes (its end, as much as fits), with a blinking cursor bar. */
  text?: string
  /** Changes to how the eyes are drawn, such as a squash while they are dragged; a clip's frames change them further. */
  tweak?: EyeTweak
  /** An animation to play in the screen's cells (not with reduced motion); `playId` names one playing of it. */
  clip?: Clip
  playId?: string | number
  /** A clip that does not loop has shown its last frame. */
  onClipEnd?: () => void
}) {
  const cols = props.cols ?? 9
  const rows = props.rows ?? 7
  const cell = props.cell ?? 4
  const gap = props.gap ?? Math.max(1, Math.round(cell * 0.28))
  const reduce = useReducedMotionConfig()
  const [frame, setFrame] = useState(0)
  const [blinking, setBlinking] = useState(false)
  const [glance, setGlance] = useState<readonly [number, number]>([0, 0])
  const following = props.look !== undefined

  // Idle faces glance around now and then, so the screen never looks frozen.
  useEffect(() => {
    if (reduce || following || (props.mood !== 'idle' && props.mood !== 'waiting')) return
    const spots = [
      [0, 0],
      [0, 0],
      [-1, 0],
      [1, 0],
      [-1, -1],
      [1, -1],
      [0, -1],
    ] as const
    let timer: ReturnType<typeof setTimeout>
    const next = () => {
      timer = setTimeout(
        () => {
          setGlance(spots[Math.floor(Math.random() * spots.length)] ?? [0, 0])
          next()
        },
        1600 + Math.random() * 2600,
      )
    }
    next()
    return () => {
      clearTimeout(timer)
      setGlance([0, 0])
    }
  }, [props.mood, reduce, following])

  useEffect(() => {
    const ms = TICK[props.mood]
    if (!ms || reduce) return
    const t = setInterval(() => setFrame((f) => f + 1), ms)
    return () => clearInterval(t)
  }, [props.mood, reduce])

  useEffect(() => {
    if (reduce || !['idle', 'listening', 'thinking', 'working', 'waiting'].includes(props.mood)) return
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      timer = setTimeout(
        () => {
          setBlinking(true)
          timer = setTimeout(() => {
            setBlinking(false)
            schedule()
          }, 140)
        },
        2200 + Math.random() * 3200,
      )
    }
    schedule()
    return () => clearTimeout(timer)
  }, [props.mood, reduce])

  // The cursor shows at once on every change, then blinks while the text stays put.
  const [cursorOn, setCursorOn] = useState(true)
  const spelling = props.text !== undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new text restarts the blink
  useEffect(() => {
    setCursorOn(true)
    if (!spelling || reduce) return
    const t = setInterval(() => setCursorOn((on) => !on), MASCOT_TYPING.blinkMs)
    return () => clearInterval(t)
  }, [props.text, spelling, reduce])

  const shown = useClip(props.clip, props.playId ?? props.clip?.name, reduce ?? false, props.onClipEnd)
  const lookX = props.look?.[0] ?? glance[0]
  const lookY = props.look?.[1] ?? glance[1]
  // Each lit cell's fill: the face's colour, a dot's own colour, or a dot's level of the face's colour.
  const lit = useMemo(() => {
    const fills = new Map<string, string>()
    const paint = ([x, y, ink]: Dot) => {
      if (x < 0 || y < 0 || x >= cols || y >= rows) return
      const fill =
        ink === undefined
          ? props.color
          : typeof ink === 'string'
            ? ink
            : `color-mix(in srgb, ${props.color} ${Math.round(Math.max(0, Math.min(1, ink)) * 100)}%, var(--screen-cell))`
      fills.set(`${x},${y}`, fill)
    }
    if (props.text !== undefined) {
      for (const c of textCells(props.text, cols, rows, cursorOn)) paint(c)
      return fills
    }
    if (shown?.eyes !== null) {
      const tweak = { ...props.tweak, ...shown?.eyes }
      const blink = blinking && forEye(tweak.shape, 0) === undefined
      for (const c of eyeCells(props.mood, cols, rows, frame, blink, [lookX, lookY], props.eyes, tweak))
        paint(c)
    }
    for (const d of shown?.dots ?? []) paint(d)
    return fills
  }, [
    props.mood,
    props.text,
    props.color,
    props.tweak,
    shown,
    cursorOn,
    cols,
    rows,
    frame,
    blinking,
    lookX,
    lookY,
    props.eyes,
  ])

  const w = cols * cell + (cols - 1) * gap
  const h = rows * cell + (rows - 1) * gap
  const r = cell * 0.3
  const cells = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      cells.push(
        <rect
          key={`${x},${y}`}
          x={x * (cell + gap)}
          y={y * (cell + gap)}
          width={cell}
          height={cell}
          rx={r}
          style={{
            fill: lit.get(`${x},${y}`) ?? 'var(--screen-cell)',
            // A clip sets its own pace; the fade would smear its frames together.
            transition: shown ? 'fill 60ms linear' : 'fill 180ms ease-out',
          }}
        />,
      )
    }
  }
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={props.className}
      data-typed={spelling || undefined}
      data-clip={shown ? props.clip?.name : undefined}
      style={
        props.glow
          ? {
              filter: `drop-shadow(0 0 ${Math.min(cell * 1.4, 18)}px ${props.color}66)`,
            }
          : undefined
      }
      aria-hidden
    >
      {cells}
    </svg>
  )
}

/**
 * The avatar used for agents everywhere: the lead (and the judge) get a face on a small dark screen, like the
 * mascot; workers get their own character.
 */
export function AgentAvatar(props: {
  name: string
  status: string
  size?: number
  className?: string
  /** Never doze: for avatars that label a message or event rather than show a live agent. */
  awake?: boolean
}) {
  if (props.name !== 'lead' && props.name !== 'judge') return <AgentCharacter {...props} />
  return <ScreenAvatar {...props} />
}

function ScreenAvatar(props: {
  name: string
  status: string
  size?: number
  className?: string
  awake?: boolean
}) {
  const size = props.size ?? 32
  const mood = useAgentMood(props.status, props.awake)
  const cols = 7
  const rows = 7
  const pad = size * 0.16
  const cell = (size - pad * 2) / (cols + (cols - 1) * 0.3)
  return (
    <span
      className={cn('relative inline-grid shrink-0 place-items-center bg-screen', props.className)}
      style={{ width: size, height: size, borderRadius: size * 0.3 }}
      title={`${props.name} · ${props.status}`}
      aria-hidden
    >
      <PixelFace
        mood={mood}
        color={agentColor(props.name)}
        cols={cols}
        rows={rows}
        cell={cell}
        gap={cell * 0.3}
      />
      {mood === 'sleep' && size >= 28 && <Snore size={size} />}
    </span>
  )
}

/* ------------------------------------------------------------------ pixel sprites */

/** Small pictures drawn in the screen's own dots: each letter names a colour in the sprite's palette, `.` is empty. */
export interface Sprite {
  readonly rows: readonly string[]
  readonly palette: Readonly<Record<string, string>>
}

/** A blossom of four petals around a yellow heart, for the mascot's top-right corner. */
export const FLOWER: Sprite = {
  rows: ['.pp.pp.', 'ppppppp', 'pppyppp', '.pyyyp.', 'pppyppp', 'ppppppp', '.pp.pp.'],
  palette: { p: '#ff8fc0', y: '#ffd34d' },
}

/** A bow tie, worn under the screen. */
export const BOW: Sprite = {
  rows: ['##.....##', '###.k.###', '####k####', '###.k.###', '##.....##'],
  palette: { '#': '#4f7df0', k: '#2f55b8' },
}

export function PixelSprite(props: { sprite: Sprite; cell: number; gap?: number; className?: string }) {
  const { sprite, cell } = props
  const gap = props.gap ?? Math.max(1, Math.round(cell * 0.28))
  const cols = Math.max(...sprite.rows.map((r) => r.length))
  const w = cols * cell + (cols - 1) * gap
  const h = sprite.rows.length * cell + (sprite.rows.length - 1) * gap
  const cells = []
  for (let y = 0; y < sprite.rows.length; y++) {
    for (let x = 0; x < cols; x++) {
      const fill = sprite.palette[sprite.rows[y]?.[x] ?? '.']
      if (fill)
        cells.push(
          <rect
            key={`${x},${y}`}
            x={x * (cell + gap)}
            y={y * (cell + gap)}
            width={cell}
            height={cell}
            rx={cell * 0.3}
            fill={fill}
          />,
        )
    }
  }
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={props.className} aria-hidden>
      {cells}
    </svg>
  )
}

/* ------------------------------------------------------------------ dot-matrix type */

const GLYPHS: Record<string, string[]> = {
  '0': [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  '2': [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
  '3': ['#####', '   # ', '  #  ', '   # ', '    #', '#   #', ' ### '],
  '4': ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # '],
  '5': ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  '6': ['  ## ', ' #   ', '#    ', '#### ', '#   #', '#   #', ' ### '],
  '7': ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  '8': [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
  '9': [' ### ', '#   #', '#   #', ' ####', '    #', '   # ', ' ##  '],
  ':': [' ', ' ', '#', ' ', '#', ' ', ' '],
  '.': [' ', ' ', ' ', ' ', ' ', ' ', '#'],
  '-': ['   ', '   ', '   ', '###', '   ', '   ', '   '],
  '/': ['    #', '    #', '   # ', '  #  ', ' #   ', '#    ', '#    '],
  '%': ['##  #', '##  #', '   # ', '  #  ', ' #   ', '#  ##', '#  ##'],
  ' ': ['  ', '  ', '  ', '  ', '  ', '  ', '  '],
  K: ['#   #', '#  # ', '# #  ', '##   ', '# #  ', '#  # ', '#   #'],
  M: ['#   #', '## ##', '# # #', '# # #', '#   #', '#   #', '#   #'],
  S: [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '],
  H: ['#   #', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  B: ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
  A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  C: [' ### ', '#   #', '#    ', '#    ', '#    ', '#   #', ' ### '],
  D: ['#### ', '#   #', '#   #', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
  F: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#    '],
  G: [' ### ', '#   #', '#    ', '# ###', '#   #', '#   #', ' ####'],
  I: ['###', ' # ', ' # ', ' # ', ' # ', ' # ', '###'],
  J: ['  ###', '   # ', '   # ', '   # ', '   # ', '#  # ', ' ##  '],
  L: ['#    ', '#    ', '#    ', '#    ', '#    ', '#    ', '#####'],
  N: ['#   #', '#   #', '##  #', '# # #', '#  ##', '#   #', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#   #', '#### ', '#    ', '#    ', '#    '],
  Q: [' ### ', '#   #', '#   #', '#   #', '# # #', '#  # ', ' ## #'],
  R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  '],
  W: ['#   #', '#   #', '#   #', '# # #', '# # #', '# # #', ' # # '],
  X: ['#   #', '#   #', ' # # ', '  #  ', ' # # ', '#   #', '#   #'],
  Y: ['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  '],
  Z: ['#####', '    #', '   # ', '  #  ', ' #   ', '#    ', '#####'],
  "'": ['#', '#', ' ', ' ', ' ', ' ', ' '],
  '?': [' ### ', '#   #', '    #', '   # ', '  #  ', '     ', '  #  '],
  '!': ['#', '#', '#', '#', '#', ' ', '#'],
  ',': ['  ', '  ', '  ', '  ', '  ', ' #', '# '],
}

/** Numbers and short labels set in a 5×7 dot-matrix face, like an LED readout. */
export function DotMatrix(props: {
  text: string
  /** Dot diameter in px. */
  dot?: number
  className?: string
  style?: CSSProperties
  /** Draws unlit dots faintly, like a real panel. */
  ghost?: boolean
}) {
  const dot = props.dot ?? 3
  const pitch = dot * 1.45
  const glyphs = [...props.text.toUpperCase()].map((ch) => GLYPHS[ch] ?? (GLYPHS[' '] as string[]))
  let x = 0
  const dots = []
  for (const [gi, g] of glyphs.entries()) {
    const width = g[0]?.length ?? 0
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < width; col++) {
        const on = g[row]?.[col] === '#'
        if (!on && !props.ghost) continue
        dots.push(
          <circle
            key={`${gi}-${row}-${col}`}
            cx={x + col * pitch + dot / 2}
            cy={row * pitch + dot / 2}
            r={dot / 2}
            fill="currentColor"
            opacity={on ? 1 : 0.1}
          />,
        )
      }
    }
    x += width * pitch + pitch
  }
  const w = Math.max(0, x - pitch)
  const h = 6 * pitch + dot
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={props.className}
      style={props.style}
      role="img"
      aria-label={props.text}
    >
      {dots}
    </svg>
  )
}

/** Inline agent chip for lists: mini face + name, tinted with the agent's color. */
export function AgentChip(props: {
  name: string
  status: string
  detail?: string
  active?: boolean
  onClick?: () => void
}) {
  const color = agentColor(props.name)
  return (
    <motion.button
      type="button"
      onClick={props.onClick}
      aria-label={copy.agentChip.label(props.name)}
      layout
      initial={{ opacity: 0, scale: 0.3 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={popSpring}
      className="inline-flex items-center gap-2 rounded-full border border-line bg-surface py-0.5 pl-0.5 pr-3 text-small transition-colors hover:border-line-strong hover:bg-fill"
      style={props.active ? { borderColor: `${color}88`, boxShadow: `0 0 0 3px ${color}22` } : undefined}
      title={props.detail}
    >
      <AgentAvatar name={props.name} status={props.status} size={22} />
      <span className="font-semibold">{props.name}</span>
      {props.detail && <span className="max-w-40 truncate text-muted">{props.detail}</span>}
    </motion.button>
  )
}
