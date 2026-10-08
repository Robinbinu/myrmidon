import {
  ArrowLeft,
  BookMarked,
  Bot,
  Brain,
  CalendarClock,
  Check,
  ChevronRight,
  CircleCheck,
  CircleX,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Gavel,
  Globe,
  GraduationCap,
  KeyRound,
  LoaderCircle,
  LogIn,
  MessageSquareText,
  Monitor,
  MonitorSmartphone,
  Moon,
  Network,
  Palette,
  Plug,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Smile,
  Sun,
  Terminal,
  Trash2,
  UserCog,
  Users,
  Webhook,
  Wrench,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  activeGateway,
  api,
  GATEWAYS_CHANGED,
  type GatewayInfo,
  hubSend,
  listGateways,
  type ModelOption,
  post,
  send,
  switchGateway,
  type TeamConfig,
} from './api.ts'
import { SkillProposalCard, type SkillProposalView } from './chat/ApprovalCards.tsx'
import { TeamSettings } from './chat/Composer.tsx'
import { ToolLibraryList } from './chat/MadeTools.tsx'
import { windowLabel } from './chat/ModelPicker.tsx'
import { SpecialistEditor } from './chat/SpecialistEditor.tsx'
import { copy } from './copy.ts'
import { DEFAULT_MASCOT, type MascotLook, SETTINGS_SAVED } from './mascot.ts'
import { PluginSlot, usePluginSlots } from './plugins.tsx'
import { removeSpecialist, useSpecialists } from './specialists.ts'
import { NOTIFY_KEY, type ThemeChoice, useCopy, usePersistentFlag } from './ui/hooks.ts'
import { AgentAvatar, BOW, FLOWER, PixelFace, PixelSprite } from './ui/pixel.tsx'
import {
  Button,
  cn,
  Dot,
  Empty,
  Field,
  IconButton,
  Kbd,
  Pill,
  Segmented,
  Select,
  Switch,
  TextArea,
  TextInput,
} from './ui/primitives.tsx'
import { useToast } from './ui/Toast.tsx'
import { AGENT_MIN_WINDOW, MASCOT_COLORS, softSpring, spring } from './ui-config.ts'

type Api = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai'

interface ProviderInfo {
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
  tools: { shell: boolean; web: boolean; files: boolean; messaging: boolean; mcp: boolean }
  verification: { threshold: number; rubric?: string; reviewer: 'off' | 'auto' | 'always' }
  instructions: { lead?: string; worker?: string }
  observer: { intervalSeconds: number }
  search: { provider: string }
  models: { hidden: string[]; hiddenProviders: string[]; windows?: Record<string, number> }
  /** Per-tool rules: `allow`, `ask` before every call, or `off`; unlisted tools keep their default. */
  permissions: Record<string, 'allow' | 'ask' | 'off'>
  profile?: { name?: string; greeting: 'model' | 'rules' }
  mascot?: MascotLook
}

interface SettingsResponse {
  settings: ServerSettings
  providers: ProviderInfo[]
  searchProviders: { id: string; label: string }[]
  customApis: Api[]
  sandbox: string
  home: string
  /** The computer account's name, used when the person has not set one. */
  account?: string
  agentDir?: string
  ompSetup: boolean
  toolCatalog: { name: string; description: string; mcp?: boolean; readOnly?: boolean }[]
}

export type Section =
  | 'general'
  | 'mascot'
  | 'specialists'
  | 'devices'
  | 'gateways'
  | 'models'
  | 'team'
  | 'tools'
  | 'skills'
  | 'plugins'
  | 'hooks'
  | 'schedules'
  | 'verification'
  | 'instructions'
  | 'memory'

const SECTIONS: { id: Section; label: string; hint: string; icon: typeof Palette }[] = [
  {
    id: 'general',
    label: copy.settings.sections.general.label,
    hint: copy.settings.sections.general.hint,
    icon: Palette,
  },
  {
    id: 'mascot',
    label: copy.settings.sections.mascot.label,
    hint: copy.settings.sections.mascot.hint,
    icon: Smile,
  },
  {
    id: 'specialists',
    label: copy.settings.sections.specialists.label,
    hint: copy.settings.sections.specialists.hint,
    icon: UserCog,
  },
  {
    id: 'devices',
    label: copy.settings.sections.devices.label,
    hint: copy.settings.sections.devices.hint,
    icon: MonitorSmartphone,
  },
  {
    id: 'gateways',
    label: copy.settings.sections.gateways.label,
    hint: copy.settings.sections.gateways.hint,
    icon: Network,
  },
  {
    id: 'models',
    label: copy.settings.sections.models.label,
    hint: copy.settings.sections.models.hint,
    icon: Brain,
  },
  {
    id: 'team',
    label: copy.settings.sections.team.label,
    hint: copy.settings.sections.team.hint,
    icon: Users,
  },
  {
    id: 'tools',
    label: copy.settings.sections.tools.label,
    hint: copy.settings.sections.tools.hint,
    icon: Wrench,
  },
  {
    id: 'skills',
    label: copy.settings.sections.skills.label,
    hint: copy.settings.sections.skills.hint,
    icon: GraduationCap,
  },
  {
    id: 'plugins',
    label: copy.settings.sections.plugins.label,
    hint: copy.settings.sections.plugins.hint,
    icon: Puzzle,
  },
  {
    id: 'hooks',
    label: copy.settings.sections.hooks.label,
    hint: copy.settings.sections.hooks.hint,
    icon: Webhook,
  },
  {
    id: 'schedules',
    label: copy.settings.sections.schedules.label,
    hint: copy.settings.sections.schedules.hint,
    icon: CalendarClock,
  },
  {
    id: 'verification',
    label: copy.settings.sections.verification.label,
    hint: copy.settings.sections.verification.hint,
    icon: Gavel,
  },
  {
    id: 'instructions',
    label: copy.settings.sections.instructions.label,
    hint: copy.settings.sections.instructions.hint,
    icon: MessageSquareText,
  },
  {
    id: 'memory',
    label: copy.settings.sections.memory.label,
    hint: copy.settings.sections.memory.hint,
    icon: BookMarked,
  },
]

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

