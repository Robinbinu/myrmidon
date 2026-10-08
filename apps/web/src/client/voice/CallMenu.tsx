import { ChevronDown, Crown, Headset, Phone, UserRound } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { CrewMember } from '../api.ts'
import { copy } from '../copy.ts'
import { useDialog } from '../ui/Modal.tsx'
import { Button } from '../ui/primitives.tsx'
import { spring } from '../ui-config.ts'

/** Who a call is with: the call assistant (undefined), the lead, or a crew member by name. */
export type CallTarget = undefined | 'lead' | string

/** Arrow keys, Home and End move between a menu's items, wrapping at the ends. */
function moveFocus(e: KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
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

/** The open menu: focus moves to its first item, and Escape closes it through the dialog stack, back to the button. */
function Menu(props: { crew: readonly CrewMember[]; onPick(to: CallTarget): void; onClose(): void }) {
  const t = copy.call.menu
  const box = useRef<HTMLDivElement>(null)
  useDialog(box, props.onClose)
  // After useDialog has noted the button to give focus back to.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [])
  const item = (key: string, to: CallTarget, Icon: typeof Phone, name: string, detail: string) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={() => props.onPick(to)}
      className="flex w-full items-center gap-2.5 rounded-base px-2 py-1.5 text-left outline-none transition-colors hover:bg-fill focus-visible:bg-fill"
    >
      <Icon className="size-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium text-fg">{name}</span>
        <span className="block truncate text-footnote text-muted">{detail}</span>
      </span>
    </button>
  )
  return (
    <motion.div
      ref={box}
      role="menu"
      tabIndex={-1}
      aria-label={copy.call.startTitle}
      onKeyDown={moveFocus}
      initial={{ opacity: 0, y: -6, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.1 } }}
      transition={spring}
      className="material-menu absolute right-0 top-[calc(100%+4px)] z-40 w-72 origin-top-right rounded-lg border border-line p-1.5 outline-none"
    >
      {item('assistant', undefined, Headset, t.assistant, t.assistantHint)}
      {item('lead', 'lead', Crown, t.lead, t.leadHint)}
      {props.crew.length > 0 && <div className="my-1 h-px bg-line" />}
      {props.crew.map((c) =>
        item(`agent-${c.name}`, c.name, UserRound, c.name, t.agentHint(c.specialty ?? c.role)),
      )}
    </motion.div>
  )
}

/**
 * The Call button: pick who to talk to. The call assistant (a fast model that hands work to the crew and can ask
 * them), the lead directly, or one of the chat's crew directly.
 */
export function CallMenu(props: { crew: readonly CrewMember[]; onCall(to: CallTarget): void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  return (
    <div ref={box} className="relative">
      <Button
        variant="toolbar"
        icon={<Phone className="size-4" />}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={copy.call.startTitle}
      >
        {copy.call.start}
        <ChevronDown className="size-3 text-muted" />
      </Button>
      <AnimatePresence>
        {open && (
          <Menu
            crew={props.crew}
            onClose={() => setOpen(false)}
            onPick={(to) => {
              setOpen(false)
              props.onCall(to)
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
