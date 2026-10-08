import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { copy } from '../copy.ts'
import { cn } from '../ui/primitives.tsx'

export interface Folds {
  isOpen(id: string): boolean
  toggle(id: string): void
  setAll(ids: readonly string[], open: boolean): void
}

/**
 * Open/closed state for a list of foldable rows. Rows follow `defaultOpen` (e.g. the running ones) until the
 * person folds or unfolds them, so new rows still arrive in a sensible state.
 */
export function useFolds(defaultOpen: (id: string) => boolean): Folds {
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map())
  const isOpen = (id: string) => chosen.get(id) ?? defaultOpen(id)
  return {
    isOpen,
    toggle: (id) => setChosen((m) => new Map(m).set(id, !(m.get(id) ?? defaultOpen(id)))),
    setAll: (ids, open) => setChosen(new Map(ids.map((id) => [id, open]))),
  }
}

/** "Expand all" / "Collapse all" for a list, like the Git and diff views. */
export function FoldAll(props: { ids: readonly string[]; folds: Folds }) {
  if (props.ids.length < 2) return null
  const allOpen = props.ids.every((id) => props.folds.isOpen(id))
  return (
    <button
      type="button"
      className="rounded-md px-1.5 py-0.5 text-small text-muted hover:bg-surface-2 hover:text-fg"
      onClick={() => props.folds.setAll(props.ids, !allOpen)}
    >
      {allOpen ? copy.folds.collapseAll : copy.folds.expandAll}
    </button>
  )
}

export function FoldChevron(props: { open: boolean; className?: string }) {
  return (
    <ChevronRight
      aria-hidden
      className={cn('size-3.5 shrink-0 transition-transform', props.open && 'rotate-90', props.className)}
    />
  )
}