/** Full-page settings, shown in place of the chat. Every change autosaves. */
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
}) {
  const toast = useToast()
  const [section, setSection] = useState<Section>(props.initialSection ?? 'general')
  const [modelsTab, setModelsTab] = useState<'models' | 'providers'>('models')
  const [data, setData] = useState<SettingsResponse>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose

  useEffect(() => {
    api<SettingsResponse>('/api/settings')
      .then(setData)
      .catch((err) => setError(String(err.message ?? err)))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select')
      if (e.key === 'Escape' && !typing && !document.querySelector('[role="dialog"]')) onClose.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** Autosave: edits apply in the UI at once and persist shortly after (or immediately for toggles). */
  const update = (patch: (s: ServerSettings) => ServerSettings, immediate = false) => {
    if (!data) return
    const next = patch(structuredClone(data.settings))
    setData({ ...data, settings: next })
    clearTimeout(timer.current)
    const save = () => {
      setSaving('saving')
      send<{ settings: ServerSettings }>('PUT', '/api/settings', next)
        .then((r) => {
          setData((d) => (d ? { ...d, settings: r.settings } : d))
          setSaving('saved')
          setTimeout(() => setSaving('idle'), 1200)
          props.onModelsChanged()
          window.dispatchEvent(new Event(SETTINGS_SAVED))
        })
        .catch((err) => {
          setSaving('idle')
          toast(String(err.message ?? err), 'error')
        })
    }
    if (immediate) save()
    else timer.current = setTimeout(save, 450)
  }

  const providersChanged = (providers: ProviderInfo[]) => {
    setData((d) => (d ? { ...d, providers } : d))
    props.onModelsChanged()
  }

  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        data-toolbar
        className="drag-region material-toolbar flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-3"
      >
        <Button variant="ghost" size="sm" onClick={props.onClose} icon={<ArrowLeft className="size-4" />}>
          {copy.settings.page.back}
        </Button>
        <span className="text-[13px] font-semibold">{copy.settings.page.title}</span>
        <span className="text-muted">/</span>
        <span className="truncate text-[13px] text-fg-2">{current?.label}</span>
        <span className="flex-1" />
        <AnimatePresence>
          {saving !== 'idle' && (
            <motion.span
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="inline-flex items-center gap-1.5 text-[12px] text-muted"
            >
              {saving === 'saving' ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5 text-ok-ink" />
              )}
              {saving === 'saving' ? copy.settings.page.saving : copy.settings.page.saved}
            </motion.span>
          )}
        </AnimatePresence>
        <span className="hidden text-[11.5px] text-muted md:inline">
          <Kbd>Esc</Kbd>
          {copy.settings.page.escToClose}
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-64 shrink-0 flex-col gap-1 overflow-auto border-r border-line p-3 md:flex">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              aria-current={section === s.id ? 'page' : undefined}
              className={cn(
                'relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                section === s.id ? 'text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
              )}
            >
              {section === s.id && (
                <motion.span
                  layoutId="settings-nav"
                  transition={spring}
                  className="absolute inset-0 rounded-xl border border-line bg-surface shadow-soft"
                />
              )}
              <span
                className={cn(
                  'relative grid size-8 shrink-0 place-items-center rounded-lg transition-colors',
                  section === s.id ? 'bg-accent-soft text-accent-fg' : 'bg-surface-2',
                )}
              >
                <s.icon className="size-4" />
              </span>
              <span className="relative min-w-0">
                <span className="block text-[13.5px] font-medium">{s.label}</span>
                <span className="block truncate text-[11.5px] text-muted">{s.hint}</span>
              </span>
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="border-b border-line p-3 md:hidden">
            <Select
              value={section}
              onChange={(e) => setSection(e.target.value as Section)}
              className="w-full"
              aria-label={copy.settings.page.sectionPicker}
            >
              {SECTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          {error && (
            <div className="m-5 rounded-xl bg-bad-soft px-4 py-3 text-[13.5px] text-bad-ink">{error}</div>
          )}
          <AnimatePresence mode="wait">
            <motion.div
              key={section}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16 }}
              className="mx-auto max-w-3xl px-6 py-8"
            >
              {section === 'general' && (
                <div className="flex flex-col gap-10">
                  <General
                    theme={props.theme}
                    onTheme={props.onTheme}
                    reduceMotion={props.reduceMotion}
                    onReduceMotion={props.onReduceMotion}
                  />
                  <Shortcuts />
                  <About data={data} />
                </div>
              )}
              {section === 'models' && data && (
                <>
                  <div className="mb-6">
                    <Segmented
                      id="models-tab"
                      value={modelsTab}
                      onChange={setModelsTab}
                      options={[
                        {
                          value: 'models',
                          label: (
                            <>
                              <Brain className="size-3.5" /> {copy.settings.page.modelsTab}
                            </>
                          ),
                        },
                        {
                          value: 'providers',
                          label: (
                            <>
                              <KeyRound className="size-3.5" /> {copy.settings.page.providersTab}
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
                      update={update}
                      onRefresh={props.onModelsChanged}
                      onAddProvider={() => setModelsTab('providers')}
                    />
                  ) : (
                    <Providers data={data} onProviders={providersChanged} update={update} />
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
              {section === 'mascot' && data && <MascotSection data={data} update={update} />}
              {section === 'specialists' && <SpecialistsSection models={props.models} />}
              {section === 'devices' && <DevicesSection />}
              {section === 'gateways' && <GatewaysSection />}
              {section === 'tools' && data && <ToolsSection data={data} update={update} />}
              {section === 'verification' && data && (
                <VerificationSection settings={data.settings} update={update} />
              )}
              {section === 'instructions' && data && (
                <InstructionsSection settings={data.settings} update={update} />
              )}
              {section === 'memory' && <MemorySection />}
              {section === 'skills' && <SkillsSection />}
              {section === 'plugins' && <PluginsSection />}
              {section === 'hooks' && <HooksSection />}
              {section === 'schedules' && <SchedulesSection />}
              {!data && !error && section !== 'general' && (
                <div className="flex items-center gap-2 text-[13px] text-muted">
                  <LoaderCircle className="size-4 animate-spin" /> {copy.settings.page.loading}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

function Heading(props: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="text-[17px] font-semibold tracking-tight">{props.title}</h3>
      {props.children && <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{props.children}</p>}
    </div>
  )
}

function Card(props: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('divide-y divide-line rounded-2xl border border-line bg-surface', props.className)}>
      {props.children}
    </div>
  )
}

function Row(props: { children: ReactNode }) {
  return <div className="px-4 py-3.5">{props.children}</div>
}

/** Desktop notifications when a round finishes while Myrmidon is in the background (this browser only). */
function NotifyToggle() {
  const toast = useToast()
  const supported = typeof Notification !== 'undefined'
  const [on, setOn] = usePersistentFlag(NOTIFY_KEY, false)
  const granted = supported && Notification.permission === 'granted'
  return (
    <Field
      label={copy.settings.notify.label}
      hint={supported ? copy.settings.notify.hint : copy.settings.notify.unsupported}
      inline
    >
      <Switch
        checked={on && granted}
        disabled={!supported}
        label={copy.settings.notify.label}
        onChange={(v) => {
          if (!v) return setOn(false)
          void Notification.requestPermission().then((p) => {
            setOn(p === 'granted')
            if (p !== 'granted') toast(copy.settings.notify.blocked, 'error')
          })
        }}
      />
    </Field>
  )
}

function General(props: {
  theme: ThemeChoice
  onTheme(t: ThemeChoice): void
  reduceMotion: boolean
  onReduceMotion(v: boolean): void
}) {
  return (
    <>
      <Heading title={copy.settings.general.title}>{copy.settings.general.intro}</Heading>
      <Card>
        <Row>
          <Field label={copy.settings.general.theme} hint={copy.settings.general.themeHint} inline>
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
          </Field>
        </Row>
        <Row>
          <Field
            label={copy.settings.general.reduceMotion}
            hint={copy.settings.general.reduceMotionHint}
            inline
          >
            <Switch
              checked={props.reduceMotion}
              onChange={props.onReduceMotion}
              label={copy.settings.general.reduceMotion}
            />
          </Field>
        </Row>
        <Row>
          <NotifyToggle />
        </Row>
      </Card>
    </>
  )
}

function ModelsSection(props: {
  models: ModelOption[]
  settings: ServerSettings
  update(p: (s: ServerSettings) => ServerSettings, immediate?: boolean): void
  onRefresh(): void
  onAddProvider(): void
}) {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [tests, setTests] = useState<Record<string, 'running' | { ok: boolean; text: string }>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const hidden = new Set(props.settings.models.hidden)
  const hiddenProviders = new Set(props.settings.models.hiddenProviders)
  const q = query.trim().toLowerCase()
  const groups = useMemo(() => {
    const by = new Map<string, ModelOption[]>()
    for (const m of props.models) {
      if (q && !`${m.ref} ${m.name}`.toLowerCase().includes(q)) continue
      by.set(m.provider, [...(by.get(m.provider) ?? []), m])
    }
    return [...by].sort(([a], [b]) => a.localeCompare(b))
  }, [props.models, q])
  const shown = props.models.filter((m) => !hidden.has(m.ref) && !hiddenProviders.has(m.provider)).length

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
      <Heading title={copy.settings.models.title}>
        {copy.settings.models.intro(props.models.length, shown)}
      </Heading>
      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
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
          icon={<RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />}
        >
          {copy.settings.models.refresh}
        </Button>
        <Button variant="soft" onClick={props.onAddProvider} icon={<Plus className="size-3.5" />}>
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
            <Card key={provider} className={cn(off && 'opacity-60')}>
              <div className="flex items-center gap-3 px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [provider]: !expanded }))}
                  aria-expanded={expanded}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={spring}>
                    <ChevronRight className="size-4 text-muted" />
                  </motion.span>
                  <span className="font-mono text-[13px] font-medium">{provider}</span>
                  <span className="text-[12px] tabular-nums text-muted">{models.length}</span>
                </button>
                <span className="text-[12px] text-muted">
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
                    const isHidden = hidden.has(m.ref)
                    return (
                      <div
                        key={m.ref}
                        className={cn('flex items-center gap-3 py-2 pl-10 pr-4', isHidden && 'opacity-55')}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-medium">{m.name}</span>
                            {m.reasoning && <Brain className="size-3.5 text-muted" />}
                          </div>
                          <div className="truncate font-mono text-[11px] text-muted">{m.id}</div>
                          {t && t !== 'running' && (
                            <div
                              className={cn(
                                'mt-0.5 flex items-center gap-1 text-[12px]',
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
                          variant="ghost"
                          onClick={() => void test(m.ref)}
                          disabled={t === 'running'}
                          icon={
                            t === 'running' ? <LoaderCircle className="size-3.5 animate-spin" /> : undefined
                          }
                        >
                          {copy.settings.models.test}
                        </Button>
                        <IconButton
                          size="sm"
                          label={
                            isHidden
                              ? copy.settings.models.showModel(m.name)
                              : copy.settings.models.hideModel(m.name)
                          }
                          onClick={() => toggleSet('hidden', m.ref)}
                        >
                          {isHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </IconButton>
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>
          )
        })}
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
        className="h-7 w-20 rounded-md border border-line-strong bg-control px-2 text-right font-mono text-[12px] outline-none focus:ring-2 focus:ring-accent-soft"
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
        'h-7 min-w-14 rounded-md px-2 text-right font-mono text-[12px] tabular-nums transition-colors hover:bg-fill',
        tokens && tokens < AGENT_MIN_WINDOW ? 'text-warn-ink' : 'text-fg-2',
        source === 'set' && 'font-semibold',
      )}
    >
      {tokens ? windowLabel(tokens) : '—'}
      {tokens && !source ? '?' : ''}
    </button>
  )
}

interface LoginOption {
  id: string
  name: string
  provider: string
  ready: boolean
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
    <div className="mb-8">
      <h4 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        <LogIn className="size-4 text-muted" /> {copy.settings.signIns.title}
        <span className="font-normal text-muted">{copy.settings.signIns.subtitle}</span>
      </h4>
      <Card>
        {shown.map((l) => {
          const active = session?.login === l.id && session.status === 'waiting' ? session : undefined
          return (
            <div key={l.id} className="border-b border-line px-4 py-3 last:border-0">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13.5px] font-medium">
                    {l.name}
                    {l.ready ? <Pill tone="ok">{copy.settings.signIns.signedIn}</Pill> : null}
                  </div>
                  <div className="font-mono text-[11.5px] text-muted">{l.provider}</div>
                </div>
                {active ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      send('DELETE', `/api/logins/${active.id}`).then(() => setSession(undefined))
                    }
                  >
                    {copy.settings.shared.cancel}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => start(l.id)}
                    disabled={waiting}
                    icon={<LogIn className="size-3.5" />}
                  >
                    {l.ready ? copy.settings.signIns.signInAgain : copy.settings.signIns.signIn}
                  </Button>
                )}
              </div>
              {active && (
                <div className="mt-3 space-y-2.5 rounded-xl border border-line bg-surface-2 p-3 text-[12.5px]">
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
                        className="font-mono text-[12px]"
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
          className="mt-2 text-[12.5px] font-medium text-muted hover:text-fg"
        >
          {copy.settings.signIns.showMore(sorted.length - shown.length)}
        </button>
      )}
    </div>
  )
}

function Providers(props: {
  data: SettingsResponse
  onProviders(p: ProviderInfo[]): void
  update(p: (s: ServerSettings) => ServerSettings, immediate?: boolean): void
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
      <Heading title={copy.settings.providers.title}>
        {copy.settings.providers.introBeforeFile}
        <span className="font-mono">models.yml</span>
        {copy.settings.providers.introBeforeDir}
        <span className="font-mono">{props.data.agentDir ?? 'agent/'}</span>
        {copy.settings.providers.introAfterDir}
      </Heading>

      {props.data.ompSetup && (
        <Card className="mb-8">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg">
              <Download className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium">{copy.settings.providers.importTitle}</div>
              <div className="text-[12.5px] text-muted">
                {importing === 'confirm'
                  ? copy.settings.providers.importConfirm
                  : copy.settings.providers.importHint}
              </div>
            </div>
            {importing === 'confirm' ? (
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setImporting('idle')}>
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
              <Button
                size="sm"
                onClick={() => setImporting('confirm')}
                disabled={importing === 'busy'}
                icon={importing === 'busy' ? <LoaderCircle className="size-3.5 animate-spin" /> : undefined}
              >
                {copy.settings.providers.import}
              </Button>
            )}
          </div>
        </Card>
      )}

      <SignIns onProviders={props.onProviders} />

      <div className="mb-2 flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-[13px] font-semibold">
          <KeyRound className="size-4 text-muted" /> {copy.settings.providers.heading}
          <span className="font-normal text-muted">
            {copy.settings.providers.readyCount(providers.filter((p) => p.ready).length, providers.length)}
          </span>
        </h4>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)} icon={<Plus className="size-3.5" />}>
            {copy.settings.providers.customEndpoint}
          </Button>
        )}
      </div>
      <AnimatePresence>
        {adding && (
          <motion.div
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
          <Empty icon={<Server className="size-5" />} title={copy.settings.providers.emptyTitle}>
            {copy.settings.providers.emptyBody}
          </Empty>
        )}
        {shown.map((p) => (
          <div key={p.id} className="px-4 py-2.5">
            <div className="flex items-center gap-3">
              <Dot status={p.ready ? 'ready' : 'idle'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px]">{p.id}</span>
                  {p.custom && <Pill tone="accent">{copy.settings.providers.custom}</Pill>}
                  <span className="text-[12px] text-muted">
                    {copy.settings.providers.modelCount(p.models)}
                  </span>
                </div>
                {p.baseUrl && <div className="truncate font-mono text-[11.5px] text-muted">{p.baseUrl}</div>}
              </div>
              <Button
                size="sm"
                variant="ghost"
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
                  <span className="text-[11.5px] text-muted">
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
                <IconButton
                  size="sm"
                  label={copy.settings.providers.removeCredentials(p.id)}
                  onClick={() =>
                    void act(
                      () => send<{ providers: ProviderInfo[] }>('DELETE', `/api/credentials/${p.id}`),
                      copy.settings.providers.removedCredentials(p.id),
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </IconButton>
              )}
              {p.custom && (
                <IconButton
                  size="sm"
                  label={copy.settings.providers.remove(p.id)}
                  onClick={() =>
                    void act(
                      () => send<{ providers: ProviderInfo[] }>('DELETE', `/api/providers/${p.id}`),
                      copy.settings.providers.removed(p.id),
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </IconButton>
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
            className="w-full px-4 py-2.5 text-left text-[12.5px] text-muted hover:text-fg"
          >
            {copy.settings.providers.showMore(hiddenCount)}
          </button>
        )}
      </Card>
      <p className="mt-2 text-[12px] text-muted">
        {copy.settings.providers.envBefore}
        <span className="font-mono">ANTHROPIC_API_KEY</span>
        {copy.settings.providers.envAfter}
      </p>
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
  const nameOk = editing || (/^[a-z][a-z0-9-]{1,40}$/.test(name) && !props.existing.includes(name))
  const urlOk = /^https?:\/\//.test(baseUrl)
  const models = [...new Set(manual.split(/[\s,]+/).filter(Boolean))]
  const discovers = apiType === 'openai-completions' || apiType === 'openai-responses'
  const keyOk = auth === 'none' || !!key.trim() || (editing && !!init?.hasKey)
  return (
    <Card className={cn(!editing && 'mb-3', 'border-accent/30')}>
      <div className="grid gap-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={copy.settings.providerForm.name}
            hint={editing ? copy.settings.providerForm.nameFixed : copy.settings.providerForm.nameHint}
          >
            <TextInput
              value={name}
              disabled={editing}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="lmstudio"
              aria-invalid={!!name && !nameOk}
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
        <Field label={copy.settings.providerForm.baseUrl}>
          <TextInput
            value={baseUrl}
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
              />
            </div>
          )}
        </div>
        <Field
          label={copy.settings.providerForm.models}
          hint={
            discovers ? copy.settings.providerForm.modelsDiscoverHint : copy.settings.providerForm.modelsHint
          }
        >
          <TextArea
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="qwen3-8b, llama-3.3-70b"
            aria-label={copy.settings.providerForm.modelIds}
            className="min-h-16 font-mono text-[12.5px]"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onCancel}>
            {copy.settings.shared.cancel}
          </Button>
          <Button
            variant="primary"
            disabled={!nameOk || !urlOk || busy || !keyOk || (!discovers && models.length === 0)}
            icon={busy ? <LoaderCircle className="size-3.5 animate-spin" /> : undefined}
            onClick={async () => {
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
      <Heading title={copy.settings.team.title}>{copy.settings.team.intro}</Heading>
      {props.config && (
        <Card className="mb-6">
          <div className="p-4">
            <TeamSettings
              placement="down"
              models={props.models}
              config={props.config}
              onConfig={(c) => {
                props.onConfig(c)
                props.update((s) => {
                  s.team = {
                    ...s.team,
                    mode: c.mode,
                    workers: c.roster.length,
                    leadModel: c.leadModel,
                    ...(c.roster[0] ? { workerModel: c.roster[0].model } : {}),
                    judgeModel: c.judgeModel,
                  }
                  return s
                })
              }}
            />
          </div>
        </Card>
      )}
      <Card>
        <Row>
          <Field label={copy.settings.team.timeLimit} hint={copy.settings.team.timeLimitHint} inline>
            <NumberField
              value={t.wallMinutes}
              min={1}
              max={240}
              suffix={copy.settings.team.units.minutes}
              onChange={(v) => props.update((s) => ({ ...s, team: { ...s.team, wallMinutes: v } }))}
            />
          </Field>
        </Row>
        <Row>
          <Field label={copy.settings.team.spendLimit} hint={copy.settings.team.spendLimitHint} inline>
            <NumberField
              value={t.costUsd}
              min={0}
              max={1000}
              step={0.1}
              suffix={copy.settings.team.units.dollars}
              onChange={(v) => props.update((s) => ({ ...s, team: { ...s.team, costUsd: v } }))}
            />
          </Field>
        </Row>
        <Row>
          <Field label={copy.settings.team.tokenLimit} hint={copy.settings.team.tokenLimitHint} inline>
            <NumberField
              value={t.tokens}
              min={0}
              max={1_000_000_000}
              suffix={copy.settings.team.units.tokens}
              wide
              onChange={(v) => props.update((s) => ({ ...s, team: { ...s.team, tokens: v } }))}
            />
          </Field>
        </Row>
        <Row>
          <Field label={copy.settings.team.turns} hint={copy.settings.team.turnsHint} inline>
            <NumberField
              value={t.maxTurns}
              min={1}
              max={200}
              onChange={(v) => props.update((s) => ({ ...s, team: { ...s.team, maxTurns: v } }))}
            />
          </Field>
        </Row>
        <Row>
          <Field label={copy.settings.team.observer} hint={copy.settings.team.observerHint} inline>
            <NumberField
              value={props.data.settings.observer.intervalSeconds}
              min={10}
              max={600}
              suffix={copy.settings.team.units.seconds}
              onChange={(v) => props.update((s) => ({ ...s, observer: { intervalSeconds: v } }))}
            />
          </Field>
        </Row>
      </Card>
    </>
  )
}

function NumberField(props: {
  value: number
  min: number
  max: number
  suffix?: string
  step?: number
  /** For values with many digits, such as token counts. */
  wide?: boolean
  onChange(v: number): void
}) {
  return (
    <div className="flex items-center gap-2">
      <TextInput
        type="number"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v) && v >= props.min && v <= props.max) props.onChange(v)
        }}
        className={`${props.wide ? 'w-32' : 'w-24'} text-right tabular-nums`}
      />
      {props.suffix && <span className="w-7 text-[12.5px] text-muted">{props.suffix}</span>}
    </div>
  )
}

