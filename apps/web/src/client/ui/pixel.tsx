import { identityOf } from '@myrmidon/protocol'
import { motion, useReducedMotion } from 'motion/react'
import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { copy } from '../copy.ts'
import { AGENT_DOZE_MS } from '../ui-config.ts'
import { AgentCharacter } from './crew.tsx'
import { cn } from './primitives.tsx'

export { JUDGE_COLOR, LEAD_COLOR, USER_COLOR } from '@myrmidon/protocol'

/* ------------------------------------------------------------------ identity */

/** Lead is signal amber, the judge lime, the user ultramarine; each worker owns a palette colour. */
export function agentColor(name: string): string {
  return identityOf(name).color
}

/** Dark or light text, whichever reads on the given fill. */
export function inkOn(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return lum > 0.6 ? 'var(--on-bright)' : 'var(--on-deep)'
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
  const reduce = useReducedMotion()
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

type Cell = readonly [number, number]

/**
 * The resting shape of the mascot's eyes, chosen in Settings: `happy` rests as arcs, `tall` as narrow ovals, `sleepy`
 * half-lidded, `lashes` round with a lash at each outer corner. Moods still change them.
 */
export type EyeStyle = 'round' | 'happy' | 'tall' | 'sleepy' | 'lashes'

const HEART = ['.#.#.', '#####', '.###.', '..#..']

/** Moods whose eyes are open and can follow something. */
const OPEN: ReadonlySet<Mood> = new Set(['idle', 'listening', 'waiting', 'wink', 'surprised', 'love'])

function eyeCells(
  mood: Mood,
  cols: number,
  rows: number,
  frame: number,
  blinking: boolean,
  look: readonly [number, number],
  style: EyeStyle = 'round',
): Cell[] {
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
  const open = OPEN.has(mood)
  const dx = mood === 'thinking' ? scan.thinking : mood === 'working' ? scan.working : open ? look[0] : 0
  const dy =
    mood === 'thinking'
      ? -Math.min(1, Math.floor(rows / 8))
      : mood === 'listening'
        ? Math.min(1, Math.floor(rows / 6)) + Math.min(0, look[1])
        : open
          ? look[1]
          : 0
  const out: Cell[] = []
  const line = (x0: number, y: number) => {
    for (let i = 0; i < ew; i++) out.push([x0 + i, y])
  }
  // Narrow eyes stand a cell taller, so they read as ovals rather than slits.
  const narrow = style === 'tall' && ew >= 3
  const blob = (x0: number, yStart: number, yEnd: number, eye?: number) => {
    const xs = narrow ? x0 + 1 : x0
    const xe = narrow ? x0 + ew - 1 : x0 + ew
    const ys = narrow ? yStart - 1 : yStart
    for (let y = ys; y < yEnd; y++) {
      for (let x = xs; x < xe; x++) {
        const corner =
          xe - xs >= 4 && yEnd - ys >= 4 && (x === xs || x === xe - 1) && (y === ys || y === yEnd - 1)
        if (!corner) out.push([x, y])
      }
    }
    if (style === 'lashes' && eye !== undefined) out.push(eye === 0 ? [xs - 1, ys - 1] : [xe, ys - 1])
  }
  for (const [eye, base] of [left, left + ew + between].entries()) {
    const x0 = base + dx
    const y0 = top + dy
    const mid = y0 + Math.floor(eh / 2)
    const resting = mood === 'idle' || mood === 'listening'
    if (mood === 'happy' || (mood === 'love' && ew < 4) || (style === 'happy' && resting && !blinking)) {
      // ^ ^ : each eye becomes an upturned arc.
      const aw = Math.max(3, ew)
      for (let i = 0; i < aw; i++) out.push([x0 + i, mid - Math.min(i, aw - 1 - i)])
      continue
    }
    if (mood === 'error') {
      const s = Math.max(3, Math.min(ew + 1, eh))
      const sy = mid - Math.floor(s / 2)
      for (let i = 0; i < s; i++) out.push([x0 + i, sy + i], [x0 + s - 1 - i, sy + i])
      continue
    }
    if (mood === 'sleep') {
      line(x0, y0 + eh - 2)
      continue
    }
    if (mood === 'love') {
      // Hearts are one cell wider than an eye; shift them outward so the pair stays symmetric.
      const hx = eye === 0 ? x0 - 1 : x0
      for (const [ry, row] of HEART.entries())
        for (const [rx, ch] of [...row].entries()) if (ch === '#') out.push([hx + rx, y0 + ry])
      continue
    }
    if (blinking || (mood === 'wink' && eye === 1)) {
      line(x0, mid)
      continue
    }
    if (mood === 'surprised') {
      blob(x0, y0 - 1, y0 + eh + 1, eye)
      continue
    }
    if (mood === 'working') {
      const h = Math.max(2, Math.round(eh * 0.62))
      const ys = y0 + Math.floor((eh - h) / 2)
      blob(x0, ys, ys + h, eye)
      continue
    }
    if (mood === 'waiting' || (style === 'sleepy' && mood === 'idle')) {
      blob(x0, mid, y0 + eh, eye)
      continue
    }
    blob(x0, y0, y0 + eh, eye)
  }
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
}) {
  const cols = props.cols ?? 9
  const rows = props.rows ?? 7
  const cell = props.cell ?? 4
  const gap = props.gap ?? Math.max(1, Math.round(cell * 0.28))
  const reduce = useReducedMotion()
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

  const lookX = props.look?.[0] ?? glance[0]
  const lookY = props.look?.[1] ?? glance[1]
  const lit = useMemo(() => {
    const set = new Set<string>()
    for (const [x, y] of eyeCells(props.mood, cols, rows, frame, blinking, [lookX, lookY], props.eyes))
      if (x >= 0 && y >= 0 && x < cols && y < rows) set.add(`${x},${y}`)
    return set
  }, [props.mood, cols, rows, frame, blinking, lookX, lookY, props.eyes])

  const w = cols * cell + (cols - 1) * gap
  const h = rows * cell + (rows - 1) * gap
  const r = cell * 0.3
  const cells = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const on = lit.has(`${x},${y}`)
      cells.push(
        <rect
          key={`${x},${y}`}
          x={x * (cell + gap)}
          y={y * (cell + gap)}
          width={cell}
          height={cell}
          rx={r}
          style={{
            fill: on ? props.color : 'var(--screen-cell)',
            transition: 'fill 180ms ease-out',
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
      transition={{ type: 'spring', stiffness: 520, damping: 17 }}
      className="inline-flex items-center gap-2 rounded-full border border-line bg-surface py-0.5 pl-0.5 pr-3 text-[12px] transition-colors hover:border-line-strong hover:bg-surface-2"
      style={props.active ? { borderColor: `${color}88`, boxShadow: `0 0 0 3px ${color}22` } : undefined}
      title={props.detail}
    >
      <AgentAvatar name={props.name} status={props.status} size={22} />
      <span className="font-semibold">{props.name}</span>
      {props.detail && <span className="max-w-40 truncate text-muted">{props.detail}</span>}
    </motion.button>
  )
}
