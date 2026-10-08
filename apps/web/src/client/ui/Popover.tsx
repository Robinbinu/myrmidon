import { Check } from 'lucide-react'
import { motion } from 'motion/react'
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
} from 'react'
import { spring } from '../ui-config.ts'
import { useDialog } from './Modal.tsx'
import { cn } from './primitives.tsx'

const ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'

/**
 * What every popover does: a press outside `within` (the popover and the button that opened it) closes it, Escape
 * closes it through the dialog stack so one Escape closes one layer, focus moves into it, and focus goes back to the
 * button when it closes.
 */
export function usePopover(
  box: RefObject<HTMLElement | null>,
  onClose: () => void,
  within?: RefObject<HTMLElement | null>,
) {
  useDialog(box, onClose)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const outside = (e: MouseEvent) => {
      const area = within?.current ?? box.current
      if (area && !area.contains(e.target as Node)) close.current()
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [box, within])
}

/** Arrow keys, Home and End move between a menu's items, wrapping at the ends. */
export function moveMenuFocus(e: KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEMS)]
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next =
    e.key === 'ArrowDown'
      ? (at + 1) % items.length
      : e.key === 'ArrowUp'
        ? (at - 1 + items.length) % items.length
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? items.length - 1
            : undefined
  if (next === undefined) return
  e.preventDefault()
  items[next]?.focus()
}

/**
 * A floating panel under or above the control that opened it. As a `menu` it holds only items: arrow keys move
 * between them and Tab closes it. As a `dialog` it can hold any controls, with its items (in a `MenuList`) still on
 * the arrow keys. Either way focus starts on the field marked `data-autofocus`, else the chosen item, else the first.
 */
export function Popover(props: {
  role: 'menu' | 'dialog'
  label: string
  onClose(): void
  within?: RefObject<HTMLElement | null>
  /** The panel element, for callers that measure it. */
  box?: RefObject<HTMLDivElement | null>
  /** Opens upward, so it grows from its bottom edge. */
  up?: boolean
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  const own = useRef<HTMLDivElement>(null)
  const box = props.box ?? own
  usePopover(box, props.onClose, props.within)
  // After useDialog has noted the button to give focus back to.
  useEffect(() => {
    const el = box.current
    const first =
      el?.querySelector<HTMLElement>('[data-autofocus]') ??
      el?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      el?.querySelector<HTMLElement>(ITEMS)
    first?.focus()
  }, [box])
  const menu = props.role === 'menu'
  return (
    <motion.div
      ref={box}
      role={props.role}
      aria-label={props.label}
      tabIndex={-1}
      onKeyDown={
        menu
          ? (e) => {
              if (e.key !== 'Tab') return moveMenuFocus(e)
              e.preventDefault()
              props.onClose()
            }
          : undefined
      }
      initial={{ opacity: 0, y: props.up ? 6 : -6, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: props.up ? 4 : -4, scale: 0.98, transition: { duration: 0.1 } }}
      transition={spring}
      style={props.style}
      className={cn('outline-none', props.className)}
    >
      {props.children}
    </motion.div>
  )
}

/** A run of items inside a dialog popover, on the arrow keys like a menu's. */
export function MenuList(props: { label: string; children: ReactNode }) {
  return (
    <div role="menu" aria-label={props.label} onKeyDown={moveMenuFocus}>
      {props.children}
    </div>
  )
}

/**
 * One item in a menu: an icon, a name, a quieter line under it, and a check when it is the chosen one (`checked`
 * makes it a radio item). Items take focus from the arrow keys, not Tab.
 */
export function MenuItem(props: {
  icon?: ReactNode
  title: ReactNode
  detail?: ReactNode
  /** Let the detail wrap instead of cutting it off. */
  multiline?: boolean
  checked?: boolean
  /** The group's Tab stop when none of its items is chosen; give it to the first. */
  tabStop?: boolean
  onSelect(): void
}) {
  return (
    <button
      type="button"
      {...(props.checked === undefined
        ? { role: 'menuitem' }
        : { role: 'menuitemradio', 'aria-checked': props.checked })}
      // The chosen item is the group's one Tab stop, as in a radio group; the arrow keys reach the rest.
      tabIndex={props.checked || props.tabStop ? 0 : -1}
      onClick={props.onSelect}
      className="flex w-full items-center gap-2.5 rounded-base px-2 py-1.5 text-left outline-none transition-colors hover:bg-fill focus-visible:bg-fill"
    >
      {props.icon}
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium text-fg">{props.title}</span>
        {props.detail && (
          <span
            className={cn('block text-footnote text-muted', props.multiline ? 'leading-snug' : 'truncate')}
          >
            {props.detail}
          </span>
        )}
      </span>
      {props.checked && <Check className="size-4 shrink-0 text-accent-fg" />}
    </button>
  )
}

/** A hairline between groups of items. */
export function MenuSeparator() {
  return <hr className="my-1 border-line" />
}
