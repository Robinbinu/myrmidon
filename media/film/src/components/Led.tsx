import { type CSSProperties, useId } from 'react'
import { C, MONO } from '../theme.ts'

export type Cell = readonly [number, number]
export type EyeMood = 'open' | 'happy' | 'wink' | 'closed' | 'worried' | 'wide' | 'squint'

export interface EyeState {
  look?: readonly [number, number]
  blink?: boolean
  mood?: EyeMood
}

/**
 * The cells a face's two eyes light, following the app's eyeCells (apps/web/src/client/ui/pixel.tsx): two blobs
 * with their corners off, centred on the grid, that look about, blink to a line, arc when happy and wink.
 */
export function eyeCells(cols: number, rows: number, state: EyeState = {}): Cell[] {
  const mood = state.mood ?? 'open'
  const ew = Math.max(1, Math.round(cols * 0.24))
  const eh = Math.max(2, Math.round(rows * 0.46))
  const spread = Math.max(1, Math.round(cols * 0.16))
  const between = (cols - ew * 2 - spread) % 2 === 0 ? spread : spread + 1
  const top = Math.round((rows - eh) / 2)
  const left = Math.floor((cols - (ew * 2 + between)) / 2)
  const [lx, ly] = state.look ?? [0, 0]
  const out: Cell[] = []
  for (const [side, base] of [left, left + ew + between].entries()) {
    const x0 = base + lx
    const y0 = top + ly
    const mid = y0 + Math.floor(eh / 2)
    const blob = (ys: number, ye: number) => {
      for (let y = ys; y < ye; y++)
        for (let x = x0; x < x0 + ew; x++) {
          const corner = ew >= 4 && ye - ys >= 4 && (x === x0 || x === x0 + ew - 1) && (y === ys || y === ye - 1)
          if (!corner) out.push([x, y])
        }
    }
    const line = (y: number) => {
      for (let x = x0; x < x0 + ew; x++) out.push([x, y])
    }
    if (mood === 'happy') {
      const aw = Math.max(3, ew)
      for (let i = 0; i < aw; i++) out.push([x0 + i, mid - Math.min(i, aw - 1 - i)])
    } else if (state.blink || mood === 'closed' || (mood === 'wink' && side === 1)) line(mid)
    else if (mood === 'worried') blob(mid - 1, y0 + eh)
    else if (mood === 'squint') blob(mid - 1, mid + 1)
    else if (mood === 'wide') blob(y0 - 1, y0 + eh + 1)
    else blob(y0, y0 + eh)
  }
  return out
}

/**
 * The mascot's dot-matrix screen: a dark display of LED cells with two amber eyes, a soft glow under them, and an
 * optional status line, like the new-chat hero.
 */
