import { Mic, MicOff, PhoneOff } from 'lucide-react'
import { motion } from 'motion/react'
import { useSyncExternalStore } from 'react'
import { copy } from '../copy.ts'
import { isMac } from '../ui/platform.ts'
import { Button, cn, IconButton } from '../ui/primitives.tsx'
import { comboLabel } from '../ui/shortcuts.ts'
import { CALL_HANG_UP_COMBO, CALL_MUTE_COMBO } from '../ui-config.ts'
import type { CallState } from './call-client.ts'

export interface CallLine {
  readonly who: 'person' | 'voice'
  readonly text: string
  /** Who said a `voice` line: `assistant`, `lead` or a crew member's name. */
  readonly from?: string
}

/** Who a call reached or who spoke on it (`assistant`, `lead` or a crew member's name), as said in the bar. */
export function callee(talk: string): string {
  return talk === 'assistant' ? copy.call.assistantName : talk === 'lead' ? copy.call.leadName : talk
}

/** The name a line of the call is labelled with. */
export function speaker(talk: string): string {
  return talk === 'assistant' ? copy.call.speaker.assistant : talk === 'lead' ? copy.call.speaker.lead : talk
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
  const current = useSyncExternalStore(
    subscribe,
    () => level,
    () => 0,
  )
  const h = props.active ? Math.min(1, current * 8) : 0
  return (
    <span aria-hidden className="flex h-4 items-center gap-0.5">
      {[0.6, 1, 0.75].map((k) => (
        <motion.span
          key={k}
          className={cn('w-0.75 rounded-full', props.active ? 'bg-accent' : 'bg-muted/50')}
          animate={{ height: `${Math.max(3, Math.round(16 * h * k))}px` }}
          transition={{ duration: 0.08 }}
        />
      ))}
    </span>
  )
}

/**
 * The bar under the toolbar while a call is on: its state, who it reached and in which chat, the mic level, the last
 * lines said or the approval waiting, mute and hang up. Only the state, new lines and the approval are announced.
 */
export function CallBar(props: {
  /** Who the call reached: `assistant`, `lead` or a crew member's name. */
  talk: string
  /** The chat the call is in, once it has one; opening it shows that chat. */
  chat?: { title: string; onOpen(): void }
  /** How long the last answer took to start. */
  latency?: number
  state: CallState
  lines: readonly CallLine[]
  /** What waits for the person's yes or no. */
  approval?: string
  muted: boolean
  onMute(muted: boolean): void
  onHangUp(): void
}) {
  const t = copy.call
  const last = props.lines.slice(props.approval ? -1 : -2)
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      className="shrink-0 overflow-hidden border-b border-line bg-accent-soft/40"
    >
      <div className="flex items-center gap-3 px-4 py-2">
        <Meter active={!props.muted} />
        <span className="w-40 shrink-0 text-callout">
          <span role="status" className="block font-medium text-fg-2">
            {props.muted ? t.states.muted : t.states[props.state]}
          </span>
          <span className="block truncate text-footnote text-muted">
            {t.with(callee(props.talk))}
            {props.latency !== undefined && ` · ${t.latency(props.latency)}`}
          </span>
          {props.chat && (
            <button
              type="button"
              onClick={props.chat.onOpen}
              title={t.openChat(props.chat.title)}
              className="block h-6 max-w-full truncate rounded-sm text-left text-footnote text-fg-2 underline-offset-2 hover:text-fg hover:underline"
            >
              {t.inChat(props.chat.title)}
            </button>
          )}
        </span>
        <div className="min-w-0 flex-1 text-callout">
          {props.approval && (
            <div role="status" className="truncate">
              <span className="font-medium text-accent-fg">{t.approval} </span>
              {props.approval}
            </div>
          )}
          <div role="log" aria-live="polite">
            {last.map((l) => (
              <div key={`${l.who}-${l.text}`} className="truncate">
                <span className="font-medium text-muted">
                  {l.who === 'person' ? t.you : speaker(l.from ?? props.talk)}:{' '}
                </span>
                {l.text}
              </div>
            ))}
          </div>
        </div>
        <IconButton
          label={props.muted ? t.unmute : t.mute}
          title={copy.sidebar.withShortcut(
            props.muted ? t.unmute : t.mute,
            comboLabel(CALL_MUTE_COMBO, isMac),
          )}
          active={props.muted}
          onClick={() => props.onMute(!props.muted)}
        >
          {props.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
        </IconButton>
        <Button
          variant="danger"
          icon={<PhoneOff className="size-3.5" />}
          title={copy.sidebar.withShortcut(t.hangUp, comboLabel(CALL_HANG_UP_COMBO, isMac))}
          onClick={props.onHangUp}
        >
          {t.hangUp}
        </Button>
      </div>
    </motion.div>
  )
}
