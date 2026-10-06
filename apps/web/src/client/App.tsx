import { Network, PanelLeft, PanelRight, Trash2 } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  type ChatSummary,
  type ColonySummary,
  type ModelOption,
  post,
  send as request,
  type TeamConfig,
} from './api.ts'
import { ColonyScreen } from './ColonyScreen.tsx'
import { Compare } from './Compare.tsx'
import { Composer, type ComposerHandle } from './chat/Composer.tsx'
import { Hero } from './chat/Hero.tsx'
import { isRunning, RoundView } from './chat/RoundView.tsx'
import { Sidebar, type View } from './chat/Sidebar.tsx'
import { Workspace } from './chat/Workspace.tsx'
import { Settings } from './Settings.tsx'
import { useHotkeys, usePersistentFlag, useTheme } from './ui/hooks.ts'
import { Modal } from './ui/Modal.tsx'
import { Button, cn, IconButton, Pill, Select, softSpring, toneFor } from './ui/primitives.tsx'
import { useToast } from './ui/Toast.tsx'

const CONFIG_KEY = 'myr-team-config'

function usePoll<T>(path: string, initial: T, ms: number): [T, () => void, string | undefined] {
  const [data, setData] = useState<T>(initial)
  const [error, setError] = useState<string>()
  const load = useCallback(() => {
    api<T>(path)
      .then((d) => {
        setData(d)
        setError(undefined)
      })
      .catch((err) => setError(String(err.message ?? err)))
  }, [path])
  useEffect(() => {
    load()
    const t = setInterval(load, ms)
    return () => clearInterval(t)
  }, [load, ms])
  return [data, load, error]
}

function readLocalConfig(): Partial<TeamConfig> {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) ?? '{}') as Partial<TeamConfig>
  } catch {
    return {}
  }
}

