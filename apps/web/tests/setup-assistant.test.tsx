import { afterEach, expect, test } from 'bun:test'
import { SETUP_STEPS, type SetupState } from '@myrmidon/protocol'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import type { TeamConfig } from '../src/client/api.ts'
import {
  CHOREOGRAPHY,
  placement,
  REACTIONS,
  reactionMotion,
  stageLayout,
  WAKE_UP,
} from '../src/client/setup/choreography.ts'
import {
  leftToSetUp,
  opensOnLoad,
  resumeAt,
  returnFromAddress,
  SETUP_SCREENS,
  type SetupReturn,
  type SetupScreen,
  type SetupView,
  starters,
  stepStatus,
} from '../src/client/setup/state.ts'
import { mount, withDom } from './dom.ts'

withDom()

const view = (setup: SetupState, have: SetupView['have'] = {}): SetupView => ({ setup, have })

/* ------------------------------------------------------------------ the choreography table */

test('every screen has its choreography: big and centred to open and close, beside the content between', () => {
  expect(Object.keys(CHOREOGRAPHY).sort()).toEqual([...SETUP_SCREENS].sort())
  expect(CHOREOGRAPHY.welcome.place).toBe('center')
  expect(CHOREOGRAPHY.ready.place).toBe('center')
  for (const step of SETUP_STEPS.filter((s) => s !== 'welcome')) {
    expect(CHOREOGRAPHY[step].place).toBe('side')
    // From the second screen on, its eyes go to the control in focus or under the pointer.
    expect(CHOREOGRAPHY[step].gaze).toBe('controls')
  }
  expect(CHOREOGRAPHY.ready.enter).toBe('celebrate')
  // It wakes up on Welcome, from asleep to looking at the person.
  expect(WAKE_UP[0]?.emotion.mood).toBe('sleep')
  expect(WAKE_UP.at(-1)?.look).toEqual([0, 0])
})

test('every reaction changes the face and moves, and each motion starts and ends at rest', () => {
  for (const [name, r] of Object.entries(REACTIONS)) {
    expect(r.emotion.label, name).toBeTruthy()
    for (const frames of Object.values(r.motion)) {
      expect(frames.at(0)).toBe(frames.at(-1))
      expect(frames.length).toBeGreaterThan(2)
    }
  }
})

test('with less motion the mascot does not travel or bounce: its face changes in place', () => {
  for (const name of Object.keys(REACTIONS) as (keyof typeof REACTIONS)[]) {
    expect(reactionMotion(name, true)).toBeUndefined()
    expect(reactionMotion(name, false)).toBe(REACTIONS[name].motion)
  }
  const target = { x: 300, y: 24, scale: 0.65 }
  // Its place is set, not animated to.
  expect(placement(target, true)).toEqual({ style: target })
  expect(placement(target, false)).toMatchObject({ animate: target })
})

test('the content and the mascot are centred together, across and down, right of the step list', () => {
  // Beside the content: the pair is centred across, the content centred down with the mascot level with its top.
  const side = stageLayout({ place: 'side', width: 1200, height: 848, frameHeight: 230, contentHeight: 300 })
  const pair = side.content.width
  expect(side.content.left).toBe((1200 - pair) / 2)
  expect(side.top).toBe((848 - 300) / 2)
  expect(side.content.paddingTop).toBe(side.top)
  // The mascot's centre is right of the content column, inside the pair.
  const mascotCentre = 1200 / 2 + side.x
  expect(mascotCentre).toBeGreaterThan(side.content.left + pair - side.content.paddingRight)
  expect(mascotCentre).toBeLessThan(side.content.left + pair)
  // Content taller than the stage starts at the top and scrolls.
  expect(
    stageLayout({ place: 'side', width: 1200, height: 500, frameHeight: 230, contentHeight: 900 }).top,
  ).toBe(32)
  // Above the content: one stack, centred down, untransformed so the home screen's mascot takes over from it.
  const centre = stageLayout({
    place: 'center',
    width: 1200,
    height: 848,
    frameHeight: 230,
    contentHeight: 300,
  })
  expect(centre.x).toBe(0)
  expect(centre.scale).toBe(1)
  expect(centre.top).toBe((848 - (230 + 48 + 300)) / 2)
  expect(centre.content.left).toBe((1200 - centre.content.width) / 2)
  // A short window keeps it smaller; a narrow one keeps the mascot beside the content smaller.
  const short = stageLayout({
    place: 'center',
    width: 768,
    height: 548,
    frameHeight: 230,
    contentHeight: 300,
  })
  expect(short.scale).toBeLessThan(1)
  const narrow = stageLayout({ place: 'side', width: 768, height: 548, frameHeight: 230, contentHeight: 300 })
  expect(narrow.scale).toBeLessThan(side.scale)
})

