import { SETUP_STEPS, type SetupMark, type SetupStep } from '@myrmidon/protocol'
import { LoaderCircle } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotionConfig } from 'motion/react'
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  CONNECTION_CHANGED,
  type ModelOption,
  type Project,
  reachable,
  send,
  type TeamConfig,
} from '../api.ts'
import { copy } from '../copy.ts'
import { DEFAULT_MASCOT, SETTINGS_SAVED } from '../mascot.ts'
import { useSettingsData } from '../Settings.tsx'
import { NOTIFY_KEY, readStored, type ThemeChoice } from '../ui/hooks.ts'
import { Logo } from '../ui/Logo.tsx'
import { Button, cn, Dot } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'
import { screenMotion } from './choreography.ts'
import { MascotStage } from './SetupMascot.tsx'
import {
  nextScreen,
  previousScreen,
  SETUP_PARAM,
  SETUP_RETURN_PARAM,
  SETUP_SCREENS,
  type SetupReturn,
  type SetupScreen,
  type SetupView,
  STATUS_DOT,
  type Starter,
  type StepStatus,
  stepStatus,
} from './state.ts'
import {
  AlertsStep,
  alertsAllowed,
  ChannelsStep,
  CrewStep,
  ModelsStep,
  ProjectStep,
  ReadyStep,
  type SetupContext,
  SetupProvider,
  VoiceStep,
  WelcomeStep,
  YouStep,
} from './steps.tsx'

const t = copy.setup

/** Alerts live in each browser: on here, and allowed, counts as set up. */
const withAlerts = (view: SetupView): SetupView => ({
  ...view,
  have: { ...view.have, alerts: readStored<string>(NOTIFY_KEY, '0') === '1' && alertsAllowed() },
})

/**
 * The first-run setup assistant, in place of the home screen: a list of its steps to jump between, one step per
 * screen, and one mascot that travels between them. Each step can be set up later; finishing (or Finish later) hands
 * the window back to the app, with a starter prompt when one was picked. Opened on one step alone (`returnTo`), it
 * does only that step: done or set up later, it hands the window back instead of walking on.
 */
