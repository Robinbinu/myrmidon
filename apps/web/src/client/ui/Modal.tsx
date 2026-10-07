import { X } from 'lucide-react'
import { motion } from 'motion/react'
import { type ReactNode, useEffect, useRef } from 'react'
import { cn, IconButton, spring } from './primitives.tsx'

/** Accessible dialog: Escape and the backdrop close it; focus moves in and returns afterwards. */
export function Modal(props: {
  title: ReactNode
  onClose(): void
  children: ReactNode
  actions?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'full'
  flush?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  // Callers pass inline handlers; keep the latest in a ref so focus is managed once per opening.
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    box.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose.current()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [])
  const width = {
    sm: 'max-w-lg',
    md: 'max-w-3xl',
    lg: 'max-w-5xl h-[min(86vh,820px)]',
    full: 'max-w-[1280px] h-[min(92vh,1000px)]',
  }[props.size ?? 'md']
  return (
    <motion.div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/45 p-4 backdrop-blur-[2px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <motion.div
        ref={box}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={spring}
        className={cn(
          'flex max-h-[90vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop outline-none',
          width,
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line py-2.5 pl-5 pr-2.5">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">{props.title}</h2>
          {props.actions}
          <IconButton label="Close" onClick={props.onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className={cn('min-h-0 flex-1 overflow-auto', props.flush ? 'flex flex-col' : 'p-5')}>
          {props.children}
        </div>
      </motion.div>
    </motion.div>
  )
}