/* ------------------------------------------------------------------ where it opens and what it shows */

test('it opens at the first step neither done nor set up later, and on Ready once there is none', () => {
  expect(resumeAt(view({ steps: {} }))).toBe('welcome')
  expect(resumeAt(view({ steps: { welcome: 'done', you: 'later' } }))).toBe('models')
  // A model connected in Settings counts as done too.
  expect(resumeAt(view({ steps: { welcome: 'done', you: 'later' } }, { models: true }))).toBe('crew')
  const all = Object.fromEntries(SETUP_STEPS.map((s) => [s, 'later'])) as SetupState['steps']
  expect(resumeAt(view({ steps: all }))).toBe('ready')
})

test('a reload comes back to the step in the address; a finished setup opens only when the address names it', () => {
  const finished = view({ finishedAt: '2026-10-09T10:00:00Z', steps: { welcome: 'done' } })
  expect(opensOnLoad(finished, '')).toBeUndefined()
  expect(opensOnLoad(finished, '?setup=voice')).toBe('voice')
  expect(opensOnLoad(view({ steps: { welcome: 'done' } }), '?setup=crew')).toBe('crew')
  expect(opensOnLoad(view({ steps: {} }), '?setup=nonsense')).toBe('welcome')
})

test('the list shows done once a thing exists, later as set up later, and the home screen counts what is left', () => {
  const v = view(
    { finishedAt: '2026-10-09T10:00:00Z', steps: { welcome: 'done', models: 'later', voice: 'later' } },
    { voice: true },
  )
  expect(stepStatus('welcome', v, 'crew')).toBe('done')
  expect(stepStatus('models', v, 'crew')).toBe('later')
  // Set up later, then turned on in Settings: done.
  expect(stepStatus('voice', v, 'crew')).toBe('done')
  expect(stepStatus('crew', v, 'crew')).toBe('current')
  expect(stepStatus('project', v, 'crew')).toBe('todo')
  expect(leftToSetUp(v)).toEqual(['models'])
  expect(leftToSetUp(view({ steps: { models: 'later' } }))).toEqual([])
  // Dismissed, the card is gone for good, whatever is still left.
  expect(leftToSetUp(view({ ...v.setup, dismissedAt: '2026-10-09T11:00:00Z' }, v.have))).toEqual([])
})

test('Continue past a step with nothing set up is skipped, not done, and the home screen still counts it', () => {
  const v = view(
    {
      finishedAt: '2026-10-09T10:00:00Z',
      steps: {
        welcome: 'done',
        you: 'done',
        models: 'done',
        voice: 'done',
        channels: 'done',
        alerts: 'done',
      },
    },
    { models: true },
  )
  expect(stepStatus('models', v)).toBe('done')
  // Voice left Off, no channel added, alerts off: gone past, but not set up.
  expect(stepStatus('voice', v)).toBe('skipped')
  expect(stepStatus('channels', v)).toBe('skipped')
  // You & mascot always has a mascot and a name to call the person, so going through it sets it up.
  expect(stepStatus('you', v)).toBe('done')
  expect(leftToSetUp(v)).toEqual(['voice', 'channels', 'alerts'])
  // A skipped step is not where the assistant opens again.
  expect(resumeAt(view({ steps: { welcome: 'done', you: 'done', models: 'done' } }))).toBe('crew')
  // Alerts on and allowed in this browser count as set up, which only the browser knows.
  localStorage.setItem('myr-notify', '1')
  ;(globalThis as { Notification?: unknown }).Notification = { permission: 'granted' }
  try {
    expect(leftToSetUp(v)).toEqual(['voice', 'channels'])
  } finally {
    localStorage.removeItem('myr-notify')
    ;(globalThis as { Notification?: unknown }).Notification = realNotification
  }
})

