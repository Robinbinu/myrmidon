import {
  MASCOT_COLORS,
  MASCOT_GRID,
  MASCOT_REACTIONS as R,
  MASCOT_SHOWS as S,
  MASCOT_TOUCH as T,
} from '../ui-config.ts'
import { type Clip, type Dot, type Frame, generated, type Look, stamp } from './clips.ts'

/** Shows on the mascot's screen: the boot sweep, confetti, Pac-Man, the Game of Life, the equaliser and touch effects. */

const { cols: COLS, rows: ROWS } = MASCOT_GRID
type Random = () => number

/** The screen switching on: a scanline sweeps down, revealing the eyes above it. */
export function boot(): Clip {
  const frames: Frame[] = [{ ms: S.bootRowMs * 2, eyes: null }]
  for (let y = 0; y <= ROWS + 1; y++) {
    const dots: Dot[] = []
    for (let x = 0; x < COLS; x++) dots.push([x, y, 1], [x, y - 1, 0.35])
    frames.push({ ms: S.bootRowMs, eyes: { reveal: y }, dots })
  }
  return { name: 'boot', frames }
}

const CONFETTI = [...Object.values(MASCOT_COLORS), '#ff6a3d', '#c6f432']

/** Confetti bursting up from the bottom like a party popper, then falling under gravity, over star eyes. */
export function confetti(random: Random = Math.random): Clip {
  return generated('confetti', function* () {
    const bits = Array.from({ length: S.confetti.count }, (_, i) => ({
      x: COLS / 2,
      y: ROWS - 1,
      vx: (random() * 2 - 1) * 7,
      vy: -8 - random() * 10,
      color: CONFETTI[i % CONFETTI.length] as string,
    }))
    const dt = S.confetti.frameMs / 1000
    for (let t = 0; t < S.confetti.ms; t += S.confetti.frameMs) {
      const dots: Dot[] = []
      for (const b of bits) {
        b.vy += S.confetti.gravity * dt
        b.x += b.vx * dt
        b.y += b.vy * dt
        dots.push([Math.round(b.x), Math.round(b.y), b.color])
      }
      yield {
        ms: S.confetti.frameMs,
        eyes: { shape: Math.floor(t / R.twinkleMs) % 2 ? 'sparkle' : 'star' },
        dots,
      }
    }
  })
}

const PAC = {
  open: ['.###.', '####.', '###..', '####.', '.###.'],
  shut: ['.###.', '#####', '#####', '#####', '.###.'],
}

/** One eye turns Pac-Man and eats a row of dots across the screen. */
export function pacman(): Clip {
  return generated('pacman', function* () {
    const top = Math.floor((ROWS - 5) / 2)
    const row = top + 2
    for (let x = -5; x <= COLS; x++) {
      const dots: Dot[] = []
      // Dots on every other column ahead of his mouth; behind it they are eaten.
      for (let d = 1; d < COLS; d += 2) if (d > x + 3) dots.push([d, row, 0.6])
      dots.push(...stamp(x % 2 === 0 ? PAC.open : PAC.shut, x, top))
      yield { ms: S.pacmanStepMs, eyes: null, dots }
    }
  })
}

/** One generation of Conway's Game of Life on the screen, wrapping round its edges. */
export function lifeStep(alive: ReadonlySet<string>, cols: number = COLS, rows: number = ROWS): Set<string> {
  const next = new Set<string>()
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let n = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if ((dx || dy) && alive.has(`${(x + dx + cols) % cols},${(y + dy + rows) % rows}`)) n++
      const key = `${x},${y}`
      if (n === 3 || (n === 2 && alive.has(key))) next.add(key)
    }
  }
  return next
}

const toDots = (alive: ReadonlySet<string>): Dot[] =>
  [...alive].map((k) => k.split(',').map(Number) as unknown as Dot)

/**
 * The Game of Life as a screensaver, seeded from the eyes: their cells, each kept or dropped at random and joined by
 * a few around them. When it dies, stops changing or runs too long it is seeded again.
 */
export function life(seed: readonly (readonly [number, number])[], random: Random = Math.random): Clip {
  const sow = () => {
    const alive = new Set<string>()
    for (const [x, y] of seed) {
      if (random() < 0.75) alive.add(`${x},${y}`)
      if (random() < S.life.seedDensity) {
        const nx = x + Math.round(random() * 2 - 1)
        const ny = y + Math.round(random() * 2 - 1)
        if (nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS) alive.add(`${nx},${ny}`)
      }
    }
    return alive
  }
  const key = (s: ReadonlySet<string>) => [...s].sort().join(' ')
  return generated(
    'life',
    function* () {
      let alive = sow()
      let seen: string[] = []
      let age = 0
      while (true) {
        yield { ms: S.life.stepMs, eyes: null, dots: toDots(alive) }
        alive = lifeStep(alive)
        const k = key(alive)
        // A still life or a blinker repeats one of the last two generations.
        if (alive.size === 0 || seen.includes(k) || ++age > S.life.maxGenerations) {
          alive = sow()
          seen = []
          age = 0
        } else seen = [seen.at(-1) ?? '', k]
      }
    },
    true,
  )
}

