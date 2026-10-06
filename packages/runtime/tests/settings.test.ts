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