const TOOL_INFO: {
  key: keyof ServerSettings['tools']
  label: string
  hint: string
  icon: typeof Terminal
}[] = [
  {
    key: 'shell',
    label: copy.settings.tools.groups.shell.label,
    hint: copy.settings.tools.groups.shell.hint,
    icon: Terminal,
  },
  {
    key: 'web',
    label: copy.settings.tools.groups.web.label,
    hint: copy.settings.tools.groups.web.hint,
    icon: Globe,
  },
  {
    key: 'files',
    label: copy.settings.tools.groups.files.label,
    hint: copy.settings.tools.groups.files.hint,
    icon: SlidersHorizontal,
  },
  {
    key: 'messaging',
    label: copy.settings.tools.groups.messaging.label,
    hint: copy.settings.tools.groups.messaging.hint,
    icon: MessageSquareText,
  },
  {
    key: 'mcp',
    label: copy.settings.tools.groups.mcp.label,
    hint: copy.settings.tools.groups.mcp.hint,
    icon: Plug,
  },
]

/** Per-tool rules on top of the groups: ask before each call, or turn a single tool off. */
function ToolRules(props: {
  data: SettingsResponse
  update(p: (s: ServerSettings) => ServerSettings, immediate?: boolean): void
}) {
  const [query, setQuery] = useState('')
  const rules = props.data.settings.permissions ?? {}
  const q = query.trim().toLowerCase()
  const tools = props.data.toolCatalog
    .filter((t) => !q || t.name.includes(q) || t.description.toLowerCase().includes(q))
    // Tools with a rule first, so what you set is easy to find again.
    .sort((a, b) => Number(!!rules[b.name]) - Number(!!rules[a.name]) || a.name.localeCompare(b.name))
  // Built-in tools are allowed unless a rule says otherwise; MCP tools have a default of their own (read-only ones
  // run, others ask), so allowing one is a rule worth keeping.
  const set = (name: string, rule: string, mcp: boolean) =>
    props.update((s) => {
      const next = { ...(s.permissions ?? {}) }
      if (rule === 'ask' || rule === 'off' || (rule === 'allow' && mcp)) next[name] = rule
      else delete next[name]
      return { ...s, permissions: next }
    }, true)
  return (
    <>
      <h4 className="mb-2 mt-8 flex items-center gap-2 text-[13px] font-semibold">
        <ShieldCheck className="size-4 text-muted" /> {copy.settings.tools.rulesTitle}
        <span className="font-normal text-muted">{copy.settings.tools.rulesSubtitle}</span>
      </h4>
      <Card>
        <Row>
          <TextInput
            aria-label={copy.settings.tools.findTool}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={copy.settings.tools.findToolPlaceholder}
          />
        </Row>
        <div className="max-h-80 overflow-y-auto">
          {tools.map((t) => (
            <Row key={t.name}>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[12.5px] font-medium">{t.name}</div>
                  <div className="truncate text-[12px] text-muted" title={t.description}>
                    {t.description}
                  </div>
                </div>
                <Select
                  aria-label={copy.settings.tools.ruleFor(t.name)}
                  value={rules[t.name] ?? (t.mcp ? 'default' : 'allow')}
                  onChange={(e) => set(t.name, e.target.value, !!t.mcp)}
                >
                  {t.mcp && (
                    <option value="default">
                      {t.name === 'mcp'
                        ? copy.settings.tools.mcpDefault
                        : t.readOnly
                          ? copy.settings.tools.readOnlyDefault
                          : copy.settings.tools.changesDefault}
                    </option>
                  )}
                  <option value="allow">{copy.settings.tools.allow}</option>
                  <option value="ask">{copy.settings.tools.askFirst}</option>
                  <option value="off">{copy.settings.shared.off}</option>
                </Select>
              </div>
            </Row>
          ))}
        </div>
      </Card>
    </>
  )
}

