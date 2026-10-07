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
  Moon,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Terminal,
  Trash2,
  Users,
  Webhook,
  Wrench,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ModelOption, send, type TeamConfig } from './api.ts'
import { TeamSettings } from './chat/Composer.tsx'
import { ToolLibraryList } from './chat/MadeTools.tsx'
import { AGENT_MIN_WINDOW, windowLabel } from './chat/ModelPicker.tsx'
import { NOTIFY_KEY, type ThemeChoice, usePersistentFlag } from './ui/hooks.ts'
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
  softSpring,
  spring,
  TextArea,
  TextInput,
} from './ui/primitives.tsx'
import { useToast } from './ui/Toast.tsx'

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
  /** Per-tool rules: `ask` before every call, or `off`; unlisted tools are allowed. */
  permissions: Record<string, 'ask' | 'off'>
}

interface SettingsResponse {
  settings: ServerSettings
  providers: ProviderInfo[]
  searchProviders: { id: string; label: string }[]
  customApis: Api[]
  sandbox: string
  home: string
  agentDir?: string
  ompSetup: boolean
  toolCatalog: { name: string; description: string }[]
}

export type Section =
  | 'general'
  | 'models'
  | 'team'
  | 'tools'
  | 'skills'
  | 'hooks'
  | 'schedules'
  | 'verification'
  | 'instructions'
  | 'memory'

const SECTIONS: { id: Section; label: string; hint: string; icon: typeof Palette }[] = [
  { id: 'general', label: 'General', hint: 'Theme, motion, shortcuts', icon: Palette },
  { id: 'models', label: 'Models & providers', hint: 'Models, API keys, endpoints', icon: Brain },
  { id: 'team', label: 'Team & budget', hint: 'Defaults and limits', icon: Users },
  { id: 'tools', label: 'Tools', hint: 'Shell, web, files', icon: Wrench },
  { id: 'skills', label: 'Skills', hint: 'Playbooks agents load', icon: GraduationCap },
  { id: 'hooks', label: 'Hooks', hint: 'Commands around every tool', icon: Webhook },
  { id: 'schedules', label: 'Schedules', hint: 'Requests that run on their own', icon: CalendarClock },
  { id: 'verification', label: 'Reviewer', hint: 'Off, auto or always', icon: Gavel },
  { id: 'instructions', label: 'Instructions', hint: 'House rules for agents', icon: MessageSquareText },
  { id: 'memory', label: 'Memory', hint: 'What agents keep across chats', icon: BookMarked },
]

