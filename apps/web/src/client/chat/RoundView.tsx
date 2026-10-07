import {
  type ChatEntry,
  type ColonyMetrics,
  type ColonyState,
  type MyrEvent,
  roundSlice,
} from '@myrmidon/protocol'
import {
  ArrowUpRight,
  BadgeCheck,
  Check,
  CheckCheck,
  ChevronDown,
  CircleStop,
  Copy,
  ExternalLink,
  FileCode,
  FileText,
  LoaderCircle,
  MessageCircleQuestion,
  Network,
  Play,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import type { ModelOption } from '../api.ts'
import { compact, duration, useCopy } from '../ui/hooks.ts'
import {
  AgentAvatar,
  AgentChip,
  agentColor,
  DotMatrix,
  JUDGE_COLOR,
  LEAD_COLOR,
  type Mood,
  PixelFace,
} from '../ui/pixel.tsx'
import { Button, cn, Pill, Skeleton, softSpring, spring } from '../ui/primitives.tsx'
import type { ColonyView } from '../use-colony.ts'
import { AgentSheet } from './AgentSheet.tsx'
import { ApprovalCards, LoginCards, MemoryCards } from './ApprovalCards.tsx'
import { ArtifactViewer } from './ArtifactViewer.tsx'
import { Markdown } from './Markdown.tsx'
import { AGENT_MIN_WINDOW, ModelPicker, windowLabel } from './ModelPicker.tsx'
import { RoundChanges } from './RoundChanges.tsx'
import { StepRow } from './StepRow.tsx'
import { currentStep, deriveSteps } from './steps.ts'

export const AWAITING = 'awaiting your reply'

/** How a round was run: its tier, and for team rounds the team mode. */
export function modeLabel(state: ColonyState): string {
  if (state.tier === 'answer') return 'Direct answer'
  if (state.tier === 'solo') return 'Solo'
  if (state.team?.mode === 'swarm') return 'Swarm'
  return 'Orchestrated'
}

export function isRunning(status: string) {
  return status === 'running' || status === 'created'
}

const enter = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: softSpring }

/**
 * Shown the moment a request is sent, until the lead's round exists: the message and the lead thinking, with a
 * running clock, as a chat assistant shows it is on it.
 */
export function PendingRound({ text }: { text: string }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const t = setInterval(() => setElapsed(Date.now() - started), 100)
    return () => clearInterval(t)
  }, [])
  return (
    <section className="flex flex-col gap-4" aria-busy="true">
      <UserMessage text={text} />
      <motion.div {...enter} className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-screen">
          <PixelFace mood="thinking" color={LEAD_COLOR} cols={7} rows={7} cell={3} gap={1} />
        </span>
        <span className="text-[13px] font-medium text-fg-2">
          Thinking<span className="caret">…</span>
        </span>
        <span className="font-mono text-[11.5px] tabular-nums text-muted">
          {(elapsed / 1000).toFixed(1)}s
        </span>
      </motion.div>
    </section>
  )
}