test('the home screen card says what is left, and its close button asks once before hiding it for good', async () => {
  const { SetupNudge } = await import('../src/client/setup/Nudge.tsx')
  const opened: string[] = []
  let dismissed = 0
  const { host, unmount } = await mount(
    <SetupNudge left={['voice', 'alerts']} onOpen={(s) => opened.push(s)} onDismiss={() => dismissed++} />,
  )
  try {
    expect(host.textContent).toContain('Finish setting up · 2 left')
    const close = host.querySelector('button[aria-label="Hide for good"]') as HTMLButtonElement
    expect(close.title).toContain('for good')
    await act(async () => close.click())
    // One click only arms it: nothing is hidden yet.
    expect(dismissed).toBe(0)
    await act(async () => Bun.sleep(450))
    const sure = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Yes, hide this card')
    await act(async () => sure?.click())
    expect(dismissed).toBe(1)
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
    expect(opened).toEqual(['voice'])
  } finally {
    await unmount()
  }
})

test('starter prompts are about the project when there is one', () => {
  expect(starters({ project: 'shop' })[0]?.label).toBe('Summarise shop')
  expect(starters({}).map((s) => s.id)).toEqual(['research', 'app', 'explain'])
  for (const list of [starters({}), starters({ project: 'x' })]) expect(list).toHaveLength(3)
})

/* ------------------------------------------------------------------ the assistant on a page */

const realFetch = globalThis.fetch
const realNotification = (globalThis as { Notification?: unknown }).Notification
afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { Notification?: unknown }).Notification = realNotification
  history.replaceState(null, '', '/')
})

const SETTINGS = {
  settings: {
    version: 1,
    team: { mode: 'orchestrated', workers: 0, wallMinutes: 30, maxTurns: 40, costUsd: 5, tokens: 0 },
    tools: { shell: true, web: true, files: true, messaging: true, mcp: true },
    verification: { threshold: 0.7, reviewer: 'auto' },
    instructions: {},
    observer: { intervalSeconds: 45 },
    search: { provider: 'auto' },
    models: { hidden: [], hiddenProviders: [], windows: {} },
    permissions: {},
    profile: { greeting: 'model', titles: 'model' },
    mascot: { eyes: 'round', look: 'neutral', color: 'amber', screen: 'rotate' },
    voice: {
      enabled: false,
      stt: { provider: 'phonon' },
      tts: { provider: 'kitten', kittenModel: 'nano', voice: 'Leo', speed: 1 },
      sensitivity: 'normal',
    },
  },
  providers: [],
  searchProviders: [],
  customApis: [],
  sandbox: 'none',
  home: '/tmp/home',
  account: 'Ada',
  ompSetup: false,
  toolCatalog: [],
}

const MODEL = {
  ref: 'local/qwen',
  provider: 'local',
  id: 'qwen',
  name: 'Qwen',
  reasoning: false,
  hidden: false,
}