const BAR_INK = [
  'var(--mood-happy)',
  'var(--mood-happy)',
  'var(--mood-happy)',
  '#ffb31a',
  '#ffb31a',
  '#ff6a3d',
]

/**
 * Equaliser bars while a call is on, following `level` (0–1, already raised to fill the bars). Each bar jumps up to
 * its new height at once and falls back a cell a frame, like a level meter.
 */
export function equaliser(level: () => number, random: Random = Math.random): Clip {
  return generated(
    'equaliser',
    function* () {
      const bars = Math.ceil(COLS / 2)
      const heights = Array.from({ length: bars }, () => 0)
      while (true) {
        const l = Math.max(0, Math.min(1, level()))
        const dots: Dot[] = []
        for (let i = 0; i < bars; i++) {
          // Middle bars ride higher, with some noise so the bars don't move as one.
          const shape = 0.55 + 0.45 * (1 - Math.abs(i - (bars - 1) / 2) / (bars / 2))
          const want = Math.round(ROWS * Math.min(1, l * shape * (0.7 + random() * 0.5)))
          const h = Math.max(want, (heights[i] ?? 0) - 1, 1)
          heights[i] = h
          for (let k = 0; k < h; k++)
            dots.push([i * 2, ROWS - 1 - k, BAR_INK[Math.floor((k / ROWS) * BAR_INK.length)] ?? '#ff6a3d'])
        }
        yield { ms: S.equaliser.frameMs, eyes: null, dots }
      }
    },
    true,
  )
}

/** A ring spreading out from a clicked cell, fading as it goes, while the eyes look there. */
export function ripple(cx: number, cy: number, look: Look): Clip {
  const reach = Math.hypot(COLS, ROWS) * 0.7
  return generated('ripple', function* () {
    for (let r = 0; r <= reach; r += 1) {
      const dots: Dot[] = []
      const level = 0.85 * (1 - r / reach)
      for (let y = 0; y < ROWS; y++)
        for (let x = 0; x < COLS; x++)
          if (Math.abs(Math.hypot(x - cx, y - cy) - r) < 0.6) dots.push([x, y, level])
      yield { ms: T.rippleStepMs, eyes: { look, mood: 'surprised' }, dots }
    }
  })
}

/** Charging while pressed: the screen fills outward from the middle and brightens, the eyes trembling near the end. */
export function charge(): Clip {
  return generated('charge', function* () {
    const n = Math.max(1, Math.round(T.chargeMs / T.chargeFrameMs))
    const reach = Math.hypot(COLS / 2, ROWS / 2)
    for (let i = 1; i <= n; i++) {
      const p = i / n
      const dots: Dot[] = []
      for (let y = 0; y < ROWS; y++)
        for (let x = 0; x < COLS; x++)
          if (Math.hypot(x - (COLS - 1) / 2, (y - (ROWS - 1) / 2) * 1.6) <= p * reach * 1.15)
            dots.push([x, y, 0.1 + 0.35 * p])
      const tremble = p > 0.7 ? (i % 2 ? 1 : -1) : 0
      yield { ms: T.chargeFrameMs, eyes: { stretch: p > 0.4 ? 1 : 0, shift: [tremble, 0] }, dots }
    }
  })
}

/** The charge let go: a full flash, a ring bursting outward with sparks, then wide eyes. */
export function pop(random: Random = Math.random): Clip {
  return generated('pop', function* () {
    const all: Dot[] = []
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) all.push([x, y, 1])
    yield { ms: T.popFlashMs, eyes: null, dots: all }
    const cx = (COLS - 1) / 2
    const cy = (ROWS - 1) / 2
    for (let r = 1; r < COLS / 2 + 2; r++) {
      const dots: Dot[] = []
      for (let y = 0; y < ROWS; y++)
        for (let x = 0; x < COLS; x++) {
          const d = Math.hypot(x - cx, (y - cy) * 1.6)
          if (Math.abs(d - r) < 0.7) dots.push([x, y, 1 - r / (COLS / 2 + 2)])
          else if (d < r && random() < 0.06) dots.push([x, y, 0.5])
        }
      yield { ms: T.popRingMs, eyes: r < 3 ? null : { mood: 'surprised' }, dots }
    }
  })
}
