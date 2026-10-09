import { SETUP_STEPS, type SetupHave, type SetupState, type SetupStep } from '@myrmidon/protocol'
import { copy } from '../copy.ts'

/** Every screen of the assistant, in order: its steps, then Ready. */
export const SETUP_SCREENS = [...SETUP_STEPS, 'ready'] as const
export type SetupScreen = (typeof SETUP_SCREENS)[number]

/** The address names the open screen, as `?settings=` does for Settings, so a reload comes back to it. */
export const SETUP_PARAM = 'setup'

/** What the server says about setup: where the person is with it, and what exists already. */
export interface SetupView {
  setup: SetupState
  have: SetupHave
}

/** done: the person went through it, or its thing exists; later: Set up later; todo: neither yet. */
export type StepStatus = 'done' | 'current' | 'later' | 'todo'

export const isScreen = (value: unknown): value is SetupScreen =>
  typeof value === 'string' && (SETUP_SCREENS as readonly string[]).includes(value)

export function screenFromAddress(search: string = location.search): SetupScreen | undefined {
  const value = new URLSearchParams(search).get(SETUP_PARAM)
  return isScreen(value) ? value : undefined
}

/** A step shows done once its thing exists, set up here or in Settings, or once the person went through it. */
export function isDone(step: SetupStep, view: SetupView): boolean {
  return !!view.have[step] || view.setup.steps[step] === 'done'
}

export function stepStatus(step: SetupStep, view: SetupView, current?: SetupScreen): StepStatus {
  if (step === current) return 'current'
  if (isDone(step, view)) return 'done'
  return view.setup.steps[step] === 'later' ? 'later' : 'todo'
}

/** The status dot each status draws (ui/status.ts): done green, current amber, later a grey ring, todo dashed. */
export const STATUS_DOT: Record<StepStatus, string> = {
  done: 'ready',
  current: 'waiting',
  later: 'idle',
  todo: 'queued',
}

/** Where the assistant opens: the first step neither done nor set up later, or Ready once there is none. */
export function resumeAt(view: SetupView): SetupScreen {
  return SETUP_STEPS.find((s) => !isDone(s, view) && view.setup.steps[s] !== 'later') ?? 'ready'
}

/** Whether the assistant takes the place of the home screen: until it is finished, or when the address names it. */
export function opensOnLoad(view: SetupView, search: string = location.search): SetupScreen | undefined {
  const named = screenFromAddress(search)
  if (named) return named
  return view.setup.finishedAt ? undefined : resumeAt(view)
}

/** The steps set up later whose thing does not exist yet: what the home screen's card says is left. */
export function leftToSetUp(view: SetupView): SetupStep[] {
  if (!view.setup.finishedAt) return []
  return SETUP_STEPS.filter((s) => view.setup.steps[s] === 'later' && !view.have[s])
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
