import { ChevronRight, Phone } from 'lucide-react'
import { useState } from 'react'
import { copy } from '../copy.ts'
import { cn } from '../ui/primitives.tsx'

/** A finished call as the server keeps it. */
export interface SavedCall {
  id: string
  chatId?: string
  startedAt: string
  endedAt: string
  turns: { at: string; who: 'person' | 'voice' | 'crew'; text: string }[]
  rounds: { colonyId: string; round?: number }[]
}

/** A call in the chat: when and how long, opening to its transcript. */
export function CallCard(props: { call: SavedCall }) {
  const t = copy.call
  const [open, setOpen] = useState(false)
  const minutes = Math.round((Date.parse(props.call.endedAt) - Date.parse(props.call.startedAt)) / 60_000)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-left text-callout transition-colors hover:bg-surface-2"
      >
        <Phone className="size-3.5 text-muted" />
        <span className="font-medium">{t.card.title(minutes)}</span>
        <span className="text-muted">
          {new Date(props.call.startedAt).toLocaleTimeString([], { timeStyle: 'short' })}
        </span>
        <span className="flex-1" />
        <span className="text-footnote text-muted">{open ? t.card.hide : t.card.show}</span>
        <ChevronRight className={cn('size-3.5 text-muted transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5 rounded-xl bg-surface-2 px-4 py-3 text-callout">
          {props.call.turns.map((turn) => (
            <div key={`${turn.at}-${turn.who}`} className={cn(turn.who === 'crew' && 'text-muted')}>
              <span className="font-medium text-fg-2">
                {turn.who === 'person' ? t.you : turn.who === 'voice' ? t.voice : t.card.crew}:{' '}
              </span>
              <span className="whitespace-pre-wrap">{turn.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
