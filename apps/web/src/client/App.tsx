import {
  type ColonyState,
  DEFAULT_PRESET,
  expandCommand,
  foldColony,
  type MyrEvent,
  type PermissionLevel,
  type PermissionPreset,
  type PluginCommand,
  roundSlice,
  type SetupStep,
} from '@myrmidon/protocol'
import {
  BarChart3,
  CircleAlert,
  Download,
  Folder,
  HeartPulse,
  LoaderCircle,
  MessageCircleQuestion,
  Network,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Settings as SettingsIcon,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { CommandPalette, type PaletteItem } from './CommandPalette.tsx'
import { Compare } from './Compare.tsx'
import { ComputerBanner, OPEN_SETTINGS_EVENT } from './ComputerUse.tsx'
import { ChatReadChips } from './chat/ApprovalCards.tsx'
import { Composer, type ComposerHandle, type Delivery } from './chat/Composer.tsx'
import { sidebarOrder, stepChat } from './chat/chat-order.ts'
import { allCommands, setPluginCommands } from './chat/commands.ts'
import { forgetDraft } from './chat/drafts.ts'
import { FolderPicker, ProjectPill } from './chat/FolderPicker.tsx'
import { Hero } from './chat/Hero.tsx'
import { useHeldDeletes } from './chat/held-deletes.ts'
import { canLead } from './chat/model-list.ts'
import { ProjectFiles } from './chat/ProjectFiles.tsx'
import { FullAccessBadge, ProjectPermissions } from './chat/ProjectPermissions.tsx'
import { isRunning, JumpToLatest, PendingRound, RoundView } from './chat/RoundView.tsx'
import { Sidebar, type View } from './chat/Sidebar.tsx'
import { Workspace } from './chat/Workspace.tsx'
import { copy } from './copy.ts'
import { useScope } from './DeviceGate.tsx'
import { SETTINGS_SAVED } from './mascot.ts'
import { ChatPermissions } from './permissions/ChatPermissions.tsx'
import { syncPluginUI } from './plugins.tsx'
import { SECTIONS, type Section, Settings } from './Settings.tsx'
import { SystemPage } from './System.tsx'
import { SetupNudge } from './setup/Nudge.tsx'
import { Setup } from './setup/Setup.tsx'
import {
  leftToSetUp,
  opensOnLoad,
  returnFromAddress,
  SETUP_PARAM,
  SETUP_RETURN_PARAM,
  type SetupReturn,
  type SetupScreen,
  type SetupView,
  type Starter,
} from './setup/state.ts'
import { useStatus } from './status.tsx'
import { useImportedThemes } from './themes/imported.ts'
import { desktop } from './ui/desktop.ts'
import { anyDialogOpen } from './ui/dialog.ts'
import {
  DOCK_BADGE_KEY,
  day,
  NOTIFY_KEY,
  readStored,
  useFollowLatest,
  useHotkeys,
  usePersistentFlag,
  useReduceMotion,
  useTheme,
} from './ui/hooks.ts'
import { FEATURE_ICONS } from './ui/icons.ts'
import { ContextMenuHost } from './ui/Menu.tsx'
import { isMac } from './ui/platform.ts'
import { Badge, Banner, Button, cn, Dot, IconButton, Select, toneFor } from './ui/primitives.tsx'
import { Sheet } from './ui/Sheet.tsx'
import { ShortcutList } from './ui/ShortcutList.tsx'
import { SplitDivider, useSplitWidth } from './ui/SplitDivider.tsx'
import { comboLabel, pressShortcut } from './ui/shortcuts.ts'
import { needsYou, runPhase } from './ui/status.ts'
import { useToast, useToastHandle } from './ui/Toast.tsx'
import { Toolbar, ToolbarTitle } from './ui/Toolbar.tsx'
import {
  CALL_HANG_UP_COMBO,
  CALL_LINES,
  CALL_MUTE_COMBO,
  DELETE_TITLES_SHOWN,
  MAX_FILE_BYTES,
  SETUP_HANDOFF_MS,
  softSpring,
  UNDO_DELETE_COMBO,
} from './ui-config.ts'
import { type ColonyView, useColony } from './use-colony.ts'
import { CallBar, type CallLine, setMicLevel } from './voice/CallBar.tsx'
import { CallCard, type SavedCall } from './voice/CallCard.tsx'
import { CallMenu, type CallTarget } from './voice/CallMenu.tsx'
import { CallClient, type CallState } from './voice/call-client.ts'

const CONFIG_KEY = 'myr-team-config'
/** When this browser last told the person about learned skills the curator archived. */
const SKILLS_ARCHIVED_SEEN_KEY = 'myr-skills-archived-seen'

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

/** The delete sheet's question: one chat by its title, several by how many with their titles listed. */
function DeleteChats(props: { chats: readonly ChatSummary[]; onCancel(): void; onConfirm(): void }) {
  const t = copy.app.deleteChat
  const [one] = props.chats
  const many = props.chats.length > 1
  const running = props.chats.filter((c) => isRunning(c.status)).length
  const listed = props.chats.slice(0, DELETE_TITLES_SHOWN)
  return (
    <div className="flex flex-col gap-4">
      {many || !one ? (
        <>
          <p className="text-title leading-relaxed text-fg-2">{t.bodyMany(props.chats.length)}</p>
          <ul className="flex flex-col gap-1 text-body text-fg">
            {listed.map((c) => (
              <li key={c.chatId} className="truncate font-medium">
                {t.quotedTitle(c.title)}
              </li>
            ))}
            {props.chats.length > listed.length && (
              <li className="text-muted">{t.andMore(props.chats.length - listed.length)}</li>
            )}
          </ul>
        </>
      ) : (
        <p className="text-title leading-relaxed text-fg-2">
          <span className="font-semibold text-fg">{t.quotedTitle(one.title)}</span>
          {t.body(one.rounds.length)}
        </p>
      )}
      {running > 0 && <Banner tone="warn">{many ? t.stillRunningMany(running) : t.stillRunning}</Banner>}
      <div className="flex justify-end gap-2">
        <Button variant="borderless" onClick={props.onCancel}>
          {t.cancel}
        </Button>
        <Button variant="destructive" onClick={props.onConfirm} icon={<Trash2 className="size-3.5" />}>
          {many ? t.confirmMany(props.chats.length) : t.confirm}
        </Button>
      </div>
    </div>
  )
}

/** A desktop notification while Myrmidon is in the background, if the person turned them on in Settings. */
function notify(text: string, chatId?: string, tag = chatId) {
  try {
    if (localStorage.getItem(NOTIFY_KEY) !== '1') return
    // The desktop app posts a native notification; its window is in the background when it lacks focus.
    const shell = desktop()
    if (shell) {
      if (!document.hasFocus()) void shell.notify(copy.brand.name, text).catch(() => {})
      return
    }
    if (typeof Notification === 'undefined') return
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

const VIEW_PARAM = 'view'
const SETTINGS_PARAM = 'settings'
const VIEWS: readonly View[] = ['chat', 'colonies', 'compare', 'system']
/** The new-chat screen's draft, beside each chat's own. */
const NEW_CHAT_DRAFT = 'new'

function viewFromAddress(): View {
  const v = new URLSearchParams(location.search).get(VIEW_PARAM)
  return VIEWS.find((view) => view === v) ?? 'chat'
}

/** The Settings section an address names; Settings shows its first section for a name it doesn't know. */
function sectionFromAddress(): Section | undefined {
  return (new URLSearchParams(location.search).get(SETTINGS_PARAM) as Section | null) ?? undefined
}

export function App() {
  const toast = useToast()
  const heldToast = useToastHandle()
  const [theme, setTheme] = useTheme(useImportedThemes())
  const [reduceMotion, setReduceMotion] = useReduceMotion()
  const [listed, refreshChats, chatsError, chatsLoaded] = usePoll<ChatSummary[]>('/api/chats', [], 2500)
  const online = useReachable()
  const fullAccess = useScope() === 'full'
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelsError, setModelsError] = useState<string>()
  const [config, setConfig] = useState<TeamConfig>()
  const [view, setView] = useState<View>(() => viewFromAddress())
  const [activeChat, setActiveChatState] = useState<string | undefined>(
    () => new URLSearchParams(location.search).get('chat') ?? undefined,
  )
  const [collapsed, setCollapsed] = usePersistentFlag('myr-sidebar-collapsed', false)
  const [workspaceOpen, setWorkspaceOpen] = usePersistentFlag('myr-workspace-open', true)
  const sidebarSplit = useSplitWidth('myr-sidebar-width', { min: 220, max: 360, initial: 260 })
  const [colonyModal, setColonyModal] = useState<string>()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(() => !!sectionFromAddress())
  // Plugins' commands join the slash menu and their UI fills its slots; a plugin switched or edited shows up here.
  const [pluginList] = usePoll<{ plugins: PluginSummary[] }>('/api/plugins', { plugins: [] }, 4000)
  useEffect(() => {
    setPluginCommands(pluginList.plugins.filter((p) => p.enabled).flatMap((p) => p.commands))
    void syncPluginUI(pluginList.plugins)
  }, [pluginList])
  const [settingsSection, setSettingsSection] = useState<Section>(() => sectionFromAddress() ?? 'general')
  /** The section Settings shows now; it moves on its own as the person picks sections, unlike the one it opens on. */
  const [shownSection, setShownSection] = useState<Section>(settingsSection)
  /** A channel whose sheet Settings → Channels opens on, from a request's toast; forgotten once Settings closes. */
  const [settingsChannel, setSettingsChannel] = useState<string>()
  useEffect(() => {
    if (!settingsOpen) setSettingsChannel(undefined)
  }, [settingsOpen])
  // Ways out of Settings go through its guard, which asks first when hook edits are unsaved.
  const settingsGuard = useRef<(go: () => void) => void>(undefined)
  const leaveSettings = useCallback(
    (go: () => void) => (settingsGuard.current ? settingsGuard.current(go) : go()),
    [],
  )
  /** The chats the delete sheet asks about: one, or the sidebar's selection. */
  const [deleting, setDeleting] = useState<readonly ChatSummary[]>()
  const deletes = useHeldDeletes({
    remove: (chatId) => request('DELETE', `/api/chats/${chatId}`),
    gone: (chatIds) => {
      for (const id of chatIds) forgetDraft(id)
      refreshChats()
    },
  })
  const { deleted } = deletes
  const chats = useMemo(() => listed.filter((c) => !deleted.has(c.chatId)), [listed, deleted])
  // The tab says how many chats wait for the person, so it shows from another tab or app.
  const needYou = chats.filter(needsYou).length
  useEffect(() => {
    document.title = copy.app.documentTitle(needYou)
    // In the desktop app the Dock icon carries the same count, unless the person turned it off.
    void desktop()
      ?.setBadge(readStored<string>(DOCK_BADGE_KEY, '1') === '1' ? needYou : 0)
      .catch(() => {})
  }, [needYou])
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
  /** The global preset, which new chats in projects without their own start on. */
  const [globalPreset, setGlobalPreset] = useState<PermissionPreset>(DEFAULT_PRESET)
  /** The project a new chat will work in. */
  const [newProject, setNewProject] = useState<string>()
  /** A new chat's own permission level, chosen in the composer before its first message. */
  const [newPermissions, setNewPermissions] = useState<PermissionLevel>()
  const [picking, setPicking] = useState(false)
  const [permissionsFor, setPermissionsFor] = useState<Project>()
  /** Where the person is with setup; `failed` while Myrmidon could not say. */
  const [setup, setSetup] = useState<SetupView | 'failed'>()
  /** The setup assistant's screen while it is open in place of the app. */
  const [setupScreen, setSetupScreen] = useState<SetupScreen>()
  /** Set while one step is open on its own: where the window goes back to once it is done. */
  const [setupReturn, setSetupReturn] = useState<SetupReturn>()
  /** Whether setup has been decided on for this page: it opens by itself only on the first answer. */
  const setupDecided = useRef(false)
  /** A starter prompt picked as setup finished, sent once the home screen is back. */
  const [starter, setStarter] = useState<string>()
  /** Setup just handed the window back, so the home screen's mascot takes over from setup's instead of popping in. */
  const [fromSetup, setFromSetup] = useState(false)
  const composer = useRef<ComposerHandle>(null)
  const seen = useRef(new Map<string, string>())
  /** Chats a skill review is reading now: asking again waits for the answer already on its way. */
  const learning = useRef(new Set<string>())

  const setActiveChat = useCallback((id: string | undefined) => {
    setActiveChatState(id)
    const url = new URL(location.href)
    if (id) url.searchParams.set('chat', id)
    else url.searchParams.delete('chat')
    history.replaceState(null, '', url)
  }, [])

  // A refresh comes back to the same screen: the screen and an open Settings section live in the address beside the
  // chat. A chats-only device has neither Settings nor System, so an address naming them falls back to the chat.
  useEffect(() => {
    if (!fullAccess && (settingsOpen || view === 'system')) {
      setSettingsOpen(false)
      if (view === 'system') setView('chat')
      return
    }
    const url = new URL(location.href)
    if (view === 'chat') url.searchParams.delete(VIEW_PARAM)
    else url.searchParams.set(VIEW_PARAM, view)
    if (settingsOpen) url.searchParams.set(SETTINGS_PARAM, shownSection)
    else url.searchParams.delete(SETTINGS_PARAM)
    if (url.href !== location.href) history.replaceState(null, '', url)
  }, [view, settingsOpen, shownSection, fullAccess])

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
    api<{ projects: Project[]; preset?: PermissionPreset; fullAccess?: boolean }>('/api/projects')
      .then((r) => {
        setProjects(r.projects)
        setGlobalPreset(r.preset ?? (r.fullAccess ? 'full' : DEFAULT_PRESET))
      })
      // With the server away the banner says so, and the list loads again once it is back.
      .catch((err) => reachable() && toast(String(err.message ?? err), 'error'))
  }, [toast])

  useEffect(loadProjects, [loadProjects])
  // Turning the sandbox off or on in Settings changes what the next chat gets.
  useEffect(() => {
    window.addEventListener(SETTINGS_SAVED, loadProjects)
    return () => window.removeEventListener(SETTINGS_SAVED, loadProjects)
  }, [loadProjects])

  // The owner meets the setup assistant until it is finished; a chats-only device never does.
  const loadSetup = useCallback(() => {
    if (!fullAccess) return
    api<SetupView>('/api/setup')
      .then((r) => {
        setSetup(r)
        if (setupDecided.current) return
        setupDecided.current = true
        const open = opensOnLoad(r)
        if (!open) return
        setSetupScreen(open)
        setSetupReturn(returnFromAddress())
      })
      .catch(() => {
        if (!setupDecided.current) setSetup('failed')
      })
  }, [fullAccess])
  useEffect(loadSetup, [loadSetup])

  // What failed to load while the server was away loads once it answers again; the polls catch up by themselves.
  useEffect(() => {
    const back = () => {
      if (!reachable()) return
      loadProjects()
      if (!config) loadModels()
      if (!setupDecided.current) loadSetup()
    }
    window.addEventListener(CONNECTION_CHANGED, back)
    return () => window.removeEventListener(CONNECTION_CHANGED, back)
  }, [config, loadModels, loadProjects, loadSetup])

  // Announce rounds that finish while the user is elsewhere: another chat, another view, or another window. The chat
  // on screen shows its own answer arriving, so a pop-up there only repeats it.
  const onScreen = useRef<string | undefined>(undefined)
  onScreen.current = !settingsOpen && view === 'chat' ? activeChat : undefined
  useEffect(() => {
    for (const c of chats) {
      const before = seen.current.get(c.chatId)
      if (before && isRunning(before) && !isRunning(c.status)) {
        const text =
          c.status === 'completed'
            ? copy.app.toasts.roundDone(c.title)
            : copy.app.toasts.roundEnded(c.title, c.status === 'stopped' ? copy.app.toasts.paused : c.status)
        const watching =
          c.chatId === onScreen.current && document.visibilityState === 'visible' && document.hasFocus()
        if (!watching) toast(text, c.status === 'completed' ? 'success' : 'info')
        notify(text, c.chatId)
      }
      seen.current.set(c.chatId, c.status)
    }
  }, [chats, toast])

  // Someone new asking to talk to the crew on a channel: a toast that opens their channel's People tab (approving
  // takes the code they were sent, typed there), and a desktop notice.
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
        label: copy.channelRequest.review,
        run: () =>
          leaveSettings(() => {
            setSettingsSection('channels')
            setSettingsChannel(w.channel)
            setSettingsOpen(true)
          }),
      })
      notify(text, undefined, `channel-request-${w.channel}-${w.id}`)
    }
  }, [status?.waiting, toast, leaveSettings])

  // Learned skills the curator archived: said once per archiving, with the way to restore them.
  const archived = status?.skillsArchived
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per archiving; openSettings is a fresh closure
  useEffect(() => {
    if (!archived) return
    try {
      if (localStorage.getItem(SKILLS_ARCHIVED_SEEN_KEY) === archived.at) return
      localStorage.setItem(SKILLS_ARCHIVED_SEEN_KEY, archived.at)
    } catch {
      // Storage blocked: said on every load rather than never.
    }
    toast(copy.app.toasts.skillsArchived(archived.names), 'info', {
      label: copy.app.toasts.reviewSkills,
      run: () => openSettings('skills'),
    })
  }, [archived?.at])

  // A voice call from this window: its socket and audio live in the client, what the bar shows lives here.
  const callRef = useRef<CallClient>(undefined)
  const [call, setCall] = useState<{
    state: CallState
    lines: CallLine[]
    /** What the person is saying, as it is heard, while they speak. */
    partial?: string
    muted: boolean
    /** Who the call reached: `assistant`, `lead` or a crew member's name. */
    talk: string
    chatId?: string
    /** The chat's title as the server named it, until the chat list has it. */
    chatTitle?: string
    latency?: number
    /** What waits for the person's yes or no, newest last. */
    approvals: { id: string; summary: string }[]
  }>()
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
  const startCall = async (to: CallTarget) => {
    if (callRef.current) return
    if (!window.isSecureContext || !navigator.mediaDevices) return toast(copy.call.insecure, 'error')
    const client = new CallClient(
      activeChat,
      {
        // A turn that was only noise ends with no line: what was heard of it goes with it.
        state: (state) =>
          setCall((c) => c && { ...c, state, ...(state === 'hearing' ? {} : { partial: undefined }) }),
        hello: (hello) =>
          setCall(
            (c) =>
              c && {
                ...c,
                talk: hello.talk,
                ...(hello.chatId ? { chatId: hello.chatId } : {}),
                ...(hello.chatTitle ? { chatTitle: hello.chatTitle } : {}),
              },
          ),
        line: (who, text, from) =>
          setCall(
            (c) =>
              c && {
                ...c,
                lines: [...c.lines, { who, text, ...(from ? { from } : {}) }].slice(-CALL_LINES),
                ...(who === 'person' ? { partial: undefined } : {}),
              },
          ),
        partial: (text) => setCall((c) => c && { ...c, partial: text }),
        level: setMicLevel,
        chat: (id) => {
          setCall((c) => c && { ...c, chatId: id })
          setActiveChat(id)
          setView('chat')
          refreshChats()
        },
        task: (request) => toast(copy.call.started(request), 'info'),
        latency: (ms) => setCall((c) => c && { ...c, latency: ms }),
        approval: (id, summary) =>
          setCall(
            (c) => c && { ...c, approvals: [...c.approvals.filter((a) => a.id !== id), { id, summary }] },
          ),
        approvalDone: (id) =>
          setCall((c) => c && { ...c, approvals: c.approvals.filter((a) => a.id !== id) }),
        // Voice off (4409) or not ready (4503: an engine to install, no call model…) is fixed in Settings → Voice.
        error: (message, code) =>
          toast(
            message,
            'error',
            fullAccess && (code === 4409 || code === 4503)
              ? { label: copy.call.openVoiceSettings, run: () => openSettings('voice') }
              : undefined,
          ),
        ended: () => {
          callRef.current = undefined
          setCall(undefined)
          setMicLevel(0)
          setCallsSeen((n) => n + 1)
        },
      },
      to,
    )
    callRef.current = client
    setCall({
      state: 'connecting',
      lines: [],
      muted: false,
      talk: to ?? 'assistant',
      ...(activeChat ? { chatId: activeChat } : {}),
      approvals: [],
    })
    try {
      await client.start()
    } catch (err) {
      // Hung up before the mic or audio was ready: what failed after that is of no interest any more.
      if (callRef.current !== client) return
      toast((err as Error).name === 'NotAllowedError' ? copy.call.noMic : (err as Error).message, 'error')
      client.hangUp()
    }
  }
  const muteCall = (muted: boolean) => {
    callRef.current?.mute(muted)
    setCall((c) => c && { ...c, muted })
  }
  const callChatTitle = call?.chatId
    ? (chats.find((c) => c.chatId === call.chatId)?.title ?? call.chatTitle)
    : undefined

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
  // A step in a chat (computer use waiting to be set up) opens Settings at its section.
  const openSettingsRef = useRef(openSettings)
  openSettingsRef.current = openSettings
  useEffect(() => {
    const open = (e: Event) => {
      const section = (e as CustomEvent<unknown>).detail
      if (SECTIONS.some((s) => s.id === section)) openSettingsRef.current(section as Section)
    }
    window.addEventListener(OPEN_SETTINGS_EVENT, open)
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open)
  }, [])

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

  const openChat = (id: string) =>
    leaveSettings(() => {
      setActiveChat(id)
      setView('chat')
      setSettingsOpen(false)
    })
  /** The chat `step` away from the open one, in the order the sidebar lists them. */
  const stepTo = (step: 1 | -1) => {
    const next = stepChat(
      sidebarOrder(chats.map((c) => c.chatId)),
      view === 'chat' ? activeChat : undefined,
      step,
    )
    if (next) openChat(next)
  }

  useHotkeys([
    { combo: 'mod+k', run: () => setPaletteOpen((o) => !o), inInputs: true },
    { combo: 'mod+n', run: () => newTask(), inInputs: true },
    { combo: 'mod+/', run: () => setShortcutsOpen((o) => !o), inInputs: true },
    // ⌘1 to ⌘9 open the chats in sidebar order; a browser keeps them for its tabs, the desktop app does not.
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
      combo: `mod+${n}`,
      run: () => {
        const id = sidebarOrder(chats.map((c) => c.chatId))[n - 1]
        if (id) openChat(id)
      },
      inInputs: true,
    })),
    { combo: 'mod+shift+[', run: () => stepTo(-1), inInputs: true },
    { combo: 'mod+shift+]', run: () => stepTo(1), inInputs: true },
    // With a sheet or menu open, ⌘. closes it instead (ui/dialog.ts).
    { combo: 'mod+.', run: () => !anyDialogOpen() && running && stop(), inInputs: true },
    { combo: '/', run: () => composer.current?.focus() },
    { combo: 'mod+b', run: () => setCollapsed(!collapsed), inInputs: true },
    // Only while a delete can be taken back, so ⌘Z is otherwise left alone.
    ...(deletes.undoLast ? [{ combo: UNDO_DELETE_COMBO, run: deletes.undoLast }] : []),
    {
      combo: 'mod+,',
      run: () => (fullAccess ? setSettingsOpen(true) : toast(copy.app.chatsOnly, 'info')),
      inInputs: true,
    },
    // With a chat's workspace on screen, it takes ⌘J itself (it knows whether its panel is showing).
    ...(!settingsOpen && view === 'chat' && chat
      ? []
      : [{ combo: 'mod+j', run: () => setWorkspaceOpen(!workspaceOpen), inInputs: true }]),
    ...(call
      ? [
          // Not while typing: on a Mac, Ctrl+D (which `mod` also matches) deletes forward in a text field.
          { combo: CALL_MUTE_COMBO, run: () => muteCall(!call.muted) },
          { combo: CALL_HANG_UP_COMBO, run: () => callRef.current?.hangUp() },
        ]
      : []),
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
          ...(!chatId && newPermissions ? { permissions: newPermissions } : {}),
          ...(files.length ? { attachments: await Promise.all(files.map(encodeFile)) } : {}),
        },
      )
      setActiveChat(r.chatId)
      if (!chatId) setNewPermissions(undefined)
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
  /**
   * Asks a reviewer to read the open chat for a skill worth keeping; the proposal appears as a card in the chat. The
   * review is a model reading the whole run, which can take minutes, so its toast stays until it answers.
   */
  const learn = async () => {
    if (!activeChat) return toast(copy.app.toasts.openChatToLearn, 'info')
    const chatId = activeChat
    const title = chat?.title ?? copy.app.titles.newTask
    if (learning.current.has(chatId)) return toast(copy.app.toasts.stillLearning(title), 'info')
    learning.current.add(chatId)
    const progress = heldToast(copy.app.toasts.learning(title), 'progress')
    try {
      const r = await post<{ proposal: { name: string } | null }>(`/api/chats/${chatId}/learn`, {})
      progress.settle(
        r.proposal ? copy.app.toasts.learned(r.proposal.name, title) : copy.app.toasts.nothingToLearn(title),
        r.proposal ? 'success' : 'info',
      )
    } catch (err) {
      progress.settle(copy.app.toasts.learnFailed(title, String((err as Error).message ?? err)), 'error')
    } finally {
      learning.current.delete(chatId)
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

  /** A confirmed delete hides the chats at once and is sent only once its undo lapses (`useHeldDeletes`). */
  const confirmDelete = () => {
    if (!deleting?.length) return
    const wasOpen = deleting.find((c) => c.chatId === activeChat)?.chatId
    setDeleting(undefined)
    deletes.hold(
      deleting,
      wasOpen
        ? () =>
            leaveSettings(() => {
              setActiveChat(wasOpen)
              setView('chat')
              setSettingsOpen(false)
            })
        : undefined,
    )
    if (wasOpen) newTask()
  }

  const sidebar = (
    <Sidebar
      onDelete={setDeleting}
      onExport={(c) => void exportChat(c).catch((err) => toast(String(err.message ?? err), 'error'))}
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
      onSelect={openChat}
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

  /** Everything the command menu reaches: app actions, chats, a new chat in each project, Settings pages. */
  const paletteItems = (): PaletteItem[] => {
    const a = copy.palette.actions
    const icon = 'size-4'
    const goTo = (v: View) => () =>
      leaveSettings(() => {
        setView(v)
        setSettingsOpen(false)
      })
    const latest = chat?.rounds.at(-1)
    const actions: (PaletteItem | false | undefined)[] = [
      {
        id: 'new',
        group: 'actions',
        label: a.newChat,
        icon: <SquarePen className={icon} />,
        combo: 'mod+n',
        run: () => newTask(),
      },
      view === 'chat' &&
        !!chat && {
          id: 'export',
          group: 'actions',
          label: a.export,
          icon: <Download className={icon} />,
          run: () => void exportChat(chat).catch((err) => toast(String(err.message ?? err), 'error')),
        },
      view === 'chat' &&
        !!latest && {
          id: 'console',
          group: 'actions',
          label: a.crewConsole,
          icon: <Network className={icon} />,
          run: () => setColonyModal(latest.colonyId),
        },
      {
        id: 'sidebar',
        group: 'actions',
        label: a.toggleSidebar,
        icon: <PanelLeft className={icon} />,
        combo: 'mod+b',
        run: () => setCollapsed(!collapsed),
      },
      {
        id: 'workspace',
        group: 'actions',
        label: a.toggleWorkspace,
        icon: <PanelRight className={icon} />,
        combo: 'mod+j',
        run: () => pressShortcut('mod+j', isMac),
      },
      fullAccess && {
        id: 'settings',
        group: 'actions',
        label: a.settings,
        icon: <SettingsIcon className={icon} />,
        combo: 'mod+,',
        run: () => setSettingsOpen(true),
      },
      {
        id: 'shortcuts',
        group: 'actions',
        label: a.shortcuts,
        icon: <FEATURE_ICONS.shortcuts className={icon} />,
        combo: 'mod+/',
        run: () => setShortcutsOpen(true),
      },
      {
        id: 'crews',
        group: 'actions',
        label: copy.sidebar.nav.crews,
        icon: <Network className={icon} />,
        run: goTo('colonies'),
      },
      {
        id: 'compare',
        group: 'actions',
        label: copy.sidebar.nav.compare,
        icon: <BarChart3 className={icon} />,
        run: goTo('compare'),
      },
      fullAccess && {
        id: 'system',
        group: 'actions',
        label: copy.system.nav,
        icon: <HeartPulse className={icon} />,
        run: goTo('system'),
      },
    ]
    return [
      ...actions.filter((x): x is PaletteItem => !!x),
      ...chats.map(
        (c): PaletteItem => ({
          id: `chat:${c.chatId}`,
          group: 'chats',
          label: c.title,
          ...(c.project ? { detail: c.project.name } : {}),
          icon: <Dot status={runPhase(c)} />,
          keywords: c.rounds.map((r) => r.request).join(' '),
          run: () => openChat(c.chatId),
        }),
      ),
      ...projects.map(
        (p): PaletteItem => ({
          id: `project:${p.id}`,
          group: 'projects',
          label: copy.palette.newChatIn(p.name),
          detail: p.path,
          icon: <Folder className={icon} />,
          keywords: p.name,
          run: () => newTask(p.id),
        }),
      ),
      ...(fullAccess
        ? SECTIONS.map(
            (sec): PaletteItem => ({
              id: `settings:${sec.id}`,
              group: 'settings',
              label: sec.label,
              detail: sec.hint,
              icon: <sec.icon className={icon} />,
              run: () => leaveSettings(() => openSettings(sec.id)),
            }),
          )
        : []),
    ]
  }

  /** Setup handing the window back: to the home screen, where a starter prompt picked on its last screen is sent. */
  const closeSetup = (result: { starter?: Starter; project?: string }) => {
    setSetupScreen(undefined)
    setSetupReturn(undefined)
    const url = new URL(location.href)
    url.searchParams.delete(SETUP_PARAM)
    url.searchParams.delete(SETUP_RETURN_PARAM)
    history.replaceState(null, '', url)
    loadSetup()
    // One step opened on its own goes back where it was opened from: Settings is still open behind it, or home.
    if (setupReturn) return
    setSettingsOpen(false)
    setView('chat')
    setActiveChat(undefined)
    if (result.project) setNewProject(result.project)
    setFromSetup(true)
    const text = result.starter?.text
    setTimeout(() => {
      setFromSetup(false)
      if (text) setStarter(text)
    }, SETUP_HANDOFF_MS)
  }
  /** One step on its own, from the home screen's card or Settings → General; it comes back there when done. */
  const openSetupStep = (step: SetupStep, from: SetupReturn) => {
    if (from === 'settings') setSettingsSection('general')
    setSetupReturn(from)
    setSetupScreen(step)
  }
  const dismissSetupNudge = () => {
    if (!setup || setup === 'failed') return
    const before = setup
    setSetup({ ...setup, setup: { ...setup.setup, dismissedAt: new Date().toISOString() } })
    request<SetupView>('PUT', '/api/setup', { dismiss: true })
      .then((r) => {
        setSetup(r)
        toast(copy.setup.nudge.dismissed, 'info')
      })
      .catch((err) => {
        setSetup(before)
        toast(String((err as Error).message ?? err), 'error')
      })
  }
  const runSetupAgain = () =>
    request<SetupView>('PUT', '/api/setup', { restart: true })
      .then((r) => {
        setSetup(r)
        setSettingsOpen(false)
        setSetupReturn(undefined)
        setSetupScreen('welcome')
      })
      .catch((err) => toast(String((err as Error).message ?? err), 'error'))
  // biome-ignore lint/correctness/useExhaustiveDependencies: sends the starter once, when it is due and a model is set
  useEffect(() => {
    if (!starter || !config) return
    setStarter(undefined)
    void send(starter).catch(() => {})
  }, [starter, config])
  const setupLeft = setup && setup !== 'failed' ? leftToSetUp(setup) : []

  // Until Myrmidon says whether setup is due, the window stays empty rather than flash the home screen first.
  if (fullAccess && setup === undefined && online) return <div className="h-dvh bg-bg" />
  const settingUp = fullAccess && !!setupScreen && !!setup && setup !== 'failed'

  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'user'}>
      <ComputerBanner />
      {/* Setup covers the window while it is open. It fades out over the app rather than vanish, so its mascot can
          settle into the home screen's (they share a layout id, and the hand-over needs the old one to exit). */}
      <AnimatePresence>
        {settingUp && setupScreen && setup && (
          <motion.div
            key="setup"
            className="fixed inset-0 z-50"
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Setup
              initial={setup}
              screen={setupScreen}
              theme={theme}
              onTheme={setTheme}
              models={models}
              onModelsChanged={loadModels}
              {...(config ? { config } : {})}
              onConfig={updateConfig}
              online={online}
              onProjects={setProjects}
              {...(setupReturn ? { returnTo: setupReturn } : {})}
              onClose={closeSetup}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {!settingUp && (
        <>
          {/* The shell is exactly one viewport tall; only inner panels scroll, so the message box never leaves the screen. */}
          <div className="flex h-dvh overflow-hidden bg-bg text-fg">
            {/* Past the sidebar's controls and chat list in one press, for people on the keyboard. */}
            {!settingsOpen && view === 'chat' && config && (
              <button
                type="button"
                onClick={() => composer.current?.focus()}
                className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[90] focus:rounded-md focus:bg-surface focus:px-3 focus:py-1.5 focus:text-body focus:font-medium focus:text-fg focus:shadow-pop"
              >
                {copy.app.skipToComposer}
              </button>
            )}
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
                  key={settingsChannel ? `${settingsSection}:${settingsChannel}` : settingsSection}
                  initialSection={settingsSection}
                  onSection={setShownSection}
                  {...(settingsChannel ? { initialChannel: settingsChannel } : {})}
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
                  onRunSetup={() => void runSetupAgain()}
                  onOpenSetupStep={(step) => openSetupStep(step, 'settings')}
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
                        <Badge tone={toneFor(runPhase(chat))}>{copy.status.run[runPhase(chat)]}</Badge>
                      )}
                      {view === 'chat' && chat?.fullAccess && <FullAccessBadge />}
                    </ToolbarTitle>
                    {view === 'chat' && voiceOn && !call && (
                      <CallMenu crew={chat?.crew ?? []} onCall={(to) => void startCall(to)} />
                    )}
                    {view === 'chat' && chat && (
                      <Button
                        variant="borderless"
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
                        talk={call.talk}
                        {...(call.chatId && callChatTitle
                          ? {
                              chat: {
                                title: callChatTitle,
                                onOpen: () => {
                                  setActiveChat(call.chatId)
                                  setView('chat')
                                },
                              },
                            }
                          : {})}
                        {...(call.latency !== undefined ? { latency: call.latency } : {})}
                        {...(call.approvals.length ? { approval: call.approvals.at(-1)?.summary } : {})}
                        state={call.state}
                        lines={call.lines}
                        {...(call.partial ? { partial: call.partial } : {})}
                        muted={call.muted}
                        onMute={muteCall}
                        onHangUp={() => {
                          callRef.current?.hangUp()
                          // The bar and its button go; the message box is where the conversation carries on.
                          composer.current?.focus()
                        }}
                      />
                    )}
                  </AnimatePresence>
                  {!online ? (
                    <div
                      role="status"
                      className="flex shrink-0 items-center gap-2 border-b border-line bg-fill px-4 py-2 text-body text-fg-2"
                    >
                      <LoaderCircle className="size-3.5 animate-spin text-muted" />
                      {copy.app.reconnecting}
                    </div>
                  ) : (
                    chatsError && (
                      <div className="shrink-0 bg-bad-soft px-4 py-2 text-body text-bad-ink">
                        {chatsError}
                      </div>
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
                          key={activeChat ?? NEW_CHAT_DRAFT}
                          ref={composer}
                          draftKey={activeChat ?? NEW_CHAT_DRAFT}
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
                            <>
                              {/* A chat started without a project stays without one. */}
                              {(!chat || chat.project) && (
                                <ProjectPill
                                  projects={projects}
                                  {...(chat?.project ? { fixed: chat.project } : {})}
                                  {...(newProject ? { value: newProject } : {})}
                                  onChange={setNewProject}
                                  {...(fullAccess ? { onAdd: () => setPicking(true) } : {})}
                                />
                              )}
                              {(() => {
                                const project = projects.find(
                                  (p) => p.id === (chat?.project?.id ?? newProject),
                                )
                                return (
                                  <ChatPermissions
                                    chatId={chat?.chatId}
                                    level={chat ? chat.permissions : newPermissions}
                                    project={
                                      project?.permissions
                                        ? { name: project.name, level: project.permissions }
                                        : undefined
                                    }
                                    globalPreset={globalPreset}
                                    canEdit={fullAccess}
                                    onPending={setNewPermissions}
                                    onSaved={refreshChats}
                                    {...(fullAccess
                                      ? { onOpenSettings: () => openSettings('permissions') }
                                      : {})}
                                  />
                                )
                              })()}
                              {chat?.reads?.length ? (
                                <ChatReadChips
                                  chatId={chat.chatId}
                                  reads={chat.reads}
                                  onChanged={refreshChats}
                                />
                              ) : null}
                            </>
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
                          recent={chats.map((c) => ({
                            chatId: c.chatId,
                            title: c.title,
                            status: runPhase(c),
                            updatedAt: c.updatedAt,
                          }))}
                          onOpenChat={openChat}
                          onPick={(t) => composer.current?.fill(t)}
                          fromSetup={fromSetup}
                          {...(call ? { call: call.state } : {})}
                        >
                          {config && !models.some(canLead) && (
                            <SetupCard {...(fullAccess ? { onConnect: () => openSettings('models') } : {})} />
                          )}
                          {fullAccess && models.some(canLead) && setupLeft.length > 0 && (
                            <SetupNudge
                              left={setupLeft}
                              onOpen={(step) => openSetupStep(step, 'home')}
                              onDismiss={dismissSetupNudge}
                            />
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
            {deleting && deleting.length > 0 && (
              <Sheet
                key="delete"
                title={
                  deleting.length === 1
                    ? copy.app.deleteChat.title
                    : copy.app.deleteChat.titleMany(deleting.length)
                }
                onClose={() => setDeleting(undefined)}
                size="sm"
              >
                <DeleteChats
                  chats={deleting}
                  onCancel={() => setDeleting(undefined)}
                  onConfirm={confirmDelete}
                />
              </Sheet>
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
                  // The open chat stays open, so the toast offers a chat in the new folder; a new task about to start
                  // works in it already.
                  if (!activeChat) setNewProject(p.id)
                  toast(
                    copy.folderPicker.added(p.name),
                    'success',
                    activeChat
                      ? { label: copy.folderPicker.startChat(p.name), run: () => newTask(p.id) }
                      : undefined,
                  )
                }}
              />
            )}
            {colonyModal && (
              <Sheet
                key="colony"
                title={copy.app.crewConsole}
                onClose={() => setColonyModal(undefined)}
                size="full"
                flush
              >
                <ColonyScreen key={colonyModal} id={colonyModal} />
              </Sheet>
            )}
            {shortcutsOpen && (
              <Sheet
                key="shortcuts"
                title={copy.settings.shortcuts.title}
                onClose={() => setShortcutsOpen(false)}
                size="sm"
              >
                <ShortcutList />
              </Sheet>
            )}
            {paletteOpen && (
              <CommandPalette key="palette" items={paletteItems()} onClose={() => setPaletteOpen(false)} />
            )}
          </AnimatePresence>
        </>
      )}
      <ContextMenuHost />
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
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-fg">
        <FEATURE_ICONS.providers className="size-4" />
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
        className="mx-auto flex max-w-[820px] items-center gap-2.5 rounded-xl border border-line-strong bg-surface px-5 py-4 text-title text-muted shadow-pop"
      >
        {props.error ? (
          <CircleAlert className="size-4 shrink-0 text-bad-ink" />
        ) : (
          <LoaderCircle className="size-4 shrink-0 animate-spin" />
        )}
        <span className="flex-1">{props.error ? t.failed : t.loading}</span>
        {props.error && (
          <Button variant="borderless" icon={<RefreshCw className="size-3.5" />} onClick={props.onRetry}>
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
        <p className="text-headline font-semibold tracking-tight">{props.title}</p>
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
  /** Voice calls in this chat, placed among the rounds by when they started. */
  calls: readonly SavedCall[]
}) {
  const running = !!props.chat && isRunning(props.chat.status)
  const rounds = props.chat?.rounds ?? []
  // Each call shows before the first round that began after it; calls since the last round began come after it.
  const callsBefore = (r: ChatRound) => {
    const at = rounds.indexOf(r)
    const from = rounds
      .slice(0, at)
      .map((x) => x.startedAt)
      .filter(Boolean)
      .at(-1)
    return r.startedAt
      ? props.calls.filter((c) => c.startedAt <= (r.startedAt ?? '') && (!from || c.startedAt > from))
      : []
  }
  const placed = new Set(rounds.flatMap(callsBefore).map((c) => c.id))
  const loose = props.calls.filter((c) => !placed.has(c.id))
  const pane = useFollowLatest<HTMLDivElement>(props.chat?.chatId)
  return (
    <div ref={pane.ref} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <ProjectFiles project={props.chat?.project}>
        <div className="mx-auto flex max-w-[820px] flex-col gap-8 p-6">
          {colonies(rounds).map((group, g) => (
            <ColonyRounds
              key={group.colonyId}
              colonyId={group.colonyId}
              rounds={group.rounds}
              first={g === 0}
              render={(colony, r) => (
                <>
                  {callsBefore(r).map((c) => (
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
      </ProjectFiles>
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