export function App() {
  const toast = useToast()
  const [theme, setTheme] = useTheme()
  const [reduceMotion, setReduceMotion] = usePersistentFlag('myr-reduce-motion', false)
  const [chats, refreshChats, chatsError] = usePoll<ChatSummary[]>('/api/chats', [], 2500)
  const [models, setModels] = useState<ModelOption[]>([])
  const [config, setConfig] = useState<TeamConfig>()
  const [view, setView] = useState<View>('chat')
  const [activeChat, setActiveChatState] = useState<string | undefined>(
    () => new URLSearchParams(location.search).get('chat') ?? undefined,
  )
  const [collapsed, setCollapsed] = usePersistentFlag('myr-sidebar-collapsed', false)
  const [workspaceOpen, setWorkspaceOpen] = usePersistentFlag('myr-workspace-open', true)
  const [mobileNav, setMobileNav] = useState(false)
  const [colonyModal, setColonyModal] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleting, setDeleting] = useState<ChatSummary>()
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [typing, setTyping] = useState(false)
  const composer = useRef<ComposerHandle>(null)
  const seen = useRef(new Map<string, string>())

  const setActiveChat = useCallback((id: string | undefined) => {
    setActiveChatState(id)
    const url = new URL(location.href)
    if (id) url.searchParams.set('chat', id)
    else url.searchParams.delete('chat')
    history.replaceState(null, '', url)
  }, [])

  const loadModels = useCallback(() => {
    api<{ models: ModelOption[]; default?: string; defaults?: Partial<TeamConfig> }>('/api/models?hidden=1')
      .then((r) => {
        setModels(r.models)
        setConfig((current) => {
          if (current) return current
          const fallback = r.default ?? r.models[0]?.ref ?? ''
          const server = r.defaults ?? {}
          return {
            mode: 'auto',
            workers: 3,
            leadModel: fallback,
            workerModel: server.workerModel ?? fallback,
            judgeModel: server.judgeModel ?? fallback,
            ...Object.fromEntries(Object.entries(server).filter(([, v]) => v !== undefined)),
            ...readLocalConfig(),
          } as TeamConfig
        })
      })
      .catch((err) => toast(String(err.message ?? err), 'error'))
  }, [toast])

  useEffect(loadModels, [loadModels])

  // Announce rounds that finish while the user is elsewhere.
  useEffect(() => {
    for (const c of chats) {
      const before = seen.current.get(c.chatId)
      if (before && isRunning(before) && !isRunning(c.status)) {
        toast(
          c.status === 'completed'
            ? `“${c.title}” is done and verified`
            : `“${c.title}” ${c.status === 'stopped' ? 'paused' : c.status}`,
          c.status === 'completed' ? 'success' : 'info',
        )
      }
      seen.current.set(c.chatId, c.status)
    }
  }, [chats, toast])

  const updateConfig = (c: TeamConfig) => {
    setConfig(c)
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(c))
    } catch {
      // Preferences are a convenience; private mode simply forgets them.
    }
  }

  const chat = chats.find((c) => c.chatId === activeChat)
  const running = !!chat && isRunning(chat.status)

  const newTask = useCallback(() => {
    setActiveChat(undefined)
    setView('chat')
    setSettingsOpen(false)
    setMobileNav(false)
    requestAnimationFrame(() => composer.current?.focus())
  }, [setActiveChat])

  useHotkeys([
    { combo: 'mod+k', run: newTask, inInputs: true },
    { combo: '/', run: () => composer.current?.focus() },
    { combo: 'mod+b', run: () => setCollapsed(!collapsed), inInputs: true },
    { combo: 'mod+j', run: () => setWorkspaceOpen(!workspaceOpen), inInputs: true },
    { combo: 'mod+,', run: () => setSettingsOpen(true), inInputs: true },
  ])

  const send = async (text: string, chatId = activeChat) => {
    if (!config) return
    if (!config.leadModel) {
      toast('Choose a lead model first', 'error')
      throw new Error('no model')
    }
    setBusy(true)
    try {
      const r = await post<{ chatId: string; colonyId: string; started: boolean }>('/api/chats', {
        text,
        config,
        chatId,
      })
      setActiveChat(r.chatId)
      setView('chat')
      if (!r.started) toast('Sent to the lead', 'info')
      refreshChats()
    } catch (err) {
      toast(String((err as Error).message ?? err), 'error')
      throw err
    } finally {
      setBusy(false)
    }
  }

  const stop = () => {
    if (!activeChat) return
    post(`/api/chats/${activeChat}/stop`, {})
      .then(() => {
        toast('Stopping the colony…', 'info')
        refreshChats()
      })
      .catch((err) => toast(String(err.message ?? err), 'error'))
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await request('DELETE', `/api/chats/${deleting.chatId}`)
      toast(`Deleted “${deleting.title}”`, 'success')
      if (deleting.chatId === activeChat) newTask()
      setDeleting(undefined)
      refreshChats()
    } catch (err) {
      toast(String((err as Error).message ?? err), 'error')
    } finally {
      setDeleteBusy(false)
    }
  }

  const sidebar = (
    <Sidebar
      onDelete={setDeleting}
      onRename={async (c, title) => {
        try {
          await request('PATCH', `/api/chats/${c.chatId}`, { title })
          refreshChats()
        } catch (err) {
          toast(String((err as Error).message ?? err), 'error')
        }
      }}
      chats={chats}
      activeChat={activeChat}
      view={view}
      theme={theme}
      onTheme={setTheme}
      onSelect={(id) => {
        setActiveChat(id)
        setView('chat')
        setSettingsOpen(false)
        setMobileNav(false)
      }}
      onNew={newTask}
      onView={(v) => {
        setView(v)
        setSettingsOpen(false)
        setMobileNav(false)
      }}
      onSettings={() => {
        setSettingsOpen(true)
        setMobileNav(false)
      }}
      onCollapse={() => (window.innerWidth < 768 ? setMobileNav(false) : setCollapsed(true))}
    />
  )

  const title =
    view === 'chat' ? (chat?.title ?? 'New task') : view === 'colonies' ? 'Colonies' : 'Compare runs'

  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'user'}>
      {/* The shell is exactly one viewport tall; only inner panels scroll, so the message box never leaves the screen. */}
      <div className="flex h-dvh overflow-hidden bg-bg text-fg">
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              key="sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 272, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={softSpring}
              className="hidden shrink-0 overflow-hidden md:block"
            >
              {sidebar}
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {mobileNav && (
            <motion.div
              className="fixed inset-0 z-50 md:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <button
                type="button"
                aria-label="Close menu"
                className="absolute inset-0 bg-black/40"
                onClick={() => setMobileNav(false)}
              />
              <motion.div
                className="absolute inset-y-0 left-0 shadow-pop"
                initial={{ x: -280 }}
                animate={{ x: 0 }}
                exit={{ x: -280 }}
                transition={softSpring}
              >
                {sidebar}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <main className="flex min-w-0 flex-1 flex-col">
          {settingsOpen ? (
            <Settings
              onClose={() => setSettingsOpen(false)}
              theme={theme}
              onTheme={setTheme}
              reduceMotion={reduceMotion}
              onReduceMotion={setReduceMotion}
              models={models}
              onModelsChanged={loadModels}
              config={config}
              onConfig={updateConfig}
            />
          ) : (
            <>
              <header className="glass relative z-10 flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
                <IconButton
                  label="Toggle sidebar"
                  title="Toggle sidebar (⌘B)"
                  onClick={() => (window.innerWidth < 768 ? setMobileNav(true) : setCollapsed(!collapsed))}
                  className={cn(!collapsed && 'md:hidden')}
                >
                  <PanelLeft className="size-4" />
                </IconButton>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <motion.span
                    key={title}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="truncate text-[14.5px] font-semibold tracking-tight"
                  >
                    {title}
                  </motion.span>
                  {view === 'chat' && chat && (
                    <Pill tone={toneFor(running ? 'running' : chat.status)}>
                      {running ? 'working' : chat.status}
                    </Pill>
                  )}
                </div>
                {view === 'chat' && chat && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Network className="size-4" />}
                      onClick={() => {
                        const latest = chat.rounds.at(-1)
                        if (latest) setColonyModal(latest.colonyId)
                      }}
                      title="Colony console: agents, tool calls, tasks, replay"
                    >
                      <span className="hidden sm:inline">Colony</span>
                    </Button>
                    <IconButton
                      label="Toggle workspace"
                      title="Workspace (⌘J)"
                      active={workspaceOpen}
                      onClick={() => setWorkspaceOpen(!workspaceOpen)}
                    >
                      <PanelRight className="size-4" />
                    </IconButton>
                  </>
                )}
              </header>
              {chatsError && (
                <div className="shrink-0 bg-bad-soft px-4 py-2 text-[13px] text-bad">{chatsError}</div>
              )}

              {view === 'chat' &&
                (() => {
                  const box = config && (
                    <Composer
                      ref={composer}
                      models={models}
                      config={config}
                      onConfig={updateConfig}
                      running={running}
                      busy={busy}
                      centered={!chat}
                      onTextChange={(t) => setTyping(t.trim().length > 0)}
                      status={running ? 'Colony is working…' : undefined}
                      placeholder={
                        chat
                          ? running
                            ? 'Message the lead while it works…'
                            : 'Ask a follow-up or request changes…'
                          : 'Describe what you want done…'
                      }
                      onSend={(t) => send(t)}
                      onStop={stop}
                    />
                  )
                  return chat ? (
                    <>
                      <Transcript
                        chat={chat}
                        onOpenColony={setColonyModal}
                        onRetry={(t) => void send(t).catch(() => {})}
                        sending={busy}
                      />
                      {box}
                    </>
                  ) : (
                    <Hero typing={typing} onPick={(t) => composer.current?.fill(t)}>
                      {box}
                    </Hero>
                  )
                })()}
              {view === 'colonies' && <ColoniesPane />}
              {view === 'compare' && <ComparePane onOpen={setColonyModal} />}
            </>
          )}
        </main>

        <AnimatePresence>
          {!settingsOpen && view === 'chat' && chat && workspaceOpen && (
            <Workspace key="workspace" chat={chat} onClose={() => setWorkspaceOpen(false)} />
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {deleting && (
          <Modal
            key="delete"
            title="Delete chat?"
            onClose={() => !deleteBusy && setDeleting(undefined)}
            size="sm"
          >
            <div className="flex flex-col gap-4">
              <p className="text-[14px] leading-relaxed text-fg-2">
                <span className="font-semibold text-fg">“{deleting.title}”</span> and its{' '}
                {deleting.rounds.length === 1 ? 'round' : `${deleting.rounds.length} rounds`} will be
                permanently removed from this machine: messages, files, logs, and agent transcripts. This
                can’t be undone.
              </p>
              {isRunning(deleting.status) && (
                <p className="rounded-xl bg-warn-soft px-3 py-2 text-[13px] text-warn">
                  This chat is still running. It will be stopped first.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDeleting(undefined)} disabled={deleteBusy}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void confirmDelete()}
                  disabled={deleteBusy}
                  icon={<Trash2 className="size-3.5" />}
                >
                  {deleteBusy ? 'Deleting…' : 'Delete chat'}
                </Button>
              </div>
            </div>
          </Modal>
        )}
        {colonyModal && (
          <Modal
            key="colony"
            title="Colony console"
            onClose={() => setColonyModal(undefined)}
            size="full"
            flush
          >
            <ColonyScreen key={colonyModal} id={colonyModal} />
          </Modal>
        )}
      </AnimatePresence>
    </MotionConfig>
  )
}

