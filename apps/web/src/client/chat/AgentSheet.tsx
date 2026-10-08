import type { ColonyState, EventPayloads, MyrEvent } from '@myrmidon/protocol'
import { BookmarkPlus, FileText, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useRef, useState } from 'react'
import type { ModelOption } from '../api.ts'
import { copy } from '../copy.ts'
import { useSpecialists } from '../specialists.ts'
import { compact } from '../ui/hooks.ts'
import { useDialog } from '../ui/Modal.tsx'
import { AgentAvatar, DotMatrix } from '../ui/pixel.tsx'
import { Button, cn, Dot, IconButton } from '../ui/primitives.tsx'
import { agentPhase } from '../ui/status.ts'
import { softSpring } from '../ui-config.ts'
import { SpecialistEditor } from './SpecialistEditor.tsx'
import { StepRow } from './StepRow.tsx'
import { deriveSteps } from './steps.ts'

function Section(props: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('border-t border-line px-5 py-4', props.className)}>
      <h3 className="mb-2 section-label text-muted">{props.title}</h3>
      {props.children}
    </section>
  )
}

/**
 * What one agent is doing, live: its focus, the task in hand, its latest thinking, and every step it has
 * taken, newest first. Opens from any agent chip or avatar in a chat.
 */
export function AgentSheet(props: {
  name: string
  state: ColonyState
  events: readonly MyrEvent[]
  onClose(): void
  /** Models to offer when keeping this worker as a specialist. */
  models?: readonly ModelOption[]
}) {
  const agent = props.state.agents[props.name]
  const [keeping, setKeeping] = useState(false)
  const kept = useSpecialists().find((s) => s.name === props.name)
  const sheet = useRef<HTMLElement>(null)
  useDialog(sheet, props.onClose)

  const { focus, thought, steps } = useMemo(() => {
    let focus: string | undefined
    let thought: EventPayloads['llm/response'] | undefined
    for (const e of props.events) {
      if (e.type === 'agent/joined') {
        const p = e.payload as EventPayloads['agent/joined']
        if (p.agent.name === props.name && p.focus) focus = p.focus
      } else if (e.type === 'llm/response') {
        const p = e.payload as EventPayloads['llm/response']
        if (p.agent === props.name && (p.text.trim() || p.thinking?.trim())) thought = p
      }
    }
    const steps = deriveSteps(props.events)
      .filter((s) => s.agent === props.name)
      .reverse()
    return { focus, thought, steps }
  }, [props.events, props.name])

  const tasks = Object.values(props.state.tasks).filter(
    (t) => t.owner === props.name && t.status !== 'deleted',
  )
  const current = tasks.find((t) => t.status === 'in_progress')
  const files = Object.entries(props.state.artifacts).filter(([, v]) => v.at(-1)?.author === props.name)
  if (!agent) return null
  const lead = agent.info.role === 'lead'
  const { phase } = agentPhase(agent, props.state)

  return (
    <>
      <motion.button
        type="button"
        aria-label={copy.agentSheet.close}
        className="fixed inset-0 z-40 bg-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={props.onClose}
      />
      <motion.aside
        ref={sheet}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={copy.agentSheet.label(props.name)}
        className="fixed inset-y-2 right-2 z-50 flex w-[min(460px,calc(100vw-16px))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop outline-none"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={softSpring}
      >
        <header className="flex items-start gap-4 px-5 pb-4 pt-5">
          <AgentAvatar name={props.name} status={phase} size={64} />
          <div className="min-w-0 flex-1 pt-1">
            <div className="flex items-center gap-2">
              <h2 className="text-page-title font-semibold tracking-tight">{props.name}</h2>
              <span className="rounded-full border border-line px-2 py-px text-caption text-muted">
                {lead ? copy.agentSheet.leadBadge : (agent.info.specialty ?? agent.info.role)}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-body text-fg-2">
              <Dot status={phase} />
              {copy.status.agent[phase]}
            </div>
            <div className="mt-0.5 truncate font-mono text-footnote text-muted">{agent.info.model}</div>
          </div>
          <IconButton label={copy.agentSheet.close} onClick={props.onClose}>
            <X className="size-4" />
          </IconButton>
        </header>
        {!lead && (
          <div className="border-b border-line px-5 pb-3">
            {keeping ? (
              <SpecialistEditor
                models={props.models ?? []}
                initial={
                  kept ?? {
                    name: props.name,
                    specialty: agent.info.specialty ?? '',
                    instructions: focus ?? '',
                    model: agent.info.model,
                  }
                }
                onSaved={() => setKeeping(false)}
                onCancel={() => setKeeping(false)}
              />
            ) : (
              <Button
                size="sm"
                variant="borderless"
                icon={<BookmarkPlus className="size-3.5" />}
                onClick={() => setKeeping(true)}
              >
                {kept ? copy.settings.specialists.edit : copy.settings.specialists.saveFromChat}
              </Button>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <Section title={lead ? copy.agentSheet.sections.role : copy.agentSheet.sections.focus}>
            <p className="text-reading leading-relaxed text-fg-2">
              {focus ?? (lead ? copy.agentSheet.defaultFocus.lead : copy.agentSheet.defaultFocus.worker)}
            </p>
          </Section>

          {current && (
            <Section title={copy.agentSheet.sections.workingOn}>
              <p className="text-reading font-medium">{current.subject}</p>
              {current.description && (
                <p className="mt-1 line-clamp-3 text-callout text-muted">{current.description}</p>
              )}
            </Section>
          )}

          {thought && (
            <Section title={copy.agentSheet.sections.latestThinking}>
              {thought.text.trim() && (
                <p className="whitespace-pre-wrap text-body leading-relaxed text-fg-2">
                  {thought.text.trim().slice(0, 1200)}
                </p>
              )}
              {thought.thinking?.trim() && (
                <details className="mt-2 text-callout text-muted">
                  <summary>{copy.agentSheet.reasoning}</summary>
                  <p className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap">
                    {thought.thinking.trim()}
                  </p>
                </details>
              )}
            </Section>
          )}

          <Section title={copy.agentSheet.sections.soFar}>
            <div className="flex flex-wrap gap-5">
              {[
                [copy.agentSheet.stats.turns, String(agent.turns)],
                [copy.agentSheet.stats.tokens, compact(agent.tokens)],
                [copy.agentSheet.stats.tools, String(agent.toolCalls)],
                [copy.agentSheet.stats.tasks, String(tasks.length)],
              ].map(([label, value]) => (
                <span key={label} className="flex flex-col gap-1">
                  <DotMatrix text={value ?? ''} dot={2.1} className="text-fg" />
                  <span className="section-label text-muted">{label}</span>
                </span>
              ))}
            </div>
          </Section>

          {files.length > 0 && (
            <Section title={copy.agentSheet.sections.files}>
              <ul className="flex flex-col gap-1">
                {files.map(([name, versions]) => (
                  <li key={name} className="flex items-center gap-2 text-body">
                    <FileText className="size-3.5 text-muted" />
                    <span className="truncate">{name}</span>
                    <span className="ml-auto text-footnote tabular-nums text-muted">
                      v{versions.at(-1)?.version}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title={copy.agentSheet.sections.activity(steps.length)}>
            {steps.length === 0 ? (
              <p className="text-body text-muted">{copy.agentSheet.nothingYet}</p>
            ) : (
              <ol className="relative flex flex-col">
                <span className="absolute bottom-3 left-[11px] top-3 w-px bg-line" aria-hidden />
                <AnimatePresence initial={false}>
                  {steps.map((s) => (
                    <StepRow key={s.id} step={s} hideAgent />
                  ))}
                </AnimatePresence>
              </ol>
            )}
          </Section>
        </div>
      </motion.aside>
    </>
  )
}
