/** Width math for resizable panes; the divider component and hook live in SplitDivider.tsx. */

export function clampWidth(w: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, w)))
}

/** A pane left of its divider grows as the divider moves right; a pane right of it grows as it moves left. */
export function dragWidth(
  start: number,
  dx: number,
  side: 'left' | 'right',
  min: number,
  max: number,
): number {
  return clampWidth(side === 'left' ? start + dx : start - dx, min, max)
}

export function readWidth(raw: string | null, initial: number, min: number, max: number): number {
  const n = raw ? Number(raw) : Number.NaN
  return Number.isFinite(n) ? clampWidth(n, min, max) : initial
}
