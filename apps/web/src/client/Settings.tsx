import { SETUP_STEPS, type SetupStep } from '@myrmidon/protocol'
import {
  ArchiveRestore,
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  CircleCheck,
  CircleX,
  Download,
  ExternalLink,
  LoaderCircle,
  LogIn,
  Monitor,
  Moon,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Sun,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { AnimatePresence, motion, useReducedMotionConfig } from 'motion/react'
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  activeGateway,
  api,
  GATEWAYS_CHANGED,
  type GatewayInfo,
  hubSend,
  listGateways,
  type ModelOption,
  post,
  postForBlob,
  send,
  switchGateway,
  type TeamConfig,
} from './api.ts'
import { ComputerSection } from './ComputerUse.tsx'
import { CHANNEL_GROUPS } from './channel-logos.ts'
import { type ChannelConnection, channelStatusText } from './channel-status.ts'
import { SkillProposalCard, type SkillProposalView } from './chat/ApprovalCards.tsx'
import { formatSize } from './chat/Attachments.tsx'
import { TeamSettings } from './chat/Composer.tsx'
import { ToolLibraryList } from './chat/MadeTools.tsx'
import { ModelPicker, windowLabel } from './chat/ModelPicker.tsx'
import { usersOf, withoutModel } from './chat/model-list.ts'
import { SpecialistEditor } from './chat/SpecialistEditor.tsx'
import { copy } from './copy.ts'
import { type MascotPatch, SETTINGS_SAVED, withMascotDefaults } from './mascot.ts'
import { MascotBehaviour, MascotPreview, MiniMascot } from './mascot-settings.tsx'
import type { CatalogTool } from './permissions/describe.ts'
import { type GlobalPermissions, PermissionsPage } from './permissions/PermissionsPage.tsx'
import { PluginSlot, usePluginSlots } from './plugins.tsx'
import {
  cronToRule,
  DEFAULT_RULE,
  describeCron,
  type Repeat,
  ruleToCron,
  type ScheduleRule,
} from './schedule-rule.ts'
import { useLiveSettings } from './settings/live.ts'
import { GROUPS, type ModelsTab, SECTIONS, type Section } from './settings/pages.ts'
import { SETTINGS, type SettingId } from './settings/registry.ts'
import {
  SettingField,
  type SettingTarget,
  SettingTargetProvider,
  setting,
  settingItem,
  settingRow,
  useSettingTarget,
} from './settings/Setting.tsx'
import {
  revealSetting,
  rowsAbove,
  SettingsSearchField,
  SettingsSearchResults,
  useSettingsSearch,
} from './settings/SettingsSearch.tsx'
import { type SearchEntry, settingsIndex } from './settings/search.ts'
import { baseUrlError, channelSetup, clampNumber, cronError, providerNameError } from './settings-forms.ts'
import { removeSpecialist, useSpecialists } from './specialists.ts'
import { useStatus } from './status.tsx'
import { AppearanceSection } from './themes/AppearanceSection.tsx'
import type { ImportedTheme } from './themes/vscode.ts'
import { ChannelLogo } from './ui/ChannelLogo.tsx'
import { ConfirmButton } from './ui/ConfirmButton.tsx'
import { desktop } from './ui/desktop.ts'
import { anyDialogOpen } from './ui/dialog.ts'
import {
  ago,
  day,
  NOTIFY_KEY,
  SUGGEST_KEY,
  type ThemeChoice,
  useCopy,
  useMinWidth,
  usePersistentFlag,
} from './ui/hooks.ts'
import { FEATURE_ICONS } from './ui/icons.ts'
import { AgentAvatar } from './ui/pixel.tsx'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardRow,
  CountBadge,
  cn,
  Dot,
  Empty,
  Field,
  IconButton,
  Kbd,
  PageHeader,
  SectionHeader,
  Segmented,
  Select,
  Switch,
  Tabs,
  TextArea,
  TextInput,
  tabPanel,
} from './ui/primitives.tsx'
import { Sheet } from './ui/Sheet.tsx'
import { ShortcutList } from './ui/ShortcutList.tsx'
import { matchCombo } from './ui/shortcuts.ts'
import { useToast } from './ui/Toast.tsx'
import {
  AGENT_MIN_WINDOW,
  MASCOT_COLORS,
  SETTINGS_NAV_COLLAPSE_PX,
  SETTINGS_SEARCH_COMBO,
  softSpring,
  spring,
  VOICE_POLL_MS,
  VOICE_SPEEDS,
} from './ui-config.ts'
import { engineTrouble } from './voice/engine-trouble.ts'
import type { VoiceEndpointView, VoiceProviderView } from './voice/providers.ts'
import {
  AddVoiceProvider,
  CallModeRow,
  CloudRows,
  cloudHint,
  EnginePicker,
  RealtimeCard,
} from './voice/VoiceChoice.tsx'
import { VoiceProviders } from './voice/VoiceProviders.tsx'

type Api = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai'

export interface ProviderInfo {
  id: string
  models: number
  ready: boolean
  custom: boolean
  baseUrl?: string
  api?: Api
  modelIds?: string[]
  keyless?: boolean
  hasKey?: boolean
  stored?: boolean
}

interface ProviderBody {
  name: string
  api: Api
  baseUrl: string
  apiKey?: string
  keyless: boolean
  models: string[]
}

export interface ServerSettings {
  version: 1
  team: {
    mode: 'orchestrated' | 'swarm'
    workers: number
    leadModel?: string
    workerModel?: string
    judgeModel?: string
    wallMinutes: number
    maxTurns: number
    costUsd: number
    tokens: number
  }
  /** Folders sandboxed agents may also read, in every chat. Full access is the global preset. */
  sandbox?: { read?: string[]; readHome?: boolean }
  /** Computer use (agents on the person's Mac); absent from older servers. */
  computerUse?: { enabled: boolean; engine?: 'cua' | 'omp' }
  verification: { threshold: number; rubric?: string; reviewer: 'off' | 'auto' | 'always' }
  instructions: { lead?: string; worker?: string }
  observer: { intervalSeconds: number }
  search: { provider: string }
  models: { hidden: string[]; hiddenProviders: string[]; windows?: Record<string, number> }
  /** The global level of the permission model: the default preset, rules, who can use what. */
  permissions: GlobalPermissions
  profile?: { name?: string; greeting: 'model' | 'rules'; titles?: 'model' | 'first-message' }
  mascot?: MascotPatch
  /** VS Code themes the person imported; absent from older servers. */
  appearance?: { imported: ImportedTheme[] }
  voice: {
    enabled: boolean
    callModel?: string
    /** Pipeline (speech to text, the call model, text to speech) or one realtime model; absent from older servers. */
    mode?: 'pipeline' | 'realtime'
    /** `phonon`, `omp`, a voice provider's id, or `endpoint:<id>`. */
    stt: { provider: string; model?: string }
    tts: {
      provider: string
      model?: string
      /** A cloud provider's voice (Kitten's is `voice`). */
      voiceId?: string
      kittenModel: 'nano' | 'micro' | 'mini'
      voice: string
      speed: number
    }
    realtime?: { provider?: string; model?: string; voice?: string }
    regions?: Record<string, string>
    endpoints?: { id: string; baseUrl: string; keyless?: boolean }[]
    sensitivity: 'low' | 'normal' | 'high'
    /** Phone calls on the SMS channel's Twilio number; absent from older servers. */
    phone?: boolean
  }
}

export interface SettingsResponse {
  settings: ServerSettings
  providers: ProviderInfo[]
  searchProviders: { id: string; label: string }[]
  customApis: Api[]
  sandbox: string
  /** Paths of the person's keys and Myrmidon's data, as typed and in full: a readable folder that opens one is warned about. */
  guardedReads?: string[]
  home: string
  /** The computer account's name, used when the person has not set one. */
  account?: string
  agentDir?: string
  ompSetup: boolean
  toolCatalog: CatalogTool[]
  /** MCP servers rules can name; absent from older servers. */
  mcpServers?: string[]
}

const API_LABELS: Record<Api, string> = {
  'openai-completions': copy.settings.providerForm.apiLabels['openai-completions'],
  'openai-responses': copy.settings.providerForm.apiLabels['openai-responses'],
  'anthropic-messages': copy.settings.providerForm.apiLabels['anthropic-messages'],
  'google-generative-ai': copy.settings.providerForm.apiLabels['google-generative-ai'],
}

const API_HINT_URL: Record<Api, string> = {
  'openai-completions': 'https://api.example.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
}

