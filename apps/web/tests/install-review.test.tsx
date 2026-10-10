import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const PREVIEW = {
  id: 'r1',
  name: 'lint-kit',
  version: '1.0.0',
  source: 'https://github.com/acme/lint-kit',
  kind: 'git',
  commit: 'abcdef1234567890',
  server: 'server/index.ts',
  hooks: 2,
  mcpServers: ['linter'],
  skills: [],
  commands: ['lint'],
  dependencies: [],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

const buttonNamed = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement

async function review() {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(String(input), 'http://x').pathname}`)
    return Response.json({ plugin: { name: 'lint-kit' }, ok: true })
  }) as unknown as typeof fetch
  const { InstallReview } = await import('../src/client/installs.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const done: string[] = []
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <ToastProvider>
        <InstallReview
          review={{ kind: 'plugin', preview: PREVIEW }}
          onClose={() => done.push('closed')}
          onInstalled={() => done.push('installed')}
        />
      </ToastProvider>
    </MotionConfig>,
  )
  return { view, calls, done }
}

test('the review says what runs as the person, and only Install installs', async () => {
  const { view, calls, done } = await review()
  const text = document.body.textContent ?? ''
  expect(text).toContain('Install lint-kit?')
  expect(text).toContain('Server code (server/index.ts)')
  expect(text).toContain('2 hooks')
  expect(text).toContain('MCP server: linter')
  expect(text).toContain('abcdef1234567890')
  expect(calls).toEqual([])
  await act(async () => {
    buttonNamed('Install').click()
    await Bun.sleep(10)
  })
  expect(calls).toEqual(['POST /api/plugin-installs/r1'])
  expect(done).toEqual(['installed'])
  await view.unmount()
})

test('cancelling drops the fetched copy and installs nothing', async () => {
  const { view, calls, done } = await review()
  await act(async () => {
    buttonNamed('Cancel').click()
    await Bun.sleep(10)
  })
  expect(calls).toEqual(['DELETE /api/plugin-installs/r1'])
  expect(done).toEqual(['closed'])
  await view.unmount()
})
