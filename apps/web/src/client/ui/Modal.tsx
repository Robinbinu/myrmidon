import { X } from 'lucide-react'
import { motion, useIsPresent } from 'motion/react'
import { type ReactNode, type RefObject, useEffect, useRef } from 'react'
import { copy } from '../copy.ts'
import { spring } from '../ui-config.ts'
import { cn, IconButton } from './primitives.tsx'

interface OpenDialog {
  readonly box: RefObject<HTMLElement | null>
  readonly close: RefObject<() => void>
}

/** Dialogs on screen, newest last. Only the newest answers Escape and holds Tab, so one Escape closes one dialog. */
const openDialogs: OpenDialog[] = []

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'

function onDialogKey(e: KeyboardEvent) {
  const top = openDialogs.at(-1)
  const box = top?.box.current
  if (!top || !box) return
  if (e.key === 'Escape') {
    top.close.current()
    return
  }
  if (e.key !== 'Tab') return
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  )
  const active = document.activeElement
  const inside = !!active && box.contains(active)
  const first = items[0]
  const last = items.at(-1)
  if (!first || !last) {
    e.preventDefault()
    box.focus()
  } else if (e.shiftKey ? !inside || active === first || active === box : !inside || active === last) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
  }
}

/**
 * What every dialog does: moves focus into `box`, keeps Tab inside it, closes on Escape when it is the topmost
 * dialog, and gives focus back to where it was once it closes.
 */
export function useDialog(box: RefObject<HTMLElement | null>, onClose: () => void) {
  // Callers pass inline handlers; keep the latest in a ref so the dialog registers once per opening.
  const close = useRef(onClose)
  close.current = onClose
  // A dialog playing its exit animation has already closed: it stops taking keys and gives focus back right away.
  const present = useIsPresent()
  useEffect(() => {
    if (!present) return
    const previous = document.activeElement as HTMLElement | null
    const entry: OpenDialog = { box, close }
    // Effects run child first, so a dialog that contains one already registered goes below it, not on top.
    const inside = openDialogs.findIndex((d) => !!d.box.current && !!box.current?.contains(d.box.current))
    openDialogs.splice(inside === -1 ? openDialogs.length : inside, 0, entry)
    if (openDialogs.length === 1) window.addEventListener('keydown', onDialogKey)
    if (!box.current?.contains(document.activeElement)) box.current?.focus()
    return () => {
      openDialogs.splice(openDialogs.indexOf(entry), 1)
      if (openDialogs.length === 0) window.removeEventListener('keydown', onDialogKey)
      previous?.focus()
    }
  }, [box, present])
}

/** Accessible dialog: Escape and the backdrop close it; focus moves in, stays in, and returns afterwards. */
export function Modal(props: {
  title: ReactNode
  onClose(): void
  children: ReactNode
  actions?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'full'
  flush?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  useDialog(box, props.onClose)
  const width = {
    sm: 'max-w-lg',
    md: 'max-w-3xl',
    lg: 'max-w-5xl h-[min(86vh,820px)]',
    full: 'max-w-[1280px] h-[min(92vh,1000px)]',
  }[props.size ?? 'md']
  return (
    <motion.div
      className="fixed inset-0 z-[60] grid place-items-center bg-scrim p-4 backdrop-blur-[2px]"
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
          <IconButton label={copy.common.close} onClick={props.onClose}>
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
