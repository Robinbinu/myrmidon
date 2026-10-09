import { useIsPresent } from 'motion/react'
import { type RefObject, useEffect, useRef } from 'react'
import { matchCombo } from './shortcuts.ts'

interface OpenDialog {
  readonly box: RefObject<HTMLElement | null>
  readonly close: RefObject<() => void>
  /** It lies over the whole page (a sheet, the command palette), not beside a control as a menu does. */
  readonly covers: boolean
}

/** Dialogs on screen, newest last. Only the newest answers Escape and holds Tab, so one Escape closes one dialog. */
const openDialogs: OpenDialog[] = []

/** Whether a sheet, popover or menu is open, so window-wide keys (⌘. stopping a round) leave it the key. */
export const anyDialogOpen = () => openDialogs.length > 0

/** Whether a dialog lies over the whole page, hiding what is under it; a menu or popover does not. */
export const pageCovered = () => openDialogs.some((d) => d.covers)

/** Told whenever a dialog opens or closes. */
const watchers = new Set<() => void>()

/** Calls `onChange` whenever a dialog opens or closes (ask `anyDialogOpen` or `pageCovered`); returns how to stop. */
export function watchDialogs(onChange: () => void): () => void {
  watchers.add(onChange)
  return () => watchers.delete(onChange)
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'

/** Escape closes the topmost layer, and so does ⌘. as on a Mac, where it cancels a sheet. */
export const closesDialog = (e: Parameters<typeof matchCombo>[1]) =>
  e.key === 'Escape' || matchCombo('mod+.', e)

function onDialogKey(e: KeyboardEvent) {
  const top = openDialogs.at(-1)
  const box = top?.box.current
  if (!top || !box) return
  if (closesDialog(e)) {
    if (e.key !== 'Escape') e.preventDefault()
    top.close.current()
    return
  }
  if (e.key !== 'Tab') return
  // Items a group reaches by arrow keys (tabindex -1) are not Tab stops.
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0 && el.tabIndex >= 0,
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
 * What every dialog does: moves focus into `box`, keeps Tab inside it, closes on Escape (or ⌘.) when it is the
 * topmost dialog, and gives focus back to where it was once it closes. `covers` says it lies over the whole page.
 */
export function useDialog(
  box: RefObject<HTMLElement | null>,
  onClose: () => void,
  { covers = false }: { covers?: boolean } = {},
) {
  // Callers pass inline handlers; keep the latest in a ref so the dialog registers once per opening.
  const close = useRef(onClose)
  close.current = onClose
  // A dialog playing its exit animation has already closed: it stops taking keys and gives focus back right away.
  const present = useIsPresent()
  useEffect(() => {
    if (!present) return
    const previous = document.activeElement as HTMLElement | null
    const entry: OpenDialog = { box, close, covers }
    // Effects run child first, so a dialog that contains one already registered goes below it, not on top.
    const inside = openDialogs.findIndex((d) => !!d.box.current && !!box.current?.contains(d.box.current))
    openDialogs.splice(inside === -1 ? openDialogs.length : inside, 0, entry)
    if (openDialogs.length === 1) window.addEventListener('keydown', onDialogKey)
    if (!box.current?.contains(document.activeElement)) box.current?.focus()
    for (const w of watchers) w()
    return () => {
      openDialogs.splice(openDialogs.indexOf(entry), 1)
      if (openDialogs.length === 0) window.removeEventListener('keydown', onDialogKey)
      previous?.focus()
      for (const w of watchers) w()
    }
  }, [box, present, covers])
}