export function LedScreen(props: {
  cols?: number
  rows?: number
  cell: number
  eyes?: EyeState
  /** Cells to light instead of eyes. */
  cells?: readonly Cell[]
  color?: string
  /** 0..1: the screen booting, row by row. */
  boot?: number
  status?: string
  statusColor?: string
  readout?: string
  bezel?: boolean
  style?: CSSProperties
}) {
  const cols = props.cols ?? 15
  const rows = props.rows ?? 8
  const cell = props.cell
  const gap = cell * 0.3
  const w = cols * cell + (cols - 1) * gap
  const h = rows * cell + (rows - 1) * gap
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const boot = props.boot ?? 1
  const lit = props.cells ?? eyeCells(cols, rows, props.eyes)
  const color = props.color
  const shownRows = boot * rows
  const litSet = new Set(lit.filter(([x, y]) => x >= 0 && y >= 0 && x < cols && y < rows && y < shownRows).map(([x, y]) => `${x},${y}`))
  const unlit = []
  const on = []
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const rowOn = Math.max(0, Math.min(1, shownRows - y))
      const key = `${x},${y}`
      unlit.push(
        <rect
          key={key}
          x={x * (cell + gap)}
          y={y * (cell + gap)}
          width={cell}
          height={cell}
          rx={cell * 0.3}
          fill="#ffffff"
          opacity={0.055 * rowOn}
        />,
      )
      if (litSet.has(key))
        on.push(
          <rect key={key} x={x * (cell + gap)} y={y * (cell + gap)} width={cell} height={cell} rx={cell * 0.3} />,
        )
    }
  const fill = color ?? `url(#eye${id})`
  const pad = cell * 1.5
  const svg = (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} overflow="visible" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={`eye${id}`} x1="0" y1="0" x2="0" y2={h} gradientUnits="userSpaceOnUse">
          <stop offset="0.25" stopColor={C.eyeTop} />
          <stop offset="0.75" stopColor={C.eyeBottom} />
        </linearGradient>
        <filter id={`blur${id}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={cell * 0.75} />
        </filter>
      </defs>
      {unlit}
      <g fill={color ?? C.glow} opacity={0.75} filter={`url(#blur${id})`}>
        {on}
      </g>
      <g fill={fill}>{on}</g>
      {boot < 1 && (
        <rect
          x={-cell * 0.5}
          y={shownRows * (cell + gap) - gap}
          width={w + cell}
          height={2}
          fill={C.eyeTop}
          opacity={0.6}
        />
      )}
    </svg>
  )
  if (props.bezel === false) return <div style={props.style}>{svg}</div>
  return (
    <div
      style={{
        padding: pad,
        paddingBottom: props.status ? pad * 0.6 : pad,
        borderRadius: pad * 1.6,
        background: `radial-gradient(120% 90% at 50% 0%, #121215 0%, ${C.screen} 60%)`,
        boxShadow: '0 0 0 1px rgba(255,255,255,0.07), 0 40px 90px -20px rgba(0,0,0,0.9), inset 0 1px 0 rgba(255,255,255,0.05)',
        ...props.style,
      }}
    >
      {svg}
      {props.status && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: cell * 1.1,
            fontFamily: MONO,
            fontSize: Math.max(12, cell * 0.62),
            letterSpacing: '0.18em',
            color: C.screenInk,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: cell * 0.4 }}>
            <span
              style={{
                width: cell * 0.3,
                height: cell * 0.3,
                borderRadius: 99,
                background: props.statusColor ?? C.ok,
                boxShadow: `0 0 ${cell * 0.4}px ${props.statusColor ?? C.ok}`,
              }}
            />
            {props.status}
          </span>
          {props.readout && <span>{props.readout}</span>}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ the mark */

const PITCH = 7.9
const ORIGIN = -12.55
const DOT = 6.6

/** The logo's eye cells on its 16×16 grid (apps/web/src/client/icon.svg): rows 5–8, columns 3–6 and 9–12. */
function logoEyes(state: EyeState): Cell[] {
  const mood = state.mood ?? 'open'
  const [lx, ly] = state.look ?? [0, 0]
  const out: Cell[] = []
  for (const [side, c0] of [3, 9].entries()) {
    const x0 = c0 + lx
    const y0 = 5 + ly
    if (mood === 'happy') {
      out.push([x0, y0 + 2], [x0 + 1, y0 + 1], [x0 + 2, y0 + 1], [x0 + 3, y0 + 2])
    } else if (state.blink || mood === 'closed' || (mood === 'wink' && side === 1)) {
      for (let i = 0; i < 4; i++) out.push([x0 + i, y0 + 2])
    } else {
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) if (!((x === 0 || x === 3) && (y === 0 || y === 3))) out.push([x0 + x, y0 + y])
    }
  }
  return out
}

