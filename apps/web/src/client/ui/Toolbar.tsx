import type { ReactNode } from 'react'
import { cn } from './primitives.tsx'

/**
 * A column's title-bar row. Rows in neighbouring columns line up into one unified title bar; the desktop shell drags
 * the window by them, and leaves room for its window buttons through --titlebar-inset.
 */
export function Toolbar(props: {
  children: ReactNode
  inset?: boolean
  material?: boolean
  className?: string
}) {
  return (
    <div
      data-toolbar
      className={cn(
        'drag-region relative z-10 flex h-[52px] shrink-0 items-center gap-1 border-b border-line px-2',
        props.material !== false && 'material-toolbar',
        props.inset && 'pl-[calc(var(--titlebar-inset)+0.5rem)]',
        props.className,
      )}
    >
      {props.children}
    </div>
  )
}

export function ToolbarTitle(props: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-body font-semibold">
      {props.children}
    </div>
  )
}
