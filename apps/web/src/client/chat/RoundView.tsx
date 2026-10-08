import {
  type ChatEntry,
  type ColonyMetrics,
  type ColonyState,
  describeEffect,
  type EventPayloads,
  type MyrEvent,
  outsideEffects,
  roundSlice,
  STOPPED_BY_USER,
} from '@myrmidon/protocol'
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleStop,
  Copy,
  ExternalLink,
  FileText,
  LoaderCircle,
  MessageCircleQuestion,
  Network,
  Phone,
  Play,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { ModelOption } from '../api.ts'
import { copy } from '../copy.ts'
import { PluginSlot, usePluginSlots } from '../plugins.tsx'
import { compact, duration, type FollowLatest, useCopy, useStickToBottom } from '../ui/hooks.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
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
import { Badge, Banner, Button, cn, Dot, IconButton, Skeleton } from '../ui/primitives.tsx'
import { AGENT_MIN_WINDOW, softSpring, spring } from '../ui-config.ts'
import type { ColonyView, LiveReply } from '../use-colony.ts'
import { AgentSheet } from './AgentSheet.tsx'
import { Approval, LoginCards, MemoryCards, SkillCards } from './ApprovalCards.tsx'
import { ArtifactViewer } from './ArtifactViewer.tsx'
import { awaitingApproval, type Pending, roundApprovals } from './approvals.ts'
import { Markdown, plainText } from './Markdown.tsx'
import { ModelPicker, windowLabel } from './ModelPicker.tsx'
import { fallbackModel } from './model-list.ts'
import { QuestionCard } from './QuestionCard.tsx'
import { RoundChanges } from './RoundChanges.tsx'
import { StepRow } from './StepRow.tsx'
import { currentStep, deriveSteps } from './steps.ts'

export const AWAITING = 'awaiting your reply'

/** How a round was run: its tier, and for team rounds the team mode. */
export function modeLabel(state: ColonyState): string {
  if (state.tier === 'answer') return copy.round.mode.answer
  if (state.tier === 'solo') return copy.round.mode.solo
  if (state.team?.mode === 'swarm') return copy.round.mode.swarm
  return copy.round.mode.orchestrated
}

export function isRunning(status: string) {
  return status === 'running' || status === 'created'
}

/** A round that stopped or failed on its own account: not paused for the person, a failed model, or a hand-over. */
function halted(state: ColonyState) {
  if (state.escalated) return false
  if (state.status === 'failed') return true
  return state.status === 'stopped' && !state.modelError && state.statusReason !== AWAITING
}

/** One thing in a round's conversation, placed by where it happened in the log. */
type Item =
  | { seq: number; message: ChatEntry }
  | { seq: number; approval: Pending }
  | { seq: number; stream: string; live: LiveReply }

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
        <span className="grid size-9 shrink-0 place-items-center rounded-base bg-screen">
          <PixelFace mood="thinking" color={LEAD_COLOR} cols={7} rows={7} cell={3} gap={1} />
        </span>
        <span className="text-body font-medium text-fg-2">
          {copy.round.pending.thinking}
          <span className="caret">…</span>
        </span>
        <span className="font-mono text-footnote tabular-nums text-muted">
          {copy.round.pending.seconds((elapsed / 1000).toFixed(1))}
        </span>
      </motion.div>
    </section>
  )
}

/**
 * Back to the newest content once the reader has scrolled up in a following view, as chat apps offer. It goes last
 * inside the scrolling element and takes no room there.
 */
