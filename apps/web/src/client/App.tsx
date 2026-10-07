import { type ColonyState, foldColony, type MyrEvent, roundSlice } from '@myrmidon/protocol'
import { Network, PanelLeft, PanelRight, Trash2 } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  type ChatRound,
  type ChatSummary,
  type ColonySummary,
  type ModelOption,
  normalizeConfig,
  type Project,
  post,
  send as request,
  type TeamConfig,
} from './api.ts'
import { ColonyScreen } from './ColonyScreen.tsx'
import { Compare } from './Compare.tsx'
import { Composer, type ComposerHandle, type Delivery } from './chat/Composer.tsx'
import { FolderPicker, ProjectPill } from './chat/FolderPicker.tsx'
import { Hero } from './chat/Hero.tsx'
import { ProjectPermissions } from './chat/ProjectPermissions.tsx'
import { isRunning, PendingRound, RoundView } from './chat/RoundView.tsx'
import { Sidebar, type View } from './chat/Sidebar.tsx'
import { Workspace } from './chat/Workspace.tsx'
import { Settings } from './Settings.tsx'
import { NOTIFY_KEY, useHotkeys, usePersistentFlag, useTheme } from './ui/hooks.ts'
import { Modal } from './ui/Modal.tsx'
import { Button, cn, IconButton, Pill, Select, softSpring, toneFor } from './ui/primitives.tsx'
import { useToast } from './ui/Toast.tsx'
import { type ColonyView, useColony } from './use-colony.ts'

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

function readLocalConfig(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) ?? '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024

