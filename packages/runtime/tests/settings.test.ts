import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseColonySpec, SettingsStore, toolsFor } from '../src/index.ts'

function home() {
  return mkdtempSync(join(tmpdir(), 'myr-settings-'))
}

test('settings validate and persist, and never hold credentials', () => {
  const dir = home()
  try {
    const store = new SettingsStore(dir)
    expect(store.get().team.wallMinutes).toBe(30)
    expect(store.get().tools.shell).toBe(true)
    expect(store.get().search.provider).toBe('auto')
    expect(() => store.set({ team: { workers: 99 } })).toThrow()
    expect(() => store.set({ search: { provider: 'Not A Provider!' } })).toThrow()
    const saved = store.set({
      team: { mode: 'manual', workers: 2, wallMinutes: 10 },
      tools: { shell: false },
      search: { provider: 'brave' },
      apiKeys: { anthropic: 'sk-ant-test-0123456789' },
    })
    expect(saved.tools.shell).toBe(false)
    expect(saved.tools.web).toBe(true)
    const reloaded = new SettingsStore(dir)
    expect(reloaded.get().team.workers).toBe(2)
    expect(reloaded.get().search.provider).toBe('brave')
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).not.toContain('sk-ant')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('disabled tools are removed from every agent', () => {
  const spec = parseColonySpec({
    name: 'T',
    mission: 'm',
    pattern: 'lead-workers',
    agents: [{ name: 'lead', role: 'lead', model: 'x/y' }],
  })
  expect(toolsFor(spec, spec.agents[0] as never)).toContain('shell')
  const restricted = { ...spec, disabledTools: ['shell', 'web_search', 'web_fetch'] }
  const tools = toolsFor(restricted, restricted.agents[0] as never)
  expect(tools).not.toContain('shell')
  expect(tools).not.toContain('web_search')
  expect(tools).toContain('publish_artifact')
})

test('a quick answer in a project chat can read the project but not change it', () => {
  const base = parseColonySpec({ name: 'T', mission: 'm', agents: [{ name: 'lead', model: 'x/y' }] })
  const chat = { chatId: 'chat-a', round: 1, request: 'what files are here?', history: '' }
  const answer = { ...base, tier: 'answer' as const, chat }
  expect(toolsFor(answer, base.agents[0] as never)).not.toContain('fs_read')
  const inProject = { ...answer, chat: { ...chat, project: { id: 'p', name: 'p', path: '/tmp/p' } } }
  const tools = toolsFor(inProject, base.agents[0] as never)
  expect(tools).toContain('fs_read')
  expect(tools).toContain('fs_list')
  expect(tools).not.toContain('fs_write')
  expect(tools).not.toContain('shell')
})

test('the reviewer is on auto unless the person turns it off or on for every answer', () => {
  const dir = home()
  try {
    const store = new SettingsStore(dir)
    expect(store.get().verification.reviewer).toBe('auto')
    store.set({ ...store.get(), verification: { ...store.get().verification, reviewer: 'off' } })
    expect(new SettingsStore(dir).get().verification.reviewer).toBe('off')
    expect(() =>
      store.set({
        ...store.get(),
        verification: { ...store.get().verification, reviewer: 'sometimes' as never },
      }),
    ).toThrow()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
