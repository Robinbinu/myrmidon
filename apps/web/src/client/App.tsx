import {
  type ColonyState,
  expandCommand,
  foldColony,
  type MyrEvent,
  type PluginCommand,
  roundSlice,
} from '@myrmidon/protocol'
import {
  CircleAlert,
  LoaderCircle,
  MessageCircleQuestion,
  Network,
  PanelLeft,
  Phone,
  Plug,
  RefreshCw,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  type ChatRound,
  type ChatSummary,
  CONNECTION_CHANGED,
  type ColonySummary,
  type ModelOption,
  normalizeConfig,
  type Project,
  post,
  reachable,
  send as request,
  type TeamConfig,
} from './api.ts'
import { ColonyScreen } from './ColonyScreen.tsx'
import { Compare } from './Compare.tsx'
import { Composer, type ComposerHandle, type Delivery } from './chat/Composer.tsx'
import { allCommands, setPluginCommands } from './chat/commands.ts'
import { FolderPicker, ProjectPill } from './chat/FolderPicker.tsx'
import { Hero } from './chat/Hero.tsx'
import { ProjectPermissions } from './chat/ProjectPermissions.tsx'
import { isRunning, JumpToLatest, PendingRound, RoundView } from './chat/RoundView.tsx'
import { Sidebar, type View } from './chat/Sidebar.tsx'
import { Workspace } from './chat/Workspace.tsx'
import { copy } from './copy.ts'
import { useScope } from './DeviceGate.tsx'
import { SETTINGS_SAVED } from './mascot.ts'
import { syncPluginUI } from './plugins.tsx'
import { type Section, Settings } from './Settings.tsx'
import { SystemPage } from './System.tsx'
import { useStatus } from './status.tsx'
import {
  day,
  NOTIFY_KEY,
  useFollowLatest,
  useHotkeys,
  usePersistentFlag,
  useReduceMotion,
  useTheme,
} from './ui/hooks.ts'
import { Modal } from './ui/Modal.tsx'
import { isMac } from './ui/platform.ts'
import { Button, cn, IconButton, Pill, Select, toneFor } from './ui/primitives.tsx'
import { SplitDivider, useSplitWidth } from './ui/SplitDivider.tsx'
import { comboLabel } from './ui/shortcuts.ts'
import { runPhase } from './ui/status.ts'
import { useToast } from './ui/Toast.tsx'
import { Toolbar, ToolbarTitle } from './ui/Toolbar.tsx'
import { AGENT_MIN_WINDOW, CALL_LINES, MAX_FILE_BYTES, softSpring } from './ui-config.ts'
import { type ColonyView, useColony } from './use-colony.ts'
import { CallBar, type CallLine, setMicLevel } from './voice/CallBar.tsx'
import { CallCard, type SavedCall } from './voice/CallCard.tsx'
import { CallClient, type CallState } from './voice/call-client.ts'

const CONFIG_KEY = 'myr-team-config'

/** What the page needs to know about a plugin. */
interface PluginSummary {
  name: string
  enabled: boolean
  commands: PluginCommand[]
  ui?: string
  uiStamp?: string
}

/** `loaded` turns true with the first answer, so an empty list is not shown as "none yet" before anything came. */
function usePoll<T>(path: string, initial: T, ms: number): [T, () => void, string | undefined, boolean] {
  const [data, setData] = useState<T>(initial)
  const [error, setError] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const load = useCallback(() => {
    api<T>(path)
      .then((d) => {
        setData(d)
        setError(undefined)
        setLoaded(true)
      })
      .catch((err) => setError(String(err.message ?? err)))
  }, [path])
  useEffect(() => {
    load()
    const t = setInterval(load, ms)
    return () => clearInterval(t)
  }, [load, ms])
  return [data, load, error, loaded]
}

/** Whether the server is answering, kept current as requests succeed or fail. */
function useReachable(): boolean {
  const [on, setOn] = useState(reachable)
  useEffect(() => {
    const update = () => setOn(reachable())
    window.addEventListener(CONNECTION_CHANGED, update)
    return () => window.removeEventListener(CONNECTION_CHANGED, update)
  }, [])
  return on
}

/** A model that can lead a crew: any the person has not hidden whose window, when known, holds an agent. */
const canLead = (m: ModelOption) => !m.hidden && (m.contextWindow ?? AGENT_MIN_WINDOW) >= AGENT_MIN_WINDOW

