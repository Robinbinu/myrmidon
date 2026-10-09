import { X } from 'lucide-react'
import { motion } from 'motion/react'
import { type ReactNode, useId, useRef } from 'react'
import { copy } from '../copy.ts'
import { fade, spring } from '../ui-config.ts'
import { useDialog } from './dialog.ts'
import { cn, IconButton } from './primitives.tsx'

const WIDTHS = {
  sm: 'max-w-lg',
  md: 'max-w-3xl',
  lg: 'max-w-5xl h-[min(86vh,820px)]',
  full: 'max-w-[1280px] h-full',
} as const

/**
 * A sheet, as a Mac window shows one: it slides down from under the title bar and dims the window behind it. Escape,
 * ⌘. and a press on the dimmed window close it; focus moves in, stays in, and goes back afterwards. A `full` sheet
 * fills the window below the title bar, for whole views such as the crew console.
 */
export function Sheet(props: {
  title: ReactNode
  onClose(): void
  children: ReactNode
  actions?: ReactNode
  size?: keyof typeof WIDTHS
  /** The body lays out its own padding and scrolling. */
  flush?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useDialog(box, props.onClose)
  return (
    <motion.div
      // The top padding is the title bar's height (Toolbar), so the sheet comes out from under it.
      className="fixed inset-0 z-[60] flex items-start justify-center bg-scrim px-4 pb-4 pt-[52px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={fade}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <motion.div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        initial={{ opacity: 0, y: -24 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -16 }}
        transition={spring}
        className={cn(
          'mt-1.5 flex max-h-full w-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop outline-none',
          WIDTHS[props.size ?? 'md'],
        )}
      >
        <div className="material-toolbar flex h-11 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-headline font-semibold tracking-tight">
            {props.title}
          </h2>
          {props.actions}
          <IconButton label={copy.common.close} onClick={props.onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div
          className={cn(
            'min-h-0 flex-1 overflow-auto overscroll-contain',
            props.flush ? 'flex flex-col' : 'p-5',
          )}
        >
          {props.children}
        </div>
      </motion.div>
    </motion.div>
  )
}
