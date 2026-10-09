import { DEFAULT_PRESET, type PermissionPreset, type SetupStep } from '@myrmidon/protocol'
import { ChevronRight, Folder, LoaderCircle, RefreshCw } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { api, type ModelOption, type Project, post, send, type TeamConfig } from '../api.ts'
import { formatSize } from '../chat/Attachments.tsx'
import { FolderPicker } from '../chat/FolderPicker.tsx'
import { helperMode, helpersHint, withHelperMode } from '../chat/helpers.ts'
import { ModelPicker } from '../chat/ModelPicker.tsx'
import { canLead } from '../chat/model-list.ts'
import { PermissionChoices } from '../chat/ProjectPermissions.tsx'
import { HelpersEditor, Row } from '../chat/TeamControls.tsx'
import { copy } from '../copy.ts'
import {
  ChannelsSection,
  type ChannelView,
  EngineTrouble,
  MascotSection,
  NumberField,
  Providers,
  ThemePicker,
  type useSettingsData,
  type VoiceStatusView,
  withDefaultCrew,
} from '../Settings.tsx'
import { desktop } from '../ui/desktop.ts'
import { DOCK_BADGE_KEY, NOTIFY_KEY, type ThemeChoice, usePersistentFlag } from '../ui/hooks.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { type TestNotice, testNotification } from '../ui/notify-test.ts'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardRow,
  cn,
  Dot,
  Field,
  SectionHeader,
  Segmented,
  Switch,
} from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'
import {
  AGENT_MIN_WINDOW,
  MIC_TEST,
  SETUP_MODEL_WAIT,
  VOICE_POLL_MS,
  VOICE_RUNTIME_BYTES,
} from '../ui-config.ts'
import { CHOREOGRAPHY, SETUP_EMOTIONS } from './choreography.ts'
import { useSetupMascot } from './SetupMascot.tsx'
import {
  alertsAllowed,
  type SetupScreen,
  type SetupView,
  STATUS_DOT,
  type Starter,
  type StepStatus,
  starters,
  stepStatus,
} from './state.ts'

/** Everything a step can read and do: the assistant's state, the settings it edits, and its way forward. */
export interface SetupContext {
  view: SetupView
  settings: ReturnType<typeof useSettingsData>
  models: ModelOption[]
  onModelsChanged(): void
  config?: TeamConfig
  onConfig(c: TeamConfig): void
  theme: ThemeChoice
  onTheme(t: ThemeChoice): void
  /**
   * The folder chosen on the project step, or else the first project added before, for the starter prompts. Whether it
   * is a git repository is known only for one chosen here.
   */
  project?: { project: Project; isGit?: boolean }
  setProject(chosen: { project: Project; isGit: boolean }): void
  onProjects(all: Project[]): void
  /** One step opened on its own: Back, done and Set up later go back where it was opened from. */
  single: boolean
  go(screen: SetupScreen): void
  back(): void
  /** Marks the step done and moves on (or, opened on its own, goes back). */
  done(step: SetupStep): void
  /** Marks the step set up later and moves on (or, opened on its own, goes back). */
  later(step: SetupStep): void
  /** Asks again what exists, after something was set up. */
  refresh(): void
  /** Ends setup; with a starter, the first chat starts with it. */
  finish(starter?: Starter): void
}

const Ctx = createContext<SetupContext | undefined>(undefined)
export const SetupProvider = Ctx.Provider
function useSetup(): SetupContext {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('a setup step outside the setup assistant')
  return ctx
}

const t = copy.setup

/** The first of a name, short enough for the mascot's screen. */
const firstName = (name: string) => name.trim().split(/\s+/)[0]?.slice(0, 8) ?? ''

/**
 * One screen of the assistant: its heading (focused as it opens, so a screen reader starts there), what it is for,
 * its content, and the way on: Back, Set up later, Continue.
 */
function StepFrame(props: {
  screen: SetupScreen
  title: string
  intro?: ReactNode
  children?: ReactNode
  /** No Set up later on Welcome and Ready. */
  later?: SetupStep
  next?: { label?: string; disabled?: boolean; hint?: string; onClick(): void }
  /** Welcome has nothing to go back to. */
  noBack?: boolean
}) {
  const ctx = useSetup()
  const mascot = useSetupMascot()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])
  const centered = CHOREOGRAPHY[props.screen].place === 'center'
  const later = props.later
  return (
    <div className={cn('flex max-w-2xl flex-col gap-6', centered && 'mx-auto items-stretch text-center')}>
      <div>
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-page-title font-semibold tracking-tight text-fg outline-none"
        >
          {props.title}
        </h1>
        {props.intro && <p className="mt-1.5 text-reading leading-relaxed text-muted">{props.intro}</p>}
      </div>
      {props.children && (
        <div className={cn('flex flex-col gap-6', centered && 'text-left')}>{props.children}</div>
      )}
      <div className={cn('flex flex-wrap items-center gap-2 pt-2', centered && 'justify-center')}>
        {!props.noBack && (
          <Button variant="borderless" onClick={ctx.back}>
            {t.back}
          </Button>
        )}
        {!centered && <span className="flex-1" />}
        {later && (
          <Button
            variant="borderless"
            onClick={() => {
              mascot.react('shrug')
              ctx.later(later)
            }}
          >
            {t.later}
          </Button>
        )}
        {props.next && (
          <Button
            variant="primary"
            disabled={props.next.disabled}
            title={props.next.disabled ? props.next.hint : undefined}
            onClick={props.next.onClick}
          >
            {ctx.single ? t.single.done : (props.next.label ?? t.continue)}
          </Button>
        )}
      </div>
      {props.next?.disabled && props.next.hint && (
        <p className={cn('-mt-4 text-small text-muted', centered ? 'text-center' : 'text-right')}>
          {props.next.hint}
        </p>
      )}
    </div>
  )
}

