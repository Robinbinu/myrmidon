import {
  BadgeCheck,
  CircleAlert,
  FileCode,
  Globe,
  ListChecks,
  Megaphone,
  Search,
  Terminal,
  TriangleAlert,
  UserPlus,
} from 'lucide-react'
import { motion } from 'motion/react'
import { cn, softSpring } from '../ui/primitives.tsx'
import type { Step, StepKind } from './steps.ts'

const STEP_STYLE: Record<StepKind, { icon: typeof Search; color: string }> = {
  search: { icon: Search, color: 'text-fg-2' },
  fetch: { icon: Globe, color: 'text-fg-2' },
  file: { icon: FileCode, color: 'text-accent' },
  task: { icon: ListChecks, color: 'text-warn' },
  team: { icon: UserPlus, color: 'text-work' },
  verdict: { icon: BadgeCheck, color: 'text-ok' },
  error: { icon: TriangleAlert, color: 'text-bad' },
  shell: { icon: Terminal, color: 'text-fg-2' },
  talk: { icon: Megaphone, color: 'text-muted' },
  signal: { icon: CircleAlert, color: 'text-warn' },
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
      className="relative grid grid-cols-[24px_1fr_auto] items-start gap-2.5 py-1.5 text-[13px] text-fg-2"
    >
      <span
        className={cn(
          'z-10 grid size-6 place-items-center rounded-lg border border-line bg-surface',
          style.color,
        )}
      >
        <style.icon className="size-3" />
      </span>
      <span className="min-w-0 break-words pt-0.5">
        {!hideAgent && <span className="text-muted">{step.agent} · </span>}
        {step.lead} {step.strong && <span className="font-semibold text-fg">{step.strong}</span>}{' '}
        {step.tail && <span className="text-muted">{step.tail}</span>}
      </span>
      <time dateTime={step.time} className="pt-0.5 text-[11.5px] tabular-nums text-muted">
        {step.time.slice(11, 16)}
      </time>
    </motion.li>
  )
}
