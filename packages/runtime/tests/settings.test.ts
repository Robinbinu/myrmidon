import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseColonySpec, SettingsStore, toolsFor, withoutModel } from '../src/index.ts'

function home() {
  return mkdtempSync(join(tmpdir(), 'myr-settings-'))
}

test('settings validate and persist, and never hold credentials', () => {
  const dir = home()
  try {
    const store = new SettingsStore(dir)
    expect(store.get().team.wallMinutes).toBe(30)
    expect(store.get().permissions).toEqual({ preset: 'auto', rules: [] })
    expect(store.get().search.provider).toBe('auto')
    expect(() => store.set({ team: { workers: 99 } })).toThrow()
    expect(() => store.set({ search: { provider: 'Not A Provider!' } })).toThrow()
    const saved = store.set({
      team: { mode: 'manual', workers: 2, wallMinutes: 10 },
      tools: { shell: false },
      search: { provider: 'brave' },
      apiKeys: { anthropic: 'sk-ant-test-0123456789' },
    })
    // The old group switch still reads: shell off for the lead and the crew alike.
    expect(saved.permissions.access).toEqual({ lead: { shell: false }, crew: { shell: false } })
    const reloaded = new SettingsStore(dir)
    expect(reloaded.get().team.workers).toBe(2)
    expect(reloaded.get().search.provider).toBe('brave')
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).not.toContain('sk-ant')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings from before the permission model load without losing a choice', () => {
  const dir = home()
  try {
    // The shape every saved file had: sandbox on (the default, written whether chosen or not) and per-tool rules.
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        sandbox: { enabled: true, read: ['~/docs'] },
        tools: { shell: true, web: false, files: true, messaging: true, mcp: true, browser: true },
        permissions: { fs_write: 'ask', mcp: 'allow', mcp__gh_delete: 'off' },
      }),
    )
    const s = new SettingsStore(dir).get()
    expect(s.permissions).toEqual({
      preset: 'auto',
      rules: [
        { kind: 'tool', target: 'fs_write', decision: 'ask' },
        { kind: 'mcp-server', target: '*', decision: 'allow' },
        { kind: 'mcp-tool', target: 'mcp__gh_delete', decision: 'deny' },
      ],
      access: { lead: { web: false }, crew: { web: false } },
    })
    expect(s.sandbox).toEqual({ read: ['~/docs'] })
    // Turning the sandbox off took a confirmation: that person keeps Full access.
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ sandbox: { enabled: false }, permissions: {} }),
    )
    const full = new SettingsStore(dir)
    expect(full.get().permissions.preset).toBe('full')
    // Saved again in the new shape, it stays Full access, and the old switch is gone from the file.
    full.set(full.get())
    expect(new SettingsStore(dir).get().permissions.preset).toBe('full')
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).sandbox).toEqual({})
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

test('removing a model takes it out of every default, hiding it or forgetting it with its context window', () => {
  const dir = home()
  try {
    const store = new SettingsStore(dir)
    const s = store.set({
      ...store.get(),
      team: { ...store.get().team, leadModel: 'a/x', workerModel: 'a/x', judgeModel: 'b/y' },
      voice: { ...store.get().voice, callModel: 'a/x' },
      models: { hidden: ['c/z'], hiddenProviders: [], windows: { 'a/x': 64_000 } },
    })
    const hidden = withoutModel(s, 'a/x', true)
    expect(hidden.cleared).toEqual(['lead', 'crewmates', 'call'])
    expect(hidden.settings.team.leadModel).toBeUndefined()
    expect(hidden.settings.team.workerModel).toBeUndefined()
    expect(hidden.settings.team.judgeModel).toBe('b/y')
    expect(hidden.settings.voice.callModel).toBeUndefined()
    expect(hidden.settings.models.hidden).toEqual(['c/z', 'a/x'])
    // Restoring a hidden model brings back the window the person set for it.
    expect(hidden.settings.models.windows['a/x']).toBe(64_000)
    // The result is valid settings, and the input is left as it was.
    expect(store.set(hidden.settings).team.leadModel).toBeUndefined()
    expect(s.team.leadModel).toBe('a/x')

    const deleted = withoutModel(s, 'a/x', false)
    expect(deleted.settings.models.hidden).toEqual(['c/z'])
    expect(deleted.settings.models.windows['a/x']).toBeUndefined()
    expect(withoutModel(s, 'b/y', true).cleared).toEqual(['reviewer'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mascot settings from before liveliness, crew, screen and sounds keep their look and gain the defaults', () => {
  const dir = home()
  try {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ mascot: { eyes: 'lashes', look: 'bow', color: 'violet', screen: 'clock' } }),
    )
    const { mascot, appearance } = new SettingsStore(dir).get()
    expect(mascot).toEqual({
      eyes: 'lashes',
      look: 'bow',
      color: 'violet',
      screen: 'clock',
      idle: 'normal',
      shows: { pacman: true, life: true, confetti: true, boot: true },
      temper: 'playful',
      crew: { show: true, count: 3, names: 'minions', custom: [], boldness: 'curious' },
      display: { dots: 'led', grid: 'faint', glow: 'soft', eyeColor: 'own', size: 'medium' },
      sounds: { enabled: false, reactions: true, typing: true, volume: 'quiet' },
    })
    expect(appearance).toEqual({ imported: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mascot settings are checked: the crew count, its names, and every choice', () => {
  const dir = home()
  try {
    const store = new SettingsStore(dir)
    expect(() => store.set({ mascot: { crew: { count: 0 } } })).toThrow()
    expect(() => store.set({ mascot: { crew: { count: 7 } } })).toThrow()
    expect(() => store.set({ mascot: { display: { dots: 'hexagon' } } })).toThrow()
    expect(() => store.set({ mascot: { crew: { custom: ['a-name-far-too-long-for-a-tag'] } } })).toThrow()
    const saved = store.set({ mascot: { crew: { names: 'custom', custom: [' Ada ', 'Ada', 'Grace', ''] } } })
    expect(saved.mascot.crew.custom).toEqual(['Ada', 'Grace'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('imported themes keep only hex colours, under keys and roles that can be colours', () => {
  const dir = home()
  try {
    const store = new SettingsStore(dir)
    const theme = {
      id: 'imported-abc123',
      name: ' Mine ',
      type: 'dark' as const,
      colors: { 'editor.background': '#101010', 'editor.foreground': '#eeeeee' },
      syntax: { keyword: '#ff00ff' },
    }
    expect(() =>
      store.set({ appearance: { imported: [{ ...theme, colors: { 'editor.background': 'url(x)' } }] } }),
    ).toThrow()
    expect(() =>
      store.set({ appearance: { imported: [{ ...theme, colors: { 'editor.background': 'red' } }] } }),
    ).toThrow()
    expect(() => store.set({ appearance: { imported: [{ ...theme, id: '../etc' }] } })).toThrow()
    const saved = store.set({
      appearance: {
        imported: [
          {
            ...theme,
            colors: { ...theme.colors, 'bad key!': '#000000' },
            syntax: { ...theme.syntax, oops: '#000' },
          },
          theme,
        ],
      },
    })
    // The same id twice is one theme, the later one.
    expect(saved.appearance.imported).toEqual([{ ...theme, name: 'Mine' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
