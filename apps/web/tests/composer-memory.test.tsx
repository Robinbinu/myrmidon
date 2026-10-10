import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { mount, press, withDom } from './dom.ts'

withDom()

const MODELS = [
  { ref: 'anthropic/opus', provider: 'anthropic', id: 'opus', name: 'Opus', reasoning: true },
  { ref: 'openai/gpt', provider: 'openai', id: 'gpt', name: 'GPT', reasoning: true },
]

/** The server's side of it: its settings file's default crew and the message box's last crew. */
interface FakeServer {
  team: Record<string, unknown>
  composer?: unknown
}
let server: FakeServer
const realFetch = globalThis.fetch

beforeEach(() => {
  // happy-dom's Web Animations reject when cut short, which motion leaves unhandled; its own timers stand in.
  Reflect.deleteProperty(Element.prototype, 'animate')
  localStorage.clear()
  server = { team: { mode: 'orchestrated', workers: 3, wallMinutes: 30 } }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.href)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const reply = (data: unknown) =>
      new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
    switch (url.pathname) {
      case '/api/models':
        return reply({
          models: MODELS,
          default: 'anthropic/opus',
          defaults: server.team,
          ...(server.composer ? { composer: server.composer } : {}),
        })
      case '/api/settings/composer':
        if (method !== 'PUT') break
        server.composer = body
        return reply({ composer: body })
      case '/api/chats':
        return reply([])
      case '/api/projects':
        return reply({ projects: [{ id: 'site', name: 'site', path: '/tmp/site', addedAt: '2026-10-01' }] })
      case '/api/setup':
        return reply({ setup: { finishedAt: '2026-10-01T00:00:00.000Z', steps: {} }, have: {} })
      case '/api/plugins':
        return reply({ plugins: [] })
      case '/api/suggestions':
        return reply({ said: [] })
      case '/api/whoami':
        return reply({ scope: 'full' })
    }
    // Anything else the page asks for is refused, as by a server without that part.
    return new Response(JSON.stringify({ error: 'not here' }), { status: 503 })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

async function app() {
  const { App } = await import('../src/client/App.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const { StatusProvider } = await import('../src/client/status.tsx')
  const { MotionConfig } = await import('motion/react')
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <ToastProvider>
        <StatusProvider>
          <App />
        </StatusProvider>
      </ToastProvider>
    </MotionConfig>,
  )
  await act(async () => Bun.sleep(50))
  return view
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const click = async (el: Element | undefined, what = 'it') => {
  if (!el) throw new Error(`no ${what} to click`)
  await act(async () => (el as HTMLElement).click())
  await act(async () => Bun.sleep(30))
}
/** The message box's lead chip, and its crew chip's summary ("Crew: thinking auto · review · 2 crewmates · auto"). */
const lead = () => buttons().find((b) => b.title === 'Lead')
const crew = () => buttons().find((b) => b.title.startsWith('Crew: '))?.title
const shown = () => ({ lead: lead()?.textContent, crew: crew() })

/** Picks GPT to lead and no helpers in the message box, as the person would. */
async function pick() {
  await click(lead(), 'lead chip')
  await click(
    [...document.querySelectorAll('[role=option]')].find((o) => o.textContent?.startsWith('GPT')),
    'GPT option',
  )
  await click(
    buttons().find((b) => b.title.startsWith('Crew: ')),
    'crew chip',
  )
  await click(
    buttons().find((b) => b.textContent === 'Never'),
    'Never',
  )
  await press('Escape')
  await act(async () => Bun.sleep(30))
}
const PICKED = { lead: 'GPT', crew: 'Crew: thinking auto · review · no crewmates' }

test('a new chat keeps the lead and helpers picked in the message box: the buttons, ⌘N and after a reload', async () => {
  let view = await app()
  try {
    expect(shown().lead).toBe('Opus')
    await pick()
    expect(shown()).toEqual(PICKED)
    await click(
      buttons().find((b) => b.getAttribute('aria-label') === 'New chat'),
      'New chat button',
    )
    expect(shown()).toEqual(PICKED)
    const { isMac } = await import('../src/client/ui/platform.ts')
    await press('n', { metaKey: isMac, ctrlKey: !isMac })
    await act(async () => Bun.sleep(30))
    expect(shown()).toEqual(PICKED)
    await click(
      buttons().find((b) => b.getAttribute('aria-label') === 'New chat in site'),
      'project button',
    )
    expect(shown()).toEqual(PICKED)
  } finally {
    await view.unmount()
  }
  view = await app()
  try {
    expect(shown()).toEqual(PICKED)
  } finally {
    await view.unmount()
  }
})

test('another browser, or this one with its storage cleared, starts with the last lead and helpers picked', async () => {
  let view = await app()
  try {
    await pick()
  } finally {
    await view.unmount()
  }
  // The desktop app serves each launch from a new port, so its page starts with empty storage every time.
  localStorage.clear()
  view = await app()
  try {
    expect(shown()).toEqual(PICKED)
  } finally {
    await view.unmount()
  }
})

test("a default crew saved with no crewmates starts a browser's first chat with the lead alone", async () => {
  server.team = { mode: 'orchestrated', workers: 0, leadModel: 'openai/gpt', judgeModel: 'openai/gpt' }
  const view = await app()
  try {
    expect(shown()).toEqual(PICKED)
  } finally {
    await view.unmount()
  }
})
