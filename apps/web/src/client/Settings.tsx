import {
  ArrowLeft,
  Bot,
  Brain,
  Check,
  CircleCheck,
  CircleX,
  Eye,
  EyeOff,
  Gavel,
  Globe,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  Monitor,
  Moon,
  Palette,
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
  Wrench,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ModelOption, send, type TeamConfig } from './api.ts'
import { TeamSettings } from './chat/Composer.tsx'
import type { ThemeChoice } from './ui/hooks.ts'
import {
  Button,
  cn,
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

type Api =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'ollama-chat'

interface ProviderConfig {
  name: string
  api: Api
  baseUrl: string
  auth: 'key' | 'none'
  models: { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }[]
}

export interface ServerSettings {
  version: 1
  team: {
    mode: 'auto' | 'manual'
    workers: number
    leadModel?: string
    workerModel?: string
    judgeModel?: string
    wallMinutes: number
    maxTurns: number
  }
  tools: { shell: boolean; web: boolean; files: boolean; messaging: boolean }
  verification: { threshold: number; rubric?: string }
  instructions: { lead?: string; worker?: string }
  observer: { intervalSeconds: number }
  models: { hidden: string[]; providers: ProviderConfig[] }
}

interface SettingsResponse {
  settings: ServerSettings
  credentials: string[]
  builtInProviders: string[]
  customApis: Api[]
  sandbox: string
  home: string
  omp: boolean
}

export type Section = 'general' | 'models' | 'team' | 'tools' | 'verification' | 'instructions'

const SECTIONS: { id: Section; label: string; hint: string; icon: typeof Palette }[] = [
  { id: 'general', label: 'General', hint: 'Theme, motion, shortcuts', icon: Palette },
  { id: 'models', label: 'Models & providers', hint: 'Models, API keys, endpoints', icon: Brain },
  { id: 'team', label: 'Team & budget', hint: 'Defaults and limits', icon: Users },
  { id: 'tools', label: 'Tools', hint: 'Shell, web, files', icon: Wrench },
  { id: 'verification', label: 'Verification', hint: 'Judge threshold, rubric', icon: Gavel },
  { id: 'instructions', label: 'Instructions', hint: 'House rules for agents', icon: MessageSquareText },
]

const API_LABELS: Record<Api, string> = {
  'openai-completions': 'OpenAI-compatible (chat completions)',
  'openai-responses': 'OpenAI Responses API',
  'anthropic-messages': 'Anthropic Messages API',
  'google-generative-ai': 'Google Gemini API',
  'ollama-chat': 'Ollama',
}

const API_HINT_URL: Record<Api, string> = {
  'openai-completions': 'https://api.example.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
  'ollama-chat': 'http://localhost:11434',
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

  const credentialsChanged = (credentials: string[]) => {
    setData((d) => (d ? { ...d, credentials } : d))
    props.onModelsChanged()
  }

  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="glass flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
        <Button variant="ghost" size="sm" onClick={props.onClose} icon={<ArrowLeft className="size-4" />}>
          Back
        </Button>
        <span className="text-[14px] font-semibold">Settings</span>
        <span className="text-muted">/</span>
        <span className="truncate text-[14px] text-fg-2">{current?.label}</span>
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
                  section === s.id ? 'bg-accent-soft text-accent' : 'bg-surface-2',
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
                    <Providers data={data} update={update} onCredentials={credentialsChanged} />
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
  const hidden = new Set(props.settings.models.hidden)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return props.models.filter((m) => !q || `${m.ref} ${m.name}`.toLowerCase().includes(q)).slice(0, 200)
  }, [props.models, query])

  const test = async (ref: string) => {
    setTests((t) => ({ ...t, [ref]: 'running' }))
    try {
      const r = await send<{ ok: boolean; ms?: number; error?: string }>('POST', '/api/models/test', { ref })
      setTests((t) => ({ ...t, [ref]: { ok: r.ok, text: r.ok ? `${r.ms} ms` : (r.error ?? 'failed') } }))
    } catch (err) {
      setTests((t) => ({ ...t, [ref]: { ok: false, text: String((err as Error).message) } }))
    }
  }

  return (
    <>
      <Heading title="Models">
        {props.models.length} models from your omp setup, providers you added, and built-in providers with a
        saved key. Hide the ones you never use, and test any model with a one-line request.
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
                toast('Model list refreshed from omp', 'success')
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
      <Card className="max-h-[52vh] overflow-auto">
        {filtered.length === 0 && <Empty title="No models match" />}
        {filtered.map((m) => {
          const t = tests[m.ref]
          const isHidden = hidden.has(m.ref)
          return (
            <div key={m.ref} className={cn('flex items-center gap-3 px-4 py-2.5', isHidden && 'opacity-55')}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{m.name}</span>
                  {m.reasoning && <Brain className="size-3.5 text-muted" />}
                  {m.source && <Pill tone={m.source === 'omp' ? 'neutral' : 'accent'}>{m.source}</Pill>}
                </div>
                <div className="truncate font-mono text-[11.5px] text-muted">{m.ref}</div>
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
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void test(m.ref)}
                disabled={t === 'running'}
                icon={t === 'running' ? <LoaderCircle className="size-3.5 animate-spin" /> : undefined}
              >
                Test
              </Button>
              <IconButton
                size="sm"
                label={isHidden ? `Show ${m.name}` : `Hide ${m.name}`}
                onClick={() =>
                  props.update((s) => {
                    const set = new Set(s.models.hidden)
                    if (set.has(m.ref)) set.delete(m.ref)
                    else set.add(m.ref)
                    s.models.hidden = [...set]
                    return s
                  }, true)
                }
              >
                {isHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </IconButton>
            </div>
          )
        })}
      </Card>
    </>
  )
}