/** Full-page settings, shown in place of the chat. Every change autosaves, except hooks (see HooksSection). */
export function Settings(props: {
  onClose(): void
  theme: ThemeChoice
  onTheme(t: ThemeChoice): void
  reduceMotion: boolean
  onReduceMotion(v: boolean): void
  models: ModelOption[]
  onModelsChanged(): void
  config?: TeamConfig
  onConfig(c: TeamConfig): void
  initialSection?: Section
  /** A channel whose sheet Settings → Channels opens on (a new request's toast). */
  initialChannel?: string
  /**
   * Filled in while Settings is open with a function that runs `go` once leaving is safe (asking first when hook
   * edits are unsaved), for the ways out of Settings that the app itself offers.
   */
  guard?: { current?: (go: () => void) => void }
  /** Told the section on screen, so the app can keep it in the address and a refresh comes back to it. */
  onSection?(section: Section): void
  /** Opens the setup assistant again from its first step (Settings → General). */
  onRunSetup?(): void
  /** Opens one step of the setup assistant on its own, which comes back here when done. */
  onOpenSetupStep?(step: SetupStep): void
}) {
  const [section, setSection] = useState<Section>(props.initialSection ?? 'general')
  const onSection = useRef(props.onSection)
  onSection.current = props.onSection
  useEffect(() => {
    onSection.current?.(section)
    if (section !== 'models') setVoiceFocus(false)
  }, [section])
  const [modelsTab, setModelsTab] = useState<ModelsTab>('models')
  // Settings → Voice's "Add a voice provider" opens the Providers tab at its voice part.
  const [voiceFocus, setVoiceFocus] = useState(false)
  const { data, error, saving, saveError, retry, update, saveNow, providersChanged, modelsRemoved } =
    useSettingsData(props.onModelsChanged)
  const wideNav = useMinWidth(SETTINGS_NAV_COLLAPSE_PX)
  // Hooks are the one section with an explicit Save; leaving it with edits asks first.
  const [hooksDirty, setHooksDirty] = useState(false)
  const [leaving, setLeaving] = useState<() => void>()
  const leave = (go: () => void) => (hooksDirty ? setLeaving(() => go) : go())
  const onClose = useRef(() => leave(props.onClose))
  onClose.current = () => leave(props.onClose)
  const { guard } = props
  // Every render, since leave changes with hooksDirty; a Settings that remounts clears only its own.
  useEffect(() => {
    if (!guard) return
    guard.current = leave
    return () => {
      if (guard.current === leave) guard.current = undefined
    }
  })
  // Reloading or closing the window would drop unsaved hook edits too.
  useEffect(() => {
    if (!hooksDirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Safari before 17 asks only when returnValue is set.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hooksDirty])

  // Search: every setting, and the live lists' items once the field is in use.
  const [searchUsed, setSearchUsed] = useState(false)
  const live = useLiveSettings(searchUsed, data, props.models)
  const index = useMemo(() => settingsIndex(live), [live])
  const search = useSettingsSearch(index)
  useEffect(() => {
    if (search.focused) setSearchUsed(true)
  }, [search.focused])
  const searchInput = search.input

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchCombo(SETTINGS_SEARCH_COMBO, e) && !anyDialogOpen()) {
        e.preventDefault()
        searchInput.current?.focus()
        searchInput.current?.select()
        return
      }
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select')
      if (e.key === 'Escape' && !typing && !anyDialogOpen()) onClose.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [searchInput])

  // Choosing a result opens its page (and tab), then finds its row and highlights it.
  const toast = useToast()
  const pageArea = useRef<HTMLDivElement>(null)
  const [target, setTarget] = useState<SettingTarget & { under: string[]; label: string }>()
  const reduce = useReducedMotionConfig() ?? props.reduceMotion
  const jump = (entry: SearchEntry) =>
    leave(() => {
      setSection(entry.page)
      if (entry.tab) setModelsTab(entry.tab)
      setTarget((was) => ({
        id: entry.id,
        ...(entry.key ? { key: entry.key } : {}),
        under: rowsAbove(entry.id),
        label: entry.label,
        n: (was?.n ?? 0) + 1,
      }))
    })
  useEffect(() => {
    if (!target) return
    return revealSetting(pageArea, target, reduce, (fallback) => {
      const t = copy.settings.search
      const first = fallback && fallback in SETTINGS ? SETTINGS[fallback as SettingId].label : undefined
      toast(
        fallback
          ? first
            ? t.startWith(target.label, first)
            : t.openOne(target.label)
          : t.notShown(target.label),
        'info',
      )
    })
  }, [target, reduce, toast])

  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const waiting = useStatus().status?.waiting?.length ?? 0
  const field = <SettingsSearchField search={search} onChoose={jump} />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        data-toolbar
        className="drag-region material-toolbar flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-3"
      >
        <Button
          variant="borderless"
          size="sm"
          onClick={() => leave(props.onClose)}
          icon={<ArrowLeft className="size-4" />}
        >
          {copy.settings.page.back}
        </Button>
        <span className="text-body font-semibold">{copy.settings.page.title}</span>
        <span className="text-muted">/</span>
        <span className="truncate text-body text-fg-2">
          {search.open ? copy.settings.search.label : current?.label}
        </span>
        <span className="flex-1" />
        <AnimatePresence>
          {saving === 'failed' ? (
            <motion.span
              key="failed"
              role="alert"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              title={saveError}
              className="inline-flex items-center gap-1.5 text-small text-bad-ink"
            >
              <CircleX className="size-3.5" />
              {copy.settings.page.saveFailed}
              <span aria-hidden>·</span>
              <Button size="sm" variant="borderless" onClick={retry} icon={<RefreshCw className="size-3" />}>
                {copy.settings.page.retry}
              </Button>
            </motion.span>
          ) : (
            saving !== 'idle' && (
              <motion.span
                key="saving"
                role="status"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="inline-flex items-center gap-1.5 text-small text-muted"
              >
                {saving === 'saving' ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5 text-ok-ink" />
                )}
                {saving === 'saving' ? copy.settings.page.saving : copy.settings.page.saved}
              </motion.span>
            )
          )}
        </AnimatePresence>
        <span className="hidden text-footnote text-muted md:inline">
          <Kbd>Esc</Kbd>
          {copy.settings.page.escToClose}
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        {/* A source list, as System Settings has: small monochrome tiles, one line per page, the open page in the
            neutral selection with its tile in amber. The search field sits over it, as on an iPhone. */}
        <nav
          aria-label={copy.settings.page.title}
          className={cn(
            'material-sidebar hidden shrink-0 flex-col overflow-auto overscroll-contain border-r border-line px-2.5 pb-3 pt-1 md:flex',
            wideNav ? 'w-60' : 'w-[60px] items-center',
          )}
        >
          {wideNav && <div className="px-0.5 pb-1 pt-2">{field}</div>}
          {GROUPS.map((group, i) => (
            <div key={group} className="flex w-full flex-col gap-px">
              {wideNav ? (
                <div className="px-2 pb-1 pt-3 text-caption font-semibold text-muted">
                  {copy.settings.page.groups[group]}
                </div>
              ) : (
                i > 0 && <div aria-hidden className="mx-2 my-2 border-t border-line" />
              )}
              {SECTIONS.filter((s) => s.group === group).map((s) => {
                const shown = section === s.id && !search.open
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() =>
                      leave(() => {
                        search.setQuery('')
                        setSection(s.id)
                      })
                    }
                    aria-current={shown ? 'page' : undefined}
                    aria-label={wideNav ? undefined : s.label}
                    title={wideNav ? s.hint : s.label}
                    className={cn(
                      'relative flex h-7 shrink-0 items-center gap-2 rounded-md text-left text-body transition-colors',
                      wideNav ? 'px-1.5' : 'w-8 justify-center',
                      shown ? 'text-fg' : 'text-fg-2 hover:bg-fill/70 hover:text-fg',
                    )}
                  >
                    {shown && (
                      <motion.span
                        layoutId="settings-nav"
                        transition={spring}
                        className="absolute inset-0 rounded-md bg-row-selected"
                      />
                    )}
                    <span
                      className={cn(
                        'relative grid size-5 shrink-0 place-items-center rounded-[5px] transition-colors',
                        shown ? 'bg-accent text-on-accent' : 'bg-fill-strong text-fg-2',
                      )}
                    >
                      <s.icon className="size-3" />
                      {s.id === 'channels' && waiting > 0 && (
                        <CountBadge
                          count={waiting}
                          tone="accent"
                          corner
                          label={copy.settings.channels.waitingBadge(waiting)}
                        />
                      )}
                    </span>
                    {wideNav && <span className="relative min-w-0 truncate">{s.label}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
        <div ref={pageArea} className="min-w-0 flex-1 overflow-y-auto overscroll-contain bg-bg">
          {!wideNav && (
            <div className="flex flex-col gap-2 border-b border-line p-3">
              {field}
              <Select
                value={section}
                onChange={(e) => {
                  const next = e.target.value as Section
                  leave(() => {
                    search.setQuery('')
                    setSection(next)
                  })
                }}
                className="w-full md:hidden"
                aria-label={copy.settings.page.sectionPicker}
              >
                {GROUPS.map((group) => (
                  <optgroup key={group} label={copy.settings.page.groups[group]}>
                    {SECTIONS.filter((s) => s.group === group).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </div>
          )}
          {error && (
            <Banner tone="bad" className="m-5">
              {error}
            </Banner>
          )}
          {search.open && (
            <div className="mx-auto max-w-3xl px-6 py-8">
              <SettingsSearchResults search={search} onChoose={jump} />
            </div>
          )}
          <AnimatePresence mode="wait">
            <motion.div
              key={section}
              data-settings-page={section}
              hidden={search.open}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16 }}
              className="mx-auto max-w-3xl px-6 py-8"
            >
              <SettingTargetProvider value={target}>
                {section === 'general' && (
                  <div className="flex flex-col gap-10">
                    <General
                      reduceMotion={props.reduceMotion}
                      onReduceMotion={props.onReduceMotion}
                      data={data}
                      update={update}
                      {...(props.onRunSetup ? { onRunSetup: props.onRunSetup } : {})}
                      {...(props.onOpenSetupStep ? { onOpenSetupStep: props.onOpenSetupStep } : {})}
                    />
                    <Shortcuts />
                    <About data={data} />
                  </div>
                )}
                {section === 'models' && data && (
                  <>
                    <div {...settingRow('models.tabs')} className="mb-6">
                      <Segmented
                        id="models-tab"
                        value={modelsTab}
                        onChange={setModelsTab}
                        options={[
                          {
                            value: 'models',
                            label: (
                              <>
                                <FEATURE_ICONS.models className="size-3.5" /> {copy.settings.page.modelsTab}
                              </>
                            ),
                          },
                          {
                            value: 'providers',
                            label: (
                              <>
                                <FEATURE_ICONS.providers className="size-3.5" />{' '}
                                {copy.settings.page.providersTab}
                              </>
                            ),
                          },
                        ]}
                      />
                    </div>
                    {modelsTab === 'models' ? (
                      <ModelsSection
                        models={props.models}
                        settings={data.settings}
                        providers={data.providers}
                        {...(props.config ? { config: props.config } : {})}
                        onConfig={props.onConfig}
                        onRemoved={(settings, providers) => {
                          modelsRemoved(settings, providers)
                          props.onModelsChanged()
                          window.dispatchEvent(new Event(SETTINGS_SAVED))
                        }}
                        update={update}
                        onRefresh={props.onModelsChanged}
                        onAddProvider={() => setModelsTab('providers')}
                      />
                    ) : (
                      <Providers
                        data={data}
                        onProviders={providersChanged}
                        update={update}
                        focusVoice={voiceFocus}
                      />
                    )}
                  </>
                )}
                {section === 'team' && data && (
                  <TeamSection
                    data={data}
                    update={update}
                    models={props.models}
                    config={props.config}
                    onConfig={props.onConfig}
                  />
                )}
                {section === 'appearance' && (
                  <AppearanceSection
                    theme={props.theme}
                    onTheme={props.onTheme}
                    {...(data ? { imported: data.settings.appearance?.imported ?? [] } : {})}
                    onSaveImported={(imported) =>
                      saveNow((s) => ({ ...s, appearance: { ...s.appearance, imported } }))
                    }
                  />
                )}
                {section === 'mascot' && data && <MascotSection data={data} update={update} />}
                {section === 'specialists' && <SpecialistsSection models={props.models} />}
                {section === 'devices' && <DevicesSection />}
                {section === 'gateways' && <GatewaysSection />}
                {section === 'channels' && <ChannelsSection initial={props.initialChannel} />}
                {section === 'voice' && data && (
                  <VoiceSection
                    settings={data.settings}
                    update={update}
                    models={props.models}
                    onAddProvider={() =>
                      leave(() => {
                        setModelsTab('providers')
                        setVoiceFocus(true)
                        setSection('models')
                      })
                    }
                  />
                )}
                {section === 'computer' && data && (
                  <ComputerSection
                    enabled={data.settings.computerUse?.enabled === true}
                    setEnabled={(enabled) =>
                      update((s) => ({ ...s, computerUse: { ...s.computerUse, enabled } }), true)
                    }
                    engine={data.settings.computerUse?.engine ?? 'cua'}
                    setEngine={(engine) =>
                      update(
                        (s) => ({ ...s, computerUse: { enabled: false, ...s.computerUse, engine } }),
                        true,
                      )
                    }
                  />
                )}
                {section === 'tools' && data && (
                  <ToolsSection data={data} update={update} onPermissions={() => setSection('permissions')} />
                )}
                {section === 'permissions' && data && (
                  <PermissionsPage
                    permissions={data.settings.permissions}
                    onChange={(permissions, immediate) => update((s) => ({ ...s, permissions }), immediate)}
                    tools={data.toolCatalog}
                    servers={data.mcpServers ?? []}
                    sandbox={data.sandbox}
                    reads={<SandboxReads data={data} update={update} />}
                  />
                )}
                {section === 'instructions' && data && (
                  <InstructionsSection settings={data.settings} update={update} />
                )}
                {section === 'memory' && <MemorySection />}
                {section === 'skills' && <SkillsSection />}
                {section === 'plugins' && <PluginsSection />}
                {section === 'hooks' && <HooksSection onDirty={setHooksDirty} />}
                {section === 'schedules' && <SchedulesSection />}
                {!data && !error && section !== 'general' && section !== 'appearance' && (
                  <div className="flex items-center gap-2 text-body text-muted">
                    <LoaderCircle className="size-4 animate-spin" /> {copy.settings.page.loading}
                  </div>
                )}
              </SettingTargetProvider>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      <AnimatePresence>
        {leaving && (
          <Sheet title={copy.settings.page.unsaved.title} onClose={() => setLeaving(undefined)} size="sm">
            <p className="text-reading leading-relaxed text-fg-2">{copy.settings.page.unsaved.body}</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="borderless" onClick={() => setLeaving(undefined)}>
                {copy.settings.page.unsaved.keep}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setLeaving(undefined)
                  setHooksDirty(false)
                  leaving()
                }}
              >
                {copy.settings.page.unsaved.discard}
              </Button>
            </div>
          </Sheet>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * The settings as the server has them, and the autosave every section uses: edits apply on the page at once and are
 * saved shortly after (toggles at once). Also used by the setup assistant, which shows some of the same sections.
 */
export function useSettingsData(onModelsChanged: () => void) {
  const toast = useToast()
  const [data, setData] = useState<SettingsResponse>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [saveError, setSaveError] = useState<string>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The settings last sent, so a failed save can be retried as it was.
  const unsaved = useRef<ServerSettings>(undefined)
  const changed = useRef(onModelsChanged)
  changed.current = onModelsChanged

  useEffect(() => {
    api<SettingsResponse>('/api/settings')
      .then(setData)
      .catch((err) => setError(String(err.message ?? err)))
  }, [])

  const persist = (next: ServerSettings): Promise<boolean> => {
    unsaved.current = next
    setSaving('saving')
    return send<{ settings: ServerSettings }>('PUT', '/api/settings', next)
      .then((r) => {
        setData((d) => (d ? { ...d, settings: r.settings } : d))
        setSaving('saved')
        setTimeout(() => setSaving((v) => (v === 'saved' ? 'idle' : v)), 1200)
        changed.current()
        window.dispatchEvent(new Event(SETTINGS_SAVED))
        return true
      })
      .catch((err) => {
        // The page still shows the edit, so the header keeps saying it is not saved until a retry works.
        setSaving('failed')
        setSaveError(String(err.message ?? err))
        toast(String(err.message ?? err), 'error')
        return false
      })
  }

  /** Autosave: edits apply in the UI at once and persist shortly after (or immediately for toggles). */
  const update = (patch: (s: ServerSettings) => ServerSettings, immediate = false) => {
    if (!data) return
    const next = patch(structuredClone(data.settings))
    setData({ ...data, settings: next })
    clearTimeout(timer.current)
    if (immediate) void persist(next)
    else timer.current = setTimeout(() => void persist(next), 450)
  }

  /** An edit saved at once, for what must be on the server before the next request (voice on before an install). */
  const saveNow = (patch: (s: ServerSettings) => ServerSettings): Promise<boolean> => {
    if (!data) return Promise.resolve(false)
    const next = patch(structuredClone(data.settings))
    setData({ ...data, settings: next })
    clearTimeout(timer.current)
    return persist(next)
  }

  const providersChanged = (providers: ProviderInfo[]) => {
    setData((d) => (d ? { ...d, providers } : d))
    changed.current()
  }

  /** A model removed on the server: its answer carries the settings and providers as they now are. */
  const modelsRemoved = (settings: SettingsResponse['settings'], providers: ProviderInfo[]) =>
    setData((d) => (d ? { ...d, settings, providers } : d))

  const retry = () => {
    if (unsaved.current) void persist(unsaved.current)
  }

  return { data, error, saving, saveError, retry, update, saveNow, providersChanged, modelsRemoved }
}

/** Ghost-text suggestions in the composer (this browser only). */
function SuggestToggle() {
  const [on, setOn] = usePersistentFlag(SUGGEST_KEY, true)
  return (
    <SettingField id="general.suggest" inline>
      <Switch checked={on} label={copy.settings.general.suggest} onChange={setOn} />
    </SettingField>
  )
}

/** Desktop notifications when a round finishes while Myrmidon is in the background (this browser only). */
function NotifyToggle() {
  const toast = useToast()
  // The desktop app posts native notifications, which macOS asks about itself the first time.
  const shell = !!desktop()
  const supported = shell || typeof Notification !== 'undefined'
  const [on, setOn] = usePersistentFlag(NOTIFY_KEY, false)
  const granted = shell || (supported && Notification.permission === 'granted')
  return (
    <SettingField
      id="general.notifications"
      {...(supported ? {} : { hint: copy.settings.notify.unsupported })}
      inline
    >
      <Switch
        checked={on && granted}
        disabled={!supported}
        label={copy.settings.notify.label}
        onChange={(v) => {
          if (!v) return setOn(false)
          if (shell) return setOn(true)
          void Notification.requestPermission().then((p) => {
            setOn(p === 'granted')
            if (p !== 'granted') toast(copy.settings.notify.blocked, 'error')
          })
        }}
      />
    </SettingField>
  )
}

/** Light, dark, or as the system has it; also on the setup assistant's Welcome. */
export function ThemePicker(props: { theme: ThemeChoice; onTheme(t: ThemeChoice): void }) {
  return (
    <Segmented
      id="theme"
      value={props.theme}
      onChange={props.onTheme}
      options={[
        {
          value: 'system',
          label: (
            <>
              <Monitor className="size-3.5" /> {copy.settings.general.themeSystem}
            </>
          ),
        },
        {
          value: 'light',
          label: (
            <>
              <Sun className="size-3.5" /> {copy.settings.general.themeLight}
            </>
          ),
        },
        {
          value: 'dark',
          label: (
            <>
              <Moon className="size-3.5" /> {copy.settings.general.themeDark}
            </>
          ),
        },
      ]}
    />
  )
}

function General(props: {
  reduceMotion: boolean
  onReduceMotion(v: boolean): void
  data: SettingsResponse | undefined
  update(p: (s: ServerSettings) => ServerSettings, immediate?: boolean): void
  onRunSetup?(): void
  onOpenSetupStep?(step: SetupStep): void
}) {
  const m = copy.settings.mascot
  const titles = props.data?.settings.profile?.titles ?? 'model'
  return (
    <>
      <PageHeader title={copy.settings.general.title}>{copy.settings.general.intro}</PageHeader>
      <Card>
        <SettingField id="general.reduceMotion" inline>
          <Switch
            checked={props.reduceMotion}
            onChange={props.onReduceMotion}
            label={copy.settings.general.reduceMotion}
          />
        </SettingField>
        <NotifyToggle />
        <SuggestToggle />
        {props.data && (
          <SettingField id="general.chatNames" hint={m.titlesHints[titles]} inline>
            <Segmented
              id="titles"
              value={titles}
              options={[
                { value: 'model', label: m.titlesModel },
                { value: 'first-message', label: m.titlesFirst },
              ]}
              onChange={(next) =>
                props.update(
                  (s) => ({ ...s, profile: { greeting: 'model', ...s.profile, titles: next } }),
                  true,
                )
              }
            />
          </SettingField>
        )}
        {props.onRunSetup && (
          <SettingField id="general.setup" inline>
            <Button icon={<FEATURE_ICONS.setup className="size-3.5" />} onClick={props.onRunSetup}>
              {copy.settings.general.runSetup}
            </Button>
          </SettingField>
        )}
        {props.onOpenSetupStep && (
          <SettingField id="general.setupStep">
            <div className="flex flex-wrap gap-1.5">
              {SETUP_STEPS.filter((s) => s !== 'welcome').map((s) => (
                <Button key={s} size="sm" onClick={() => props.onOpenSetupStep?.(s)}>
                  {copy.setup.steps[s]}
                </Button>
              ))}
            </div>
          </SettingField>
        )}
      </Card>
    </>
  )
}

function ModelsSection(props: {
  models: ModelOption[]
  settings: ServerSettings
  providers: ProviderInfo[]
  config?: TeamConfig
  onConfig(c: TeamConfig): void
  /** A model was removed: the settings and providers as the server has them now. */
  onRemoved(settings: ServerSettings, providers: ProviderInfo[]): void
  update(p: (s: ServerSettings) => ServerSettings, immediate?: boolean): void
  onRefresh(): void
  onAddProvider(): void
}) {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [tests, setTests] = useState<Record<string, 'running' | { ok: boolean; text: string }>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [hiddenOpen, setHiddenOpen] = useState(false)
  // Search jumping to a model unfolds the list it is in.
  const target = useSettingTarget('models.model')
  const targetModel = props.models.find((x) => x.ref === target?.key)
  useEffect(() => {
    if (!targetModel) return
    if (props.settings.models.hidden.includes(targetModel.ref)) setHiddenOpen(true)
    else setOpen((o) => ({ ...o, [targetModel.provider]: true }))
  }, [targetModel, props.settings.models.hidden])
  const hidden = new Set(props.settings.models.hidden)
  const hiddenProviders = new Set(props.settings.models.hiddenProviders)
  const q = query.trim().toLowerCase()
  // A removed model leaves its provider's list for Hidden models, where it can be restored.
  const groups = useMemo(() => {
    const removed = new Set(props.settings.models.hidden)
    const by = new Map<string, ModelOption[]>()
    for (const m of props.models) {
      if (removed.has(m.ref) || (q && !`${m.ref} ${m.name}`.toLowerCase().includes(q))) continue
      by.set(m.provider, [...(by.get(m.provider) ?? []), m])
    }
    return [...by].sort(([a], [b]) => a.localeCompare(b))
  }, [props.models, q, props.settings.models.hidden])
  const hiddenModels = props.models.filter(
    (m) => hidden.has(m.ref) && (!q || `${m.ref} ${m.name}`.toLowerCase().includes(q)),
  )
  const shown = props.models.filter((m) => !hidden.has(m.ref) && !hiddenProviders.has(m.provider)).length
  /** A custom endpoint's model leaves its list; any other model, or an endpoint's only one, is hidden. */
  const deletes = (m: ModelOption) => {
    const ids = props.providers.find((p) => p.id === m.provider && p.custom)?.modelIds ?? []
    return ids.length > 1 && ids.includes(m.id)
  }
  const remove = async (m: ModelOption) => {
    try {
      const r = await send<{
        removed: 'deleted' | 'hidden'
        cleared: ('lead' | 'crewmates' | 'reviewer' | 'call' | 'titles')[]
        lead?: string
        titles?: string
        settings: ServerSettings
        providers: ProviderInfo[]
      }>('POST', '/api/models/remove', { ref: m.ref })
      const lead = r.lead
      const moved = lead && props.config ? withoutModel(props.config, m.ref, lead) : undefined
      const leadMoved = r.cleared.includes('lead') || (!!moved && moved.leadModel !== props.config?.leadModel)
      if (moved) props.onConfig(moved)
      props.onRemoved(r.settings, r.providers)
      const name = (ref: string) => props.models.find((x) => x.ref === ref)?.name ?? ref
      toast(
        [
          r.removed === 'deleted'
            ? copy.settings.models.removedDeleted(m.name, m.provider)
            : copy.settings.models.removedHidden(m.name),
          leadMoved && lead && copy.settings.models.nowLeads(name(lead)),
          r.cleared.includes('titles') && r.titles && copy.settings.models.nowNames(name(r.titles)),
        ]
          .filter(Boolean)
          .join(' '),
        'success',
      )
    } catch (err) {
      toast(String((err as Error).message ?? err), 'error')
    }
  }
  const inUse = (m: ModelOption) => {
    const users = usersOf(m.ref, props.config, props.settings)
    if (!users.length) return undefined
    const who = new Intl.ListFormat('en').format(users.map((u) => copy.settings.models.users[u]))
    return copy.settings.models.inUse(who, users.length > 1 || users[0] === 'crewmates')
  }

  const test = async (ref: string) => {
    setTests((t) => ({ ...t, [ref]: 'running' }))
    try {
      const r = await send<{ ok: boolean; ms?: number; error?: string }>('POST', '/api/models/test', { ref })
      setTests((t) => ({
        ...t,
        [ref]: {
          ok: r.ok,
          text: r.ok ? copy.settings.models.testMs(r.ms) : (r.error ?? copy.settings.models.testFailed),
        },
      }))
    } catch (err) {
      setTests((t) => ({ ...t, [ref]: { ok: false, text: String((err as Error).message) } }))
    }
  }
  const toggleSet = (key: 'hidden' | 'hiddenProviders', value: string) =>
    props.update((s) => {
      const set = new Set(s.models[key])
      if (set.has(value)) set.delete(value)
      else set.add(value)
      s.models[key] = [...set]
      return s
    }, true)

  return (
    <>
      <PageHeader title={copy.settings.models.title}>
        {copy.settings.models.intro(props.models.length, shown)}
      </PageHeader>
      <div className="mb-3 flex gap-2">
        <div {...settingRow('models.filter')} className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <TextInput
            placeholder={copy.settings.models.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
            aria-label={copy.settings.models.search}
          />
        </div>
        <Button
          {...settingRow('models.refresh')}
          onClick={() => {
            setRefreshing(true)
            api('/api/models?refresh=1')
              .then(() => {
                props.onRefresh()
                toast(copy.settings.models.refreshed, 'success')
              })
              .catch((err) => toast(String(err.message ?? err), 'error'))
              .finally(() => setRefreshing(false))
          }}
          loading={refreshing}
          icon={<RefreshCw className="size-3.5" />}
        >
          {copy.settings.models.refresh}
        </Button>
        <Button
          {...settingRow('models.add')}
          variant="primary"
          onClick={props.onAddProvider}
          icon={<Plus className="size-3.5" />}
        >
          {copy.settings.models.addModels}
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {groups.length === 0 && (
          <Card>
            <Empty title={q ? copy.settings.models.noMatch : copy.settings.models.none} />
          </Card>
        )}
        {groups.map(([provider, models]) => {
          const off = hiddenProviders.has(provider)
          const expanded = open[provider] ?? (!!q || models.length <= 20)
          return (
            <Card key={provider}>
              <div
                {...settingItem('models.provider', provider)}
                className="flex items-center gap-3 px-4 py-2.5"
              >
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [provider]: !expanded }))}
                  aria-expanded={expanded}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={spring}>
                    <ChevronRight className="size-4 text-muted" />
                  </motion.span>
                  {/* Off reads in the muted ink rather than a faded card, which would drop below AA contrast. */}
                  <span className={cn('font-mono text-body font-medium', off && 'text-muted')}>
                    {provider}
                  </span>
                  <span className="text-small tabular-nums text-muted">{models.length}</span>
                </button>
                <span className="text-small text-muted">
                  {off ? copy.settings.shared.off : copy.settings.models.inPickers}
                </span>
                <Switch
                  checked={!off}
                  label={copy.settings.models.showProvider(provider)}
                  onChange={() => toggleSet('hiddenProviders', provider)}
                />
              </div>
              {expanded && (
                <div className="max-h-[46vh] overflow-auto">
                  {models.map((m) => {
                    const t = tests[m.ref]
                    return (
                      <div
                        key={m.ref}
                        {...settingItem('models.model', m)}
                        className="group/model flex items-center gap-3 py-2 pl-10 pr-4"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-body font-medium">{m.name}</span>
                            {m.reasoning && <FEATURE_ICONS.thinking className="size-3.5 text-muted" />}
                          </div>
                          <div className="truncate font-mono text-caption text-muted">{m.id}</div>
                          {t && t !== 'running' && (
                            <div
                              className={cn(
                                'mt-0.5 flex items-center gap-1 text-small',
                                t.ok ? 'text-ok-ink' : 'text-bad-ink',
                              )}
                            >
                              {t.ok ? <CircleCheck className="size-3.5" /> : <CircleX className="size-3.5" />}
                              <span className="truncate">
                                {t.ok ? copy.settings.models.respondedIn(t.text) : t.text}
                              </span>
                            </div>
                          )}
                        </div>
                        {/* An armed Remove takes their room for what it says about the removal. */}
                        <span className="contents group-has-[[data-armed]]/model:hidden">
                          <WindowField
                            model={m}
                            set={props.settings.models.windows?.[m.ref]}
                            onSet={(tokens) =>
                              props.update((s) => {
                                const windows = { ...s.models.windows }
                                if (tokens) windows[m.ref] = tokens
                                else delete windows[m.ref]
                                return { ...s, models: { ...s.models, windows } }
                              }, true)
                            }
                          />
                          <Button
                            size="sm"
                            variant="borderless"
                            onClick={() => void test(m.ref)}
                            loading={t === 'running'}
                          >
                            {copy.settings.models.test}
                          </Button>
                        </span>
                        <ConfirmButton
                          icon={deletes(m) ? true : <FEATURE_ICONS.hiddenModels className="size-4" />}
                          label={copy.settings.models.remove(m.name)}
                          title={
                            deletes(m)
                              ? copy.settings.models.removeDeleteTitle(m.provider)
                              : copy.settings.models.removeHideTitle
                          }
                          confirm={copy.settings.models.confirmRemove}
                          warning={inUse(m)}
                          onConfirm={() => void remove(m)}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>
          )
        })}
        {hiddenModels.length > 0 && (
          <Card>
            <button
              type="button"
              {...settingRow('models.hidden')}
              onClick={() => setHiddenOpen((o) => !o)}
              aria-expanded={hiddenOpen}
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
            >
              <motion.span animate={{ rotate: hiddenOpen ? 90 : 0 }} transition={spring}>
                <ChevronRight className="size-4 text-muted" />
              </motion.span>
              <FEATURE_ICONS.hiddenModels className="size-4 text-muted" />
              <span className="text-body font-medium">
                {copy.settings.models.hiddenHeading(hiddenModels.length)}
              </span>
            </button>
            {hiddenOpen && (
              <div className="max-h-[46vh] overflow-auto">
                {hiddenModels.map((m) => (
                  <div
                    key={m.ref}
                    {...settingItem('models.model', m)}
                    className="flex items-center gap-3 py-2 pl-10 pr-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body font-medium text-fg-2">{m.name}</div>
                      <div className="truncate font-mono text-caption text-muted">{m.ref}</div>
                    </div>
                    <Button
                      size="sm"
                      variant="borderless"
                      aria-label={copy.settings.models.restoreLabel(m.name)}
                      onClick={() => toggleSet('hidden', m.ref)}
                    >
                      {copy.settings.models.restore}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  )
}

const WINDOW_SOURCES = {
  set: copy.settings.models.windowSources.set,
  provider: copy.settings.models.windowSources.provider,
  catalog: copy.settings.models.windowSources.catalog,
  name: copy.settings.models.windowSources.name,
} as const

/**
 * A model's context window, editable in thousands of tokens. Most come from the provider or models.dev; a model with
 * no source shows a guess, which is worth correcting here so long chats are summarized in time.
 */
function WindowField(props: { model: ModelOption; set?: number; onSet(tokens?: number): void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLInputElement>(null)
  // Opening the editor selects the value, so typing replaces it.
  useEffect(() => {
    if (editing) field.current?.select()
  }, [editing])
  const tokens = props.set ?? props.model.contextWindow
  const source = props.set ? 'set' : props.model.windowSource
  const commit = () => {
    setEditing(false)
    const text = draft.trim().toLowerCase()
    if (!text) return props.onSet(undefined)
    const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(text.replace(/,/g, ''))
    if (!m) return
    const n = Number(m[1])
    // People think in K and M; a bare number of 1024 or more is taken as tokens.
    const value = m[2] === 'm' ? n * 1_000_000 : m[2] === 'k' || n < 1024 ? n * 1000 : n
    if (value >= 1024) props.onSet(Math.round(value))
  }
  if (editing)
    return (
      <input
        ref={field}
        value={draft}
        placeholder={copy.settings.models.windowPlaceholder}
        aria-label={copy.settings.models.windowLabel(props.model.name)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="h-7 w-20 rounded-md border border-line-strong bg-control px-2 text-right font-mono text-small outline-none focus:ring-2 focus:ring-accent-soft"
      />
    )
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(tokens ? windowLabel(tokens).toLowerCase() : '')
        setEditing(true)
      }}
      title={
        tokens
          ? copy.settings.models.windowTitle(
              tokens.toLocaleString(),
              source ? WINDOW_SOURCES[source] : copy.settings.models.windowGuess,
            )
          : copy.settings.models.windowUnknown
      }
      className={cn(
        'h-7 min-w-14 rounded-md px-2 text-right font-mono text-small tabular-nums transition-colors hover:bg-fill',
        tokens && tokens < AGENT_MIN_WINDOW ? 'text-warn-ink' : 'text-fg-2',
        source === 'set' && 'font-semibold',
      )}
    >
      {tokens ? windowLabel(tokens) : '—'}
      {tokens && !source ? '?' : ''}
    </button>
  )
}

export interface LoginOption {
  id: string
  name: string
  provider: string
  ready: boolean
  /** Myrmidon holds an OAuth sign-in for the provider, not only an API key. */
  signedIn: boolean
}

interface LoginState {
  id: string
  login: string
  status: 'waiting' | 'done' | 'failed' | 'cancelled'
  url?: string
  instructions?: string
  prompt?: { message: string; placeholder?: string }
  progress?: string
  result?: { email?: string; orgName?: string }
  error?: string
}

/** Subscription sign-ins listed first; the rest sit behind "More". */
const FEATURED_LOGINS = [
  'anthropic',
  'openai-codex',
  'google-gemini-cli',
  'google-antigravity',
  'github-copilot',
]

/** Sign in with a subscription (Claude Pro/Max, ChatGPT, Gemini, Copilot…) through omp's OAuth flows. */
function SignIns(props: { onProviders(p: ProviderInfo[]): void }) {
  const toast = useToast()
  const [logins, setLogins] = useState<LoginOption[]>()
  const [session, setSession] = useState<LoginState>()
  const [answer, setAnswer] = useState('')
  const [more, setMore] = useState(false)
  // Search jumping to a sign-in behind "More" shows them all.
  const target = useSettingTarget('providers.signIn')
  useEffect(() => {
    if (target) setMore(true)
  }, [target])

  const load = () =>
    api<{ logins: LoginOption[] }>('/api/logins')
      .then((r) => setLogins(r.logins))
      .catch(() => setLogins([]))
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    void load()
  }, [])

  const waiting = session?.status === 'waiting'
  const sessionId = session?.id
  // biome-ignore lint/correctness/useExhaustiveDependencies: polls while one sign-in is open
  useEffect(() => {
    if (!waiting || !sessionId) return
    const t = setInterval(async () => {
      const next = await api<LoginState>(`/api/logins/${sessionId}`).catch(() => undefined)
      if (!next) return
      setSession(next)
      if (next.status === 'done') {
        const who = next.result?.email ?? next.result?.orgName
        toast(copy.settings.signIns.signedInToast(who), 'success')
        void load()
        api<{ providers: ProviderInfo[] }>('/api/settings')
          .then((r) => props.onProviders(r.providers))
          .catch(() => {})
      } else if (next.status === 'failed') toast(next.error ?? copy.settings.signIns.failed, 'error')
    }, 1500)
    return () => clearInterval(t)
  }, [waiting, sessionId])

  // Only the sign-in goes: an API key stored for the same provider stays.
  const signOut = async (l: LoginOption) => {
    try {
      const r = await send<{ providers: ProviderInfo[]; logins: LoginOption[] }>(
        'DELETE',
        `/api/credentials/${encodeURIComponent(l.provider)}/oauth`,
      )
      props.onProviders(r.providers)
      setLogins(r.logins)
      toast(copy.settings.signIns.signedOut(l.name), 'success')
    } catch (err) {
      toast(String((err as Error).message), 'error')
    }
  }

  const start = async (login: string) => {
    setAnswer('')
    try {
      const state = await send<LoginState>('POST', '/api/logins', { login })
      setSession(state)
      if (state.url) window.open(state.url, '_blank', 'noopener')
    } catch (err) {
      toast(String((err as Error).message), 'error')
    }
  }

  if (!logins?.length) return null
  const rank = (l: LoginOption) => {
    const i = FEATURED_LOGINS.indexOf(l.id)
    return i === -1 ? FEATURED_LOGINS.length : i
  }
  const sorted = [...logins].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  const shown = more ? sorted : sorted.filter((l) => l.ready || FEATURED_LOGINS.includes(l.id))

  return (
    <div {...settingRow('providers.signIns')} className="mb-8">
      <SectionHeader
        className="mb-2"
        icon={<LogIn className="size-4 text-muted" />}
        title={copy.settings.signIns.title}
        note={copy.settings.signIns.subtitle}
      />
      <Card>
        {shown.map((l) => {
          const active = session?.login === l.id && session.status === 'waiting' ? session : undefined
          return (
            <div
              key={l.id}
              {...settingItem('providers.signIn', l)}
              className="border-b border-line px-4 py-3 last:border-0"
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-reading font-medium">
                    {l.name}
                    {l.ready ? <Badge tone="ok">{copy.settings.signIns.signedIn}</Badge> : null}
                  </div>
                  <div className="font-mono text-footnote text-muted">{l.provider}</div>
                </div>
                {active ? (
                  <Button
                    size="sm"
                    variant="borderless"
                    onClick={() =>
                      send('DELETE', `/api/logins/${active.id}`).then(() => setSession(undefined))
                    }
                  >
                    {copy.settings.shared.cancel}
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    {l.signedIn && (
                      <ConfirmButton
                        label={copy.settings.signIns.signOut}
                        confirm={copy.settings.signIns.confirmSignOut(l.name)}
                        disabled={waiting}
                        onConfirm={() => void signOut(l)}
                      />
                    )}
                    <Button
                      size="sm"
                      onClick={() => start(l.id)}
                      disabled={waiting}
                      icon={<LogIn className="size-3.5" />}
                    >
                      {l.ready ? copy.settings.signIns.signInAgain : copy.settings.signIns.signIn}
                    </Button>
                  </div>
                )}
              </div>
              {active && (
                <div className="mt-3 space-y-2.5 rounded-lg border border-line bg-fill p-3 text-callout">
                  <div className="flex items-center gap-2 text-fg-2">
                    <LoaderCircle className="size-3.5 animate-spin" />
                    {active.progress ?? copy.settings.signIns.finishInBrowser}
                  </div>
                  {active.instructions && <div className="text-muted">{active.instructions}</div>}
                  {active.url && (
                    <a
                      href={active.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 font-medium text-accent-fg hover:underline"
                    >
                      <ExternalLink className="size-3.5" /> {copy.settings.signIns.openPage}
                    </a>
                  )}
                  {active.prompt && (
                    <form
                      className="flex gap-2"
                      onSubmit={async (e) => {
                        e.preventDefault()
                        if (!answer.trim()) return
                        setSession(await send<LoginState>('POST', `/api/logins/${active.id}`, { answer }))
                        setAnswer('')
                      }}
                    >
                      <TextInput
                        aria-label={active.prompt.message}
                        placeholder={active.prompt.placeholder ?? active.prompt.message}
                        value={answer}
                        onChange={(e) => setAnswer(e.target.value)}
                        className="font-mono"
                      />
                      <Button size="sm" type="submit" disabled={!answer.trim()}>
                        {copy.settings.signIns.submit}
                      </Button>
                    </form>
                  )}
                  {active.prompt && <div className="text-muted">{active.prompt.message}</div>}
                </div>
              )}
            </div>
          )
        })}
      </Card>
      {sorted.length > shown.length && (
        <button
          type="button"
          onClick={() => setMore(true)}
          className="mt-2 text-callout font-medium text-muted hover:text-fg"
        >
          {copy.settings.signIns.showMore(sorted.length - shown.length)}
        </button>
      )}
    </div>
  )
}

export function Providers(props: {
  data: SettingsResponse
  onProviders(p: ProviderInfo[]): void
  update(p: (s: ServerSettings) => ServerSettings, immediate?: boolean): void
  /** Inside the setup assistant, which has its own heading and says where keys are kept itself. */
  embedded?: boolean
  /** Scrolled to the voice providers (from Settings → Voice). */
  focusVoice?: boolean
}) {
  const off = new Set(props.data.settings.models.hiddenProviders)
  const setOff = (id: string, hide: boolean) =>
    props.update(
      (s) => ({
        ...s,
        models: {
          ...s.models,
          hiddenProviders: hide
            ? [...new Set([...s.models.hiddenProviders, id])]
            : s.models.hiddenProviders.filter((x) => x !== id),
        },
      }),
      true,
    )
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [importing, setImporting] = useState<'idle' | 'confirm' | 'busy'>('idle')
  const providers = props.data.providers
  // Search jumping to a provider the short list leaves out shows them all.
  const target = useSettingTarget('providers.provider')
  useEffect(() => {
    if (target) setShowAll(true)
  }, [target])
  const shown = showAll ? providers : providers.filter((p) => p.ready || p.custom)
  const hiddenCount = providers.length - shown.length

  const act = async (run: () => Promise<{ providers: ProviderInfo[] }>, done: string) => {
    try {
      const r = await run()
      props.onProviders(r.providers)
      toast(done, 'success')
      return true
    } catch (err) {
      toast(String((err as Error).message), 'error')
      return false
    }
  }

  return (
    <>
      {!props.embedded && (
        <PageHeader title={copy.settings.providers.title}>{copy.settings.providers.intro}</PageHeader>
      )}
      {props.data.agentDir && !props.embedded && (
        <p className="-mt-4 mb-6 truncate font-mono text-footnote text-muted" title={props.data.agentDir}>
          {copy.settings.providers.storedIn(props.data.agentDir)}
        </p>
      )}

      {props.data.ompSetup && (
        <Card className="mb-8">
          <div {...settingRow('providers.import')} className="flex flex-wrap items-center gap-3 px-4 py-3.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-fg">
              <Download className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-reading font-medium">{copy.settings.providers.importTitle}</div>
              <div className="text-callout text-muted">
                {importing === 'confirm'
                  ? copy.settings.providers.importConfirm
                  : copy.settings.providers.importHint}
              </div>
            </div>
            {importing === 'confirm' ? (
              <div className="flex gap-2">
                <Button size="sm" variant="borderless" onClick={() => setImporting('idle')}>
                  {copy.settings.shared.cancel}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={async () => {
                    setImporting('busy')
                    await act(async () => {
                      const r = await send<{ copied: string[]; providers: ProviderInfo[] }>(
                        'POST',
                        '/api/import-omp',
                      )
                      return r
                    }, copy.settings.providers.imported)
                    setImporting('idle')
                  }}
                >
                  {copy.settings.providers.replaceAndImport}
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={() => setImporting('confirm')} loading={importing === 'busy'}>
                {copy.settings.providers.import}
              </Button>
            )}
          </div>
        </Card>
      )}

      <SignIns onProviders={props.onProviders} />

      <div {...settingRow('providers.list')} className="mb-2 flex items-center justify-between">
        <SectionHeader
          icon={<FEATURE_ICONS.providers className="size-4 text-muted" />}
          title={copy.settings.providers.heading}
          note={copy.settings.providers.readyCount(providers.filter((p) => p.ready).length, providers.length)}
        />
        {!adding && (
          <Button
            {...settingRow('providers.custom')}
            size="sm"
            onClick={() => setAdding(true)}
            icon={<Plus className="size-3.5" />}
          >
            {copy.settings.providers.customEndpoint}
          </Button>
        )}
      </div>
      <AnimatePresence>
        {adding && (
          <motion.div
            {...settingRow('providers.custom')}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={softSpring}
            className="overflow-hidden"
          >
            <ProviderForm
              existing={providers.map((p) => p.id)}
              apis={props.data.customApis}
              onCancel={() => setAdding(false)}
              onSave={async (body) => {
                if (
                  await act(
                    () => send<{ providers: ProviderInfo[] }>('POST', '/api/providers', body),
                    copy.settings.providers.connected(body.name),
                  )
                )
                  setAdding(false)
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <Card>
        {shown.length === 0 && (
          <Empty
            icon={<FEATURE_ICONS.providers className="size-5" />}
            title={copy.settings.providers.emptyTitle}
          >
            {copy.settings.providers.emptyBody}
          </Empty>
        )}
        {shown.map((p) => (
          <div key={p.id} {...settingItem('providers.provider', p)} className="px-4 py-2.5">
            <div className="flex items-center gap-3">
              <Dot status={p.ready ? 'ready' : 'idle'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-body">{p.id}</span>
                  {p.custom && <Badge tone="accent">{copy.settings.providers.custom}</Badge>}
                  <span className="text-small text-muted">
                    {copy.settings.providers.modelCount(p.models)}
                  </span>
                </div>
                {p.baseUrl && <div className="truncate font-mono text-footnote text-muted">{p.baseUrl}</div>}
              </div>
              <Button
                size="sm"
                variant="borderless"
                onClick={() => setEditing(editing === p.id ? undefined : p.id)}
              >
                {p.custom
                  ? copy.settings.providers.edit
                  : p.ready
                    ? copy.settings.providers.replaceKey
                    : copy.settings.providers.addKey}
              </Button>
              {p.ready && !p.custom && !p.stored && (
                <span className="flex items-center gap-2" title={copy.settings.providers.externalCredentials}>
                  <span className="text-footnote text-muted">
                    {off.has(p.id) ? copy.settings.shared.off : copy.settings.shared.on}
                  </span>
                  <Switch
                    checked={!off.has(p.id)}
                    onChange={(on) => setOff(p.id, !on)}
                    label={copy.settings.providers.use(p.id)}
                  />
                </span>
              )}
              {p.stored && !p.custom && (
                <ConfirmButton
                  icon
                  label={copy.settings.providers.removeCredentials(p.id)}
                  confirm={copy.settings.providers.confirmRemoveCredentials}
                  onConfirm={() =>
                    void act(
                      () => send<{ providers: ProviderInfo[] }>('DELETE', `/api/credentials/${p.id}`),
                      copy.settings.providers.removedCredentials(p.id),
                    )
                  }
                />
              )}
              {p.custom && (
                <ConfirmButton
                  icon
                  label={copy.settings.providers.remove(p.id)}
                  confirm={copy.settings.providers.confirmRemove}
                  onConfirm={() =>
                    void act(
                      () => send<{ providers: ProviderInfo[] }>('DELETE', `/api/providers/${p.id}`),
                      copy.settings.providers.removed(p.id),
                    )
                  }
                />
              )}
            </div>
            {editing === p.id && p.custom && (
              <div className="mt-3">
                <ProviderForm
                  initial={p}
                  existing={providers.map((x) => x.id)}
                  apis={props.data.customApis}
                  onCancel={() => setEditing(undefined)}
                  onSave={async ({ name: _name, ...body }) => {
                    if (
                      await act(
                        () => send<{ providers: ProviderInfo[] }>('PUT', `/api/providers/${p.id}`, body),
                        copy.settings.providers.updated(p.id),
                      )
                    )
                      setEditing(undefined)
                  }}
                />
              </div>
            )}
            {editing === p.id && !p.custom && (
              <KeyForm
                provider={p.id}
                onSave={async (apiKey) => {
                  if (
                    await act(
                      () =>
                        send<{ providers: ProviderInfo[] }>('PUT', `/api/credentials/${p.id}`, { apiKey }),
                      copy.settings.providers.savedKey(p.id),
                    )
                  )
                    setEditing(undefined)
                }}
              />
            )}
          </div>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full px-4 py-2.5 text-left text-callout text-muted hover:text-fg"
          >
            {copy.settings.providers.showMore(hiddenCount)}
          </button>
        )}
      </Card>
      <p className="mt-2 text-small text-muted">
        {copy.settings.providers.envBefore}
        <span className="font-mono">ANTHROPIC_API_KEY</span>
        {copy.settings.providers.envAfter}
      </p>
      {!props.embedded && <VoiceProviders focus={props.focusVoice ?? false} />}
    </>
  )
}

function KeyForm(props: { provider: string; onSave(key: string): Promise<void> }) {
  const [value, setValue] = useState('')
  return (
    <form
      className="mt-2 flex gap-2 pl-5"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim()) void props.onSave(value.trim())
      }}
    >
      <TextInput
        type="password"
        autoComplete="off"
        autoFocus
        placeholder={copy.settings.providers.apiKeyFor(props.provider)}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="flex-1"
        aria-label={copy.settings.providers.apiKeyFor(props.provider)}
      />
      <Button type="submit" variant="primary" disabled={!value.trim()}>
        {copy.settings.shared.save}
      </Button>
    </form>
  )
}

function ProviderForm(props: {
  initial?: ProviderInfo
  existing: string[]
  apis: Api[]
  onCancel(): void
  onSave(body: ProviderBody): Promise<void>
}) {
  const init = props.initial
  const editing = !!init
  const [name, setName] = useState(init?.id ?? '')
  const [apiType, setApiType] = useState<Api>(init?.api ?? 'openai-completions')
  const [baseUrl, setBaseUrl] = useState(init?.baseUrl ?? '')
  const [auth, setAuth] = useState<'key' | 'none'>(init?.keyless ? 'none' : 'key')
  const [key, setKey] = useState('')
  const [manual, setManual] = useState((init?.modelIds ?? []).join(', '))
  const [busy, setBusy] = useState(false)
  // A field's reason shows once the person has left it filled in, and every reason once Connect is pressed too early.
  const [tried, setTried] = useState(false)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const touch = (field: string) => (e: { target: { value: string } }) =>
    e.target.value && setTouched((t) => ({ ...t, [field]: true }))
  const formId = useId()
  const models = [...new Set(manual.split(/[\s,]+/).filter(Boolean))]
  const discovers = apiType === 'openai-completions' || apiType === 'openai-responses'
  const errors = {
    name: editing ? undefined : providerNameError(name, props.existing),
    baseUrl: baseUrlError(baseUrl),
    key:
      auth === 'none' || key.trim() || (editing && init?.hasKey)
        ? undefined
        : copy.settings.validation.keyRequired,
    models: discovers || models.length > 0 ? undefined : copy.settings.validation.modelsRequired,
  }
  const shown = (field: keyof typeof errors) => (tried || touched[field] ? errors[field] : undefined)
  return (
    <Card className={cn(!editing && 'mb-3', 'border-accent/30')}>
      <div className="grid gap-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={copy.settings.providerForm.name}
            hint={editing ? copy.settings.providerForm.nameFixed : copy.settings.providerForm.nameHint}
            error={shown('name')}
          >
            <TextInput
              value={name}
              disabled={editing}
              onBlur={touch('name')}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="lmstudio"
            />
          </Field>
          <Field label={copy.settings.providerForm.apiType}>
            <Select value={apiType} onChange={(e) => setApiType(e.target.value as Api)} className="w-full">
              {props.apis.map((a) => (
                <option key={a} value={a}>
                  {API_LABELS[a]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={copy.settings.providerForm.baseUrl} error={shown('baseUrl')}>
          <TextInput
            type="url"
            value={baseUrl}
            onBlur={touch('baseUrl')}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={API_HINT_URL[apiType]}
          />
        </Field>
        <div className="flex flex-wrap items-end gap-4">
          <Field label={copy.settings.providerForm.authentication}>
            <Segmented
              id={`auth-${init?.id ?? 'new'}`}
              value={auth}
              onChange={setAuth}
              options={[
                { value: 'key', label: copy.settings.providerForm.apiKey },
                { value: 'none', label: copy.settings.providerForm.keyless },
              ]}
            />
          </Field>
          {auth === 'key' && (
            <div className="min-w-56 flex-1">
              <TextInput
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={
                  editing && init?.hasKey
                    ? copy.settings.providerForm.keySaved
                    : copy.settings.providerForm.apiKey
                }
                aria-label={copy.settings.providerForm.apiKey}
                aria-invalid={tried && !!errors.key}
                aria-describedby={tried && errors.key ? `${formId}key-error` : undefined}
              />
            </div>
          )}
        </div>
        {tried && errors.key && (
          <p id={`${formId}key-error`} className="-mt-2 text-small leading-snug text-bad-ink">
            {errors.key}
          </p>
        )}
        <Field
          label={copy.settings.providerForm.models}
          hint={
            discovers ? copy.settings.providerForm.modelsDiscoverHint : copy.settings.providerForm.modelsHint
          }
          error={tried ? errors.models : undefined}
        >
          <TextArea
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="qwen3-8b, llama-3.3-70b"
            className="min-h-16 font-mono"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="borderless" onClick={props.onCancel}>
            {copy.settings.shared.cancel}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              if (Object.values(errors).some(Boolean)) return setTried(true)
              setBusy(true)
              await props.onSave({
                name,
                api: apiType,
                baseUrl: baseUrl.trim(),
                ...(auth === 'key' && key.trim() ? { apiKey: key.trim() } : {}),
                keyless: auth === 'none',
                models,
              })
              setBusy(false)
            }}
          >
            {editing ? copy.settings.providerForm.saveChanges : copy.settings.providerForm.connect}
            {models.length ? copy.settings.providerForm.modelCount(models.length) : ''}
          </Button>
        </div>
      </div>
    </Card>
  )
}

/** The settings with `config`'s crew as the default every new chat starts with. */
export function withDefaultCrew(s: ServerSettings, c: TeamConfig): ServerSettings {
  s.team = {
    ...s.team,
    mode: c.mode,
    workers: c.roster.length,
    leadModel: c.leadModel,
    ...(c.roster[0] ? { workerModel: c.roster[0].model } : {}),
    judgeModel: c.judgeModel,
  }
  return s
}

function TeamSection(props: {
  data: SettingsResponse
  update(p: (s: ServerSettings) => ServerSettings): void
  models: ModelOption[]
  config?: TeamConfig
  onConfig(c: TeamConfig): void
}) {
  const t = props.data.settings.team
  return (
    <>
      <PageHeader title={copy.settings.team.title}>{copy.settings.team.intro}</PageHeader>
      {props.config && (
        <>
          <SectionHeader as="h3" className="mb-2" title={copy.settings.team.crewTitle} />
          <Card className="mb-8">
            <div className="p-4">
              <TeamSettings
                placement="down"
                models={props.models}
                config={props.config}
                onConfig={(c) => {
                  props.onConfig(c)
                  props.update((s) => withDefaultCrew(s, c))
                }}
              />
            </div>
          </Card>
        </>
      )}
      <SectionHeader as="h3" className="mb-2" title={copy.settings.team.limitsTitle} />
      <Card className="mb-8">
        <SettingField id="team.wallMinutes" inline>
          <NumberField
            label={copy.settings.team.timeLimit}
            value={t.wallMinutes}
            min={1}
            max={240}
            suffix={copy.settings.team.units.minutes}
            onChange={(v) => props.update((s) => ({ ...s, team: { ...s.team, wallMinutes: v } }))}
          />
        </SettingField>
        <SettingField id="team.costUsd" inline>
          <NumberField
            label={copy.settings.team.spendLimit}
            value={t.costUsd}
            min={0}
            max={1000}
            step={0.1}
            suffix={copy.settings.team.units.dollars}
            onChange={(v) => props.update((s) => ({ ...s, team: { ...s.team, costUsd: v } }))}
          />
        </SettingField>
        <SettingField id="team.tokens" inline>
          <NumberField
            label={copy.settings.team.tokenLimit}
            value={t.tokens}
            min={0}
            max={1_000_000_000}
            suffix={copy.settings.team.units.tokens}
            wide
            onChange={(v) => props.update((s) => ({ ...s, team: { ...s.team, tokens: v } }))}
          />
        </SettingField>
        <SettingField id="team.maxTurns" inline>
          <NumberField
            label={copy.settings.team.turns}
            value={t.maxTurns}
            min={1}
            max={200}
            onChange={(v) => props.update((s) => ({ ...s, team: { ...s.team, maxTurns: v } }))}
          />
        </SettingField>
        <SettingField id="team.observer" inline>
          <NumberField
            label={copy.settings.team.observer}
            value={props.data.settings.observer.intervalSeconds}
            min={10}
            max={600}
            suffix={copy.settings.team.units.seconds}
            onChange={(v) => props.update((s) => ({ ...s, observer: { intervalSeconds: v } }))}
          />
        </SettingField>
      </Card>
      <ReviewerSettings settings={props.data.settings} update={props.update} />
    </>
  )
}

/**
 * A number with limits. Typing applies each value inside the limits at once; leaving the box keeps an out-of-range
 * value at the nearest limit and an empty one at what it was, and while the value is outside them the box says so.
 */
export function NumberField(props: {
  label: string
  value: number
  min: number
  max: number
  suffix?: string
  step?: number
  /** For values with many digits, such as token counts. */
  wide?: boolean
  onChange(v: number): void
}) {
  const id = useId()
  const [draft, setDraft] = useState<string>()
  const text = draft ?? String(props.value)
  const n = Number(text)
  const ok = !!text.trim() && Number.isFinite(n) && n >= props.min && n <= props.max
  const range = copy.settings.validation.range(props.min.toLocaleString(), props.max.toLocaleString())
  const commit = () => {
    if (draft === undefined) return
    const next = clampNumber(draft, props.min, props.max, props.value)
    setDraft(undefined)
    if (next !== props.value) props.onChange(next)
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex items-center gap-2">
        <TextInput
          type="number"
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={text}
          aria-label={props.label}
          aria-invalid={!ok}
          aria-describedby={ok ? undefined : id}
          title={range}
          onChange={(e) => {
            const value = e.target.value
            setDraft(value)
            const v = Number(value)
            if (value.trim() && Number.isFinite(v) && v >= props.min && v <= props.max) props.onChange(v)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
          className={`${props.wide ? 'w-32' : 'w-24'} text-right tabular-nums`}
        />
        {props.suffix && <span className="w-7 text-callout text-muted">{props.suffix}</span>}
      </div>
      {!ok && (
        <p id={id} className="text-small text-warn-ink">
          {range}
        </p>
      )}
    </div>
  )
}

/** Whether a folder the person typed is, or lies inside, one of the guarded paths (their keys, Myrmidon's data). */
function opensGuarded(folder: string, guarded: readonly string[]): boolean {
  const f = folder.trim().replace(/\/+$/, '')
  return guarded.some((g) => f === g || f.startsWith(`${g}/`))
}

/** The folders sandboxed agents may read in every chat, beyond the project and their own files. */
function SandboxReads(props: {
  data: SettingsResponse
  update(p: (s: ServerSettings) => ServerSettings, immediate?: boolean): void
}) {
  const t = copy.settings.tools.reads
  const sandbox = props.data.settings.sandbox ?? {}
  const [text, setText] = useState((sandbox.read ?? []).join('\n'))
  const folders = text
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
  const guarded = folders.filter((f) => opensGuarded(f, props.data.guardedReads ?? []))
  return (
    <>
      <SectionHeader
        className="mb-2"
        icon={<FEATURE_ICONS.readAccess className="size-4 text-muted" />}
        title={t.title}
        note={t.subtitle}
      />
      <Card className="mb-6">
        <CardRow {...settingRow('permissions.readHome')}>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-reading font-medium">{setting('permissions.readHome').label}</div>
              <div className="text-callout text-muted">{setting('permissions.readHome').help}</div>
            </div>
            <Switch
              checked={!!sandbox.readHome}
              label={t.home}
              onChange={(v) => props.update((s) => ({ ...s, sandbox: { ...s.sandbox, readHome: v } }), true)}
            />
          </div>
        </CardRow>
        <CardRow {...settingRow('permissions.readFolders')}>
          <Field label={setting('permissions.readFolders').label}>
            <TextArea
              value={text}
              onChange={(e) => {
                const next = e.target.value
                setText(next)
                const read = next
                  .split('\n')
                  .map((f) => f.trim())
                  .filter(Boolean)
                props.update((s) => ({ ...s, sandbox: { ...s.sandbox, read } }))
              }}
              rows={3}
              placeholder={t.foldersPlaceholder}
              className="font-mono"
            />
          </Field>
          {guarded.length > 0 && <p className="mt-2 text-callout text-warn-ink">{t.guarded(guarded)}</p>}
        </CardRow>
      </Card>
    </>
  )
}

function ToolsSection(props: {
  data: SettingsResponse
  update(p: (s: ServerSettings) => ServerSettings, immediate?: boolean): void
  onPermissions(): void
}) {
  return (
    <>
      <PageHeader title={copy.settings.tools.title}>{copy.settings.tools.intro}</PageHeader>
      <Banner tone="info" className="mb-6 flex items-center gap-3">
        <FEATURE_ICONS.permissions className="size-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">{copy.permissions.page.movedFromTools}</span>
        <Button size="sm" onClick={props.onPermissions}>
          {copy.permissions.page.openPermissions}
        </Button>
      </Banner>
      <McpServers />
      <div {...settingRow('tools.library')}>
        <SectionHeader
          className="mb-2 mt-8"
          icon={<FEATURE_ICONS.tools className="size-4 text-muted" />}
          title={copy.settings.tools.libraryTitle}
          note={copy.settings.tools.librarySubtitle}
        />
        <ToolLibraryList />
      </div>
      <SectionHeader
        className="mb-2 mt-8"
        icon={<Search className="size-4 text-muted" />}
        title={copy.settings.tools.webSearch}
      />
      <Card>
        <SettingField id="tools.webSearch" inline>
          <Select
            value={props.data.settings.search.provider}
            onChange={(e) => props.update((s) => ({ ...s, search: { provider: e.target.value } }), true)}
            aria-label={copy.settings.tools.searchProvider}
            className="min-w-44"
          >
            <option value="auto">{copy.settings.tools.searchAuto}</option>
            {props.data.searchProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </SettingField>
      </Card>
    </>
  )
}

export interface McpServer {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  target: string
  enabled: boolean
  status: 'connected' | 'connecting' | 'disconnected' | 'disabled' | 'error'
  tools: string[]
  error?: string
}

const MCP_TONE = {
  connected: 'ok',
  connecting: 'work',
  disconnected: 'neutral',
  disabled: 'neutral',
  error: 'bad',
} as const

/** MCP servers from `mcp.json`: their status and tools, an enable switch each, and a form to add one. */
function McpServers() {
  const toast = useToast()
  const [servers, setServers] = useState<McpServer[]>()
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: '', transport: 'stdio', command: '', url: '', env: '' })

  useEffect(() => {
    api<{ servers: McpServer[] }>('/api/mcp')
      .then((r) => setServers(r.servers))
      .catch(() => setServers([]))
  }, [])

  const act = async (run: () => Promise<{ servers: McpServer[] }>, done: string) => {
    setBusy(true)
    try {
      setServers((await run()).servers)
      toast(done, 'success')
      return true
    } catch (err) {
      toast(String((err as Error).message), 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    const [command = '', ...args] = form.command.trim().split(/\s+/)
    const env = Object.fromEntries(
      form.env
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    )
    const config =
      form.transport === 'stdio'
        ? { type: 'stdio', command, args, ...(Object.keys(env).length ? { env } : {}) }
        : { type: form.transport, url: form.url.trim() }
    const ok = await act(
      () => send<{ servers: McpServer[] }>('POST', '/api/mcp', { name: form.name.trim(), config }),
      copy.settings.mcp.added(form.name.trim()),
    )
    if (ok) {
      setAdding(false)
      setForm({ name: '', transport: 'stdio', command: '', url: '', env: '' })
    }
  }

  return (
    <div {...settingRow('tools.mcp')}>
      <div className="mb-2 mt-8 flex items-center justify-between">
        <SectionHeader
          icon={<FEATURE_ICONS.mcp className="size-4 text-muted" />}
          title={copy.settings.mcp.title}
          note={copy.settings.mcp.subtitle}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="borderless"
            disabled={busy}
            onClick={() => act(() => send('POST', '/api/mcp-reload'), copy.settings.mcp.reconnected)}
            icon={<RefreshCw className="size-3.5" />}
          >
            {copy.settings.mcp.reconnect}
          </Button>
          {!adding && (
            <Button size="sm" onClick={() => setAdding(true)} icon={<Plus className="size-3.5" />}>
              {copy.settings.mcp.addServer}
            </Button>
          )}
        </div>
      </div>
      {adding && (
        <Card className="mb-3">
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <Field label={copy.settings.mcp.name}>
              <TextInput
                value={form.name}
                placeholder="github"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label={copy.settings.mcp.transport}>
              <Select
                value={form.transport}
                onChange={(e) => setForm({ ...form, transport: e.target.value })}
              >
                <option value="stdio">{copy.settings.mcp.transportStdio}</option>
                <option value="http">{copy.settings.mcp.transportHttp}</option>
                <option value="sse">{copy.settings.mcp.transportSse}</option>
              </Select>
            </Field>
            {form.transport === 'stdio' ? (
              <>
                <Field label={copy.settings.mcp.command} hint={copy.settings.mcp.commandHint}>
                  <TextInput
                    value={form.command}
                    placeholder="npx -y @modelcontextprotocol/server-filesystem /path"
                    onChange={(e) => setForm({ ...form, command: e.target.value })}
                    className="font-mono"
                  />
                </Field>
                <Field label={copy.settings.mcp.environment} hint={copy.settings.mcp.environmentHint}>
                  <TextArea
                    rows={2}
                    value={form.env}
                    onChange={(e) => setForm({ ...form, env: e.target.value })}
                    className="font-mono"
                  />
                </Field>
              </>
            ) : (
              <Field label={copy.settings.mcp.url}>
                <TextInput
                  value={form.url}
                  placeholder="https://example.com/mcp"
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  className="font-mono"
                />
              </Field>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
            <Button size="sm" variant="borderless" onClick={() => setAdding(false)}>
              {copy.settings.shared.cancel}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={
                !form.name.trim() || (form.transport === 'stdio' ? !form.command.trim() : !form.url.trim())
              }
              onClick={add}
              loading={busy}
            >
              {copy.settings.mcp.addAndConnect}
            </Button>
          </div>
        </Card>
      )}
      <Card>
        {servers === undefined ? (
          <CardRow>
            <span className="text-body text-muted">{copy.settings.shared.loading}</span>
          </CardRow>
        ) : servers.length === 0 ? (
          <CardRow>
            <span className="text-body text-muted">{copy.settings.mcp.empty}</span>
          </CardRow>
        ) : (
          servers.map((m) => (
            <CardRow key={m.name} {...settingItem('tools.mcpServer', m)}>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-reading font-medium">
                    {m.name}
                    <Badge tone={MCP_TONE[m.status]}>{copy.settings.mcp.statuses[m.status]}</Badge>
                    {m.tools.length > 0 && (
                      <span className="text-small text-muted">
                        {copy.settings.mcp.toolCount(m.tools.length)}
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-footnote text-muted" title={m.target}>
                    {m.transport} · {m.target}
                  </div>
                  {m.error && <div className="mt-0.5 text-small text-bad-ink">{m.error}</div>}
                </div>
                <Switch
                  checked={m.enabled}
                  label={copy.settings.mcp.enable(m.name)}
                  onChange={(v) =>
                    act(
                      () => send('PUT', `/api/mcp/${encodeURIComponent(m.name)}`, { enabled: v }),
                      v ? copy.settings.mcp.enabled(m.name) : copy.settings.mcp.disabled(m.name),
                    )
                  }
                />
                <ConfirmButton
                  icon
                  label={copy.settings.mcp.remove(m.name)}
                  confirm={copy.settings.mcp.confirmRemove}
                  onConfirm={() =>
                    void act(
                      () => send('DELETE', `/api/mcp/${encodeURIComponent(m.name)}`),
                      copy.settings.mcp.removed(m.name),
                    )
                  }
                />
              </div>
            </CardRow>
          ))
        )}
      </Card>
    </div>
  )
}

const REVIEWER_HINT = {
  off: copy.settings.reviewer.hints.off,
  auto: copy.settings.reviewer.hints.auto,
  always: copy.settings.reviewer.hints.always,
} as const

export interface DeviceRow {
  id: string
  name: string
  scope: 'full' | 'chat'
  createdAt: string
  lastSeenAt?: string
  hub?: boolean
  current?: boolean
}

/** Devices paired with this gateway, with Revoke, and a single-use pairing link for a new one. */
function DevicesSection() {
  const t = copy.settings.devices
  const toast = useToast()
  const [data, setData] = useState<{ remote: boolean; devices: DeviceRow[] }>()
  const [scope, setScope] = useState<'full' | 'chat'>('full')
  const [link, setLink] = useState<{ code: string; link: string }>()
  const [copied, copyText] = useCopy()
  const load = () =>
    api<{ remote: boolean; devices: DeviceRow[] }>('/api/devices')
      .then(setData)
      .catch((err: Error) => toast(err.message, 'error'))
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once
  useEffect(() => {
    void load()
  }, [])
  const makeLink = () =>
    post<{ code: string; link: string }>('/api/devices/pair-code', { scope }).then(setLink, (err: Error) =>
      toast(err.message, 'error'),
    )
  const revoke = (d: DeviceRow) =>
    send('DELETE', `/api/devices/${encodeURIComponent(d.id)}`).then(
      () => {
        toast(t.revoked(d.name), 'info')
        void load()
      },
      (err: Error) => toast(err.message, 'error'),
    )
  return (
    <>
      <PageHeader title={t.title}>{data?.remote === false ? t.introLocal : t.introRemote}</PageHeader>
      {data?.remote === false ? (
        <div
          role="note"
          className="mb-6 flex items-start gap-3 rounded-2xl border border-line bg-fill px-4 py-3 text-body"
        >
          <FEATURE_ICONS.devices className="mt-0.5 size-4 shrink-0 text-muted" />
          <div>
            <div className="font-semibold">{t.pairNeedsRemoteTitle}</div>
            <div className="text-fg-2">{t.pairNeedsRemote}</div>
          </div>
        </div>
      ) : (
        <Card className="mb-6">
          <SettingField id="devices.scope" hint={t.scopeHints[scope]} inline>
            <Segmented
              id="pair-scope"
              value={scope}
              options={[
                { value: 'full', label: t.scopes.full },
                { value: 'chat', label: t.scopes.chat },
              ]}
              onChange={(s) => {
                setScope(s)
                setLink(undefined)
              }}
            />
          </SettingField>
          <CardRow {...settingRow('devices.pair')}>
            {link ? (
              <div className="flex flex-col gap-2">
                <p className="text-body text-fg-2">{t.link}</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-xl bg-fill px-3 py-2 font-mono text-callout">
                    {link.link}
                  </code>
                  <Button size="sm" variant="borderless" onClick={() => copyText(link.link)}>
                    {copied ? t.copied : t.copy}
                  </Button>
                </div>
                <p className="text-callout text-muted">{t.code(link.code)}</p>
              </div>
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon={<Plus className="size-3.5" />}
                onClick={() => void makeLink()}
              >
                {t.pair}
              </Button>
            )}
          </CardRow>
        </Card>
      )}
      {data && data.devices.length === 0 ? (
        <Empty icon={<FEATURE_ICONS.devices className="size-5" />} title={t.empty} />
      ) : (
        <Card>
          {data?.devices.map((d) => (
            <div
              key={d.id}
              {...settingItem('devices.device', d)}
              className="flex items-center gap-3 px-4 py-3"
            >
              <FEATURE_ICONS.devices className="size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-reading font-semibold">{d.name}</span>
                  {d.current && <Badge tone="accent">{t.thisDevice}</Badge>}
                </div>
                <div className="truncate text-small text-muted">
                  {t.scopeNames[d.scope]}
                  {d.hub ? ` · ${t.viaHub}` : ''} ·{' '}
                  {d.lastSeenAt ? t.lastSeen(new Date(d.lastSeenAt).toLocaleString()) : t.never}
                </div>
              </div>
              <ConfirmButton
                label={t.revoke}
                confirm={d.current ? t.confirmRevokeSelf : t.confirmRevoke}
                warning={d.current ? t.revokeSelfWarning : undefined}
                onConfirm={() => void revoke(d)}
              />
            </div>
          ))}
        </Card>
      )}
    </>
  )
}

export interface ChannelView {
  id: string
  label: string
  setup?: string
  fields: {
    key: string
    label: string
    secret?: boolean
    placeholder?: string
    hint?: string
    optional?: boolean
  }[]
  values: Record<string, string>
  secretsSet: string[]
  configured: boolean
  enabled: boolean
  project?: string
  dm: 'pairing' | 'allowlist' | 'open' | 'disabled'
  groups: 'approve' | 'open' | 'disabled'
  mention: boolean
  stream: 'progress' | 'partial' | 'final'
  perPerson: boolean
  allow: string[]
  allowExample?: string
  allowInvalid: string[]
  status: ChannelConnection
  health: {
    connectedAt?: string
    reconnects: number
    lastError?: string
    lastIn?: string
    lastOut?: string
    owed: number
  }
  people: { id: string; name: string; handle?: string; role: 'owner' | 'member'; by?: 'code' | 'settings' }[]
  approvedGroups: { id: string; title: string }[]
  pending: {
    id: string
    kind: 'person' | 'group'
    sender: { id: string; name: string; handle?: string }
    chat: { title?: string }
    expires: string
  }[]
}

/**
 * Shown in full once the person has started on it: switched on, or with settings saved. A platform whose settings
 * are all optional (SimpleX) or that has none (WhatsApp) counts as configured from the start, so that alone is not it.
 */
const inUse = (c: ChannelView) =>
  c.enabled || c.secretsSet.length > 0 || Object.keys(c.values).length > 0 || c.people.length > 0

/** The pairing codes the bot sends are this long (`packages/runtime/src/channels/store.ts`). */
const PAIRING_CODE_LENGTH = 8

/** How often Settings → Channels looks again, so a code someone just asked for shows up. */
const CHANNELS_POLL_MS = 3000

type ChannelTab = 'setup' | 'people' | 'rules' | 'activity'

const channelState = (c: ChannelView) => (c.enabled ? c.status.state : 'off')

/**
 * Messaging channels as a gallery of their apps (OpenClaw's and Hermes's channel pages): the ones in use first, with
 * their state and who is waiting, then every other app to add, grouped and searchable. A tile opens the app's sheet.
 */
export function ChannelsSection(props: {
  initial?: string | undefined
  /** Inside the setup assistant, which has its own heading. */
  embedded?: boolean
  /** Told each list as it loads, so the setup assistant can notice an app connecting. */
  onChannels?(channels: readonly ChannelView[]): void
}) {
  const t = copy.settings.channels
  const toast = useToast()
  const [list, setList] = useState<ChannelView[]>()
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [open, setOpen] = useState<string | undefined>(props.initial)
  const [query, setQuery] = useState('')
  // Shown on the page while it lasts (a damaged channels.json, the server away), not toasted again on every poll.
  const [loadError, setLoadError] = useState<string>()
  const load = () =>
    api<{ channels: ChannelView[] }>('/api/channels')
      .then((r) => {
        setList(r.channels)
        setLoadError(undefined)
        props.onChannels?.(r.channels)
      })
      .catch((err: Error) => setLoadError(err.message))
  // biome-ignore lint/correctness/useExhaustiveDependencies: load on a timer
  useEffect(() => {
    void load()
    void api<{ projects: { id: string; name: string }[] }>('/api/projects')
      .then((r) => setProjects(r.projects))
      .catch((err: Error) => toast(err.message, 'error'))
    const timer = setInterval(() => void load(), CHANNELS_POLL_MS)
    return () => clearInterval(timer)
  }, [])
  const connected = list?.filter(inUse) ?? []
  const q = query.trim().toLowerCase()
  const others = (list ?? []).filter((c) => !inUse(c) && (!q || c.label.toLowerCase().includes(q)))
  const groups = Object.keys(t.groupsTitle) as (keyof typeof t.groupsTitle)[]
  const shown = list?.find((c) => c.id === open)
  return (
    <>
      {!props.embedded && <PageHeader title={t.title}>{t.intro}</PageHeader>}
      {loadError && (
        <Banner tone="bad" role="alert" className="mb-6">
          {t.loadError(loadError)}
        </Banner>
      )}
      {connected.length > 0 && (
        <section {...settingRow('channels.yours')} className="mb-8">
          <SectionHeader as="h3" className="mb-2" title={t.yours} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {connected.map((c) => (
              <button
                key={c.id}
                type="button"
                {...settingItem('channels.channel', c)}
                onClick={() => setOpen(c.id)}
                className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-left shadow-soft transition-colors hover:bg-fill"
              >
                <ChannelLogo id={c.id} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-reading font-semibold">{c.label}</span>
                    {c.pending.length > 0 && <Badge tone="warn">{t.waitingBadge(c.pending.length)}</Badge>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-small text-muted">
                    <Dot status={channelState(c)} />
                    <span className={cn('truncate', c.status.state === 'error' && 'text-bad-ink')}>
                      {channelStatusText(c)}
                    </span>
                  </div>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted" />
              </button>
            ))}
          </div>
        </section>
      )}
      {!list && !loadError && (
        <div className="flex items-center gap-2 text-body text-muted">
          <LoaderCircle className="size-4 animate-spin" /> {copy.settings.page.loading}
        </div>
      )}
      {list && (
        <section {...settingRow('channels.add')}>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <SectionHeader as="h3" title={t.add} />
              <p className="text-small text-muted">{t.addHint}</p>
            </div>
            <div className="relative w-56">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
              <TextInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t.search}
                aria-label={t.search}
                className="pl-8"
              />
            </div>
          </div>
          {others.length === 0 && q && <p className="text-callout text-muted">{t.noMatch}</p>}
          {groups.map((g) => {
            const apps = others.filter((c) => (CHANNEL_GROUPS[c.id] ?? 'other') === g)
            if (apps.length === 0) return null
            return (
              <div key={g} className="mb-5">
                <div className="mb-2 section-label text-muted">{t.groupsTitle[g]}</div>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                  {apps.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      {...settingItem('channels.channel', c)}
                      onClick={() => setOpen(c.id)}
                      className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface px-2 py-3 text-center transition-colors hover:bg-fill"
                    >
                      <ChannelLogo id={c.id} size={32} />
                      <span className="w-full truncate text-small">{c.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </section>
      )}
      <AnimatePresence>
        {shown && (
          <ChannelSheet
            key={shown.id}
            channel={shown}
            projects={projects}
            onChanged={load}
            onClose={() => setOpen(undefined)}
          />
        )}
      </AnimatePresence>
    </>
  )
}

/** One app's sheet: its setup, who may use it, its rules, and what has happened on it. */
function ChannelSheet(props: {
  channel: ChannelView
  projects: { id: string; name: string }[]
  onChanged(): Promise<unknown>
  onClose(): void
}) {
  const t = copy.settings.channels
  const c = props.channel
  const toast = useToast()
  const [tab, setTab] = useState<ChannelTab>(c.pending.length > 0 ? 'people' : 'setup')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [allowDraft, setAllowDraft] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [events, setEvents] = useState<{ at: string; kind: string; text: string }[]>()
  // Shown in the tab while it lasts, not toasted again on every poll.
  const [eventsError, setEventsError] = useState<string>()
  const [allowError, setAllowError] = useState<string>()
  const [allowSaved, setAllowSaved] = useState(false)
  const saved = new Set([...c.secretsSet, ...Object.keys(c.values).filter((k) => c.values[k])])
  const setup = channelSetup(c.fields, saved, draft)
  const changed = Object.keys(setup.values).length > 0
  // Why the settings were not saved: on the one field it is about, or for the form when it is about several.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [setupError, setSetupError] = useState<string>()
  useEffect(() => {
    if (tab !== 'activity') return
    const get = () =>
      api<{ events: { at: string; kind: string; text: string }[] }>(`/api/channels/${c.id}/activity`)
        .then((r) => {
          setEvents(r.events)
          setEventsError(undefined)
        })
        .catch((err: Error) => setEventsError(err.message))
    void get()
    const timer = setInterval(() => void get(), CHANNELS_POLL_MS)
    return () => clearInterval(timer)
  }, [tab, c.id])
  const configure = async (patch: Record<string, unknown>) => {
    setBusy(true)
    try {
      await send('PUT', `/api/channels/${c.id}`, patch)
      await props.onChanged()
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const saveValues = async () => {
    setSetupError(undefined)
    if (setup.missing.length)
      return setFieldErrors(
        Object.fromEntries(setup.missing.map((k) => [k, copy.settings.validation.required])),
      )
    setFieldErrors({})
    setBusy(true)
    try {
      const { channel } = await send<{ channel: ChannelView }>('PUT', `/api/channels/${c.id}`, {
        values: setup.values,
      })
      setDraft({})
      if (channel.status.state === 'on') toast(t.saved(channel.status.account), 'success')
      await props.onChanged()
    } catch (err) {
      const why = (err as Error).message
      const typed = Object.keys(setup.values)
      if (typed.length === 1 && typed[0]) setFieldErrors({ [typed[0]]: why })
      else setSetupError(why)
    } finally {
      setBusy(false)
    }
  }
  const saveAllow = async () => {
    if (allowDraft === undefined) return
    const allow = allowDraft
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
    try {
      await send('PUT', `/api/channels/${c.id}`, { allow })
      setAllowDraft(undefined)
      setAllowError(undefined)
      setAllowSaved(true)
      await props.onChanged()
    } catch (err) {
      setAllowError((err as Error).message)
      setAllowSaved(false)
    }
  }
  const act = (promise: Promise<unknown>, done?: string) =>
    promise.then(
      () => {
        if (done) toast(done, 'success')
        void props.onChanged()
      },
      (err: Error) => toast(err.message, 'error'),
    )
  const hasOwner = c.people.some((p) => p.role === 'owner')
  // An owner from before ownership was recorded may have become it only by being on the allowlist.
  const unconfirmed = c.allow.length > 0 ? c.people.find((p) => p.role === 'owner' && !p.by) : undefined
  // Approving takes the code the bot sent the requester: the server checks it, so a stranger who wrote first (even
  // under the owner's name) cannot be approved by a click.
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [codeErrors, setCodeErrors] = useState<Record<string, string>>({})
  const approve = async (p: ChannelView['pending'][number]) => {
    const code = (codes[p.id] ?? '').trim()
    if (!code) return setCodeErrors((all) => ({ ...all, [p.id]: copy.settings.validation.required }))
    try {
      await post(`/api/channels/${c.id}/approve`, { code, request: p.id })
      toast(t.approved(p.kind === 'group' ? (p.chat.title ?? '') : p.sender.name), 'success')
      setCodes(({ [p.id]: _, ...rest }) => rest)
      await props.onChanged()
    } catch (err) {
      setCodeErrors((all) => ({ ...all, [p.id]: (err as Error).message }))
    }
  }
  const tabs: { value: ChannelTab; label: string; count?: number }[] = [
    { value: 'setup', label: t.tabs.setup },
    ...(c.configured
      ? [
          { value: 'people' as const, label: t.tabs.people, count: c.pending.length },
          { value: 'rules' as const, label: t.tabs.rules },
        ]
      : []),
    { value: 'activity', label: t.tabs.activity },
  ]
  const h = t.health
  return (
    <Sheet
      size="md"
      flush
      onClose={props.onClose}
      title={
        <span className="flex items-center gap-3">
          <ChannelLogo id={c.id} size={28} />
          <span className="min-w-0">
            <span className="block truncate">{c.label}</span>
            <span className="flex items-center gap-1.5 text-small font-normal text-muted">
              <Dot status={channelState(c)} />
              <span className={cn('truncate', c.status.state === 'error' && 'text-bad-ink')}>
                {channelStatusText(c)}
              </span>
            </span>
          </span>
        </span>
      }
      actions={
        c.configured && (
          <span {...settingRow('channels.on')} className="inline-flex">
            <Switch checked={c.enabled} onChange={(enabled) => void configure({ enabled })} label={t.on} />
          </span>
        )
      }
    >
      <Tabs id={`channel-${c.id}`} value={tab} tabs={tabs} onChange={setTab} className="shrink-0" />
      <div {...tabPanel(`channel-${c.id}`, tab)} className="min-h-[24rem] flex-1 overflow-auto p-5">
        {tab === 'setup' && (
          <div className="flex flex-col gap-4">
            {c.setup && (
              <p className="whitespace-pre-line rounded-lg bg-fill px-4 py-3 text-callout text-fg-2">
                {c.setup}
              </p>
            )}
            {c.status.state === 'linking' && (
              <img
                src={c.status.image}
                alt={t.status.linking}
                className="size-56 self-center rounded-xl bg-white p-2"
              />
            )}
            {(c.fields.length > 0 || !c.enabled || c.configured) && (
              <div {...settingRow('channels.setup')}>
                <Card>
                  {c.fields.map((f) => (
                    <CardRow key={f.key}>
                      <Field
                        label={f.optional ? t.optional(f.label) : f.label}
                        hint={f.secret && c.secretsSet.includes(f.key) ? t.secretSet : f.hint}
                        error={fieldErrors[f.key]}
                      >
                        <TextInput
                          type={f.secret ? 'password' : 'text'}
                          autoComplete="off"
                          value={draft[f.key] ?? (f.secret ? '' : (c.values[f.key] ?? ''))}
                          onChange={(e) => {
                            const value = e.target.value
                            setDraft((d) => ({ ...d, [f.key]: value }))
                            setFieldErrors(({ [f.key]: _, ...rest }) => rest)
                            setSetupError(undefined)
                          }}
                          placeholder={f.placeholder}
                          className="font-mono"
                        />
                      </Field>
                    </CardRow>
                  ))}
                  {c.fields.length > 0 ? (
                    <CardRow>
                      <div className="flex flex-wrap items-center gap-3">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy || !changed}
                          onClick={() => void saveValues()}
                        >
                          {busy ? t.saving : t.save}
                        </Button>
                        {setup.missing.length > 0 && (
                          <span className="text-small text-muted">
                            {t.stillNeeded(
                              c.fields.filter((f) => setup.missing.includes(f.key)).map((f) => f.label),
                            )}
                          </span>
                        )}
                      </div>
                      {setupError && (
                        <p role="alert" className="mt-2 text-small leading-snug text-bad-ink">
                          {setupError}
                        </p>
                      )}
                    </CardRow>
                  ) : (
                    !c.enabled && (
                      <CardRow>
                        <Button size="sm" variant="primary" onClick={() => void configure({ enabled: true })}>
                          {t.turnOn}
                        </Button>
                      </CardRow>
                    )
                  )}
                  {c.configured && (
                    <SettingField id="channels.project" inline>
                      <Select
                        value={c.project ?? ''}
                        onChange={(e) => void configure({ project: e.target.value || null })}
                        aria-label={t.project}
                      >
                        <option value="">{t.noProject}</option>
                        {props.projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    </SettingField>
                  )}
                </Card>
              </div>
            )}
            {inUse(c) && (
              <div {...settingRow('channels.remove')} className="flex justify-end">
                <ConfirmButton
                  label={t.remove}
                  confirm={t.removeConfirm}
                  warning={t.removeWarning}
                  disabled={busy}
                  onConfirm={() =>
                    void send('DELETE', `/api/channels/${c.id}`).then(
                      () => {
                        toast(t.removed(c.label), 'success')
                        props.onClose()
                        void props.onChanged()
                      },
                      (err: Error) => toast(err.message, 'error'),
                    )
                  }
                />
              </div>
            )}
          </div>
        )}

        {tab === 'people' && (
          <div className="flex flex-col gap-4">
            {unconfirmed && (
              <Banner tone="warn" className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1">{t.confirmOwner(unconfirmed.name)}</p>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    void act(
                      post(`/api/channels/${c.id}/owner`, { person: unconfirmed.id }),
                      t.ownerConfirmed(unconfirmed.name),
                    )
                  }
                >
                  {t.confirmOwnerButton}
                </Button>
              </Banner>
            )}
            {c.pending.length > 0 && (
              <div {...settingRow('channels.requests')}>
                <Card>
                  <CardRow>
                    <div className="text-body font-semibold">{t.waiting}</div>
                    <div className="text-small text-muted">{t.waitingHint}</div>
                  </CardRow>
                  {!hasOwner && c.pending.some((p) => p.kind === 'person') && (
                    <CardRow>
                      <p className="text-callout text-warn-ink">{t.ownerFirst}</p>
                    </CardRow>
                  )}
                  {c.pending.map((p) => {
                    const asOwner = !hasOwner && p.kind === 'person'
                    return (
                      <div key={p.id} className="flex flex-col gap-2 px-4 py-3">
                        <div className="min-w-0">
                          <div className="truncate text-reading font-semibold">
                            {p.sender.name}
                            {p.kind === 'group' ? ` · ${t.group(p.chat.title ?? '')}` : ''}
                          </div>
                          <div className="truncate font-mono text-small text-muted">
                            {t.sender(c.label, p.sender.id, p.sender.handle)}
                          </div>
                          <div className="text-small text-muted">
                            {t.expires(new Date(p.expires).toLocaleTimeString())}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="w-48">
                            <Field label={t.code} error={codeErrors[p.id]}>
                              <TextInput
                                value={codes[p.id] ?? ''}
                                onChange={(e) => {
                                  const code = e.target.value
                                  setCodes((all) => ({ ...all, [p.id]: code }))
                                  setCodeErrors(({ [p.id]: _, ...rest }) => rest)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void approve(p)
                                }}
                                autoComplete="off"
                                spellCheck={false}
                                maxLength={PAIRING_CODE_LENGTH}
                                className="font-mono uppercase"
                              />
                            </Field>
                          </div>
                          <div className="ml-auto flex gap-2">
                            <ConfirmButton
                              label={t.decline}
                              name={t.declineName(p.kind === 'group' ? (p.chat.title ?? '') : p.sender.name)}
                              confirm={t.declineConfirm}
                              onConfirm={() =>
                                void act(send('DELETE', `/api/channels/${c.id}/request/${p.id}`))
                              }
                            />
                            <Button size="sm" variant="primary" onClick={() => void approve(p)}>
                              {asOwner ? t.makeOwner : t.approve}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </Card>
              </div>
            )}
            <div {...settingRow('channels.people')}>
              <Card>
                <CardRow>
                  <div className="text-body font-semibold">{t.people}</div>
                </CardRow>
                {c.people.length === 0 && <div className="px-4 py-3 text-callout text-muted">{t.none}</div>}
                {c.people.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1 truncate text-reading">
                      {p.name}
                      {p.handle ? <span className="text-muted"> @{p.handle}</span> : null}
                    </div>
                    <Badge tone={p.role === 'owner' ? 'accent' : 'neutral'}>
                      {p.role === 'owner' ? t.owner : t.member}
                    </Badge>
                    {p.role === 'member' && (
                      <ConfirmButton
                        label={t.makeOwner}
                        name={t.makeOwnerName(p.name)}
                        confirm={t.makeOwnerConfirm}
                        warning={hasOwner ? t.makeOwnerWarning : t.makeOwnerFirstWarning}
                        onConfirm={() =>
                          void act(post(`/api/channels/${c.id}/owner`, { person: p.id }), t.madeOwner(p.name))
                        }
                      />
                    )}
                    <ConfirmButton
                      label={t.revoke}
                      name={t.revokeName(p.name)}
                      confirm={t.revokeConfirm}
                      warning={p.role === 'owner' ? t.revokeOwnerWarning : t.revokeWarning}
                      onConfirm={() => void act(send('DELETE', `/api/channels/${c.id}/person/${p.id}`))}
                    />
                  </div>
                ))}
                {c.approvedGroups.length > 0 && (
                  <CardRow>
                    <div className="text-body font-semibold">{t.groups}</div>
                  </CardRow>
                )}
                {c.approvedGroups.map((g) => (
                  <div key={g.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1 truncate text-reading">{g.title}</div>
                    <ConfirmButton
                      label={t.revoke}
                      name={t.revokeName(g.title)}
                      confirm={t.revokeConfirm}
                      warning={t.revokeGroupWarning}
                      onConfirm={() => void act(send('DELETE', `/api/channels/${c.id}/group/${g.id}`))}
                    />
                  </div>
                ))}
              </Card>
            </div>
          </div>
        )}

        {tab === 'rules' && (
          <Card>
            <SettingField id="channels.dm" hint={t.dmHint[c.dm]} inline>
              <Select value={c.dm} onChange={(e) => void configure({ dm: e.target.value })} aria-label={t.dm}>
                {(['pairing', 'allowlist', 'open', 'disabled'] as const).map((v) => (
                  <option key={v} value={v}>
                    {t.dmOptions[v]}
                  </option>
                ))}
              </Select>
            </SettingField>
            <SettingField id="channels.groups" hint={t.groupsHint[c.groups]} inline>
              <Select
                value={c.groups}
                onChange={(e) => void configure({ groups: e.target.value })}
                aria-label={t.groupsLabel}
              >
                {(['approve', 'open', 'disabled'] as const).map((v) => (
                  <option key={v} value={v}>
                    {t.groupsOptions[v]}
                  </option>
                ))}
              </Select>
            </SettingField>
            <SettingField id="channels.mention" inline>
              <Switch
                checked={c.mention}
                onChange={(mention) => void configure({ mention })}
                label={t.mention}
              />
            </SettingField>
            <SettingField id="channels.perPerson" inline>
              <Switch
                checked={c.perPerson}
                onChange={(perPerson) => void configure({ perPerson })}
                label={t.perPerson}
              />
            </SettingField>
            <SettingField
              id="channels.allow"
              hint={
                <>
                  {t.allowHint}
                  {allowSaved && <span className="text-ok-ink"> {t.allowSaved}</span>}
                </>
              }
              error={
                allowError ??
                (c.allowInvalid.length ? t.allowStale(c.allowInvalid, c.allowExample) : undefined)
              }
            >
              <TextInput
                value={allowDraft ?? c.allow.join(', ')}
                onChange={(e) => {
                  setAllowDraft(e.target.value)
                  setAllowSaved(false)
                }}
                onBlur={() => void saveAllow()}
                placeholder={c.allowExample ?? t.allowPlaceholder}
              />
            </SettingField>
            <SettingField id="channels.stream" hint={t.streamHint[c.stream]} inline>
              <Select
                value={c.stream}
                onChange={(e) => void configure({ stream: e.target.value })}
                aria-label={t.stream}
              >
                {(['progress', 'partial', 'final'] as const).map((v) => (
                  <option key={v} value={v}>
                    {t.streamOptions[v]}
                  </option>
                ))}
              </Select>
            </SettingField>
          </Card>
        )}

        {tab === 'activity' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-callout text-muted">
              <span>{h.lastIn(c.health.lastIn ? ago(c.health.lastIn) : h.never)}</span>
              <span>{h.lastOut(c.health.lastOut ? ago(c.health.lastOut) : h.never)}</span>
              {c.health.reconnects > 0 && <span>{h.reconnects(c.health.reconnects)}</span>}
              {c.health.owed > 0 && <span className="text-warn-ink">{h.owed(c.health.owed)}</span>}
            </div>
            {c.health.lastError && channelState(c) !== 'on' && (
              <Banner tone="bad">{h.lastError(c.health.lastError)}</Banner>
            )}
            {eventsError && (
              <Banner tone="bad" role="alert">
                {eventsError}
              </Banner>
            )}
            <Card>
              {events?.length === 0 && (
                <div className="px-4 py-3 text-callout text-muted">{t.noActivity}</div>
              )}
              {events?.map((e) => (
                <div key={`${e.at}-${e.text}`} className="flex items-center gap-3 px-4 py-2.5 text-body">
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      (e.kind === 'failed' || e.kind === 'trouble') && 'text-bad-ink',
                    )}
                  >
                    {e.text}
                  </span>
                  <span className="shrink-0 text-small text-muted">{ago(e.at)}</span>
                </div>
              ))}
            </Card>
          </div>
        )}
      </div>
    </Sheet>
  )
}

export interface VoiceStatusView {
  enabled: boolean
  callModel?: string
  mode?: 'pipeline' | 'realtime'
  /** The voice providers and the person's own services; absent from older servers. */
  providers?: VoiceProviderView[]
  endpoints?: VoiceEndpointView[]
  stt: {
    provider: ServerSettings['voice']['stt']['provider']
    phonon: { state: string; line?: string; error?: string }
    omp: string[]
    keySet: boolean
  }
  tts: {
    provider: ServerSettings['voice']['tts']['provider']
    /** While downloading: files `done` of `total`, and bytes `received` of `size`. */
    kitten: { state: string; done?: number; total?: number; received?: number; size?: number; error?: string }
    voices: string[]
    omp: string[]
    keySet: boolean
  }
  /** Bytes each local engine downloads the first time; absent from older servers. */
  sizes?: { phonon: number; kitten: Record<'nano' | 'micro' | 'mini', number>; vad: number; turn: number }
  /** Days a call's transcript is kept. */
  transcriptDays?: number
  /** The phone line on the SMS number; absent where there are no channels. */
  phone?: { state: 'off' | 'connecting' | 'on' | 'error'; number?: string; error?: string }
}

/** An engine installing, starting or downloading: Settings → Voice looks again until it is done. */
function voiceBusy(s: VoiceStatusView | undefined): boolean {
  return (
    !!s &&
    (s.stt.phonon.state === 'installing' ||
      s.stt.phonon.state === 'starting' ||
      s.tts.kitten.state === 'downloading' ||
      s.phone?.state === 'connecting')
  )
}

/** A speech engine that failed: what went wrong and what to do, with its own message behind details. */
export function EngineTrouble(props: { engine: 'phonon' | 'kitten'; raw: string }) {
  const t = copy.settings.voice.trouble
  const trouble = engineTrouble(props.engine, props.raw)
  return (
    <div className="min-w-0 flex-1 text-body">
      <p className="text-bad-ink">{trouble.cause}</p>
      <p className="text-fg-2">{trouble.fix}</p>
      {props.raw && (
        <details className="mt-1 text-callout text-muted">
          <summary>{t.details}</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-fill/60 px-2.5 py-2 font-mono text-footnote text-fg-2">
            {props.raw}
          </pre>
        </details>
      )}
    </div>
  )
}

/**
 * Voice calls: the call mode, the call model, speech to text and text to speech (on this Mac by default — Phonon-2 and
 * Kitten TTS, installed from here — omp's speech models, the voice providers set up in Models & providers, or the
 * person's own services), a realtime model, and how loud speech must be to count.
 */
function VoiceSection(props: {
  settings: ServerSettings
  update(p: (s: ServerSettings) => ServerSettings): void
  models: ModelOption[]
  /** Opens Models & providers at its voice providers. */
  onAddProvider(): void
}) {
  const t = copy.settings.voice
  const toast = useToast()
  const v = props.settings.voice
  const [status, setStatus] = useState<VoiceStatusView>()
  const [trying, setTrying] = useState(false)
  // A failing look is said once, not again on every later look that fails the same way.
  const failed = useRef<string>(undefined)
  // Counts finished looks, so each one, answered or failed, can schedule the next.
  const [looks, setLooks] = useState(0)
  const load = () =>
    api<VoiceStatusView>('/api/voice')
      .then((s) => {
        failed.current = undefined
        setStatus(s)
      })
      .catch((err: Error) => {
        if (failed.current === err.message) return
        failed.current = err.message
        toast(err.message, 'error')
      })
      .finally(() => setLooks((n) => n + 1))
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, and again after each save
  useEffect(() => {
    void load()
    window.addEventListener(SETTINGS_SAVED, load)
    return () => window.removeEventListener(SETTINGS_SAVED, load)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: each finished look schedules the next while one is due
  useEffect(() => {
    if (!voiceBusy(status) && !failed.current) return
    const timer = setTimeout(() => void load(), VOICE_POLL_MS)
    return () => clearTimeout(timer)
  }, [looks])
  const set = (patch: (voice: ServerSettings['voice']) => ServerSettings['voice']) =>
    props.update((s) => ({ ...s, voice: patch(s.voice) }))
  const act = (promise: Promise<unknown>) => promise.then(load, (err: Error) => toast(err.message, 'error'))
  const engine = (s: { state: string; done?: number; total?: number; received?: number; size?: number }) =>
    s.state === 'downloading'
      ? s.size
        ? t.engine.downloadingBytes(formatSize(s.received ?? 0), formatSize(s.size))
        : t.engine.downloading(s.done ?? 0, s.total ?? 0)
      : ((t.engine[s.state as keyof typeof t.engine] as string | undefined) ?? s.state)
  const sizes = status?.sizes
  const size = (bytes: number | undefined) => (bytes ? formatSize(bytes) : '')
  const providers = status?.providers ?? []
  const endpoints = status?.endpoints ?? []
  const realtime = v.mode === 'realtime'
  const tryIt = async () => {
    setTrying(true)
    try {
      const url = URL.createObjectURL(await postForBlob('/api/voice/sample', { text: t.trySentence }))
      const audio = new Audio(url)
      audio.onended = () => URL.revokeObjectURL(url)
      await audio.play()
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setTrying(false)
    }
  }
  const sttHint =
    v.stt.provider === 'phonon'
      ? t.hints.phonon(size(sizes?.phonon))
      : v.stt.provider === 'omp'
        ? t.hints.ompStt(status?.stt.omp.join(', ') ?? '')
        : cloudHint('stt', v.stt.provider, providers, endpoints)
  const ttsHint =
    v.tts.provider === 'kitten'
      ? t.hints.kitten
      : v.tts.provider === 'omp'
        ? t.hints.ompTts(status?.tts.omp.join(', ') ?? '')
        : cloudHint('tts', v.tts.provider, providers, endpoints)
  const onOff = (
    <Card className="mb-6">
      <SettingField
        id="voice.enabled"
        hint={
          <>
            {t.enabledHint({
              detector: size(sizes?.vad),
              turn: size(sizes?.turn),
              kitten: size(sizes?.kitten[v.tts.kittenModel]),
            })}
            {status?.transcriptDays !== undefined && ` ${t.transcripts(status.transcriptDays)}`}
          </>
        }
        inline
      >
        <Switch
          checked={v.enabled}
          onChange={(enabled) => set((x) => ({ ...x, enabled }))}
          label={t.enabled}
        />
      </SettingField>
    </Card>
  )
  if (!v.enabled)
    return (
      <>
        <PageHeader title={t.title}>{t.intro}</PageHeader>
        {onOff}
      </>
    )
  return (
    <>
      <PageHeader title={t.title}>{t.intro}</PageHeader>
      {onOff}
      <Card className="mb-6">
        <CallModeRow voice={v} set={set} />
        {!realtime && (
          <SettingField id="voice.callModel">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                id="call-model"
                value={v.callModel ? 'own' : 'lead'}
                options={[
                  { value: 'lead', label: t.sameAsLead },
                  { value: 'own', label: t.ownModel },
                ]}
                onChange={(choice) =>
                  set((x) => ({
                    ...x,
                    callModel: choice === 'lead' ? undefined : (status?.callModel ?? props.models[0]?.ref),
                  }))
                }
              />
              {v.callModel ? (
                <ModelPicker
                  variant="compact"
                  label={t.callModel}
                  value={v.callModel}
                  models={props.models}
                  placement="down"
                  onChange={(callModel) => set((x) => ({ ...x, callModel }))}
                />
              ) : (
                status?.callModel && (
                  <span className="text-callout text-muted">
                    {t.leadModel(
                      props.models.find((m) => m.ref === status.callModel)?.name ?? status.callModel,
                    )}
                  </span>
                )
              )}
            </div>
          </SettingField>
        )}
        <SettingField id="voice.sensitivity" inline>
          <Select
            value={v.sensitivity}
            onChange={(e) => set((x) => ({ ...x, sensitivity: e.target.value as typeof v.sensitivity }))}
            aria-label={t.sensitivity}
          >
            {(['low', 'normal', 'high'] as const).map((k) => (
              <option key={k} value={k}>
                {t.sensitivities[k]}
              </option>
            ))}
          </Select>
        </SettingField>
      </Card>

      {realtime && (
        <>
          <SectionHeader as="h3" className="mb-2" title={t.realtimeTitle} />
          <RealtimeCard voice={v} providers={providers} set={set} onAddProvider={props.onAddProvider} />
        </>
      )}

      <div className="mb-2 flex items-center justify-between">
        <SectionHeader as="h3" title={t.sttTitle} note={realtime ? t.directOnly : undefined} />
        <AddVoiceProvider onClick={props.onAddProvider} />
      </div>
      <Card className="mb-6">
        <EnginePicker
          kind="stt"
          voice={v}
          providers={providers}
          endpoints={endpoints}
          set={set}
          hint={sttHint}
        />
        {v.stt.provider === 'phonon' && status && (
          <CardRow>
            <div className="flex items-center gap-3 text-body">
              {status.stt.phonon.state === 'error' ? (
                <EngineTrouble engine="phonon" raw={status.stt.phonon.error ?? ''} />
              ) : (
                <span className="min-w-0 flex-1 truncate text-fg-2" title={status.stt.phonon.line}>
                  {engine(status.stt.phonon)}
                  {status.stt.phonon.line && <span className="text-muted"> · {status.stt.phonon.line}</span>}
                </span>
              )}
              <Button
                size="sm"
                disabled={status.stt.phonon.state === 'installing'}
                onClick={() => void act(post('/api/voice/phonon/install', {}))}
              >
                {status.stt.phonon.state === 'missing' ? t.install : t.reinstall}
              </Button>
            </div>
          </CardRow>
        )}
        <CloudRows kind="stt" voice={v} providers={providers} set={set} />
      </Card>

      <SectionHeader as="h3" className="mb-2" title={t.ttsTitle} note={realtime ? t.directOnly : undefined} />
      <Card className="mb-6">
        <EnginePicker
          kind="tts"
          voice={v}
          providers={providers}
          endpoints={endpoints}
          set={set}
          hint={ttsHint}
        />
        {v.tts.provider === 'kitten' && (
          <>
            <SettingField id="voice.tts.kittenModel" inline>
              <Select
                value={v.tts.kittenModel}
                onChange={(e) =>
                  set((x) => ({
                    ...x,
                    tts: { ...x.tts, kittenModel: e.target.value as typeof v.tts.kittenModel },
                  }))
                }
                aria-label={t.kittenModel}
              >
                {(['nano', 'micro', 'mini'] as const).map((m) => (
                  <option key={m} value={m}>
                    {sizes ? `${t.kittenModels[m]} · ${formatSize(sizes.kitten[m])}` : t.kittenModels[m]}
                  </option>
                ))}
              </Select>
            </SettingField>
            {status && (
              <CardRow>
                <div className="flex items-center gap-3 text-body">
                  {status.tts.kitten.state === 'error' ? (
                    <EngineTrouble engine="kitten" raw={status.tts.kitten.error ?? ''} />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-fg-2">{engine(status.tts.kitten)}</span>
                  )}
                  {(status.tts.kitten.state === 'missing' || status.tts.kitten.state === 'error') && (
                    <Button
                      size="sm"
                      onClick={() =>
                        void act(post('/api/voice/kitten/download', { model: v.tts.kittenModel }))
                      }
                    >
                      {t.download}
                    </Button>
                  )}
                </div>
              </CardRow>
            )}
            <SettingField id="voice.tts.voice" inline>
              <Select
                value={v.tts.voice}
                onChange={(e) => set((x) => ({ ...x, tts: { ...x.tts, voice: e.target.value } }))}
                aria-label={t.voice}
              >
                {(status?.tts.voices ?? [v.tts.voice]).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </SettingField>
          </>
        )}
        <CloudRows kind="tts" voice={v} providers={providers} set={set} />
        <SettingField id="voice.tts.speed" inline>
          <Select
            value={String(v.tts.speed)}
            onChange={(e) => set((x) => ({ ...x, tts: { ...x.tts, speed: Number(e.target.value) } }))}
            aria-label={t.speed}
          >
            {VOICE_SPEEDS.map((sp) => (
              <option key={sp} value={String(sp)}>
                {`${sp}×`}
              </option>
            ))}
          </Select>
        </SettingField>
        <CardRow {...settingRow('voice.tts.try')}>
          <Button size="sm" variant="primary" disabled={trying} onClick={() => void tryIt()}>
            {t.tryIt}
          </Button>
        </CardRow>
      </Card>

      {status?.phone && (
        <>
          <SectionHeader
            as="h3"
            className="mb-2"
            icon={<FEATURE_ICONS.phoneCalls className="size-4 text-muted" />}
            title={t.phone.title}
          />
          <Card className="mb-6">
            <SettingField
              id="voice.phone.enabled"
              hint={
                <>
                  {t.phone.hint}
                  {status.phone.state === 'connecting' && ` ${t.phone.connecting}`}
                  {status.phone.state === 'on' &&
                    status.phone.number &&
                    ` ${t.phone.on(status.phone.number)}`}
                </>
              }
              error={status.phone.state === 'error' ? status.phone.error : undefined}
              inline
            >
              <Switch
                checked={v.phone === true}
                onChange={(phone) => set((x) => ({ ...x, phone }))}
                label={t.phone.enabled}
              />
            </SettingField>
            {status.phone.state === 'on' && (
              <SettingField id="voice.phone.callMe" inline>
                <Button
                  size="sm"
                  onClick={() =>
                    void post<{ to: string }>('/api/voice/phone/call', {}).then(
                      (r) => toast(t.phone.calling(r.to)),
                      (err: Error) => toast(err.message, 'error'),
                    )
                  }
                >
                  {t.phone.callMe}
                </Button>
              </SettingField>
            )}
          </Card>
        </>
      )}
    </>
  )
}

/**
 * Other gateways this machine shows (it is their hub): add one with its pairing link, see whether it answers, show it
 * in this window, or remove it. Always this machine's list, whichever gateway the window shows.
 */
function GatewaysSection() {
  const t = copy.settings.gateways
  const toast = useToast()
  const [list, setList] = useState<GatewayInfo[]>()
  const [link, setLink] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const active = activeGateway()
  const load = () =>
    listGateways()
      .then(setList)
      .catch((err: Error) => toast(err.message, 'error'))
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once
  useEffect(() => {
    void load()
  }, [])
  const add = async () => {
    setBusy(true)
    try {
      const { gateway } = await hubSend<{ gateway: GatewayInfo }>('POST', '/api/gateways', {
        link: link.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      })
      toast(t.added(gateway.name), 'success')
      window.dispatchEvent(new Event(GATEWAYS_CHANGED))
      setLink('')
      setName('')
      await load()
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const remove = (g: GatewayInfo) =>
    hubSend('DELETE', `/api/gateways/${encodeURIComponent(g.id)}`).then(
      () => {
        toast(t.removed(g.name), 'info')
        // The window cannot keep showing a gateway that is gone.
        if (g.id === active) switchGateway(undefined)
        else {
          window.dispatchEvent(new Event(GATEWAYS_CHANGED))
          void load()
        }
      },
      (err: Error) => toast(err.message, 'error'),
    )
  return (
    <>
      <PageHeader title={t.title}>{t.intro}</PageHeader>
      <Card className="mb-6">
        <SettingField id="gateways.link">
          <TextInput
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://box.tail1234.ts.net/#pair=…"
            aria-label={t.link}
            className="font-mono"
          />
        </SettingField>
        <SettingField id="gateways.name">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            aria-label={t.name}
          />
        </SettingField>
        <CardRow {...settingRow('gateways.add')}>
          <Button
            size="sm"
            variant="primary"
            disabled={!link.trim()}
            loading={busy}
            icon={<Plus className="size-3.5" />}
            onClick={() => void add()}
          >
            {busy ? t.adding : t.add}
          </Button>
        </CardRow>
      </Card>
      {list && list.length === 0 ? (
        <Empty icon={<FEATURE_ICONS.gateways className="size-5" />} title={t.empty} />
      ) : (
        <Card>
          {list?.map((g) => (
            <div
              key={g.id}
              {...settingItem('gateways.gateway', g)}
              className="flex items-center gap-3 px-4 py-3"
            >
              <Dot tone={g.health.ok ? 'ok' : 'bad'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-reading font-semibold">{g.name}</span>
                  {g.id === active && <Badge tone="accent">{t.shown}</Badge>}
                </div>
                <div className="truncate text-small text-muted">
                  {new URL(g.url).host} · {copy.settings.devices.scopeNames[g.scope]} ·{' '}
                  {g.health.ok ? t.reachable : g.health.error} ·{' '}
                  {t.checked(new Date(g.health.checkedAt).toLocaleTimeString())}
                </div>
              </div>
              {g.id !== active && (
                <Button size="sm" variant="borderless" onClick={() => switchGateway(g.id)}>
                  {t.show}
                </Button>
              )}
              <ConfirmButton
                label={t.remove}
                confirm={copy.settings.gateways.confirmRemove}
                onConfirm={() => void remove(g)}
              />
            </div>
          ))}
        </Card>
      )}
    </>
  )
}

/** The person's saved specialists: each as a row, opened into its editor; a new one starts empty. */
function SpecialistsSection(props: { models: ModelOption[] }) {
  const t = copy.settings.specialists
  const toast = useToast()
  const list = useSpecialists()
  const [open, setOpen] = useState<string>()
  const modelName = (ref?: string) =>
    ref ? (props.models.find((m) => m.ref === ref)?.name ?? ref) : t.teamModel
  return (
    <>
      <PageHeader title={t.title}>{t.intro}</PageHeader>
      <div {...settingRow('specialists.add')}>
        <div className="mb-4 flex justify-end">
          <Button
            size="sm"
            variant="primary"
            icon={<Plus className="size-3.5" />}
            onClick={() => setOpen('new')}
          >
            {t.add}
          </Button>
        </div>
        {open === 'new' && (
          <Card className="mb-4 p-4">
            <SpecialistEditor
              models={props.models}
              onSaved={() => setOpen(undefined)}
              onCancel={() => setOpen(undefined)}
            />
          </Card>
        )}
      </div>
      {list.length === 0 && open !== 'new' ? (
        <Empty icon={<FEATURE_ICONS.specialists className="size-5" />} title={t.empty}>
          {t.emptyHint}
        </Empty>
      ) : (
        <Card>
          {list.map((s) =>
            open === s.id ? (
              <div key={s.id} {...settingItem('specialists.specialist', s)} className="p-4">
                <SpecialistEditor
                  models={props.models}
                  initial={s}
                  onSaved={() => setOpen(undefined)}
                  onCancel={() => setOpen(undefined)}
                />
              </div>
            ) : (
              <div
                key={s.id}
                {...settingItem('specialists.specialist', s)}
                className="group flex items-center gap-3 px-4 py-3"
              >
                <AgentAvatar name={s.name} status="idle" size={32} awake />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-reading font-semibold">{s.name}</span>
                    <span className="truncate text-callout text-fg-2">{s.specialty}</span>
                  </div>
                  <div className="truncate text-small text-muted">
                    {modelName(s.model)}
                    {s.off.length > 0 && ` · ${t.toolsOff(s.off.map((g) => t.groups[g]).join(', '))}`}
                  </div>
                </div>
                <Button size="sm" variant="borderless" onClick={() => setOpen(s.id)}>
                  {t.edit}
                </Button>
                <ConfirmButton
                  label={t.remove}
                  confirm={copy.settings.specialists.confirmRemove}
                  onConfirm={() =>
                    void removeSpecialist(s.id).then(
                      () => toast(t.removed(s.name), 'info'),
                      (err: Error) => toast(err.message, 'error'),
                    )
                  }
                />
              </div>
            ),
          )}
        </Card>
      )}
    </>
  )
}

/** A choice shown as a small picture with its name under it, like macOS's appearance pickers. */
function Tile(props: { selected: boolean; label: string; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.selected}
      className="flex flex-col items-center gap-1.5 text-small text-fg-2"
    >
      <span
        className={cn(
          'grid place-items-center rounded-lg p-0.5 ring-2 transition-shadow',
          props.selected ? 'ring-accent' : 'ring-transparent hover:ring-line-strong',
        )}
      >
        {props.children}
      </span>
      <span className={props.selected ? 'font-medium text-fg' : ''}>{props.label}</span>
    </button>
  )
}

export function MascotSection(props: {
  data: SettingsResponse
  update(p: (s: ServerSettings) => ServerSettings, immediate?: boolean): void
  /**
   * Inside the setup assistant: its own heading, only the name and the look, and no small preview, since the
   * assistant's own mascot changes as the person picks.
   */
  embedded?: boolean
}) {
  const t = copy.settings.mascot
  const profile = props.data.settings.profile ?? { greeting: 'model' as const }
  const look = withMascotDefaults(props.data.settings.mascot)
  const set = (patch: MascotPatch) =>
    props.update((s) => ({ ...s, mascot: withMascotDefaults(s.mascot, patch) }), true)
  return (
    <>
      {!props.embedded && <PageHeader title={t.title}>{t.intro}</PageHeader>}
      <Card className="mb-6">
        <SettingField id="mascot.name" hint={t.nameHint(props.data.account ?? '')} inline>
          <TextInput
            value={profile.name ?? ''}
            placeholder={props.data.account}
            maxLength={40}
            aria-label={t.name}
            onChange={(e) =>
              props.update((s) => ({
                ...s,
                profile: { greeting: 'model', ...s.profile, name: e.target.value },
              }))
            }
            className="w-48"
          />
        </SettingField>
        {!props.embedded && (
          <SettingField id="mascot.greeting" hint={t.greetingHints[profile.greeting]} inline>
            <Segmented
              id="greeting"
              value={profile.greeting}
              options={[
                { value: 'model', label: t.greetingModel },
                { value: 'rules', label: t.greetingRules },
              ]}
              onChange={(greeting) =>
                props.update((s) => ({ ...s, profile: { ...s.profile, greeting } }), true)
              }
            />
          </SettingField>
        )}
      </Card>
      <Card>
        {!props.embedded && (
          <CardRow {...settingRow('mascot.preview')}>
            <MascotPreview look={look} />
          </CardRow>
        )}
        <SettingField id="mascot.eyes">
          <div className="flex flex-wrap gap-3">
            {(['round', 'happy', 'tall', 'sleepy', 'lashes'] as const).map((eyes) => (
              <Tile
                key={eyes}
                selected={look.eyes === eyes}
                label={t.eyeStyles[eyes]}
                onClick={() => set({ eyes })}
              >
                <MiniMascot look={{ ...look, eyes, look: 'neutral' }} />
              </Tile>
            ))}
          </div>
        </SettingField>
        <SettingField id="mascot.look">
          <div className="flex flex-wrap gap-4">
            {(['neutral', 'flower', 'bow'] as const).map((l) => (
              <Tile key={l} selected={look.look === l} label={t.looks[l]} onClick={() => set({ look: l })}>
                <span className="px-1.5 pb-2 pt-1.5">
                  <MiniMascot look={{ ...look, look: l }} />
                </span>
              </Tile>
            ))}
          </div>
        </SettingField>
        <SettingField id="mascot.color">
          <div className="flex flex-wrap gap-3">
            {(Object.keys(MASCOT_COLORS) as (keyof typeof MASCOT_COLORS)[]).map((color) => (
              <Tile
                key={color}
                selected={look.color === color}
                label={t.colors[color]}
                onClick={() => set({ color })}
              >
                <span className="grid size-10 place-items-center rounded-base bg-screen">
                  <span className="size-4 rounded-sm" style={{ background: MASCOT_COLORS[color] }} />
                </span>
              </Tile>
            ))}
          </div>
        </SettingField>
        <SettingField id="mascot.screen" inline>
          <Segmented
            id="mascot-screen"
            value={look.screen}
            options={(['rotate', 'clock', 'name', 'crew', 'face'] as const).map((screen) => ({
              value: screen,
              label: t.screens[screen],
            }))}
            onChange={(screen) => set({ screen })}
          />
        </SettingField>
      </Card>
      {!props.embedded && <MascotBehaviour look={look} set={set} />}
    </>
  )
}

/** Crew & budget → Reviewer: when the work is reviewed, the score it must reach, and the rubric. */
function ReviewerSettings(props: {
  settings: ServerSettings
  update(p: (s: ServerSettings) => ServerSettings): void
}) {
  const v = props.settings.verification
  const off = v.reviewer === 'off'
  return (
    <>
      <SectionHeader
        as="h3"
        icon={<FEATURE_ICONS.reviewer className="size-4 text-muted" />}
        title={copy.settings.reviewer.title}
      />
      <p className="mb-3 mt-1 text-callout text-muted">{copy.settings.reviewer.intro}</p>
      <Card>
        <SettingField id="reviewer.when" hint={REVIEWER_HINT[v.reviewer]} inline>
          <Segmented
            id="reviewer"
            value={v.reviewer}
            options={[
              { value: 'off', label: copy.settings.shared.off },
              { value: 'auto', label: copy.settings.reviewer.auto },
              { value: 'always', label: copy.settings.reviewer.always },
            ]}
            onChange={(reviewer) =>
              props.update((s) => ({ ...s, verification: { ...s.verification, reviewer } }))
            }
          />
        </SettingField>
        <SettingField id="reviewer.threshold" inline>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0.3}
              max={1}
              step={0.05}
              value={v.threshold}
              onChange={(e) =>
                props.update((s) => ({
                  ...s,
                  verification: { ...s.verification, threshold: Number(e.target.value) },
                }))
              }
              className="w-40 accent-[var(--accent)]"
              aria-label={copy.settings.reviewer.threshold}
              disabled={off}
            />
            <span className="w-10 text-right font-mono text-body tabular-nums">{v.threshold.toFixed(2)}</span>
          </div>
        </SettingField>
        <SettingField id="reviewer.rubric">
          <TextArea
            value={v.rubric ?? ''}
            onChange={(e) =>
              props.update((s) => ({ ...s, verification: { ...s.verification, rubric: e.target.value } }))
            }
            placeholder={copy.settings.reviewer.rubricPlaceholder}
            rows={5}
            disabled={off}
          />
        </SettingField>
      </Card>
    </>
  )
}

function InstructionsSection(props: {
  settings: ServerSettings
  update(p: (s: ServerSettings) => ServerSettings): void
}) {
  const i = props.settings.instructions
  return (
    <>
      <PageHeader title={copy.settings.instructions.title}>{copy.settings.instructions.intro}</PageHeader>
      <Card>
        <SettingField id="instructions.lead">
          <TextArea
            value={i.lead ?? ''}
            onChange={(e) =>
              props.update((s) => ({ ...s, instructions: { ...s.instructions, lead: e.target.value } }))
            }
            placeholder={copy.settings.instructions.leadPlaceholder}
            rows={5}
          />
        </SettingField>
        <SettingField id="instructions.workers">
          <TextArea
            value={i.worker ?? ''}
            onChange={(e) =>
              props.update((s) => ({ ...s, instructions: { ...s.instructions, worker: e.target.value } }))
            }
            placeholder={copy.settings.instructions.workersPlaceholder}
            rows={5}
          />
        </SettingField>
      </Card>
    </>
  )
}

export interface ScheduleEntry {
  id: string
  name: string
  request: string
  cron: string
  project?: string
  /** A channel the owner follows each run on. */
  deliver?: string
  enabled: boolean
  nextRun?: string
  lastRun?: { at: string; chatId?: string; error?: string }
}

const when = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'

const REPEATS: Repeat[] = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom']
/** Minutes past the hour an hourly schedule offers; a schedule saved at another minute keeps its own. */
const HOURLY_MINUTES = Array.from({ length: 12 }, (_, i) => i * 5)
/** Monday first in the day chips, as most calendars show a week; cron still counts Sunday as 0. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

/** Why a picked schedule cannot be saved, in words, or nothing. */
function ruleError(rule: ScheduleRule): string | undefined {
  if (rule.repeat === 'weekly' && rule.days.length === 0) return copy.settings.schedules.pickADay
  if (rule.repeat === 'custom') return cronError(rule.cron)
  return undefined
}

/**
 * When a schedule runs: a repeat, then the time, days or day of the month it needs, with the result in plain words.
 * Cron stays available as Custom for anything the picker cannot say.
 */
function SchedulePicker(props: { rule: ScheduleRule; onChange(rule: ScheduleRule): void }) {
  const t = copy.settings.schedules
  const { rule, onChange } = props
  const errorId = useId()
  const error = ruleError(rule)
  const timed = rule.repeat !== 'hourly' && rule.repeat !== 'custom'
  const minutes = HOURLY_MINUTES.includes(rule.minute)
    ? HOURLY_MINUTES
    : [...HOURLY_MINUTES, rule.minute].sort((a, b) => a - b)
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label={t.repeat.label}
          value={rule.repeat}
          onChange={(e) => {
            const repeat = e.target.value as Repeat
            // Switching to Custom starts from what was picked, so the person edits a working expression.
            onChange({ ...rule, repeat, ...(repeat === 'custom' ? { cron: ruleToCron(rule) } : {}) })
          }}
        >
          {REPEATS.map((r) => (
            <option key={r} value={r}>
              {t.repeat[r]}
            </option>
          ))}
        </Select>
        {rule.repeat === 'hourly' && (
          <Select
            aria-label={t.minutePast}
            value={rule.minute}
            onChange={(e) => onChange({ ...rule, minute: Number(e.target.value) })}
          >
            {minutes.map((m) => (
              <option key={m} value={m}>
                :{String(m).padStart(2, '0')}
              </option>
            ))}
          </Select>
        )}
        {rule.repeat === 'monthly' && (
          <Select
            aria-label={t.dayOfMonth}
            value={rule.dayOfMonth}
            onChange={(e) => onChange({ ...rule, dayOfMonth: Number(e.target.value) })}
          >
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {t.ordinal(d)}
              </option>
            ))}
          </Select>
        )}
        {timed && (
          <div className="w-28">
            <TextInput
              type="time"
              aria-label={t.time}
              value={`${String(rule.hour).padStart(2, '0')}:${String(rule.minute).padStart(2, '0')}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(':').map(Number)
                // A cleared field keeps the last time rather than saving a schedule that has none.
                if (Number.isInteger(h) && Number.isInteger(m))
                  onChange({ ...rule, hour: h as number, minute: m as number })
              }}
            />
          </div>
        )}
        {rule.repeat === 'custom' && (
          <div className="w-56">
            <TextInput
              aria-label={t.cronExpression}
              aria-invalid={!!error}
              aria-describedby={error ? errorId : undefined}
              value={rule.cron}
              onChange={(e) => onChange({ ...rule, cron: e.target.value })}
              placeholder={t.cronPlaceholder}
              className="font-mono"
            />
          </div>
        )}
      </div>
      {rule.repeat === 'weekly' && (
        <fieldset className="mt-2 flex flex-wrap gap-1" aria-describedby={error ? errorId : undefined}>
          <legend className="sr-only">{t.days}</legend>
          {WEEK_ORDER.map((d) => {
            const on = rule.days.includes(d)
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                aria-label={t.dayName[d]}
                onClick={() =>
                  onChange({ ...rule, days: on ? rule.days.filter((x) => x !== d) : [...rule.days, d] })
                }
                className={cn(
                  'h-7 min-w-11 rounded-md px-2 text-small font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-focus/30',
                  on ? 'bg-accent text-on-accent' : 'bg-fill-strong text-fg-2 hover:text-fg',
                )}
              >
                {t.dayShort[d]}
              </button>
            )
          })}
        </fieldset>
      )}
      {error ? (
        <p id={errorId} className="mt-1.5 text-small leading-snug text-bad-ink">
          {error}
        </p>
      ) : (
        <p className="mt-1.5 text-small leading-snug text-muted">
          {describeCron(ruleToCron(rule))}
          {rule.repeat !== 'custom' && ` ${t.localTime}`}
          {rule.repeat === 'monthly' &&
            rule.dayOfMonth > 28 &&
            `. ${t.shortMonths(t.ordinal(rule.dayOfMonth))}`}
        </p>
      )}
    </div>
  )
}

/** Requests that start on their own on a cron schedule, as new chats with the default team. */
function SchedulesSection() {
  const toast = useToast()
  const [list, setList] = useState<ScheduleEntry[]>()
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [draft, setDraft] = useState({
    request: '',
    rule: DEFAULT_RULE,
    project: '',
    deliver: '',
  })
  // The schedule whose time is being changed in place, with the rule picked so far.
  const [editing, setEditing] = useState<{ id: string; rule: ScheduleRule }>()
  // Channels with an owner can report each run there.
  const [channels, setChannels] = useState<{ id: string; label: string }[]>([])
  const load = () =>
    api<{ schedules: ScheduleEntry[] }>('/api/schedules')
      .then((r) => setList(r.schedules))
      .catch((err: Error) => toast(err.message, 'error'))
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once
  useEffect(() => {
    void load()
    api<{ channels: { id: string; label: string; configured: boolean; people: { role: string }[] }[] }>(
      '/api/channels',
    )
      .then((r) =>
        setChannels(r.channels.filter((c) => c.configured && c.people.some((p) => p.role === 'owner'))),
      )
      .catch(() => {})
    api<{ projects: { id: string; name: string }[] }>('/api/projects')
      .then((r) => setProjects(r.projects))
      .catch(() => {})
  }, [])
  const act = (run: () => Promise<unknown>, done?: string) =>
    void run()
      .then(() => {
        if (done) toast(done, 'success')
        return load()
      })
      .catch((err: Error) => toast(err.message, 'error'))
  return (
    <>
      <PageHeader title={copy.settings.schedules.title}>{copy.settings.schedules.intro}</PageHeader>
      <Card className="mb-6">
        <CardRow {...settingRow('schedules.add')}>
          <Field label={copy.settings.schedules.request}>
            <TextArea
              rows={2}
              value={draft.request}
              onChange={(e) => setDraft({ ...draft, request: e.target.value })}
              placeholder={copy.settings.schedules.requestPlaceholder}
            />
          </Field>
          <div className="mt-3">
            <SchedulePicker rule={draft.rule} onChange={(rule) => setDraft({ ...draft, rule })} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select
              aria-label={copy.settings.schedules.project}
              value={draft.project}
              onChange={(e) => setDraft({ ...draft, project: e.target.value })}
            >
              <option value="">{copy.settings.schedules.noProject}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            {channels.length > 0 && (
              <Select
                aria-label={copy.settings.schedules.deliver}
                value={draft.deliver}
                onChange={(e) => setDraft({ ...draft, deliver: e.target.value })}
              >
                <option value="">{copy.settings.schedules.noDeliver}</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {copy.settings.schedules.deliverTo(c.label)}
                  </option>
                ))}
              </Select>
            )}
            <span className="flex-1" />
            <Button
              size="sm"
              variant="primary"
              icon={<Plus className="size-3.5" />}
              disabled={!draft.request.trim() || !!ruleError(draft.rule)}
              onClick={() =>
                act(async () => {
                  await send('POST', '/api/schedules', {
                    request: draft.request,
                    cron: ruleToCron(draft.rule),
                    ...(draft.project ? { project: draft.project } : {}),
                    ...(draft.deliver ? { deliver: draft.deliver } : {}),
                  })
                  setDraft({ ...draft, request: '' })
                }, copy.settings.schedules.scheduled)
              }
            >
              {copy.settings.schedules.schedule}
            </Button>
          </div>
        </CardRow>
      </Card>
      {!list ? (
        <div className="flex items-center gap-2 text-body text-muted">
          <LoaderCircle className="size-4 animate-spin" /> {copy.settings.schedules.loading}
        </div>
      ) : list.length === 0 ? (
        <Empty
          icon={<FEATURE_ICONS.schedules className="size-5" />}
          title={copy.settings.schedules.emptyTitle}
        >
          {copy.settings.schedules.emptyBody}
        </Empty>
      ) : (
        <Card>
          {list.map((s) => (
            <CardRow key={s.id} {...settingItem('schedules.schedule', s)}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-reading leading-relaxed">{s.request}</p>
                  <p className="mt-1 flex flex-wrap gap-x-3 text-small text-muted">
                    <span>{describeCron(s.cron)}</span>
                    {s.project && (
                      <span>
                        {copy.settings.schedules.inProject(
                          projects.find((p) => p.id === s.project)?.name ?? s.project,
                        )}
                      </span>
                    )}
                    {s.deliver && (
                      <span>
                        {copy.settings.schedules.deliverTo(
                          channels.find((c) => c.id === s.deliver)?.label ?? s.deliver,
                        )}
                      </span>
                    )}
                    <span>
                      {s.enabled
                        ? copy.settings.schedules.next(when(s.nextRun))
                        : copy.settings.schedules.paused}
                    </span>
                    {s.lastRun && (
                      <span className={s.lastRun.error ? 'text-bad-ink' : ''}>
                        {copy.settings.schedules.last(when(s.lastRun.at))}
                        {s.lastRun.error ? `: ${s.lastRun.error}` : ''}
                      </span>
                    )}
                  </p>
                  {editing?.id === s.id && (
                    <div className="mt-3">
                      <SchedulePicker
                        rule={editing.rule}
                        onChange={(rule) => setEditing({ id: s.id, rule })}
                      />
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={!!ruleError(editing.rule)}
                          onClick={() =>
                            act(async () => {
                              await send('PATCH', `/api/schedules/${s.id}`, {
                                cron: ruleToCron(editing.rule),
                              })
                              setEditing(undefined)
                            }, copy.settings.schedules.updated)
                          }
                        >
                          {copy.settings.schedules.save}
                        </Button>
                        <Button size="sm" variant="borderless" onClick={() => setEditing(undefined)}>
                          {copy.settings.schedules.cancel}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                {editing?.id !== s.id && (
                  <Button
                    size="sm"
                    variant="borderless"
                    onClick={() => setEditing({ id: s.id, rule: cronToRule(s.cron) })}
                  >
                    {copy.settings.schedules.change}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="borderless"
                  onClick={() =>
                    act(() => send('POST', `/api/schedules/${s.id}/run`), copy.settings.schedules.started)
                  }
                >
                  {copy.settings.schedules.runNow}
                </Button>
                <Switch
                  checked={s.enabled}
                  label={copy.settings.schedules.runOnSchedule(s.name)}
                  onChange={(enabled) => act(() => send('PATCH', `/api/schedules/${s.id}`, { enabled }))}
                />
                <ConfirmButton
                  icon
                  label={copy.settings.schedules.delete}
                  confirm={copy.settings.schedules.confirmDelete}
                  onConfirm={() => act(() => send('DELETE', `/api/schedules/${s.id}`))}
                />
              </div>
            </CardRow>
          ))}
        </Card>
      )}
    </>
  )
}

type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop'
interface HookRow {
  event: HookEvent
  matcher: string
  command: string
  timeout: string
}
type HooksFile = {
  hooks: Partial<
    Record<HookEvent, { matcher?: string; hooks: { type: 'command'; command: string; timeout?: number }[] }[]>
  >
}

const HOOK_EVENTS: { value: HookEvent; label: string }[] = [
  { value: 'PreToolUse', label: copy.settings.hooks.events.PreToolUse },
  { value: 'PostToolUse', label: copy.settings.hooks.events.PostToolUse },
  { value: 'Stop', label: copy.settings.hooks.events.Stop },
]

function rowsOf(file: HooksFile): HookRow[] {
  return HOOK_EVENTS.flatMap(({ value }) =>
    (file.hooks[value] ?? []).flatMap((g) =>
      g.hooks.map((h) => ({
        event: value,
        matcher: g.matcher ?? '',
        command: h.command,
        timeout: h.timeout ? String(h.timeout) : '',
      })),
    ),
  )
}

function fileOf(rows: HookRow[]): HooksFile {
  const hooks: HooksFile['hooks'] = {}
  for (const r of rows) {
    if (!r.command.trim()) continue
    const timeout = Number(r.timeout)
    const groups = hooks[r.event] ?? []
    hooks[r.event] = groups
    groups.push({
      ...(r.event !== 'Stop' && r.matcher.trim() ? { matcher: r.matcher.trim() } : {}),
      hooks: [{ type: 'command', command: r.command.trim(), ...(timeout > 0 ? { timeout } : {}) }],
    })
  }
  return { hooks }
}

/**
 * The person's hooks, in Claude Code's format: commands Myrmidon runs before or after matching tools, or when a
 * round ends. They run as the person, outside the sandbox, which is why they save only on Save rather than as each
 * character is typed: a half-written command would already run on the next tool call.
 */
function HooksSection(props: { onDirty(dirty: boolean): void }) {
  const toast = useToast()
  const [rows, setRows] = useState<HookRow[]>()
  const [dirty, setDirty] = useState(false)
  const { onDirty } = props
  useEffect(() => {
    onDirty(dirty)
  }, [dirty, onDirty])
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once
  useEffect(() => {
    api<HooksFile>('/api/hooks')
      .then((f) => setRows(rowsOf(f)))
      .catch((err: Error) => toast(err.message, 'error'))
  }, [])
  const change = (i: number, patch: Partial<HookRow>) => {
    setRows((rs) => rs?.map((r, j) => (j === i ? { ...r, ...patch } : r)))
    setDirty(true)
  }
  const save = async () => {
    try {
      const saved = await send<HooksFile>('PUT', '/api/hooks', fileOf(rows ?? []))
      setRows(rowsOf(saved))
      setDirty(false)
      toast(copy.settings.hooks.saved, 'success')
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }
  return (
    <>
      <PageHeader title={copy.settings.hooks.title}>
        {copy.settings.hooks.introBeforeFsEdit}
        <code className="font-mono text-callout">fs_edit</code>
        {copy.settings.hooks.introBeforeShell}
        <code className="font-mono text-callout">shell</code>
        {copy.settings.hooks.introBeforeEditWrite}
        <code className="font-mono text-callout">Edit|Write</code>
        {copy.settings.hooks.introBeforeBash}
        <code className="font-mono text-callout">Bash</code>
        {copy.settings.hooks.introAfterBash}
      </PageHeader>
      <div
        role="note"
        className="mb-4 flex items-start gap-3 rounded-2xl border border-warn/25 bg-warn-soft px-4 py-3 text-body"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn-ink" />
        <div>
          <div className="font-semibold">{copy.settings.hooks.warningTitle}</div>
          <div className="text-fg-2">{copy.settings.hooks.warning}</div>
        </div>
      </div>
      {!rows ? (
        <div className="flex items-center gap-2 text-body text-muted">
          <LoaderCircle className="size-4 animate-spin" /> {copy.settings.hooks.loading}
        </div>
      ) : (
        <div {...settingRow('hooks.list')}>
          <Card>
            {rows.length === 0 && (
              <CardRow>
                <p className="text-body text-muted">{copy.settings.hooks.empty}</p>
              </CardRow>
            )}
            {rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place by position
              <CardRow key={i}>
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      aria-label={copy.settings.hooks.when}
                      value={r.event}
                      onChange={(e) => change(i, { event: e.target.value as HookEvent })}
                    >
                      {HOOK_EVENTS.map((ev) => (
                        <option key={ev.value} value={ev.value}>
                          {ev.label}
                        </option>
                      ))}
                    </Select>
                    {r.event !== 'Stop' && (
                      <div className="w-56">
                        <TextInput
                          aria-label={copy.settings.hooks.tools}
                          value={r.matcher}
                          onChange={(e) => change(i, { matcher: e.target.value })}
                          placeholder={copy.settings.hooks.toolsPlaceholder}
                        />
                      </div>
                    )}
                    <div className="w-20">
                      <TextInput
                        aria-label={copy.settings.hooks.timeout}
                        value={r.timeout}
                        onChange={(e) => change(i, { timeout: e.target.value.replace(/[^\d.]/g, '') })}
                        placeholder={copy.settings.hooks.timeoutPlaceholder}
                      />
                    </div>
                    <span className="flex-1" />
                    <IconButton
                      label={copy.settings.hooks.remove}
                      onClick={() => {
                        setRows((rs) => rs?.filter((_, j) => j !== i))
                        setDirty(true)
                      }}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                  <TextInput
                    aria-label={copy.settings.hooks.command}
                    value={r.command}
                    onChange={(e) => change(i, { command: e.target.value })}
                    placeholder={copy.settings.hooks.commandPlaceholder}
                    className="font-mono"
                  />
                </div>
              </CardRow>
            ))}
            <CardRow>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="borderless"
                  icon={<Plus className="size-3.5" />}
                  onClick={() => {
                    setRows((rs) => [
                      ...(rs ?? []),
                      { event: 'PostToolUse', matcher: '', command: '', timeout: '' },
                    ])
                    setDirty(true)
                  }}
                >
                  {copy.settings.hooks.add}
                </Button>
                <span className="flex-1" />
                <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void save()}>
                  {copy.settings.shared.save}
                </Button>
              </div>
            </CardRow>
          </Card>
        </div>
      )}
    </>
  )
}

export interface SkillEntry {
  name: string
  description: string
  dir: string
  source: 'myrmidon' | 'claude' | 'plugin' | 'project'
  enabled: boolean
  curation?: { uses: number; lastUsed?: string; stale: boolean; kept: boolean }
}

interface SkillsResponse {
  skills: SkillEntry[]
  archived: { name: string; description: string }[]
  dir?: string
  retire?: { staleDays: number; archiveDays: number }
}

const SKILL_SOURCES: Record<SkillEntry['source'], string> = {
  myrmidon: copy.settings.skills.sources.myrmidon,
  claude: copy.settings.skills.sources.claude,
  plugin: copy.settings.skills.sources.plugin,
  project: copy.settings.skills.sources.project,
}

export interface PluginEntry {
  name: string
  version?: string
  description?: string
  author?: string
  dir: string
  enabled: boolean
  skills: string[]
  commands: { name: string }[]
  hooks: number
  mcpServers: string[]
  error?: string
  /** Its code's entry point, when it has code. */
  server?: string
  settings: Record<string, { type: 'string' | 'number' | 'boolean'; description?: string; secret?: boolean }>
  values: Record<string, string | number | boolean>
  status?: { loaded: boolean; error?: string; tools: string[]; log: string[] }
}

/** A plugin's settings, saved one field at a time when it loses focus (or a switch flips). */
function PluginSettings(props: { plugin: PluginEntry; onSaved(): void }) {
  const toast = useToast()
  const save = (key: string, value: string | number | boolean) =>
    void send('PUT', `/api/plugins/${props.plugin.name}/settings`, { [key]: value })
      .then(props.onSaved)
      .catch((err: Error) => toast(err.message, 'error'))
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-line bg-fill/40 p-3">
      {Object.entries(props.plugin.settings).map(([key, spec]) => {
        const value = props.plugin.values[key]
        return (
          <div key={key} className="flex flex-col gap-1">
            <span className="flex items-center justify-between gap-2">
              <span className="font-mono text-callout font-medium">{key}</span>
              {spec.type === 'boolean' && (
                <Switch checked={value === true} label={key} onChange={(on) => save(key, on)} />
              )}
            </span>
            {spec.description && <span className="text-small text-muted">{spec.description}</span>}
            {spec.type !== 'boolean' && (
              <TextInput
                type={spec.secret ? 'password' : spec.type === 'number' ? 'number' : 'text'}
                defaultValue={spec.secret ? '' : String(value ?? '')}
                placeholder={spec.secret && value ? copy.settings.plugins.secretSet : ''}
                onBlur={(e) => {
                  const text = e.target.value
                  if (spec.secret && !text) return
                  if (!spec.secret && text === String(value ?? '')) return
                  save(key, spec.type === 'number' ? Number(text) : text)
                }}
                aria-label={key}
                className="font-mono"
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The person's plugins: add one from a folder or git URL, switch each on or off, remove it. */
function PluginsSection() {
  const toast = useToast()
  const [data, setData] = useState<{ plugins: PluginEntry[]; dir?: string }>()
  const [source, setSource] = useState('')
  const [adding, setAdding] = useState(false)
  const load = () =>
    api<{ plugins: PluginEntry[]; dir?: string }>('/api/plugins')
      .then(setData)
      .catch((err: Error) => toast(err.message, 'error'))
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once
  useEffect(() => {
    void load()
  }, [])
  const add = async () => {
    setAdding(true)
    try {
      const r = await send<{ plugin: PluginEntry }>('POST', '/api/plugins', { source })
      toast(copy.settings.plugins.added(r.plugin.name), 'success')
      setSource('')
      await load()
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setAdding(false)
    }
  }
  const [logOpen, setLogOpen] = useState<string>()
  const pages = usePluginSlots('settings.page')
  const parts = (p: PluginEntry) =>
    [
      p.skills.length ? copy.settings.plugins.skills(p.skills.length) : '',
      p.commands.length ? copy.settings.plugins.commands(p.commands.length) : '',
      p.hooks ? copy.settings.plugins.hooks(p.hooks) : '',
      p.mcpServers.length ? copy.settings.plugins.servers(p.mcpServers.length) : '',
      p.status?.tools.length ? copy.settings.plugins.tools(p.status.tools.length) : '',
    ].filter(Boolean)
  return (
    <>
      <PageHeader title={copy.settings.plugins.title}>{copy.settings.plugins.intro}</PageHeader>
      <form
        {...settingRow('plugins.add')}
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (source.trim() && !adding) void add()
        }}
      >
        <TextInput
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder={copy.settings.plugins.sourcePlaceholder}
          aria-label={copy.settings.plugins.sourceLabel}
          className="flex-1 font-mono"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!source.trim()}
          loading={adding}
          icon={<Plus className="size-3.5" />}
        >
          {adding ? copy.settings.plugins.adding : copy.settings.plugins.add}
        </Button>
      </form>
      {!data ? (
        <div className="flex items-center gap-2 text-body text-muted">
          <LoaderCircle className="size-4 animate-spin" /> {copy.settings.plugins.loading}
        </div>
      ) : data.plugins.length === 0 ? (
        <Empty icon={<FEATURE_ICONS.plugins className="size-5" />} title={copy.settings.plugins.emptyTitle}>
          {copy.settings.plugins.emptyBody}
        </Empty>
      ) : (
        <>
          <Card>
            {data.plugins.map((p) => (
              <CardRow key={p.name} {...settingItem('plugins.plugin', p)}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('font-mono text-reading font-medium', !p.enabled && 'text-muted')}>
                        {p.name}
                      </span>
                      {p.version && <span className="text-small text-muted">v{p.version}</span>}
                      {p.author && (
                        <span className="text-small text-muted">{copy.settings.plugins.by(p.author)}</span>
                      )}
                    </div>
                    {p.description && (
                      <p className="mt-1 text-body leading-relaxed text-fg-2">{p.description}</p>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {parts(p).map((part) => (
                        <Badge key={part} tone="neutral">
                          {part}
                        </Badge>
                      ))}
                    </div>
                    {p.error && <p className="mt-1.5 text-callout text-bad-ink">{p.error}</p>}
                    {p.server && p.enabled && (
                      <p
                        className={cn(
                          'mt-1.5 text-callout',
                          p.status?.error ? 'text-bad-ink' : p.status?.loaded ? 'text-ok-ink' : 'text-muted',
                        )}
                      >
                        {p.status?.error
                          ? copy.settings.plugins.codeFailed(p.status.error)
                          : p.status?.loaded
                            ? copy.settings.plugins.codeRunning
                            : copy.settings.plugins.codeStarting}
                      </p>
                    )}
                    {Object.keys(p.settings).length > 0 && p.enabled && (
                      <PluginSettings plugin={p} onSaved={() => void load()} />
                    )}
                    {pages
                      .filter((page) => page.plugin === p.name && p.enabled)
                      .map(({ plugin, def }) => (
                        <div key={plugin} className="mt-2">
                          <PluginSlot
                            plugin={plugin}
                            def={def}
                            props={{
                              values: p.values,
                              save: async (values) => {
                                await send('PUT', `/api/plugins/${plugin}/settings`, values)
                                await load()
                              },
                            }}
                          />
                        </div>
                      ))}
                    {p.status?.log.length ? (
                      <div className="mt-1.5">
                        <button
                          type="button"
                          onClick={() => setLogOpen(logOpen === p.name ? undefined : p.name)}
                          className="text-small text-muted hover:text-fg-2"
                        >
                          {logOpen === p.name ? copy.settings.plugins.hideLog : copy.settings.plugins.showLog}
                        </button>
                        {logOpen === p.name && (
                          <pre className="mt-1 max-h-48 overflow-auto rounded-xl bg-fill/60 px-2.5 py-2 font-mono text-footnote text-fg-2">
                            {p.status.log.join('\n')}
                          </pre>
                        )}
                      </div>
                    ) : null}
                    <p className="mt-1 truncate font-mono text-footnote text-muted" title={p.dir}>
                      {p.dir}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <ConfirmButton
                      label={copy.settings.plugins.remove}
                      confirm={copy.settings.plugins.confirmRemove}
                      onConfirm={() =>
                        void send('DELETE', `/api/plugins/${p.name}`)
                          .then(() => toast(copy.settings.plugins.removed(p.name), 'success'))
                          .then(load)
                          .catch((err: Error) => toast(err.message, 'error'))
                      }
                    />
                    <Switch
                      checked={p.enabled}
                      label={copy.settings.plugins.canUse(p.name)}
                      onChange={(enabled) =>
                        void send('PUT', `/api/plugins/${p.name}`, { enabled })
                          .then(load)
                          .catch((err: Error) => toast(err.message, 'error'))
                      }
                    />
                  </div>
                </div>
              </CardRow>
            ))}
          </Card>
          <p className="mt-2 text-small text-muted">{copy.settings.plugins.applies}</p>
        </>
      )}
    </>
  )
}

/**
 * A skill's description, two lines at most until expanded: some are paragraphs written for the model. Its folder
 * shows only when expanded (and as the name's tooltip), since a path says little at a glance.
 */
function SkillDescription(props: { text: string; dir: string }) {
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  const box = useRef<HTMLParagraphElement>(null)
  // Whether the text overflows two lines can only be measured once it is laid out.
  useLayoutEffect(() => {
    const el = box.current
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1)
  }, [open])
  return (
    <>
      <p ref={box} className={cn('mt-1 text-body leading-relaxed text-fg-2', !open && 'line-clamp-2')}>
        {props.text}
      </p>
      {open && (
        <p className="mt-1 break-all font-mono text-footnote text-muted" title={props.dir}>
          {props.dir}
        </p>
      )}
      {(long || open) && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="mt-0.5 text-small font-medium text-muted hover:text-fg"
        >
          {open ? copy.settings.skills.showLess : copy.settings.skills.showMore}
        </button>
      )}
    </>
  )
}

/** Skills agents can load: from Myrmidon's skills folder and the person's Claude Code skills, each switchable. */
function SkillsSection() {
  const toast = useToast()
  const [data, setData] = useState<SkillsResponse>()
  const [proposed, setProposed] = useState<SkillProposalView[]>([])
  const load = () => {
    api<{ proposals: SkillProposalView[] }>('/api/skill-proposals')
      .then((r) => setProposed(r.proposals))
      .catch(() => {})
    return api<SkillsResponse>('/api/skills')
      .then(setData)
      .catch((err: Error) => toast(err.message, 'error'))
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once
  useEffect(() => {
    void load()
  }, [])
  return (
    <>
      <PageHeader title={copy.settings.skills.title}>
        {copy.settings.skills.introBeforeDir}
        <code className="font-mono text-callout">{data?.dir ?? 'skills/'}</code>
        {copy.settings.skills.introBeforeUserDir}
        <code className="font-mono text-callout">~/.claude/skills</code>
        {copy.settings.skills.introBeforeProjectDir}
        <code className="font-mono text-callout">.claude/skills</code>
        {copy.settings.skills.introAfterProjectDir}
        {data?.retire &&
          ` ${copy.settings.skills.retireIntro(data.retire.staleDays, data.retire.archiveDays)}`}
      </PageHeader>
      {proposed.length > 0 && (
        <div {...settingRow('skills.proposed')} className="mb-6 flex flex-col gap-3">
          <SectionHeader title={copy.settings.skills.proposed(proposed.length)} />
          <AnimatePresence initial={false}>
            {proposed.map((p) => (
              <SkillProposalCard key={p.id} proposal={p} onDecided={() => void load()} />
            ))}
          </AnimatePresence>
        </div>
      )}
      {!data ? (
        <div className="flex items-center gap-2 text-body text-muted">
          <LoaderCircle className="size-4 animate-spin" /> {copy.settings.skills.loading}
        </div>
      ) : data.skills.length === 0 ? (
        <Empty icon={<FEATURE_ICONS.skills className="size-5" />} title={copy.settings.skills.emptyTitle}>
          {copy.settings.skills.emptyBody}
        </Empty>
      ) : (
        <Card>
          {data.skills.map((s) => (
            <CardRow key={s.name} {...settingItem('skills.skill', s)}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-reading font-medium" title={s.dir}>
                      {s.name}
                    </span>
                    <Badge tone={s.source === 'myrmidon' ? 'accent' : 'neutral'}>
                      {SKILL_SOURCES[s.source]}
                    </Badge>
                    {s.curation && <Badge>{copy.settings.skills.learned}</Badge>}
                    {s.curation?.stale && (
                      <span title={data.retire && copy.settings.skills.staleHint(data.retire.archiveDays)}>
                        <Badge tone="warn">{copy.settings.skills.stale}</Badge>
                      </span>
                    )}
                  </div>
                  <SkillDescription text={s.description} dir={s.dir} />
                  {s.curation && (
                    <div className="mt-1 text-footnote text-muted">
                      {copy.settings.skills.uses(
                        s.curation.uses,
                        s.curation.lastUsed ? ago(s.curation.lastUsed) : undefined,
                      )}
                    </div>
                  )}
                </div>
                {s.curation && (
                  <Button
                    size="sm"
                    variant="borderless"
                    icon={<Pin className={cn('size-3.5', s.curation.kept && 'fill-current')} />}
                    aria-pressed={s.curation.kept}
                    title={copy.settings.skills.keepHint}
                    onClick={() =>
                      void send('PUT', `/api/skills/${s.name}`, { kept: !s.curation?.kept })
                        .then(load)
                        .catch((err: Error) => toast(err.message, 'error'))
                    }
                  >
                    {s.curation.kept ? copy.settings.skills.kept : copy.settings.skills.keep}
                  </Button>
                )}
                <Switch
                  checked={s.enabled}
                  label={copy.settings.skills.canUse(s.name)}
                  onChange={(enabled) =>
                    void send('PUT', `/api/skills/${s.name}`, { enabled })
                      .then(load)
                      .catch((err: Error) => toast(err.message, 'error'))
                  }
                />
              </div>
            </CardRow>
          ))}
        </Card>
      )}
      {!!data?.archived.length && (
        <div {...settingRow('skills.archived')} className="mt-8">
          <SectionHeader title={copy.settings.skills.archivedTitle(data.archived.length)} />
          <p className="mb-3 text-footnote text-muted">{copy.settings.skills.archivedHint}</p>
          <Card>
            {data.archived.map((a) => (
              <CardRow key={a.name}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-reading font-medium text-fg-2">{a.name}</div>
                    <div className="text-footnote text-muted">{a.description}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="borderless"
                    icon={<ArchiveRestore className="size-3.5" />}
                    onClick={() =>
                      void post(`/api/skills/${a.name}/restore`, {})
                        .then(() => {
                          toast(copy.settings.skills.restored(a.name), 'success')
                          return load()
                        })
                        .catch((err: Error) => toast(err.message, 'error'))
                    }
                  >
                    {copy.settings.skills.restore}
                  </Button>
                </div>
              </CardRow>
            ))}
          </Card>
        </div>
      )}
    </>
  )
}

interface MemoryEntry {
  id: string
  text: string
  kind: 'preference' | 'decision' | 'lesson' | 'fact'
  project?: string
  status: 'active' | 'proposed'
  source: { by: 'person' | 'agent'; agent?: string; why?: string }
  updatedAt: string
}

const MEMORY_KINDS = ['preference', 'decision', 'lesson', 'fact'] as const

/** What Myrmidon keeps across chats: add, edit, re-scope and remove memories, and decide on agents' proposals. */
function MemorySection() {
  const toast = useToast()
  const [memories, setMemories] = useState<MemoryEntry[]>()
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [draft, setDraft] = useState({ text: '', kind: 'preference', project: '' })
  const [editing, setEditing] = useState<{ id: string; text: string }>()
  const load = () =>
    api<{ memories: MemoryEntry[] }>('/api/memory')
      .then((r) => setMemories(r.memories))
      .catch((err: Error) => toast(err.message, 'error'))
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once
  useEffect(() => {
    void load()
    api<{ projects: { id: string; name: string }[] }>('/api/projects')
      .then((r) => setProjects(r.projects))
      .catch(() => {})
  }, [])
  const act = async (run: () => Promise<unknown>) => {
    try {
      await run()
      await load()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }
  const scopeName = (project?: string) =>
    project ? (projects.find((p) => p.id === project)?.name ?? project) : copy.settings.memory.everyChat
  const groups = [...new Set((memories ?? []).map((m) => m.project ?? ''))].sort((a, b) =>
    a === '' ? -1 : b === '' ? 1 : scopeName(a).localeCompare(scopeName(b)),
  )
  return (
    <>
      <PageHeader title={copy.settings.memory.title}>{copy.settings.memory.intro}</PageHeader>
      <Card className="mb-6">
        <CardRow {...settingRow('memory.add')}>
          <Field label={copy.settings.memory.remember} hint={copy.settings.memory.rememberHint}>
            <TextArea
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              placeholder={copy.settings.memory.rememberPlaceholder}
              rows={2}
            />
          </Field>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select
              aria-label={copy.settings.memory.kind}
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
            >
              {MEMORY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {copy.settings.memory.kinds[k]}
                </option>
              ))}
            </Select>
            <Select
              aria-label={copy.settings.memory.appliesTo}
              value={draft.project}
              onChange={(e) => setDraft({ ...draft, project: e.target.value })}
            >
              <option value="">{copy.settings.memory.everyChat}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {copy.settings.memory.onlyProject(p.name)}
                </option>
              ))}
            </Select>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="primary"
              disabled={draft.text.trim().length < 3}
              icon={<Plus className="size-3.5" />}
              onClick={() =>
                void act(async () => {
                  await send('POST', '/api/memory', draft)
                  setDraft({ ...draft, text: '' })
                })
              }
            >
              {copy.settings.memory.rememberButton}
            </Button>
          </div>
        </CardRow>
      </Card>
      {!memories ? (
        <div className="flex items-center gap-2 text-body text-muted">
          <LoaderCircle className="size-4 animate-spin" /> {copy.settings.memory.loading}
        </div>
      ) : memories.length === 0 ? (
        <Empty icon={<FEATURE_ICONS.memory className="size-5" />} title={copy.settings.memory.emptyTitle}>
          {copy.settings.memory.emptyBody}
        </Empty>
      ) : (
        <div {...settingRow('memory.list')}>
          {groups.map((g) => (
            <section key={g || 'all'} className="mb-6">
              <h4 className="mb-2 section-label text-muted">{scopeName(g || undefined)}</h4>
              <Card>
                {memories
                  .filter((m) => (m.project ?? '') === g)
                  .map((m) => (
                    <CardRow key={m.id}>
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          {editing?.id === m.id ? (
                            <TextArea
                              autoFocus
                              rows={2}
                              value={editing.text}
                              onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                            />
                          ) : (
                            <button
                              type="button"
                              title={copy.settings.memory.edit}
                              onClick={() => setEditing({ id: m.id, text: m.text })}
                              className="w-full text-left text-reading leading-relaxed hover:text-fg-2"
                            >
                              {m.text}
                            </button>
                          )}
                          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-small text-muted">
                            <Select
                              aria-label={copy.settings.memory.kind}
                              value={m.kind}
                              onChange={(e) =>
                                void act(() => send('PATCH', `/api/memory/${m.id}`, { kind: e.target.value }))
                              }
                            >
                              {MEMORY_KINDS.map((k) => (
                                <option key={k} value={k}>
                                  {copy.settings.memory.kinds[k]}
                                </option>
                              ))}
                            </Select>
                            <Select
                              aria-label={copy.settings.memory.appliesTo}
                              value={m.project ?? ''}
                              onChange={(e) =>
                                void act(() =>
                                  send('PATCH', `/api/memory/${m.id}`, { project: e.target.value || null }),
                                )
                              }
                            >
                              <option value="">{copy.settings.memory.everyChat}</option>
                              {projects.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {copy.settings.memory.onlyProject(p.name)}
                                </option>
                              ))}
                            </Select>
                            <span>
                              {m.source.by === 'agent'
                                ? copy.settings.memory.fromAgent(
                                    m.source.agent ?? copy.settings.memory.anAgent,
                                  )
                                : copy.settings.memory.addedByYou}{' '}
                              · {day(m.updatedAt)}
                            </span>
                            {m.status === 'proposed' && (
                              <Badge tone="warn">{copy.settings.memory.waiting}</Badge>
                            )}
                          </div>
                          {m.source.why && (
                            <p className="mt-1 text-small text-muted">
                              {copy.settings.memory.why(m.source.why)}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {editing?.id === m.id ? (
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() =>
                                void act(async () => {
                                  await send('PATCH', `/api/memory/${m.id}`, { text: editing.text })
                                  setEditing(undefined)
                                })
                              }
                            >
                              {copy.settings.shared.save}
                            </Button>
                          ) : m.status === 'proposed' ? (
                            <Button
                              size="sm"
                              variant="primary"
                              icon={<Check className="size-3.5" />}
                              onClick={() =>
                                void act(() => send('POST', `/api/memory/${m.id}/decide`, { keep: true }))
                              }
                            >
                              {copy.settings.memory.keep}
                            </Button>
                          ) : null}
                          {m.status === 'proposed' ? (
                            <IconButton
                              size="sm"
                              label={copy.settings.memory.forget}
                              onClick={() =>
                                void act(() => send('POST', `/api/memory/${m.id}/decide`, { keep: false }))
                              }
                            >
                              <Trash2 className="size-4" />
                            </IconButton>
                          ) : (
                            <ConfirmButton
                              icon
                              label={copy.settings.memory.forget}
                              confirm={copy.settings.memory.confirmForget}
                              onConfirm={() => void act(() => send('DELETE', `/api/memory/${m.id}`))}
                            />
                          )}
                        </div>
                      </div>
                    </CardRow>
                  ))}
              </Card>
            </section>
          ))}
        </div>
      )}
    </>
  )
}

function Shortcuts() {
  return (
    <div {...settingRow('general.shortcuts')}>
      <PageHeader title={copy.settings.shortcuts.title} />
      <ShortcutList />
    </div>
  )
}

function About({ data }: { data?: SettingsResponse }) {
  return (
    <>
      <PageHeader title={copy.settings.about.title}>{copy.settings.about.intro}</PageHeader>
      <Card>
        <SettingField id="general.dataFolder" inline>
          <span className="font-mono text-callout text-muted">{data?.home ?? '…'}</span>
        </SettingField>
        <SettingField id="general.providersReady" inline>
          <span className="font-mono text-callout text-muted">
            {data ? data.providers.filter((p) => p.ready).length : '…'}
          </span>
        </SettingField>
        <SettingField id="general.sandbox" inline>
          <span className="font-mono text-callout text-muted">{data?.sandbox ?? '…'}</span>
        </SettingField>
        <CardRow>
          <p className="text-callout text-muted">{copy.settings.about.eventLog}</p>
        </CardRow>
      </Card>
      <div className="mt-4 flex items-center gap-2 text-small text-muted">
        <Bot className="size-3.5" /> {copy.settings.about.builtOn}
      </div>
    </>
  )
}