/** A Myrmidon for the page: it keeps setup as the server does and answers the rest with what each test needs. */
function fakeServer(
  start: SetupState,
  answers: {
    test?: { ok: boolean; error?: string }
    have?: SetupView['have']
    projects?: unknown[]
    voiceOn?: boolean
    /** Marks are refused, as a Myrmidon that cannot write its settings does. */
    markFails?: boolean
  } = {},
) {
  const state = { setup: structuredClone(start) }
  const puts: unknown[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost/')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (url.pathname === '/api/setup') {
      if (method === 'PUT') {
        puts.push(body)
        if (answers.markFails) return Response.json({ error: 'settings.json is read-only' }, { status: 500 })
        if (body.step) state.setup.steps = { ...state.setup.steps, [body.step]: body.mark }
        if (body.finish) state.setup.finishedAt = '2026-10-09T10:00:00Z'
      }
      return Response.json({ setup: state.setup, have: answers.have ?? {} })
    }
    if (url.pathname === '/api/projects') return Response.json({ projects: answers.projects ?? [] })
    if (url.pathname === '/api/settings')
      return Response.json(
        answers.voiceOn
          ? {
              ...SETTINGS,
              settings: { ...SETTINGS.settings, voice: { ...SETTINGS.settings.voice, enabled: true } },
            }
          : SETTINGS,
      )
    if (url.pathname === '/api/setup/detect') return Response.json({ ready: [], env: [], local: [] })
    if (url.pathname === '/api/models/test')
      return Response.json(answers.test ?? { ok: true, ms: 800, reply: 'OK' })
    if (url.pathname === '/api/voice')
      return Response.json({
        enabled: false,
        stt: { provider: 'phonon', phonon: { state: 'missing' }, omp: [], keySet: false },
        tts: { provider: 'kitten', kitten: { state: 'missing' }, voices: ['Leo'], omp: [], keySet: false },
        sizes: {
          phonon: 163_515_201,
          kitten: { nano: 60_000_000, micro: 45_000_000, mini: 81_000_000 },
          vad: 1_289_603,
          turn: 8_679_182,
        },
      })
    return Response.json({})
  }) as unknown as typeof fetch
  return { puts }
}

async function showSetup(
  screen: SetupScreen,
  start: SetupState,
  extra: {
    returnTo?: SetupReturn
    onClose?(result: unknown): void
    have?: SetupView['have']
    config?: Partial<TeamConfig>
    onConfig?(c: TeamConfig): void
  } = {},
) {
  const { Setup } = await import('../src/client/setup/Setup.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const config: TeamConfig = {
    mode: 'orchestrated' as const,
    leadModel: MODEL.ref,
    judgeModel: MODEL.ref,
    roster: [],
    extraWorkers: 0,
    ...extra.config,
  }
  return mount(
    // happy-dom never finishes an animation, and a screen waits for the one before it to leave.
    <MotionConfig reducedMotion="always" skipAnimations>
      <ToastProvider>
        <Setup
          initial={{ setup: start, have: extra.have ?? {} }}
          screen={screen}
          theme="system"
          onTheme={() => {}}
          models={[MODEL]}
          onModelsChanged={() => {}}
          config={config}
          onConfig={extra.onConfig ?? (() => {})}
          online
          onProjects={() => {}}
          {...(extra.returnTo ? { returnTo: extra.returnTo } : {})}
          onClose={extra.onClose ?? (() => {})}
        />
      </ToastProvider>
    </MotionConfig>,
  )
}

const settle = () => act(async () => Bun.sleep(700))
const heading = () => document.querySelector('h1')?.textContent
const button = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement
const listed = () =>
  Object.fromEntries(
    [...document.querySelectorAll('nav li button')].map((b) => [
      b.textContent?.trim(),
      b.getAttribute('data-status'),
    ]),
  )

test('Continue marks the step done and moves on; the next heading takes focus and the address follows', async () => {
  const { puts } = fakeServer({ steps: {} })
  const { unmount } = await showSetup('welcome', { steps: {} })
  try {
    await settle()
    expect(heading()).toBe('Welcome to Myrmidon')
    expect(location.search).toBe('?setup=welcome')
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Step 1 of 9: Welcome')
    await act(async () => button('Get started').click())
    await settle()
    expect(heading()).toBe('You & your mascot')
    expect(document.activeElement?.tagName).toBe('H1')
    expect(location.search).toBe('?setup=you')
    expect(puts).toContainEqual({ step: 'welcome', mark: 'done' })
    expect(listed()).toMatchObject({ Welcome: 'done', 'You & mascot': 'current', 'Connect models': 'todo' })
    // The list is a navigation landmark whose current step says so.
    expect(
      document.querySelector('nav[aria-label="Setup steps"] [aria-current="step"]')?.textContent,
    ).toContain('You & mascot')
  } finally {
    await unmount()
  }
})