function Transcript(props: {
  chat: ChatSummary
  onOpenColony(id: string): void
  onRetry(text: string): void
  /** A message is on its way to the server; retry stays disabled until it lands. */
  sending: boolean
}) {
  const running = isRunning(props.chat.status)
  const pane = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  // Follow new activity only while the reader is already at the bottom of the conversation.
  useEffect(() => {
    const el = pane.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })
  return (
    <div
      ref={pane}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
      }}
    >
      <div className="mx-auto flex max-w-[820px] flex-col gap-8 px-4 py-6 sm:px-6">
        {props.chat.rounds.map((r, i) => (
          <div key={r.colonyId} className={cn(i > 0 && 'border-t border-line pt-8')}>
            <RoundView
              colonyId={r.colonyId}
              onOpenColony={props.onOpenColony}
              onRetry={props.onRetry}
              retry={
                i === props.chat.rounds.length - 1 && !running
                  ? props.sending
                    ? 'starting'
                    : 'ready'
                  : 'hidden'
              }
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function ColoniesPane() {
  const [colonies] = usePoll<ColonySummary[]>('/api/colonies', [], 4000)
  const [selected, setSelected] = useState<string>()
  const active = selected ?? colonies[0]?.id
  if (!active) return <div className="flex-1 p-10 text-center text-muted">No colonies yet.</div>
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        <Select
          value={active}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="Colony"
          className="max-w-full"
        >
          {colonies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.status} · {c.createdAt?.slice(0, 16).replace('T', ' ')}
            </option>
          ))}
        </Select>
      </div>
      <ColonyScreen key={active} id={active} />
    </div>
  )
}

function ComparePane(props: { onOpen(id: string): void }) {
  const [colonies] = usePoll<ColonySummary[]>('/api/colonies', [], 5000)
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Compare colonies={colonies} onOpen={props.onOpen} />
    </div>
  )
}