function ToolsSection(props: {
  data: SettingsResponse
  update(p: (s: ServerSettings) => ServerSettings, immediate?: boolean): void
}) {
  const sandboxed = props.data.sandbox !== 'none'
  return (
    <>
      <Heading title={copy.settings.tools.title}>{copy.settings.tools.intro}</Heading>
      <div
        className={cn(
          'mb-4 flex items-start gap-3 rounded-2xl border px-4 py-3 text-[13px]',
          sandboxed ? 'border-ok/25 bg-ok-soft' : 'border-warn/25 bg-warn-soft',
        )}
      >
        <ShieldCheck className={cn('mt-0.5 size-4 shrink-0', sandboxed ? 'text-ok-ink' : 'text-warn-ink')} />
        <div>
          <div className="font-semibold">
            {sandboxed
              ? copy.settings.tools.sandboxActive(props.data.sandbox)
              : copy.settings.tools.noSandbox}
          </div>
          <div className="text-fg-2">
            {sandboxed ? copy.settings.tools.sandboxedHint : copy.settings.tools.unsandboxedHint}
          </div>
        </div>
      </div>
      <Card>
        {TOOL_INFO.map((t) => (
          <Row key={t.key}>
            <div className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-fg-2">
                <t.icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">{t.label}</div>
                <div className="text-[12.5px] text-muted">{t.hint}</div>
              </div>
              <Switch
                checked={props.data.settings.tools[t.key]}
                label={t.label}
                onChange={(v) => props.update((s) => ({ ...s, tools: { ...s.tools, [t.key]: v } }), true)}
              />
            </div>
          </Row>
        ))}
      </Card>
      <ToolRules data={props.data} update={props.update} />
      <McpServers />
      <h4 className="mb-2 mt-8 flex items-center gap-2 text-[13px] font-semibold">
        <Wrench className="size-4 text-muted" /> {copy.settings.tools.libraryTitle}
        <span className="font-normal text-muted">{copy.settings.tools.librarySubtitle}</span>
      </h4>
      <ToolLibraryList />
      <h4 className="mb-2 mt-8 flex items-center gap-2 text-[13px] font-semibold">
        <Search className="size-4 text-muted" /> {copy.settings.tools.webSearch}
      </h4>
      <Card>
        <Row>
          <Field
            label={copy.settings.tools.searchProvider}
            hint={copy.settings.tools.searchProviderHint}
            inline
          >
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
          </Field>
        </Row>
      </Card>
    </>
  )
}