test('Set up later marks the step, moves on, and the list shows it hollow', async () => {
  const { puts } = fakeServer({ steps: { welcome: 'done' } })
  const { unmount } = await showSetup('you', { steps: { welcome: 'done' } })
  try {
    await settle()
    await act(async () => button('Set up later').click())
    await settle()
    expect(puts).toContainEqual({ step: 'you', mark: 'later' })
    expect(heading()).toBe('Connect a model')
    expect(listed()).toMatchObject({ 'You & mascot': 'later', 'Connect models': 'current' })
    const later = [...document.querySelectorAll('nav li button')].find((b) => b.textContent?.includes('You'))
    expect(later?.getAttribute('aria-label')).toBe('You & mascot, set up later')
  } finally {
    await unmount()
  }
})

test('a step in the address opens on reload, and the list jumps between steps', async () => {
  fakeServer({ steps: { welcome: 'done' } })
  history.replaceState(null, '', '/?setup=crew')
  const { unmount } = await showSetup(opensOnLoad({ setup: { steps: {} }, have: {} }) ?? 'welcome', {
    steps: {},
  })
  try {
    await settle()
    expect(heading()).toBe('Your crew')
    const voice = [...document.querySelectorAll('nav li button')].find((b) =>
      b.textContent?.includes('Voice'),
    )
    await act(async () => (voice as HTMLButtonElement).click())
    await settle()
    expect(heading()).toBe('Voice calls')
    expect(location.search).toBe('?setup=voice')
  } finally {
    await unmount()
  }
})