/** One round of a conversation: the request, live run card, files, replies, and verified outcome. */
export function RoundView(props: {
  colonyId: string
  /** The colony's log and state, loaded once for all the rounds it ran. */
  colony: ColonyView
  /** Which of the colony's rounds this is (the latest without it). */
  round?: number
  onOpenColony(id: string): void
  onRetry(text: string): void
  /** Picks a stopped round back up where it left off, optionally on another model. */
  onResume(model?: string): Promise<void>
  models: ModelOption[]
  /** Only the latest finished round offers a retry, and only one at a time. */
  retry: 'ready' | 'starting' | 'hidden'
}) {
  const colony = props.colony
  const slice = useMemo(
    () => roundSlice(colony.state, colony.events, props.round),
    [colony.state, colony.events, props.round],
  )
  const { state, events, info } = slice
  // Live cards (approvals, sign-ins, memories, servers) belong to the round that is running now.
  const latest = !info || info === colony.state.rounds.at(-1)
  const [file, setFile] = useState<string>()
  const [inspect, setInspect] = useState<string>()

  if (colony.error)
    return <div className="rounded-xl bg-bad-soft px-4 py-3 text-[13.5px] text-bad-ink">{colony.error}</div>
  if (events.length === 0) {
    return (
      <section className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="ml-auto h-11 w-2/5 rounded-2xl" />
        <Skeleton className="h-20 rounded-2xl" />
      </section>
    )
  }
  // A round the lead handles alone reads as a chat: its reply and a quiet line of what it did, no run card.
  const solo = state.tier === 'solo' || state.tier === 'answer'
  const [first, ...rest] = state.chatMessages
  const opening = first?.from === 'user' ? first : undefined
  const thread = opening ? rest : state.chatMessages
  // The run card sits under the latest message sent mid-run, so what the colony did next reads in order.
  const split = thread.findLastIndex((m) => m.from === 'user') + 1
  const message = (m: ChatEntry) =>
    m.from === 'user' ? (
      <UserMessage
        key={m.id}
        text={m.text}
        attachments={m.attachments}
        onOpen={setFile}
        mode={m.mode}
        readBy={m.readBy}
        live={state.status === 'running'}
      />
    ) : (
      <AgentMessage
        key={m.id}
        from={m.from}
        text={m.text}
        final={m.final}
        plain={solo}
        {...(m.assumption ? { assumption: m.assumption } : {})}
        onInspect={() => setInspect(m.from)}
      />
    )
  // Files this round wrote; earlier rounds' files are still in the colony but belong to their own rounds.
  const from = info?.startSeq ?? 0
  const to = info?.endSeq ?? Number.POSITIVE_INFINITY
  const files = Object.entries(state.artifacts).filter(([, v]) =>
    v.some((x) => x.seq >= from && x.seq <= to && x.author !== 'previous-round' && x.author !== 'user'),
  )

  return (
    <section className="flex flex-col gap-4">
      {opening && <UserMessage text={opening.text} attachments={opening.attachments} onOpen={setFile} />}
      <AnimatePresence initial={false}>{thread.slice(0, split).map(message)}</AnimatePresence>
      {!solo && (
        <motion.div layout transition={softSpring}>
          <RunCard
            state={state}
            events={events}
            metrics={slice.metrics}
            onOpenColony={() => props.onOpenColony(props.colonyId)}
            onInspect={setInspect}
          />
        </motion.div>
      )}
      {latest && (
        <>
          <LiveServers state={state} />
          <ApprovalCards colonyId={props.colonyId} state={state} />
          <LoginCards state={state} />
          <MemoryCards state={state} />
        </>
      )}
      <AnimatePresence initial={false}>{thread.slice(split).map(message)}</AnimatePresence>
      {solo && (
        <LeadActivity
          state={state}
          events={events}
          metrics={slice.metrics}
          onOpenColony={() => props.onOpenColony(props.colonyId)}
        />
      )}
      {state.status !== 'completed' && (
        <Outcome
          state={state}
          retry={props.retry}
          onRetry={() => opening && props.onRetry(opening.text)}
          onResume={props.onResume}
          models={props.models}
        />
      )}
      {/* One result card: the verdict, the files, and the project's changes, as rows. Empty rows render nothing. */}
      <motion.div
        {...enter}
        className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface empty:hidden"
      >
        {state.status === 'completed' && (
          <Outcome
            state={state}
            retry={props.retry}
            onRetry={() => opening && props.onRetry(opening.text)}
            onResume={props.onResume}
            models={props.models}
          />
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5">
            <span className="mr-1 text-[12.5px] text-muted">Files</span>
            {files.map(([name, versions]) => {
              const latest = versions.at(-1)
              const Icon = /\.(md|txt|csv|pdf|docx?)$/i.test(name) ? FileText : FileCode
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => setFile(name)}
                  title={`v${latest?.version} · ${compact(latest?.size ?? 0)}B · ${latest?.author}`}
                  className="inline-flex min-h-8 max-w-[240px] items-center gap-1.5 rounded-lg border border-line bg-surface-2/60 px-2.5 text-[12.5px] font-medium transition-colors hover:border-line-strong hover:bg-surface-2"
                >
                  <Icon className="size-3.5 shrink-0 text-muted" />
                  <span className="truncate">{name}</span>
                  {(latest?.version ?? 1) > 1 && (
                    <span className="text-[11px] text-muted">v{latest?.version}</span>
                  )}
                </button>
              )
            })}
          </div>
        )}
        <RoundChanges
          colonyId={props.colonyId}
          {...(info ? { round: info.round } : {})}
          checkpoints={info?.checkpoints ?? state.checkpoints}
          state={state}
          running={isRunning(state.status)}
        />
      </motion.div>
      <AnimatePresence>
        {inspect && (
          <AgentSheet
            key={inspect}
            name={inspect}
            state={state}
            events={events}
            onClose={() => setInspect(undefined)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {file && state.artifacts[file] && (
          <ArtifactViewer
            colonyId={props.colonyId}
            name={file}
            versions={state.artifacts[file] ?? []}
            onClose={() => setFile(undefined)}
          />
        )}
      </AnimatePresence>
    </section>
  )
}

function UserMessage(props: {
  text: string
  /** Set for messages sent while the round was running. */
  mode?: 'steer' | 'queue' | undefined
  readBy?: readonly string[] | undefined
  live?: boolean
  attachments?: readonly string[] | undefined
  onOpen?(name: string): void
}) {
  const [copied, copy] = useCopy()
  const read = props.readBy?.length ? props.readBy : undefined
  return (
    <motion.div {...enter} className="group flex flex-col items-end gap-1">
      <div className="max-w-[min(85%,640px)] select-text whitespace-pre-wrap break-words rounded-[22px] rounded-br-md bg-bubble px-4 py-2.5 text-[14px] leading-[1.6] text-on-bubble shadow-soft">
        {props.text}
      </div>
      {props.attachments?.length ? (
        <div className="flex max-w-[min(85%,640px)] flex-wrap justify-end gap-1.5">
          {props.attachments.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => props.onOpen?.(name)}
              className="inline-flex max-w-[260px] items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-[12px] transition-colors hover:bg-surface-2"
            >
              <FileText className="size-3.5 shrink-0 text-muted" />
              <span className="truncate">{name.replace(/^uploads\//, '')}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        {props.mode && (
          <span className="flex items-center gap-1 text-[11.5px] text-muted" aria-live="polite">
            {props.mode === 'steer' ? 'Steer' : 'Queued'}
            <span aria-hidden>·</span>
            {read ? (
              <>
                <CheckCheck className="size-3.5 text-ok-ink" /> Read by {read.join(', ')}
              </>
            ) : props.live ? (
              <>
                <LoaderCircle className="size-3 animate-spin" />
                {props.mode === 'steer' ? 'joins the next step' : 'waits until the current work is done'}
              </>
            ) : (
              'not read before the round ended'
            )}
          </span>
        )}
        <button
          type="button"
          onClick={() => copy(props.text)}
          aria-label="Copy message"
          className="rounded-md p-1 text-muted opacity-0 transition-all hover:bg-surface-2 hover:text-fg group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </motion.div>
  )
}

function AgentMessage(props: {
  from: string
  text: string
  final: boolean
  /** A reply in a one-on-one chat with the lead: plain, like any chat assistant's. */
  plain?: boolean
  /** A check-in: the work continues on this assumption until the person answers. */
  assumption?: string
  onInspect(): void
}) {
  const [copied, copy] = useCopy()
  return (
    <motion.div {...enter} className="group flex gap-3">
      <button
        type="button"
        onClick={props.onInspect}
        aria-label={`What ${props.from} is doing`}
        className="h-fit rounded-[10px] transition-transform hover:scale-105"
      >
        <AgentAvatar name={props.from} status={props.final ? 'completed' : 'idle'} size={32} awake />
      </button>
      <div className="min-w-0 flex-1">
        {(!props.plain || props.assumption) && (
          <div className="mb-1 flex items-center gap-2 text-[12.5px]">
            <span className="font-semibold text-fg">{props.from}</span>
            <span className="size-1.5 rounded-full" style={{ background: agentColor(props.from) }} />
            {props.final && !props.plain && <Pill tone="ok">final answer</Pill>}
            {props.assumption && <Pill tone="accent">check-in</Pill>}
          </div>
        )}
        <div
          className={cn(
            props.plain && 'pt-1',
            props.final && !props.plain && 'rounded-2xl border border-ok/25 bg-ok-soft/40 px-4 py-3',
            props.assumption && 'rounded-2xl border border-accent/25 bg-accent-soft/40 px-4 py-3',
          )}
        >
          <Markdown text={props.text} />
          {props.assumption && (
            <p className="mt-2 border-t border-accent/20 pt-2 text-[12.5px] text-fg-2">
              <span className="font-medium text-fg">Meanwhile: </span>
              {props.assumption}{' '}
              <span className="text-muted">Reply below to change it; the work keeps going.</span>
            </p>
          )}
        </div>
        <div className="mt-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-within:opacity-100">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => copy(props.text)}
            icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
    </motion.div>
  )
}

/**
 * What the lead is doing in a one-on-one round, in one quiet line: while it works, its face, the current step and a
 * clock; once it is done, a footer with the time, tokens and steps. The steps open underneath on a click.
 */
function LeadActivity(props: {
  state: ColonyState
  events: readonly MyrEvent[]
  metrics: ColonyMetrics
  onOpenColony(): void
}) {
  const { state, events } = props
  const running = isRunning(state.status)
  const [open, setOpen] = useState(false)
  const steps = useMemo(() => deriveSteps(events), [events])
  const now = running ? currentStep(events) : undefined
  const awaiting = state.statusReason === AWAITING
  const m = props.metrics
  const visible = steps.slice(-30).reverse()
  // Steps are phrased for a team ("lead is searching…"); one-on-one, the name goes without saying.
  const doing = now?.replace(/^lead is /, '')
  const label = running
    ? `${doing ? doing[0]?.toUpperCase() + doing.slice(1) : 'Thinking'}…`
    : awaiting
      ? 'Waiting for your reply'
      : state.escalated
        ? state.escalated.to === 'team'
          ? 'Bringing in helpers'
          : 'Handing this to one agent with every tool'
        : state.status === 'completed'
          ? `Done in ${duration(m.wallMs)}`
          : state.status === 'failed'
            ? 'Failed'
            : 'Stopped'
  return (
    // Once done it tucks under the reply, in line with its text (past the 32px avatar and its gap).
    <motion.div {...enter} className={cn('flex flex-col gap-2', !running && '-mt-2 pl-11')}>
      <div className="flex items-center gap-2.5 text-[12.5px] text-muted">
        {running && (
          <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-screen">
            <PixelFace mood="working" color={LEAD_COLOR} cols={7} rows={7} cell={2} gap={1} />
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          disabled={steps.length === 0}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors enabled:hover:bg-surface-2 enabled:hover:text-fg-2"
        >
          <motion.span key={label} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="truncate">
            {running ? <span className="font-medium text-fg-2">{label}</span> : label}
          </motion.span>
          <span className="shrink-0 tabular-nums">
            {running ? ` · ${(m.wallMs / 1000).toFixed(0)}s` : ` · ${compact(m.tokens)} tokens`}
            {steps.length > 0 && ` · ${steps.length} step${steps.length === 1 ? '' : 's'}`}
          </span>
          {steps.length > 0 && (
            <motion.span animate={{ rotate: open ? 0 : -90 }} transition={spring} className="shrink-0">
              <ChevronDown className="size-3.5" />
            </motion.span>
          )}
        </button>
        {!running && (
          <button
            type="button"
            onClick={props.onOpenColony}
            title="Map, replay and transcripts of this round"
            aria-label="Open the round's details"
            className="rounded-md p-1 transition-colors hover:bg-surface-2 hover:text-fg-2"
          >
            <Network className="size-3.5" />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && steps.length > 0 && (
          <motion.ol
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={softSpring}
            className="relative ml-1 flex max-h-72 flex-col overflow-y-auto overscroll-contain border-l border-line pl-3"
          >
            {visible.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </motion.ol>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/** Dev servers the agents started that are still running, with a link to open each in your browser. */
function LiveServers({ state }: { state: ColonyState }) {
  const live = Object.values(state.servers).filter((s) => !s.stopped)
  if (live.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-ok/30 bg-ok-soft/40 px-3.5 py-2 text-[13px]">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-ok opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-ok" />
      </span>
      {live.map((s) => (
        <a
          key={s.name}
          href={s.url}
          target="_blank"
          rel="noreferrer"
          title={`${s.command} (started by ${s.agent})`}
          className="inline-flex items-center gap-1.5 rounded-lg px-1.5 py-0.5 hover:bg-surface-2"
        >
          <span className="font-medium">{s.name}</span>
          <span className="font-mono text-[12px] text-muted">{s.url.replace(/^https?:\/\//, '')}</span>
          <ExternalLink className="size-3.5 text-muted" />
        </a>
      ))}
    </div>
  )
}

/** Tokens, cost and time against the round's limits, e.g. "120k / 500k tokens · $0.84 / $2 · 12m left". */
function spend(state: ColonyState, m: ColonyMetrics, running: boolean): string {
  const { tokens: tokenLimit, costUsd, wallMs } = state.budget
  const parts = [`${compact(m.tokens)}${tokenLimit ? ` / ${compact(tokenLimit)}` : ''} tokens`]
  if (m.cost !== undefined && (m.cost > 0 || costUsd))
    parts.push(`$${m.cost < 0.1 ? m.cost.toFixed(3) : m.cost.toFixed(2)}${costUsd ? ` / $${costUsd}` : ''}`)
  if (running && wallMs > 0) parts.push(`${duration(Math.max(0, wallMs - m.wallMs))} left`)
  return parts.join(' · ')
}

function RunCard(props: {
  state: ColonyState
  events: readonly MyrEvent[]
  /** This round's figures (a colony that served several rounds keeps running totals). */
  metrics: ColonyMetrics
  onOpenColony(): void
  onInspect(name: string): void
}) {
  const { state, events } = props
  const running = isRunning(state.status)
  const [open, setOpen] = useState<boolean>()
  const expanded = open ?? running
  const [showAll, setShowAll] = useState(false)
  const steps = useMemo(() => deriveSteps(events), [events])
  const m = props.metrics
  const agents = Object.values(state.agents)
  const tasks = Object.values(state.tasks).filter((t) => t.status !== 'deleted')
  const done = tasks.filter((t) => t.status === 'verified').length
  const now = running ? currentStep(events) : undefined
  const awaiting = state.statusReason === AWAITING
  // Newest first, matching every other feed in the app.
  const visible = (showAll ? steps : steps.slice(-6)).slice().reverse()

  const head: { title: string; mood: Mood; color: string } = running
    ? { title: 'Working on it', mood: 'working', color: LEAD_COLOR }
    : state.status === 'completed'
      ? { title: `Done in ${duration(m.wallMs)}`, mood: 'happy', color: JUDGE_COLOR }
      : awaiting
        ? { title: 'Paused for your reply', mood: 'waiting', color: LEAD_COLOR }
        : state.escalated
          ? {
              title:
                state.escalated.to === 'team' ? 'Handed to a team' : 'Handed to one agent with every tool',
              mood: 'happy',
              color: LEAD_COLOR,
            }
          : {
              title: state.status === 'failed' ? 'Run failed' : 'Run stopped',
              mood: state.status === 'failed' ? 'error' : 'sleep',
              color: state.status === 'failed' ? '#ff6369' : '#8a8a94',
            }

  return (
    <motion.div
      {...enter}
      className={cn(
        'overflow-hidden rounded-2xl border bg-surface shadow-soft transition-colors duration-300',
        running ? 'border-work/35' : 'border-line',
      )}
    >
      <div className="flex items-center gap-1 p-1.5">
        <button
          type="button"
          onClick={() => setOpen(!expanded)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-screen">
            <PixelFace mood={head.mood} color={head.color} cols={7} rows={7} cell={3} gap={1} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold">{head.title}</span>
            <span className="block truncate text-[12px] tabular-nums text-muted">
              {modeLabel(state)} · {agents.length} agent{agents.length === 1 ? '' : 's'} · {steps.length}{' '}
              steps
              {tasks.length > 0 && ` · ${done}/${tasks.length} tasks`} · {spend(state, m, running)}
            </span>
          </span>
          {running && <Elapsed ms={m.wallMs} />}
          <motion.span animate={{ rotate: expanded ? 0 : -90 }} transition={spring} className="text-muted">
            <ChevronDown className="size-4" />
          </motion.span>
        </button>
        <Button
          variant="ghost"
          size="sm"
          onClick={props.onOpenColony}
          icon={<Network className="size-3.5" />}
          title="Colony map, replay, and agent transcripts"
        >
          <span className="hidden sm:inline">Colony</span>
        </Button>
      </div>
      {running && (
        <div className="relative h-0.5 overflow-hidden bg-surface-2">
          {tasks.length ? (
            <motion.span
              className="absolute inset-y-0 left-0 bg-accent"
              animate={{ width: `${Math.max(4, (done / tasks.length) * 100)}%` }}
              transition={softSpring}
            />
          ) : (
            <motion.span
              className="absolute inset-y-0 w-2/5 bg-gradient-to-r from-transparent via-accent to-transparent"
              animate={{ x: ['-100%', '260%'] }}
              transition={{ duration: 1.6, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
            />
          )}
        </div>
      )}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={softSpring}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-3 px-4 pb-4 pt-2">
              <div className="flex flex-wrap gap-1.5">
                {agents.map((a) => (
                  <AgentChip
                    key={a.info.name}
                    onClick={() => props.onInspect(a.info.name)}
                    name={a.info.name}
                    status={a.status}
                    active={a.status === 'working'}
                    detail={a.info.specialty ?? a.info.model.split('/').pop()}
                  />
                ))}
              </div>
              {steps.length > 0 && (
                // Newest first; the list scrolls inside the card so the chat never grows with it.
                <ol className="relative flex max-h-80 flex-col overflow-y-auto overscroll-contain pr-1">
                  <span className="absolute bottom-3 left-[11px] top-3 w-px bg-line" aria-hidden />
                  <AnimatePresence initial={false}>
                    {visible.map((s) => (
                      <StepRow key={s.id} step={s} />
                    ))}
                  </AnimatePresence>
                </ol>
              )}
              {steps.length > 6 && (
                <button
                  type="button"
                  onClick={() => setShowAll(!showAll)}
                  className="self-start text-[12.5px] font-medium text-accent-fg hover:underline"
                >
                  {showAll ? 'Show fewer steps' : `Show all ${steps.length} steps`}
                </button>
              )}
              {now && (
                <div className="flex items-center gap-2 text-[12.5px] text-muted">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  <motion.span key={now} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    {now}…
                  </motion.span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/**
 * A model that stopped the round: what happened in plain words, the provider's own message tucked away, and the way
 * forward. A conversation too long for the model only offers models it fits in, and no retry that cannot work.
 */
function ModelFailure(props: {
  failed: NonNullable<ColonyState['modelError']>
  models: ModelOption[]
  retry: boolean
  onResume(model?: string): Promise<void>
}) {
  const { failed, models } = props
  const [resuming, setResuming] = useState<'same' | 'other'>()
  const [nextModel, setNextModel] = useState('')
  const name = (ref: string) => models.find((m) => m.ref === ref)?.name ?? ref
  const overflow = failed.kind === 'overflow'
  // Room for the conversation as it is, plus a quarter to keep working in.
  const needed = overflow && failed.tokens ? Math.ceil(failed.tokens * 1.25) : undefined
  const fits = (m: ModelOption) => m.ref !== failed.model && (!needed || (m.contextWindow ?? 0) >= needed)
  const usable = models.filter((m) => !m.hidden)
  const suggested = needed
    ? usable.filter(fits).sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))[0]
    : usable.find(fits)
  const pick = nextModel || suggested?.ref || ''
  // Folding again only helps a model with room for the agent's own instructions and tools.
  const canRetry = !overflow || (failed.window ?? 0) >= AGENT_MIN_WINDOW
  const title = overflow
    ? `Too long for ${name(failed.model)}`
    : failed.kind === 'refusal'
      ? `${name(failed.model)} declined to continue`
      : `${name(failed.model)} couldn't answer`
  const explain = overflow
    ? failed.tokens && failed.window && failed.tokens < failed.window
      ? `${name(failed.model)} turned down about ${windowLabel(failed.tokens)} tokens, though its window is listed as ${windowLabel(failed.window)}. Its real window is probably smaller: correct it in Settings → Models, or continue on another model.`
      : failed.tokens && failed.window
        ? `This conversation is about ${windowLabel(failed.tokens)} tokens, and ${name(failed.model)} holds ${windowLabel(failed.window)}, even after older messages were summarized. Continue on a model with a bigger window.`
        : `The conversation no longer fits ${name(failed.model)}'s context window, even after older messages were summarized.`
    : failed.kind === 'refusal'
      ? "The provider's safety filter stopped this reply. Another model can pick up from here."
      : 'The provider returned an error. Another model can pick up from here, or try again.'
  const go = (which: 'same' | 'other') => {
    setResuming(which)
    void props.onResume(which === 'other' ? pick : undefined).finally(() => setResuming(undefined))
  }
  return (
    <motion.div
      {...enter}
      role="alert"
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5 shadow-soft"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-warn-soft text-warn-ink">
          <TriangleAlert className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-fg">
            {title}
            <span className="font-normal text-muted"> · {failed.agent}</span>
          </div>
          <p className="mt-0.5 text-[13px] leading-relaxed text-fg-2">{explain}</p>
          <details className="group mt-1.5">
            <summary className="cursor-default list-none text-[12px] text-muted hover:text-fg-2">
              <ChevronDown className="mr-0.5 inline size-3 -rotate-90 transition-transform group-open:rotate-0" />
              Provider message
            </summary>
            <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-fill/60 px-2.5 py-2 font-mono text-[11.5px] text-fg-2">
              {failed.message}
            </pre>
          </details>
        </div>
      </div>
      {props.retry && (
        <div className="flex flex-wrap items-center gap-2 pl-10">
          <div className="min-w-0 max-w-[260px] flex-1">
            <ModelPicker
              variant="chip"
              label="Continue with"
              value={pick}
              models={models}
              onChange={setNextModel}
              placement="up"
              {...(needed
                ? {
                    minWindow: needed,
                    minReason: `Under ${windowLabel(needed)}: this conversation won't fit`,
                  }
                : {})}
            />
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={!pick || resuming !== undefined}
            onClick={() => go('other')}
            icon={
              resuming === 'other' ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )
            }
          >
            {resuming === 'other' ? 'Continuing…' : 'Continue'}
          </Button>
          {canRetry && (
            <Button size="sm" variant="ghost" disabled={resuming !== undefined} onClick={() => go('same')}>
              {resuming === 'same' ? 'Retrying…' : overflow ? 'Summarize and retry' : 'Try again'}
            </Button>
          )}
          {!pick && needed && (
            <span className="text-[12px] text-muted">
              No model with {windowLabel(needed)} or more is set up. Add one in Settings → Models.
            </span>
          )}
        </div>
      )}
      <p className="pl-10 text-[12px] text-muted">The work so far is kept; the failed reply is not.</p>
    </motion.div>
  )
}

/** Live elapsed time on the run card, as an LED readout. */
function Elapsed({ ms }: { ms: number }) {
  const s = Math.floor(ms / 1000)
  const text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return <DotMatrix text={text} dot={2} className="mr-1 text-fg-2" />
}

function Outcome({
  state,
  retry,
  onRetry,
  onResume,
  models,
}: {
  state: ColonyState
  retry: 'ready' | 'starting' | 'hidden'
  onRetry(): void
  onResume(model?: string): Promise<void>
  models: ModelOption[]
}) {
  const [resuming, setResuming] = useState(false)
  const failed = state.status === 'stopped' ? state.modelError : undefined
  const finals = state.verdicts.filter((v) => v.target === 'colony')
  const last = finals.at(-1)
  const box = 'flex items-start gap-3 rounded-2xl border px-4 py-3 text-[13.5px]'
  if (state.status === 'completed') {
    const judge = finals.filter((v) => v.score !== undefined).at(-1)
    // A round the reviewer did not look at needs no banner; the round card already says it is done.
    if (!judge) return null
    return (
      <div className="flex items-start gap-3 bg-ok-soft px-4 py-3 text-[13.5px] text-ok-ink" role="status">
        <BadgeCheck className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            Reviewed
            {judge.score !== undefined && (
              <span className="tabular-nums"> · score {judge.score.toFixed(2)}</span>
            )}
          </div>
          <details className="mt-1 text-fg-2">
            <summary className="text-[12.5px]">Why it passed</summary>
            <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[12px]">
              {judge.evidence}
            </pre>
          </details>
        </div>
      </div>
    )
  }
  if (failed)
    return <ModelFailure failed={failed} models={models} retry={retry !== 'hidden'} onResume={onResume} />
  if (state.escalated) {
    return (
      <motion.div
        {...enter}
        className={cn(box, 'border-accent/25 bg-accent-soft text-accent-fg')}
        role="status"
      >
        <ArrowUpRight className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <div className="font-semibold">
            Moved to {state.escalated.to === 'team' ? 'a team' : 'one agent with every tool'}
          </div>
          <div className="text-[12.5px] text-fg-2">
            {state.escalated.reason} The next round picks it up with these files and notes.
          </div>
        </div>
      </motion.div>
    )
  }
  if (state.status === 'stopped' && state.statusReason === AWAITING) {
    return (
      <motion.div
        {...enter}
        className={cn(box, 'border-accent/25 bg-accent-soft text-accent-fg')}
        role="status"
      >
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
        <div>
          <div className="font-semibold">Waiting for your reply</div>
          <div className="text-[12.5px] text-fg-2">
            Answer below and the colony continues where it left off, with its files.
          </div>
        </div>
      </motion.div>
    )
  }
  if (state.status === 'stopped' || state.status === 'failed') {
    return (
      <motion.div {...enter} className={cn(box, 'border-bad/25 bg-bad-soft text-bad-ink')} role="status">
        <CircleStop className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div>
            <span className="font-semibold">{state.status === 'failed' ? 'Failed' : 'Stopped'}</span>
            <span className="text-[12.5px]"> · {state.statusReason}</span>
          </div>
          {last && !last.pass && (
            <details className="mt-1 text-fg-2">
              <summary className="text-[12.5px]">Last verification</summary>
              <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[12px]">
                {last.evidence}
              </pre>
            </details>
          )}
        </div>
        {retry !== 'hidden' && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setResuming(true)
              void onResume().finally(() => setResuming(false))
            }}
            disabled={resuming || retry === 'starting'}
            icon={
              resuming ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />
            }
          >
            {resuming ? 'Resuming…' : 'Resume'}
          </Button>
        )}
        {retry !== 'hidden' && (
          <Button
            size="sm"
            onClick={onRetry}
            disabled={retry === 'starting'}
            icon={
              retry === 'starting' ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )
            }
          >
            {retry === 'starting' ? 'Starting…' : 'Retry'}
          </Button>
        )}
      </motion.div>
    )
  }
  return last && !last.pass ? (
    <motion.div {...enter} className={cn(box, 'border-warn/25 bg-warn-soft text-warn-ink')} role="status">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="font-semibold">The reviewer asked for changes</span>
        <span className="text-[12.5px]"> · the colony is fixing them</span>
        <details className="mt-1 text-fg-2">
          <summary className="text-[12.5px]">Feedback</summary>
          <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[12px]">
            {last.evidence}
          </pre>
        </details>
      </div>
    </motion.div>
  ) : null
}
