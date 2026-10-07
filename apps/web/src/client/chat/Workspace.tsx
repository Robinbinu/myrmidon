import {
  type ColonyState,
  type EventPayloads,
  type MyrEvent,
  roundSlice,
  type TaskSnapshot,
} from '@myrmidon/protocol'
import {
  Activity,
  ChevronRight,
  Crown,
  FileCode,
  FileText,
  GitBranch,
  ListChecks,
  Mail,
  MonitorSmartphone,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  Users,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { ChatSummary } from '../api.ts'
import { compact, usePersistentFlag } from '../ui/hooks.ts'
import { AgentAvatar, DotMatrix } from '../ui/pixel.tsx'
import { cn, Dot, Empty, IconButton, Pill, Select, softSpring, toneFor } from '../ui/primitives.tsx'
import { useColony } from '../use-colony.ts'
import SpringCheck from '../vendor/react-bits/SpringCheck'
import { AgentSheet } from './AgentSheet.tsx'
import { ArtifactViewer } from './ArtifactViewer.tsx'
import { AuditView } from './AuditView.tsx'
import { Computer } from './Computer.tsx'
import { FoldAll, FoldChevron, useFolds } from './Folds.tsx'
import { GitView } from './GitView.tsx'
import { ColonyTools } from './MadeTools.tsx'
import { ShellTerminal } from './ShellTerminal.tsx'
import { deriveSteps } from './steps.ts'
import { TaskBoard } from './TaskBoard.tsx'

type Tab =
  | 'files'
  | 'git'
  | 'shell'
  | 'computer'
  | 'tasks'
  | 'team'
  | 'mail'
  | 'terminal'
  | 'activity'
  | 'audit'

/** The panel's views, listed down its activity bar like an IDE's. `terminal` is the agents' sandboxed commands. */
const VIEWS: { value: Tab; label: string; icon: typeof FileCode; projectOnly?: boolean }[] = [
  { value: 'files', label: 'Files', icon: FileCode },
  { value: 'git', label: 'Git', icon: GitBranch, projectOnly: true },
  { value: 'shell', label: 'Terminal', icon: Terminal },
  { value: 'computer', label: 'Computer', icon: MonitorSmartphone },
  { value: 'tasks', label: 'Tasks', icon: ListChecks },
  { value: 'team', label: 'Team', icon: Users },
  { value: 'mail', label: 'Mail', icon: Mail },
  { value: 'terminal', label: 'Agent commands', icon: SquareTerminal },
  { value: 'activity', label: 'Activity', icon: Activity },
  { value: 'audit', label: 'Audit', icon: ShieldCheck },
]

const ORDER: TaskSnapshot['status'][] = [
  'in_progress',
  'submitted',
  'rejected',
  'pending',
  'verified',
  'deleted',
]

interface ShellRun {
  id: string
  agent: string
  command: string
  output?: string
  ok?: boolean
  time: string
}

function shellRuns(events: readonly MyrEvent[]): ShellRun[] {
  const runs = new Map<string, ShellRun>()
  for (const e of events) {
    if (e.type === 'tool/call') {
      const p = e.payload as EventPayloads['tool/call']
      if (p.tool !== 'shell') continue
      const args = (p.args ?? {}) as { command?: string }
      runs.set(p.callId, { id: e.id, agent: p.agent, command: args.command ?? '', time: e.time })
    } else if (e.type === 'tool/result') {
      const p = e.payload as EventPayloads['tool/result']
      const run = runs.get(p.callId)
      if (p.tool === 'shell' && run) Object.assign(run, { output: p.output, ok: p.ok })
    }
  }
  return [...runs.values()]
}

/**
 * Right-hand workspace, like an IDE's: an icon rail that is always there, and the panel for the chosen view (files,
 * git, terminal, computer, tasks, team, mail, agent commands, activity, audit), which opens from the rail and closes back
 * to it.
 */
export function Workspace(props: { chat: ChatSummary; open: boolean; onOpenChange(open: boolean): void }) {
  const rounds = props.chat.rounds
  // A chat's rounds share a colony, so a round is picked by colony and number.
  const keyOf = (r: { colonyId: string; round: number }) => `${r.colonyId}:${r.round}`
  const [picked, setPicked] = useState<string>()
  const current = rounds.find((r) => keyOf(r) === picked) ?? rounds.at(-1)
  const colonyId = current?.colonyId ?? ''
  // The latest round shows the colony live; an earlier one shows the colony as that round left it.
  const round = current && current !== rounds.at(-1) ? current.round : undefined
  const roundPicker =
    rounds.length > 1 ? (
      <Select
        value={current ? keyOf(current) : ''}
        onChange={(e) => setPicked(e.target.value)}
        aria-label="Round"
      >
        {rounds.map((r) => (
          <option key={keyOf(r)} value={keyOf(r)}>
            Round {r.round}
          </option>
        ))}
      </Select>
    ) : null
  return (
    <aside aria-label="Workspace" className="flex h-full shrink-0">
      {colonyId && (
        <WorkspaceBody
          key={colonyId}
          colonyId={colonyId}
          {...(round !== undefined ? { round } : {})}
          project={props.chat.project}
          open={props.open}
          onOpenChange={props.onOpenChange}
          roundPicker={roundPicker}
        />
      )}
    </aside>
  )
}

const TAB_KEY = 'myr-workspace-tab'

function savedTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY)
    return VIEWS.some((v) => v.value === t) ? (t as Tab) : 'files'
  } catch {
    return 'files'
  }
}