function readLocalConfig(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) ?? '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Reads a file for the send request, which carries attachments as base64. */
async function encodeFile(file: File): Promise<{ name: string; data: string }> {
  if (file.size > MAX_FILE_BYTES) throw new Error(copy.app.fileTooLarge(file.name))
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
    lines.push(`## ${copy.app.export.round(round.round)}`, '')
    for (const m of state.chatMessages)
      lines.push(`**${m.from === 'user' ? copy.app.export.you : m.from}:**`, '', m.text, '')
    const from = info?.startSeq ?? 0
    const files = Object.entries(state.artifacts)
      .filter(([, v]) => v.some((x) => x.seq >= from && x.author !== 'user'))
      .map(([name]) => name)
    if (files.length) lines.push(copy.app.export.files(files.join(', ')), '')
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${
    chat.title
      .replace(/[^\w -]+/g, '')
      .trim()
      .slice(0, 60) || copy.app.export.fallbackName
  }.md`
  a.click()
  URL.revokeObjectURL(url)
}

/** A desktop notification while Myrmidon is in the background, if the person turned them on in Settings. */
function notify(text: string, chatId?: string, tag = chatId) {
  try {
    if (localStorage.getItem(NOTIFY_KEY) !== '1' || typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted' || !document.hidden) return
    const n = new Notification(copy.brand.name, { body: text, tag })
    n.onclick = () => {
      window.focus()
      if (!chatId) return
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
  const [reduceMotion, setReduceMotion] = useReduceMotion()
  const [chats, refreshChats, chatsError, chatsLoaded] = usePoll<ChatSummary[]>('/api/chats', [], 2500)
  const online = useReachable()
  const fullAccess = useScope() === 'full'
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelsError, setModelsError] = useState<string>()
  const [config, setConfig] = useState<TeamConfig>()
  const [view, setView] = useState<View>('chat')
  const [activeChat, setActiveChatState] = useState<string | undefined>(
    () => new URLSearchParams(location.search).get('chat') ?? undefined,
  )
  const [collapsed, setCollapsed] = usePersistentFlag('myr-sidebar-collapsed', false)
  const [workspaceOpen, setWorkspaceOpen] = usePersistentFlag('myr-workspace-open', true)
  const sidebarSplit = useSplitWidth('myr-sidebar-width', { min: 220, max: 360, initial: 260 })
  // Below the docking width the panel covers the chat, so it never reopens on its own there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on load
  useEffect(() => {
    if (window.innerWidth < 1280) setWorkspaceOpen(false)
  }, [])
  const [colonyModal, setColonyModal] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Plugins' commands join the slash menu and their UI fills its slots; a plugin switched or edited shows up here.
  const [pluginList] = usePoll<{ plugins: PluginSummary[] }>('/api/plugins', { plugins: [] }, 4000)
  useEffect(() => {
    setPluginCommands(pluginList.plugins.filter((p) => p.enabled).flatMap((p) => p.commands))
    void syncPluginUI(pluginList.plugins)
  }, [pluginList])
  const [settingsSection, setSettingsSection] = useState<Section>('general')
  // Ways out of Settings go through its guard, which asks first when hook edits are unsaved.
  const settingsGuard = useRef<(go: () => void) => void>(undefined)
  const leaveSettings = useCallback(
    (go: () => void) => (settingsGuard.current ? settingsGuard.current(go) : go()),
    [],
  )
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
        setModelsError(undefined)
        setConfig((current) => {
          if (current) return current
          const fallback = r.default ?? r.models[0]?.ref ?? ''
          const server = Object.fromEntries(
            Object.entries(r.defaults ?? {}).filter(([, v]) => v !== undefined),
          )
          return normalizeConfig({ ...server, ...readLocalConfig() }, fallback)
        })
      })
      // The message box's stand-in says so and offers to try again.
      .catch((err) => setModelsError(String(err.message ?? err)))
  }, [])

  useEffect(loadModels, [loadModels])

  const loadProjects = useCallback(() => {
    api<{ projects: Project[] }>('/api/projects')
      .then((r) => setProjects(r.projects))
      // With the server away the banner says so, and the list loads again once it is back.
      .catch((err) => reachable() && toast(String(err.message ?? err), 'error'))
  }, [toast])

  useEffect(loadProjects, [loadProjects])

  // What failed to load while the server was away loads once it answers again; the polls catch up by themselves.
  useEffect(() => {
    const back = () => {
      if (!reachable()) return
      loadProjects()
      if (!config) loadModels()
    }
    window.addEventListener(CONNECTION_CHANGED, back)
    return () => window.removeEventListener(CONNECTION_CHANGED, back)
  }, [config, loadModels, loadProjects])

  // Announce rounds that finish while the user is elsewhere.
  useEffect(() => {
    for (const c of chats) {
      const before = seen.current.get(c.chatId)
      if (before && isRunning(before) && !isRunning(c.status)) {
        const text =
          c.status === 'completed'
            ? copy.app.toasts.roundDone(c.title)
            : copy.app.toasts.roundEnded(c.title, c.status === 'stopped' ? copy.app.toasts.paused : c.status)
        toast(text, c.status === 'completed' ? 'success' : 'info')
        notify(text, c.chatId)
      }
      seen.current.set(c.chatId, c.status)
    }
  }, [chats, toast])

  // Someone new asking to talk to the crew on a channel: a toast to approve them from here, and a desktop notice.
  const { status } = useStatus()
  const knownRequests = useRef<Set<string>>(undefined)
  useEffect(() => {
    const waiting = status?.waiting
    if (!waiting) return
    const known = knownRequests.current
    knownRequests.current = new Set(waiting.map((w) => `${w.channel}/${w.id}`))
    // The requests already waiting when the page opened are on the Channels page; only new ones interrupt.
    if (!known) return
    for (const w of waiting) {
      if (known.has(`${w.channel}/${w.id}`)) continue
      const text = copy.channelRequest[w.kind](w.name, w.label)
      toast(text, 'info', {
        label: copy.channelRequest.approve,
        run: async () => {
          try {
            await post(`/api/channels/${w.channel}/approve`, { request: w.id })
            toast(copy.channelRequest.approved(w.name), 'success')
          } catch (err) {
            toast(String((err as Error).message ?? err), 'error')
          }
        },
      })
      notify(text, undefined, `channel-request-${w.channel}-${w.id}`)
    }
  }, [status?.waiting, toast])

  // A voice call from this window: its socket and audio live in the client, what the bar shows lives here.
  const callRef = useRef<CallClient>(undefined)
  const [call, setCall] = useState<{ state: CallState; lines: CallLine[]; muted: boolean }>()
  const [calls, setCalls] = useState<SavedCall[]>([])
  const [callsSeen, setCallsSeen] = useState(0)
  // The Call button shows only once voice calls are on in Settings → Voice.
  const [voiceOn, setVoiceOn] = useState(false)
  useEffect(() => {
    const load = () =>
      api<{ enabled?: boolean }>('/api/voice')
        .then((r) => setVoiceOn(r.enabled === true))
        .catch(() => setVoiceOn(false))
    void load()
    window.addEventListener(SETTINGS_SAVED, load)
    return () => window.removeEventListener(SETTINGS_SAVED, load)
  }, [])
  const callChat = activeChat
  // biome-ignore lint/correctness/useExhaustiveDependencies: callsSeen reloads the list after a call ends
  useEffect(() => {
    if (!callChat) return setCalls([])
    api<{ calls: SavedCall[] }>(`/api/chats/${callChat}/calls`)
      .then((r) => setCalls(r.calls))
      .catch(() => setCalls([]))
  }, [callChat, callsSeen])
  const startCall = async () => {
    if (callRef.current) return
    if (!window.isSecureContext || !navigator.mediaDevices) return toast(copy.call.insecure, 'error')
    const client = new CallClient(activeChat, {
      state: (state) => setCall((c) => c && { ...c, state }),
      line: (who, text) =>
        setCall((c) => c && { ...c, lines: [...c.lines, { who, text }].slice(-CALL_LINES) }),
      level: setMicLevel,
      chat: (id) => {
        setActiveChat(id)
        setView('chat')
        refreshChats()
      },
      task: (request) => toast(copy.call.started(request), 'info'),
      error: (message) => toast(message, 'error'),
      ended: () => {
        callRef.current = undefined
        setCall(undefined)
        setMicLevel(0)
        setCallsSeen((n) => n + 1)
      },
    })
    callRef.current = client
    setCall({ state: 'connecting', lines: [], muted: false })
    try {
      await client.start()
    } catch (err) {
      toast((err as Error).name === 'NotAllowedError' ? copy.call.noMic : (err as Error).message, 'error')
      client.hangUp()
    }
  }

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
  const waiting = !!pending && (pending.chatId ?? undefined) === (chat?.chatId ?? pending.chatId)
  /** A chat link (`?chat=`) whose chat is not in the list once it has loaded. */
  const missing = !!activeChat && chatsLoaded && !chat && !waiting

  const openSettings = (section: Section) => {
    if (!fullAccess) return toast(copy.app.chatsOnly, 'info')
    setSettingsSection(section)
    setSettingsOpen(true)
  }

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
    (project?: string) =>
      leaveSettings(() => {
        setNewProject(project)
        setActiveChat(undefined)
        setView('chat')
        setSettingsOpen(false)
        requestAnimationFrame(() => composer.current?.focus())
      }),
    [setActiveChat, leaveSettings],
  )

  useHotkeys([
    { combo: 'mod+k', run: () => newTask(), inInputs: true },
    { combo: 'mod+n', run: () => newTask(), inInputs: true },
    { combo: '/', run: () => composer.current?.focus() },
    { combo: 'mod+b', run: () => setCollapsed(!collapsed), inInputs: true },
    {
      combo: 'mod+,',
      run: () => (fullAccess ? setSettingsOpen(true) : toast(copy.app.chatsOnly, 'info')),
      inInputs: true,
    },
    // With a chat's workspace on screen, it takes ⌘J itself (it knows whether its panel is showing).
    ...(!settingsOpen && view === 'chat' && chat
      ? []
      : [{ combo: 'mod+j', run: () => setWorkspaceOpen(!workspaceOpen), inInputs: true }]),
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
      toast(copy.app.toasts.chooseLeadModel, 'error')
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
        toast(delivery === 'queue' ? copy.app.toasts.queued : copy.app.toasts.steering, 'info')
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
      toast(model ? copy.app.toasts.continuingOnNewModel : copy.app.toasts.resuming, 'info')
      refreshChats()
    } catch (err) {
      toast(String((err as Error).message ?? err), 'error')
    }
  }

  /** Slash commands from the composer (the ones it does not handle itself). */
  /** Asks a reviewer to read the open chat for a skill worth keeping; the proposal appears as a card in the chat. */
  const learn = async () => {
    if (!activeChat) return toast(copy.app.toasts.openChatToLearn, 'info')
    toast(copy.app.toasts.learning, 'info')
    try {
      const r = await post<{ proposal: { name: string } | null }>(`/api/chats/${activeChat}/learn`, {})
      toast(
        r.proposal ? copy.app.toasts.learned(r.proposal.name) : copy.app.toasts.nothingToLearn,
        r.proposal ? 'success' : 'info',
      )
    } catch (err) {
      toast(String((err as Error).message), 'error')
    }
  }

  const command = async (name: string, arg: string) => {
    const last = chat?.rounds.at(-1)
    switch (name) {
      case 'learn':
        return learn()
      case 'plan':
        return send(arg, activeChat, 'steer', [], true)
      case 'steer':
      case 'queue':
        if (!running) {
          toast(copy.app.toasts.notRunningSendNormally, 'info')
          throw new Error('not running')
        }
        return send(arg, activeChat, name)
      case 'stop':
        return running ? stop() : toast(copy.app.toasts.notRunning, 'info')
      case 'resume':
        return resume()
      case 'retry':
        if (!last || running)
          return toast(running ? copy.app.toasts.stillRunning : copy.app.toasts.nothingToRetry, 'info')
        return send(last.request).catch(() => {})
      case 'new':
        return newTask()
      case 'rename':
        if (!activeChat) return toast(copy.app.toasts.openChatToRename, 'info')
        await request('PATCH', `/api/chats/${activeChat}`, { title: arg })
        refreshChats()
        return toast(copy.app.toasts.renamed, 'success')
      case 'mode':
        if (!config || (arg !== 'orchestrated' && arg !== 'swarm')) {
          toast(copy.app.toasts.modeUsage, 'error')
          throw new Error('bad mode')
        }
        updateConfig(normalizeConfig({ ...config, mode: arg }, config.leadModel))
        return toast(
          arg === 'swarm' ? copy.app.toasts.modeSwarm : copy.app.toasts.modeOrchestrated,
          'success',
        )
      case 'model': {
        const q = arg.toLowerCase()
        const found =
          models.find((m) => m.ref.toLowerCase() === q) ??
          models.find((m) => m.name.toLowerCase().includes(q) || m.ref.toLowerCase().includes(q))
        if (!config || !found) {
          toast(copy.app.toasts.noModelMatches(arg), 'error')
          throw new Error('no model')
        }
        updateConfig({ ...config, leadModel: found.ref })
        // A running round switches now, from each agent's next step; later rounds start on it too.
        if (chat && running) {
          const r = await request<{ switched: string[] }>('POST', `/api/chats/${chat.chatId}/model`, {
            model: found.ref,
          })
          return toast(copy.app.toasts.modelSwitched(r.switched.join(', '), found.name), 'success')
        }
        return toast(copy.app.toasts.leadModel(found.name), 'success')
      }
      case 'thinking': {
        if (!config || !['low', 'medium', 'high', 'auto'].includes(arg)) {
          toast(copy.app.toasts.thinkingUsage, 'error')
          throw new Error('bad thinking')
        }
        const { thinking: _old, ...rest } = config
        updateConfig(arg === 'auto' ? rest : { ...rest, thinking: arg as 'low' | 'medium' | 'high' })
        return toast(
          arg === 'auto' ? copy.app.toasts.thinkingAuto : copy.app.toasts.thinkingLevel(arg),
          'success',
        )
      }
      case 'export':
        return chat ? exportChat(chat) : toast(copy.app.toasts.openChatToExport, 'info')
      case 'mcp':
      case 'settings':
        return leaveSettings(() => openSettings(name === 'mcp' ? 'tools' : 'general'))
      default: {
        const fromPlugin = allCommands().find((c) => c.name === name && c.prompt !== undefined)
        if (fromPlugin?.prompt !== undefined) return send(expandCommand({ prompt: fromPlugin.prompt }, arg))
      }
    }
  }

  const stop = () => {
    if (!activeChat) return
    post(`/api/chats/${activeChat}/stop`, {})
      .then(() => {
        toast(copy.app.toasts.stopping, 'info')
        refreshChats()
      })
      .catch((err) => toast(String(err.message ?? err), 'error'))
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await request('DELETE', `/api/chats/${deleting.chatId}`)
      toast(copy.app.toasts.deleted(deleting.title), 'success')
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
      loaded={chatsLoaded}
      activeChat={activeChat}
      view={view}
      theme={theme}
      onTheme={setTheme}
      onSelect={(id) =>
        leaveSettings(() => {
          setActiveChat(id)
          setView('chat')
          setSettingsOpen(false)
        })
      }
      onNew={() => newTask()}
      projects={projects}
      onNewInProject={(p) => newTask(p.id)}
      // A chats-only device works in the projects there are; adding, changing or removing them is not for it.
      {...(fullAccess
        ? {
            onAddProject: () => setPicking(true),
            onProjectPermissions: setPermissionsFor,
            onRemoveProject: async (p: Project) => {
              try {
                const r = await request<{ projects: Project[] }>('DELETE', `/api/projects/${p.id}`)
                setProjects(r.projects)
                if (newProject === p.id) setNewProject(undefined)
                toast(copy.app.toasts.projectRemoved(p.name), 'info')
              } catch (err) {
                toast(String((err as Error).message ?? err), 'error')
              }
            },
          }
        : {})}
      onView={(v) =>
        leaveSettings(() => {
          setView(v)
          setSettingsOpen(false)
        })
      }
      onSettings={() => (fullAccess ? setSettingsOpen(true) : toast(copy.app.chatsOnly, 'info'))}
      onGateways={() => leaveSettings(() => openSettings('gateways'))}
      onCollapse={() => setCollapsed(true)}
    />
  )

  const title =
    view === 'chat'
      ? (chat?.title ?? (missing ? copy.app.chatNotFound.title : copy.app.titles.newTask))
      : view === 'colonies'
        ? copy.app.titles.crews
        : view === 'system'
          ? copy.system.title
          : copy.app.titles.compare

  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'user'}>
      {/* The shell is exactly one viewport tall; only inner panels scroll, so the message box never leaves the screen. */}
      <div className="flex h-dvh overflow-hidden bg-bg text-fg">
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              key="sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: sidebarSplit.width, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={sidebarSplit.dragging ? { duration: 0 } : softSpring}
              className="shrink-0 overflow-hidden"
            >
              {sidebar}
            </motion.div>
          )}
        </AnimatePresence>
        {!collapsed && <SplitDivider split={sidebarSplit} side="left" label={copy.app.resizeSidebar} />}

        <main className="flex min-w-0 flex-1 flex-col bg-surface">
          {settingsOpen ? (
            <Settings
              key={settingsSection}
              initialSection={settingsSection}
              guard={settingsGuard}
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
              <Toolbar inset={collapsed}>
                {collapsed && (
                  <IconButton
                    label={copy.app.showSidebar}
                    title={copy.app.showSidebarTitle(comboLabel('mod+b', isMac))}
                    onClick={() => setCollapsed(false)}
                  >
                    <PanelLeft className="size-4" />
                  </IconButton>
                )}
                {collapsed && (
                  <IconButton
                    label={copy.app.newTask}
                    title={copy.app.newTaskTitle(comboLabel('mod+n', isMac))}
                    onClick={() => newTask()}
                  >
                    <SquarePen className="size-4" />
                  </IconButton>
                )}
                <ToolbarTitle>
                  <motion.span
                    key={title}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="truncate"
                  >
                    {title}
                  </motion.span>
                  {view === 'chat' && chat && (
                    <Pill tone={toneFor(runPhase(chat))}>{copy.status.run[runPhase(chat)]}</Pill>
                  )}
                </ToolbarTitle>
                {view === 'chat' && voiceOn && !call && (
                  <Button
                    variant="toolbar"
                    size="sm"
                    icon={<Phone className="size-4" />}
                    onClick={() => void startCall()}
                    title={copy.call.startTitle}
                  >
                    {copy.call.start}
                  </Button>
                )}
                {view === 'chat' && chat && (
                  <Button
                    variant="toolbar"
                    size="sm"
                    icon={<Network className="size-4" />}
                    onClick={() => {
                      const latest = chat.rounds.at(-1)
                      if (latest) setColonyModal(latest.colonyId)
                    }}
                    title={copy.app.crewButtonTitle}
                  >
                    {copy.app.crewButton}
                  </Button>
                )}
              </Toolbar>
              <AnimatePresence>
                {call && (
                  <CallBar
                    key="call"
                    state={call.state}
                    lines={call.lines}
                    muted={call.muted}
                    onMute={(muted) => {
                      callRef.current?.mute(muted)
                      setCall((c) => c && { ...c, muted })
                    }}
                    onHangUp={() => callRef.current?.hangUp()}
                  />
                )}
              </AnimatePresence>
              {!online ? (
                <div
                  role="status"
                  className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-body text-fg-2"
                >
                  <LoaderCircle className="size-3.5 animate-spin text-muted" />
                  {copy.app.reconnecting}
                </div>
              ) : (
                chatsError && (
                  <div className="shrink-0 bg-bad-soft px-4 py-2 text-body text-bad-ink">{chatsError}</div>
                )
              )}

              {view === 'chat' &&
                (() => {
                  if (missing)
                    return (
                      <PaneNotice
                        icon={<MessageCircleQuestion className="size-6 text-muted" />}
                        title={copy.app.chatNotFound.title}
                        body={copy.app.chatNotFound.body}
                        action={{
                          label: copy.app.chatNotFound.action,
                          icon: <SquarePen className="size-3.5" />,
                          run: () => newTask(),
                        }}
                      />
                    )
                  // A chat link waits for the chat list rather than showing the entry page meanwhile.
                  if (activeChat && !chat && !waiting)
                    return chatsError ? (
                      <PaneNotice
                        icon={<CircleAlert className="size-6 text-bad-ink" />}
                        title={copy.app.chatFailed}
                        body={chatsError}
                        action={{
                          label: copy.app.composer.retry,
                          icon: <RefreshCw className="size-3.5" />,
                          run: refreshChats,
                        }}
                      />
                    ) : (
                      <div className="flex-1" />
                    )
                  const box = config ? (
                    <Composer
                      ref={composer}
                      models={models}
                      config={config}
                      onConfig={updateConfig}
                      running={running}
                      busy={busy}
                      centered={!chat}
                      onTextChange={setDraft}
                      status={running ? copy.app.composer.status : undefined}
                      placeholder={
                        chat
                          ? `${
                              running
                                ? chat.rounds.at(-1)?.swarm
                                  ? copy.app.composer.messagePeers
                                  : copy.app.composer.messageLead
                                : copy.app.composer.followUp
                            }${chat.crew?.length ? copy.app.composer.mentionHint : ''}`
                          : copy.app.composer.newTask
                      }
                      onSend={(t, delivery, files) => send(t, activeChat, delivery, files)}
                      {...(chat?.crew ? { crew: chat.crew } : {})}
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
                            {...(fullAccess ? { onAdd: () => setPicking(true) } : {})}
                          />
                        )
                      }
                    />
                  ) : (
                    <ComposerPending
                      centered={!chat}
                      {...(modelsError ? { error: modelsError } : {})}
                      onRetry={loadModels}
                    />
                  )
                  return chat || waiting ? (
                    <>
                      <Transcript
                        {...(chat ? { chat } : {})}
                        calls={calls}
                        onOpenColony={setColonyModal}
                        onRetry={(t) => void send(t).catch(() => {})}
                        onLearn={() => void learn()}
                        onAnswer={(t) => send(t)}
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
                      news={chats.map((c) => `${c.chatId}:${c.status}:${c.awaiting ? 1 : 0}`).join('|')}
                      onPick={(t) => composer.current?.fill(t)}
                    >
                      {config && !models.some(canLead) && (
                        <SetupCard {...(fullAccess ? { onConnect: () => openSettings('models') } : {})} />
                      )}
                      {box}
                    </Hero>
                  )
                })()}
              {view === 'colonies' && <ColoniesPane />}
              {view === 'compare' && <ComparePane onOpen={setColonyModal} />}
              {view === 'system' && (
                <SystemPage
                  onManageChannels={() => openSettings('channels')}
                  onOpenChat={(id) => {
                    setActiveChat(id)
                    setView('chat')
                  }}
                />
              )}
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
            title={copy.app.deleteChat.title}
            onClose={() => !deleteBusy && setDeleting(undefined)}
            size="sm"
          >
            <div className="flex flex-col gap-4">
              <p className="text-title leading-relaxed text-fg-2">
                <span className="font-semibold text-fg">
                  {copy.app.deleteChat.quotedTitle(deleting.title)}
                </span>
                {copy.app.deleteChat.body(deleting.rounds.length)}
              </p>
              {isRunning(deleting.status) && (
                <p className="rounded-xl bg-warn-soft px-3 py-2 text-body text-warn-ink">
                  {copy.app.deleteChat.stillRunning}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDeleting(undefined)} disabled={deleteBusy}>
                  {copy.app.deleteChat.cancel}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void confirmDelete()}
                  disabled={deleteBusy}
                  icon={<Trash2 className="size-3.5" />}
                >
                  {deleteBusy ? copy.app.deleteChat.deleting : copy.app.deleteChat.confirm}
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
              // The open chat stays open; a new task about to start works in the folder just added.
              if (!activeChat) setNewProject(p.id)
            }}
          />
        )}
        {colonyModal && (
          <Modal
            key="colony"
            title={copy.app.crewConsole}
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

/**
 * On the entry page while no model can lead: where to connect one, instead of a picker with nothing in it. Without
 * `onConnect` (a chats-only device, which cannot open Settings) it says who can.
 */
function SetupCard(props: { onConnect?(): void }) {
  const t = copy.app.setup
  return (
    <div className="mb-3 flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-pop">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg">
        <Plug className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-reading font-semibold">{t.title}</p>
        <p className="text-callout leading-snug text-muted">{props.onConnect ? t.body : t.askOwner}</p>
      </div>
      {props.onConnect && (
        <Button variant="primary" onClick={props.onConnect}>
          {t.action}
        </Button>
      )}
    </div>
  )
}

/** The message box's place while the models it offers load, or why they did not, with a way to try again. */
function ComposerPending(props: { centered: boolean; error?: string; onRetry(): void }) {
  const t = copy.app.composer
  return (
    <div className={cn('shrink-0', props.centered ? 'w-full' : 'px-6 pb-4 pt-2')}>
      <div
        aria-busy={!props.error}
        className="mx-auto flex max-w-[820px] items-center gap-2.5 rounded-[26px] border border-line-strong bg-surface px-5 py-4 text-title text-muted shadow-pop"
      >
        {props.error ? (
          <CircleAlert className="size-4 shrink-0 text-bad-ink" />
        ) : (
          <LoaderCircle className="size-4 shrink-0 animate-spin" />
        )}
        <span className="flex-1">{props.error ? t.failed : t.loading}</span>
        {props.error && (
          <Button variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={props.onRetry}>
            {t.retry}
          </Button>
        )}
      </div>
    </div>
  )
}

/** In place of a pane that cannot show: a chat link to a chat this gateway lacks, or a list that would not load. */
function PaneNotice(props: {
  icon: ReactNode
  title: string
  body: string
  action?: { label: string; icon: ReactNode; run(): void }
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
      {props.icon}
      <div>
        <p className="text-[15px] font-semibold">{props.title}</p>
        <p className="text-body text-muted">{props.body}</p>
      </div>
      {props.action && (
        <Button variant="primary" icon={props.action.icon} onClick={props.action.run}>
          {props.action.label}
        </Button>
      )}
    </div>
  )
}

function Transcript(props: {
  chat?: ChatSummary
  onOpenColony(id: string): void
  onRetry(text: string): void
  /** Asks for a skill to be learned from this chat. */
  onLearn(): void
  onAnswer(text: string): Promise<unknown>
  onResume(model?: string): Promise<void>
  models: ModelOption[]
  /** A message is on its way to the server; retry stays disabled until it lands. */
  sending: boolean
  /** A request whose round has not started yet. */
  pending?: string
  /** Voice calls in this chat: each shows before the first round it started, the rest at the end. */
  calls: readonly SavedCall[]
}) {
  const running = !!props.chat && isRunning(props.chat.status)
  const rounds = props.chat?.rounds ?? []
  const startsAt = (c: SavedCall, r: ChatRound) =>
    c.rounds[0]?.colonyId === r.colonyId && (c.rounds[0]?.round ?? r.round) === r.round
  const loose = props.calls.filter((c) => !rounds.some((r) => startsAt(c, r)))
  const pane = useFollowLatest<HTMLDivElement>(props.chat?.chatId)
  return (
    <div ref={pane.ref} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto flex max-w-[820px] flex-col gap-8 p-6">
        {colonies(rounds).map((group, g) => (
          <ColonyRounds
            key={group.colonyId}
            colonyId={group.colonyId}
            rounds={group.rounds}
            first={g === 0}
            render={(colony, r) => (
              <>
                {props.calls
                  .filter((c) => startsAt(c, r))
                  .map((c) => (
                    <CallCard key={c.id} call={c} />
                  ))}
                <RoundView
                  colonyId={r.colonyId}
                  colony={colony}
                  round={r.round}
                  onOpenColony={props.onOpenColony}
                  onRetry={props.onRetry}
                  onLearn={props.onLearn}
                  onAnswer={props.onAnswer}
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
              </>
            )}
          />
        ))}
        {loose.map((c) => (
          <CallCard key={c.id} call={c} />
        ))}
        {props.pending && (
          <div className={cn(rounds.length > 0 && 'border-t border-line pt-8')}>
            <PendingRound text={props.pending} />
          </div>
        )}
      </div>
      <JumpToLatest follow={pane} />
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
  const [colonies, , error, loaded] = usePoll<ColonySummary[]>('/api/colonies', [], 4000)
  const [selected, setSelected] = useState<string>()
  const active = selected ?? colonies[0]?.id
  if (!loaded)
    return error ? (
      <PaneNotice
        icon={<CircleAlert className="size-6 text-bad-ink" />}
        title={copy.app.crewsFailed}
        body={error}
      />
    ) : (
      <div className="flex-1" />
    )
  if (!active) return <div className="flex-1 p-10 text-center text-muted">{copy.app.noCrews}</div>
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
        <Select
          value={active}
          onChange={(e) => setSelected(e.target.value)}
          aria-label={copy.app.crewSelect}
          className="max-w-full"
        >
          {colonies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {copy.status.run[runPhase(c)]} · {day(c.createdAt, true)}
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