/** While the settings the step edits load, or why they did not. */
function SettingsPending() {
  const { settings } = useSetup()
  if (settings.error) return <Banner tone="bad">{settings.error}</Banner>
  return (
    <p className="flex items-center gap-2 text-body text-muted">
      <LoaderCircle className="size-4 animate-spin" /> {t.loading}
    </p>
  )
}

/* ------------------------------------------------------------------ 1 welcome */

export function WelcomeStep() {
  const ctx = useSetup()
  return (
    <StepFrame
      screen="welcome"
      title={t.welcome.title}
      intro={t.welcome.intro}
      noBack
      next={{ label: t.welcome.start, onClick: () => ctx.done('welcome') }}
    >
      <Card>
        <CardRow>
          <p className="text-body font-medium text-fg">{t.welcome.localTitle}</p>
          <p className="mt-0.5 text-callout leading-snug text-muted">{t.welcome.local}</p>
        </CardRow>
        <CardRow>
          <Field label={t.welcome.theme} inline>
            <ThemePicker theme={ctx.theme} onTheme={ctx.onTheme} />
          </Field>
        </CardRow>
      </Card>
    </StepFrame>
  )
}

/* ------------------------------------------------------------------ 2 you & mascot */

export function YouStep() {
  const ctx = useSetup()
  const mascot = useSetupMascot()
  const data = ctx.settings.data
  const name = data?.settings.profile?.name?.trim() || data?.account || ''
  useEffect(() => {
    mascot.screen(name ? copy.setup.screen.hello(firstName(name)) : copy.setup.screen.hi)
  }, [mascot, name])
  // Each new look it is given gets a reaction: love for a colour, a wink for the rest.
  const look = data?.settings.mascot
  const before = useRef(look)
  useEffect(() => {
    const was = before.current
    before.current = look
    if (!was || !look) return
    if (was.color !== look.color) mascot.react('love')
    else if (was.eyes !== look.eyes || was.look !== look.look || was.screen !== look.screen)
      mascot.react('wink')
  }, [look, mascot])
  return (
    <StepFrame
      screen="you"
      title={t.you.title}
      intro={t.you.intro}
      later="you"
      next={{ onClick: () => ctx.done('you') }}
    >
      {data ? <MascotSection data={data} update={ctx.settings.update} embedded /> : <SettingsPending />}
    </StepFrame>
  )
}

/* ------------------------------------------------------------------ 3 connect models */

interface Detection {
  ready: { id: string; models: number }[]
  env: { provider: string; variable: string; ready: boolean }[]
  local: { id: string; baseUrl: string; provider: string; models: string[]; added: boolean }[]
}

type TestState = 'idle' | 'running' | { ok: true; ms: number; reply?: string } | { ok: false; error: string }

/** A model's answer or error as the mascot's speech line says it: one short line. */
const speech = (text: string) => (text.length > 120 ? `${text.slice(0, 117)}…` : text)

