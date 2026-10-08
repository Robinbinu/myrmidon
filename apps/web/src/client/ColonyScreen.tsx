import {
  type ColonyState,
  colonyMetrics,
  DELIVERED_VERIFIER,
  type EventPayloads,
  type MyrEvent,
  reviewVerdicts,
  stopCause,
} from '@myrmidon/protocol'
import {
  Activity,
  BadgeCheck,
  ChevronRight,
  CircleDot,
  FileCode,
  Gavel,
  ListChecks,
  Mail,
  Megaphone,
  MessageSquare,
  Network,
  Pause,
  Play,
  Radio,
  SkipBack,
  SkipForward,
  TriangleAlert,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { ColonyMap } from './ColonyMap.tsx'
import { ArtifactViewer } from './chat/ArtifactViewer.tsx'
import { Markdown } from './chat/Markdown.tsx'
import { copy } from './copy.ts'
import { describeEvent } from './describe.ts'
import { clock, compact, duration, money } from './ui/hooks.ts'
import { AgentAvatar } from './ui/pixel.tsx'
import { cn, Dot, Empty, Pill, Tabs, toneFor } from './ui/primitives.tsx'
import { agentPhase, runPhase } from './ui/status.ts'
import { MAX_ACTIVITY_ITEMS, REPLAY_SPEEDS } from './ui-config.ts'
import { useColony } from './use-colony.ts'

type Tab = 'activity' | 'board' | 'tasks' | 'files' | 'map' | 'verdicts'

type Item =
  | { kind: 'say'; id: string; time: string; agent: string; text: string; thinking?: string; error?: string }
  | {
      kind: 'tool'
      id: string
      time: string
      agent: string
      tool: string
      args: Record<string, unknown>
      ok?: boolean
      output?: string
    }
  | {
      kind: 'event'
      id: string
      time: string
      agent: string
      icon: typeof Mail
      tone: string
      text: string
      body?: string
    }

function argSummary(tool: string, args: Record<string, unknown>): string {
  const pick = ['query', 'url', 'command', 'name', 'path', 'id', 'subject', 'to', 'text', 'summary']
  for (const k of pick) if (typeof args[k] === 'string') return String(args[k]).slice(0, 140)
  return tool === 'read_task' || tool === 'observe' || tool.startsWith('list_')
    ? ''
    : JSON.stringify(args).slice(0, 140)
}

function agentOf(e: MyrEvent): string | undefined {
  // `agent/joined` carries the whole agent record; everything else names the agent directly.
  const p = e.payload as { agent?: string | { name: string }; from?: string; author?: string; by?: string }
  const agent = typeof p.agent === 'object' ? p.agent.name : p.agent
  return agent ?? p.from ?? p.author ?? p.by
}

/** Builds the activity stream (newest first) from the log up to the replay cursor. */
function buildItems(events: readonly MyrEvent[], cursor: number, agent?: string): Item[] {
  const calls = new Map<string, Item & { kind: 'tool' }>()
  const items: Item[] = []
  for (const e of events.slice(0, cursor)) {
    const who = agentOf(e) ?? copy.colonyScreen.agents.system
    if (
      agent &&
      who !== agent &&
      e.type !== 'verifier/verdict' &&
      !(e.type === 'mail/sent' && (e.payload as { to: string }).to === agent)
    )
      continue
    const base = { id: e.id, time: e.time, agent: who }
    switch (e.type) {
      case 'llm/response': {
        const p = e.payload as EventPayloads['llm/response']
        if (p.text.trim() || p.error)
          items.push({
            ...base,
            kind: 'say',
            text: p.text,
            ...(p.thinking ? { thinking: p.thinking } : {}),
            ...(p.error ? { error: p.error } : {}),
          })
        break
      }
      case 'tool/call': {
        const p = e.payload as EventPayloads['tool/call']
        const item = {
          ...base,
          kind: 'tool' as const,
          tool: p.tool,
          args: (p.args ?? {}) as Record<string, unknown>,
        }
        calls.set(p.callId, item)
        items.push(item)
        break
      }
      case 'tool/result': {
        const p = e.payload as EventPayloads['tool/result']
        const call = calls.get(p.callId)
        if (call) Object.assign(call, { ok: p.ok, output: p.output })
        break
      }
      case 'mail/sent': {
        const p = e.payload as EventPayloads['mail/sent']
        items.push({
          ...base,
          kind: 'event',
          icon: Mail,
          tone: 'text-work-ink',
          text: `${p.from} → ${p.to}${p.subject ? ` · ${p.subject}` : ''}`,
          body: p.body,
        })
        break
      }
      case 'board/posted': {
        const p = e.payload as EventPayloads['board/posted']
        items.push({
          ...base,
          kind: 'event',
          icon: Megaphone,
          tone: 'text-fg-2',
          text: copy.colonyScreen.activity.postedToBoard,
          body: p.text,
        })
        break
      }
      case 'chat/user': {
        const p = e.payload as EventPayloads['chat/user']
        items.push({
          ...base,
          agent: copy.colonyScreen.agents.you,
          kind: 'event',
          icon: MessageSquare,
          tone: 'text-accent-fg',
          text: copy.colonyScreen.activity.messageFromYou,
          body: p.text,
        })
        break
      }
      case 'chat/reply': {
        const p = e.payload as EventPayloads['chat/reply']
        items.push({
          ...base,
          kind: 'event',
          icon: MessageSquare,
          tone: 'text-accent-fg',
          text: p.final ? copy.colonyScreen.activity.finalAnswer : copy.colonyScreen.activity.replied,
          body: p.text,
        })
        break
      }
      case 'task/changed': {
        const p = e.payload as EventPayloads['task/changed']
        items.push({
          ...base,
          kind: 'event',
          icon: ListChecks,
          tone: 'text-warn-ink',
          text: `${p.task.id} → ${p.task.status.replace('_', ' ')}: ${p.task.subject}`,
        })
        break
      }
      case 'artifact/versioned': {
        const p = e.payload as EventPayloads['artifact/versioned']
        items.push({
          ...base,
          kind: 'event',
          icon: FileCode,
          tone: 'text-accent-fg',
          text: copy.colonyScreen.activity.published(p.name, p.version, compact(p.size)),
        })
        break
      }
      case 'verifier/verdict': {
        const p = e.payload as EventPayloads['verifier/verdict']
        if (p.verifierId === DELIVERED_VERIFIER) {
          items.push({
            ...base,
            agent: copy.colonyScreen.agents.colony,
            kind: 'event',
            icon: CircleDot,
            tone: 'text-muted',
            text: copy.events.notReviewed,
          })
          break
        }
        items.push({
          ...base,
          agent: p.verifierId,
          kind: 'event',
          icon: Gavel,
          tone: p.pass ? 'text-ok-ink' : 'text-bad-ink',
          text: `${copy.colonyScreen.activity.verdict(p.pass ? copy.colonyScreen.pass : copy.colonyScreen.fail, copy.reviewTarget(p.target))}${p.score !== undefined ? ` · ${copy.colonyScreen.score(p.score.toFixed(2))}` : ''}`,
          body: p.evidence,
        })
        break
      }
      case 'agent/joined': {
        const p = e.payload as EventPayloads['agent/joined']
        items.push({
          ...base,
          kind: 'event',
          icon: UserPlus,
          tone: 'text-work-ink',
          text: copy.colonyScreen.activity.broughtIn(p.agent.name, p.agent.model),
          body: p.focus,
        })
        break
      }
      case 'observer/signal': {
        const p = e.payload as EventPayloads['observer/signal']
        items.push({
          ...base,
          agent: copy.colonyScreen.agents.observer,
          kind: 'event',
          icon: TriangleAlert,
          tone: 'text-warn-ink',
          text: `${copy.checkIn.kinds[p.kind] ?? p.kind} · ${copy.checkIn.severities[p.severity] ?? p.severity}`,
          body: p.facts,
        })
        break
      }
      case 'colony/started':
      case 'colony/completed':
      case 'colony/stopped': {
        items.push({
          ...base,
          agent: copy.colonyScreen.agents.colony,
          kind: 'event',
          icon: CircleDot,
          tone: 'text-muted',
          text: describeEvent(e),
        })
        break
      }
    }
  }
  return items.slice(-MAX_ACTIVITY_ITEMS).reverse()
}

/** Full colony view in the style of a coding-agent console: agents, a live activity stream, and a replay bar. */
export function ColonyScreen({ id }: { id: string; compact?: boolean }) {
  const colony = useColony(id)
  const { state, events, cursor } = colony
  const [tab, setTab] = useState<Tab>('activity')
  const [agent, setAgent] = useState<string>()
  const [file, setFile] = useState<string>()
  const m = colonyMetrics(state)
  const reviewed = reviewVerdicts(state)
  const run = runPhase({ status: state.status, ...stopCause(state) })
  const items = useMemo(() => buildItems(events, cursor, agent), [events, cursor, agent])
  const agents = Object.values(state.agents)
  const tasks = Object.values(state.tasks).filter((t) => t.status !== 'deleted')

  if (colony.error)
    return (
      <div className="m-4 rounded-lg bg-bad-soft px-4 py-3 text-reading text-bad-ink">{colony.error}</div>
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-headline font-semibold tracking-tight">{state.name}</h2>
            <Pill tone={toneFor(run)}>
              <Dot status={run} /> {copy.status.run[run]}
            </Pill>
          </div>
          {state.statusReason && <p className="truncate text-callout text-muted">{state.statusReason}</p>}
        </div>
        <div className="flex flex-wrap gap-4 text-callout tabular-nums text-muted">
          <Stat label={copy.colonyScreen.stats.time} value={duration(m.wallMs)} />
          <Stat label={copy.colonyScreen.stats.tokens} value={compact(m.tokens)} />
          <Stat label={copy.colonyScreen.stats.cost} value={money(m.cost, m.tokens)} />
          <Stat label={copy.colonyScreen.stats.toolCalls} value={String(m.toolCalls)} />
          <Stat label={copy.colonyScreen.stats.files} value={String(Object.keys(state.artifacts).length)} />
          <Stat
            label={copy.colonyScreen.stats.verdicts}
            value={`${reviewed.filter((v) => v.pass).length}/${reviewed.length}`}
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 flex-col overflow-auto border-r border-line p-2 md:flex">
          <div className="px-2 pb-1.5 pt-1 section-label text-muted">{copy.colonyScreen.agentsHeading}</div>
          <AgentButton
            active={!agent}
            onClick={() => setAgent(undefined)}
            icon={<Users className="size-4" />}
            name={copy.colonyScreen.everyone}
            detail={copy.colonyScreen.agentCount(agents.length)}
          />
          {agents.map((a) => {
            const { phase } = agentPhase(a, state)
            return (
              <AgentButton
                key={a.info.name}
                active={agent === a.info.name}
                onClick={() => setAgent(a.info.name)}
                icon={<AgentAvatar name={a.info.name} status={phase} size={32} />}
                name={a.info.name}
                detail={a.info.specialty ?? a.info.model.split('/').pop() ?? a.info.model}
                status={phase}
                meta={copy.colonyScreen.agentMeta(a.turns, compact(a.tokens))}
              />
            )
          })}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <Tabs
            id={`colony-${id}`}
            value={tab}
            onChange={setTab}
            tabs={[
              {
                value: 'activity',
                label: (
                  <>
                    <Activity className="size-3.5" /> {copy.colonyScreen.tabs.activity}
                  </>
                ),
              },
              {
                value: 'board',
                label: (
                  <>
                    <Megaphone className="size-3.5" /> {copy.colonyScreen.tabs.board}
                  </>
                ),
                count: state.board.length,
              },
              {
                value: 'tasks',
                label: (
                  <>
                    <ListChecks className="size-3.5" /> {copy.colonyScreen.tabs.tasks}
                  </>
                ),
                count: tasks.length,
              },
              {
                value: 'files',
                label: (
                  <>
                    <FileCode className="size-3.5" /> {copy.colonyScreen.tabs.files}
                  </>
                ),
                count: Object.keys(state.artifacts).length,
              },
              {
                value: 'map',
                label: (
                  <>
                    <Network className="size-3.5" /> {copy.colonyScreen.tabs.map}
                  </>
                ),
              },
              {
                value: 'verdicts',
                label: (
                  <>
                    <BadgeCheck className="size-3.5" /> {copy.colonyScreen.tabs.verdicts}
                  </>
                ),
                count: reviewed.length,
              },
            ]}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            {tab === 'activity' && <ActivityStream items={items} filtered={!!agent} />}
            {tab === 'board' && <Board state={state} />}
            {tab === 'tasks' && <Kanban state={state} />}
            {tab === 'files' && <Files state={state} onOpen={setFile} />}
            {tab === 'map' && (
              <div className="h-full bg-bg">
                <ColonyMap
                  state={state}
                  events={events}
                  cursor={cursor}
                  selected={agent}
                  onSelect={(a) => setAgent(a === agent ? undefined : a)}
                />
              </div>
            )}
            {tab === 'verdicts' && <Verdicts state={state} />}
          </div>
        </div>
      </div>
      <ReplayBar colony={colony} />
      <AnimatePresence>
        {file && state.artifacts[file] && (
          <ArtifactViewer
            colonyId={id}
            name={file}
            versions={state.artifacts[file] ?? []}
            onClose={() => setFile(undefined)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col">
      <span className="section-label">{label}</span>
      <span className="text-body font-semibold text-fg">{value}</span>
    </span>
  )
}

function AgentButton(props: {
  active: boolean
  onClick(): void
  icon: React.ReactNode
  name: string
  detail: string
  status?: string
  meta?: string
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        'relative flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors',
        props.active ? 'text-fg' : 'text-fg-2 hover:bg-surface-2',
      )}
    >
      {props.active && (
        <motion.span
          layoutId="colony-agent"
          className="absolute inset-0 rounded-xl bg-accent-soft"
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        />
      )}
      <span className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-xl bg-surface-2">
        {props.icon}
      </span>
      <span className="relative min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-body font-medium">
          {props.status && <Dot status={props.status} />}
          <span className="truncate">{props.name}</span>
        </span>
        <span className="block truncate font-mono text-caption text-muted">{props.detail}</span>
      </span>
      {props.meta && <span className="relative text-caption tabular-nums text-muted">{props.meta}</span>}
    </button>
  )
}

function ActivityStream({ items, filtered }: { items: Item[]; filtered: boolean }) {
  if (items.length === 0)
    return (
      <Empty
        icon={<Activity className="size-5" />}
        title={filtered ? copy.colonyScreen.noAgentActivity : copy.colonyScreen.noActivity}
      />
    )
  return (
    <div className="h-full overflow-auto px-4 py-3">
      <ol className="mx-auto flex max-w-3xl flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id}>
            {item.kind === 'tool' ? (
              <ToolRow item={item} />
            ) : item.kind === 'say' ? (
              <SayRow item={item} />
            ) : (
              <EventRow item={item} />
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

function RowMeta({ agent, time }: { agent: string; time: string }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 text-caption tabular-nums text-muted">
      <span className="font-medium">{agent}</span>
      <time>{clock(time, true)}</time>
    </span>
  )
}

function ToolRow({ item }: { item: Item & { kind: 'tool' } }) {
  const [open, setOpen] = useState(false)
  const summary = argSummary(item.tool, item.args)
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-surface',
        item.ok === false ? 'border-bad/30' : 'border-line',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <motion.span animate={{ rotate: open ? 90 : 0 }} className="text-muted">
          <ChevronRight className="size-3.5" />
        </motion.span>
        <Wrench className={cn('size-3.5 shrink-0', item.ok === false ? 'text-bad-ink' : 'text-muted')} />
        <span className="font-mono text-callout font-semibold">{item.tool}</span>
        <span className="min-w-0 truncate font-mono text-small text-muted">{summary}</span>
        {item.ok === undefined && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-work" />}
        <RowMeta agent={item.agent} time={item.time} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div className="grid gap-2 border-t border-line bg-code px-3 py-2.5 font-mono text-small">
              <div>
                <div className="mb-1 section-label text-muted">{copy.colonyScreen.toolInput}</div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(item.args, null, 2)}
                </pre>
              </div>
              {item.output !== undefined && (
                <div>
                  <div className={cn('mb-1 section-label', item.ok ? 'text-muted' : 'text-bad-ink')}>
                    {copy.colonyScreen.toolOutput}
                  </div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-fg-2">
                    {item.output}
                  </pre>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function SayRow({ item }: { item: Item & { kind: 'say' } }) {
  const [more, setMore] = useState(false)
  const long = item.text.length > 600
  return (
    <div
      className={cn(
        'rounded-lg border px-3.5 py-2.5',
        item.error ? 'border-bad/30 bg-bad-soft' : 'border-transparent bg-surface-2/60',
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-small">
        <AgentAvatar name={item.agent} status="idle" size={18} awake />
        <span className="font-semibold">{item.agent}</span>
        <RowMeta agent="" time={item.time} />
      </div>
      {item.error && <p className="text-callout text-bad-ink">{item.error}</p>}
      {item.text && (
        <div className="text-reading">
          <Markdown text={long && !more ? `${item.text.slice(0, 600)}…` : item.text} />
          {long && (
            <button
              type="button"
              onClick={() => setMore(!more)}
              className="mt-1 text-small font-medium text-accent-fg hover:underline"
            >
              {more ? copy.colonyScreen.showLess : copy.colonyScreen.showMore}
            </button>
          )}
        </div>
      )}
      {item.thinking && (
        <details className="mt-1.5">
          <summary className="text-small text-muted">{copy.colonyScreen.thinking}</summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-small text-muted">
            {item.thinking}
          </pre>
        </details>
      )}
    </div>
  )
}

function EventRow({ item }: { item: Item & { kind: 'event' } }) {
  return (
    <div className="flex gap-2.5 rounded-lg px-3 py-1.5 transition-colors hover:bg-surface-2/60">
      <item.icon className={cn('mt-0.5 size-4 shrink-0', item.tone)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-body">
          <span className="truncate text-fg-2">{item.text}</span>
          <RowMeta agent={item.agent} time={item.time} />
        </div>
        {item.body && (
          <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-callout text-muted">{item.body}</p>
        )}
      </div>
    </div>
  )
}

function Board({ state }: { state: ColonyState }) {
  if (state.board.length === 0)
    return <Empty icon={<Megaphone className="size-5" />} title={copy.colonyScreen.noPosts} />
  return (
    <div className="h-full overflow-auto px-4 py-3">
      <ol className="mx-auto flex max-w-3xl flex-col gap-2">
        {[...state.board].reverse().map((b) => (
          <li key={b.id} className="rounded-lg border border-line bg-surface px-3.5 py-2.5">
            <div className="mb-1 flex items-center gap-2 text-small">
              <span className="font-semibold">{b.agent}</span>
              {b.mentions.length > 0 && (
                <span className="text-muted">→ {b.mentions.map((x) => `@${x}`).join(' ')}</span>
              )}
              <RowMeta agent="" time={b.time} />
            </div>
            <p className="whitespace-pre-wrap text-reading">{b.text}</p>
          </li>
        ))}
      </ol>
    </div>
  )
}

const COLUMNS: { title: string; statuses: string[]; tone: string }[] = [
  { title: copy.colonyScreen.columns.todo, statuses: ['pending', 'rejected'], tone: 'bg-muted/50' },
  { title: copy.colonyScreen.columns.inProgress, statuses: ['in_progress'], tone: 'bg-work' },
  { title: copy.colonyScreen.columns.inReview, statuses: ['submitted'], tone: 'bg-warn' },
  { title: copy.colonyScreen.columns.done, statuses: ['verified'], tone: 'bg-ok' },
]

function Kanban({ state }: { state: ColonyState }) {
  const tasks = Object.values(state.tasks)
  if (tasks.length === 0)
    return (
      <Empty icon={<ListChecks className="size-5" />} title={copy.colonyScreen.noTasks}>
        {copy.colonyScreen.noTasksHint}
      </Empty>
    )
  return (
    <div className="grid h-full grid-cols-1 gap-3 overflow-auto p-4 sm:grid-cols-2 xl:grid-cols-4">
      {COLUMNS.map((col) => {
        const list = tasks.filter((t) => col.statuses.includes(t.status))
        return (
          <div key={col.title} className="flex min-h-0 flex-col rounded-2xl bg-surface-2/60 p-2">
            <div className="flex items-center gap-2 px-1.5 pb-2 pt-1 text-callout font-semibold">
              <span className={cn('size-2 rounded-full', col.tone)} />
              {col.title}
              <span className="text-muted">{list.length}</span>
            </div>
            <div className="flex min-h-0 flex-col gap-2 overflow-auto">
              {list.map((t) => (
                <motion.div
                  layout
                  layoutId={`task-${t.id}`}
                  key={t.id}
                  className="rounded-lg border border-line bg-surface p-3 shadow-soft"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-caption text-muted">{t.id}</span>
                    {t.status === 'rejected' && <Pill tone="bad">{copy.colonyScreen.rework}</Pill>}
                    {t.owner && <span className="ml-auto text-footnote text-muted">{t.owner}</span>}
                  </div>
                  <p className="text-body font-medium">{t.subject}</p>
                  {t.description && (
                    <p className="mt-1 line-clamp-3 text-small text-muted">{t.description}</p>
                  )}
                  {t.artifacts.length > 0 && (
                    <p className="mt-1.5 truncate font-mono text-caption text-accent-fg">
                      {t.artifacts.join(', ')}
                    </p>
                  )}
                </motion.div>
              ))}
              {list.length === 0 && (
                <p className="px-2 py-3 text-small text-muted">{copy.colonyScreen.emptyColumn}</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Files({ state, onOpen }: { state: ColonyState; onOpen(name: string): void }) {
  const files = Object.entries(state.artifacts).sort(([a], [b]) => a.localeCompare(b))
  if (files.length === 0)
    return <Empty icon={<FileCode className="size-5" />} title={copy.colonyScreen.noFiles} />
  return (
    <div className="h-full overflow-auto p-3">
      <div className="mx-auto grid max-w-3xl gap-1">
        {files.map(([name, versions]) => {
          const latest = versions.at(-1)
          return (
            <button
              key={name}
              type="button"
              onClick={() => onOpen(name)}
              className="group flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
            >
              <span className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent-fg">
                <FileCode className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-reading font-medium">{name}</span>
                <span className="text-footnote text-muted">
                  {copy.colonyScreen.versions(versions.length)} · {compact(latest?.size ?? 0)}B ·{' '}
                  {latest?.author}
                </span>
              </span>
              <ChevronRight className="size-4 text-muted transition-transform group-hover:translate-x-0.5" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Verdicts({ state }: { state: ColonyState }) {
  const verdicts = reviewVerdicts(state)
  if (verdicts.length === 0)
    return <Empty icon={<Gavel className="size-5" />} title={copy.colonyScreen.noVerdicts} />
  return (
    <div className="h-full overflow-auto p-4">
      <ol className="mx-auto flex max-w-3xl flex-col gap-2">
        {[...verdicts].reverse().map((v) => (
          <li
            key={v.id}
            className={cn(
              'rounded-lg border px-3.5 py-3',
              v.pass ? 'border-ok/25 bg-ok-soft/50' : 'border-bad/25 bg-bad-soft/50',
            )}
          >
            <div className="mb-1 flex flex-wrap items-center gap-2 text-callout">
              <Pill tone={v.pass ? 'ok' : 'bad'}>
                {v.pass ? copy.colonyScreen.pass : copy.colonyScreen.fail}
              </Pill>
              <span className="font-mono">{v.verifierId}</span>
              <span className="text-muted">
                {copy.colonyScreen.verdictTarget(copy.reviewTarget(v.target))}
              </span>
              {v.score !== undefined && (
                <span className="font-semibold tabular-nums">
                  {copy.colonyScreen.score(v.score.toFixed(2))}
                </span>
              )}
              <RowMeta agent="" time={v.time} />
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-small text-fg-2">
              {v.evidence}
            </pre>
          </li>
        ))}
      </ol>
    </div>
  )
}

function ReplayBar({ colony }: { colony: ReturnType<typeof useColony> }) {
  const { cursor, head, live, events, setCursor, setLive } = colony
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(16)
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      if (cursor >= head) setPlaying(false)
      else setCursor(cursor + 1)
    }, 1000 / speed)
    return () => clearInterval(t)
  }, [playing, speed, cursor, head, setCursor])
  const current = events[cursor - 1]
  const btn =
    'grid size-8 place-items-center rounded-xl text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-30'
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-surface px-3 py-2">
      <button
        type="button"
        className={btn}
        onClick={() => setCursor(Math.max(1, cursor - 1))}
        aria-label={copy.colonyScreen.replay.stepBack}
      >
        <SkipBack className="size-4" />
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => setPlaying(!playing)}
        disabled={cursor >= head && !playing}
        aria-label={playing ? copy.colonyScreen.replay.pause : copy.colonyScreen.replay.play}
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => setCursor(Math.min(head, cursor + 1))}
        aria-label={copy.colonyScreen.replay.stepForward}
      >
        <SkipForward className="size-4" />
      </button>
      <select
        value={speed}
        onChange={(e) => setSpeed(Number(e.target.value))}
        aria-label={copy.colonyScreen.replay.speed}
        className="h-8 rounded-xl border border-line bg-surface px-1.5 text-small"
      >
        {REPLAY_SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <input
        type="range"
        min={0}
        max={Math.max(1, head)}
        value={cursor}
        onChange={(e) => setCursor(Number(e.target.value))}
        aria-label={copy.colonyScreen.replay.position}
        className="mx-1 min-w-32 flex-1 accent-[var(--accent)]"
      />
      <span className="hidden max-w-[40%] truncate font-mono text-footnote text-muted lg:inline">
        #{cursor}/{head} {current ? `· ${describeEvent(current)}` : ''}
      </span>
      <button
        type="button"
        onClick={() => setLive(!live)}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-xl border px-2.5 text-small font-semibold transition-colors',
          live ? 'border-bad/40 bg-bad-soft text-bad-ink' : 'border-line text-muted hover:text-fg',
        )}
      >
        <Radio className={cn('size-3.5', live && 'animate-pulse')} /> {copy.colonyScreen.replay.live}
      </button>
    </div>
  )
}
