import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { ImportableSession, ImportedSession } from '../src/client/api.ts'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const session = (over: Partial<ImportableSession>): ImportableSession => ({
  source: 'claude',
  id: 'id',
  cwd: '/work/app',
  updatedAt: new Date().toISOString(),
  bytes: 2048,
  ...over,
})

test('sessions group by tool, then by project or folder, and search matches titles, first messages and folders', async () => {
  const { groupSessions } = await import('../src/client/chat/SessionImport.tsx')
  const sessions = [
    session({ id: 'a', title: 'Login bug', project: { id: 'app-1', name: 'App' } }),
    session({ id: 'b', source: 'codex', cwd: '/work/site', preview: 'Rename foo to bar' }),
    session({ id: 'c', preview: 'Plan the release', project: { id: 'app-1', name: 'App' } }),
    session({ id: 'd', cwd: '/elsewhere/tool' }),
  ]
  const all = groupSessions(sessions, '')
  expect(all.map((g) => g.source)).toEqual(['claude', 'codex'])
  expect(all[0]?.folders.map((f) => [f.name, f.sessions.map((s) => s.id)])).toEqual([
    ['App', ['a', 'c']],
    ['tool', ['d']],
  ])
  expect(
    groupSessions(sessions, 'rename').flatMap((g) => g.folders.flatMap((f) => f.sessions.map((s) => s.id))),
  ).toEqual(['b'])
  expect(groupSessions(sessions, 'codex site').map((g) => g.source)).toEqual(['codex'])
  expect(groupSessions(sessions, 'nothing like it')).toEqual([])
})

test('picking a session imports it and hands the import on; its transcript opens from a folded line', async () => {
  const imported: ImportedSession = {
    id: 'import-x-1',
    source: 'claude',
    sourceId: 'a',
    title: 'Login bug',
    cwd: '/work/app',
    updatedAt: '',
    importedAt: '',
    omitted: 2,
    turns: [
      { role: 'user', text: 'Fix the login bug' },
      { role: 'tool', tool: 'Bash', text: 'cat auth.ts', result: 'boom', error: true },
      { role: 'assistant', text: 'Fixed.' },
    ],
  }
  const posted: unknown[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith('/api/import-sessions') && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)))
      return Response.json(imported)
    }
    return Response.json({ sessions: [session({ id: 'a', title: 'Login bug' })] })
  }) as unknown as typeof fetch
  const { ImportSessions, ImportedTranscript } = await import('../src/client/chat/SessionImport.tsx')
  const got: ImportedSession[] = []
  const { host, unmount } = await mount(<ImportSessions onImported={(s) => got.push(s)} />)
  const doc = host.ownerDocument
  try {
    await act(async () => Bun.sleep(10))
    const row = [...doc.querySelectorAll('button')].find((b) => b.textContent?.includes('Login bug'))
    expect(row).toBeDefined()
    await act(async () => {
      row?.click()
      await Bun.sleep(10)
    })
    expect(posted).toEqual([{ source: 'claude', id: 'a' }])
    expect(got.map((s) => s.id)).toEqual(['import-x-1'])
  } finally {
    await unmount()
  }

  const shown = await mount(<ImportedTranscript session={imported} />)
  try {
    const text = () => shown.host.textContent ?? ''
    expect(text()).toContain('Imported from Claude Code')
    expect(text()).not.toContain('Fix the login bug')
    await act(async () => (shown.host.querySelector('button') as HTMLButtonElement).click())
    expect(text()).toContain('2 earlier messages left out')
    expect(text()).toContain('Fix the login bug')
    expect(text()).toContain('Failed: boom')
  } finally {
    await shown.unmount()
  }
})