export function ModelsStep() {
  const ctx = useSetup()
  const mascot = useSetupMascot()
  const toast = useToast()
  const [found, setFound] = useState<Detection>()
  const [lookError, setLookError] = useState<string>()
  const [adding, setAdding] = useState<string>()
  const [waitingFor, setWaitingFor] = useState<string>()
  const [test, setTest] = useState<TestState>('idle')
  const leaders = ctx.models.filter(canLead)
  const [ref, setRef] = useState<string>()
  const chosen = ref ?? leaders.find((m) => m.ref === ctx.config?.leadModel)?.ref ?? leaders[0]?.ref
  const nothingFound = !!found && found.ready.length === 0 && found.local.length === 0
  const [more, setMore] = useState(false)

  const look = () => {
    setLookError(undefined)
    api<Detection>('/api/setup/detect')
      .then(setFound)
      .catch((err: Error) => setLookError(err.message))
  }
  // Looks once, as the step opens.
  useEffect(look, [])

  const run = async (model: string) => {
    setRef(model)
    setTest('running')
    mascot.say(undefined)
    mascot.hold(SETUP_EMOTIONS.thinking)
    mascot.screen(copy.setup.screen.thinking)
    try {
      const r = await send<{ ok: boolean; ms?: number; reply?: string; error?: string }>(
        'POST',
        '/api/models/test',
        {
          ref: model,
        },
      )
      mascot.hold(undefined)
      mascot.screen(undefined)
      if (!r.ok) throw new Error(r.error ?? t.models.failed)
      setTest({ ok: true, ms: r.ms ?? 0, ...(r.reply ? { reply: r.reply } : {}) })
      mascot.react('hop')
      mascot.say(speech(r.reply ?? t.models.answeredSilently))
      ctx.refresh()
    } catch (err) {
      mascot.hold(undefined)
      mascot.screen(undefined)
      const error = (err as Error).message
      setTest({ ok: false, error })
      mascot.react('worried')
      mascot.say(speech(error))
    }
  }

  // A provider just added: test its first model that can lead once the model list has it. The list is asked again
  // a few times while the provider finds its models; one that has none that can lead says so.
  const asked = useRef(0)
  useEffect(() => {
    if (!waitingFor) return
    const first = ctx.models.find((m) => m.provider === waitingFor && canLead(m))
    if (first) {
      setWaitingFor(undefined)
      void run(first.ref)
      return
    }
    if (asked.current >= SETUP_MODEL_WAIT.tries) {
      setWaitingFor(undefined)
      setTest({ ok: false, error: t.models.noModels(waitingFor) })
      return
    }
    const timer = setTimeout(() => {
      asked.current += 1
      ctx.onModelsChanged()
    }, SETUP_MODEL_WAIT.everyMs)
    return () => clearTimeout(timer)
  })

  const pickProvider = (provider: string) => {
    const first = leaders.find((m) => m.provider === provider)
    if (first) return void run(first.ref)
    asked.current = 0
    setWaitingFor(provider)
    ctx.onModelsChanged()
  }
  /** A provider whose models are all too small to lead a crew (an on-device model) is shown, but not offered. */
  const canUse = (provider: string) =>
    leaders.some((m) => m.provider === provider) || !ctx.models.some((m) => m.provider === provider)

  const pickLocal = async (server: Detection['local'][number]) => {
    if (server.added) return pickProvider(server.provider)
    setAdding(server.id)
    try {
      const r = await send<{ providers: never[] }>('POST', '/api/providers', {
        name: server.provider,
        api: 'openai-completions',
        baseUrl: server.baseUrl,
        keyless: true,
        models: [],
      })
      ctx.settings.providersChanged(r.providers)
      setFound((f) =>
        f ? { ...f, local: f.local.map((l) => (l.id === server.id ? { ...l, added: true } : l)) } : f,
      )
      asked.current = 0
      setWaitingFor(server.provider)
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setAdding(undefined)
    }
  }

  const answered = typeof test === 'object' && test.ok ? test : undefined
  const failed = typeof test === 'object' && !test.ok ? test : undefined
  // The model that answered leads every new chat once the person continues, and reviews too while nothing does; the
  // step says so under the answer rather than changing the crew behind a test.
  const adopting =
    answered && chosen && ctx.config && (ctx.config.leadModel !== chosen || !ctx.config.judgeModel)
      ? { config: ctx.config, model: chosen, reviewerToo: !ctx.config.judgeModel }
      : undefined
  const proceed = () => {
    if (adopting) {
      const next = {
        ...adopting.config,
        leadModel: adopting.model,
        judgeModel: adopting.config.judgeModel || adopting.model,
      }
      ctx.onConfig(next)
      ctx.settings.update((s) => withDefaultCrew(s, next), true)
    }
    ctx.done('models')
  }
  const localName = (id: string) => t.models.local[id] ?? id
  const inUse = (provider: string) => !!answered && !!chosen && chosen.startsWith(`${provider}/`)

  return (
    <StepFrame
      screen="models"
      title={t.models.title}
      intro={t.models.intro}
      later="models"
      next={{ disabled: !answered, hint: t.models.gate, onClick: proceed }}
    >
      <section aria-labelledby="setup-found">
        <SectionHeader as="h2" className="mb-2" title={<span id="setup-found">{t.models.found}</span>} />
        <Card>
          {!found && !lookError && (
            <CardRow>
              <p className="flex items-center gap-2 text-body text-muted">
                <LoaderCircle className="size-4 animate-spin" /> {t.models.looking}
              </p>
            </CardRow>
          )}
          {lookError && (
            <CardRow>
              <div className="flex items-center gap-3">
                <p className="min-w-0 flex-1 text-body text-bad-ink">{t.models.lookFailed(lookError)}</p>
                <Button size="sm" icon={<RefreshCw className="size-3" />} onClick={look}>
                  {t.tryAgain}
                </Button>
              </div>
            </CardRow>
          )}
          {nothingFound && (
            <CardRow>
              <p className="text-body text-muted">{t.models.none}</p>
            </CardRow>
          )}
          {found?.ready.map((p) => {
            const env = found.env.find((e) => e.provider === p.id)
            return (
              <CardRow key={p.id}>
                <div className="flex items-center gap-3">
                  <Dot status="ready" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-body">{p.id}</span>
                      <Badge tone="ok">{t.models.ready}</Badge>
                    </div>
                    <p className="text-small text-muted">
                      {canUse(p.id) ? t.models.models(p.models) : t.models.tooSmall}
                      {env && ` · ${t.models.envKey(env.variable)}`}
                    </p>
                  </div>
                  {canUse(p.id) && (
                    <Button
                      size="sm"
                      variant={inUse(p.id) ? 'borderless' : 'push'}
                      disabled={test === 'running' || !!waitingFor}
                      aria-label={t.models.pickLabel(p.id)}
                      onClick={() => pickProvider(p.id)}
                    >
                      {inUse(p.id) ? t.models.inUse : t.models.use}
                    </Button>
                  )}
                </div>
              </CardRow>
            )
          })}
          {found?.env
            .filter((e) => !e.ready)
            .map((e) => (
              <CardRow key={e.variable}>
                <div className="flex items-center gap-3">
                  <Dot status="idle" />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-body">{t.models.envKey(e.variable)}</p>
                    <p className="text-small text-muted">{t.models.envKeyHint}</p>
                  </div>
                </div>
              </CardRow>
            ))}
          {found?.local.map((l) => (
            <CardRow key={l.id}>
              <div className="flex items-center gap-3">
                <Dot status="ready" />
                <div className="min-w-0 flex-1">
                  <p className="text-body font-medium">{t.models.localRunning(localName(l.id))}</p>
                  <p className="truncate text-small text-muted">
                    {l.models.length
                      ? `${t.models.models(l.models.length)} · ${l.models.slice(0, 3).join(', ')}`
                      : t.models.noModels(localName(l.id))}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={inUse(l.provider) ? 'borderless' : 'push'}
                  loading={adding === l.id || waitingFor === l.provider}
                  disabled={test === 'running' || l.models.length === 0}
                  aria-label={t.models.pickLabel(localName(l.id))}
                  onClick={() => void pickLocal(l)}
                >
                  {adding === l.id
                    ? t.models.adding(localName(l.id))
                    : inUse(l.provider)
                      ? t.models.inUse
                      : t.models.use}
                </Button>
              </div>
            </CardRow>
          ))}
        </Card>
      </section>

      <section>
        <button
          type="button"
          aria-expanded={more || nothingFound}
          onClick={() => setMore(!(more || nothingFound))}
          className="flex items-center gap-1.5 text-body font-semibold text-fg"
        >
          <ChevronRight
            className={cn('size-4 text-muted transition-transform', (more || nothingFound) && 'rotate-90')}
          />
          {t.models.more}
        </button>
        <AnimatePresence initial={false}>
          {(more || nothingFound) && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto', transitionEnd: { overflow: 'visible' } }}
              exit={{ opacity: 0, height: 0, overflow: 'hidden' }}
              className="overflow-hidden"
            >
              <div className="pt-4">
                {ctx.settings.data ? (
                  <Providers
                    data={ctx.settings.data}
                    onProviders={ctx.settings.providersChanged}
                    update={ctx.settings.update}
                    embedded
                  />
                ) : (
                  <SettingsPending />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      <section aria-labelledby="setup-test">
        <SectionHeader as="h2" className="mb-2" title={<span id="setup-test">{t.models.testTitle}</span>} />
        <Card>
          <CardRow>
            {chosen ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 text-callout text-muted">{t.models.testHint}</p>
                <ModelPicker
                  variant="compact"
                  placement="up"
                  label={t.models.testModel}
                  value={chosen}
                  models={ctx.models}
                  minWindow={AGENT_MIN_WINDOW}
                  onChange={(m) => {
                    setRef(m)
                    setTest('idle')
                  }}
                />
                <Button variant="primary" loading={test === 'running'} onClick={() => void run(chosen)}>
                  {test === 'running' ? t.models.testing : t.models.test}
                </Button>
              </div>
            ) : (
              <p className="text-callout text-muted">{t.models.noModel}</p>
            )}
          </CardRow>
          <div aria-live="polite">
            {answered && (
              <CardRow>
                <p className="text-body text-ok-ink">
                  {t.models.answered((answered.ms / 1000).toFixed(1), answered.reply)}
                </p>
                {adopting && (
                  <p className="mt-1 text-callout text-muted">
                    {t.models.leadNote(
                      ctx.single ? t.single.done : t.continue,
                      ctx.models.find((m) => m.ref === adopting.model)?.name ?? adopting.model,
                      adopting.reviewerToo,
                    )}
                  </p>
                )}
              </CardRow>
            )}
          </div>
        </Card>
        {failed && (
          <Banner tone="bad" role="alert" className="mt-3">
            <p className="font-medium">{t.models.failed}</p>
            <p className="mt-0.5 break-words">{failed.error}</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                icon={<RefreshCw className="size-3" />}
                onClick={() => chosen && void run(chosen)}
              >
                {t.tryAgain}
              </Button>
              <Button
                size="sm"
                variant="borderless"
                onClick={() => {
                  mascot.react('shrug')
                  ctx.later('models')
                }}
              >
                {t.later}
              </Button>
            </div>
          </Banner>
        )}
      </section>
    </StepFrame>
  )
}

/* ------------------------------------------------------------------ 4 your crew */

const GROUP = 'divide-y divide-line overflow-visible rounded-base border border-line bg-surface'

const HELPER_MODES = [
  { value: 'never', label: copy.teamControls.helperModes.never.title },
  { value: 'auto', label: copy.teamControls.helperModes.auto.title },
  { value: 'always', label: copy.teamControls.helperModes.always.title },
] as const

export function CrewStep() {
  const ctx = useSetup()
  const mascot = useSetupMascot()
  const config = ctx.config
  const names =
    config && helperMode(config) !== 'never' ? config.roster.map((r) => r.specialist ?? r.role) : []
  const key = names.join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the names
  useEffect(() => {
    mascot.crew(names)
  }, [key, mascot])
  // Leaving the step sends the crew's cursors away.
  useEffect(() => () => mascot.crew([]), [mascot])
  const set = (c: TeamConfig) => {
    ctx.onConfig(c)
    ctx.settings.update((s) => withDefaultCrew(s, c))
  }
  const data = ctx.settings.data
  const reviewer = data?.settings.verification.reviewer ?? 'auto'
  return (
    <StepFrame
      screen="crew"
      title={t.crew.title}
      intro={t.crew.intro}
      later="crew"
      next={{ onClick: () => ctx.done('crew') }}
    >
      {config && ctx.models.some(canLead) ? (
        <>
          <div className={GROUP}>
            {config.mode !== 'swarm' && (
              <Row label={copy.composer.lead} hint={copy.composer.leadHint}>
                <ModelPicker
                  variant="compact"
                  placement="down"
                  label={copy.composer.lead}
                  value={config.leadModel}
                  models={ctx.models}
                  onChange={(leadModel) => set({ ...config, leadModel })}
                />
              </Row>
            )}
            <Row label={copy.composer.helpers} hint={helpersHint(config)}>
              <Segmented
                id="setup-crewmates"
                value={helperMode(config)}
                options={[...HELPER_MODES]}
                onChange={(mode) => set(withHelperMode(config, mode, ctx.models))}
              />
            </Row>
          </div>
          {helperMode(config) !== 'never' && (
            <div className={GROUP}>
              <HelpersEditor models={ctx.models} config={config} onConfig={set} placement="down" />
            </div>
          )}
        </>
      ) : (
        <p className="text-body text-muted">{t.crew.waiting}</p>
      )}
      <p className="text-callout leading-snug text-muted">{t.crew.cost}</p>
      {data ? (
        <Card>
          <CardRow>
            <Field label={t.crew.spend} hint={t.crew.spendHint} inline>
              <NumberField
                label={t.crew.spend}
                value={data.settings.team.costUsd}
                min={0}
                max={1000}
                step={0.5}
                suffix={copy.settings.team.units.dollars}
                onChange={(v) => ctx.settings.update((s) => ({ ...s, team: { ...s.team, costUsd: v } }))}
              />
            </Field>
          </CardRow>
          <CardRow>
            <Field label={t.crew.reviewer} hint={t.crew.reviewerHint} inline>
              <Switch
                checked={reviewer !== 'off'}
                label={t.crew.reviewer}
                onChange={(on) =>
                  ctx.settings.update(
                    (s) => ({ ...s, verification: { ...s.verification, reviewer: on ? 'auto' : 'off' } }),
                    true,
                  )
                }
              />
            </Field>
          </CardRow>
        </Card>
      ) : (
        <SettingsPending />
      )}
    </StepFrame>
  )
}

/* ------------------------------------------------------------------ 5 your first project */

export function ProjectStep() {
  const ctx = useSetup()
  const mascot = useSetupMascot()
  const [picking, setPicking] = useState(false)
  const chosen = ctx.project
  // Set once the person picks a preset here; until then the folder's own, which may load after the step opens.
  // Wrapped, since picking no preset (follow the global one) is a choice too.
  const [picked, setPicked] = useState<{ preset?: PermissionPreset }>()
  const preset = picked ? picked.preset : chosen?.project.permissions?.preset
  const [saveError, setSaveError] = useState<string>()
  const data = ctx.settings.data

  useEffect(() => {
    if (chosen) mascot.screen(chosen.project.name.toUpperCase())
  }, [chosen, mascot])

  const apply = async (project: Project, next: PermissionPreset | undefined) => {
    setPicked(next ? { preset: next } : {})
    setSaveError(undefined)
    mascot.react(next === 'ask' ? 'nod' : next === 'read-only' ? 'curious' : 'ping')
    try {
      // Only the preset changes: the project's rules and readable folders stay as they are.
      const r = await send<{ projects: Project[] }>('PUT', `/api/projects/${project.id}/permissions`, {
        rules: project.permissions?.rules ?? [],
        ...(project.permissions?.access ? { access: project.permissions.access } : {}),
        preset: next ?? null,
      })
      ctx.onProjects(r.projects)
    } catch (err) {
      setSaveError((err as Error).message)
    }
  }

  return (
    <StepFrame
      screen="project"
      title={t.project.title}
      intro={t.project.intro}
      later="project"
      next={{ disabled: !chosen, onClick: () => ctx.done('project') }}
    >
      <Card>
        <CardRow>
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-fill text-muted">
              <Folder className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              {chosen ? (
                <>
                  <p className="truncate text-body font-medium">{chosen.project.name}</p>
                  <p className="truncate font-mono text-small text-muted" title={chosen.project.path}>
                    {chosen.project.path}
                  </p>
                </>
              ) : (
                <p className="text-body text-muted">{t.project.none}</p>
              )}
            </div>
            <Button variant={chosen ? 'push' : 'primary'} onClick={() => setPicking(true)}>
              {chosen ? t.project.change : t.project.choose}
            </Button>
          </div>
        </CardRow>
        {chosen && (
          <CardRow>
            {chosen.isGit !== undefined && (
              <p className="mb-3 text-callout text-fg-2">{chosen.isGit ? t.project.git : t.project.notGit}</p>
            )}
            <p className="mb-2 text-body font-medium">{t.project.permissions}</p>
            <PermissionChoices
              value={preset}
              global={data?.settings.permissions.preset ?? DEFAULT_PRESET}
              onChange={(next) => void apply(chosen.project, next)}
            />
          </CardRow>
        )}
      </Card>
      {saveError && chosen && (
        <Banner tone="bad" role="alert">
          <p>{t.project.saveFailed(saveError)}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => void apply(chosen.project, preset)}>
              {t.tryAgain}
            </Button>
            <Button size="sm" variant="borderless" onClick={() => ctx.later('project')}>
              {t.later}
            </Button>
          </div>
        </Banner>
      )}
      <AnimatePresence>
        {picking && (
          <FolderPicker
            key="folders"
            onClose={() => setPicking(false)}
            onAdded={(project, all, isGit) => {
              setPicking(false)
              ctx.onProjects(all)
              ctx.setProject({ project, isGit })
              ctx.refresh()
              // The folder's permissions start from what it is: a git repository asks first, any other is read-only.
              void apply(project, isGit ? 'ask' : 'read-only')
            }}
          />
        )}
      </AnimatePresence>
    </StepFrame>
  )
}

/* ------------------------------------------------------------------ 6 voice calls */

type VoiceChoice = 'off' | 'local' | 'cloud'

const isLocalBusy = (s?: VoiceStatusView) =>
  !!s &&
  (s.stt.phonon.state === 'installing' ||
    s.stt.phonon.state === 'starting' ||
    s.tts.kitten.state === 'downloading')

/** The microphone test: asks for it once, then its level, which the mascot's eyes pulse with. */
function MicTest(props: { onDenied(): void }) {
  const mascot = useSetupMascot()
  const [state, setState] = useState<'idle' | 'asking' | 'on' | 'unavailable'>('idle')
  const [error, setError] = useState<string>()
  const [level, setLevel] = useState(0)
  const stop = useRef<() => void>(undefined)
  // The browser's prompt can still be open as the step closes: a microphone granted after that is let go at once.
  const open = useRef(true)
  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
      stop.current?.()
    }
  }, [])

  const start = async () => {
    setError(undefined)
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return setState('unavailable')
    setState('asking')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!open.current) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      const audio = new AudioContext()
      const analyser = audio.createAnalyser()
      analyser.fftSize = MIC_TEST.fftSize
      audio.createMediaStreamSource(stream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      let frame = 0
      const tick = () => {
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const v of samples) sum += ((v - 128) / 128) ** 2
        const next = Math.min(1, Math.sqrt(sum / samples.length) * MIC_TEST.gain)
        mascot.level(next)
        setLevel(next)
        frame = requestAnimationFrame(tick)
      }
      tick()
      stop.current = () => {
        cancelAnimationFrame(frame)
        for (const track of stream.getTracks()) track.stop()
        void audio.close()
        mascot.level(0)
        stop.current = undefined
      }
      setState('on')
    } catch (err) {
      if (!open.current) return
      setState('idle')
      const name = (err as Error).name
      if (name === 'NotAllowedError' || name === 'SecurityError') props.onDenied()
      else setError((err as Error).message)
    }
  }

  return (
    <CardRow>
      <p className="text-body font-medium">{t.voice.micTitle}</p>
      <p className="mt-0.5 text-callout text-muted">
        {state === 'on' ? t.voice.micListening : t.voice.micWhy}
      </p>
      {state === 'unavailable' && <p className="mt-2 text-callout text-warn-ink">{t.voice.micUnavailable}</p>}
      {error && <p className="mt-2 text-callout text-bad-ink">{error}</p>}
      <div className="mt-3 flex items-center gap-3">
        {state === 'on' ? (
          <>
            <meter
              className="sr-only"
              aria-label={t.voice.micLevel}
              min={0}
              max={100}
              value={Math.round(level * 100)}
            />
            <div aria-hidden className="h-2 flex-1 overflow-hidden rounded-full bg-fill-strong">
              <div className="h-full rounded-full bg-ok" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
            <Button
              size="sm"
              onClick={() => {
                stop.current?.()
                setState('idle')
              }}
            >
              {t.voice.micStop}
            </Button>
          </>
        ) : (
          <Button loading={state === 'asking'} onClick={() => void start()}>
            {t.voice.micAllow}
          </Button>
        )}
      </div>
    </CardRow>
  )
}

