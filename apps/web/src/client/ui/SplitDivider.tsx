import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react'
import { readStored, store } from './hooks.ts'
import { cn } from './primitives.tsx'
import { clampWidth, dragWidth, readWidth } from './split.ts'

export interface Split {
  width: number
  min: number
  max: number
  initial: number
  dragging: boolean
  set(w: number): void
  reset(): void
  setDragging(d: boolean): void
}

/** A pane width the person can drag, remembered on this machine. */
export function useSplitWidth(key: string, opts: { min: number; max: number; initial: number }): Split {
  const [width, setWidth] = useState(() => readWidth(readStored(key, ''), opts.initial, opts.min, opts.max))
  const [dragging, setDragging] = useState(false)
  const set = (w: number) => {
    const next = clampWidth(w, opts.min, opts.max)
    setWidth(next)
    store(key, String(next))
  }
  return { width, ...opts, dragging, set, reset: () => set(opts.initial), setDragging }
}

/**
 * The edge between two panes: drag it, or focus it and use the arrow keys (Shift for bigger steps, Home and End for
 * the limits); double-click puts the width back. It takes no room; its hit area straddles the edge.
 */
export function SplitDivider(props: {
  split: Split
  side: 'left' | 'right'
  label: string
  className?: string
}) {
  const { split, side } = props
  const start = useRef<{ x: number; width: number }>(undefined)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, width: split.width }
    split.setDragging(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    split.set(dragWidth(start.current.width, e.clientX - start.current.x, side, split.min, split.max))
  }
  const end = () => {
    start.current = undefined
    split.setDragging(false)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16
    // Arrow keys move the divider, so for a right-hand pane "left" means wider.
    const grow = side === 'left' ? 1 : -1
    const moves: Record<string, () => number> = {
      ArrowLeft: () => split.width - step * grow,
      ArrowRight: () => split.width + step * grow,
      Home: () => split.min,
      End: () => split.max,
    }
    const next = moves[e.key]
    if (!next) return
    e.preventDefault()
    split.set(next())
  }
  return (
    <div className={cn('relative z-30 w-0 shrink-0', props.className)}>
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable, adjustable separator has no native element */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={props.label}
        aria-valuenow={split.width}
        aria-valuemin={split.min}
        aria-valuemax={split.max}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={split.reset}
        onKeyDown={onKeyDown}
        className={cn(
          'absolute inset-y-0 -left-1 w-2 cursor-col-resize outline-none transition-colors',
          'hover:bg-focus/25 focus-visible:bg-focus/40',
          split.dragging && 'bg-focus/40',
        )}
      />
    </div>
  )
}
