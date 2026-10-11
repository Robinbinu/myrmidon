import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { namingModel } from '../src/catalog.ts'
import type { OmpRuntime } from '../src/omp/runtime.ts'
import { SettingsStore, withoutModel } from '../src/settings.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'myr-small-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

// What omp lists on a Mac with Apple Intelligence: the on-device model, free (no price) and keyless.
const models = [
  { provider: 'openai', id: 'gpt-4o-mini', cost: { input: 0.15 }, contextWindow: 128_000 },
  { provider: 'anthropic', id: 'claude-opus-4-5', cost: { input: 5 }, contextWindow: 200_000 },
  { provider: 'apple', id: 'on-device', cost: { input: 0 }, contextWindow: 8192 },
]
const omp = { available: () => models } as unknown as OmpRuntime
const lead = 'anthropic/claude-opus-4-5'

test('small jobs go to the cheapest priced model until the person picks one: the on-device model is never swapped in', () => {
  const settings = new SettingsStore(home)
  expect(namingModel(omp, settings, lead)).toBe('openai/gpt-4o-mini')
  settings.set({ ...settings.get(), team: { ...settings.get().team, smallModel: 'apple/on-device' } })
  expect(namingModel(omp, settings, lead)).toBe('apple/on-device')
  // Hidden, or gone from what omp can call (Apple Intelligence turned off): the cheapest again.
  settings.set({ ...settings.get(), models: { ...settings.get().models, hiddenProviders: ['apple'] } })
  expect(namingModel(omp, settings, lead)).toBe('openai/gpt-4o-mini')
  const gone = { available: () => models.slice(0, 2) } as unknown as OmpRuntime
  settings.set({ ...settings.get(), models: { ...settings.get().models, hiddenProviders: [] } })
  expect(namingModel(gone, settings, lead)).toBe('openai/gpt-4o-mini')
  // Without settings (find's judge), the cheapest as before.
  expect(namingModel(omp, undefined, lead)).toBe('openai/gpt-4o-mini')
})

test('removing the small-jobs model sends small jobs back to the cheapest, and keeps the other new keys', () => {
  const settings = new SettingsStore(home)
  const s = settings.set({
    ...settings.get(),
    team: { ...settings.get().team, smallModel: 'apple/on-device' },
    memory: { suggest: true, embeddingModel: 'openai/text-embedding-3-small' },
    power: { keepAwake: true },
  })
  expect(s.memory.embeddingModel).toBe('openai/text-embedding-3-small')
  expect(s.power.keepAwake).toBe(true)
  expect(withoutModel(s, 'apple/on-device', true).settings.team.smallModel).toBeUndefined()
  // Defaults: no small-jobs model, no embeddings, the computer sleeps as usual.
  const fresh = new SettingsStore(mkdtempSync(join(home, 'fresh-'))).get()
  expect(fresh.team.smallModel).toBeUndefined()
  expect(fresh.memory).toEqual({ suggest: true })
  expect(fresh.power).toEqual({ keepAwake: false })
})