function WorkspaceBody({
  colonyId,
  round,
  project,
  open,
  onOpenChange,
  roundPicker,
}: {
  colonyId: string
  /** An earlier round of the colony to show; the latest (live) without it. */
  round?: number
  project?: { id: string; name: string }
  open: boolean
  onOpenChange(open: boolean): void
  roundPicker: ReactNode
}) {
  const colony = useColony(colonyId)
  const { state, events } = useMemo(
    () => (round === undefined ? colony : roundSlice(colony.state, colony.events, round)),
    [colony, round],
  )
  const views = VIEWS.filter((v) => !v.projectOnly || project)
  // Once opened, the panel stays mounted while closed, so a running terminal survives closing it.
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) setMounted(true)
  }, [open])
  // The shell keeps running while you look at other views; it starts the first time you open it.
  const [shellOpened, setShellOpened] = useState(false)
  const [inspect, setInspect] = useState<string>()
  const plan = state.notes.filter((n) => n.section === 'plan').at(-1)
  const [tab, setTabState] = useState<Tab>(() => {
    const t = savedTab()
    return t === 'git' && !project ? 'files' : t
  })
  const setTab = (t: Tab) => {
    setTabState(t)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      // The last view is a convenience; private mode simply forgets it.
    }
  }
  const View = views.find((v) => v.value === tab)?.icon ?? FileCode
  // Cards in the chat (a sign-in request) can open a view here, e.g. one agent's browser.
  const [focus, setFocus] = useState<string>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: setTab and onOpenChange are stable enough for a listener
  useEffect(() => {
    const open = (e: Event) => {
      const { view, agent } = (e as CustomEvent<{ view: Tab; agent?: string }>).detail
      setTab(view)
      if (agent) setFocus(agent)
      onOpenChange(true)
    }
    window.addEventListener('myr:open-view', open)
    return () => window.removeEventListener('myr:open-view', open)
  }, [])
  useEffect(() => {
    if (open && tab === 'shell') setShellOpened(true)
  }, [open, tab])
  const [file, setFile] = useState<string>()
  const steps = useMemo(() => deriveSteps(events), [events])
  const shells = useMemo(() => shellRuns(events), [events])
  const files = Object.entries(state.artifacts).sort(([a], [b]) => a.localeCompare(b))
  const tasks = Object.values(state.tasks)
    .filter((t) => t.status !== 'deleted')
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const agents = Object.values(state.agents)
  const messages = useMemo(() => conversation(state), [state])
  const by = (s: string) => tasks.filter((t) => t.status === s).length
  // The newest command and any still running start unfolded; so do tasks someone is working on or must redo.
  const newestShell = shells.at(-1)?.id
  const shellFolds = useFolds((id) => id === newestShell || shells.find((r) => r.id === id)?.ok === undefined)
  const [board, setBoard] = usePersistentFlag('myr-task-board', false)
  const taskFolds = useFolds((id) =>
    ['in_progress', 'submitted', 'rejected'].includes(state.tasks[id]?.status ?? ''),
  )
  const pct = (n: number) => `${tasks.length ? (n / tasks.length) * 100 : 0}%`
  const counts: Partial<Record<Tab, number>> = {
    files: files.length + Object.keys(state.madeTools).length,
    tasks: tasks.length,
    team: agents.length,
    mail: messages.length,
    terminal: shells.length,
  }

  return (
    <>
      <div className="flex h-full min-h-0">
        <div
          className={cn(
            'flex-col border-l border-line bg-surface',
            // Wide screens dock the panel beside the chat; narrower ones slide it over the chat, left of the rail;
            // phones have no rail and give the panel the whole width.
            'fixed inset-y-0 right-0 z-40 w-full shadow-pop md:right-12 md:w-[min(460px,calc(100vw-3rem))] xl:static xl:z-auto xl:w-[440px] xl:shadow-none',
            open ? 'flex' : 'hidden',
          )}
        >
          {mounted && (
            <>
              <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
                <View className="size-4 text-muted" />
                <span className="hidden min-w-0 flex-1 truncate text-[14px] font-semibold md:block">
                  {views.find((v) => v.value === tab)?.label}
                </span>
                {/* Phones have no rail; the views are picked here instead. */}
                <Select
                  value={tab}
                  onChange={(e) => {
                    const next = e.target.value as Tab
                    setTab(next)
                    if (next === 'shell') setShellOpened(true)
                  }}
                  aria-label="Workspace view"
                  className="min-w-0 flex-1 md:hidden"
                >
                  {views.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </Select>
                {roundPicker}
                <IconButton label="Close panel" title="Close panel (⌘J)" onClick={() => onOpenChange(false)}>
                  <X className="size-4" />
                </IconButton>
              </div>
              {shellOpened && (
                <div className={tab === 'shell' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
                  <ShellTerminal
                    {...(project ? { project: project.id } : {})}
                    cwdLabel={project ? `${project.name} · your shell` : '~ · your shell'}
                  />
                </div>
              )}
              <div className={tab === 'shell' ? 'hidden' : 'min-h-0 flex-1 overflow-auto'}>
                <AnimatePresence mode="wait">
                  <motion.div
                    key={tab}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {tab === 'git' && project && <GitView project={project.id} />}
                    {tab === 'files' && <ColonyTools colonyId={colonyId} tools={state.madeTools} />}
                    {tab === 'files' &&
                      (files.length === 0 ? (
                        Object.keys(state.madeTools).length > 0 ? null : (
                          <Empty icon={<FileCode className="size-5" />} title="No files yet">
                            Everything the colony publishes appears here, with every version kept.
                          </Empty>
                        )
                      ) : (
                        <div className="p-2">
                          {files.map(([name, versions]) => {
                            const latest = versions.at(-1)
                            const Icon = /\.(md|txt|csv)$/i.test(name) ? FileText : FileCode
                            return (
                              <button
                                key={name}
                                type="button"
                                onClick={() => setFile(name)}
                                className="group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
                              >
                                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                                  <Icon className="size-4" />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[13.5px] font-medium">{name}</span>
                                  <span className="text-[11.5px] text-muted">
                                    {versions.length} version{versions.length === 1 ? '' : 's'} ·{' '}
                                    {compact(latest?.size ?? 0)}B · {latest?.author}
                                  </span>
                                </span>
                                <ChevronRight className="size-4 text-muted transition-transform group-hover:translate-x-0.5" />
                              </button>
                            )
                          })}
                        </div>
                      ))}
                    {tab === 'tasks' &&
                      (tasks.length === 0 ? (
                        <Empty icon={<ListChecks className="size-5" />} title="No tasks">
                          Tasks appear when a team splits the work into parts.
                        </Empty>
                      ) : (
                        <>
                          {plan && (
                            <details className="group border-b border-line px-4 py-3" open>
                              <summary className="flex cursor-pointer list-none items-center justify-between font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                                Plan · {plan.agent}
                              </summary>
                              <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-fg-2">
                                {plan.text}
                              </p>
                            </details>
                          )}
                          <div className="border-b border-line px-4 py-3.5">
                            <div className="mb-2 flex items-baseline justify-between text-[12.5px]">
                              <span className="font-semibold">
                                {by('verified')} of {tasks.length} done
                              </span>
                              <span className="text-muted">
                                {by('in_progress')} active · {by('submitted')} in review · {by('pending')}{' '}
                                waiting
                              </span>
                            </div>
                            <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-2">
                              <motion.span
                                className="bg-ok"
                                animate={{ width: pct(by('verified')) }}
                                transition={softSpring}
                              />
                              <motion.span
                                className="bg-warn"
                                animate={{ width: pct(by('submitted')) }}
                                transition={softSpring}
                              />
                              <motion.span
                                className="bg-work"
                                animate={{ width: pct(by('in_progress')) }}
                                transition={softSpring}
                              />
                            </div>
                          </div>
                          <div className="flex items-center gap-2 px-3 pt-2">
                            <fieldset
                              aria-label="Task layout"
                              className="m-0 inline-flex min-w-0 rounded-lg border border-line p-0.5"
                            >
                              {(
                                [
                                  [false, 'List'],
                                  [true, 'Board'],
                                ] as const
                              ).map(([value, label]) => (
                                <button
                                  key={label}
                                  type="button"
                                  aria-pressed={board === value}
                                  onClick={() => setBoard(value)}
                                  className={cn(
                                    'rounded-md px-2 py-0.5 text-[12px] transition-colors',
                                    board === value ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg',
                                  )}
                                >
                                  {label}
                                </button>
                              ))}
                            </fieldset>
                            <span className="flex-1" />
                            {!board && <FoldAll ids={tasks.map((t) => t.id)} folds={taskFolds} />}
                          </div>
                          {board ? (
                            <TaskBoard
                              tasks={tasks}
                              events={events}
                              agents={state.agents}
                              live={state.status === 'running'}
                              onInspect={setInspect}
                            />
                          ) : (
                            <ul className="divide-y divide-line">
                              {tasks.map((t) => {
                                const open = taskFolds.isOpen(t.id)
                                const details = !!t.description || t.blockedBy.length > 0
                                return (
                                  <motion.li layout key={t.id} className="flex flex-col gap-1 px-4 py-3">
                                    <button
                                      type="button"
                                      onClick={() => taskFolds.toggle(t.id)}
                                      aria-expanded={details ? open : undefined}
                                      disabled={!details}
                                      className="-mx-1 flex items-center gap-2 rounded-md px-1 text-left enabled:hover:bg-surface-2"
                                    >
                                      <FoldChevron
                                        open={open && details}
                                        className={details ? 'text-muted' : 'invisible'}
                                      />
                                      <Pill tone={toneFor(t.status)}>{t.status.replace('_', ' ')}</Pill>
                                      <span className="font-mono text-[11px] text-muted">{t.id}</span>
                                      {t.owner && <span className="text-[12px] text-muted">· {t.owner}</span>}
                                    </button>
                                    <span className="sr-only">{t.subject}</span>
                                    {/* Agents complete tasks, so the check is a live readout, not a control. */}
                                    <div inert className="-my-1.5" title={t.subject}>
                                      <SpringCheck
                                        label={<span className="block truncate">{t.subject}</span>}
                                        className="check-line"
                                        checked={t.status === 'verified'}
                                        color="var(--text)"
                                        fillColor="var(--ok)"
                                        checkColor="var(--bg)"
                                        boxSize={18}
                                        boxRadius={6}
                                        fontSize={13.5}
                                        doneOpacity={0.5}
                                      />
                                    </div>
                                    {open && t.description && (
                                      <div className="whitespace-pre-wrap text-[12.5px] text-muted">
                                        {t.description}
                                      </div>
                                    )}
                                    {open && t.blockedBy.length > 0 && (
                                      <div className="text-[11.5px] text-muted">
                                        after {t.blockedBy.join(', ')}
                                      </div>
                                    )}
                                  </motion.li>
                                )
                              })}
                            </ul>
                          )}
                        </>
                      ))}
                    {tab === 'team' && (
                      <ul className="divide-y divide-line">
                        {agents.map((a) => {
                          const task = tasks.find(
                            (t) => t.owner === a.info.name && t.status === 'in_progress',
                          )
                          const lead = a.info.role === 'lead'
                          return (
                            <li key={a.info.name}>
                              <button
                                type="button"
                                onClick={() => setInspect(a.info.name)}
                                className="flex w-full gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-2"
                              >
                                <AgentAvatar name={a.info.name} status={a.status} size={40} />
                                <div className="grid min-w-0 flex-1 gap-1">
                                  <div className="flex items-center gap-2">
                                    <span className="font-semibold">{a.info.name}</span>
                                    {lead && <Crown className="size-3.5 text-signal" />}
                                    {a.info.specialty && (
                                      <span className="rounded-full border border-line px-2 py-px text-[11px] text-muted">
                                        {a.info.specialty}
                                      </span>
                                    )}
                                    <Pill tone={toneFor(a.status)}>
                                      <Dot status={a.status} /> {a.status}
                                    </Pill>
                                  </div>
                                  <div className="truncate font-mono text-[11.5px] text-muted">
                                    {a.info.model}
                                  </div>
                                  {(task || a.detail) && (
                                    <div className="text-[12.5px]">
                                      {task ? `Working on ${task.subject}` : a.detail}
                                    </div>
                                  )}
                                  <div className="mt-1 flex flex-wrap gap-4">
                                    {[
                                      ['turns', String(a.turns)],
                                      ['tokens', compact(a.tokens)],
                                      ['tools', String(a.toolCalls)],
                                    ].map(([label, value]) => (
                                      <span key={label} className="flex flex-col gap-1">
                                        <DotMatrix text={value ?? ''} dot={1.9} className="text-fg" />
                                        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                                          {label}
                                        </span>
                                      </span>
                                    ))}
                                    {a.costKnown && a.cost > 0 && (
                                      <span className="self-end text-[11.5px] tabular-nums text-muted">
                                        ${a.cost.toFixed(3)}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                    {tab === 'terminal' &&
                      (shells.length === 0 ? (
                        <Empty icon={<Terminal className="size-5" />} title="No shell commands yet">
                          Agents run commands in a sandbox that can only write to their own scratch folder.
                        </Empty>
                      ) : (
                        <>
                          <div className="flex justify-end px-3 pt-2">
                            <FoldAll ids={shells.map((s) => s.id)} folds={shellFolds} />
                          </div>
                          <div className="m-3 mt-1 overflow-hidden rounded-xl border border-line bg-[#0b0f17] font-mono text-[12px] text-slate-200">
                            {[...shells].reverse().map((s) => {
                              const open = shellFolds.isOpen(s.id)
                              return (
                                <div key={s.id} className="border-b border-white/5 last:border-0">
                                  <button
                                    type="button"
                                    onClick={() => shellFolds.toggle(s.id)}
                                    aria-expanded={open}
                                    className="block w-full px-3.5 py-3 text-left hover:bg-white/[0.03]"
                                  >
                                    <span className="flex items-center gap-2 text-[11px] text-slate-400">
                                      <FoldChevron open={open} />
                                      <span>{s.agent}</span>
                                      <span>·</span>
                                      <span>{s.time.slice(11, 19)}</span>
                                      <span className="flex-1" />
                                      {s.ok === undefined ? (
                                        <span className="text-work">running…</span>
                                      ) : (
                                        <span
                                          className={
                                            s.ok && /^exit 0/.test(s.output ?? '')
                                              ? 'text-emerald-400'
                                              : 'text-amber-400'
                                          }
                                        >
                                          {(s.output ?? '').split('\n')[0]}
                                        </span>
                                      )}
                                    </span>
                                    <span
                                      className={cn(
                                        'mt-1.5 block break-all',
                                        open ? 'whitespace-pre-wrap' : 'truncate',
                                      )}
                                    >
                                      <span className="select-none text-emerald-400">$ </span>
                                      {s.command}
                                    </span>
                                  </button>
                                  {open && s.output && (
                                    <pre className="mx-3.5 mb-3 max-h-64 overflow-auto whitespace-pre-wrap break-all text-slate-400">
                                      {s.output
                                        .split('\n')
                                        .slice(1)
                                        .join('\n')
                                        .replace(/--- (stdout|stderr)\n?/g, '')
                                        .trim() || '(no output)'}
                                    </pre>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </>
                      ))}
                    {tab === 'audit' && <AuditView events={events} />}
                    {tab === 'mail' && <MailTab messages={messages} onInspect={setInspect} />}
                    {tab === 'computer' && (
                      <Computer
                        colonyId={colonyId}
                        live={state.status === 'running'}
                        events={events}
                        {...(focus ? { focus } : {})}
                      />
                    )}
                    {tab === 'activity' &&
                      (steps.length === 0 ? (
                        <Empty icon={<Activity className="size-5" />} title="Nothing yet" />
                      ) : (
                        <ol className="flex flex-col px-4 py-2">
                          {[...steps].reverse().map((s) => (
                            <li
                              key={s.id}
                              className="grid grid-cols-[1fr_auto] gap-3 border-b border-line py-2 text-[12.5px] last:border-0"
                            >
                              <span className="min-w-0 break-words text-fg-2">
                                <span className="text-muted">{s.agent} · </span>
                                {s.lead}{' '}
                                {s.strong && <span className="font-semibold text-fg">{s.strong}</span>}{' '}
                                {s.tail && <span className="text-muted">{s.tail}</span>}
                              </span>
                              <time className="tabular-nums text-muted">{s.time.slice(11, 19)}</time>
                            </li>
                          ))}
                        </ol>
                      ))}
                  </motion.div>
                </AnimatePresence>
              </div>
            </>
          )}
        </div>
        <nav
          aria-label="Workspace views"
          className="hidden w-12 shrink-0 flex-col items-center gap-1 border-l border-line bg-surface py-2 md:flex"
        >
          {views.map((v) => {
            const count = counts[v.value]
            return (
              <button
                key={v.value}
                type="button"
                onClick={() => {
                  // The open view's icon closes the panel; any other icon opens its view.
                  if (open && tab === v.value) return onOpenChange(false)
                  setTab(v.value)
                  if (v.value === 'shell') setShellOpened(true)
                  onOpenChange(true)
                }}
                aria-label={v.label}
                aria-pressed={open && tab === v.value}
                title={v.label}
                className={cn(
                  'relative grid size-9 place-items-center rounded-lg transition-colors',
                  open && tab === v.value
                    ? 'bg-surface-2 text-fg'
                    : 'text-muted hover:bg-surface-2/60 hover:text-fg',
                )}
              >
                {open && tab === v.value && (
                  <motion.span
                    layoutId="workspace-view"
                    transition={softSpring}
                    className="absolute -left-[7px] top-1.5 bottom-1.5 w-[2px] rounded-full bg-fg"
                  />
                )}
                <v.icon className="size-[18px]" />
                {!!count && (
                  <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-surface-3 px-1 text-center text-[11px] font-medium leading-4 tabular-nums text-fg-2">
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </div>
      <AnimatePresence>
        {file && state.artifacts[file] && (
          <ArtifactViewer
            colonyId={colonyId}
            name={file}
            versions={state.artifacts[file] ?? []}
            onClose={() => setFile(undefined)}
          />
        )}
      </AnimatePresence>
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
    </>
  )
}

interface Message {
  readonly id: string
  readonly seq: number
  readonly time: string
  readonly from: string
  /** An agent's name, or `board` for a post everyone can read. */
  readonly to: string
  readonly subject?: string
  readonly text: string
  readonly read?: boolean
}

/** Everything the agents said to each other: board posts and direct mail, oldest first. */
function conversation(state: ColonyState): Message[] {
  return [
    ...state.board.map((b) => ({
      id: b.id,
      seq: b.seq,
      time: b.time,
      from: b.agent,
      to: 'board',
      text: b.text,
    })),
    ...state.mail.map((m) => ({
      id: m.id,
      seq: m.seq,
      time: m.time,
      from: m.from,
      to: m.to,
      ...(m.subject ? { subject: m.subject } : {}),
      text: m.body,
      read: m.delivered,
    })),
  ].sort((a, b) => a.seq - b.seq)
}

/** The agents' conversation, filterable to the messages one agent sent or received. */
function MailTab(props: { messages: readonly Message[]; onInspect(name: string): void }) {
  const [who, setWho] = useState('')
  const names = [...new Set(props.messages.flatMap((m) => [m.from, m.to]))]
    .filter((n) => n !== 'board')
    .sort()
  const shown = who ? props.messages.filter((m) => m.from === who || m.to === who) : props.messages
  if (props.messages.length === 0)
    return (
      <Empty icon={<Mail className="size-5" />} title="No messages yet">
        Board posts and mail between agents show up here.
      </Empty>
    )
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <span className="text-[12px] text-muted">
          {shown.length} message{shown.length === 1 ? '' : 's'}
        </span>
        <Select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Show messages for">
          <option value="">Everyone</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </div>
      <ol className="flex flex-col gap-3 px-4 py-3">
        {shown.map((m) => (
          <li key={m.id} className="flex gap-2.5">
            <button
              type="button"
              onClick={() => props.onInspect(m.from)}
              aria-label={`Open ${m.from}`}
              className="h-fit rounded-lg transition-transform hover:scale-105"
            >
              <AgentAvatar name={m.from} status="idle" size={26} awake />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5 text-[12px]">
                <span className="font-semibold text-fg">{m.from}</span>
                <span className="text-muted">→ {m.to === 'board' ? 'everyone' : m.to}</span>
                {m.to !== 'board' && m.read === false && <Pill tone="warn">unread</Pill>}
                <time className="ml-auto shrink-0 tabular-nums text-muted">{m.time.slice(11, 16)}</time>
              </div>
              <div className="mt-1 rounded-xl rounded-tl-sm border border-line bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-fg-2">
                {m.subject && <div className="mb-0.5 font-medium text-fg">{m.subject}</div>}
                <div className="whitespace-pre-wrap break-words">{m.text}</div>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
