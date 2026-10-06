import { motion, useReducedMotion } from 'motion/react'
import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { cn } from './primitives.tsx'

/* ------------------------------------------------------------------ identity */

/** Lead is signal amber, the judge lime, the user ultramarine; workers get a stable color from their call sign. */
const WORKER_COLORS = ['#ff7eb6', '#4d7cff', '#a374ff', '#19c3e6', '#ff6a3d', '#2ed3a0', '#c6f432', '#ff9f43']
export const LEAD_COLOR = '#ffb31a'
export const JUDGE_COLOR = '#d4ff3a'
export const USER_COLOR = '#3434f0'

export function agentColor(name: string): string {
  if (name === 'lead') return LEAD_COLOR
  if (name === 'judge' || name.startsWith('verifier')) return JUDGE_COLOR
  if (name === 'user' || name === 'You') return USER_COLOR
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return WORKER_COLORS[h % WORKER_COLORS.length] as string
}

/** Dark or light text, whichever reads on the given fill. */
export function inkOn(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return lum > 0.6 ? '#0b0b0d' : '#ffffff'
}

/* ------------------------------------------------------------------ pixel face */

/** `listening`: eyes lowered toward the message box while the user types. */
export type Mood = 'idle' | 'listening' | 'thinking' | 'working' | 'happy' | 'error' | 'sleep' | 'waiting'

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

type Cell = readonly [number, number]

function eyeCells(
  mood: Mood,
  cols: number,
  rows: number,
  frame: number,
  blinking: boolean,
  glance: readonly [number, number],
): Cell[] {
  const ew = Math.max(1, Math.round(cols * 0.24))
  const eh = Math.max(2, Math.round(rows * 0.46))
  const between = Math.max(1, Math.round(cols * 0.16))
  const top = Math.round((rows - eh) / 2)
  const left = Math.floor((cols - (ew * 2 + between)) / 2)
  const look = {
    thinking: [0, 0, -1, -1, 0, 1, 1, 0][frame % 8] ?? 0,
    working: [-1, 0, 1, 0][frame % 4] ?? 0,
  }
  const idle = mood === 'idle' || mood === 'waiting'
  const dx = mood === 'thinking' ? look.thinking : mood === 'working' ? look.working : idle ? glance[0] : 0
  const dy =
    mood === 'thinking'
      ? -Math.min(1, Math.floor(rows / 8))
      : mood === 'listening'
        ? Math.min(1, Math.floor(rows / 6))
        : idle
          ? glance[1]
          : 0
  const out: Cell[] = []
  for (const x0 of [left + dx, left + ew + between + dx]) {
    const y0 = top + dy
    const mid = y0 + Math.floor(eh / 2)
    if (mood === 'happy') {
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
    if (mood === 'sleep' || blinking) {
      for (let i = 0; i < ew; i++) out.push([x0 + i, mood === 'sleep' ? y0 + eh - 2 : mid])
      continue
    }
    const h = mood === 'working' ? Math.max(2, Math.round(eh * 0.62)) : eh
    const yStart = mood === 'waiting' ? mid : mood === 'working' ? y0 + Math.floor((eh - h) / 2) : y0
    const yEnd = mood === 'waiting' ? y0 + eh : yStart + h
    for (let y = yStart; y < yEnd; y++) {
      for (let x = x0; x < x0 + ew; x++) {
        const corner =
          ew >= 4 && yEnd - yStart >= 4 && (x === x0 || x === x0 + ew - 1) && (y === yStart || y === yEnd - 1)
        if (!corner) out.push([x, y])
      }
    }
  }
  return out
}

const TICK: Record<Mood, number> = {
  idle: 0,
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
}) {
  const cols = props.cols ?? 9
  const rows = props.rows ?? 7
  const cell = props.cell ?? 4
  const gap = props.gap ?? Math.max(1, Math.round(cell * 0.28))
  const reduce = useReducedMotion()
  const [frame, setFrame] = useState(0)
  const [blinking, setBlinking] = useState(false)
  const [glance, setGlance] = useState<readonly [number, number]>([0, 0])

  // Idle faces glance around now and then, so the screen never looks frozen.
  useEffect(() => {
    if (reduce || (props.mood !== 'idle' && props.mood !== 'waiting')) return
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
  }, [props.mood, reduce])

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

  const lit = useMemo(() => {
    const set = new Set<string>()
    for (const [x, y] of eyeCells(props.mood, cols, rows, frame, blinking, glance))
      if (x >= 0 && y >= 0 && x < cols && y < rows) set.add(`${x},${y}`)
    return set
  }, [props.mood, cols, rows, frame, blinking, glance])

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
          style={{ fill: on ? props.color : 'var(--screen-cell)', transition: 'fill 90ms linear' }}
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
        props.glow ? { filter: `drop-shadow(0 0 ${Math.min(cell * 1.4, 18)}px ${props.color}66)` } : undefined
      }
      aria-hidden
    >
      {cells}
    </svg>
  )
}

/** A face on a small dark screen tile: the avatar used for agents everywhere. */
export function AgentAvatar(props: { name: string; status: string; size?: number; className?: string }) {
  const size = props.size ?? 32
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
        mood={moodFor(props.status)}
        color={agentColor(props.name)}
        cols={cols}
        rows={rows}
        cell={cell}
        gap={cell * 0.3}
      />
    </span>
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

/* ------------------------------------------------------------------ cursors */

/** The rounded pointer from collaborative design tools. */
export function CursorArrow({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden className="shrink-0">
      <path
        d="M3.1 2.2c-.5-.4-1.2 0-1.1.7l2.3 14.6c.1.7 1 .9 1.4.3l2.9-4.3c.2-.3.5-.5.9-.5l5.2-.2c.7 0 1-.9.5-1.4L3.1 2.2Z"
        fill={color}
        stroke="white"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A named cursor: pointer plus a colored pill, the way collaborators appear on a shared canvas. */
export function CursorPill(props: {
  name: string
  color?: string
  className?: string
  size?: 'sm' | 'md' | 'lg'
  face?: string
}) {
  const color = props.color ?? agentColor(props.name)
  const size = props.size ?? 'sm'
  return (
    <span className={cn('pointer-events-none inline-flex select-none flex-col items-start', props.className)}>
      <CursorArrow color={color} size={size === 'lg' ? 26 : size === 'md' ? 20 : 16} />
      <span
        className={cn(
          'ml-3 -mt-1 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-semibold shadow-card',
          size === 'lg'
            ? 'px-4 py-1.5 text-[15px]'
            : size === 'md'
              ? 'px-3 py-1 text-[13px]'
              : 'px-2.5 py-0.5 text-[11.5px]',
        )}
        style={{ background: color, color: inkOn(color) }}
      >
        {props.name}
      </span>
    </span>
  )
}

/** Inline agent chip for lists: mini face + name, tinted with the agent's color. */
export function AgentChip(props: { name: string; status: string; detail?: string; active?: boolean }) {
  const color = agentColor(props.name)
  return (
    <motion.span
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="inline-flex items-center gap-2 rounded-full border border-line bg-surface py-0.5 pl-0.5 pr-3 text-[12px]"
      style={props.active ? { borderColor: `${color}88`, boxShadow: `0 0 0 3px ${color}22` } : undefined}
      title={props.detail}
    >
      <AgentAvatar name={props.name} status={props.status} size={22} />
      <span className="font-semibold">{props.name}</span>
      {props.detail && <span className="max-w-40 truncate text-muted">{props.detail}</span>}
    </motion.span>
  )
}
