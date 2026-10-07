import { useId } from 'react'

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
    [...row].flatMap((ch, x) => (ch === '#' ? [{ x: ex + x * PITCH, y: Y0 + y * PITCH }] : [])),
  ),
)

/** The Myrmidon mark: the mascot's two pixel eyes on a dark glass tile. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId()
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="Myrmidon"
    >
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d1d22" />
          <stop offset="1" stopColor="#09090b" />
        </linearGradient>
        <linearGradient id={`${id}e`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffc847" />
          <stop offset="1" stopColor="#ff9d0a" />
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
        stroke="#ffffff"
        strokeOpacity="0.09"
      />
      <g filter={`url(#${id}g)`} opacity="0.55">
        {CELLS.map((c) => (
          <rect key={`g${c.x},${c.y}`} x={c.x} y={c.y} width={CELL} height={CELL} rx={0.55} fill="#ffb31a" />
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
          fill={`url(#${id}e)`}
        />
      ))}
    </svg>
  )
}