/** Reads a file for the send request, which carries attachments as base64. */
async function encodeFile(file: File): Promise<{ name: string; data: string }> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 10 MB`)
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { name: file.name, data: btoa(binary) }
}

/** Downloads a chat as Markdown: each round's request, the colony's replies, and the files it delivered. */
async function exportChat(chat: ChatSummary) {
  const lines = [`# ${chat.title}`, '']
  const loaded = new Map<string, { state: ColonyState; events: MyrEvent[] }>()
  for (const round of chat.rounds) {
    let colony = loaded.get(round.colonyId)
    if (!colony) {
      const events = await api<MyrEvent[]>(`/api/colonies/${round.colonyId}/events?from=1&limit=20000`)
      colony = { events, state: foldColony(round.colonyId, events) }
      loaded.set(round.colonyId, colony)
    }
    const { state, info } = roundSlice(colony.state, colony.events, round.round)
    lines.push(`## Round ${round.round}`, '')
    for (const m of state.chatMessages)
      lines.push(`**${m.from === 'user' ? 'You' : m.from}:**`, '', m.text, '')
    const from = info?.startSeq ?? 0
    const files = Object.entries(state.artifacts)
      .filter(([, v]) => v.some((x) => x.seq >= from && x.author !== 'user'))
      .map(([name]) => name)
    if (files.length) lines.push(`Files: ${files.join(', ')}`, '')
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${
    chat.title
      .replace(/[^\w -]+/g, '')
      .trim()
      .slice(0, 60) || 'chat'
  }.md`
  a.click()
  URL.revokeObjectURL(url)
}

/** A desktop notification while Myrmidon is in the background, if the person turned them on in Settings. */
function notify(text: string, chatId: string) {
  try {
    if (localStorage.getItem(NOTIFY_KEY) !== '1' || typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted' || !document.hidden) return
    const n = new Notification('Myrmidon', { body: text, tag: chatId })
    n.onclick = () => {
      window.focus()
      const url = new URL(location.href)
      url.searchParams.set('chat', chatId)
      location.href = url.toString()
    }
  } catch {
    // Notifications are a convenience; a browser that refuses them just shows the toast.
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
  // Below the docking width the panel covers the chat, so it never reopens on its own there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on load
  useEffect(() => {
    if (window.innerWidth < 1280) setWorkspaceOpen(false)
  }, [])
  const [mobileNav, setMobileNav] = useState(false)
  const [colonyModal, setColonyModal] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<'general' | 'tools'>('general')
  const [deleting, setDeleting] = useState<ChatSummary>()
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  /** A request on its way: shown at once, until its round appears in the chat list. */
  const [pending, setPending] = useState<{
    text: string
    chatId?: string
    colonyId?: string
    round?: number
  }>()
  const [draft, setDraft] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  /** The project a new chat will work in. */
  const [newProject, setNewProject] = useState<string>()
  const [picking, setPicking] = useState(false)
  const [permissionsFor, setPermissionsFor] = useState<Project>()
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
    api<{ models: ModelOption[]; default?: string; defaults?: Record<string, unknown> }>(
      '/api/models?hidden=1',
    )
      .then((r) => {
        setModels(r.models)
        setConfig((current) => {
          if (current) return current
          const fallback = r.default ?? r.models[0]?.ref ?? ''
          const server = Object.fromEntries(
            Object.entries(r.defaults ?? {}).filter(([, v]) => v !== undefined),
          )
          return normalizeConfig({ ...server, ...readLocalConfig() }, fallback)
        })
      })
      .catch((err) => toast(String(err.message ?? err), 'error'))
  }, [toast])

  useEffect(loadModels, [loadModels])

  useEffect(() => {
    api<{ projects: Project[] }>('/api/projects')
      .then((r) => setProjects(r.projects))
      .catch((err) => toast(String(err.message ?? err), 'error'))
  }, [toast])

  // Announce rounds that finish while the user is elsewhere.
  useEffect(() => {
    for (const c of chats) {
      const before = seen.current.get(c.chatId)
      if (before && isRunning(before) && !isRunning(c.status)) {
        const text =
          c.status === 'completed'
            ? `“${c.title}” is done and verified`
            : `“${c.title}” ${c.status === 'stopped' ? 'paused' : c.status}`
        toast(text, c.status === 'completed' ? 'success' : 'info')
        notify(text, c.chatId)
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

  // The pending card gives way once the chat list shows the round it started.
  useEffect(() => {
    // A chat's rounds share a colony, so it is the round, not the colony, that shows the request arrived.
    if (
      pending?.colonyId &&
      chats.some((c) =>
        c.rounds.some(
          (r) =>
            r.colonyId === pending.colonyId && (pending.round === undefined || r.round === pending.round),
        ),
      )
    )
      setPending(undefined)
  }, [chats, pending])

  const newTask = useCallback(
    (project?: string) => {
      setNewProject(project)
      setActiveChat(undefined)
      setView('chat')
      setSettingsOpen(false)
      setMobileNav(false)
      requestAnimationFrame(() => composer.current?.focus())
    },
    [setActiveChat],
  )

  useHotkeys([
    { combo: 'mod+k', run: () => newTask(), inInputs: true },
    { combo: '/', run: () => composer.current?.focus() },
    { combo: 'mod+b', run: () => setCollapsed(!collapsed), inInputs: true },
    { combo: 'mod+j', run: () => setWorkspaceOpen(!workspaceOpen), inInputs: true },
    { combo: 'mod+,', run: () => setSettingsOpen(true), inInputs: true },
  ])

  const send = async (
    text: string,
    chatId = activeChat,
    delivery: Delivery = 'steer',
    files: readonly File[] = [],
    plan = false,
  ) => {
    if (!config) return
    if (!config.leadModel) {
      toast('Choose a lead model first', 'error')
      throw new Error('no model')
    }
    setBusy(true)
    const startsRound = !chat || !running
    if (startsRound) setPending({ text, ...(chatId ? { chatId } : {}) })
    try {
      const r = await post<{ chatId: string; colonyId: string; started: boolean; round?: number }>(
        '/api/chats',
        {
          text,
          config,
          chatId,
          delivery,
          ...(plan ? { plan: true } : {}),
          ...(!chatId && newProject ? { project: newProject } : {}),
          ...(files.length ? { attachments: await Promise.all(files.map(encodeFile)) } : {}),
        },
      )
      setActiveChat(r.chatId)
      setView('chat')
      if (r.started)
        setPending({ text, chatId: r.chatId, colonyId: r.colonyId, ...(r.round ? { round: r.round } : {}) })
      else {
        setPending(undefined)
        toast(delivery === 'queue' ? 'Queued until the current work is done' : 'Steering the colony', 'info')
      }
      refreshChats()
    } catch (err) {
      setPending(undefined)
      toast(String((err as Error).message ?? err), 'error')
      throw err
    } finally {
      setBusy(false)
    }
  }

  const resume = async (model?: string) => {
    if (!activeChat) return
    try {
      await post(`/api/chats/${activeChat}/resume`, model ? { model } : {})
      toast(model ? 'Continuing on the new model' : 'Resuming where it left off', 'info')
      refreshChats()
    } catch (err) {
      toast(String((err as Error).message ?? err), 'error')
    }
  }

  /** Slash commands from the composer (the ones it does not handle itself). */
  const command = async (name: string, arg: string) => {
    const last = chat?.rounds.at(-1)
    switch (name) {
      case 'plan':
        return send(arg, activeChat, 'steer', [], true)
      case 'steer':
      case 'queue':
        if (!running) {
          toast('Nothing is running; send it as a normal message', 'info')
          throw new Error('not running')
        }
        return send(arg, activeChat, name)
      case 'stop':
        return running ? stop() : toast('Nothing is running', 'info')
      case 'resume':
        return resume()
      case 'retry':
        if (!last || running) return toast(running ? 'Still running' : 'Nothing to retry yet', 'info')
        return send(last.request).catch(() => {})
      case 'new':
        return newTask()
      case 'rename':
        if (!activeChat) return toast('Open a chat to rename it', 'info')
        await request('PATCH', `/api/chats/${activeChat}`, { title: arg })
        refreshChats()
        return toast('Renamed', 'success')
      case 'mode':
        if (!config || (arg !== 'orchestrated' && arg !== 'swarm')) {
          toast('Use /mode orchestrated or /mode swarm', 'error')
          throw new Error('bad mode')
        }
        updateConfig(normalizeConfig({ ...config, mode: arg }, config.leadModel))
        return toast(
          arg === 'swarm' ? 'Swarm: equal peers' : 'Orchestrated: a lead with specialists',
          'success',
        )
      case 'model': {
        const q = arg.toLowerCase()
        const found =
          models.find((m) => m.ref.toLowerCase() === q) ??
          models.find((m) => m.name.toLowerCase().includes(q) || m.ref.toLowerCase().includes(q))
        if (!config || !found) {
          toast(`No model matches “${arg}”`, 'error')
          throw new Error('no model')
        }
        updateConfig({ ...config, leadModel: found.ref })
        // A running round switches now, from each agent's next step; later rounds start on it too.
        if (chat && running) {
          const r = await request<{ switched: string[] }>('POST', `/api/chats/${chat.chatId}/model`, {
            model: found.ref,
          })
          return toast(`${r.switched.join(', ')} now on ${found.name}, from the next step`, 'success')
        }
        return toast(`Lead model: ${found.name}`, 'success')
      }
      case 'thinking': {
        if (!config || !['low', 'medium', 'high', 'auto'].includes(arg)) {
          toast('Use /thinking low, medium, high, or auto', 'error')
          throw new Error('bad thinking')
        }
        const { thinking: _old, ...rest } = config
        updateConfig(arg === 'auto' ? rest : { ...rest, thinking: arg as 'low' | 'medium' | 'high' })
        return toast(
          arg === 'auto' ? 'Thinking: each role decides' : `Thinking: ${arg} for work rounds`,
          'success',
        )
      }
      case 'export':
        return chat ? exportChat(chat) : toast('Open a chat to export it', 'info')
      case 'mcp':
      case 'settings':
        setSettingsSection(name === 'mcp' ? 'tools' : 'general')
        return setSettingsOpen(true)
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
      onNew={() => newTask()}
      projects={projects}
      onNewInProject={(p) => newTask(p.id)}
      onAddProject={() => setPicking(true)}
      onProjectPermissions={setPermissionsFor}
      onRemoveProject={async (p) => {
        try {
          const r = await request<{ projects: Project[] }>('DELETE', `/api/projects/${p.id}`)
          setProjects(r.projects)
          if (newProject === p.id) setNewProject(undefined)
          toast(`Removed ${p.name} from projects; its folder and chats are untouched`, 'info')
        } catch (err) {
          toast(String((err as Error).message ?? err), 'error')
        }
      }}
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
                className="absolute inset-y-0 left-0 bg-bg shadow-pop"
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
              key={settingsSection}
              initialSection={settingsSection}
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
                  <IconButton
                    label="Workspace"
                    title="Workspace (⌘J)"
                    active={workspaceOpen}
                    onClick={() => setWorkspaceOpen(!workspaceOpen)}
                    className="md:hidden"
                  >
                    <PanelRight className="size-4" />
                  </IconButton>
                )}
                {view === 'chat' && chat && (
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
                      onTextChange={setDraft}
                      status={running ? 'Colony is working…' : undefined}
                      placeholder={
                        chat
                          ? running
                            ? chat.rounds.at(-1)?.swarm
                              ? 'Message the peers while they work…'
                              : 'Message the lead while it works…'
                            : 'Ask a follow-up or request changes…'
                          : 'Describe what you want done…'
                      }
                      onSend={(t, delivery, files) => send(t, activeChat, delivery, files)}
                      onCommand={command}
                      onStop={stop}
                      chatState={{ chat: !!chat, resumable: !!chat && chat.status === 'stopped' }}
                      project={
                        // A chat started without a project stays without one.
                        (!chat || chat.project) && (
                          <ProjectPill
                            projects={projects}
                            {...(chat?.project ? { fixed: chat.project } : {})}
                            {...(newProject ? { value: newProject } : {})}
                            onChange={setNewProject}
                            onAdd={() => setPicking(true)}
                          />
                        )
                      }
                    />
                  )
                  const waiting =
                    pending && (pending.chatId ?? undefined) === (chat?.chatId ?? pending.chatId)
                  return chat || waiting ? (
                    <>
                      <Transcript
                        {...(chat ? { chat } : {})}
                        onOpenColony={setColonyModal}
                        onRetry={(t) => void send(t).catch(() => {})}
                        onResume={resume}
                        models={models}
                        sending={busy}
                        {...(waiting && pending ? { pending: pending.text } : {})}
                      />
                      {box}
                    </>
                  ) : (
                    <Hero
                      draft={draft}
                      working={chats.filter((c) => isRunning(c.status)).length}
                      {...(chats[0]
                        ? { latest: { status: chats[0].status, updatedAt: chats[0].updatedAt } }
                        : {})}
                      onPick={(t) => composer.current?.fill(t)}
                    >
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
          {!settingsOpen && view === 'chat' && chat && (
            <Workspace key="workspace" chat={chat} open={workspaceOpen} onOpenChange={setWorkspaceOpen} />
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
        {permissionsFor && (
          <ProjectPermissions
            key="permissions"
            project={permissionsFor}
            onClose={() => setPermissionsFor(undefined)}
            onSaved={setProjects}
          />
        )}
        {picking && (
          <FolderPicker
            key="folders"
            onClose={() => setPicking(false)}
            onAdded={(p, all) => {
              setProjects(all)
              setPicking(false)
              newTask(p.id)
            }}
          />
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
  chat?: ChatSummary
  onOpenColony(id: string): void
  onRetry(text: string): void
  onResume(model?: string): Promise<void>
  models: ModelOption[]
  /** A message is on its way to the server; retry stays disabled until it lands. */
  sending: boolean
  /** A request whose round has not started yet. */
  pending?: string
}) {
  const running = !!props.chat && isRunning(props.chat.status)
  const rounds = props.chat?.rounds ?? []
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
        {colonies(rounds).map((group, g) => (
          <ColonyRounds
            key={group.colonyId}
            colonyId={group.colonyId}
            rounds={group.rounds}
            first={g === 0}
            render={(colony, r) => (
              <RoundView
                colonyId={r.colonyId}
                colony={colony}
                round={r.round}
                onOpenColony={props.onOpenColony}
                onRetry={props.onRetry}
                onResume={props.onResume}
                models={props.models}
                retry={
                  r === rounds.at(-1) && !running && !props.pending
                    ? props.sending
                      ? 'starting'
                      : 'ready'
                    : 'hidden'
                }
              />
            )}
          />
        ))}
        {props.pending && (
          <div className={cn(rounds.length > 0 && 'border-t border-line pt-8')}>
            <PendingRound text={props.pending} />
          </div>
        )}
      </div>
    </div>
  )
}

/** A chat's rounds grouped by the colony that ran them, in order: one colony for chats since rounds shared one. */
function colonies(rounds: readonly ChatRound[]): { colonyId: string; rounds: ChatRound[] }[] {
  const out: { colonyId: string; rounds: ChatRound[] }[] = []
  for (const r of rounds) {
    const last = out.at(-1)
    if (last?.colonyId === r.colonyId) last.rounds.push(r)
    else out.push({ colonyId: r.colonyId, rounds: [r] })
  }
  return out
}

/** Loads one colony's log once and shows each of its rounds from it. */
function ColonyRounds(props: {
  colonyId: string
  rounds: ChatRound[]
  first: boolean
  render(colony: ColonyView, round: ChatRound): ReactNode
}) {
  const colony = useColony(props.colonyId)
  return props.rounds.map((r, i) => (
    <div
      key={`${r.colonyId}:${r.round}`}
      className={cn((i > 0 || !props.first) && 'border-t border-line pt-8')}
    >
      {props.render(colony, r)}
    </div>
  ))
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