interface McpServer {
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
    <>
      <div className="mb-2 mt-8 flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-[13px] font-semibold">
          <Plug className="size-4 text-muted" /> {copy.settings.mcp.title}
          <span className="font-normal text-muted">{copy.settings.mcp.subtitle}</span>
        </h4>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
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
                    className="font-mono text-[12px]"
                  />
                </Field>
                <Field label={copy.settings.mcp.environment} hint={copy.settings.mcp.environmentHint}>
                  <TextArea
                    rows={2}
                    value={form.env}
                    onChange={(e) => setForm({ ...form, env: e.target.value })}
                    className="font-mono text-[12px]"
                  />
                </Field>
              </>
            ) : (
              <Field label={copy.settings.mcp.url}>
                <TextInput
                  value={form.url}
                  placeholder="https://example.com/mcp"
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  className="font-mono text-[12px]"
                />
              </Field>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {copy.settings.shared.cancel}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={
                busy ||
                !form.name.trim() ||
                (form.transport === 'stdio' ? !form.command.trim() : !form.url.trim())
              }
              onClick={add}
              icon={busy ? <LoaderCircle className="size-3.5 animate-spin" /> : undefined}
            >
              {copy.settings.mcp.addAndConnect}
            </Button>
          </div>
        </Card>
      )}
      <Card>
        {servers === undefined ? (
          <Row>
            <span className="text-[13px] text-muted">{copy.settings.shared.loading}</span>
          </Row>
        ) : servers.length === 0 ? (
          <Row>
            <span className="text-[13px] text-muted">{copy.settings.mcp.empty}</span>
          </Row>
        ) : (
          servers.map((m) => (
            <Row key={m.name}>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13.5px] font-medium">
                    {m.name}
                    <Pill tone={MCP_TONE[m.status]}>{copy.settings.mcp.statuses[m.status]}</Pill>
                    {m.tools.length > 0 && (
                      <span className="text-[12px] text-muted">
                        {copy.settings.mcp.toolCount(m.tools.length)}
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[11.5px] text-muted" title={m.target}>
                    {m.transport} · {m.target}
                  </div>
                  {m.error && <div className="mt-0.5 text-[12px] text-bad-ink">{m.error}</div>}
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
                <IconButton
                  label={copy.settings.mcp.remove(m.name)}
                  size="sm"
                  onClick={() =>
                    act(
                      () => send('DELETE', `/api/mcp/${encodeURIComponent(m.name)}`),
                      copy.settings.mcp.removed(m.name),
                    )
                  }
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            </Row>
          ))
        )}
      </Card>
    </>
  )
}

const REVIEWER_HINT = {
  off: copy.settings.reviewer.hints.off,
  auto: copy.settings.reviewer.hints.auto,
  always: copy.settings.reviewer.hints.always,
} as const