export function JumpToLatest({ follow }: { follow: Omit<FollowLatest<HTMLElement>, 'ref'> }) {
  return (
    <div className="pointer-events-none sticky bottom-0 h-0">
      <AnimatePresence>
        {follow.away && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={spring}
            className="absolute inset-x-0 bottom-4 flex justify-center"
          >
            <button
              type="button"
              onClick={follow.jump}
              className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3.5 text-callout font-medium text-fg-2 shadow-pop transition-colors hover:bg-fill hover:text-fg"
            >
              {follow.fresh ? copy.round.jump.fresh : copy.round.jump.latest}
              <ArrowDown className="size-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
  /** Asks for a skill to be learned from this chat's work. */
  onLearn(): void
  /** Sends the person's answer to the questions the round is waiting on; rejects if it did not get through. */
  onAnswer(text: string): Promise<unknown>
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

  if (colony.error) return <Banner tone="bad">{colony.error}</Banner>
  if (events.length === 0) {
    return (
      <section className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="ml-auto h-11 w-2/5 rounded-2xl" />
        <Skeleton className="h-20 rounded-2xl" />
      </section>
    )
  }
  // A round the lead runs reads as a chat: its reply and a quiet line of what it did, no run card. That holds when it
  // brings helpers in too (agents it adds, or the team an escalation hands to); a team the person asked for, or a
  // swarm, keeps the run card.
  const index = info ? colony.state.rounds.indexOf(info) : -1
  const handedOver = index > 0 && colony.state.rounds[index - 1]?.escalated?.to === 'team'
  // A round the person opened by writing to a crew member directly is a conversation with them.
  const addressed = !!state.chat?.addressed?.length
  const solo = !info?.swarm && (state.tier === 'solo' || state.tier === 'answer' || handedOver || addressed)
  // Who speaks for the round: replies from anyone else (a crew member answering the person) carry their name.
  const speaker =
    Object.values(state.agents).find((a) => a.info.role === 'lead')?.info.name ?? Object.keys(state.agents)[0]
  const [first, ...rest] = state.chatMessages
  const opening = first?.from === 'user' ? first : undefined
  const thread = opening ? rest : state.chatMessages
  const streaming =
    latest && isRunning(state.status)
      ? Object.entries(colony.streams).filter(
          // The whole colony's messages: a reply that began in the last round landed there, not in this one.
          ([agent, live]) =>
            live.text && !colony.state.chatMessages.some((m) => m.from === agent && m.seq > live.since),
        )
      : []
  const timeline: Item[] = [
    ...thread.map((m) => ({ seq: m.seq, message: m })),
    // Only the round running now can still be waiting on the person.
    ...roundApprovals(state, events).filter((r) => r.approval.decided || latest),
    // A reply still being written sits where it began, after what was in the log by then.
    ...streaming.map(([agent, live]) => ({ seq: live.since + 0.5, stream: agent, live })),
  ].sort((a, b) => a.seq - b.seq)
  // The run card sits under the latest message sent mid-run, so what the colony did next reads in order.
  const split = timeline.findLastIndex((i) => 'message' in i && i.message.from === 'user') + 1
  const lastReply = state.chatMessages.findLast((m) => m.from !== 'user')
  const announce = streaming[0]
    ? copy.round.agent.replying(streaming[0][0])
    : lastReply
      ? copy.round.agent.said(lastReply.from, plainText(lastReply.text))
      : ''
  const message = (m: ChatEntry) =>
    m.from === 'user' ? (
      <UserMessage
        key={m.id}
        text={m.text}
        to={m.to}
        attachments={m.attachments}
        onOpen={setFile}
        mode={m.mode}
        readBy={m.readBy}
        live={state.status === 'running'}
        voice={m.voice}
      />
    ) : (
      <div key={m.id} className="flex flex-col">
        <AgentMessage
          from={m.from}
          text={m.text}
          final={m.final}
          plain={solo && m.from === speaker}
          {...(m.assumption ? { assumption: m.assumption } : {})}
          onInspect={() => setInspect(m.from)}
        />
        {(m.choices || m.plan) && (
          <div className="pl-11">
            <QuestionCard
              choices={m.choices ?? []}
              {...(m.plan ? { plan: m.plan } : {})}
              open={latest && state.statusReason === AWAITING && m === state.chatMessages.at(-1)}
              onAnswer={props.onAnswer}
            />
          </div>
        )}
      </div>
    )
  const item = (i: Item) =>
    'message' in i ? (
      message(i.message)
    ) : 'approval' in i ? (
      <Approval key={i.approval.id} colonyId={props.colonyId} request={i.approval} />
    ) : (
      <StreamingReply
        key={`stream:${i.stream}`}
        from={i.stream}
        text={i.live.text}
        plain={solo && i.stream === speaker}
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
      {opening && (
        <UserMessage
          text={opening.text}
          to={opening.to}
          attachments={opening.attachments}
          onOpen={setFile}
          voice={opening.voice}
        />
      )}
      <AnimatePresence initial={false}>{timeline.slice(0, split).map(item)}</AnimatePresence>
      {solo && <Thoughts events={events} running={isRunning(state.status)} />}
      {!solo && (
        <motion.div layout transition={softSpring}>
          <RunCard
            state={state}
            events={events}
            metrics={slice.metrics}
            onOpenColony={() => props.onOpenColony(props.colonyId)}
            onInspect={setInspect}
            {...(latest ? { onLearn: props.onLearn } : {})}
            {...(halted(state)
              ? {
                  footer: (
                    <Halted
                      inCard
                      state={state}
                      events={events}
                      retry={props.retry}
                      onRetry={() => opening && props.onRetry(opening.text)}
                      onResume={props.onResume}
                    />
                  ),
                }
              : {})}
          />
        </motion.div>
      )}
      {latest && (
        <>
          <LiveServers state={state} />
          <LoginCards state={state} />
          <MemoryCards state={state} />
          <SkillCards state={state} />
        </>
      )}
      <AnimatePresence initial={false}>{timeline.slice(split).map(item)}</AnimatePresence>
      {/* Screen readers hear that a reply is coming, then the reply once, not every chunk as it streams. */}
      {latest && (
        <p className="sr-only" aria-live="polite">
          {announce}
        </p>
      )}
      {/* A plugin's send returns nothing; a failed send has already shown its error. */}
      <PluginCards events={events} state={state} onAnswer={(t) => void props.onAnswer(t).catch(() => {})} />
      {solo && !addressed && (
        <Helpers
          state={state}
          events={events}
          onInspect={setInspect}
          onOpenColony={() => props.onOpenColony(props.colonyId)}
        />
      )}
      {solo && (
        <LeadActivity
          state={state}
          events={events}
          metrics={slice.metrics}
          onOpenColony={() => props.onOpenColony(props.colonyId)}
          {...(latest ? { onLearn: props.onLearn } : {})}
        />
      )}
      {/* A team round that stopped says so on its run card, so the banner would only repeat it. */}
      {state.status !== 'completed' && (solo || !halted(state)) && (
        <Outcome
          latest={latest}
          state={state}
          events={events}
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
            latest={latest}
            state={state}
            events={events}
            retry={props.retry}
            onRetry={() => opening && props.onRetry(opening.text)}
            onResume={props.onResume}
            models={props.models}
          />
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5">
            <span className="mr-1 text-callout text-muted">{copy.round.files}</span>
            {files.map(([name, versions]) => {
              const latest = versions.at(-1)
              const Icon = /\.(md|txt|csv|pdf|docx?)$/i.test(name) ? FileText : FEATURE_ICONS.files
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => setFile(name)}
                  title={copy.round.fileTitle(latest?.version, compact(latest?.size ?? 0), latest?.author)}
                  className="inline-flex min-h-8 max-w-[240px] items-center gap-1.5 rounded-xl border border-line bg-fill/60 px-2.5 text-callout font-medium transition-colors hover:border-line-strong hover:bg-fill"
                >
                  <Icon className="size-3.5 shrink-0 text-muted" />
                  <span className="truncate">{name}</span>
                  {(latest?.version ?? 1) > 1 && (
                    <span className="text-caption text-muted">{copy.round.fileVersion(latest?.version)}</span>
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
          // The folder's latest rewind, which for an earlier round came after the round ended.
          state={colony.state}
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
            models={props.models}
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
  /** Crew members the person wrote to directly (@name). */
  to?: readonly string[] | undefined
  /** Said aloud on a voice call. */
  voice?: boolean | undefined
  onOpen?(name: string): void
}) {
  const [copied, copyText] = useCopy()
  const read = props.readBy?.length ? props.readBy : undefined
  return (
    <motion.div {...enter} className="group flex flex-col items-end gap-1">
      <div className="max-w-[min(85%,640px)] select-text whitespace-pre-wrap break-words rounded-3xl rounded-br-md bg-bubble px-4 py-2.5 text-title leading-[1.6] text-on-bubble shadow-soft">
        {props.text}
      </div>
      {props.attachments?.length ? (
        <div className="flex max-w-[min(85%,640px)] flex-wrap justify-end gap-1.5">
          {props.attachments.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => props.onOpen?.(name)}
              className="inline-flex max-w-[260px] items-center gap-1.5 rounded-xl border border-line bg-surface px-2 py-1 text-small transition-colors hover:bg-fill"
            >
              <FileText className="size-3.5 shrink-0 text-muted" />
              <span className="truncate">{name.replace(/^uploads\//, '')}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        {props.voice && (
          <span className="flex items-center gap-1 text-footnote text-muted">
            <Phone className="size-3" />
            {copy.round.message.saidOnCall}
          </span>
        )}
        {props.to?.length ? (
          <span className="flex items-center gap-1 text-footnote text-muted">
            {copy.round.message.to}
            {props.to.map((name) => (
              <span key={name} className="inline-flex items-center gap-1 font-medium text-fg-2">
                <span className="size-1.5 rounded-full" style={{ background: agentColor(name) }} />
                {name}
              </span>
            ))}
          </span>
        ) : null}
        {props.mode && (
          <span className="flex items-center gap-1 text-footnote text-muted" aria-live="polite">
            {props.mode === 'steer' ? copy.round.message.steer : copy.round.message.queued}
            <span aria-hidden>·</span>
            {read ? (
              <>
                <CheckCheck className="size-3.5 text-ok-ink" /> {copy.round.message.readBy(read.join(', '))}
              </>
            ) : props.live ? (
              <>
                <LoaderCircle className="size-3 animate-spin" />
                {props.mode === 'steer' ? copy.round.message.steerLive : copy.round.message.queueLive}
              </>
            ) : (
              copy.round.message.notRead
            )}
          </span>
        )}
        <button
          type="button"
          onClick={() => copyText(props.text)}
          aria-label={copy.round.message.copyMessage}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted opacity-0 transition-all hover:bg-fill hover:text-fg group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-visible:opacity-100"
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
  const [copied, copyText] = useCopy()
  return (
    <motion.div {...enter} className="group flex gap-3">
      <button
        type="button"
        onClick={props.onInspect}
        aria-label={copy.round.agent.inspect(props.from)}
        className="h-fit rounded-base transition-transform hover:scale-105"
      >
        <AgentAvatar name={props.from} status={props.final ? 'completed' : 'idle'} size={32} awake />
      </button>
      <div className="min-w-0 flex-1">
        {(!props.plain || props.assumption) && (
          <div className="mb-1 flex items-center gap-2 text-callout">
            <span className="font-semibold text-fg">{props.from}</span>
            <span className="size-1.5 rounded-full" style={{ background: agentColor(props.from) }} />
            {props.final && !props.plain && <Badge tone="ok">{copy.round.agent.finalAnswer}</Badge>}
            {props.assumption && <Badge tone="accent">{copy.round.agent.checkIn}</Badge>}
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
            <p className="mt-2 border-t border-accent/20 pt-2 text-callout text-fg-2">
              <span className="font-medium text-fg">{copy.round.agent.meanwhile}</span>
              {props.assumption} <span className="text-muted">{copy.round.agent.meanwhileHint}</span>
            </p>
          )}
        </div>
        <div className="mt-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-within:opacity-100">
          <Button
            variant="borderless"
            size="sm"
            onClick={() => copyText(props.text)}
            icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          >
            {copied ? copy.round.agent.copied : copy.round.agent.copy}
          </Button>
        </div>
      </div>
    </motion.div>
  )
}

/**
 * The helpers the lead brought into a round, as one quiet line ("Brought in nova (researcher) and kai (coder)") that
 * opens to who they are. A helper counts once it joins or takes a turn; their work stays in the workspace.
 */
function Helpers(props: {
  state: ColonyState
  events: readonly MyrEvent[]
  onInspect(name: string): void
  onOpenColony(): void
}) {
  const [open, setOpen] = useState(false)
  const helpers = useMemo(() => {
    const names = new Set<string>()
    for (const e of props.events) {
      if (e.type === 'agent/joined') names.add((e.payload as EventPayloads['agent/joined']).agent.name)
      if (e.type === 'agent/turn') names.add((e.payload as EventPayloads['agent/turn']).agent)
    }
    return [...names].flatMap((n) => {
      const a = props.state.agents[n]
      return a && a.info.role !== 'lead' ? [a] : []
    })
  }, [props.events, props.state.agents])
  if (helpers.length === 0) return null
  return (
    <motion.div {...enter} className="flex flex-col gap-2 pl-11">
      <div className="flex items-center gap-1 text-callout text-muted">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-fill hover:text-fg-2"
        >
          <FEATURE_ICONS.helpers className="size-3.5 shrink-0" />
          <span className="truncate">
            {copy.round.helpers.broughtIn(
              helpers.map((a) => copy.round.helpers.helper(a.info.name, a.info.specialty)),
            )}
          </span>
          <motion.span animate={{ rotate: open ? 0 : -90 }} transition={spring} className="shrink-0">
            <ChevronDown className="size-3.5" />
          </motion.span>
        </button>
        <button
          type="button"
          onClick={props.onOpenColony}
          title={copy.round.helpers.crew}
          aria-label={copy.round.helpers.crew}
          className="grid size-6 shrink-0 place-items-center rounded-md transition-colors hover:bg-fill hover:text-fg-2"
        >
          <Network className="size-3.5" />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={softSpring}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap gap-1.5 pb-1">
              {helpers.map((a) => (
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
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/** A reply as the model writes it; the finished one replaces it once it is in the log. */
function StreamingReply(props: { from: string; text: string; plain: boolean }) {
  return (
    <div className="flex gap-3" aria-busy="true">
      <AgentAvatar name={props.from} status="running" size={32} awake />
      <div className="min-w-0 flex-1">
        {!props.plain && (
          <div className="mb-1 flex items-center gap-2 text-callout">
            <span className="font-semibold text-fg">{props.from}</span>
            <span className="size-1.5 rounded-full" style={{ background: agentColor(props.from) }} />
          </div>
        )}
        <div className={cn(props.plain && 'pt-1')}>
          <Markdown text={props.text} />
          <span className="caret text-muted">▍</span>
        </div>
      </div>
    </div>
  )
}

/**
 * The lead's thinking in a one-on-one round, as chat apps show it: "Thought for 8s" above the reply, opening to what it
 * thought. Each thought's time runs from the event before it to the reply that carried it.
 */
function Thoughts(props: { events: readonly MyrEvent[]; running: boolean }) {
  const [open, setOpen] = useState(false)
  const list = useStickToBottom<HTMLDivElement>(open)
  const thoughts = useMemo(() => {
    const out: { id: string; text: string; ms: number }[] = []
    props.events.forEach((e, i) => {
      if (e.type !== 'llm/response') return
      const text = (e.payload as EventPayloads['llm/response']).thinking?.trim()
      if (!text) return
      const before = props.events[i - 1]
      out.push({ id: e.id, text, ms: before ? Math.max(0, Date.parse(e.time) - Date.parse(before.time)) : 0 })
    })
    return out
  }, [props.events])
  if (thoughts.length === 0) return null
  const total = thoughts.reduce((sum, t) => sum + t.ms, 0)
  return (
    <motion.div {...enter} className="flex flex-col gap-1.5 pl-11">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 text-callout text-muted transition-colors hover:bg-fill hover:text-fg-2"
      >
        <FEATURE_ICONS.thinking className="size-3.5" />
        <span className="tabular-nums">
          {props.running
            ? copy.round.thoughts.thinkingFor(duration(Math.max(1000, total)))
            : copy.round.thoughts.thoughtFor(duration(Math.max(1000, total)))}
          {thoughts.length > 1 && ` · ${copy.round.thoughts.times(thoughts.length)}`}
        </span>
        <motion.span animate={{ rotate: open ? 0 : -90 }} transition={spring}>
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={softSpring}
            className="overflow-hidden"
          >
            <div
              ref={list}
              className="flex max-h-96 flex-col gap-3 overflow-y-auto overscroll-contain border-l-2 border-line pl-3 text-body text-fg-2"
            >
              {thoughts.map((t) => (
                <div key={t.id} className="select-text">
                  <Markdown text={t.text} />
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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
  /** On the chat's latest round: learn a skill from how it was done. */
  onLearn?(): void
}) {
  const { state, events } = props
  const running = isRunning(state.status)
  const [open, setOpen] = useState(false)
  const steps = useMemo(() => deriveSteps(events), [events])
  const now = running ? currentStep(events) : undefined
  const awaiting = state.statusReason === AWAITING
  // The last step is the call that asked; the lead does nothing more until the person answers it.
  const approving = running && awaitingApproval(state, events)
  const m = props.metrics
  const visible = steps.slice(-30).reverse()
  // The clock ticks on its own while the lead works; the log only moves when something happens.
  const [clock, setClock] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  const started = events[0] ? Date.parse(events[0].time) : clock
  const elapsed = running ? Math.max(0, clock - started) : m.wallMs
  // Steps are phrased for a team ("lead is searching…"); one-on-one, the name goes without saying.
  const doing = now?.replace(/^lead is /, '')
  const label = approving
    ? copy.round.lead.approval
    : running
      ? `${doing ? doing[0]?.toUpperCase() + doing.slice(1) : copy.round.lead.thinking}…`
      : awaiting
        ? copy.round.lead.waiting
        : state.escalated
          ? state.escalated.to === 'team'
            ? copy.round.lead.toTeam
            : copy.round.lead.toAgent
          : state.status === 'completed'
            ? copy.round.lead.doneIn(duration(m.wallMs))
            : state.status === 'failed'
              ? copy.round.lead.failed
              : copy.round.lead.stopped
  return (
    // Once done it tucks under the reply, in line with its text (past the 32px avatar and its gap).
    <motion.div {...enter} className={cn('flex flex-col gap-2', !running && '-mt-2 pl-11')}>
      <div className="flex items-center gap-2.5 text-callout text-muted">
        {running && (
          <span className="grid size-7 shrink-0 place-items-center rounded-base bg-screen">
            <PixelFace
              mood={approving ? 'waiting' : 'working'}
              color={LEAD_COLOR}
              cols={7}
              rows={7}
              cell={2}
              gap={1}
            />
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          disabled={steps.length === 0}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors enabled:hover:bg-fill enabled:hover:text-fg-2"
        >
          <motion.span key={label} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="truncate">
            {running ? <span className="font-medium text-fg-2">{label}</span> : label}
          </motion.span>
          <span className="shrink-0 tabular-nums">
            {running ? ` · ${duration(elapsed)}` : ` · ${copy.round.lead.tokens(compact(m.tokens))}`}
            {steps.length > 0 && ` · ${copy.round.lead.steps(steps.length)}`}
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
            title={copy.round.lead.detailsTitle}
            aria-label={copy.round.lead.detailsLabel}
            className="grid size-6 shrink-0 place-items-center rounded-md transition-colors hover:bg-fill hover:text-fg-2"
          >
            <Network className="size-3.5" />
          </button>
        )}
        {!running && props.onLearn && state.status === 'completed' && (
          <button
            type="button"
            onClick={props.onLearn}
            title={copy.round.lead.learnTitle}
            aria-label={copy.round.lead.learnTitle}
            className="grid size-6 shrink-0 place-items-center rounded-md transition-colors hover:bg-fill hover:text-fg-2"
          >
            <FEATURE_ICONS.skills className="size-3.5" />
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

/** Plugins' cards for the events they put in this round's log (ctx.events.emit), in the order they came. */
function PluginCards(props: {
  events: readonly MyrEvent[]
  state: ColonyState
  onAnswer(text: string): void
}) {
  const cards = usePluginSlots('chat.card')
  if (cards.length === 0) return null
  const byPlugin = new Map(cards.map((c) => [c.plugin, c.def]))
  return (
    <>
      {props.events.flatMap((e) => {
        if (e.type !== 'plugin/event') return []
        const p = e.payload as EventPayloads['plugin/event']
        const def = byPlugin.get(p.plugin)
        if (!def) return []
        return [
          <motion.div key={e.id} {...enter} className="pl-11">
            <PluginSlot
              plugin={p.plugin}
              def={def}
              props={{ event: { type: p.type, data: p.data }, state: props.state, send: props.onAnswer }}
            />
          </motion.div>,
        ]
      })}
    </>
  )
}

/** Dev servers the agents started that are still running, with a link to open each in your browser. */
function LiveServers({ state }: { state: ColonyState }) {
  const live = Object.values(state.servers).filter((s) => !s.stopped)
  if (live.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-ok/30 bg-ok-soft/40 px-3.5 py-2 text-body">
      <Dot tone="ok" pulse />
      {live.map((s) => (
        <a
          key={s.name}
          href={s.url}
          target="_blank"
          rel="noreferrer"
          title={copy.round.serverTitle(s.command, s.agent)}
          className="inline-flex items-center gap-1.5 rounded-xl px-1.5 py-0.5 hover:bg-fill"
        >
          <span className="font-medium">{s.name}</span>
          <span className="font-mono text-small text-muted">{s.url.replace(/^https?:\/\//, '')}</span>
          <ExternalLink className="size-3.5 text-muted" />
        </a>
      ))}
    </div>
  )
}

/** Tokens, cost and time against the round's limits, e.g. "120k / 500k tokens · $0.84 / $2 · 12m left". */
function spend(state: ColonyState, m: ColonyMetrics, running: boolean): string {
  const { tokens: tokenLimit, costUsd, wallMs } = state.budget
  const parts = [
    copy.round.spend.tokens(`${compact(m.tokens)}${tokenLimit ? ` / ${compact(tokenLimit)}` : ''}`),
  ]
  if (m.cost !== undefined && (m.cost > 0 || costUsd))
    parts.push(`$${m.cost < 0.1 ? m.cost.toFixed(3) : m.cost.toFixed(2)}${costUsd ? ` / $${costUsd}` : ''}`)
  if (running && wallMs > 0) parts.push(copy.round.spend.left(duration(Math.max(0, wallMs - m.wallMs))))
  return parts.join(' · ')
}

function RunCard(props: {
  state: ColonyState
  events: readonly MyrEvent[]
  /** This round's figures (a colony that served several rounds keeps running totals). */
  metrics: ColonyMetrics
  onOpenColony(): void
  onInspect(name: string): void
  /** On the chat's latest round: learn a skill from how it was done. */
  onLearn?(): void
  /** Under the header, always shown: why the round stopped and the way on. */
  footer?: ReactNode
}) {
  const { state, events } = props
  const running = isRunning(state.status)
  const approving = running && awaitingApproval(state, events)
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
    ? { title: copy.round.run.working, mood: 'working', color: LEAD_COLOR }
    : state.status === 'completed'
      ? { title: copy.round.run.doneIn(duration(m.wallMs)), mood: 'happy', color: JUDGE_COLOR }
      : awaiting
        ? { title: copy.round.run.paused, mood: 'waiting', color: LEAD_COLOR }
        : state.escalated
          ? {
              title: state.escalated.to === 'team' ? copy.round.run.toTeam : copy.round.run.toAgent,
              mood: 'happy',
              color: LEAD_COLOR,
            }
          : {
              title: state.status === 'failed' ? copy.round.run.failed : copy.round.run.stopped,
              mood: state.status === 'failed' ? 'error' : 'sleep',
              color: state.status === 'failed' ? 'var(--mood-failed)' : 'var(--mood-stopped)',
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
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-fill"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-screen">
            <PixelFace mood={head.mood} color={head.color} cols={7} rows={7} cell={3} gap={1} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-reading font-semibold">{head.title}</span>
            <span className="block truncate text-small tabular-nums text-muted">
              {modeLabel(state)} · {copy.round.run.agents(agents.length)} ·{' '}
              {copy.round.run.steps(steps.length)}
              {tasks.length > 0 && ` · ${copy.round.run.tasks(done, tasks.length)}`} ·{' '}
              {spend(state, m, running)}
            </span>
          </span>
          {running && <Elapsed ms={m.wallMs} />}
          <motion.span animate={{ rotate: expanded ? 0 : -90 }} transition={spring} className="text-muted">
            <ChevronDown className="size-4" />
          </motion.span>
        </button>
        <Button
          variant="borderless"
          size="sm"
          onClick={props.onOpenColony}
          icon={<Network className="size-3.5" />}
          title={copy.round.run.crewTitle}
        >
          <span className="hidden sm:inline">{copy.round.run.crew}</span>
        </Button>
        {!running && props.onLearn && state.status === 'completed' && (
          <IconButton size="sm" label={copy.round.lead.learnTitle} onClick={props.onLearn}>
            <FEATURE_ICONS.skills className="size-3.5" />
          </IconButton>
        )}
      </div>
      {running && (
        <div className="relative h-0.5 overflow-hidden bg-fill">
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
                  className="self-start text-callout font-medium text-accent-fg hover:underline"
                >
                  {showAll ? copy.round.run.showFewer : copy.round.run.showAll(steps.length)}
                </button>
              )}
              {approving ? (
                <div className="flex items-center gap-2 text-callout text-muted">
                  <FEATURE_ICONS.approvalAsk className="size-3.5" />
                  <span>{copy.round.lead.approval}</span>
                </div>
              ) : (
                now && (
                  <div className="flex items-center gap-2 text-callout text-muted">
                    <LoaderCircle className="size-3.5 animate-spin" />
                    <motion.span key={now} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                      {now}…
                    </motion.span>
                  </div>
                )
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {props.footer}
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
  /** The models the chat's crew runs on. */
  used: readonly string[]
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
    : fallbackModel(failed.model, usable, fits, props.used)
  const pick = nextModel || suggested?.ref || ''
  // Folding again only helps a model with room for the agent's own instructions and tools.
  const canRetry = !overflow || (failed.window ?? 0) >= AGENT_MIN_WINDOW
  const title = overflow
    ? copy.modelFailure.tooLong(name(failed.model))
    : failed.kind === 'refusal'
      ? copy.modelFailure.declined(name(failed.model))
      : copy.modelFailure.couldntAnswer(name(failed.model))
  const explain = overflow
    ? failed.tokens && failed.window && failed.tokens < failed.window
      ? copy.modelFailure.windowTooSmall(
          name(failed.model),
          windowLabel(failed.tokens),
          windowLabel(failed.window),
        )
      : failed.tokens && failed.window
        ? copy.modelFailure.conversationTooLong(
            windowLabel(failed.tokens),
            name(failed.model),
            windowLabel(failed.window),
          )
        : copy.modelFailure.noLongerFits(name(failed.model))
    : failed.kind === 'refusal'
      ? copy.modelFailure.refusal
      : copy.modelFailure.error
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
          <div className="text-title font-semibold text-fg">
            {title}
            <span className="font-normal text-muted"> · {failed.agent}</span>
          </div>
          <p className="mt-0.5 text-body leading-relaxed text-fg-2">{explain}</p>
          <details className="group mt-1.5">
            <summary className="cursor-default list-none text-small text-muted hover:text-fg-2">
              <ChevronDown className="mr-0.5 inline size-3 -rotate-90 transition-transform group-open:rotate-0" />
              {copy.modelFailure.providerMessage}
            </summary>
            <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-fill/60 px-2.5 py-2 font-mono text-footnote text-fg-2">
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
              label={copy.modelFailure.continueWith}
              value={pick}
              models={models}
              onChange={setNextModel}
              placement="up"
              {...(needed
                ? {
                    minWindow: needed,
                    minReason: copy.modelFailure.wontFit(windowLabel(needed)),
                  }
                : {})}
            />
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={!pick || resuming !== undefined}
            onClick={() => go('other')}
            loading={resuming === 'other'}
            icon={<Play className="size-3.5" />}
          >
            {resuming === 'other' ? copy.modelFailure.continuing : copy.modelFailure.continue}
          </Button>
          {canRetry && (
            <Button
              size="sm"
              variant="borderless"
              disabled={resuming !== undefined}
              onClick={() => go('same')}
            >
              {resuming === 'same'
                ? copy.modelFailure.retrying
                : overflow
                  ? copy.modelFailure.summarizeAndRetry
                  : copy.modelFailure.tryAgain}
            </Button>
          )}
          {!pick && needed && (
            <span className="text-small text-muted">{copy.modelFailure.noModel(windowLabel(needed))}</span>
          )}
        </div>
      )}
      <p className="pl-10 text-small text-muted">{copy.modelFailure.kept}</p>
    </motion.div>
  )
}

/**
 * What a stopped round already did outside Myrmidon (commands, MCP calls, actions on web pages), which a rewind
 * cannot undo; resuming tells the agents the same, so they check before repeating any.
 */
function AlreadyDone(props: { events: readonly MyrEvent[] }) {
  const effects = useMemo(() => outsideEffects(props.events), [props.events])
  if (effects.length === 0) return null
  return (
    <details className="mt-1.5 text-fg-2">
      <summary className="text-callout">{copy.outcome.effects(effects.length)}</summary>
      <ul className="mt-1.5 flex max-h-48 flex-col gap-0.5 overflow-auto font-mono text-small">
        {effects.map((e) => (
          <li key={e.id} className="truncate" title={describeEffect(e)}>
            <span className="text-muted">{e.agent}:</span> {describeEffect(e)}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-small text-muted">{copy.outcome.effectsHint}</p>
    </details>
  )
}

/** Live elapsed time on the run card, as an LED readout. */
function Elapsed({ ms }: { ms: number }) {
  const s = Math.floor(ms / 1000)
  const text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return <DotMatrix text={text} dot={2} className="mr-1 text-fg-2" />
}

/**
 * Why a round stopped or failed, what it already did outside, and Resume / Retry: a banner of its own, or the run
 * card's footer (`inCard`), whose header already says it stopped.
 */
function Halted(props: {
  state: ColonyState
  events: readonly MyrEvent[]
  retry: 'ready' | 'starting' | 'hidden'
  onRetry(): void
  onResume(model?: string): Promise<void>
  inCard?: boolean
}) {
  const { state, retry } = props
  const [resuming, setResuming] = useState(false)
  const last = state.verdicts.filter((v) => v.target === 'colony').at(-1)
  const byYou = state.statusReason === STOPPED_BY_USER
  // Red is for a real failure; a stop the person made is neutral, and one a limit or a stall made is a warning.
  const tone =
    state.status === 'failed' || state.modelError
      ? { text: 'text-bad-ink', box: 'border-bad/25 bg-bad-soft' }
      : byYou
        ? { text: 'text-muted', box: 'border-line bg-surface' }
        : { text: 'text-warn-ink', box: 'border-warn/25 bg-warn-soft' }
  return (
    <motion.div
      {...enter}
      className={cn(
        'flex items-start gap-3 px-4 py-3 text-reading',
        tone.text,
        props.inCard ? 'border-t border-line' : cn('rounded-2xl border', tone.box),
      )}
      role="status"
    >
      <CircleStop className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div>
          {!props.inCard && (
            <span className="font-semibold">
              {state.status === 'failed' ? copy.outcome.failed : copy.outcome.stopped}
              {state.statusReason && ' · '}
            </span>
          )}
          <span className="text-callout">{byYou ? copy.outcome.stoppedByYou : state.statusReason}</span>
        </div>
        <AlreadyDone events={props.events} />
        {last && !last.pass && (
          <details className="mt-1 text-fg-2">
            <summary className="text-callout">{copy.outcome.lastVerification}</summary>
            <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-small">
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
            void props.onResume().finally(() => setResuming(false))
          }}
          disabled={retry === 'starting'}
          loading={resuming}
          icon={<Play className="size-3.5" />}
        >
          {resuming ? copy.outcome.resuming : copy.outcome.resume}
        </Button>
      )}
      {retry !== 'hidden' && (
        <Button
          size="sm"
          onClick={props.onRetry}
          loading={retry === 'starting'}
          icon={<RotateCcw className="size-3.5" />}
        >
          {retry === 'starting' ? copy.outcome.starting : copy.outcome.retry}
        </Button>
      )}
    </motion.div>
  )
}

function Outcome({
  latest,
  state,
  events,
  retry,
  onRetry,
  onResume,
  models,
}: {
  /** Whether this is the chat's latest round: only that one can still be waiting for the person. */
  latest: boolean
  state: ColonyState
  events: readonly MyrEvent[]
  retry: 'ready' | 'starting' | 'hidden'
  onRetry(): void
  onResume(model?: string): Promise<void>
  models: ModelOption[]
}) {
  const failed = state.status === 'stopped' ? state.modelError : undefined
  const finals = state.verdicts.filter((v) => v.target === 'colony')
  const last = finals.at(-1)
  const box = 'flex items-start gap-3 rounded-2xl border px-4 py-3 text-reading'
  if (state.status === 'completed') {
    const judge = finals.filter((v) => v.score !== undefined).at(-1)
    // A round the reviewer did not look at needs no banner; the round card already says it is done.
    if (!judge) return null
    return (
      <div className="flex items-start gap-3 bg-ok-soft px-4 py-3 text-reading text-ok-ink" role="status">
        <FEATURE_ICONS.verdict className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {copy.outcome.reviewed}
            {judge.score !== undefined && (
              <span className="tabular-nums"> · {copy.outcome.score(judge.score.toFixed(2))}</span>
            )}
          </div>
          <details className="mt-1 text-fg-2">
            <summary className="text-callout">{copy.outcome.whyPassed}</summary>
            <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-small">
              {judge.evidence}
            </pre>
          </details>
        </div>
      </div>
    )
  }
  if (failed)
    return (
      <ModelFailure
        failed={failed}
        models={models}
        used={Object.values(state.agents).map((a) => a.info.model)}
        retry={retry !== 'hidden'}
        onResume={onResume}
      />
    )
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
            {copy.outcome.movedTo(state.escalated.to === 'team' ? copy.outcome.aTeam : copy.outcome.oneAgent)}
          </div>
          <div className="text-callout text-fg-2">
            {state.escalated.reason} {copy.outcome.escalatedNext}
          </div>
        </div>
      </motion.div>
    )
  }
  // Questions with options are their own call to answer; the banner would only repeat it.
  if (state.status === 'stopped' && state.statusReason === AWAITING && state.chatMessages.at(-1)?.choices)
    return null
  // An earlier round that ended on a question was answered by the round after it.
  if (state.status === 'stopped' && state.statusReason === AWAITING && !latest) return null
  if (state.status === 'stopped' && state.statusReason === AWAITING) {
    return (
      <motion.div
        {...enter}
        className={cn(box, 'border-accent/25 bg-accent-soft text-accent-fg')}
        role="status"
      >
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
        <div>
          <div className="font-semibold">{copy.outcome.waiting}</div>
          <div className="text-callout text-fg-2">{copy.outcome.waitingHint}</div>
        </div>
      </motion.div>
    )
  }
  if (halted(state))
    return <Halted state={state} events={events} retry={retry} onRetry={onRetry} onResume={onResume} />
  return last && !last.pass ? (
    <motion.div {...enter} className={cn(box, 'border-warn/25 bg-warn-soft text-warn-ink')} role="status">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="font-semibold">{copy.outcome.changesAsked}</span>
        <span className="text-callout"> · {copy.outcome.fixing}</span>
        <details className="mt-1 text-fg-2">
          <summary className="text-callout">{copy.outcome.feedback}</summary>
          <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-small">
            {last.evidence}
          </pre>
        </details>
      </div>
    </motion.div>
  ) : null
}
