import type { ColonyState, EventPayloads, MyrEvent, TaskSnapshot } from '@myrmidon/protocol'
import {
  Activity,
  ChevronRight,
  Crown,
  FileCode,
  FileText,
  FolderOpen,
  ListChecks,
  Mail,
  Terminal,
  Users,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import type { ChatSummary } from '../api.ts'
import { compact } from '../ui/hooks.ts'
import { AgentAvatar, DotMatrix } from '../ui/pixel.tsx'
import { Dot, Empty, IconButton, Pill, Select, softSpring, Tabs, toneFor } from '../ui/primitives.tsx'
import { useColony } from '../use-colony.ts'
import SpringCheck from '../vendor/react-bits/SpringCheck'
import { AgentSheet } from './AgentSheet.tsx'
import { ArtifactViewer } from './ArtifactViewer.tsx'
import { deriveSteps } from './steps.ts'

type Tab = 'files' | 'tasks' | 'team' | 'mail' | 'terminal' | 'activity'

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

/** Right-hand panel: files, task progress, team, shell sessions, and the full activity log. */
export function Workspace(props: { chat: ChatSummary; onClose(): void }) {
  const rounds = props.chat.rounds
  const [picked, setPicked] = useState<string>()
  const colonyId =
    picked && rounds.some((r) => r.colonyId === picked) ? picked : (rounds.at(-1)?.colonyId ?? '')
  return (
    <motion.aside
      initial={{ x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 24, opacity: 0 }}
      transition={softSpring}
      aria-label="Workspace"
      className="fixed inset-y-0 right-0 z-40 flex w-[min(460px,94vw)] flex-col border-l border-line bg-surface shadow-pop xl:static xl:z-auto xl:w-[440px] xl:shadow-none"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
        <FolderOpen className="size-4 text-muted" />
        <span className="flex-1 text-[14px] font-semibold">Workspace</span>
        {rounds.length > 1 && (
          <Select value={colonyId} onChange={(e) => setPicked(e.target.value)} aria-label="Round">
            {rounds.map((r) => (
              <option key={r.colonyId} value={r.colonyId}>
                Round {r.round}
              </option>
            ))}
          </Select>
        )}
        <IconButton label="Close workspace" onClick={props.onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      {colonyId && <WorkspaceBody key={colonyId} colonyId={colonyId} />}
    </motion.aside>
  )
}

function WorkspaceBody({ colonyId }: { colonyId: string }) {
  const { state, events } = useColony(colonyId)
  const [inspect, setInspect] = useState<string>()
  const plan = state.notes.filter((n) => n.section === 'plan').at(-1)
  const [tab, setTab] = useState<Tab>('files')
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
  const pct = (n: number) => `${tasks.length ? (n / tasks.length) * 100 : 0}%`

  return (
    <>
      <Tabs
        id="workspace"
        value={tab}
        onChange={setTab}
        tabs={[
          {
            value: 'files',
            label: (
              <>
                <FileCode className="size-3.5" /> Files
              </>
            ),
            count: files.length,
          },
          {
            value: 'tasks',
            label: (
              <>
                <ListChecks className="size-3.5" /> Tasks
              </>
            ),
            count: tasks.length,
          },
          {
            value: 'team',
            label: (
              <>
                <Users className="size-3.5" /> Team
              </>
            ),
            count: agents.length,
          },
          {
            value: 'mail',
            label: (
              <>
                <Mail className="size-3.5" /> Mail
              </>
            ),
            count: messages.length,
          },
          {
            value: 'terminal',
            label: (
              <>
                <Terminal className="size-3.5" /> Terminal
              </>
            ),
            count: shells.length,
          },
          {
            value: 'activity',
            label: (
              <>
                <Activity className="size-3.5" /> Activity
              </>
            ),
          },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {tab === 'files' &&
              (files.length === 0 ? (
                <Empty icon={<FileCode className="size-5" />} title="No files yet">
                  Everything the colony publishes appears here, with every version kept.
                </Empty>
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
                      <summary className="flex cursor-pointer list-none items-center justify-between font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">
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
                        {by('in_progress')} active · {by('submitted')} in review · {by('pending')} waiting
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
                  <ul className="divide-y divide-line">
                    {tasks.map((t) => (
                      <motion.li layout key={t.id} className="flex flex-col gap-1 px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Pill tone={toneFor(t.status)}>{t.status.replace('_', ' ')}</Pill>
                          <span className="font-mono text-[11px] text-muted">{t.id}</span>
                          {t.owner && <span className="text-[12px] text-muted">· {t.owner}</span>}
                        </div>
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
                        {t.description && <div className="text-[12.5px] text-muted">{t.description}</div>}
                        {t.blockedBy.length > 0 && (
                          <div className="text-[11.5px] text-muted">after {t.blockedBy.join(', ')}</div>
                        )}
                      </motion.li>
                    ))}
                  </ul>
                </>
              ))}
            {tab === 'team' && (
              <ul className="divide-y divide-line">
                {agents.map((a) => {
                  const task = tasks.find((t) => t.owner === a.info.name && t.status === 'in_progress')
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
                          <div className="truncate font-mono text-[11.5px] text-muted">{a.info.model}</div>
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
                                <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">
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
                <div className="m-3 overflow-hidden rounded-xl border border-line bg-[#0b0f17] font-mono text-[12px] text-slate-200">
                  {[...shells].reverse().map((s) => (
                    <div key={s.id} className="border-b border-white/5 px-3.5 py-3 last:border-0">
                      <div className="flex items-center gap-2 text-[11px] text-slate-400">
                        <span>{s.agent}</span>
                        <span>·</span>
                        <span>{s.time.slice(11, 19)}</span>
                        <span className="flex-1" />
                        {s.ok === undefined ? (
                          <span className="text-work">running…</span>
                        ) : (
                          <span
                            className={
                              s.ok && /^exit 0/.test(s.output ?? '') ? 'text-emerald-400' : 'text-amber-400'
                            }
                          >
                            {(s.output ?? '').split('\n')[0]}
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 whitespace-pre-wrap break-all">
                        <span className="select-none text-emerald-400">$ </span>
                        {s.command}
                      </div>
                      {s.output && (
                        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-slate-400">
                          {s.output
                            .split('\n')
                            .slice(1)
                            .join('\n')
                            .replace(/--- (stdout|stderr)\n?/g, '')
                            .trim() || '(no output)'}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            {tab === 'mail' && <MailTab messages={messages} onInspect={setInspect} />}
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
                        {s.lead} {s.strong && <span className="font-semibold text-fg">{s.strong}</span>}{' '}
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
