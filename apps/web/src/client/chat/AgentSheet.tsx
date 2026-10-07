import type { ColonyState, EventPayloads, MyrEvent } from '@myrmidon/protocol'
import { FileText, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo } from 'react'
import { compact } from '../ui/hooks.ts'
import { AgentAvatar, DotMatrix } from '../ui/pixel.tsx'
import { cn, Dot, IconButton, softSpring } from '../ui/primitives.tsx'
import { StepRow } from './StepRow.tsx'
import { deriveSteps } from './steps.ts'

const STATUS_LABEL: Record<string, string> = {
  provisioning: 'Starting up',
  ready: 'Ready',
  working: 'Working',
  idle: 'Waiting for work',
  completed: 'Done',
  stopped: 'Resting',
  failed: 'Failed',
}

function Section(props: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('border-t border-line px-5 py-4', props.className)}>
      <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{props.title}</h3>
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
}) {
  const agent = props.state.agents[props.name]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

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

  return (
    <>
      <motion.button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-40 bg-black/25"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={props.onClose}
      />
      <motion.aside
        role="dialog"
        aria-label={`${props.name} details`}
        className="fixed inset-y-2 right-2 z-50 flex w-[min(460px,calc(100vw-16px))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={softSpring}
      >
        <header className="flex items-start gap-4 px-5 pb-4 pt-5">
          <AgentAvatar name={props.name} status={agent.status} size={64} />
          <div className="min-w-0 flex-1 pt-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[20px] font-semibold tracking-tight">{props.name}</h2>
              <span className="rounded-full border border-line px-2 py-px text-[11px] text-muted">
                {lead ? 'lead' : (agent.info.specialty ?? agent.info.role)}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[13px] text-fg-2">
              <Dot status={agent.status === 'stopped' ? 'idle' : agent.status} />
              {STATUS_LABEL[agent.status] ?? agent.status}
            </div>
            <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted">{agent.info.model}</div>
          </div>
          <IconButton label="Close" onClick={props.onClose}>
            <X className="size-4" />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <Section title={lead ? 'Role' : 'Focus'}>
            <p className="text-[13.5px] leading-relaxed text-fg-2">
              {focus ??
                (lead
                  ? 'Plans the work, brings in workers, and answers you.'
                  : 'Picks up tasks from the board.')}
            </p>
          </Section>

          {current && (
            <Section title="Working on">
              <p className="text-[13.5px] font-medium">{current.subject}</p>
              {current.description && (
                <p className="mt-1 line-clamp-3 text-[12.5px] text-muted">{current.description}</p>
              )}
            </Section>
          )}

          {thought && (
            <Section title="Latest thinking">
              {thought.text.trim() && (
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg-2">
                  {thought.text.trim().slice(0, 1200)}
                </p>
              )}
              {thought.thinking?.trim() && (
                <details className="mt-2 text-[12.5px] text-muted">
                  <summary>Reasoning</summary>
                  <p className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap">
                    {thought.thinking.trim()}
                  </p>
                </details>
              )}
            </Section>
          )}

          <Section title="So far">
            <div className="flex flex-wrap gap-5">
              {[
                ['turns', String(agent.turns)],
                ['tokens', compact(agent.tokens)],
                ['tools', String(agent.toolCalls)],
                ['tasks', String(tasks.length)],
              ].map(([label, value]) => (
                <span key={label} className="flex flex-col gap-1">
                  <DotMatrix text={value ?? ''} dot={2.1} className="text-fg" />
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    {label}
                  </span>
                </span>
              ))}
            </div>
          </Section>

          {files.length > 0 && (
            <Section title="Files">
              <ul className="flex flex-col gap-1">
                {files.map(([name, versions]) => (
                  <li key={name} className="flex items-center gap-2 text-[13px]">
                    <FileText className="size-3.5 text-muted" />
                    <span className="truncate">{name}</span>
                    <span className="ml-auto text-[11.5px] tabular-nums text-muted">
                      v{versions.at(-1)?.version}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title={`Activity · ${steps.length}`}>
            {steps.length === 0 ? (
              <p className="text-[13px] text-muted">Nothing yet.</p>
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