const API_LABELS: Record<Api, string> = {
  'openai-completions': 'OpenAI-compatible (chat completions)',
  'openai-responses': 'OpenAI Responses API',
  'anthropic-messages': 'Anthropic Messages API',
  'google-generative-ai': 'Google Gemini API',
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
          Back
        </Button>
        <span className="text-[13px] font-semibold">Settings</span>
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
                <Check className="size-3.5 text-ok" />
              )}
              {saving === 'saving' ? 'Saving…' : 'All changes saved'}
            </motion.span>
          )}
        </AnimatePresence>
        <span className="hidden text-[11.5px] text-muted md:inline">
          <Kbd>Esc</Kbd> to close
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
              aria-label="Section"
            >
              {SECTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          {error && (
            <div className="m-5 rounded-xl bg-bad-soft px-4 py-3 text-[13.5px] text-bad">{error}</div>
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
                              <Brain className="size-3.5" /> Your models
                            </>
                          ),
                        },
                        {
                          value: 'providers',
                          label: (
                            <>
                              <KeyRound className="size-3.5" /> Keys &amp; providers
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
              {section === 'tools' && data && <ToolsSection data={data} update={update} />}
              {section === 'verification' && data && (
                <VerificationSection settings={data.settings} update={update} />
              )}
              {section === 'instructions' && data && (
                <InstructionsSection settings={data.settings} update={update} />
              )}
              {section === 'memory' && <MemorySection />}
              {section === 'skills' && <SkillsSection />}
              {section === 'hooks' && <HooksSection />}
              {section === 'schedules' && <SchedulesSection />}
              {!data && !error && section !== 'general' && (
                <div className="flex items-center gap-2 text-[13px] text-muted">
                  <LoaderCircle className="size-4 animate-spin" /> Loading settings…
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
      label="Notify me when a round finishes"
      hint={
        supported
          ? 'A desktop notification when a round is done (or stops) while Myrmidon is in the background, including scheduled ones.'
          : 'This browser does not support notifications.'
      }
      inline
    >
      <Switch
        checked={on && granted}
        disabled={!supported}
        label="Notify me when a round finishes"
        onChange={(v) => {
          if (!v) return setOn(false)
          void Notification.requestPermission().then((p) => {
            setOn(p === 'granted')
            if (p !== 'granted')
              toast('Notifications are blocked for this site in your browser settings', 'error')
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
      <Heading title="General">How Myrmidon looks and feels on this device.</Heading>
      <Card>
        <Row>
          <Field label="Theme" hint="System follows your operating system." inline>
            <Segmented
              id="theme"
              value={props.theme}
              onChange={props.onTheme}
              options={[
                {
                  value: 'system',
                  label: (
                    <>
                      <Monitor className="size-3.5" /> System
                    </>
                  ),
                },
                {
                  value: 'light',
                  label: (
                    <>
                      <Sun className="size-3.5" /> Light
                    </>
                  ),
                },
                {
                  value: 'dark',
                  label: (
                    <>
                      <Moon className="size-3.5" /> Dark
                    </>
                  ),
                },
              ]}
            />
          </Field>
        </Row>
        <Row>
          <Field label="Reduce motion" hint="Turn off animations and transitions." inline>
            <Switch checked={props.reduceMotion} onChange={props.onReduceMotion} label="Reduce motion" />
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
      setTests((t) => ({ ...t, [ref]: { ok: r.ok, text: r.ok ? `${r.ms} ms` : (r.error ?? 'failed') } }))
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
      <Heading title="Models">
        {props.models.length} models you can call right now, {shown} shown in pickers. Switch off whole
        providers you don’t use, hide single models, and test any model with a one-line request.
      </Heading>
      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <TextInput
            placeholder="Search models"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
            aria-label="Search models"
          />
        </div>
        <Button
          onClick={() => {
            setRefreshing(true)
            api('/api/models?refresh=1')
              .then(() => {
                props.onRefresh()
                toast('Model lists refreshed from providers', 'success')
              })
              .catch((err) => toast(String(err.message ?? err), 'error'))
              .finally(() => setRefreshing(false))
          }}
          icon={<RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />}
        >
          Refresh
        </Button>
        <Button variant="soft" onClick={props.onAddProvider} icon={<Plus className="size-3.5" />}>
          Add models
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {groups.length === 0 && (
          <Card>
            <Empty title={q ? 'No models match' : 'No models yet'} />
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
                <span className="text-[12px] text-muted">{off ? 'Off' : 'In pickers'}</span>
                <Switch
                  checked={!off}
                  label={`Show ${provider} models in pickers`}
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
                                t.ok ? 'text-ok' : 'text-bad',
                              )}
                            >
                              {t.ok ? <CircleCheck className="size-3.5" /> : <CircleX className="size-3.5" />}
                              <span className="truncate">{t.ok ? `Responded in ${t.text}` : t.text}</span>
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
                          Test
                        </Button>
                        <IconButton
                          size="sm"
                          label={isHidden ? `Show ${m.name}` : `Hide ${m.name}`}
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
  set: 'set by you',
  provider: 'from the provider',
  catalog: 'from models.dev',
  name: "from the model's name",
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
        placeholder="e.g. 32k"
        aria-label={`Context window of ${props.model.name}`}
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
          ? `${tokens.toLocaleString()} tokens of context, ${source ? WINDOW_SOURCES[source] : 'a guess'}. Click to change; clear it to go back to automatic.`
          : 'Context window unknown. Click to set it.'
      }
      className={cn(
        'h-7 min-w-14 rounded-md px-2 text-right font-mono text-[12px] tabular-nums transition-colors hover:bg-fill',
        tokens && tokens < AGENT_MIN_WINDOW ? 'text-warn' : 'text-fg-2',
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
        toast(`Signed in${who ? ` as ${who}` : ''}`, 'success')
        void load()
        api<{ providers: ProviderInfo[] }>('/api/settings')
          .then((r) => props.onProviders(r.providers))
          .catch(() => {})
      } else if (next.status === 'failed') toast(next.error ?? 'Sign-in failed', 'error')
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
        <LogIn className="size-4 text-muted" /> Sign in with a subscription
        <span className="font-normal text-muted">
          use Claude, ChatGPT or Gemini plans instead of API keys
        </span>
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
                    {l.ready ? <Pill tone="ok">signed in</Pill> : null}
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
                    Cancel
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => start(l.id)}
                    disabled={waiting}
                    icon={<LogIn className="size-3.5" />}
                  >
                    {l.ready ? 'Sign in again' : 'Sign in'}
                  </Button>
                )}
              </div>
              {active && (
                <div className="mt-3 space-y-2.5 rounded-xl border border-line bg-surface-2 p-3 text-[12.5px]">
                  <div className="flex items-center gap-2 text-fg-2">
                    <LoaderCircle className="size-3.5 animate-spin" />
                    {active.progress ?? 'Finish signing in in the browser tab; this updates by itself.'}
                  </div>
                  {active.instructions && <div className="text-muted">{active.instructions}</div>}
                  {active.url && (
                    <a
                      href={active.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 font-medium text-accent-fg hover:underline"
                    >
                      <ExternalLink className="size-3.5" /> Open the sign-in page
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
                        Submit
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
          Show {sorted.length - shown.length} more sign-ins
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
      <Heading title="Providers & keys">
        Myrmidon runs omp’s provider stack in-process: every built-in provider, OAuth logins, and custom
        endpoints from <span className="font-mono">models.yml</span>. Keys stay in owner-only files under{' '}
        <span className="font-mono">{props.data.agentDir ?? 'agent/'}</span> and never reach the browser.
      </Heading>

      {props.data.ompSetup && (
        <Card className="mb-8">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg">
              <Download className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium">Import your omp setup</div>
              <div className="text-[12.5px] text-muted">
                {importing === 'confirm'
                  ? 'Replaces Myrmidon’s keys, logins, and custom providers with the ones in ~/.omp/agent.'
                  : 'Copy keys, OAuth logins, and custom providers from ~/.omp/agent. The omp CLI is not needed.'}
              </div>
            </div>
            {importing === 'confirm' ? (
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setImporting('idle')}>
                  Cancel
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
                    }, 'Imported your omp setup')
                    setImporting('idle')
                  }}
                >
                  Replace and import
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                onClick={() => setImporting('confirm')}
                disabled={importing === 'busy'}
                icon={importing === 'busy' ? <LoaderCircle className="size-3.5 animate-spin" /> : undefined}
              >
                Import
              </Button>
            )}
          </div>
        </Card>
      )}

      <SignIns onProviders={props.onProviders} />

      <div className="mb-2 flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-[13px] font-semibold">
          <KeyRound className="size-4 text-muted" /> Providers
          <span className="font-normal text-muted">
            {providers.filter((p) => p.ready).length} ready of {providers.length}
          </span>
        </h4>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)} icon={<Plus className="size-3.5" />}>
            Custom endpoint
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
                    `Connected ${body.name}`,
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
          <Empty icon={<Server className="size-5" />} title="No providers ready yet">
            Import your omp setup, add a key below, or connect LM Studio, Ollama, vLLM, OpenRouter, or any
            OpenAI, Anthropic, or Gemini-compatible endpoint.
          </Empty>
        )}
        {shown.map((p) => (
          <div key={p.id} className="px-4 py-2.5">
            <div className="flex items-center gap-3">
              <Dot status={p.ready ? 'ready' : 'idle'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px]">{p.id}</span>
                  {p.custom && <Pill tone="accent">custom</Pill>}
                  <span className="text-[12px] text-muted">
                    {p.models} model{p.models === 1 ? '' : 's'}
                  </span>
                </div>
                {p.baseUrl && <div className="truncate font-mono text-[11.5px] text-muted">{p.baseUrl}</div>}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(editing === p.id ? undefined : p.id)}
              >
                {p.custom ? 'Edit' : p.ready ? 'Replace key' : 'Add key'}
              </Button>
              {p.ready && !p.custom && !p.stored && (
                <span
                  className="flex items-center gap-2"
                  title="Its credentials come from outside Myrmidon (environment variables, a cloud profile such as ~/.aws, or none needed). Turn it off to stop using its models."
                >
                  <span className="text-[11.5px] text-muted">{off.has(p.id) ? 'Off' : 'On'}</span>
                  <Switch
                    checked={!off.has(p.id)}
                    onChange={(on) => setOff(p.id, !on)}
                    label={`Use ${p.id}`}
                  />
                </span>
              )}
              {p.stored && !p.custom && (
                <IconButton
                  size="sm"
                  label={`Remove ${p.id} credentials`}
                  onClick={() =>
                    void act(
                      () => send<{ providers: ProviderInfo[] }>('DELETE', `/api/credentials/${p.id}`),
                      `Removed ${p.id} credentials`,
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </IconButton>
              )}
              {p.custom && (
                <IconButton
                  size="sm"
                  label={`Remove ${p.id}`}
                  onClick={() =>
                    void act(
                      () => send<{ providers: ProviderInfo[] }>('DELETE', `/api/providers/${p.id}`),
                      `Removed ${p.id}`,
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
                        `Updated ${p.id}`,
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
                      `Saved the ${p.id} key`,
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
            Show {hiddenCount} more built-in providers
          </button>
        )}
      </Card>
      <p className="mt-2 text-[12px] text-muted">
        Environment variables such as <span className="font-mono">ANTHROPIC_API_KEY</span> also work.
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
        placeholder={`${props.provider} API key`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="flex-1"
        aria-label={`${props.provider} API key`}
      />
      <Button type="submit" variant="primary" disabled={!value.trim()}>
        Save
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
            label="Name"
            hint={
              editing
                ? 'The model prefix; fixed once created.'
                : 'Lowercase. Becomes the model prefix, e.g. lmstudio/qwen3'
            }
          >
            <TextInput
              value={name}
              disabled={editing}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="lmstudio"
              aria-invalid={!!name && !nameOk}
            />
          </Field>
          <Field label="API type">
            <Select value={apiType} onChange={(e) => setApiType(e.target.value as Api)} className="w-full">
              {props.apis.map((a) => (
                <option key={a} value={a}>
                  {API_LABELS[a]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Base URL">
          <TextInput
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={API_HINT_URL[apiType]}
          />
        </Field>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Authentication">
            <Segmented
              id={`auth-${init?.id ?? 'new'}`}
              value={auth}
              onChange={setAuth}
              options={[
                { value: 'key', label: 'API key' },
                { value: 'none', label: 'None (local)' },
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
                placeholder={editing && init?.hasKey ? 'Key saved · type to replace' : 'API key'}
                aria-label="API key"
              />
            </div>
          )}
        </div>
        <Field
          label="Models"
          hint={
            discovers
              ? 'Model ids, separated by commas. Leave empty to discover them from the endpoint’s model list.'
              : 'Model ids, separated by commas.'
          }
        >
          <TextArea
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="qwen3-8b, llama-3.3-70b"
            aria-label="Model ids"
            className="min-h-16 font-mono text-[12.5px]"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
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
            {editing ? 'Save changes' : 'Connect'}
            {models.length ? ` · ${models.length} model${models.length === 1 ? '' : 's'}` : ''}
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
      <Heading title="Team & budget">
        Defaults for every new task. You can still change the team per message.
      </Heading>
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
          <Field
            label="Time limit per round"
            hint="The colony stops when this runs out, verified or not."
            inline
          >
            <NumberField
              value={t.wallMinutes}
              min={1}
              max={240}
              suffix="min"
              onChange={(v) => props.update((s) => ({ ...s, team: { ...s.team, wallMinutes: v } }))}
            />
          </Field>
        </Row>
        <Row>
          <Field
            label="Spend limit per round"
            hint="The round stops at this cost; at 80% agents are told to wrap up. 0 means no limit."
            inline
          >
            <NumberField
              value={t.costUsd}
              min={0}
              max={1000}
              step={0.1}
              suffix="$"
              onChange={(v) => props.update((s) => ({ ...s, team: { ...s.team, costUsd: v } }))}
            />
          </Field>
        </Row>
        <Row>
          <Field
            label="Token limit per round"
            hint="Counts every token the models process, cached input included. 0 means no limit."
            inline
          >
            <NumberField
              value={t.tokens}
              min={0}
              max={1_000_000_000}
              suffix="tok"
              wide
              onChange={(v) => props.update((s) => ({ ...s, team: { ...s.team, tokens: v } }))}
            />
          </Field>
        </Row>
        <Row>
          <Field label="Turns per agent" hint="Each agent stops after this many turns." inline>
            <NumberField
              value={t.maxTurns}
              min={1}
              max={200}
              onChange={(v) => props.update((s) => ({ ...s, team: { ...s.team, maxTurns: v } }))}
            />
          </Field>
        </Row>
        <Row>
          <Field
            label="Observer interval"
            hint="How often the observer checks time, idle agents, and stalls."
            inline
          >
            <NumberField
              value={props.data.settings.observer.intervalSeconds}
              min={10}
              max={600}
              suffix="s"
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
    label: 'Shell',
    hint: 'Run commands in a sandbox that can only write to the agent’s scratch folder.',
    icon: Terminal,
  },
  {
    key: 'web',
    label: 'Web search & fetch',
    hint: 'Search the internet and read pages, PDFs, repos, and papers with dedicated readers.',
    icon: Globe,
  },
  {
    key: 'files',
    label: 'Scratch files',
    hint: 'Private working files for drafts before publishing artifacts.',
    icon: SlidersHorizontal,
  },
  {
    key: 'messaging',
    label: 'Messaging',
    hint: 'Board posts, direct mail between agents, and shared notes.',
    icon: MessageSquareText,
  },
  {
    key: 'mcp',
    label: 'MCP servers',
    hint: 'Tools from the MCP servers below, for every agent that does hands-on work.',
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
  const set = (name: string, rule: string) =>
    props.update((s) => {
      const next = { ...(s.permissions ?? {}) }
      if (rule === 'ask' || rule === 'off') next[name] = rule
      else delete next[name]
      return { ...s, permissions: next }
    }, true)
  return (
    <>
      <h4 className="mb-2 mt-8 flex items-center gap-2 text-[13px] font-semibold">
        <ShieldCheck className="size-4 text-muted" /> Per-tool rules
        <span className="font-normal text-muted">
          ask before each call, or turn one tool off; applies to new rounds
        </span>
      </h4>
      <Card>
        <Row>
          <TextInput
            aria-label="Find a tool"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a tool, e.g. browser, shell, mcp"
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
                  aria-label={`Rule for ${t.name}`}
                  value={rules[t.name] ?? 'allow'}
                  onChange={(e) => set(t.name, e.target.value)}
                >
                  <option value="allow">Allow</option>
                  <option value="ask">Ask first</option>
                  <option value="off">Off</option>
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
      <Heading title="Tools">
        Capabilities agents get in new tasks. Publishing, tasks, and verification are always on.
      </Heading>
      <div
        className={cn(
          'mb-4 flex items-start gap-3 rounded-2xl border px-4 py-3 text-[13px]',
          sandboxed ? 'border-ok/25 bg-ok-soft' : 'border-warn/25 bg-warn-soft',
        )}
      >
        <ShieldCheck className={cn('mt-0.5 size-4 shrink-0', sandboxed ? 'text-ok' : 'text-warn')} />
        <div>
          <div className="font-semibold">
            {sandboxed ? `Sandbox active: ${props.data.sandbox}` : 'No OS sandbox found'}
          </div>
          <div className="text-fg-2">
            {sandboxed
              ? 'Shell commands and command checks cannot write outside the agent’s scratch folder.'
              : 'The shell tool stays disabled unless the server is started with --unsafe-no-sandbox.'}
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
        <Wrench className="size-4 text-muted" /> Your tool library
        <span className="font-normal text-muted">
          tools agents made that you kept; every new round starts with them
        </span>
      </h4>
      <ToolLibraryList />
      <h4 className="mb-2 mt-8 flex items-center gap-2 text-[13px] font-semibold">
        <Search className="size-4 text-muted" /> Web search
      </h4>
      <Card>
        <Row>
          <Field
            label="Search provider"
            hint="Auto tries omp’s chain: providers you have keys for first, then keyless ones like DuckDuckGo."
            inline
          >
            <Select
              value={props.data.settings.search.provider}
              onChange={(e) => props.update((s) => ({ ...s, search: { provider: e.target.value } }), true)}
              aria-label="Search provider"
              className="min-w-44"
            >
              <option value="auto">Auto</option>
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
      `Added ${form.name.trim()}`,
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
          <Plug className="size-4 text-muted" /> MCP servers
          <span className="font-normal text-muted">from mcp.json; imported with your omp setup</span>
        </h4>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => act(() => send('POST', '/api/mcp-reload'), 'Reconnected MCP servers')}
            icon={<RefreshCw className="size-3.5" />}
          >
            Reconnect
          </Button>
          {!adding && (
            <Button size="sm" onClick={() => setAdding(true)} icon={<Plus className="size-3.5" />}>
              Add server
            </Button>
          )}
        </div>
      </div>
      {adding && (
        <Card className="mb-3">
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <Field label="Name">
              <TextInput
                value={form.name}
                placeholder="github"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Transport">
              <Select
                value={form.transport}
                onChange={(e) => setForm({ ...form, transport: e.target.value })}
              >
                <option value="stdio">Local command (stdio)</option>
                <option value="http">Remote (HTTP)</option>
                <option value="sse">Remote (SSE, legacy)</option>
              </Select>
            </Field>
            {form.transport === 'stdio' ? (
              <>
                <Field label="Command" hint="The program and its arguments.">
                  <TextInput
                    value={form.command}
                    placeholder="npx -y @modelcontextprotocol/server-filesystem /path"
                    onChange={(e) => setForm({ ...form, command: e.target.value })}
                    className="font-mono text-[12px]"
                  />
                </Field>
                <Field
                  label="Environment"
                  hint="KEY=value per line. Your own API keys are not passed on otherwise."
                >
                  <TextArea
                    rows={2}
                    value={form.env}
                    onChange={(e) => setForm({ ...form, env: e.target.value })}
                    className="font-mono text-[12px]"
                  />
                </Field>
              </>
            ) : (
              <Field label="URL">
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
              Cancel
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
              Add and connect
            </Button>
          </div>
        </Card>
      )}
      <Card>
        {servers === undefined ? (
          <Row>
            <span className="text-[13px] text-muted">Loading…</span>
          </Row>
        ) : servers.length === 0 ? (
          <Row>
            <span className="text-[13px] text-muted">
              No MCP servers yet. Add one, or import your omp setup under Models &amp; providers.
            </span>
          </Row>
        ) : (
          servers.map((m) => (
            <Row key={m.name}>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13.5px] font-medium">
                    {m.name}
                    <Pill tone={MCP_TONE[m.status]}>{m.status}</Pill>
                    {m.tools.length > 0 && (
                      <span className="text-[12px] text-muted">{m.tools.length} tools</span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[11.5px] text-muted" title={m.target}>
                    {m.transport} · {m.target}
                  </div>
                  {m.error && <div className="mt-0.5 text-[12px] text-bad">{m.error}</div>}
                </div>
                <Switch
                  checked={m.enabled}
                  label={`Enable ${m.name}`}
                  onChange={(v) =>
                    act(
                      () => send('PUT', `/api/mcp/${encodeURIComponent(m.name)}`, { enabled: v }),
                      v ? `Enabled ${m.name}` : `Disabled ${m.name}`,
                    )
                  }
                />
                <IconButton
                  label={`Remove ${m.name}`}
                  size="sm"
                  onClick={() =>
                    act(() => send('DELETE', `/api/mcp/${encodeURIComponent(m.name)}`), `Removed ${m.name}`)
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
  off: "Never. The lead's final answer completes the task.",
  auto: 'When the lead decides the work deserves it: code, files, research with sources.',
  always: 'Every final answer, before the task completes; findings go back to the lead to fix.',
} as const

function VerificationSection(props: {
  settings: ServerSettings
  update(p: (s: ServerSettings) => ServerSettings): void
}) {
  const v = props.settings.verification
  const off = v.reviewer === 'off'
  return (
    <>
      <Heading title="Reviewer">
        An independent model checks the work against your request. Choose its model under Team &amp; budget;
        one from another provider than the team catches more.
      </Heading>
      <Card>
        <Row>
          <Field label="When to review" hint={REVIEWER_HINT[v.reviewer]} inline>
            <Segmented
              id="reviewer"
              value={v.reviewer}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'auto', label: 'Auto' },
                { value: 'always', label: 'Always' },
              ]}
              onChange={(reviewer) =>
                props.update((s) => ({ ...s, verification: { ...s.verification, reviewer } }))
              }
            />
          </Field>
        </Row>
        <Row>
          <Field label="Pass threshold" hint="Reviewer score from 0 to 1 needed for the work to pass." inline>
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
                aria-label="Pass threshold"
                disabled={off}
              />
              <span className="w-10 text-right font-mono text-[13px] tabular-nums">
                {v.threshold.toFixed(2)}
              </span>
            </div>
          </Field>
        </Row>
        <Row>
          <Field
            label="Custom rubric"
            hint="Optional. Replaces the default rubric the reviewer scores against."
          >
            <TextArea
              value={v.rubric ?? ''}
              onChange={(e) =>
                props.update((s) => ({ ...s, verification: { ...s.verification, rubric: e.target.value } }))
              }
              placeholder="e.g. Code must include tests that pass; reports must cite a primary source for every number."
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
      <Heading title="Agent instructions">
        Added to the system prompt of every agent in new tasks. Use it for your house rules.
      </Heading>
      <Card>
        <Row>
          <Field label="Lead" hint="Planning, delegation, and how to talk to you.">
            <TextArea
              value={i.lead ?? ''}
              onChange={(e) =>
                props.update((s) => ({ ...s, instructions: { ...s.instructions, lead: e.target.value } }))
              }
              placeholder="e.g. Prefer TypeScript. Keep plans to three bullets. Always cite sources."
              rows={5}
            />
          </Field>
        </Row>
        <Row>
          <Field label="Workers" hint="How workers should do and report their part.">
            <TextArea
              value={i.worker ?? ''}
              onChange={(e) =>
                props.update((s) => ({ ...s, instructions: { ...s.instructions, worker: e.target.value } }))
              }
              placeholder="e.g. Write tests first. Report blockers immediately."
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
  { cron: '0 * * * *', label: 'Every hour' },
  { cron: '0 9 * * *', label: 'Every day at 9:00' },
  { cron: '0 9 * * 1-5', label: 'Weekdays at 9:00' },
  { cron: '0 9 * * 1', label: 'Mondays at 9:00' },
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
      <Heading title="Schedules">
        Requests that run on their own, like a daily digest or a weekly dependency check. Each run is a new
        chat with your default team, verified like any other; turn on notifications in General to hear when
        one finishes. The server has to be running for a schedule to fire.
      </Heading>
      <Card className="mb-6">
        <Row>
          <Field label="Request">
            <TextArea
              rows={2}
              value={draft.request}
              onChange={(e) => setDraft({ ...draft, request: e.target.value })}
              placeholder="e.g. Summarize what changed in this repo since yesterday and flag anything risky."
            />
          </Field>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select
              aria-label="When"
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
              <option value="custom">Custom (cron)</option>
            </Select>
            {draft.custom && (
              <div className="w-40">
                <TextInput
                  aria-label="Cron expression"
                  value={draft.cron}
                  onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
                  placeholder="m h dom mon dow"
                  className="font-mono text-[12.5px]"
                />
              </div>
            )}
            <Select
              aria-label="Project"
              value={draft.project}
              onChange={(e) => setDraft({ ...draft, project: e.target.value })}
            >
              <option value="">No project</option>
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
                }, 'Scheduled')
              }
            >
              Schedule
            </Button>
          </div>
        </Row>
      </Card>
      {!list ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <LoaderCircle className="size-4 animate-spin" /> Loading schedules…
        </div>
      ) : list.length === 0 ? (
        <Empty icon={<CalendarClock className="size-5" />} title="Nothing scheduled">
          Add a request above and it runs on its own at the times you pick.
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
                      <span>in {projects.find((p) => p.id === s.project)?.name ?? s.project}</span>
                    )}
                    <span>{s.enabled ? `next ${when(s.nextRun)}` : 'paused'}</span>
                    {s.lastRun && (
                      <span className={s.lastRun.error ? 'text-bad' : ''}>
                        last {when(s.lastRun.at)}
                        {s.lastRun.error ? `: ${s.lastRun.error}` : ''}
                      </span>
                    )}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => act(() => send('POST', `/api/schedules/${s.id}/run`), 'Started a run')}
                >
                  Run now
                </Button>
                <Switch
                  checked={s.enabled}
                  label={`Run ${s.name} on schedule`}
                  onChange={(enabled) => act(() => send('PATCH', `/api/schedules/${s.id}`, { enabled }))}
                />
                <IconButton
                  label="Delete this schedule"
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
  { value: 'PreToolUse', label: 'Before a tool' },
  { value: 'PostToolUse', label: 'After a tool' },
  { value: 'Stop', label: 'When a round ends' },
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
      toast('Hooks saved: they apply to every tool call from now on', 'success')
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }
  return (
    <>
      <Heading title="Hooks">
        Commands Myrmidon runs at fixed points, so a rule holds every time instead of relying on an agent:
        format after every edit, refuse commands that touch secrets, notify you when a round ends. Same format
        as Claude Code: a hook gets the event as JSON on stdin; exit 2 before a tool blocks it, after a tool
        tells the agent. Tool names match Myrmidon's (<code className="font-mono text-[12.5px]">fs_edit</code>
        , <code className="font-mono text-[12.5px]">shell</code>) or Claude Code's (
        <code className="font-mono text-[12.5px]">Edit|Write</code>,{' '}
        <code className="font-mono text-[12.5px]">Bash</code>
        ). Hooks run as you, outside the sandbox.
      </Heading>
      {!rows ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <LoaderCircle className="size-4 animate-spin" /> Loading hooks…
        </div>
      ) : (
        <Card>
          {rows.length === 0 && (
            <Row>
              <p className="text-[13px] text-muted">No hooks yet.</p>
            </Row>
          )}
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place by position
            <Row key={i}>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label="When"
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
                        aria-label="Tools"
                        value={r.matcher}
                        onChange={(e) => change(i, { matcher: e.target.value })}
                        placeholder="Tools, e.g. Edit|Write (empty: all)"
                      />
                    </div>
                  )}
                  <div className="w-20">
                    <TextInput
                      aria-label="Timeout in seconds"
                      value={r.timeout}
                      onChange={(e) => change(i, { timeout: e.target.value.replace(/[^\d.]/g, '') })}
                      placeholder="60s"
                    />
                  </div>
                  <span className="flex-1" />
                  <IconButton
                    label="Remove this hook"
                    onClick={() => {
                      setRows((rs) => rs?.filter((_, j) => j !== i))
                      setDirty(true)
                    }}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
                <TextInput
                  aria-label="Command"
                  value={r.command}
                  onChange={(e) => change(i, { command: e.target.value })}
                  placeholder={`e.g. jq -r .tool_input.file_path | xargs npx prettier --write`}
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
                Add hook
              </Button>
              <span className="flex-1" />
              <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void save()}>
                Save
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
  source: 'myrmidon' | 'claude' | 'project'
  enabled: boolean
}

const SKILL_SOURCES: Record<SkillEntry['source'], string> = {
  myrmidon: 'Myrmidon',
  claude: 'Claude Code',
  project: 'project',
}

/** Skills agents can load: from Myrmidon's skills folder and the person's Claude Code skills, each switchable. */
function SkillsSection() {
  const toast = useToast()
  const [data, setData] = useState<{ skills: SkillEntry[]; dir?: string }>()
  const load = () =>
    api<{ skills: SkillEntry[]; dir?: string }>('/api/skills')
      .then(setData)
      .catch((err: Error) => toast(err.message, 'error'))
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once
  useEffect(() => {
    void load()
  }, [])
  return (
    <>
      <Heading title="Skills">
        Playbooks in the Agent Skills format (a folder with a SKILL.md, plus scripts and references). Agents
        see each skill's name and description, and load the full skill when a task matches. Add one by putting
        its folder in <code className="font-mono text-[12.5px]">{data?.dir ?? 'skills/'}</code> or{' '}
        <code className="font-mono text-[12.5px]">~/.claude/skills</code>; a project's{' '}
        <code className="font-mono text-[12.5px]">.claude/skills</code> apply to its chats.
      </Heading>
      {!data ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <LoaderCircle className="size-4 animate-spin" /> Loading skills…
        </div>
      ) : data.skills.length === 0 ? (
        <Empty icon={<GraduationCap className="size-5" />} title="No skills yet">
          Put a skill folder in one of the places above and it appears here.
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
                  label={`Agents can use ${s.name}`}
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
    project ? (projects.find((p) => p.id === project)?.name ?? project) : 'Every chat'
  const groups = [...new Set((memories ?? []).map((m) => m.project ?? ''))].sort((a, b) =>
    a === '' ? -1 : b === '' ? 1 : scopeName(a).localeCompare(scopeName(b)),
  )
  return (
    <>
      <Heading title="Memory">
        What every new chat starts knowing: your preferences and decisions, and lessons about each project.
        Agents propose memories during a chat; nothing is kept until you keep it.
      </Heading>
      <Card className="mb-6">
        <Row>
          <Field label="Remember something" hint="One fact per memory, in a sentence.">
            <TextArea
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              placeholder="e.g. I prefer pnpm over npm. Reports go in docs/reports/."
              rows={2}
            />
          </Field>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select
              aria-label="Kind"
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
            >
              {MEMORY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Applies to"
              value={draft.project}
              onChange={(e) => setDraft({ ...draft, project: e.target.value })}
            >
              <option value="">Every chat</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  Only {p.name}
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
              Remember
            </Button>
          </div>
        </Row>
      </Card>
      {!memories ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <LoaderCircle className="size-4 animate-spin" /> Loading memory…
        </div>
      ) : memories.length === 0 ? (
        <Empty icon={<BookMarked className="size-5" />} title="Nothing remembered yet">
          Add something above, or keep a memory an agent proposes in a chat.
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
                            title="Edit"
                            onClick={() => setEditing({ id: m.id, text: m.text })}
                            className="w-full text-left text-[13.5px] leading-relaxed hover:text-fg-2"
                          >
                            {m.text}
                          </button>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                          <Select
                            aria-label="Kind"
                            value={m.kind}
                            onChange={(e) =>
                              void act(() => send('PATCH', `/api/memory/${m.id}`, { kind: e.target.value }))
                            }
                          >
                            {MEMORY_KINDS.map((k) => (
                              <option key={k} value={k}>
                                {k}
                              </option>
                            ))}
                          </Select>
                          <Select
                            aria-label="Applies to"
                            value={m.project ?? ''}
                            onChange={(e) =>
                              void act(() =>
                                send('PATCH', `/api/memory/${m.id}`, { project: e.target.value || null }),
                              )
                            }
                          >
                            <option value="">Every chat</option>
                            {projects.map((p) => (
                              <option key={p.id} value={p.id}>
                                Only {p.name}
                              </option>
                            ))}
                          </Select>
                          <span>
                            {m.source.by === 'agent'
                              ? `from ${m.source.agent ?? 'an agent'}`
                              : 'added by you'}{' '}
                            · {m.updatedAt.slice(0, 10)}
                          </span>
                          {m.status === 'proposed' && <Pill tone="warn">waiting for you</Pill>}
                        </div>
                        {m.source.why && <p className="mt-1 text-[12px] text-muted">Why: {m.source.why}</p>}
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
                            Save
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
                            Keep
                          </Button>
                        ) : null}
                        <IconButton
                          label="Forget this"
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
  ['New task', ['⌘', 'K']],
  ['Focus the message box', ['/']],
  ['Toggle sidebar', ['⌘', 'B']],
  ['Toggle workspace', ['⌘', 'J']],
  ['Open settings', ['⌘', ',']],
  ['Send message', ['Enter']],
  ['New line', ['Shift', 'Enter']],
  ['Close dialogs and panels', ['Esc']],
]

function Shortcuts() {
  return (
    <>
      <Heading title="Keyboard shortcuts" />
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
      <Heading title="About Myrmidon">
        Colonies of agents that plan, research, build, and verify on your machine.
      </Heading>
      <Card>
        <Row>
          <Field label="Data directory" inline>
            <span className="font-mono text-[12.5px] text-muted">{data?.home ?? '…'}</span>
          </Field>
        </Row>
        <Row>
          <Field label="Providers ready" hint="Through the embedded omp provider stack." inline>
            <span className="font-mono text-[12.5px] text-muted">
              {data ? data.providers.filter((p) => p.ready).length : '…'}
            </span>
          </Field>
        </Row>
        <Row>
          <Field label="Sandbox" inline>
            <span className="font-mono text-[12.5px] text-muted">{data?.sandbox ?? '…'}</span>
          </Field>
        </Row>
        <Row>
          <p className="text-[12.5px] text-muted">
            Every colony is an append-only event log; agents never edit your files directly. Licensed under
            Apache-2.0.
          </p>
        </Row>
      </Card>
      <div className="mt-4 flex items-center gap-2 text-[12px] text-muted">
        <Bot className="size-3.5" /> Built on oh-my-pi (providers, search, readers), pi-agent-core, and
        Cordis.
      </div>
    </>
  )
}
