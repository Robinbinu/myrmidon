import { useId } from 'react'
import { copy } from '../copy.ts'

const CELL = 2.05
const PITCH = 2.65
/** One eye: a 4×4 pixel blob with its corners trimmed, exactly like the mascot's. */
const EYE = ['.##.', '####', '####', '.##.']
const EYE_W = 3 * PITCH + CELL
const SPACING = 3.4
const X0 = (32 - (EYE_W * 2 + SPACING)) / 2
const Y0 = (32 - EYE_W) / 2 + 0.4

const CELLS = [X0, X0 + EYE_W + SPACING].flatMap((ex) =>
  EYE.flatMap((row, y) =>
    [...row].flatMap((ch, x) =>
      // The first lit pixel of each eye catches the light, as on the app icon.
      ch === '#' ? [{ x: ex + x * PITCH, y: Y0 + y * PITCH, light: x === 1 && y === 0 }] : [],
    ),
  ),
)

/** The Myrmidon mark: the mascot's two pixel eyes on a dark glass tile, lit from above. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId()
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label={copy.brand.name}
    >
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--logo-tile-top)' }} />
          <stop offset="1" style={{ stopColor: 'var(--logo-tile-bottom)' }} />
        </linearGradient>
        <linearGradient id={`${id}e`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--logo-eye-top)' }} />
          <stop offset="1" style={{ stopColor: 'var(--logo-eye-bottom)' }} />
        </linearGradient>
        <linearGradient id={`${id}h`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.12" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <filter id={`${id}g`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id}t)`} />
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="8.5"
        fill="none"
        style={{ stroke: 'var(--logo-rim)' }}
        strokeOpacity="0.09"
      />
      <g filter={`url(#${id}g)`} opacity="0.7">
        {CELLS.map((c) => (
          <rect
            key={`g${c.x},${c.y}`}
            x={c.x}
            y={c.y}
            width={CELL}
            height={CELL}
            rx={0.55}
            style={{ fill: 'var(--logo-glow)' }}
          />
        ))}
      </g>
      {CELLS.map((c) => (
        <rect
          key={`${c.x},${c.y}`}
          x={c.x}
          y={c.y}
          width={CELL}
          height={CELL}
          rx={0.55}
          fill={c.light ? 'var(--logo-eye-light)' : `url(#${id}e)`}
        />
      ))}
      <rect width="32" height="32" rx="9" fill={`url(#${id}h)`} />
    </svg>
  )
}
