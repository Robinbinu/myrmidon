import type { ColonyState, EventPayloads, MyrEvent, TaskSnapshot } from '@myrmidon/protocol'
import { LayoutGroup, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { copy } from '../copy.ts'
import { duration } from '../ui/hooks.ts'
import { AgentAvatar } from '../ui/pixel.tsx'
import { cn, Dot } from '../ui/primitives.tsx'
import { softSpring } from '../ui-config.ts'

const LANES: { status: TaskSnapshot['status']; label: string }[] = [
  { status: 'in_progress', label: copy.taskBoard.lanes.inProgress },
  { status: 'submitted', label: copy.taskBoard.lanes.submitted },
  { status: 'rejected', label: copy.taskBoard.lanes.rejected },
  { status: 'pending', label: copy.taskBoard.lanes.pending },
  { status: 'verified', label: copy.taskBoard.lanes.verified },
]

/**
 * The task board as lanes by status, live while the round runs: cards move between lanes as tasks are claimed,
 * submitted, sent back and verified, and show how long each has been where it is. Lanes stack in a narrow panel
 * and sit side by side when there is room.
 */
export function TaskBoard(props: {
  tasks: readonly TaskSnapshot[]
  events: readonly MyrEvent[]
  agents: ColonyState['agents']
  live: boolean
  onInspect(agent: string): void
}) {
  // When each task last changed status, from the log.
  const since = useMemo(() => {
    const at = new Map<string, string>()
    for (const e of props.events)
      if (e.type === 'task/changed') at.set((e.payload as EventPayloads['task/changed']).task.id, e.time)
    return at
  }, [props.events])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!props.live) return
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [props.live])

  return (
    <div className="@container">
      <LayoutGroup>
        <div className="grid grid-cols-1 gap-3 p-3 @xl:grid-cols-2 @4xl:grid-cols-5">
          {LANES.map((lane) => {
            const cards = props.tasks.filter((t) => t.status === lane.status)
            return (
              <section
                key={lane.status}
                aria-label={lane.label}
                className={cn('flex min-w-0 flex-col gap-2', cards.length === 0 && 'opacity-60')}
              >
                <h3 className="flex items-center gap-2 px-1 section-label text-muted">
                  <Dot status={lane.status} pulse={false} />
                  {lane.label}
                  <span className="tabular-nums">{cards.length}</span>
                </h3>
                <ul className="flex flex-col gap-2">
                  {cards.map((t) => {
                    const at = since.get(t.id)
                    const owner = t.owner ?? t.assignee
                    return (
                      <motion.li
                        key={t.id}
                        layoutId={`board-${t.id}`}
                        layout
                        transition={softSpring}
                        className={cn(
                          'flex flex-col gap-1.5 rounded-lg border border-line bg-surface px-3 py-2.5',
                          lane.status === 'verified' && 'opacity-70',
                        )}
                      >
                        <div className="flex items-center gap-2 text-caption text-muted">
                          <span className="font-mono">{t.id}</span>
                          <span className="flex-1" />
                          {at && lane.status !== 'verified' && (
                            <span className="tabular-nums">
                              {copy.taskBoard.inLaneFor(duration(Math.max(0, now - Date.parse(at))))}
                            </span>
                          )}
                        </div>
                        <p className="line-clamp-2 text-body leading-snug">{t.subject}</p>
                        <div className="flex flex-wrap items-center gap-2 text-footnote text-muted">
                          {owner && (
                            <button
                              type="button"
                              onClick={() => props.onInspect(owner)}
                              className="-ml-0.5 flex items-center gap-1.5 rounded-md px-0.5 hover:text-fg"
                            >
                              <AgentAvatar
                                name={owner}
                                status={props.agents[owner]?.status ?? 'idle'}
                                size={18}
                              />
                              {owner}
                            </button>
                          )}
                          {lane.status === 'pending' && t.blockedBy.length > 0 && (
                            <span>{copy.taskBoard.after(t.blockedBy.join(', '))}</span>
                          )}
                        </div>
                      </motion.li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      </LayoutGroup>
    </div>
  )
}
