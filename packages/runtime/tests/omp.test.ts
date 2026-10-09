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

test('signing out keeps an API key stored for the same provider', async () => {
  const omp = await bootOmp(home)
  await omp.setApiKey('anthropic', 'sk-ant-test-123456')
  expect(omp.providers().find((p) => p.id === 'anthropic')?.stored).toBe(true)
  expect(omp.logins().find((l) => l.provider === 'anthropic')?.signedIn).toBe(false)

  await omp.signOut('anthropic')
  expect(omp.providers().find((p) => p.id === 'anthropic')?.stored).toBe(true)

  await omp.removeCredentials('anthropic')
  expect(omp.providers().find((p) => p.id === 'anthropic')?.stored).toBe(false)
})

test("a custom endpoint's model can be deleted from its list, but not its only one or a built-in provider's", async () => {
  const omp = await bootOmp(home)
  await omp.addProvider({
    name: 'localai',
    baseUrl: 'http://localhost:1235/v1',
    api: 'openai-completions',
    apiKey: 'local-key-123456',
    models: ['qwen3-8b', 'gemma-3'],
  })
  try {
    expect(await omp.removeModel('localai', 'qwen3-8b')).toBe(true)
    expect(omp.providers().find((p) => p.id === 'localai')?.modelIds).toEqual(['gemma-3'])
    expect(omp.find('localai', 'qwen3-8b')).toBeUndefined()
    // An empty list would make the endpoint discover its models, bringing every one back: only hiding works.
    expect(await omp.removeModel('localai', 'gemma-3')).toBe(false)
    expect(await omp.removeModel('localai', 'missing')).toBe(false)
    expect(omp.providers().find((p) => p.id === 'localai')?.modelIds).toEqual(['gemma-3'])
    const builtIn = omp.all().find((m) => m.provider === 'anthropic')
    expect(builtIn).toBeDefined()
    expect(await omp.removeModel('anthropic', builtIn?.id ?? '')).toBe(false)
  } finally {
    await omp.removeProvider('localai')
  }
})

test("voice providers' keys live in the same vault as the model providers', and share a model provider's key", async () => {
  const omp = await bootOmp(home)
  const keys = omp.voiceKeys
  await keys.set('deepgram', ' dg-key-123 ')
  expect(await keys.get('deepgram')).toBe('dg-key-123')
  expect(keys.stored('deepgram')).toBe(true)
  // A voice-only key does not make a model provider appear.
  expect(omp.providers().some((p) => p.id === 'deepgram')).toBe(false)
  // OpenAI's voice reads the key added for OpenAI's models.
  await omp.setApiKey('openai', 'sk-openai-voice-test')
  expect(await keys.get('openai')).toBe('sk-openai-voice-test')
  await keys.remove('deepgram')
  expect(keys.stored('deepgram')).toBe(false)
  expect(await keys.get('deepgram')).toBeUndefined()
  await omp.removeCredentials('openai')
  await expect(keys.set('Not An Id', 'k')).rejects.toThrow('invalid provider id')
})