export function VoiceStep() {
  const ctx = useSetup()
  const mascot = useSetupMascot()
  const toast = useToast()
  const [status, setStatus] = useState<VoiceStatusView>()
  const [error, setError] = useState<string>()
  const [looks, setLooks] = useState(0)
  const voice = ctx.settings.data?.settings.voice
  const choice: VoiceChoice = !voice?.enabled
    ? 'off'
    : voice.stt.provider === 'phonon' || voice.tts.provider === 'kitten'
      ? 'local'
      : 'cloud'

  const load = () =>
    api<VoiceStatusView>('/api/voice')
      .then((s) => {
        setStatus(s)
        setError(undefined)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLooks((n) => n + 1))
  // biome-ignore lint/correctness/useExhaustiveDependencies: once as the step opens
  useEffect(() => {
    void load()
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: each finished look schedules the next while one is due
  useEffect(() => {
    if (!isLocalBusy(status)) return
    const timer = setTimeout(() => void load(), VOICE_POLL_MS)
    return () => clearTimeout(timer)
  }, [looks])

  const kitten = status?.tts.kitten
  const phonon = status?.stt.phonon
  const pct =
    kitten?.state === 'downloading' && kitten.size
      ? Math.round(((kitten.received ?? 0) / kitten.size) * 100)
      : undefined
  useEffect(() => {
    mascot.screen(pct !== undefined ? copy.setup.screen.percent(pct) : undefined)
  }, [mascot, pct])

  const sizes = status?.sizes
  const localSize = sizes
    ? formatSize(
        VOICE_RUNTIME_BYTES +
          sizes.phonon +
          sizes.kitten[voice?.tts.kittenModel ?? 'nano'] +
          sizes.vad +
          sizes.turn,
      )
    : ''

  /** Installs what is not there yet, in the background; the step shows the progress. */
  const getLocal = async () => {
    setError(undefined)
    try {
      if (phonon?.state === 'missing' || phonon?.state === 'error')
        await post('/api/voice/phonon/install', {})
      if (kitten?.state === 'missing' || kitten?.state === 'error')
        await post('/api/voice/kitten/download', { model: voice?.tts.kittenModel ?? 'nano' })
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const choose = async (next: VoiceChoice) => {
    const saved = await ctx.settings.saveNow((s) => ({
      ...s,
      voice: {
        ...s.voice,
        enabled: next !== 'off',
        ...(next === 'local'
          ? { stt: { ...s.voice.stt, provider: 'phonon' }, tts: { ...s.voice.tts, provider: 'kitten' } }
          : next === 'cloud'
            ? { stt: { ...s.voice.stt, provider: 'omp' }, tts: { ...s.voice.tts, provider: 'omp' } }
            : {}),
      },
    }))
    if (!saved) return
    ctx.refresh()
    if (next === 'local') await getLocal()
    else await load()
    if (next !== 'off') mascot.react('wink')
  }

  const trouble =
    choice === 'local'
      ? phonon?.state === 'error'
        ? { engine: 'phonon' as const, raw: phonon.error ?? '' }
        : kitten?.state === 'error'
          ? { engine: 'kitten' as const, raw: kitten.error ?? '' }
          : undefined
      : undefined
  const busy = isLocalBusy(status)
  const ready =
    choice === 'local' &&
    !!phonon &&
    !!kitten &&
    ['ready', 'running'].includes(phonon.state) &&
    ['ready', 'running'].includes(kitten.state)

  return (
    <StepFrame
      screen="voice"
      title={t.voice.title}
      intro={t.voice.intro}
      later="voice"
      next={{ onClick: () => ctx.done('voice') }}
    >
      {voice ? (
        <Card>
          <CardRow>
            <Field
              label={t.voice.choice}
              hint={
                choice === 'off'
                  ? t.voice.offHint
                  : choice === 'local'
                    ? t.voice.localHint(localSize)
                    : t.voice.cloudHint([...(status?.stt.omp ?? []), ...(status?.tts.omp ?? [])].join(', '))
              }
            >
              <Segmented
                id="setup-voice"
                value={choice}
                options={[
                  { value: 'off', label: t.voice.off },
                  { value: 'local', label: localSize ? `${t.voice.local} · ${localSize}` : t.voice.local },
                  { value: 'cloud', label: t.voice.cloud },
                ]}
                onChange={(next) => void choose(next)}
              />
            </Field>
          </CardRow>
          {choice === 'local' && (busy || ready) && (
            <CardRow>
              <div aria-live="polite" className="flex flex-col gap-2">
                <p className="text-body text-fg-2">
                  {ready ? t.voice.ready : pct !== undefined ? t.voice.progress(pct) : t.voice.installing}
                </p>
                {busy && (
                  <div
                    role="progressbar"
                    aria-label={t.voice.installing}
                    {...(pct !== undefined
                      ? { 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }
                      : {})}
                    className="h-1.5 overflow-hidden rounded-full bg-fill-strong"
                  >
                    <div
                      className={cn(
                        'h-full rounded-full bg-accent',
                        pct === undefined && 'w-1/3 animate-pulse',
                      )}
                      style={pct !== undefined ? { width: `${pct}%` } : undefined}
                    />
                  </div>
                )}
              </div>
            </CardRow>
          )}
          {choice !== 'off' && (
            <MicTest
              onDenied={() => {
                toast(desktop() ? t.voice.micDenied.desktop : t.voice.micDenied.browser, 'info')
                mascot.react('shrug')
                ctx.later('voice')
              }}
            />
          )}
        </Card>
      ) : (
        <SettingsPending />
      )}
      {(trouble || error) && (
        <Banner tone="bad" role="alert">
          <p className="font-medium">{t.voice.failed}</p>
          {trouble ? <EngineTrouble engine={trouble.engine} raw={trouble.raw} /> : <p>{error}</p>}
          <div className="mt-2 flex gap-2">
            <Button size="sm" icon={<RefreshCw className="size-3" />} onClick={() => void getLocal()}>
              {t.tryAgain}
            </Button>
            <Button size="sm" variant="borderless" onClick={() => ctx.later('voice')}>
              {t.later}
            </Button>
          </div>
        </Banner>
      )}
    </StepFrame>
  )
}

/* ------------------------------------------------------------------ 7 messaging apps */

export function ChannelsStep() {
  const ctx = useSetup()
  const mascot = useSetupMascot()
  const toast = useToast()
  const on = useRef<Set<string>>(undefined)
  const seen = (channels: readonly ChannelView[]) => {
    const now = new Set(channels.filter((c) => c.enabled && c.status.state === 'on').map((c) => c.id))
    const before = on.current
    on.current = now
    if (!before) return
    for (const c of channels)
      if (now.has(c.id) && !before.has(c.id)) {
        mascot.react('ping')
        mascot.screen(copy.setup.screen.ping)
        toast(t.channels.connected(c.label), 'success')
        ctx.refresh()
      }
  }
  return (
    <StepFrame
      screen="channels"
      title={t.channels.title}
      intro={t.channels.intro}
      later="channels"
      next={{ onClick: () => ctx.done('channels') }}
    >
      <div>
        <ChannelsSection embedded onChannels={seen} />
      </div>
    </StepFrame>
  )
}

/* ------------------------------------------------------------------ 8 alerts */

export function AlertsStep() {
  const ctx = useSetup()
  const mascot = useSetupMascot()
  const toast = useToast()
  const shell = desktop()
  const supported = !!shell || typeof Notification !== 'undefined'
  const [notify, setNotify] = usePersistentFlag(NOTIFY_KEY, false)
  const [badge, setBadge] = usePersistentFlag(DOCK_BADGE_KEY, true)
  const [result, setResult] = useState<TestNotice>()
  const testing = useRef<AbortController>(undefined)
  useEffect(() => () => testing.current?.abort(), [])

  const denied = () => {
    setNotify(false)
    toast(shell ? t.alerts.denied.desktop : t.alerts.denied.browser, 'info')
    mascot.react('shrug')
    ctx.later('alerts')
  }
  // The mascot sends itself one, and is pleased when it lands; how it went shows under the button.
  const sendTest = async () => {
    testing.current?.abort()
    const asked = new AbortController()
    testing.current = asked
    setResult(undefined)
    const r = await testNotification(copy.brand.name, t.alerts.testBody, {
      signal: asked.signal,
      onWaiting: () => setResult({ state: 'waiting' }),
    })
    if (asked.signal.aborted) return
    setResult(r)
    if (r.state === 'sent') {
      mascot.react('love')
      mascot.screen(copy.setup.screen.ping)
    } else if (r.state !== 'cancelled') mascot.react('shrug')
  }
  const turnOn = async (next: boolean) => {
    if (!next) return setNotify(false)
    if (!shell) {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') return denied()
    }
    setNotify(true)
    ctx.refresh()
    await sendTest()
  }

  return (
    <StepFrame
      screen="alerts"
      title={t.alerts.title}
      intro={t.alerts.intro}
      later="alerts"
      next={{ onClick: () => ctx.done('alerts') }}
    >
      <Card>
        <CardRow>
          <Field label={t.alerts.notify} hint={supported ? t.alerts.notifyHint : t.alerts.unsupported} inline>
            <Switch
              checked={notify && alertsAllowed()}
              disabled={!supported}
              label={t.alerts.notify}
              onChange={(v) => void turnOn(v)}
            />
          </Field>
        </CardRow>
        {(supported || result) && (
          <CardRow>
            <div className="flex items-center gap-3">
              <p
                role="status"
                data-result={result?.state}
                className={cn(
                  'min-w-0 flex-1 text-callout',
                  result?.state === 'blocked' || result?.state === 'failed' ? 'text-bad-ink' : 'text-muted',
                )}
              >
                {result ? testResultText(result) : ''}
              </p>
              <Button
                size="sm"
                icon={<FEATURE_ICONS.alerts className="size-3.5" />}
                onClick={() => void sendTest()}
              >
                {t.alerts.test}
              </Button>
            </div>
          </CardRow>
        )}
        {shell && (
          <CardRow>
            <Field label={t.alerts.badge} hint={t.alerts.badgeHint} inline>
              <Switch
                checked={badge}
                label={t.alerts.badge}
                onChange={(v) => {
                  setBadge(v)
                  if (!v) void shell.setBadge(0).catch(() => {})
                }}
              />
            </Field>
          </CardRow>
        )}
      </Card>
    </StepFrame>
  )
}

/** What the Alerts step says under its test button about how the test went. */
function testResultText(r: TestNotice): string {
  const said = t.alerts.result
  switch (r.state) {
    case 'sent':
      return r.desktop ? said.sentDesktop : said.sent
    case 'waiting':
      return said.waiting
    case 'blocked':
      return said.blocked
    case 'unsupported':
      return t.alerts.unsupported
    case 'failed':
      return said.failed(r.error)
    case 'cancelled':
      return ''
  }
}

/* ------------------------------------------------------------------ 9 ready */

/** What Ready says beside each step. The open screen is Ready itself, so no step there is current. */
const READY_STATUS: Record<StepStatus, string> = {
  done: t.ready.done,
  later: t.ready.later,
  skipped: t.ready.skipped,
  todo: t.ready.todo,
  current: t.ready.todo,
}

export function ReadyStep(props: { steps: readonly SetupStep[] }) {
  const ctx = useSetup()
  const offers = starters(ctx.project ? { project: ctx.project.project.name } : {})
  return (
    <StepFrame
      screen="ready"
      title={t.ready.title}
      intro={t.ready.intro}
      next={{ label: t.ready.finish, onClick: () => ctx.finish() }}
    >
      <Card>
        {props.steps
          .filter((s) => s !== 'welcome')
          .map((s) => {
            const status = stepStatus(s, ctx.view)
            // Named by what it shows, the step and how it stands, so a spoken "click Voice calls" finds it.
            return (
              <button
                key={s}
                type="button"
                onClick={() => ctx.go(s)}
                aria-label={t.ready.row(t.steps[s], READY_STATUS[status])}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-fill"
              >
                <Dot status={STATUS_DOT[status]} />
                <span className="min-w-0 flex-1 text-body">{t.steps[s]}</span>
                <span className="text-small text-muted">{READY_STATUS[status]}</span>
                <ChevronRight aria-hidden className="size-4 text-muted" />
              </button>
            )
          })}
      </Card>
      {ctx.view.have.models ? (
        <section aria-labelledby="setup-starters">
          <SectionHeader
            as="h2"
            className="mb-2"
            title={<span id="setup-starters">{t.ready.starters}</span>}
          />
          <div className="grid gap-2 sm:grid-cols-3">
            {offers.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => ctx.finish(s)}
                className="flex flex-col gap-1 rounded-xl border border-line bg-surface p-3 text-left shadow-soft transition-colors hover:bg-fill"
              >
                <span className="text-body font-medium text-fg">{s.label}</span>
                <span className="line-clamp-3 text-small text-muted">{s.text}</span>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <Banner tone="warn">
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1">{t.ready.noModel}</span>
            <Button variant="primary" onClick={() => ctx.go('models')}>
              {t.ready.connect}
            </Button>
          </div>
        </Banner>
      )}
    </StepFrame>
  )
}
