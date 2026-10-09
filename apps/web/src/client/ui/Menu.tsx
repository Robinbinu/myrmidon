import { Copy, type LucideIcon } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type MouseEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MENU_EDGE_PX, menuFade } from '../ui-config.ts'
import { moveMenuFocus, usePopover } from './Popover.tsx'
import { isMac } from './platform.ts'
import { cn } from './primitives.tsx'
import { comboLabel } from './shortcuts.ts'

/** One command in a menu. */
export interface MenuAction {
  readonly label: string
  readonly icon?: LucideIcon
  /** The shortcut that does the same thing (as shortcuts.ts writes it), shown at the row's end. */
  readonly combo?: string
  /** Removes or discards something: drawn in red, and always placed last. */
  readonly destructive?: boolean
  readonly disabled?: boolean
  run(): void
}

export type MenuEntry = MenuAction | 'separator'

/** What callers pass: entries, with `false` or `undefined` for ones that do not apply here. */
export type MenuEntries = readonly (MenuEntry | false | null | undefined)[]

/**
 * A menu as it is shown: entries that do not apply dropped, destructive ones moved to the end behind a separator
 * (as on a Mac, where Delete sits apart at the bottom), and no separator at either end or two in a row.
 */
export function arrangeMenu(entries: MenuEntries): MenuEntry[] {
  const kept = entries.filter((e): e is MenuEntry => !!e)
  const risky = kept.filter((e) => e !== 'separator' && e.destructive)
  const ordered = [...kept.filter((e) => e === 'separator' || !e.destructive), 'separator' as const, ...risky]
  const out: MenuEntry[] = []
  for (const e of ordered)
    if (e !== 'separator' || (out.length > 0 && out.at(-1) !== 'separator')) out.push(e)
  if (out.at(-1) === 'separator') out.pop()
  return out
}

interface Box {
  readonly width: number
  readonly height: number
}

/**
 * Where a menu opened at a point goes: below and to the right of it, flipped to the left or above where it would run
 * out of the window, and never past the window's edges.
 */
export function menuPosition(
  at: { x: number; y: number },
  size: Box,
  view: Box,
  margin = MENU_EDGE_PX,
): { left: number; top: number } {
  const place = (start: number, length: number, room: number) => {
    const flipped = start + length > room - margin ? start - length : start
    return Math.round(Math.max(margin, Math.min(flipped, room - margin - length)))
  }
  return { left: place(at.x, size.width, view.width), top: place(at.y, size.height, view.height) }
}

