import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const LINK = '/Users/robin/.local/bin/myrmidon'
const APP = '/Applications/Myrmidon.app/Contents/Resources/app/sidecar/myrmidon'

const SETTINGS = {
  settings: {
    version: 1,
    team: { mode: 'orchestrated', workers: 1, wallMinutes: 30, maxTurns: 40, costUsd: 5, tokens: 0 },
    models: { hidden: [], hiddenProviders: [], windows: {} },
    permissions: { preset: 'auto', rules: [] },
    profile: { greeting: 'model', titles: 'model' },
    power: { keepAwake: false },
    cli: { command: true },
  },
  providers: [],
}

/** A Myrmidon whose /api/cli-command starts in `state`; every other route answers empty. */
function fakeServer(start: Record<string, unknown>) {
  let status: Record<string, unknown> = { link: LINK, profileBlock: false, ...start }
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost/')
    const method = init?.method ?? 'GET'
    if (url.pathname === '/api/settings') return Response.json(SETTINGS)
    if (url.pathname !== '/api/cli-command') return Response.json({})
    calls.push(method)
    if (method === 'POST') status = { ...status, state: 'installed', target: APP, profileBlock: true }
    if (method === 'DELETE') status = { link: LINK, state: 'missing', profileBlock: false }
    return Response.json(status)
  }) as unknown as typeof fetch
  return calls
}

const settle = () => act(async () => Bun.sleep(60))

async function showGeneral() {
  const { Settings } = await import('../src/client/Settings.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const view = await mount(
    <MotionConfig reducedMotion="always" skipAnimations>
      <ToastProvider>
        <Settings
          onClose={() => {}}
          theme="system"
          onTheme={() => {}}
          reduceMotion
          onReduceMotion={() => {}}
          models={[]}
          onModelsChanged={() => {}}
          onConfig={() => {}}
          initialSection="general"
        />
      </ToastProvider>
    </MotionConfig>,
  )
  await settle()
  return view
}

const row = () => document.querySelector('[data-setting-id="general.cliCommand"]')
const status = () => row()?.querySelector('[role="status"]')?.textContent
const rowButton = (name: string) =>
  [...(row()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === name)

test('Settings → General shows where the command is installed, and Remove takes it away', async () => {
  const calls = fakeServer({ state: 'installed', target: APP })
  const { unmount } = await showGeneral()
  try {
    expect(row()?.textContent).toContain('Terminal command')
    expect(status()).toBe(`Installed at ${LINK}.`)
    expect(rowButton('Install')).toBeUndefined()
    await act(async () => rowButton('Remove')?.click())
    await settle()
    expect(calls).toContain('DELETE')
    expect(status()).toBe('Not installed.')
    await act(async () => rowButton('Install')?.click())
    await settle()
    expect(calls).toContain('POST')
    expect(status()).toBe(`Installed at ${LINK}.`)
  } finally {
    await unmount()
  }
})

test('a broken link offers Repair; a development build says why and offers nothing', async () => {
  fakeServer({ state: 'broken', target: '/Volumes/Old/Myrmidon.app/Contents/Resources/app/sidecar/myrmidon' })
  const broken = await showGeneral()
  try {
    expect(status()).toContain('is broken')
    expect(rowButton('Repair')).toBeTruthy()
    expect(rowButton('Remove')).toBeTruthy()
  } finally {
    await broken.unmount()
  }
  const reason = 'Only the desktop app can install the myrmidon command.'
  const calls = fakeServer({ state: 'unavailable', reason })
  const dev = await showGeneral()
  try {
    expect(status()).toBe(reason)
    expect(row()?.querySelectorAll('button').length).toBe(0)
    expect(calls).toEqual(['GET'])
  } finally {
    await dev.unmount()
  }
})
