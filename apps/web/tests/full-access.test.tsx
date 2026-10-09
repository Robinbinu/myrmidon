import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

test('a new chat gets full access from its project, or from the sandbox being off unless the project is read-only', async () => {
  const { fullAccessFor } = await import('../src/client/chat/ProjectPermissions.tsx')
  expect(fullAccessFor('full', false)).toBe(true)
  expect(fullAccessFor('auto', false)).toBe(false)
  expect(fullAccessFor(undefined, false)).toBe(false)
  expect(fullAccessFor('ask', true)).toBe(true)
  expect(fullAccessFor(undefined, true)).toBe(true)
  expect(fullAccessFor('read-only', true)).toBe(false)
})

test('the setup assistant offers three choices; a project’s own permissions add Full access', async () => {
  const { PermissionChoices } = await import('../src/client/chat/ProjectPermissions.tsx')
  const radios = async (full: boolean) => {
    const { host, unmount } = await mount(
      <PermissionChoices mode="ask" onChange={() => {}} {...(full ? { full } : {})} />,
    )
    const values = [...host.querySelectorAll('input[type=radio]')].map((r) => (r as HTMLInputElement).value)
    await unmount()
    return values
  }
  expect(await radios(false)).toEqual(['auto', 'ask', 'read-only'])
  expect(await radios(true)).toEqual(['auto', 'ask', 'read-only', 'full'])
})

test('saving a project as Full access takes a second click, with the warning shown first', async () => {
  const sent: unknown[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')))
    return Response.json({ projects: [] })
  }) as unknown as typeof fetch
  const { ProjectPermissions } = await import('../src/client/chat/ProjectPermissions.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const project = {
    id: 'site-1',
    name: 'site',
    path: '/tmp/site',
    addedAt: '',
    permissions: { mode: 'ask' as const, allow: [] },
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
  try {
    await act(async () => {
      ;(doc.querySelector('input[value=full]') as HTMLInputElement).click()
    })
    await act(async () => button(copy.permissions.save).click())
    expect(sent).toEqual([])
    expect(doc.body.textContent).toContain(copy.fullAccess.warning)
    await act(async () => Bun.sleep(450))
    await act(async () => {
      button(copy.permissions.confirmFull).click()
      await Bun.sleep(10)
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ mode: 'full' })
    expect(closed).toBe(true)
  } finally {
    await unmount()
  }
})