export function Setup(props: {
  initial: SetupView
  screen: SetupScreen
  theme: ThemeChoice
  onTheme(t: ThemeChoice): void
  models: ModelOption[]
  onModelsChanged(): void
  config?: TeamConfig
  onConfig(c: TeamConfig): void
  /** Whether Myrmidon answers; while it does not, the assistant says it is reconnecting and keeps its place. */
  online: boolean
  onProjects(all: Project[]): void
  /** Set when one step was opened on its own: where the window goes back to once that step is done. */
  returnTo?: SetupReturn
  onClose(result: { starter?: Starter; project?: string }): void
}) {
  const toast = useToast()
  const reduce = !!useReducedMotionConfig()
  const [view, setView] = useState(() => withAlerts(props.initial))
  const [screen, setScreen] = useState(props.screen)
  const settings = useSettingsData(props.onModelsChanged)
  const [project, setProject] = useState<{ project: Project; isGit: boolean }>()
  const [closing, setClosing] = useState(false)
  // Marks made while Myrmidon did not answer, sent again once it does.
  const unsent = useRef(new Map<SetupStep, SetupMark>())
  const single = !!props.returnTo

  // The open screen lives in the address, so a reload comes back to it.
  useEffect(() => {
    const url = new URL(location.href)
    url.searchParams.set(SETUP_PARAM, screen)
    if (props.returnTo) url.searchParams.set(SETUP_RETURN_PARAM, props.returnTo)
    else url.searchParams.delete(SETUP_RETURN_PARAM)
    if (url.href !== location.href) history.replaceState(null, '', url)
  }, [screen, props.returnTo])

  const take = useCallback((r: SetupView) => setView((v) => withAlerts({ ...v, ...r })), [])
  const refresh = useCallback(() => {
    api<SetupView>('/api/setup')
      .then(take)
      .catch(() => {})
  }, [take])
  // biome-ignore lint/correctness/useExhaustiveDependencies: what exists is asked again on every screen
  useEffect(refresh, [screen])
  useEffect(() => {
    window.addEventListener(SETTINGS_SAVED, refresh)
    return () => window.removeEventListener(SETTINGS_SAVED, refresh)
  }, [refresh])

  const sendMark = useCallback(
    (step: SetupStep, mark: SetupMark) =>
      send<SetupView>('PUT', '/api/setup', { step, mark })
        .then((r) => {
          unsent.current.delete(step)
          take(r)
        })
        .catch((err: Error) => {
          unsent.current.set(step, mark)
          if (reachable()) toast(err.message, 'error')
        }),
    [take, toast],
  )
  useEffect(() => {
    const back = () => {
      if (!reachable()) return
      for (const [step, mark] of unsent.current) void sendMark(step, mark)
      refresh()
    }
    window.addEventListener(CONNECTION_CHANGED, back)
    return () => window.removeEventListener(CONNECTION_CHANGED, back)
  }, [refresh, sendMark])

  const mark = (step: SetupStep, value: SetupMark) => {
    setView((v) => ({ ...v, setup: { ...v.setup, steps: { ...v.setup.steps, [step]: value } } }))
    return sendMark(step, value)
  }
  /** After a step: the next one, or, for a step opened on its own, back where it was opened from once it is saved. */
  const leave = (step: SetupStep, value: SetupMark) => {
    const saved = mark(step, value)
    if (!single) return setScreen(nextScreen(step))
    setClosing(true)
    void saved.then(() => props.onClose({}))
  }

  const finish = async (starter?: Starter) => {
    setClosing(true)
    try {
      await send('PUT', '/api/setup', { finish: true })
    } catch (err) {
      setClosing(false)
      return toast((err as Error).message, 'error')
    }
    props.onClose({ ...(starter ? { starter } : {}), ...(project ? { project: project.project.id } : {}) })
  }

  const ctx: SetupContext = {
    view,
    settings,
    models: props.models,
    onModelsChanged: props.onModelsChanged,
    ...(props.config ? { config: props.config } : {}),
    onConfig: props.onConfig,
    theme: props.theme,
    onTheme: props.onTheme,
    ...(project ? { project } : {}),
    setProject,
    onProjects: props.onProjects,
    single,
    go: setScreen,
    back: () => {
      if (single) return props.onClose({})
      const before = previousScreen(screen)
      if (before) setScreen(before)
    },
    done: (step) => leave(step, 'done'),
    later: (step) => leave(step, 'later'),
    refresh,
    finish: (starter) => void finish(starter),
  }

  const look = useMemo(() => ({ ...DEFAULT_MASCOT, ...settings.data?.settings.mascot }), [settings.data])
  const name = settings.data?.settings.profile?.name?.trim() || settings.data?.account
  const status = (s: SetupScreen): StepStatus =>
    s === 'ready' ? (s === screen ? 'current' : 'todo') : stepStatus(s, view, screen)
  const at = SETUP_SCREENS.indexOf(screen)

  // Up and Down move between the steps in the list, as in any list of choices.
  const list = useRef<HTMLOListElement>(null)
  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const buttons = [...(list.current?.querySelectorAll('button') ?? [])]
    const from = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const to = buttons[Math.max(0, Math.min(buttons.length - 1, from + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (to) {
      e.preventDefault()
      to.focus()
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      <header
        data-toolbar
        className="drag-region material-toolbar flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line pr-3 pl-[calc(var(--titlebar-inset)+1rem)]"
      >
        <Logo size={22} />
        <span className="text-body font-semibold">{t.title}</span>
        <span className="flex-1" />
        {single ? (
          <Button variant="borderless" size="sm" loading={closing} onClick={() => props.onClose({})}>
            {t.single.close}
          </Button>
        ) : (
          <Button
            variant="borderless"
            size="sm"
            title={t.finishLaterTitle}
            loading={closing}
            onClick={() => void finish()}
          >
            {t.finishLater}
          </Button>
        )}
      </header>
      {!props.online && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-line bg-fill px-4 py-2 text-body text-fg-2"
        >
          <LoaderCircle className="size-3.5 animate-spin text-muted" />
          {copy.app.reconnecting}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t.navLabel}
          className="material-sidebar w-48 shrink-0 overflow-y-auto border-r border-line px-2.5 py-4 lg:w-60"
        >
          <ol ref={list} className="flex flex-col gap-px" onKeyDown={onListKey}>
            {SETUP_SCREENS.map((s) => {
              const st = status(s)
              return (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => setScreen(s)}
                    aria-current={s === screen ? 'step' : undefined}
                    aria-label={`${t.steps[s]}, ${t.status[st]}`}
                    data-status={st}
                    className={cn(
                      'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-body transition-colors',
                      s === screen ? 'bg-row-selected text-fg' : 'text-fg-2 hover:bg-fill/70 hover:text-fg',
                    )}
                  >
                    <Dot status={STATUS_DOT[st]} />
                    <span className="min-w-0 truncate">{t.steps[s]}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>
        <main className="flex min-w-0 flex-1 flex-col bg-surface">
          <MascotStage screen={screen} look={look} {...(name ? { name: name.split(/\s+/)[0] ?? name } : {})}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={screen} {...screenMotion(reduce)} transition={{ duration: 0.18 }}>
                <SetupProvider value={ctx}>
                  {screen === 'welcome' && <WelcomeStep />}
                  {screen === 'you' && <YouStep />}
                  {screen === 'models' && <ModelsStep />}
                  {screen === 'crew' && <CrewStep />}
                  {screen === 'project' && <ProjectStep />}
                  {screen === 'voice' && <VoiceStep />}
                  {screen === 'channels' && <ChannelsStep />}
                  {screen === 'alerts' && <AlertsStep />}
                  {screen === 'ready' && <ReadyStep steps={SETUP_STEPS} />}
                </SetupProvider>
              </motion.div>
            </AnimatePresence>
          </MascotStage>
        </main>
      </div>
      <p className="sr-only" aria-live="polite">
        {t.announce(at + 1, SETUP_SCREENS.length, t.steps[screen])}
      </p>
    </div>
  )
}