test('a model that does not answer says why, offers Try again and Set up later, and keeps Continue shut', async () => {
  fakeServer({ steps: { welcome: 'done' } }, { test: { ok: false, error: 'connection refused' } })
  const { unmount } = await showSetup('models', { steps: { welcome: 'done' } })
  try {
    await settle()
    await act(async () => button('Send a test message').click())
    await settle()
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('The model did not answer')
    expect(alert?.textContent).toContain('connection refused')
    expect([...(alert?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim())).toEqual([
      'Try again',
      'Set up later',
    ])
    expect(button('Continue').disabled).toBe(true)
  } finally {
    await unmount()
  }
})

test('a model that answers opens Continue and shows its reply', async () => {
  fakeServer({ steps: { welcome: 'done' } })
  const { unmount } = await showSetup('models', { steps: { welcome: 'done' } })
  try {
    await settle()
    expect(button('Continue').disabled).toBe(true)
    await act(async () => button('Send a test message').click())
    await settle()
    expect(document.body.textContent).toContain('It answered in 0.8 s: “OK”')
    expect(button('Continue').disabled).toBe(false)
  } finally {
    await unmount()
  }
})

test('notifications refused: it says how to allow them later, marks alerts later and moves on', async () => {
  const { puts } = fakeServer({ steps: { welcome: 'done' } })
  ;(globalThis as { Notification?: unknown }).Notification = {
    permission: 'default',
    requestPermission: async () => 'denied',
  }
  const { unmount } = await showSetup('alerts', { steps: { welcome: 'done' } })
  try {
    await settle()
    const toggle = document.querySelector('[role="switch"]') as HTMLButtonElement
    await act(async () => toggle.click())
    await settle()
    expect(document.body.textContent).toContain('Notifications were not allowed. To allow them later')
    expect(puts).toContainEqual({ step: 'alerts', mark: 'later' })
    expect(heading()).toBe('You’re ready')
  } finally {
    await unmount()
  }
})

/* ------------------------------------------------------------------ one step on its own */

test('one step opened on its own goes back when set up later, instead of walking on to the next step', async () => {
  const start: SetupState = { finishedAt: '2026-10-09T10:00:00Z', steps: { welcome: 'done', voice: 'later' } }
  const { puts } = fakeServer(start)
  const closed: unknown[] = []
  const { unmount } = await showSetup('voice', start, { returnTo: 'home', onClose: (r) => closed.push(r) })
  try {
    await settle()
    expect(heading()).toBe('Voice calls')
    // The address keeps where it goes back to, so a reload still does this step alone.
    expect(returnFromAddress()).toBe('home')
    expect(button('Done')).toBeTruthy()
    expect(button('Continue')).toBeUndefined()
    expect(button('Finish later')).toBeUndefined()
    const later = [...document.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === 'Set up later',
    )
    await act(async () => (later.at(-1) as HTMLButtonElement).click())
    await settle()
    expect(puts).toContainEqual({ step: 'voice', mark: 'later' })
    expect(closed).toEqual([{}])
    expect(heading()).toBe('Voice calls')
    expect(puts.some((p) => (p as { finish?: boolean }).finish)).toBe(false)
  } finally {
    await unmount()
  }
})

test('one step opened from Settings goes back when done, and Back and Close go back without marking it', async () => {
  const start: SetupState = { finishedAt: '2026-10-09T10:00:00Z', steps: { welcome: 'done' } }
  const { puts } = fakeServer(start)
  const closed: unknown[] = []
  const { unmount } = await showSetup('channels', start, {
    returnTo: 'settings',
    onClose: (r) => closed.push(r),
  })
  try {
    await settle()
    expect(returnFromAddress()).toBe('settings')
    await act(async () => button('Back').click())
    await act(async () => button('Close').click())
    expect(closed).toHaveLength(2)
    expect(puts).toEqual([])
    await act(async () => button('Done').click())
    await settle()
    expect(puts).toContainEqual({ step: 'channels', mark: 'done' })
    expect(closed).toHaveLength(3)
    expect(heading()).toBe('Messaging apps')
  } finally {
    await unmount()
  }
})

test('the whole assistant run again still walks on to the next step', async () => {
  fakeServer({ steps: { welcome: 'done' } })
  const { unmount } = await showSetup('channels', { steps: { welcome: 'done' } })
  try {
    await settle()
    expect(returnFromAddress()).toBeUndefined()
    await act(async () => button('Continue').click())
    await settle()
    expect(heading()).toBe('Alerts')
  } finally {
    await unmount()
  }
})

/* ------------------------------------------------------------------ the test notification */

test('the test notification says how it went: sent, or blocked with how to allow it', async () => {
  fakeServer({ steps: { welcome: 'done' } })
  localStorage.setItem('myr-notify', '1')
  const made: string[] = []
  const permission = { now: 'granted' }
  ;(globalThis as { Notification?: unknown }).Notification = class {
    static get permission() {
      return permission.now
    }
    static requestPermission = async () => permission.now
    constructor(title: string) {
      made.push(title)
    }
  }
  const { unmount } = await showSetup('alerts', { steps: { welcome: 'done' } })
  try {
    await settle()
    const status = () => document.querySelector('[role="status"][data-result]')
    await act(async () => button('Send a test notification').click())
    await settle()
    expect(made).toEqual(['Myrmidon'])
    expect(status()?.getAttribute('data-result')).toBe('sent')
    expect(status()?.textContent).toContain('Sent.')
    // Allowed when the switch went on, blocked since: it says so and how to allow it, and stays on the step.
    permission.now = 'denied'
    await act(async () => button('Send a test notification').click())
    await settle()
    expect(status()?.getAttribute('data-result')).toBe('blocked')
    expect(status()?.textContent).toContain('Allow notifications in the site settings')
    expect(heading()).toBe('Alerts')
  } finally {
    localStorage.removeItem('myr-notify')
    await unmount()
  }
})

test('in the desktop app in front, the test waits for Myrmidon to go to the background, then is sent', async () => {
  fakeServer({ steps: { welcome: 'done' } })
  localStorage.setItem('myr-notify', '1')
  const sent: string[] = []
  window.myrmidonDesktop = {
    pickFolder: async () => undefined,
    reveal: async () => {},
    setBadge: async () => {},
    notify: async (_title, body) => {
      sent.push(body)
    },
  }
  const hasFocus = document.hasFocus.bind(document)
  let focused = true
  document.hasFocus = () => focused
  const { unmount } = await showSetup('alerts', { steps: { welcome: 'done' } })
  try {
    await settle()
    const status = () => document.querySelector('[role="status"][data-result]')
    await act(async () => button('Send a test notification').click())
    await settle()
    expect(status()?.getAttribute('data-result')).toBe('waiting')
    expect(sent).toEqual([])
    focused = false
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
    })
    await settle()
    expect(sent).toEqual(['This is how Myrmidon tells you a chat is done.'])
    expect(status()?.getAttribute('data-result')).toBe('sent')
    expect(status()?.textContent).toContain('System Settings → Notifications → Myrmidon')
  } finally {
    document.hasFocus = hasFocus
    delete window.myrmidonDesktop
    localStorage.removeItem('myr-notify')
    await unmount()
  }
})

