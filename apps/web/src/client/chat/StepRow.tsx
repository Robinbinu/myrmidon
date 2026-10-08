import { CircleAlert, Megaphone, Search, TriangleAlert, UserPlus } from 'lucide-react'
import { motion } from 'motion/react'
import { clock } from '../ui/hooks.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { cn } from '../ui/primitives.tsx'
import { softSpring } from '../ui-config.ts'
import type { Step, StepKind } from './steps.ts'

const STEP_STYLE: Record<StepKind, { icon: typeof Search; color: string }> = {
  search: { icon: Search, color: 'text-fg-2' },
  fetch: { icon: FEATURE_ICONS.web, color: 'text-fg-2' },
  file: { icon: FEATURE_ICONS.files, color: 'text-accent-fg' },
  task: { icon: FEATURE_ICONS.tasks, color: 'text-warn-ink' },
  team: { icon: UserPlus, color: 'text-work-ink' },
  verdict: { icon: FEATURE_ICONS.verdict, color: 'text-ok-ink' },
  error: { icon: TriangleAlert, color: 'text-bad-ink' },
  shell: { icon: FEATURE_ICONS.agentShell, color: 'text-fg-2' },
  talk: { icon: Megaphone, color: 'text-muted' },
  signal: { icon: CircleAlert, color: 'text-warn-ink' },
  think: { icon: FEATURE_ICONS.thinking, color: 'text-muted' },
}

/** One line of the activity feed: kind icon, who, what, when. `hideAgent` drops the name in a one-agent view. */
export function StepRow({ step, hideAgent }: { step: Step; hideAgent?: boolean }) {
  const style = STEP_STYLE[step.kind]
  return (
    <motion.li
      layout
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      transition={softSpring}
      className="relative grid grid-cols-[24px_1fr_auto] items-start gap-2.5 py-1.5 text-body text-fg-2"
    >
      <span
        className={cn(
          'z-10 grid size-6 place-items-center rounded-xl border border-line bg-surface',
          style.color,
        )}
      >
        <style.icon className="size-3" />
      </span>
      {step.detail ? (
        <details className="group min-w-0 break-words pt-0.5">
          <summary className="list-none text-muted marker:hidden hover:text-fg-2">
            {!hideAgent && <span>{step.agent} · </span>}
            {step.lead} <span className="italic">{step.strong}</span>
          </summary>
          <div className="mt-1.5 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border border-line bg-fill px-3 py-2 text-callout leading-relaxed text-fg-2">
            {step.detail}
          </div>
        </details>
      ) : (
        <span className="min-w-0 break-words pt-0.5">
          {!hideAgent && <span className="text-muted">{step.agent} · </span>}
          {step.lead} {step.strong && <span className="font-semibold text-fg">{step.strong}</span>}{' '}
          {step.tail && <span className="text-muted">{step.tail}</span>}
        </span>
      )}
      <time dateTime={step.time} className="pt-0.5 text-footnote tabular-nums text-muted">
        {clock(step.time)}
      </time>
    </motion.li>
  )
}