/** The Myrmidon mark: amber pixel eyes on a full-bleed LED grid, on a deep black glass tile. */
export function LogoTile(props: { size: number; eyes?: EyeState; glow?: number; style?: CSSProperties }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const lit = logoEyes(props.eyes ?? {})
  const litSet = new Set(lit.map(([x, y]) => `${x},${y}`))
  const mood = props.eyes?.mood ?? 'open'
  const lightCells = new Set(
    mood === 'open' && !props.eyes?.blink
      ? [3, 9].map((c) => `${c + 1 + (props.eyes?.look?.[0] ?? 0)},${5 + (props.eyes?.look?.[1] ?? 0)}`)
      : [],
  )
  const grid = []
  const on = []
  for (let r = 0; r < 16; r++)
    for (let c = 0; c < 16; c++) {
      const key = `${c},${r}`
      const x = ORIGIN + c * PITCH
      const y = ORIGIN + 4.9 + r * PITCH
      if (litSet.has(key)) on.push({ key, x, y })
      else grid.push(<rect key={key} x={x} y={y} width={DOT} height={DOT} rx={1.8} />)
    }
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 100 100"
      style={{ display: 'block', overflow: 'visible', ...props.style }}
    >
      <defs>
        <radialGradient id={`t${id}`} cx=".5" cy="0" r="1.15">
          <stop offset="0" stopColor="#121214" />
          <stop offset=".5" stopColor="#050506" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <linearGradient id={`h${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".07" />
          <stop offset=".42" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`e${id}`} gradientUnits="userSpaceOnUse" x1="0" y1="31.85" x2="0" y2="63.45">
          <stop offset="0" stopColor={C.eyeTop} />
          <stop offset="1" stopColor={C.eyeBottom} />
        </linearGradient>
        <filter id={`g${id}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3.8" />
        </filter>
        <filter id={`o${id}`} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
        <clipPath id={`c${id}`}>
          <rect width="100" height="100" rx="22.4" />
        </clipPath>
      </defs>
      {(props.glow ?? 0) > 0 && (
        <rect
          x="8"
          y="22"
          width="84"
          height="56"
          rx="20"
          fill={C.glow}
          opacity={0.32 * (props.glow ?? 0)}
          filter={`url(#o${id})`}
        />
      )}
      <rect width="100" height="100" rx="22.4" fill={`url(#t${id})`} />
      <g fill="#fff" opacity=".035" clipPath={`url(#c${id})`}>
        {grid}
      </g>
      <g fill={C.glow} opacity=".8" filter={`url(#g${id})`}>
        {on.map((d) => (
          <rect key={d.key} x={d.x} y={d.y} width={DOT} height={DOT} rx={1.8} />
        ))}
      </g>
      <g>
        {on.map((d) => (
          <rect
            key={d.key}
            x={d.x}
            y={d.y}
            width={DOT}
            height={DOT}
            rx={1.8}
            fill={lightCells.has(d.key) ? C.eyeLight : `url(#e${id})`}
          />
        ))}
      </g>
      <rect width="100" height="100" rx="22.4" fill={`url(#h${id})`} />
      <rect x=".4" y=".4" width="99.2" height="99.2" rx="22" fill="none" stroke="#fff" strokeOpacity=".1" strokeWidth=".8" />
    </svg>
  )
}

/* ------------------------------------------------------------------ dot-matrix type */

/** 5×7 dot-matrix letters, from the app's DotMatrix readout. */
export const GLYPHS: Record<string, string[]> = {
  M: ['#   #', '## ##', '# # #', '# # #', '#   #', '#   #', '#   #'],
  Y: ['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  '],
  R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
  I: ['###', ' # ', ' # ', ' # ', ' # ', ' # ', '###'],
  D: ['#### ', '#   #', '#   #', '#   #', '#   #', '#   #', '#### '],
  O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  N: ['#   #', '#   #', '##  #', '# # #', '#  ##', '#   #', '#   #'],
  ' ': ['  ', '  ', '  ', '  ', '  ', '  ', '  '],
}

/** The dots that spell `text`, in units of one pitch, with the text's width. */
export function dotLayout(text: string): { dots: [number, number][]; width: number } {
  const dots: [number, number][] = []
  let x = 0
  for (const ch of text.toUpperCase()) {
    const g = GLYPHS[ch] ?? GLYPHS[' ']
    if (!g) continue
    const gw = g[0]?.length ?? 0
    for (let r = 0; r < 7; r++) for (let c = 0; c < gw; c++) if (g[r]?.[c] === '#') dots.push([x + c, r])
    x += gw + 1
  }
  return { dots, width: x - 1 }
}