/* ------------------------------------------------------------------ what each step says and keeps */

test('Ready says what exists: set up, set up later, skipped or not set up, each row named as it reads', async () => {
  const start: SetupState = {
    steps: { welcome: 'done', you: 'done', models: 'done', crew: 'done', voice: 'done', channels: 'later' },
  }
  fakeServer(start, { have: { models: true, crew: true } })
  const { unmount } = await showSetup('ready', start, { have: { models: true, crew: true } })
  try {
    await settle()
    expect(document.body.textContent).toContain('Here is where each step stands.')
    const buttons = [...document.querySelectorAll('main button[aria-label]')]
    const steps = buttons.filter((b) => b.querySelector('span.flex-1'))
    const rows = Object.fromEntries(
      steps.map((b) => [b.querySelector('span.flex-1')?.textContent, b.getAttribute('aria-label')]),
    )
    expect(rows).toMatchObject({
      'You & mascot': 'You & mascot, Set up',
      'Connect models': 'Connect models, Set up',
      'Voice calls': 'Voice calls, Skipped',
      'Messaging apps': 'Messaging apps, Set up later',
      'Your first project': 'Your first project, Not set up',
    })
    // The name starts with what the row shows, so it can be found by its words.
    for (const b of steps) {
      const shown = [...b.querySelectorAll('span')]
        .map((x) => x.textContent)
        .filter(Boolean)
        .join(', ')
      expect(b.getAttribute('aria-label')).toBe(shown)
    }
  } finally {
    await unmount()
  }
})

test('a model that answers is made the lead only on Continue, and the step says so first', async () => {
  fakeServer({ steps: { welcome: 'done' } })
  const configs: TeamConfig[] = []
  const { unmount } = await showSetup(
    'models',
    { steps: { welcome: 'done' } },
    { config: { leadModel: '', judgeModel: '' }, onConfig: (c) => configs.push(c) },
  )
  try {
    await settle()
    await act(async () => button('Send a test message').click())
    await settle()
    expect(document.body.textContent).toContain(
      'Continue makes Qwen the lead of every new chat, and its reviewer. You can change it in Your crew.',
    )
    expect(configs).toEqual([])
    await act(async () => button('Continue').click())
    await settle()
    expect(configs.at(-1)).toMatchObject({ leadModel: MODEL.ref, judgeModel: MODEL.ref })
    expect(heading()).toBe('Your crew')
  } finally {
    await unmount()
  }
})

test('the spend limit, review and what the crew costs are on the crew step, not the project step', async () => {
  fakeServer({ steps: { welcome: 'done' } })
  const { unmount } = await showSetup('crew', { steps: { welcome: 'done' } })
  try {
    await settle()
    expect(document.body.textContent).toContain('Spend limit per run')
    expect(document.body.textContent).toContain('Review the work')
    expect(document.body.textContent).toContain('more crewmates and bigger models cost more')
    await act(async () => button('Continue').click())
    await settle()
    expect(heading()).toBe('Your first project')
    expect(document.body.textContent).not.toContain('Spend limit per run')
    expect(document.body.textContent).not.toContain('Review the work')
  } finally {
    await unmount()
  }
})

test('the project step opened from Settings shows the project added before and can be finished', async () => {
  const start: SetupState = { finishedAt: '2026-10-09T10:00:00Z', steps: { welcome: 'done' } }
  const project = {
    id: 'p1',
    name: 'shop',
    path: '/Users/ada/shop',
    addedAt: '2026-10-01T10:00:00Z',
    permissions: { mode: 'ask', allow: [] },
  }
  const { puts } = fakeServer(start, { projects: [project] })
  const closed: unknown[] = []
  const { unmount } = await showSetup('project', start, {
    returnTo: 'settings',
    onClose: (r) => closed.push(r),
  })
  try {
    await settle()
    expect(document.body.textContent).toContain('shop')
    expect(document.body.textContent).not.toContain('No folder chosen yet.')
    expect(button('Choose another folder')).toBeTruthy()
    // Its permissions as they are, not a guess from a git check that was never made.
    expect(document.querySelector<HTMLInputElement>('input[name="permission-mode"]:checked')?.value).toBe(
      'ask',
    )
    expect(document.body.textContent).not.toContain('A git repository')
    expect(document.body.textContent).not.toContain('Not a git repository')
    const done = button('Done')
    expect(done.disabled).toBe(false)
    await act(async () => done.click())
    await settle()
    expect(puts).toContainEqual({ step: 'project', mark: 'done' })
    expect(closed).toHaveLength(1)
  } finally {
    await unmount()
  }
})