/** The rows of a menu. Choosing one closes the menu first, so the command runs with focus back where it was. */
export function MenuRows(props: { entries: readonly MenuEntry[]; onClose(): void }) {
  return props.entries.map((e, i) =>
    e === 'separator' ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity besides their place
      <hr key={`sep-${i}`} className="mx-2 my-[5px] border-line" />
    ) : (
      <button
        key={e.label}
        type="button"
        role="menuitem"
        tabIndex={-1}
        disabled={e.disabled}
        aria-keyshortcuts={e.combo ? ariaCombo(e.combo) : undefined}
        // The pointer and the arrow keys move one highlight, as in a Mac menu.
        onMouseEnter={(ev) => ev.currentTarget.focus()}
        onMouseLeave={(ev) => ev.currentTarget.closest<HTMLElement>('[role="menu"]')?.focus()}
        onClick={() => {
          props.onClose()
          e.run()
        }}
        className={cn(
          // The highlighted row takes the accent, as a Mac menu's does; a destructive one turns red instead.
          'group flex h-[22px] w-full items-center gap-2 rounded-sm px-2 text-left text-body outline-none disabled:opacity-40',
          e.destructive
            ? 'text-bad-ink focus:bg-bad-fill focus:text-white'
            : 'text-fg focus:bg-accent focus:text-on-accent',
        )}
      >
        {e.icon ? (
          <e.icon
            aria-hidden
            className={cn('size-3.5 shrink-0', !e.destructive && 'text-fg-2 group-focus:text-on-accent')}
          />
        ) : (
          <span aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{e.label}</span>
        {e.combo && (
          <span
            aria-hidden
            className="pl-4 text-small tabular-nums text-muted group-focus:text-current group-focus:opacity-70"
          >
            {comboLabel(e.combo, isMac)}
          </span>
        )}
      </button>
    ),
  )
}

/** A combo as aria-keyshortcuts writes it: Meta+Shift+[ on a Mac, Control+Shift+[ elsewhere. */
function ariaCombo(combo: string): string {
  return combo
    .split('+')
    .map((p) =>
      p === 'mod' ? (isMac ? 'Meta' : 'Control') : p === 'shift' ? 'Shift' : p === 'alt' ? 'Alt' : p,
    )
    .join('+')
}

interface OpenMenu {
  readonly x: number
  readonly y: number
  readonly entries: readonly MenuEntry[]
  readonly label: string
  /** Opened from the keyboard (the menu key, Shift+F10): the first item takes focus at once. */
  readonly keyboard: boolean
}

/** A context menu at a point in the window: glass, keyboard-driven, closing on Escape, Tab or a press outside. */
function ContextMenu(props: OpenMenu & { onClose(): void }) {
  const box = useRef<HTMLDivElement>(null)
  usePopover(box, props.onClose)
  const { onClose } = props
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const at = menuPosition(
      { x: props.x, y: props.y },
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    )
    el.style.left = `${at.left}px`
    el.style.top = `${at.top}px`
  }, [props.x, props.y])
  useEffect(() => {
    if (props.keyboard) box.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [props.keyboard])
  // A menu belongs to the moment it opened in: the window losing focus, resizing or scrolling closes it.
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [onClose])
  return (
    <motion.div
      ref={box}
      role="menu"
      aria-label={props.label}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return moveMenuFocus(e)
        e.preventDefault()
        props.onClose()
      }}
      onContextMenu={(e) => e.preventDefault()}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={menuFade}
      style={{ left: props.x, top: props.y }}
      className="material-menu fixed z-[80] min-w-[200px] max-w-[320px] rounded-md border border-line p-[5px] outline-none"
    >
      <MenuRows entries={props.entries} onClose={props.onClose} />
    </motion.div>
  )
}

/** Whether a right-click should get the browser's menu instead: in a text field, or over text the person selected. */
function wantsBrowserMenu(e: MouseEvent<HTMLElement>): boolean {
  const target = e.target instanceof Element ? e.target : null
  if (target?.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')) return true
  const selection = window.getSelection()
  return (
    !!selection &&
    !selection.isCollapsed &&
    !!selection.toString().trim() &&
    selection.containsNode(e.currentTarget, true)
  )
}

/** The host on screen, which draws the open menu; there is one, and only one menu is open at a time. */
let showMenu: ((menu: OpenMenu | undefined) => void) | undefined

/**
 * Where context menus draw, rendered once at the app's root so a menu is never clipped or moved by the pane it opened
 * in (a sidebar's glass is a containing block for fixed elements).
 */
export function ContextMenuHost() {
  const [shown, setShown] = useState<OpenMenu>()
  useEffect(() => {
    showMenu = setShown
    return () => {
      if (showMenu === setShown) showMenu = undefined
    }
  }, [])
  const close = useCallback(() => setShown(undefined), [])
  return (
    <AnimatePresence>
      {shown && <ContextMenu key={`${shown.x},${shown.y}`} {...shown} onClose={close} />}
    </AnimatePresence>
  )
}

/**
 * For an element's onContextMenu: opens a menu of `entries` at the pointer (or under the element, from the keyboard),
 * named `label` for screen readers. Over a text field or selected text the browser's own menu opens instead.
 */
export function openContextMenu(e: MouseEvent<HTMLElement>, label: string, entries: MenuEntries) {
  if (!showMenu || wantsBrowserMenu(e)) return
  const list = arrangeMenu(entries)
  if (!list.length) return
  e.preventDefault()
  e.stopPropagation()
  // The menu key and Shift+F10 report no pointer position: the menu opens under the element instead.
  const keyboard = e.clientX === 0 && e.clientY === 0
  const r = e.currentTarget.getBoundingClientRect()
  showMenu({
    x: keyboard ? r.left + 8 : e.clientX,
    y: keyboard ? r.bottom : e.clientY,
    entries: list,
    label,
    keyboard,
  })
}

/** A menu entry that copies `text`, then says so with `onCopied` (a toast). */
export function copyAction(label: string, text: string, onCopied?: () => void): MenuAction {
  return {
    label,
    icon: Copy,
    run: () => {
      void navigator.clipboard.writeText(text).then(() => onCopied?.())
    },
  }
}
