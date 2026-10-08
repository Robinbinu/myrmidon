import { ChevronDown, Crown, Headset, Phone, UserRound } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { copy } from '../copy.ts'
import { Button } from '../ui/primitives.tsx'
import { spring } from '../ui-config.ts'

/** Who a call is with: the call assistant (undefined), the lead, or a crew member by name. */
export type CallTarget = undefined | 'lead' | string

/**
 * The Call button: pick who to talk to. The call assistant (a fast model that hands work to the crew and can ask
 * them), the lead directly, or one of the chat's crew directly.
 */
export function CallMenu(props: {
  crew: readonly { name: string; role?: string }[]
  onCall(to: CallTarget): void
}) {
  const t = copy.call.menu
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const pick = (to: CallTarget) => {
    setOpen(false)
    props.onCall(to)
  }
  const item = (key: string, to: CallTarget, Icon: typeof Phone, name: string, detail: string) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      onClick={() => pick(to)}
      className="flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-fill"
    >
      <Icon className="size-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium text-fg">{name}</span>
        <span className="block truncate text-footnote text-muted">{detail}</span>
      </span>
    </button>
  )
  return (
    <div ref={box} className="relative">
      <Button
        variant="toolbar"
        size="sm"
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
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.1 } }}
            transition={spring}
            className="material-menu absolute right-0 top-[calc(100%+4px)] z-40 w-72 origin-top-right rounded-lg border border-line p-1.5"
          >
            {item('assistant', undefined, Headset, t.assistant, t.assistantHint)}
            {item('lead', 'lead', Crown, t.lead, t.leadHint)}
            {props.crew.length > 0 && <div className="my-1 h-px bg-line" />}
            {props.crew.map((c) => item(`agent-${c.name}`, c.name, UserRound, c.name, t.agentHint(c.role)))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
