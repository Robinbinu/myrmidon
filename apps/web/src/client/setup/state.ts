import { SETUP_STEPS, type SetupHave, type SetupState, type SetupStep } from '@myrmidon/protocol'
import { copy } from '../copy.ts'
import { desktop } from '../ui/desktop.ts'
import { NOTIFY_KEY, readStored } from '../ui/hooks.ts'

/** Every screen of the assistant, in order: its steps, then Ready. */
export const SETUP_SCREENS = [...SETUP_STEPS, 'ready'] as const
export type SetupScreen = (typeof SETUP_SCREENS)[number]

/** The address names the open screen, as `?settings=` does for Settings, so a reload comes back to it. */
export const SETUP_PARAM = 'setup'

/**
 * Where one step opened on its own (from the home screen's card or Settings) goes back to once it is done or set up
 * later, instead of walking on to the next step. Absent when the whole assistant runs.
 */
export type SetupReturn = 'home' | 'settings'
/** The address names it beside the step, so a reload still does only that step. */
export const SETUP_RETURN_PARAM = 'from'

export function returnFromAddress(search: string = location.search): SetupReturn | undefined {
  const value = new URLSearchParams(search).get(SETUP_RETURN_PARAM)
  return value === 'home' || value === 'settings' ? value : undefined
}

/** What the server says about setup: where the person is with it, and what exists already. */
export interface SetupView {
  setup: SetupState
  have: SetupHave
}

/**
 * done: its thing exists (or, for a step with nothing to be missing, the person went through it); later: Set up
 * later; skipped: Continue with nothing set up; todo: not reached yet.
 */
export type StepStatus = 'done' | 'current' | 'later' | 'skipped' | 'todo'

export const isScreen = (value: unknown): value is SetupScreen =>
  typeof value === 'string' && (SETUP_SCREENS as readonly string[]).includes(value)

export function screenFromAddress(search: string = location.search): SetupScreen | undefined {
  const value = new URLSearchParams(search).get(SETUP_PARAM)
  return isScreen(value) ? value : undefined
}

/** Whether this window may notify: the desktop app always can, a browser once the person allowed it. */
export function alertsAllowed(): boolean {
  if (desktop()) return true
  return typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

/** Alerts live in each browser, so the server cannot say: on here, and allowed, counts as set up. */
export const withAlerts = (view: SetupView): SetupView => ({
  ...view,
  have: { ...view.have, alerts: readStored<string>(NOTIFY_KEY, '0') === '1' && alertsAllowed() },
})

/**
 * Steps where going through them is the setting up: Welcome has nothing to set, and You & mascot always has a mascot
 * and a name to call the person (their account's when they type none). Every other step is set up only once its thing
 * exists, so Continue past it with nothing chosen is not.
 */
const SET_UP_BY_VISIT: readonly SetupStep[] = ['welcome', 'you']

/** A step is set up once its thing exists, set up here or in Settings. */
export function isDone(step: SetupStep, view: SetupView): boolean {
  return !!view.have[step] || (SET_UP_BY_VISIT.includes(step) && view.setup.steps[step] === 'done')
}

export function stepStatus(step: SetupStep, view: SetupView, current?: SetupScreen): StepStatus {
  if (step === current) return 'current'
  if (isDone(step, view)) return 'done'
  const mark = view.setup.steps[step]
  return mark === 'later' ? 'later' : mark === 'done' ? 'skipped' : 'todo'
}

/**
 * The status dot each status draws (ui/status.ts): done green, current amber, later and skipped a grey ring, todo
 * dashed.
 */
export const STATUS_DOT: Record<StepStatus, string> = {
  done: 'ready',
  current: 'waiting',
  later: 'idle',
  skipped: 'idle',
  todo: 'queued',
}

/** Where the assistant opens: the first step not set up and not gone through yet, or Ready once there is none. */
export function resumeAt(view: SetupView): SetupScreen {
  return SETUP_STEPS.find((s) => !isDone(s, view) && !view.setup.steps[s]) ?? 'ready'
}

/** Whether the assistant takes the place of the home screen: until it is finished, or when the address names it. */
export function opensOnLoad(view: SetupView, search: string = location.search): SetupScreen | undefined {
  const named = screenFromAddress(search)
  if (named) return named
  return view.setup.finishedAt ? undefined : resumeAt(view)
}

/**
 * The steps gone past without their thing, set up later or skipped with Continue: what the home screen's card says
 * is left. None once the card was dismissed, which is for good.
 */
export function leftToSetUp(view: SetupView): SetupStep[] {
  if (!view.setup.finishedAt || view.setup.dismissedAt) return []
  const here = withAlerts(view)
  return SETUP_STEPS.filter((s) => {
    const status = stepStatus(s, here)
    return status === 'later' || status === 'skipped'
  })
}

export function nextScreen(screen: SetupScreen): SetupScreen {
  return SETUP_SCREENS[Math.min(SETUP_SCREENS.indexOf(screen) + 1, SETUP_SCREENS.length - 1)] ?? 'ready'
}

export function previousScreen(screen: SetupScreen): SetupScreen | undefined {
  const at = SETUP_SCREENS.indexOf(screen)
  return at > 0 ? SETUP_SCREENS[at - 1] : undefined
}

export interface Starter {
  id: string
  label: string
  text: string
}

/** Three first requests, tuned to what was set up: a project gets requests about it, otherwise general ones. */
export function starters(input: { project?: string }): Starter[] {
  const s = copy.setup.ready.starter
  if (input.project)
    return [
      { id: 'project', ...s.project(input.project) },
      { id: 'projectRisks', ...s.projectRisks },
      { id: 'research', ...s.research },
    ]
  return [
    { id: 'research', ...s.research },
    { id: 'app', ...s.app },
    { id: 'explain', ...s.explain },
  ]
}
