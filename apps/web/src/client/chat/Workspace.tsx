import {
  type ColonyState,
  type Conversation as ConversationInfo,
  type ConversationLine,
  conversationsOf,
  type EventPayloads,
  linesOf,
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
  Puzzle,
  SquareTerminal,
  Terminal,
  Users,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type CSSProperties, Fragment, type ReactNode, useEffect, useMemo, useState } from 'react'
import type { ChatSummary } from '../api.ts'
import { copy } from '../copy.ts'
import { useScope } from '../DeviceGate.tsx'
import { PluginSlot, usePluginSlots } from '../plugins.tsx'
import { clock, compact, useHotkeys, useMinWidth, usePersistentFlag, useStickToBottom } from '../ui/hooks.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { AgentAvatar, agentColor, DotMatrix } from '../ui/pixel.tsx'
import { isMac } from '../ui/platform.ts'
import {
  Badge,
  CountBadge,
  cn,
  countText,
  Dot,
  Empty,
  IconButton,
  Select,
  toneFor,
} from '../ui/primitives.tsx'
import { SplitDivider, useSplitWidth } from '../ui/SplitDivider.tsx'
import { comboLabel } from '../ui/shortcuts.ts'
import { agentPhase } from '../ui/status.ts'
import { softSpring, WORKSPACE_DOCK_PX } from '../ui-config.ts'
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
  | `plugin:${string}`
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

interface ViewDef {
  value: Tab
  label: string
  icon: typeof FileCode
  /** Views that sit together on the rail, between dividers. */
  group: number
  /** The digit of its shortcut (see VIEW_COMBO). */
  key?: string
  projectOnly?: boolean
  /** The person's own login shell: the server opens it only for full-access devices. */
  fullOnly?: boolean
}

/**
 * The panel's views, listed down its activity bar like an IDE's, in groups: the work, the machines agents use, the
 * crew, and the record. `terminal` is the agents' sandboxed commands; `shell` is the person's own.
 */