test('one step on its own keeps the list closed, and stays open when its mark is not kept', async () => {
  const start: SetupState = { finishedAt: '2026-10-09T10:00:00Z', steps: { welcome: 'done' } }
  fakeServer(start, { markFails: true })
  const closed: unknown[] = []
  const { unmount } = await showSetup('channels', start, {
    returnTo: 'settings',
    onClose: (r) => closed.push(r),
  })
  try {
    await settle()
    const list = [...document.querySelectorAll<HTMLButtonElement>('nav li button')]
    expect(list.filter((b) => !b.disabled).map((b) => b.textContent?.trim())).toEqual(['Messaging apps'])
    await act(async () => button('Done').click())
    await settle()
    expect(closed).toEqual([])
    expect(heading()).toBe('Messaging apps')
    // It says the mark was not kept, and Done can be pressed again.
    expect(document.body.textContent).toContain('Myrmidon hit a problem')
    expect(button('Done').disabled).toBe(false)
  } finally {
    await unmount()
  }
})

/* ------------------------------------------------------------------ the microphone test */

/** A microphone for the page: `grant` answers the browser's prompt, each track counts its stops. */
function fakeMicrophone() {
  const stops = { n: 0 }
  let grant: (() => void) | undefined
  const stream = { getTracks: () => [{ stop: () => stops.n++ }] }
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: () =>
        new Promise((resolve) => {
          grant = () => resolve(stream)
        }),
    },
  })
  ;(globalThis as { AudioContext?: unknown }).AudioContext = class {
    createAnalyser() {
      return { fftSize: 0, getByteTimeDomainData: () => {} }
    }
    createMediaStreamSource() {
      return { connect: () => {} }
    }
    close = async () => {}
  }
  return {
    stops,
    grant: () => grant?.(),
    restore() {
      delete (window as { isSecureContext?: boolean }).isSecureContext
      delete (navigator as { mediaDevices?: unknown }).mediaDevices
      delete (globalThis as { AudioContext?: unknown }).AudioContext
    },
  }
}

test('Stop the test lets the microphone go and puts the test back to the start', async () => {
  fakeServer({ steps: { welcome: 'done' } }, { voiceOn: true })
  const mic = fakeMicrophone()
  const { unmount } = await showSetup('voice', { steps: { welcome: 'done' } })
  try {
    await settle()
    await act(async () => button('Allow the microphone').click())
    await act(async () => mic.grant())
    await settle()
    expect(document.body.textContent).toContain('Say something')
    await act(async () => button('Stop the test').click())
    expect(mic.stops.n).toBe(1)
    expect(button('Stop the test')).toBeUndefined()
    expect(button('Allow the microphone')).toBeTruthy()
  } finally {
    mic.restore()
    await unmount()
  }
})

test('a microphone allowed after the step was left is let go at once, and the step is not marked', async () => {
  const { puts } = fakeServer({ steps: { welcome: 'done' } }, { voiceOn: true })
  const mic = fakeMicrophone()
  const { unmount } = await showSetup('voice', { steps: { welcome: 'done' } })
  try {
    await settle()
    await act(async () => button('Allow the microphone').click())
    // The browser's prompt is open; the person goes to another step meanwhile.
    const channels = [...document.querySelectorAll('nav li button')].find((b) =>
      b.textContent?.includes('Messaging'),
    ) as HTMLButtonElement
    await act(async () => channels.click())
    await settle()
    expect(heading()).toBe('Messaging apps')
    await act(async () => mic.grant())
    await settle()
    expect(mic.stops.n).toBe(1)
    expect(puts).toEqual([])
  } finally {
    mic.restore()
    await unmount()
  }
})
