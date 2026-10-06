const COLS = 7
const ROWS = 5
const CELL = 2.9
const GAP = 1
const EYES = new Set(['1,1', '2,1', '1,2', '2,2', '1,3', '2,3', '4,1', '5,1', '4,2', '5,2', '4,3', '5,3'])

/** The Myrmidon mark: the colony's face, two signal-amber eyes on a dark dot-matrix screen. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  const x0 = (32 - (COLS * CELL + (COLS - 1) * GAP)) / 2
  const y0 = (32 - (ROWS * CELL + (ROWS - 1) * GAP)) / 2
  const cells = []
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const eye = EYES.has(`${x},${y}`)
      cells.push(
        <rect
          key={`${x},${y}`}
          x={x0 + x * (CELL + GAP)}
          y={y0 + y * (CELL + GAP)}
          width={CELL}
          height={CELL}
          rx={0.85}
          fill={eye ? '#ffb31a' : '#ffffff'}
          opacity={eye ? 1 : 0.07}
        />,
      )
    }
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="Myrmidon"
    >
      <rect width="32" height="32" rx="9" fill="#0b0b0d" />
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="8.5"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.1"
      />
      {cells}
    </svg>
  )
}
