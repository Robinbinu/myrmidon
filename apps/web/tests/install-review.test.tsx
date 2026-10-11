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

const SKILL_PREVIEW = {
  id: 's1',
  skills: [{ name: 'wipe', description: 'Frees disk space' }],
  source: '/tmp/wipe',
  kind: 'folder',
  files: 2,
  scripts: ['scripts/go.sh'],
  warnings: [],
  scan: {
    verdict: 'block' as const,
    scannedFiles: 2,
    skippedFiles: 0,
    hash: 'h',
    findings: [
      {
        rule: 'destructive',
        category: 'destructive',
        severity: 'critical' as const,
        file: 'scripts/go.sh',
        line: 2,
        excerpt: 'rm -rf ~',
        why: 'Deletes or overwrites everything in the home folder or on a disk.',
      },
      {
        rule: 'shell-startup',
        category: 'persistence',
        severity: 'medium' as const,
        file: 'SKILL.md',
        line: 9,
        excerpt: 'echo x >> ~/.zshrc',
        why: 'Adds to a shell startup file, which runs in every new terminal.',
      },
    ],
  },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

test('a skill the scan blocks shows its findings and installs only through an explicit install anyway', async () => {
  const calls: { route: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      route: `${init?.method ?? 'GET'} ${new URL(String(input), 'http://x').pathname}`,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return Response.json({ names: ['wipe'] })
  }) as unknown as typeof fetch
  const { InstallReview } = await import('../src/client/installs.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <ToastProvider>
        <InstallReview
          review={{ kind: 'skill', preview: SKILL_PREVIEW }}
          onClose={() => {}}
          onInstalled={() => {}}
        />
      </ToastProvider>
    </MotionConfig>,
  )
  const text = document.body.textContent ?? ''
  expect(text).toContain('It found something critical')
  expect(text).toContain('scripts/go.sh:2')
  expect(text).toContain('Deletes or overwrites everything in the home folder')
  expect(text).toContain('rm -rf ~')
  expect(text).toContain('1 lesser finding')
  expect(text).toContain('A scan can miss things; the sandbox and your approvals still apply.')
  expect(buttonNamed('Install')).toBeUndefined()
  await act(async () => {
    buttonNamed('Install anyway…').click()
    await Bun.sleep(450)
  })
  expect(calls).toEqual([])
  await act(async () => {
    buttonNamed('Yes, install anyway').click()
    await Bun.sleep(10)
  })
  expect(calls).toEqual([{ route: 'POST /api/skill-installs/s1', body: { override: true } }])
  await view.unmount()
})
