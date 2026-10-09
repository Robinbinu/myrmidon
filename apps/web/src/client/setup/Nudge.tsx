import type { SetupStep } from '@myrmidon/protocol'
import { X } from 'lucide-react'
import { copy } from '../copy.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Button, IconButton } from '../ui/primitives.tsx'

/**
 * On the home screen once setup is finished: what was set up later and is still not there, and a way back to it.
 * Dismissing it hides it for good; the steps stay in Settings → General.
 */
export function SetupNudge(props: {
  left: readonly SetupStep[]
  onOpen(step: SetupStep): void
  onDismiss(): void
}) {
  const t = copy.setup
  const first = props.left[0]
  if (!first) return null
  return (
    <div className="mb-3 flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-pop">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-fg">
        <FEATURE_ICONS.setup className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-reading font-semibold">{t.nudge.title(props.left.length)}</p>
        <p className="truncate text-callout leading-snug text-muted">
          {t.nudge.body(props.left.map((s) => t.steps[s]).join(', '))}
        </p>
      </div>
      <Button onClick={() => props.onOpen(first)}>{t.nudge.action}</Button>
      <IconButton label={t.nudge.dismiss} title={t.nudge.dismissTitle} onClick={props.onDismiss}>
        <X className="size-4" />
      </IconButton>
    </div>
  )
}