function Providers(props: {
  data: SettingsResponse
  update(p: (s: ServerSettings) => ServerSettings, immediate?: boolean): void
  onCredentials(c: string[]): void
}) {
  const toast = useToast()
  const [keyProvider, setKeyProvider] = useState(
    props.data.builtInProviders.includes('anthropic') ? 'anthropic' : (props.data.builtInProviders[0] ?? ''),
  )
  const [keyValue, setKeyValue] = useState('')
  const [adding, setAdding] = useState(false)
  const providers = props.data.settings.models.providers

  const saveKey = async (provider: string, value: string) => {
    try {
      const r = await send<{ credentials: string[] }>('PUT', `/api/credentials/${provider}`, {
        apiKey: value,
      })
      props.onCredentials(r.credentials)
      toast(`Saved the ${provider} key`, 'success')
      return true
    } catch (err) {
      toast(String((err as Error).message), 'error')
      return false
    }
  }

  const removeKey = async (provider: string) => {
    try {
      const r = await send<{ credentials: string[] }>('DELETE', `/api/credentials/${provider}`)
      props.onCredentials(r.credentials)
      toast(`Removed the ${provider} key`, 'info')
    } catch (err) {
      toast(String((err as Error).message), 'error')
    }
  }

  return (
    <>
      <Heading title="Providers & keys">
        Add any model the way omp does: save a key for a built-in provider, or connect your own endpoint. Keys
        stay in a private file on this machine, are never shown again, and are scrubbed from colony logs.
      </Heading>

      <h4 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        <KeyRound className="size-4 text-muted" /> API keys for built-in providers
      </h4>
      <Card className="mb-8">
        <Row>
          <div className="flex flex-wrap gap-2">
            <Select
              value={keyProvider}
              onChange={(e) => setKeyProvider(e.target.value)}
              aria-label="Provider"
              className="min-w-40"
            >
              {props.data.builtInProviders.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
            <TextInput
              type="password"
              autoComplete="off"
              placeholder="Paste API key"
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
              className="min-w-48 flex-1"
              aria-label="API key"
            />
            <Button
              variant="primary"
              disabled={!keyValue.trim()}
              onClick={async () => {
                if (await saveKey(keyProvider, keyValue)) setKeyValue('')
              }}
            >
              Save key
            </Button>
          </div>
          <p className="mt-2 text-[12px] text-muted">
            Without a saved key, Myrmidon uses the provider’s environment variable or your{' '}
            <span className="font-mono">omp login</span>.
          </p>
        </Row>
        {props.data.credentials.map((p) => (
          <div key={p} className="flex items-center gap-3 px-4 py-2.5">
            <KeyRound className="size-4 text-ok" />
            <span className="flex-1 font-mono text-[13px]">{p}</span>
            <span className="font-mono text-[12px] text-muted">••••••••</span>
            <IconButton size="sm" label={`Remove ${p} key`} onClick={() => void removeKey(p)}>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))}
      </Card>

      <div className="mb-2 flex items-center justify-between">
        <h4 className="flex items-center gap-2 text-[13px] font-semibold">
          <Server className="size-4 text-muted" /> Custom providers
        </h4>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)} icon={<Plus className="size-3.5" />}>
            Add provider
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
              existing={providers.map((p) => p.name)}
              apis={props.data.customApis}
              onCancel={() => setAdding(false)}
              onSave={async (p, key) => {
                if (key && !(await saveKey(p.name, key))) return
                props.update((s) => {
                  s.models.providers = [...s.models.providers, p]
                  return s
                }, true)
                setAdding(false)
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {providers.length === 0 && !adding ? (
        <Card>
          <Empty icon={<Server className="size-5" />} title="No custom providers">
            Connect LM Studio, Ollama, vLLM, OpenRouter, a company gateway, or any OpenAI, Anthropic, or
            Gemini-compatible endpoint.
          </Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {providers.map((p) => (
            <ProviderCard
              key={p.name}
              provider={p}
              hasKey={props.data.credentials.includes(p.name)}
              onChange={(next) =>
                props.update((s) => {
                  s.models.providers = s.models.providers.map((x) => (x.name === p.name ? next : x))
                  return s
                }, true)
              }
              onRemove={() =>
                props.update((s) => {
                  s.models.providers = s.models.providers.filter((x) => x.name !== p.name)
                  return s
                }, true)
              }
            />
          ))}
        </div>
      )}
    </>
  )
}

function ProviderForm(props: {
  existing: string[]
  apis: Api[]
  onCancel(): void
  onSave(p: ProviderConfig, key?: string): Promise<void>
}) {
  const [name, setName] = useState('')
  const [apiType, setApiType] = useState<Api>('openai-completions')
  const [baseUrl, setBaseUrl] = useState('')
  const [auth, setAuth] = useState<'key' | 'none'>('key')
  const [key, setKey] = useState('')
  const [found, setFound] = useState<string[]>()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const nameOk = /^[a-z0-9][a-z0-9_-]{0,39}$/.test(name) && !props.existing.includes(name)
  const urlOk = /^https?:\/\//.test(baseUrl)

  const discover = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const r = await send<{ models: string[] }>('POST', '/api/providers/discover', {
        api: apiType,
        baseUrl,
        apiKey: auth === 'key' ? key : undefined,
      })
      setFound(r.models)
      setPicked(new Set(r.models.slice(0, 20)))
    } catch (err) {
      setError(String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const models = [...new Set([...picked, ...manual.split(/[\s,]+/).filter(Boolean)])]
  return (
    <Card className="mb-3 border-accent/30">
      <div className="grid gap-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="Lowercase. Becomes the model prefix, e.g. lmstudio/qwen3">
            <TextInput
              value={name}
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
              id="auth"
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
                placeholder="API key (stored privately)"
                aria-label="API key"
              />
            </div>
          )}
        </div>
        <div className="rounded-xl bg-surface-2 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[13px] font-medium">Models</span>
            <Button
              size="sm"
              onClick={() => void discover()}
              disabled={!urlOk || busy}
              icon={
                busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />
              }
            >
              Discover models
            </Button>
          </div>
          {error && <p className="mb-2 text-[12.5px] text-bad">{error}</p>}
          {found && (
            <div className="mb-2 max-h-48 overflow-auto rounded-lg border border-line bg-surface p-1">
              {found.length === 0 && (
                <p className="p-2 text-[12.5px] text-muted">The endpoint listed no models.</p>
              )}
              {found.map((id) => (
                <label
                  key={id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[12.5px] hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={picked.has(id)}
                    onChange={() =>
                      setPicked((p) => {
                        const n = new Set(p)
                        if (n.has(id)) n.delete(id)
                        else n.add(id)
                        return n
                      })
                    }
                    className="accent-[var(--accent)]"
                  />
                  <span className="font-mono">{id}</span>
                </label>
              ))}
            </div>
          )}
          <TextInput
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="…or type model ids, separated by commas"
            aria-label="Model ids"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!nameOk || !urlOk || models.length === 0}
            onClick={() =>
              void props.onSave(
                { name, api: apiType, baseUrl: baseUrl.trim(), auth, models: models.map((id) => ({ id })) },
                auth === 'key' && key.trim() ? key.trim() : undefined,
              )
            }
          >
            Add provider · {models.length} model{models.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function ProviderCard(props: {
  provider: ProviderConfig
  hasKey: boolean
  onChange(p: ProviderConfig): void
  onRemove(): void
}) {
  const [adding, setAdding] = useState('')
  const p = props.provider
  return (
    <Card>
      <div className="flex items-start gap-3 px-4 py-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
          <Server className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{p.name}</span>
            <Pill>{API_LABELS[p.api]}</Pill>
            {p.auth === 'none' ? (
              <Pill tone="neutral">no key</Pill>
            ) : props.hasKey ? (
              <Pill tone="ok">key saved</Pill>
            ) : (
              <Pill tone="warn">no key yet</Pill>
            )}
          </div>
          <div className="truncate font-mono text-[12px] text-muted">{p.baseUrl}</div>
        </div>
        <IconButton size="sm" label={`Remove ${p.name}`} onClick={props.onRemove}>
          <Trash2 className="size-4" />
        </IconButton>
      </div>
      <div className="flex flex-wrap gap-1.5 px-4 py-3">
        {p.models.map((m) => (
          <span
            key={m.id}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 py-0.5 pl-2.5 pr-1 font-mono text-[11.5px]"
          >
            {m.id}
            <button
              type="button"
              aria-label={`Remove ${m.id}`}
              onClick={() => props.onChange({ ...p, models: p.models.filter((x) => x.id !== m.id) })}
              className="grid size-4 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-fg"
            >
              ×
            </button>
          </span>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const id = adding.trim()
            if (id && !p.models.some((m) => m.id === id))
              props.onChange({ ...p, models: [...p.models, { id }] })
            setAdding('')
          }}
        >
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="+ model id"
            aria-label={`Add a model to ${p.name}`}
            className="h-6 w-32 rounded-full border border-dashed border-line-strong bg-transparent px-2.5 font-mono text-[11.5px] outline-none focus:border-accent"
          />
        </form>
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
                    workers: c.workers,
                    leadModel: c.leadModel,
                    workerModel: c.workerModel,
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
        className="w-24 text-right tabular-nums"
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
    hint: 'Search the internet and read pages through omp.',
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
]

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
    </>
  )
}

function VerificationSection(props: {
  settings: ServerSettings
  update(p: (s: ServerSettings) => ServerSettings): void
}) {
  const v = props.settings.verification
  return (
    <>
      <Heading title="Verification">
        An independent judge model scores the final result. A round only completes when it passes. Choose the
        judge model under Team &amp; budget.
      </Heading>
      <Card>
        <Row>
          <Field label="Pass threshold" hint="Judge score from 0 to 1 needed to complete a round." inline>
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
              />
              <span className="w-10 text-right font-mono text-[13px] tabular-nums">
                {v.threshold.toFixed(2)}
              </span>
            </div>
          </Field>
        </Row>
        <Row>
          <Field label="Custom rubric" hint="Optional. Replaces the default rubric the judge scores against.">
            <TextArea
              value={v.rubric ?? ''}
              onChange={(e) =>
                props.update((s) => ({ ...s, verification: { ...s.verification, rubric: e.target.value } }))
              }
              placeholder="e.g. Code must include tests that pass; reports must cite a primary source for every number."
              rows={5}
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
          <Field label="omp CLI" hint="Used for logins, web search, and your model list." inline>
            {data ? data.omp ? <Pill tone="ok">found</Pill> : <Pill tone="warn">not found</Pill> : null}
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
        <Bot className="size-3.5" /> Built on pi-ai, pi-agent-core, and Cordis.
      </div>
    </>
  )
}