interface DeviceRow {
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
      <Heading title={t.title}>{data?.remote === false ? t.introLocal : t.introRemote}</Heading>
      <Card className="mb-6">
        <Row>
          <Field label={t.scope} hint={t.scopeHints[scope]} inline>
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
          </Field>
        </Row>
        <Row>
          {link ? (
            <div className="flex flex-col gap-2">
              <p className="text-[13px] text-fg-2">{t.link}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-fill px-3 py-2 font-mono text-[12.5px]">
                  {link.link}
                </code>
                <Button size="sm" variant="ghost" onClick={() => copyText(link.link)}>
                  {copied ? t.copied : t.copy}
                </Button>
              </div>
              <p className="text-[12.5px] text-muted">{t.code(link.code)}</p>
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
        </Row>
      </Card>
      {data && data.devices.length === 0 ? (
        <Empty icon={<MonitorSmartphone className="size-5" />} title={t.empty} />
      ) : (
        <Card>
          {data?.devices.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-4 py-3">
              <MonitorSmartphone className="size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[13.5px] font-semibold">{d.name}</span>
                  {d.current && <Pill tone="accent">{t.thisDevice}</Pill>}
                </div>
                <div className="truncate text-[12px] text-muted">
                  {t.scopeNames[d.scope]}
                  {d.hub ? ` · ${t.viaHub}` : ''} ·{' '}
                  {d.lastSeenAt ? t.lastSeen(new Date(d.lastSeenAt).toLocaleString()) : t.never}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void revoke(d)}>
                {t.revoke}
              </Button>
            </div>
          ))}
        </Card>
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
      <Heading title={t.title}>{t.intro}</Heading>
      <Card className="mb-6">
        <Row>
          <Field label={t.link} hint={t.linkHint}>
            <TextInput
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://box.tail1234.ts.net/#pair=…"
              aria-label={t.link}
              className="font-mono"
            />
          </Field>
        </Row>
        <Row>
          <Field label={t.name} hint={t.nameHint}>
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              aria-label={t.name}
            />
          </Field>
        </Row>
        <Row>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !link.trim()}
            icon={busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            onClick={() => void add()}
          >
            {busy ? t.adding : t.add}
          </Button>
        </Row>
      </Card>
      {list && list.length === 0 ? (
        <Empty icon={<Network className="size-5" />} title={t.empty} />
      ) : (
        <Card>
          {list?.map((g) => (
            <div key={g.id} className="flex items-center gap-3 px-4 py-3">
              <span
                className={cn('inline-flex size-2 shrink-0 rounded-full', g.health.ok ? 'bg-ok' : 'bg-bad')}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[13.5px] font-semibold">{g.name}</span>
                  {g.id === active && <Pill tone="accent">{t.shown}</Pill>}
                </div>
                <div className="truncate text-[12px] text-muted">
                  {new URL(g.url).host} · {copy.settings.devices.scopeNames[g.scope]} ·{' '}
                  {g.health.ok ? t.reachable : g.health.error} ·{' '}
                  {t.checked(new Date(g.health.checkedAt).toLocaleTimeString())}
                </div>
              </div>
              {g.id !== active && (
                <Button size="sm" variant="ghost" onClick={() => switchGateway(g.id)}>
                  {t.show}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void remove(g)}>
                {t.remove}
              </Button>
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
      <Heading title={t.title}>{t.intro}</Heading>
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
      {list.length === 0 && open !== 'new' ? (
        <Empty icon={<UserCog className="size-5" />} title={t.empty}>
          {t.emptyHint}
        </Empty>
      ) : (
        <Card>
          {list.map((s) =>
            open === s.id ? (
              <div key={s.id} className="p-4">
                <SpecialistEditor
                  models={props.models}
                  initial={s}
                  onSaved={() => setOpen(undefined)}
                  onCancel={() => setOpen(undefined)}
                />
              </div>
            ) : (
              <div key={s.id} className="group flex items-center gap-3 px-4 py-3">
                <AgentAvatar name={s.name} status="idle" size={32} awake />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13.5px] font-semibold">{s.name}</span>
                    <span className="truncate text-[12.5px] text-fg-2">{s.specialty}</span>
                  </div>
                  <div className="truncate text-[12px] text-muted">
                    {modelName(s.model)}
                    {s.off.length > 0 && ` · ${t.toolsOff(s.off.map((g) => t.groups[g]).join(', '))}`}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setOpen(s.id)}>
                  {t.edit}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void removeSpecialist(s.id).then(
                      () => toast(t.removed(s.name), 'info'),
                      (err: Error) => toast(err.message, 'error'),
                    )
                  }
                >
                  {t.remove}
                </Button>
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
      className="flex flex-col items-center gap-1.5 text-[12px] text-fg-2"
    >
      <span
        className={cn(
          'grid place-items-center rounded-xl p-0.5 ring-2 transition-shadow',
          props.selected ? 'ring-accent' : 'ring-transparent hover:ring-line-strong',
        )}
      >
        {props.children}
      </span>
      <span className={props.selected ? 'font-medium text-fg' : ''}>{props.label}</span>
    </button>
  )
}

/** The mascot's screen at a size for pickers: its eyes in the chosen style and colour, with its accessory. */
function MiniMascot(props: { look: MascotLook; cell?: number }) {
  const cell = props.cell ?? 4
  return (
    <span className="relative inline-block rounded-[14px] bg-screen p-2.5">
      <PixelFace
        mood="idle"
        color={MASCOT_COLORS[props.look.color]}
        cols={15}
        rows={8}
        cell={cell}
        gap={cell * 0.3}
        eyes={props.look.eyes}
        look={[0, 0]}
      />
      {props.look.look === 'flower' && (
        <PixelSprite sprite={FLOWER} cell={cell * 0.85} className="absolute -right-2.5 -top-2.5" />
      )}
      {props.look.look === 'bow' && (
        <PixelSprite
          sprite={BOW}
          cell={cell * 0.75}
          className="absolute -bottom-2.5 left-1/2 -translate-x-1/2"
        />
      )}
    </span>
  )
}

function MascotSection(props: {
  data: SettingsResponse
  update(p: (s: ServerSettings) => ServerSettings, immediate?: boolean): void
}) {
  const t = copy.settings.mascot
  const profile = props.data.settings.profile ?? { greeting: 'model' as const }
  const look = { ...DEFAULT_MASCOT, ...props.data.settings.mascot }
  const set = (patch: Partial<MascotLook>) =>
    props.update((s) => ({ ...s, mascot: { ...DEFAULT_MASCOT, ...s.mascot, ...patch } }), true)
  return (
    <>
      <Heading title={t.title}>{t.intro}</Heading>
      <Card className="mb-6">
        <Row>
          <Field label={t.name} hint={t.nameHint(props.data.account ?? '')} inline>
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
          </Field>
        </Row>
        <Row>
          <Field label={t.greeting} hint={t.greetingHints[profile.greeting]} inline>
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
          </Field>
        </Row>
      </Card>
      <Card>
        <Row>
          <figure className="m-0 grid place-items-center py-4" aria-label={t.preview}>
            <MiniMascot look={look} cell={9} />
          </figure>
        </Row>
        <Row>
          <Field label={t.eyes}>
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
          </Field>
        </Row>
        <Row>
          <Field label={t.look}>
            <div className="flex flex-wrap gap-4">
              {(['neutral', 'flower', 'bow'] as const).map((l) => (
                <Tile key={l} selected={look.look === l} label={t.looks[l]} onClick={() => set({ look: l })}>
                  <span className="px-1.5 pb-2 pt-1.5">
                    <MiniMascot look={{ ...look, look: l }} />
                  </span>
                </Tile>
              ))}
            </div>
          </Field>
        </Row>
        <Row>
          <Field label={t.color}>
            <div className="flex flex-wrap gap-3">
              {(Object.keys(MASCOT_COLORS) as (keyof typeof MASCOT_COLORS)[]).map((color) => (
                <Tile
                  key={color}
                  selected={look.color === color}
                  label={t.colors[color]}
                  onClick={() => set({ color })}
                >
                  <span className="grid size-10 place-items-center rounded-[10px] bg-screen">
                    <span className="size-4 rounded-[5px]" style={{ background: MASCOT_COLORS[color] }} />
                  </span>
                </Tile>
              ))}
            </div>
          </Field>
        </Row>
        <Row>
          <Field label={t.screen} inline>
            <Segmented
              id="mascot-screen"
              value={look.screen}
              options={(['rotate', 'clock', 'name', 'crew', 'face'] as const).map((screen) => ({
                value: screen,
                label: t.screens[screen],
              }))}
              onChange={(screen) => set({ screen })}
            />
          </Field>
        </Row>
      </Card>
    </>
  )
}

function VerificationSection(props: {
  settings: ServerSettings
  update(p: (s: ServerSettings) => ServerSettings): void
}) {
  const v = props.settings.verification
  const off = v.reviewer === 'off'
  return (
    <>
      <Heading title={copy.settings.reviewer.title}>{copy.settings.reviewer.intro}</Heading>
      <Card>
        <Row>
          <Field label={copy.settings.reviewer.when} hint={REVIEWER_HINT[v.reviewer]} inline>
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
          </Field>
        </Row>
        <Row>
          <Field label={copy.settings.reviewer.threshold} hint={copy.settings.reviewer.thresholdHint} inline>
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
              <span className="w-10 text-right font-mono text-[13px] tabular-nums">
                {v.threshold.toFixed(2)}
              </span>
            </div>
          </Field>
        </Row>
        <Row>
          <Field label={copy.settings.reviewer.rubric} hint={copy.settings.reviewer.rubricHint}>
            <TextArea
              value={v.rubric ?? ''}
              onChange={(e) =>
                props.update((s) => ({ ...s, verification: { ...s.verification, rubric: e.target.value } }))
              }
              placeholder={copy.settings.reviewer.rubricPlaceholder}
              rows={5}
              disabled={off}
            />
          </Field>
        </Row>
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
      <Heading title={copy.settings.instructions.title}>{copy.settings.instructions.intro}</Heading>
      <Card>
        <Row>
          <Field label={copy.settings.instructions.lead} hint={copy.settings.instructions.leadHint}>
            <TextArea
              value={i.lead ?? ''}
              onChange={(e) =>
                props.update((s) => ({ ...s, instructions: { ...s.instructions, lead: e.target.value } }))
              }
              placeholder={copy.settings.instructions.leadPlaceholder}
              rows={5}
            />
          </Field>
        </Row>
        <Row>
          <Field label={copy.settings.instructions.workers} hint={copy.settings.instructions.workersHint}>
            <TextArea
              value={i.worker ?? ''}
              onChange={(e) =>
                props.update((s) => ({ ...s, instructions: { ...s.instructions, worker: e.target.value } }))
              }
              placeholder={copy.settings.instructions.workersPlaceholder}
              rows={5}
            />
          </Field>
        </Row>
      </Card>
    </>
  )
}

interface ScheduleEntry {
  id: string
  name: string
  request: string
  cron: string
  project?: string
  enabled: boolean
  nextRun?: string
  lastRun?: { at: string; chatId?: string; error?: string }
}

const CRON_PRESETS: { cron: string; label: string }[] = [
  { cron: '0 * * * *', label: copy.settings.schedules.presets.hourly },
  { cron: '0 9 * * *', label: copy.settings.schedules.presets.daily },
  { cron: '0 9 * * 1-5', label: copy.settings.schedules.presets.weekdays },
  { cron: '0 9 * * 1', label: copy.settings.schedules.presets.mondays },
]

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

/** Requests that start on their own on a cron schedule, as new chats with the default team. */
function SchedulesSection() {
  const toast = useToast()
  const [list, setList] = useState<ScheduleEntry[]>()
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [draft, setDraft] = useState({ request: '', cron: '0 9 * * 1-5', custom: false, project: '' })
  const load = () =>
    api<{ schedules: ScheduleEntry[] }>('/api/schedules')
      .then((r) => setList(r.schedules))
      .catch((err: Error) => toast(err.message, 'error'))
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once
  useEffect(() => {
    void load()
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
  const label = (cron: string) => CRON_PRESETS.find((p) => p.cron === cron)?.label ?? cron
  return (
    <>
      <Heading title={copy.settings.schedules.title}>{copy.settings.schedules.intro}</Heading>
      <Card className="mb-6">
        <Row>
          <Field label={copy.settings.schedules.request}>
            <TextArea
              rows={2}
              value={draft.request}
              onChange={(e) => setDraft({ ...draft, request: e.target.value })}
              placeholder={copy.settings.schedules.requestPlaceholder}
            />
          </Field>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select
              aria-label={copy.settings.schedules.when}
              value={draft.custom ? 'custom' : draft.cron}
              onChange={(e) =>
                setDraft(
                  e.target.value === 'custom'
                    ? { ...draft, custom: true }
                    : { ...draft, custom: false, cron: e.target.value },
                )
              }
            >
              {CRON_PRESETS.map((p) => (
                <option key={p.cron} value={p.cron}>
                  {p.label}
                </option>
              ))}
              <option value="custom">{copy.settings.schedules.custom}</option>
            </Select>
            {draft.custom && (
              <div className="w-40">
                <TextInput
                  aria-label={copy.settings.schedules.cronExpression}
                  value={draft.cron}
                  onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
                  placeholder={copy.settings.schedules.cronPlaceholder}
                  className="font-mono text-[12.5px]"
                />
              </div>
            )}
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
            <span className="flex-1" />
            <Button
              size="sm"
              variant="primary"
              icon={<Plus className="size-3.5" />}
              disabled={!draft.request.trim()}
              onClick={() =>
                act(async () => {
                  await send('POST', '/api/schedules', {
                    request: draft.request,
                    cron: draft.cron,
                    ...(draft.project ? { project: draft.project } : {}),
                  })
                  setDraft({ ...draft, request: '' })
                }, copy.settings.schedules.scheduled)
              }
            >
              {copy.settings.schedules.schedule}
            </Button>
          </div>
        </Row>
      </Card>
      {!list ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <LoaderCircle className="size-4 animate-spin" /> {copy.settings.schedules.loading}
        </div>
      ) : list.length === 0 ? (
        <Empty icon={<CalendarClock className="size-5" />} title={copy.settings.schedules.emptyTitle}>
          {copy.settings.schedules.emptyBody}
        </Empty>
      ) : (
        <Card>
          {list.map((s) => (
            <Row key={s.id}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] leading-relaxed">{s.request}</p>
                  <p className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-muted">
                    <span>{label(s.cron)}</span>
                    {s.project && (
                      <span>
                        {copy.settings.schedules.inProject(
                          projects.find((p) => p.id === s.project)?.name ?? s.project,
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
                </div>
                <Button
                  size="sm"
                  variant="ghost"
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
                <IconButton
                  label={copy.settings.schedules.delete}
                  onClick={() => act(() => send('DELETE', `/api/schedules/${s.id}`))}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            </Row>
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
 * round ends. They run as the person, outside the sandbox.
 */
function HooksSection() {
  const toast = useToast()
  const [rows, setRows] = useState<HookRow[]>()
  const [dirty, setDirty] = useState(false)
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
      <Heading title={copy.settings.hooks.title}>
        {copy.settings.hooks.introBeforeFsEdit}
        <code className="font-mono text-[12.5px]">fs_edit</code>
        {copy.settings.hooks.introBeforeShell}
        <code className="font-mono text-[12.5px]">shell</code>
        {copy.settings.hooks.introBeforeEditWrite}
        <code className="font-mono text-[12.5px]">Edit|Write</code>
        {copy.settings.hooks.introBeforeBash}
        <code className="font-mono text-[12.5px]">Bash</code>
        {copy.settings.hooks.introAfterBash}
      </Heading>
      {!rows ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <LoaderCircle className="size-4 animate-spin" /> {copy.settings.hooks.loading}
        </div>
      ) : (
        <Card>
          {rows.length === 0 && (
            <Row>
              <p className="text-[13px] text-muted">{copy.settings.hooks.empty}</p>
            </Row>
          )}
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place by position
            <Row key={i}>
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
                  className="font-mono text-[12.5px]"
                />
              </div>
            </Row>
          ))}
          <Row>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
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
          </Row>
        </Card>
      )}
    </>
  )
}

interface SkillEntry {
  name: string
  description: string
  dir: string
  source: 'myrmidon' | 'claude' | 'plugin' | 'project'
  enabled: boolean
}

const SKILL_SOURCES: Record<SkillEntry['source'], string> = {
  myrmidon: copy.settings.skills.sources.myrmidon,
  claude: copy.settings.skills.sources.claude,
  plugin: copy.settings.skills.sources.plugin,
  project: copy.settings.skills.sources.project,
}

interface PluginEntry {
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
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-line bg-surface-2/40 p-3">
      {Object.entries(props.plugin.settings).map(([key, spec]) => {
        const value = props.plugin.values[key]
        return (
          <div key={key} className="flex flex-col gap-1">
            <span className="flex items-center justify-between gap-2">
              <span className="font-mono text-[12.5px] font-medium">{key}</span>
              {spec.type === 'boolean' && (
                <Switch checked={value === true} label={key} onChange={(on) => save(key, on)} />
              )}
            </span>
            {spec.description && <span className="text-[12px] text-muted">{spec.description}</span>}
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
                className="font-mono text-[12.5px]"
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
  const [removing, setRemoving] = useState<string>()
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
      <Heading title={copy.settings.plugins.title}>{copy.settings.plugins.intro}</Heading>
      <form
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
          className="flex-1 font-mono text-[12.5px]"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!source.trim() || adding}
          icon={adding ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
        >
          {adding ? copy.settings.plugins.adding : copy.settings.plugins.add}
        </Button>
      </form>
      {!data ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <LoaderCircle className="size-4 animate-spin" /> {copy.settings.plugins.loading}
        </div>
      ) : data.plugins.length === 0 ? (
        <Empty icon={<Puzzle className="size-5" />} title={copy.settings.plugins.emptyTitle}>
          {copy.settings.plugins.emptyBody}
        </Empty>
      ) : (
        <>
          <Card>
            {data.plugins.map((p) => (
              <Row key={p.name}>
                <div className={cn('flex items-start gap-3', !p.enabled && 'opacity-60')}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[13.5px] font-medium">{p.name}</span>
                      {p.version && <span className="text-[12px] text-muted">v{p.version}</span>}
                      {p.author && (
                        <span className="text-[12px] text-muted">{copy.settings.plugins.by(p.author)}</span>
                      )}
                    </div>
                    {p.description && (
                      <p className="mt-1 text-[13px] leading-relaxed text-fg-2">{p.description}</p>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {parts(p).map((part) => (
                        <Pill key={part} tone="neutral">
                          {part}
                        </Pill>
                      ))}
                    </div>
                    {p.error && <p className="mt-1.5 text-[12.5px] text-bad-ink">{p.error}</p>}
                    {p.server && p.enabled && (
                      <p
                        className={cn(
                          'mt-1.5 text-[12.5px]',
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
                          className="text-[12px] text-muted hover:text-fg-2"
                        >
                          {logOpen === p.name ? copy.settings.plugins.hideLog : copy.settings.plugins.showLog}
                        </button>
                        {logOpen === p.name && (
                          <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-fill/60 px-2.5 py-2 font-mono text-[11.5px] text-fg-2">
                            {p.status.log.join('\n')}
                          </pre>
                        )}
                      </div>
                    ) : null}
                    <p className="mt-1 truncate font-mono text-[11.5px] text-muted" title={p.dir}>
                      {p.dir}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (removing !== p.name) return setRemoving(p.name)
                        setRemoving(undefined)
                        void send('DELETE', `/api/plugins/${p.name}`)
                          .then(() => toast(copy.settings.plugins.removed(p.name), 'success'))
                          .then(load)
                          .catch((err: Error) => toast(err.message, 'error'))
                      }}
                      onBlur={() => setRemoving(undefined)}
                      className={cn(removing === p.name && 'text-bad-ink')}
                    >
                      {removing === p.name
                        ? copy.settings.plugins.confirmRemove
                        : copy.settings.plugins.remove}
                    </Button>
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
              </Row>
            ))}
          </Card>
          <p className="mt-2 text-[12px] text-muted">{copy.settings.plugins.applies}</p>
        </>
      )}
    </>
  )
}

/** Skills agents can load: from Myrmidon's skills folder and the person's Claude Code skills, each switchable. */
function SkillsSection() {
  const toast = useToast()
  const [data, setData] = useState<{ skills: SkillEntry[]; dir?: string }>()
  const [proposed, setProposed] = useState<SkillProposalView[]>([])
  const load = () => {
    api<{ proposals: SkillProposalView[] }>('/api/skill-proposals')
      .then((r) => setProposed(r.proposals))
      .catch(() => {})
    return api<{ skills: SkillEntry[]; dir?: string }>('/api/skills')
      .then(setData)
      .catch((err: Error) => toast(err.message, 'error'))
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once
  useEffect(() => {
    void load()
  }, [])
  return (
    <>
      <Heading title={copy.settings.skills.title}>
        {copy.settings.skills.introBeforeDir}
        <code className="font-mono text-[12.5px]">{data?.dir ?? 'skills/'}</code>
        {copy.settings.skills.introBeforeUserDir}
        <code className="font-mono text-[12.5px]">~/.claude/skills</code>
        {copy.settings.skills.introBeforeProjectDir}
        <code className="font-mono text-[12.5px]">.claude/skills</code>
        {copy.settings.skills.introAfterProjectDir}
      </Heading>
      {proposed.length > 0 && (
        <div className="mb-6 flex flex-col gap-3">
          <h4 className="text-[13px] font-semibold text-fg-2">
            {copy.settings.skills.proposed(proposed.length)}
          </h4>
          <AnimatePresence initial={false}>
            {proposed.map((p) => (
              <SkillProposalCard key={p.id} proposal={p} onDecided={() => void load()} />
            ))}
          </AnimatePresence>
        </div>
      )}
      {!data ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <LoaderCircle className="size-4 animate-spin" /> {copy.settings.skills.loading}
        </div>
      ) : data.skills.length === 0 ? (
        <Empty icon={<GraduationCap className="size-5" />} title={copy.settings.skills.emptyTitle}>
          {copy.settings.skills.emptyBody}
        </Empty>
      ) : (
        <Card>
          {data.skills.map((s) => (
            <Row key={s.name}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[13.5px] font-medium">{s.name}</span>
                    <Pill tone={s.source === 'myrmidon' ? 'accent' : 'neutral'}>
                      {SKILL_SOURCES[s.source]}
                    </Pill>
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-fg-2">{s.description}</p>
                  <p className="mt-1 truncate font-mono text-[11.5px] text-muted" title={s.dir}>
                    {s.dir}
                  </p>
                </div>
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
            </Row>
          ))}
        </Card>
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
      <Heading title={copy.settings.memory.title}>{copy.settings.memory.intro}</Heading>
      <Card className="mb-6">
        <Row>
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
        </Row>
      </Card>
      {!memories ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <LoaderCircle className="size-4 animate-spin" /> {copy.settings.memory.loading}
        </div>
      ) : memories.length === 0 ? (
        <Empty icon={<BookMarked className="size-5" />} title={copy.settings.memory.emptyTitle}>
          {copy.settings.memory.emptyBody}
        </Empty>
      ) : (
        groups.map((g) => (
          <section key={g || 'all'} className="mb-6">
            <h4 className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
              {scopeName(g || undefined)}
            </h4>
            <Card>
              {memories
                .filter((m) => (m.project ?? '') === g)
                .map((m) => (
                  <Row key={m.id}>
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
                            className="w-full text-left text-[13.5px] leading-relaxed hover:text-fg-2"
                          >
                            {m.text}
                          </button>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
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
                              ? copy.settings.memory.fromAgent(m.source.agent ?? copy.settings.memory.anAgent)
                              : copy.settings.memory.addedByYou}{' '}
                            · {m.updatedAt.slice(0, 10)}
                          </span>
                          {m.status === 'proposed' && <Pill tone="warn">{copy.settings.memory.waiting}</Pill>}
                        </div>
                        {m.source.why && (
                          <p className="mt-1 text-[12px] text-muted">
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
                        <IconButton
                          label={copy.settings.memory.forget}
                          onClick={() =>
                            void act(() =>
                              m.status === 'proposed'
                                ? send('POST', `/api/memory/${m.id}/decide`, { keep: false })
                                : send('DELETE', `/api/memory/${m.id}`),
                            )
                          }
                        >
                          <Trash2 className="size-4" />
                        </IconButton>
                      </div>
                    </div>
                  </Row>
                ))}
            </Card>
          </section>
        ))
      )}
    </>
  )
}

const SHORTCUTS: [string, string[]][] = [
  [copy.settings.shortcuts.newTask, ['⌘', 'K']],
  [copy.settings.shortcuts.focusComposer, ['/']],
  [copy.settings.shortcuts.toggleSidebar, ['⌘', 'B']],
  [copy.settings.shortcuts.toggleWorkspace, ['⌘', 'J']],
  [copy.settings.shortcuts.openSettings, ['⌘', ',']],
  [copy.settings.shortcuts.send, ['Enter']],
  [copy.settings.shortcuts.newLine, ['Shift', 'Enter']],
  [copy.settings.shortcuts.close, ['Esc']],
]

function Shortcuts() {
  return (
    <>
      <Heading title={copy.settings.shortcuts.title} />
      <Card>
        {SHORTCUTS.map(([label, keys]) => (
          <div key={label} className="flex items-center justify-between px-4 py-3 text-[13.5px]">
            <span>{label}</span>
            <span className="flex gap-1">
              {keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </div>
        ))}
      </Card>
    </>
  )
}

function About({ data }: { data?: SettingsResponse }) {
  return (
    <>
      <Heading title={copy.settings.about.title}>{copy.settings.about.intro}</Heading>
      <Card>
        <Row>
          <Field label={copy.settings.about.dataDirectory} inline>
            <span className="font-mono text-[12.5px] text-muted">{data?.home ?? '…'}</span>
          </Field>
        </Row>
        <Row>
          <Field
            label={copy.settings.about.providersReady}
            hint={copy.settings.about.providersReadyHint}
            inline
          >
            <span className="font-mono text-[12.5px] text-muted">
              {data ? data.providers.filter((p) => p.ready).length : '…'}
            </span>
          </Field>
        </Row>
        <Row>
          <Field label={copy.settings.about.sandbox} inline>
            <span className="font-mono text-[12.5px] text-muted">{data?.sandbox ?? '…'}</span>
          </Field>
        </Row>
        <Row>
          <p className="text-[12.5px] text-muted">{copy.settings.about.eventLog}</p>
        </Row>
      </Card>
      <div className="mt-4 flex items-center gap-2 text-[12px] text-muted">
        <Bot className="size-3.5" /> {copy.settings.about.builtOn}
      </div>
    </>
  )
}
