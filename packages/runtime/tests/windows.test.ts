import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model } from '@oh-my-pi/pi-ai'
import { withOllamaContext } from '../src/models.ts'
import { ContextWindows, normalizeModelId, windowFromName } from '../src/windows.ts'

const API = {
  volcengine: {
    models: {
      'doubao-seed-1-6-251015': { limit: { context: 256_000, output: 64_000 } },
      'deepseek-v4-flash-ga-260731': { limit: { context: 1_000_000, output: 384_000 } },
    },
  },
  'nano-gpt': { models: { 'doubao-1.5-pro-32k': { limit: { context: 32_000 } } } },
  qiniu: { models: { 'doubao-1.5-pro-32k': { limit: { context: 128_000 } } } },
  hostA: { models: { 'vendor/thing-7b-0731': { limit: { context: 65_536, input: 60_000 } } } },
  hostB: { models: { 'thing-7b': { limit: { context: 65_536, input: 60_000 } } } },
  broken: { models: { nope: { limit: {} } } },
}

async function loaded(overrides: Record<string, number> = {}) {
  const windows = new ContextWindows({
    cacheFile: join(mkdtempSync(join(tmpdir(), 'myr-windows-')), 'windows.json'),
    overrides: () => overrides,
    fetch: (async () => new Response(JSON.stringify(API))) as unknown as typeof fetch,
  })
  await windows.load()
  return { windows }
}

test('model ids from different hosts normalize to the same name, and sizes in names are read', () => {
  expect(normalizeModelId('deepseek/DeepSeek-V4.1-Flash:thinking')).toBe('deepseek-v4-1-flash')
  expect(normalizeModelId('doubao-1-5-pro-32k-250115')).toBe('doubao-1-5-pro-32k')
  expect(windowFromName('doubao-1-5-lite-32k-250115')).toBe(32_000)
  expect(windowFromName('ernie-4.0-8k-latest')).toBe(8_000)
  expect(windowFromName('qwen-7b')).toBeUndefined()
})

test("omp's own windows stand; its 128k guess is replaced by the host's entry, the name, or other hosts", async () => {
  const { windows } = await loaded()
  // Known to omp: kept, whatever models.dev says.
  expect(windows.of({ provider: 'apple', id: 'on-device', contextWindow: 8_192 })).toEqual({
    tokens: 8_192,
    source: 'provider',
  })
  // omp's 128k default on Ark: models.dev lists Ark as volcengine.
  expect(windows.of({ provider: 'ark', id: 'doubao-seed-1-6-251015', contextWindow: 128_000 })).toEqual({
    tokens: 256_000,
    source: 'catalog',
  })
  // Not listed for its host, but its name says 32k, which beats hosts that disagree.
  expect(windows.of({ provider: 'ark', id: 'doubao-1-5-pro-32k-250115', contextWindow: 128_000 })).toEqual({
    tokens: 32_000,
    source: 'name',
  })
  // Listed by other hosts under other spellings: their input limit.
  expect(windows.of({ provider: 'custom', id: 'thing-7b', contextWindow: 128_000 })).toEqual({
    tokens: 60_000,
    source: 'catalog',
  })
  // Nothing anywhere: omp's guess, marked as no source.
  expect(windows.of({ provider: 'custom', id: 'mystery', contextWindow: 128_000 })).toEqual({
    tokens: 128_000,
  })
})

test("the person's own window wins, and resolved models carry the window to use", async () => {
  const { windows } = await loaded({ 'apple/on-device': 4_096 })
  expect(windows.of({ provider: 'apple', id: 'on-device', contextWindow: 8_192 })).toEqual({
    tokens: 4_096,
    source: 'set',
  })
  const model = { provider: 'ark', id: 'deepseek-v4-flash-ga-260731', contextWindow: 128_000 } as Model
  expect(windows.apply(model).contextWindow).toBe(1_000_000)
})

test('the models.dev index is cached and not fetched again within a day', async () => {
  const cacheFile = join(mkdtempSync(join(tmpdir(), 'myr-windows-')), 'windows.json')
  let fetched = 0
  const make = () =>
    new ContextWindows({
      cacheFile,
      fetch: (async () => {
        fetched += 1
        return new Response(JSON.stringify(API))
      }) as unknown as typeof fetch,
    })
  await make().load()
  const again = make()
  await again.load()
  expect(fetched).toBe(1)
  expect(again.of({ provider: 'ark', id: 'doubao-seed-1-6-251015', contextWindow: 128_000 }).tokens).toBe(
    256_000,
  )
})

test('an unreachable models.dev leaves omp and name hints working', async () => {
  const windows = new ContextWindows({
    fetch: (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch,
  })
  await windows.load()
  expect(
    windows.of({ provider: 'ark', id: 'doubao-1-5-lite-32k-250115', contextWindow: 128_000 }).tokens,
  ).toBe(32_000)
})

test('Ollama requests ask for room for their prompt, in power-of-two steps, within the window', async () => {
  const ollama = { api: 'ollama-chat', contextWindow: 32_768 } as Model
  const sized = withOllamaContext(ollama, {})
  const small = (await sized?.onPayload?.({ messages: ['hi'] })) as { options: { num_ctx: number } }
  expect(small.options.num_ctx).toBe(16_384)
  const big = (await sized?.onPayload?.({ messages: ['x'.repeat(200_000)] })) as {
    options: { num_ctx: number }
  }
  expect(big.options.num_ctx).toBe(32_768)
  const other = {}
  expect(withOllamaContext({ api: 'openai-completions' } as Model, other)).toBe(other)
})
