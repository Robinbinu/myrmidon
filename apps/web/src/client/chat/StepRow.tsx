import { CircleAlert, Megaphone, Search, TriangleAlert, UserPlus } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { blobImage } from '../api.ts'
import { OPEN_SETTINGS_EVENT } from '../ComputerUse.tsx'
import { copy } from '../copy.ts'
import { diffLines } from '../diff.ts'
import { clock } from '../ui/hooks.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { cn } from '../ui/primitives.tsx'
import { softSpring } from '../ui-config.ts'
import { DiffLines } from './ApprovalCards.tsx'
import { useOpenProjectFile } from './ProjectFiles.tsx'
import type { Step, StepKind } from './steps.ts'
import { CellDisplays } from './visuals/CellDisplays.tsx'

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
  advice: { icon: FEATURE_ICONS.advisor, color: 'text-muted' },
  computer: { icon: FEATURE_ICONS.computerUse, color: 'text-warn-ink' },
  computerSetup: { icon: FEATURE_ICONS.computerUse, color: 'text-warn-ink' },
  cell: { icon: FEATURE_ICONS.codeCells, color: 'text-fg-2' },
}

/** One line of the activity feed: kind icon, who, what, when. `hideAgent` drops the name in a one-agent view. */
export function StepRow({ step, hideAgent }: { step: Step; hideAgent?: boolean }) {
  const style = STEP_STYLE[step.kind]
  const openFile = useOpenProjectFile()
  // React mounts a closed <details>'s children too: the screenshot waits until the step is first opened.
  const [shotOpened, setShotOpened] = useState(false)
  const change = step.change
  // A write's whole content is new; an edit shows the text it replaced against its replacement.
  const lines = useMemo(
    () =>
      change &&
      (change.before === undefined
        ? change.after.split('\n').map((text) => ({ kind: 'add' as const, text }))
        : diffLines(change.before, change.after)),
    [change],
  )
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
      {step.displays ? (
        // Open from the start: what a cell showed is why it is a step at all.
        <details open className="group min-w-0 break-words pt-0.5">
          <summary className="list-none marker:hidden hover:text-fg">
            {!hideAgent && <span className="text-muted">{step.agent} · </span>}
            {step.lead} <span className="font-semibold text-fg">{step.strong}</span>
          </summary>
          <CellDisplays colony={step.displays.colony} displays={step.displays.items} />
        </details>
      ) : step.shot ? (
        <details
          className="group min-w-0 break-words pt-0.5"
          onToggle={(e) => e.currentTarget.open && setShotOpened(true)}
        >
          <summary className="list-none marker:hidden hover:text-fg">
            {!hideAgent && <span className="text-muted">{step.agent} · </span>}
            {step.lead} <span className="font-semibold text-fg">{step.strong}</span>{' '}
            {step.tail && <span className="text-muted">{step.tail}</span>}
          </summary>
          {shotOpened && <StepShot colony={step.shot.colony} blob={step.shot.blob} />}
        </details>
      ) : step.kind === 'computerSetup' ? (
        <span className="min-w-0 break-words pt-0.5">
          {!hideAgent && <span className="text-muted">{step.agent} · </span>}
          {step.lead} <span className="text-fg">{step.tail}</span>{' '}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: 'computer' }))}
            className="font-medium text-accent-fg hover:underline"
          >
            {copy.computerUse.blocked.open}
          </button>
        </span>
      ) : lines ? (
        <details className="group min-w-0 break-words pt-0.5">
          <summary className="list-none marker:hidden hover:text-fg">
            {!hideAgent && <span className="text-muted">{step.agent} · </span>}
            {step.lead} <span className="font-semibold text-fg">{step.strong}</span>
          </summary>
          <div className="mt-1.5 overflow-hidden rounded-xl border border-line bg-surface">
            <DiffLines lines={lines} />
          </div>
        </details>
      ) : step.detail ? (
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
      <span className="flex items-center gap-1 pt-0.5">
        {step.file && openFile && (
          <button
            type="button"
            onClick={() => step.file && openFile(step.file)}
            title={copy.projectFile.open(step.file)}
            aria-label={copy.projectFile.open(step.file)}
            className="grid size-5 place-items-center rounded-md text-muted transition-colors hover:bg-fill hover:text-fg"
          >
            <FEATURE_ICONS.projectFile className="size-3.5" />
          </button>
        )}
        <time dateTime={step.time} className="text-footnote tabular-nums text-muted">
          {clock(step.time)}
        </time>
      </span>
    </motion.li>
  )
}

/** A desktop step's screenshot, loaded when the step is opened (it is fetched with the auth header, not by URL). */
function StepShot(props: { colony: string; blob: string }) {
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let made: string | undefined
    let stop = false
    blobImage(props.colony, props.blob)
      .then((u) => {
        if (stop) URL.revokeObjectURL(u)
        else {
          made = u
          setUrl(u)
        }
      })
      .catch(() => !stop && setFailed(true))
    return () => {
      stop = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [props.colony, props.blob])
  return (
    <div className="mt-1.5 overflow-hidden rounded-xl border border-line bg-surface">
      {url ? (
        <img src={url} alt="" className="block w-full" />
      ) : failed ? (
        <p className="px-3 py-2 text-callout text-muted">{copy.computerUse.shotFailed}</p>
      ) : (
        <div className="h-24 animate-pulse bg-fill" />
      )}
    </div>
  )
}
