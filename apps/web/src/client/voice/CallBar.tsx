import { Mic, MicOff, PhoneOff } from 'lucide-react'
import { motion } from 'motion/react'
import { useSyncExternalStore } from 'react'
import { copy } from '../copy.ts'
import { Button, cn, IconButton } from '../ui/primitives.tsx'
import type { CallState } from './call-client.ts'

export interface CallLine {
  readonly who: 'person' | 'voice'
  readonly text: string
}

/**
 * The mic's level, kept outside React state: it changes 50 times a second, and only the meter needs it.
 */
let level = 0
const listeners = new Set<() => void>()
export function setMicLevel(next: number) {
  if (Math.abs(next - level) < 0.004) return
  level = next
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Three bars that follow the mic's level while the person can be heard. */
function Meter(props: { active: boolean }) {
  const current = useSyncExternalStore(subscribe, () => level)
  const h = props.active ? Math.min(1, current * 8) : 0
  return (
    <span aria-hidden className="flex h-4 items-center gap-[2px]">
      {[0.6, 1, 0.75].map((k) => (
        <motion.span
          key={k}
          className={cn('w-[3px] rounded-full', props.active ? 'bg-accent' : 'bg-muted/50')}
          animate={{ height: `${Math.max(3, Math.round(16 * h * k))}px` }}
          transition={{ duration: 0.08 }}
        />
      ))}
    </span>
  )
}

/** The bar under the toolbar while a call is on: its state, the mic level, the last lines said, mute and hang up. */
export function CallBar(props: {
  state: CallState
  lines: readonly CallLine[]
  muted: boolean
  onMute(muted: boolean): void
  onHangUp(): void
}) {
  const t = copy.call
  const last = props.lines.slice(-2)
  return (
    <motion.div
      role="status"
      aria-live="polite"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      className="shrink-0 overflow-hidden border-b border-line bg-accent-soft/40"
    >
      <div className="flex items-center gap-3 px-4 py-2">
        <Meter active={!props.muted} />
        <span className="w-24 shrink-0 text-callout font-medium text-fg-2">{t.states[props.state]}</span>
        <div className="min-w-0 flex-1 text-callout">
          {last.map((l) => (
            <div key={`${l.who}-${l.text}`} className="truncate">
              <span className="font-medium text-muted">{l.who === 'person' ? t.you : t.voice}: </span>
              {l.text}
            </div>
          ))}
        </div>
        <IconButton
          label={props.muted ? t.unmute : t.mute}
          active={props.muted}
          onClick={() => props.onMute(!props.muted)}
        >
          {props.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
        </IconButton>
        <Button size="sm" variant="danger" icon={<PhoneOff className="size-3.5" />} onClick={props.onHangUp}>
          {t.hangUp}
        </Button>
      </div>
    </motion.div>
  )
}
