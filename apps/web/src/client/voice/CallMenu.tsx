import { ChevronDown, Crown, Headset, Phone, UserRound } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { useRef, useState } from 'react'
import type { CrewMember } from '../api.ts'
import { copy } from '../copy.ts'
import { MenuItem, MenuSeparator, Popover } from '../ui/Popover.tsx'
import { Button } from '../ui/primitives.tsx'

/** Who a call is with: the call assistant (undefined), the lead, or a crew member by name. */
export type CallTarget = undefined | 'lead' | string

/**
 * The Call button: pick who to talk to. The call assistant (a fast model that hands work to the crew and can ask
 * them), the lead directly, or one of the chat's crew directly.
 */
export function CallMenu(props: { crew: readonly CrewMember[]; onCall(to: CallTarget): void }) {
  const t = copy.call.menu
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const pick = (to: CallTarget) => {
    setOpen(false)
    props.onCall(to)
  }
  const icon = (Icon: typeof Phone) => <Icon className="size-4 shrink-0 text-muted" />
  return (
    <div ref={box} className="relative">
      <Button
        variant="borderless"
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
          <Popover
            role="menu"
            label={copy.call.startTitle}
            onClose={() => setOpen(false)}
            within={box}
            className="material-menu absolute right-0 z-40 top-[calc(100%+4px)] w-72 origin-top-right rounded-lg border border-line p-1.5"
          >
            <MenuItem
              icon={icon(Headset)}
              title={t.assistant}
              detail={t.assistantHint}
              onSelect={() => pick(undefined)}
            />
            <MenuItem icon={icon(Crown)} title={t.lead} detail={t.leadHint} onSelect={() => pick('lead')} />
            {props.crew.length > 0 && <MenuSeparator />}
            {props.crew.map((c) => (
              <MenuItem
                key={c.name}
                icon={icon(UserRound)}
                title={c.name}
                detail={t.agentHint(c.specialty ?? c.role)}
                onSelect={() => pick(c.name)}
              />
            ))}
          </Popover>
        )}
      </AnimatePresence>
    </div>
  )
}
