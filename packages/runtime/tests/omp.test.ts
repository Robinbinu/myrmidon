import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootOmp, ModelResolver, pointOmpAt } from '../src/index.ts'

const home = mkdtempSync(join(tmpdir(), 'myr-omp-'))
pointOmpAt(home)
afterAll(() => rmSync(home, { recursive: true, force: true }))

test('custom providers go to models.yml, keys to the vault, and models resolve through omp', async () => {
  const omp = await bootOmp(home)
  const resolver = new ModelResolver(omp)
  expect(() => resolver.resolve('lmstudio/qwen3-8b')).toThrow('unknown model')

  const info = await omp.addProvider({
    name: 'lmstudio',
    baseUrl: 'http://localhost:1234/v1/',
    api: 'openai-completions',
    apiKey: 'local-key-123456',
    models: ['qwen3-8b'],
  })
  expect(info).toMatchObject({ id: 'lmstudio', custom: true, ready: true, models: 1 })
  const yml = join(home, 'agent', 'models.yml')
  expect(readFileSync(yml, 'utf8')).toContain('http://localhost:1234/v1')
  expect(statSync(yml).mode & 0o777).toBe(0o600)

  const { model } = resolver.resolve('lmstudio/qwen3-8b')
  expect(model.baseUrl).toBe('http://localhost:1234/v1')
  expect(await resolver.apiKey(model)).toBe('local-key-123456')

  const edited = await omp.updateProvider('lmstudio', {
    baseUrl: 'http://localhost:4321/v1',
    api: 'openai-completions',
    keyless: false,
    models: ['qwen3-8b', 'gemma-3'],
  })
  expect(edited).toMatchObject({
    baseUrl: 'http://localhost:4321/v1',
    modelIds: ['qwen3-8b', 'gemma-3'],
    hasKey: true,
  })
  expect(await resolver.apiKey(resolver.resolve('lmstudio/gemma-3').model)).toBe('local-key-123456')
  await expect(
    omp.addProvider({ name: 'lmstudio', baseUrl: 'http://x', api: 'openai-completions', models: [] }),
  ).rejects.toThrow('already exists')

  await omp.removeProvider('lmstudio')
  expect(omp.providers().some((p) => p.id === 'lmstudio')).toBe(false)
  expect(() => resolver.resolve('lmstudio/qwen3-8b')).toThrow('unknown model')
})

test('search providers come from omp', async () => {
  const omp = await bootOmp(home)
  const ids = omp.searchProviders().map((p) => p.id)
  expect(ids).toContain('duckduckgo')
  expect(ids.length).toBeGreaterThan(10)
})
