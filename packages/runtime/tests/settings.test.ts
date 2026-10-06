import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelResolver, parseColonySpec, SettingsStore, toolsFor } from '../src/index.ts'

function home() {
  return mkdtempSync(join(tmpdir(), 'myr-settings-'))
}

test('settings validate, persist, and keep API keys in a private file', () => {
  const dir = home()
  try {
    const store = new SettingsStore(dir)
    expect(store.get().team.wallMinutes).toBe(30)
    expect(store.get().tools.shell).toBe(true)
    expect(() => store.set({ team: { workers: 99 } })).toThrow()
    const saved = store.set({
      team: { mode: 'manual', workers: 2, wallMinutes: 10 },
      tools: { shell: false },
      models: {
        providers: [
          {
            name: 'lmstudio',
            api: 'openai-completions',
            baseUrl: 'http://localhost:1234/v1',
            auth: 'none',
            models: [{ id: 'qwen3-8b' }],
          },
        ],
      },
    })
    expect(saved.tools.shell).toBe(false)
    expect(saved.tools.web).toBe(true)
    store.setApiKey('anthropic', 'sk-ant-test-0123456789')
    expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600)
    const reloaded = new SettingsStore(dir)
    expect(reloaded.get().team.workers).toBe(2)
    expect(reloaded.apiKey('anthropic')).toBe('sk-ant-test-0123456789')
    expect(reloaded.configuredProviders()).toEqual(['anthropic'])
    expect(JSON.stringify(reloaded.get())).not.toContain('sk-ant')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('custom providers from settings resolve, and saved keys win over other sources', async () => {
  const dir = home()
  try {
    const store = new SettingsStore(dir)
    store.set({
      models: {
        providers: [
          {
            name: 'lmstudio',
            api: 'openai-completions',
            baseUrl: 'http://localhost:1234/v1',
            auth: 'none',
            models: [{ id: 'qwen3-8b', name: 'Qwen3 8B' }],
          },
        ],
      },
    })
    const resolver = new ModelResolver(store)
    const { model } = resolver.resolve('lmstudio/qwen3-8b')
    expect(model.baseUrl).toBe('http://localhost:1234/v1')
    expect(await resolver.apiKey(model)).toBe('none')
    store.setApiKey('lmstudio', 'local-key-123456')
    expect(await resolver.apiKey(model)).toBe('local-key-123456')
    expect(() => resolver.resolve('lmstudio/missing')).toThrow('unknown model')
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
