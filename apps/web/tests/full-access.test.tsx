import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

test('a project uses the global preset unless it has its own, and a read-only one stays read only', async () => {
  const { presetFor } = await import('../src/client/chat/ProjectPermissions.tsx')
  expect(presetFor(undefined, 'full')).toBe('full')
  expect(presetFor({ permissions: { rules: [] } }, 'auto')).toBe('auto')
  expect(presetFor({ permissions: { preset: 'ask', rules: [] } }, 'full')).toBe('ask')
  expect(presetFor({ permissions: { preset: 'read-only', rules: [] } }, 'full')).toBe('read-only')
})

test('the setup assistant offers "use global" and three presets; a project’s own permissions add Full access', async () => {
  const { PermissionChoices } = await import('../src/client/chat/ProjectPermissions.tsx')
  const { PresetChoice } = await import('../src/client/permissions/PresetChoice.tsx')
  const radios = async (ui: React.ReactNode) => {
    const { host, unmount } = await mount(ui)
    const values = [...host.querySelectorAll('input[type=radio]')].map((r) => (r as HTMLInputElement).value)
    await unmount()
    return values
  }
  expect(await radios(<PermissionChoices value={undefined} global="auto" onChange={() => {}} />)).toEqual([
    'inherit',
    'read-only',
    'ask',
    'auto',
  ])
  expect(
    await radios(
      <PresetChoice
        value={undefined}
        inherit={{ label: 'Use global', preset: 'auto' }}
        onChange={() => {}}
      />,
    ),
  ).toEqual(['inherit', 'read-only', 'ask', 'auto', 'full'])
})

test('choosing Full access for a project takes a second click, with the warning shown first', async () => {
  const sent: { method: string; body: unknown }[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) })
    return Response.json({ projects: [] })
  }) as unknown as typeof fetch
  const { ProjectPermissions } = await import('../src/client/chat/ProjectPermissions.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const project = {
    id: 'site-1',
    name: 'site',
    path: '/tmp/site',
    addedAt: '',
    permissions: { preset: 'ask' as const, rules: [] },
  }
  let closed = false
  const { host, unmount } = await mount(
    <MotionConfig reducedMotion="always">
      <ProjectPermissions project={project} onClose={() => (closed = true)} onSaved={() => {}} />
    </MotionConfig>,
  )
  const doc = host.ownerDocument
  const button = (text: string) =>
    [...doc.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement
  const puts = () => sent.filter((r) => r.method === 'PUT')
  try {
    await act(async () => {
      ;(doc.querySelector('input[value=full]') as HTMLInputElement).click()
    })
    // Not chosen yet: the warning asks first, and the saved preset is still Ask.
    expect(doc.body.textContent).toContain(copy.fullAccess.warning)
    expect((doc.querySelector('input[value=ask]') as HTMLInputElement).checked).toBe(false)
    await act(async () => button(copy.permissions.confirmFull).click())
    expect((doc.querySelector('input[value=full]') as HTMLInputElement).checked).toBe(true)
    expect(puts()).toEqual([])
    await act(async () => {
      button(copy.permissions.save).click()
      await Bun.sleep(10)
    })
    expect(puts()).toHaveLength(1)
    expect(puts()[0]?.body).toMatchObject({ preset: 'full' })
    expect(closed).toBe(true)
  } finally {
    await unmount()
  }
})