const VIEWS: ViewDef[] = [
  { value: 'files', label: copy.workspace.views.files, icon: FileCode, group: 0, key: '1' },
  { value: 'git', label: copy.workspace.views.git, icon: GitBranch, group: 0, key: '2', projectOnly: true },
  { value: 'tasks', label: copy.workspace.views.tasks, icon: ListChecks, group: 0, key: '3' },
  { value: 'shell', label: copy.workspace.views.shell, icon: Terminal, group: 1, key: '4', fullOnly: true },
  {
    value: 'computer',
    label: copy.workspace.views.computer,
    icon: FEATURE_ICONS.computer,
    group: 1,
    key: '5',
  },
  { value: 'terminal', label: copy.workspace.views.terminal, icon: SquareTerminal, group: 1, key: '6' },
  { value: 'team', label: copy.workspace.views.team, icon: Users, group: 2, key: '7' },
  { value: 'mail', label: copy.workspace.views.mail, icon: Mail, group: 2, key: '8' },
  { value: 'activity', label: copy.workspace.views.activity, icon: Activity, group: 3, key: '9' },
  { value: 'audit', label: copy.workspace.views.audit, icon: FEATURE_ICONS.audit, group: 3, key: '0' },
]
const PLUGIN_GROUP = 4
const VIEW_COMBO = (key: string) => `mod+alt+${key}`
/** The views the panel opens by itself for, in the order it prefers when several have something. */
const CONTENT_VIEWS: Tab[] = ['computer', 'files', 'git', 'tasks']
const EDITS = new Set(['fs_write', 'fs_edit'])

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
        aria-label={copy.workspace.roundLabel}
      >
        {rounds.map((r) => (
          <option key={keyOf(r)} value={keyOf(r)}>
            {copy.workspace.roundOption(r.round)}
          </option>
        ))}
      </Select>
    ) : null
  return (
    <aside aria-label={copy.workspace.label} className="flex h-full shrink-0">
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
  const split = useSplitWidth('myr-inspector-width', { min: 320, max: 640, initial: 440 })
  const { state, events } = useMemo(
    () => (round === undefined ? colony : roundSlice(colony.state, colony.events, round)),
    [colony, round],
  )
  const pluginTabs = usePluginSlots('workspace.tab')
  const fullAccess = useScope() === 'full'
  const views: ViewDef[] = [
    ...VIEWS.filter((v) => (!v.projectOnly || project) && (!v.fullOnly || fullAccess)),
    ...pluginTabs.map(({ plugin, def }) => ({
      value: `plugin:${plugin}` as Tab,
      label: def.title ?? plugin,
      icon: Puzzle,
      group: PLUGIN_GROUP,
    })),
  ]
  // The shell keeps running while you look at other views; it starts the first time you open it.
  const [shellOpened, setShellOpened] = useState(false)
  const [inspect, setInspect] = useState<string>()
  const plan = state.notes.filter((n) => n.section === 'plan').at(-1)
  const [tab, setTabState] = useState<Tab>(() => {
    const t = savedTab()
    return (t === 'git' && !project) || (t === 'shell' && !fullAccess) ? 'files' : t
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: setTab and show are stable enough for a listener
  useEffect(() => {
    const open = (e: Event) => {
      const { view, agent } = (e as CustomEvent<{ view: Tab; agent?: string }>).detail
      setTab(view)
      if (agent) setFocus(agent)
      show(true)
    }
    window.addEventListener('myr:open-view', open)
    return () => window.removeEventListener('myr:open-view', open)
  }, [])
  const [file, setFile] = useState<string>()
  const [hint, setHint] = useState<{ label: string; combo?: string; top: number; right: number }>()
  const steps = useMemo(() => deriveSteps(events), [events])
  const shells = useMemo(() => shellRuns(events), [events])
  const files = Object.entries(state.artifacts).sort(([a], [b]) => a.localeCompare(b))
  const tasks = Object.values(state.tasks)
    .filter((t) => t.status !== 'deleted')
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const agents = Object.values(state.agents)
  const threads = useMemo(() => threadsOf(state), [state])
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
    mail: threads.reduce((n, t) => n + t.messages.length, 0),
    terminal: shells.length,
  }
  const edited = useMemo(
    () =>
      events.some((e) => e.type === 'tool/call' && EDITS.has((e.payload as EventPayloads['tool/call']).tool)),
    [events],
  )
  const has: Partial<Record<Tab, boolean>> = {
    computer: Object.values(state.logins).some((l) => !l.finished),
    files: !!counts.files,
    git: !!project && edited,
    tasks: tasks.length > 0,
  }
  const worth = CONTENT_VIEWS.find((t) => has[t])
  // The panel the person keeps open shows itself only in chats with something in it (a one-line question has
  // nothing); opening it in this chat (the rail, ⌘J, a card in the chat) shows it anyway. Closing it is remembered.
  // Where the panel would cover the chat (a narrow or zoomed window) it never shows itself.
  const [asked, setAsked] = useState(false)
  const docks = useMinWidth(WORKSPACE_DOCK_PX)
  const shown = open && (asked || (docks && worth !== undefined))
  const show = (next: boolean) => {
    setAsked(next)
    onOpenChange(next)
  }
  const auto = shown && !asked
  // Opening by itself, it starts on what it opened for unless the last view has something to show too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when it opens by itself
  useEffect(() => {
    if (auto && worth && !has[tab]) setTabState(worth)
  }, [auto])
  // Once opened, the panel stays mounted while closed, so a running terminal survives closing it.
  const [mounted, setMounted] = useState(shown)
  useEffect(() => {
    if (shown) setMounted(true)
  }, [shown])
  useEffect(() => {
    if (shown && tab === 'shell') setShellOpened(true)
  }, [shown, tab])
  const pick = (t: Tab) => {
    // The open view's icon (or shortcut) closes the panel; any other opens its view.
    if (shown && tab === t) return show(false)
    setTab(t)
    if (t === 'shell') setShellOpened(true)
    show(true)
  }
  useHotkeys([
    { combo: 'mod+j', run: () => show(!shown), inInputs: true },
    ...views.flatMap((v) => (v.key ? [{ combo: VIEW_COMBO(v.key), run: () => pick(v.value) }] : [])),
  ])

  return (
    <>
      <div className="flex h-full min-h-0">
        {shown && (
          <SplitDivider
            split={split}
            side="right"
            label={copy.workspace.resize}
            className="hidden xl:block"
          />
        )}
        <div
          style={{ '--inspector-w': `${split.width}px` } as CSSProperties}
          className={cn(
            'flex-col border-l border-line bg-surface',
            // Wide screens dock the panel beside the chat; narrower ones slide it over the chat, left of the rail;
            // phones have no rail and give the panel the whole width.
            'fixed inset-y-0 right-0 z-40 w-full shadow-pop md:right-12 md:w-[min(440px,calc(100vw-3rem))] xl:static xl:z-auto xl:w-[min(var(--inspector-w),calc(100vw-820px))] xl:shadow-none',
            shown ? 'flex' : 'hidden',
          )}
        >
          {mounted && (
            <>
              <div
                data-toolbar
                className="drag-region flex h-[52px] shrink-0 items-center gap-2 border-b border-line pl-4 pr-2"
              >
                <View className="size-4 text-muted" />
                <span className="hidden min-w-0 flex-1 truncate text-title font-semibold md:block">
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
                  aria-label={copy.workspace.viewLabel}
                  className="min-w-0 flex-1 md:hidden"
                >
                  {views.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </Select>
                {roundPicker}
                <IconButton
                  label={copy.workspace.close}
                  title={copy.workspace.closeTitle}
                  onClick={() => show(false)}
                >
                  <X className="size-4" />
                </IconButton>
              </div>
              {shellOpened && (
                <div className={tab === 'shell' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
                  <ShellTerminal
                    {...(project ? { project: project.id } : {})}
                    cwdLabel={project ? copy.workspace.shellCwd(project.name) : copy.workspace.shellCwd('~')}
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
                    // An open conversation fills the panel and scrolls on its own, opening at its newest message.
                    className={tab === 'mail' ? 'h-full' : undefined}
                  >
                    {tab === 'git' && project && <GitView project={project.id} />}
                    {tab === 'files' && <ColonyTools colonyId={colonyId} tools={state.madeTools} />}
                    {tab === 'files' &&
                      (files.length === 0 ? (
                        Object.keys(state.madeTools).length > 0 ? null : (
                          <Empty
                            icon={<FileCode className="size-5" />}
                            title={copy.workspace.files.emptyTitle}
                          >
                            {copy.workspace.files.emptyBody}
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
                                className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-fill"
                              >
                                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg">
                                  <Icon className="size-4" />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-reading font-medium">{name}</span>
                                  <span className="text-footnote text-muted">
                                    {copy.workspace.files.meta(versions.length, compact(latest?.size ?? 0))} ·{' '}
                                    {latest?.author}
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
                        <Empty
                          icon={<ListChecks className="size-5" />}
                          title={copy.workspace.tasks.emptyTitle}
                        >
                          {copy.workspace.tasks.emptyBody}
                        </Empty>
                      ) : (
                        <>
                          {plan && (
                            <details className="group border-b border-line px-4 py-3" open>
                              <summary className="flex list-none items-center justify-between section-label text-muted">
                                {copy.workspace.tasks.plan(plan.agent)}
                              </summary>
                              <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-callout leading-relaxed text-fg-2">
                                {plan.text}
                              </p>
                            </details>
                          )}
                          <div className="border-b border-line px-4 py-3.5">
                            <div className="mb-2 flex items-baseline justify-between text-callout">
                              <span className="font-semibold">
                                {copy.workspace.tasks.done(by('verified'), tasks.length)}
                              </span>
                              <span className="text-muted">
                                {copy.workspace.tasks.progress(
                                  by('in_progress'),
                                  by('submitted'),
                                  by('pending'),
                                )}
                              </span>
                            </div>
                            <div className="flex h-1.5 overflow-hidden rounded-full bg-fill">
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
                              aria-label={copy.workspace.tasks.layout}
                              className="m-0 inline-flex min-w-0 rounded-xl border border-line p-0.5"
                            >
                              {(
                                [
                                  [false, copy.workspace.tasks.list],
                                  [true, copy.workspace.tasks.board],
                                ] as const
                              ).map(([value, label]) => (
                                <button
                                  key={label}
                                  type="button"
                                  aria-pressed={board === value}
                                  onClick={() => setBoard(value)}
                                  className={cn(
                                    'rounded-md px-2 py-0.5 text-small transition-colors',
                                    board === value ? 'bg-fill-strong text-fg' : 'text-muted hover:text-fg',
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
                                      className="-mx-1 flex items-center gap-2 rounded-md px-1 text-left enabled:hover:bg-fill"
                                    >
                                      <FoldChevron
                                        open={open && details}
                                        className={details ? 'text-muted' : 'invisible'}
                                      />
                                      <Badge tone={toneFor(t.status)}>
                                        {copy.workspace.taskStatus[t.status]}
                                      </Badge>
                                      <span className="font-mono text-caption text-muted">{t.id}</span>
                                      {t.owner && <span className="text-small text-muted">· {t.owner}</span>}
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
                                      <div className="whitespace-pre-wrap text-callout text-muted">
                                        {t.description}
                                      </div>
                                    )}
                                    {open && t.blockedBy.length > 0 && (
                                      <div className="text-footnote text-muted">
                                        {copy.workspace.tasks.after(t.blockedBy.join(', '))}
                                      </div>
                                    )}
                                  </motion.li>
                                )
                              })}
                            </ul>
                          )}
                        </>
                      ))}
                    {tab === 'team' && agents.length === 0 && (
                      <Empty icon={<Users className="size-5" />} title={copy.workspace.team.emptyTitle}>
                        {copy.workspace.team.emptyBody}
                      </Empty>
                    )}
                    {tab === 'team' && agents.length > 0 && (
                      <ul className="divide-y divide-line">
                        {agents.map((a) => {
                          const task = tasks.find(
                            (t) => t.owner === a.info.name && t.status === 'in_progress',
                          )
                          const lead = a.info.role === 'lead'
                          const { phase, detail } = agentPhase(a, state)
                          return (
                            <li key={a.info.name}>
                              <button
                                type="button"
                                onClick={() => setInspect(a.info.name)}
                                className="flex w-full gap-3 px-4 py-3.5 text-left transition-colors hover:bg-fill"
                              >
                                <AgentAvatar name={a.info.name} status={phase} size={40} />
                                <div className="grid min-w-0 flex-1 gap-1">
                                  <div className="flex items-center gap-2">
                                    <span className="font-semibold">{a.info.name}</span>
                                    {lead && <Crown className="size-3.5 text-signal" />}
                                    {a.info.specialty && (
                                      <span className="rounded-full border border-line px-2 py-px text-caption text-muted">
                                        {a.info.specialty}
                                      </span>
                                    )}
                                    <Badge tone={toneFor(phase)}>
                                      <Dot status={phase} /> {copy.status.agent[phase]}
                                    </Badge>
                                  </div>
                                  <div className="truncate font-mono text-footnote text-muted">
                                    {a.info.model}
                                  </div>
                                  {(task || detail) && (
                                    <div className="text-callout">
                                      {task ? copy.workspace.team.workingOn(task.subject) : detail}
                                    </div>
                                  )}
                                  <div className="mt-1 flex flex-wrap gap-4">
                                    {[
                                      [copy.workspace.team.turns, String(a.turns)],
                                      [copy.workspace.team.tokens, compact(a.tokens)],
                                      [copy.workspace.team.tools, String(a.toolCalls)],
                                    ].map(([label, value]) => (
                                      <span key={label} className="flex flex-col gap-1">
                                        <DotMatrix text={value ?? ''} dot={1.9} className="text-fg" />
                                        <span className="section-label text-muted">{label}</span>
                                      </span>
                                    ))}
                                    {a.costKnown && a.cost > 0 && (
                                      <span className="self-end text-footnote tabular-nums text-muted">
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
                        <Empty icon={<Terminal className="size-5" />} title={copy.workspace.shell.emptyTitle}>
                          {copy.workspace.shell.emptyBody}
                        </Empty>
                      ) : (
                        <>
                          <div className="flex justify-end px-3 pt-2">
                            <FoldAll ids={shells.map((s) => s.id)} folds={shellFolds} />
                          </div>
                          <div className="m-3 mt-1 overflow-hidden rounded-lg border border-line bg-[color:var(--shell-log-bg)] font-mono text-small text-[color:var(--terminal-text)]">
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
                                    <span className="flex items-center gap-2 text-caption text-[color:var(--terminal-muted)]">
                                      <FoldChevron open={open} />
                                      <span>{s.agent}</span>
                                      <span>·</span>
                                      <span>{clock(s.time, true)}</span>
                                      <span className="flex-1" />
                                      {s.ok === undefined ? (
                                        <span className="text-signal">{copy.workspace.shell.running}</span>
                                      ) : (
                                        <span
                                          className={
                                            s.ok && /^exit 0/.test(s.output ?? '')
                                              ? 'text-[color:var(--terminal-command)]'
                                              : 'text-[color:var(--terminal-error)]'
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
                                      <span className="select-none text-[color:var(--terminal-command)]">
                                        ${' '}
                                      </span>
                                      {s.command}
                                    </span>
                                  </button>
                                  {open && s.output && (
                                    <pre className="mx-3.5 mb-3 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[color:var(--terminal-muted)]">
                                      {s.output
                                        .split('\n')
                                        .slice(1)
                                        .join('\n')
                                        .replace(/--- (stdout|stderr)\n?/g, '')
                                        .trim() || copy.workspace.shell.noOutput}
                                    </pre>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </>
                      ))}
                    {tab === 'audit' && <AuditView events={events} />}
                    {pluginTabs.map(
                      ({ plugin, def }) =>
                        tab === `plugin:${plugin}` && (
                          <PluginSlot key={plugin} plugin={plugin} def={def} props={{ colonyId, state }} />
                        ),
                    )}
                    {tab === 'mail' && <MailTab threads={threads} onInspect={setInspect} />}
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
                        <Empty icon={<Activity className="size-5" />} title={copy.workspace.activityEmpty} />
                      ) : (
                        <ol className="flex flex-col px-4 py-2">
                          {[...steps].reverse().map((s) => (
                            <li
                              key={s.id}
                              className="grid grid-cols-[1fr_auto] gap-3 border-b border-line py-2 text-callout last:border-0"
                            >
                              <span className="min-w-0 break-words text-fg-2">
                                <span className="text-muted">{s.agent} · </span>
                                {s.lead}{' '}
                                {s.strong && <span className="font-semibold text-fg">{s.strong}</span>}{' '}
                                {s.tail && <span className="text-muted">{s.tail}</span>}
                              </span>
                              <time className="tabular-nums text-muted">{clock(s.time, true)}</time>
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
          aria-label={copy.workspace.viewsLabel}
          className="hidden w-12 shrink-0 flex-col border-l border-line bg-surface md:flex"
        >
          <div data-toolbar className="drag-region h-[52px] w-full shrink-0 border-b border-line" />
          {/* Short windows and plugin views make the rail taller than the window, so it scrolls. */}
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto pb-2 pt-1.5">
            {views.map((v, i) => {
              const count = counts[v.value]
              const on = shown && tab === v.value
              const combo = v.key ? VIEW_COMBO(v.key) : undefined
              // The rail scrolls, which would clip a tooltip inside it, so the tooltip is placed on the window.
              const point = (el: HTMLElement) => {
                const r = el.getBoundingClientRect()
                setHint({
                  label: v.label,
                  ...(combo ? { combo: comboLabel(combo, isMac) } : {}),
                  top: r.top + r.height / 2,
                  right: window.innerWidth - r.left + 6,
                })
              }
              return (
                <Fragment key={v.value}>
                  {views[i - 1] && views[i - 1]?.group !== v.group && (
                    <span aria-hidden="true" className="my-0.5 h-px w-5 shrink-0 bg-line" />
                  )}
                  <button
                    type="button"
                    onClick={() => pick(v.value)}
                    onMouseEnter={(e) => point(e.currentTarget)}
                    onFocus={(e) => point(e.currentTarget)}
                    onMouseLeave={() => setHint(undefined)}
                    onBlur={() => setHint(undefined)}
                    aria-label={count ? copy.workspace.viewWithCount(v.label, countText(count)) : v.label}
                    aria-pressed={on}
                    aria-keyshortcuts={v.key ? `${isMac ? 'Meta' : 'Control'}+Alt+${v.key}` : undefined}
                    className={cn(
                      'relative grid size-8 shrink-0 place-items-center rounded-md transition-colors',
                      on ? 'bg-fill text-fg' : 'text-muted hover:bg-fill/60 hover:text-fg',
                    )}
                  >
                    {on && (
                      <motion.span
                        layoutId="workspace-view"
                        transition={softSpring}
                        className="absolute -left-[7px] top-1.5 bottom-1.5 w-[2px] rounded-full bg-fg"
                      />
                    )}
                    <v.icon className="size-[18px]" />
                    {!!count && <CountBadge count={count} corner />}
                  </button>
                </Fragment>
              )
            })}
          </div>
        </nav>
        {hint && (
          <div
            role="tooltip"
            style={{ top: hint.top, right: hint.right }}
            className="material-menu pointer-events-none fixed z-50 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-md border border-line px-2 py-1 text-small text-fg"
          >
            {hint.label}
            {hint.combo && <kbd className="font-sans text-footnote text-muted">{hint.combo}</kbd>}
          </div>
        )}
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

/** A conversation in the Mail tab, with its lines: the team chat, a group, or two agents' one-to-one chat. */
interface Thread extends ConversationInfo {
  readonly messages: readonly ConversationLine[]
}

function threadsOf(state: ColonyState): Thread[] {
  return conversationsOf(state)
    .map((c) => ({ ...c, messages: linesOf(state, c.id) }))
    .filter((t) => t.messages.length > 0)
}

const threadTitle = (t: Thread) =>
  t.kind === 'team' ? copy.workspace.mail.team : t.kind === 'group' ? t.name : t.members.join(' · ')

/**
 * The agents' messages, laid out like a messaging app: a list of conversations (the team's group chat and each pair
 * of agents who wrote to each other), newest first, and a conversation open as bubbles with replies quoted.
 */
function MailTab(props: { threads: readonly Thread[]; onInspect(name: string): void }) {
  const [open, setOpen] = useState<string>()
  const threads = props.threads
  const thread = threads.find((t) => t.id === open)
  if (threads.length === 0)
    return (
      <Empty icon={<Mail className="size-5" />} title={copy.workspace.mail.emptyTitle}>
        {copy.workspace.mail.emptyBody}
      </Empty>
    )
  if (thread)
    return <Conversation thread={thread} onBack={() => setOpen(undefined)} onInspect={props.onInspect} />
  return (
    <ul className="flex flex-col py-1">
      {threads.map((t) => {
        const last = t.messages.at(-1)
        const unread = t.messages.filter((m) => m.read === false).length
        return (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => setOpen(t.id)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-fill"
            >
              {t.kind === 'team' ? (
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-fill text-fg-2">
                  <Users className="size-4" />
                </span>
              ) : (
                <span className="relative h-9 w-11 shrink-0">
                  <span className="absolute left-0 top-0">
                    <AgentAvatar name={t.members[0] ?? ''} status="idle" size={26} awake />
                  </span>
                  <span className="absolute bottom-0 right-0 rounded-base ring-2 ring-surface">
                    <AgentAvatar name={t.members[1] ?? ''} status="idle" size={26} awake />
                  </span>
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-body font-semibold text-fg">{threadTitle(t)}</span>
                  {t.kind === 'group' && (
                    <span className="shrink-0 text-footnote text-muted">
                      {copy.workspace.mail.members(t.members.length)}
                    </span>
                  )}
                  <time className="ml-auto shrink-0 text-footnote tabular-nums text-muted">
                    {clock(last?.time)}
                  </time>
                </span>
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-callout text-muted">
                    {last ? `${last.from}: ${last.text}` : ''}
                  </span>
                  {unread > 0 && (
                    <span className="min-w-5 shrink-0 rounded-full bg-ok px-1.5 text-center text-caption font-semibold leading-5 text-on-bright">
                      {unread}
                    </span>
                  )}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * One conversation as chat bubbles. One-to-one, the second agent writes on the right, like your own messages; in the
 * team chat and groups everyone writes on the left, as in a group chat.
 */
function Conversation(props: { thread: Thread; onBack(): void; onInspect(name: string): void }) {
  const { thread } = props
  const right = thread.kind === 'direct' ? thread.members[1] : undefined
  const bySeq = new Map(thread.messages.map((m) => [m.seq, m]))
  const list = useStickToBottom<HTMLDivElement>(thread.id)
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
        <IconButton size="sm" label={copy.workspace.mail.back} onClick={props.onBack}>
          <ChevronRight className="size-4 rotate-180" />
        </IconButton>
        <span className="truncate text-body font-semibold">{threadTitle(thread)}</span>
        {thread.kind === 'group' && (
          <span className="truncate text-small text-muted">{thread.members.join(', ')}</span>
        )}
        <span className="ml-auto pr-2 text-small text-muted">
          {copy.workspace.mail.count(thread.messages.length)}
        </span>
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ol className="flex flex-col gap-1.5 px-3 py-3">
          {thread.messages.map((m, i) => {
            const mine = m.from === right
            const quoted = m.replyTo !== undefined ? bySeq.get(m.replyTo) : undefined
            const first = thread.messages[i - 1]?.from !== m.from
            return (
              <li key={m.id} className={cn('flex gap-2', mine && 'flex-row-reverse', first && 'mt-1.5')}>
                <span className="w-[26px] shrink-0">
                  {first && (
                    <button
                      type="button"
                      onClick={() => props.onInspect(m.from)}
                      aria-label={copy.workspace.mail.open(m.from)}
                      className="rounded-xl transition-transform hover:scale-105"
                    >
                      <AgentAvatar name={m.from} status="idle" size={26} awake />
                    </button>
                  )}
                </span>
                <div
                  className={cn(
                    'max-w-[80%] rounded-2xl px-3 py-1.5 text-callout leading-relaxed',
                    mine ? 'rounded-tr-sm bg-accent-soft text-fg' : 'rounded-tl-sm bg-fill text-fg-2',
                  )}
                >
                  {first && (
                    <div className="text-footnote font-semibold" style={{ color: agentColor(m.from) }}>
                      {m.from}
                    </div>
                  )}
                  {quoted && (
                    <div className="mb-1 truncate border-l-2 border-line-strong pl-2 text-footnote text-muted">
                      {quoted.from}: {quoted.text}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap break-words">{m.text}</div>
                  <div className="mt-0.5 flex justify-end gap-1 text-caption tabular-nums text-muted">
                    {clock(m.time)}
                    {m.read !== undefined && (
                      <span
                        className={m.read ? 'text-ok-ink' : ''}
                        title={m.read ? copy.workspace.mail.read : copy.workspace.mail.unread}
                      >
                        {m.read ? '✓✓' : '✓'}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
