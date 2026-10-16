import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootOmp, bootRuntime, ChatService, ModelResolver, pointOmpAt } from '../src/index.ts'
import { scopedOut } from '../src/model-scopes.ts'
import { completeSimple, type Model } from '../src/omp/ai.ts'
import { createMockModel } from '../src/omp/mock.ts'
import { SettingsStore } from '../src/settings.ts'

// Several keys per provider, through omp's own vault and rotation, against a local server standing in for the
// provider: the first key it sees is out of quota (429), any other answers. Nothing leaves the machine.

const home = mkdtempSync(join(tmpdir(), 'myr-keys-'))
pointOmpAt(home)
const seen: string[] = []
let origin = ''
let server: { stop(force?: boolean): void }
const realFetch = globalThis.fetch

beforeAll(() => {
  const s = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const key = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
      seen.push(key)
      if (key === seen[0])
        return Response.json(
          { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } },
          { status: 429, headers: { 'retry-after': '120' } },
        )
      const chunk = {
        id: 'c',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'ok' } }],
      }
      const done = {
        id: 'c',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    },
  })
  server = s as never
  origin = `http://127.0.0.1:${s.port}`
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(origin)) throw new Error(`a request left for ${url}`)
    return realFetch(input, init)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
})

test('several keys rotate per agent: a key out of quota rests, the agent moves to the next and stays on it', async () => {
  const omp = await bootOmp(home)
  try {
    await omp.addApiKey('deepseek', 'sk-first-key-aaaa')
    await omp.addApiKey('deepseek', 'sk-second-key-bbbb')
    expect(omp.keys().map((k) => [k.provider, k.hint])).toEqual([
      ['deepseek', 'aaaa'],
      ['deepseek', 'bbbb'],
    ])
    const resolver = new ModelResolver(omp)
    const base = resolver.resolve('deepseek/deepseek-v4-flash').model
    const model = {
      ...base,
      baseUrl: `${origin}${new URL(base.baseUrl).pathname.replace(/\/$/, '')}`,
    } as Model
    const ask = async (session: string) =>
      completeSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }, {
        apiKey: await resolver.requestKey(model, session),
        maxRetries: 0,
      } as never)
    const first = await ask('colony-1/lead')
    expect(first.stopReason).toBe('stop')
    // The first key answered 429; the call went on with the other one, unasked.
    expect(seen).toHaveLength(2)
    expect(seen[1]).not.toBe(seen[0])
    const resting = omp.keys().find((k) => seen[0]?.endsWith(k.hint))
    expect(resting?.restingUntil && Date.parse(resting.restingUntil)).toBeGreaterThan(Date.now())
    // The same agent stays on the key that answered; the resting one is not tried again.
    await ask('colony-1/lead')
    expect(seen.slice(2)).toEqual([seen[1] ?? ''])
    // A single key needs no rotation: it is sent as it is, as before.
    expect(await omp.removeKey('deepseek', resting?.id ?? -1)).toBe(true)
    expect(typeof (await resolver.requestKey(model, 'colony-1/lead'))).toBe('string')
    // Replacing the key replaces every key.
    await omp.setApiKey('deepseek', 'sk-replacement-cccc')
    expect(omp.keys().map((k) => k.hint)).toEqual(['cccc'])
  } finally {
    omp.close()
  }
})

test('a model kept for a project folder answers only chats in it or in a project inside it', () => {
  const scopes = { 'openai/gpt-work': '/Users/robin/work' }
  expect(scopedOut(scopes, 'openai/gpt-work', '/Users/robin/work')).toBeUndefined()
  expect(scopedOut(scopes, 'openai/gpt-work', '/Users/robin/work/api')).toBeUndefined()
  expect(scopedOut(scopes, 'openai/gpt-work', '/Users/robin/workshop')).toBe('/Users/robin/work')
  expect(scopedOut(scopes, 'openai/gpt-work', undefined)).toBe('/Users/robin/work')
  expect(scopedOut(scopes, 'anthropic/claude', '/tmp')).toBeUndefined()
})

test('a chat outside the folder a model is kept for is refused before it starts, and says where it is kept', async () => {
  const runtimeHome = mkdtempSync(join(tmpdir(), 'myr-scoped-'))
  const runtime = await bootRuntime(runtimeHome)
  try {
    const resolver = new ModelResolver()
    const mock = createMockModel({ handler: () => ({ content: ['ok'] }) })
    resolver.register('mock/work', { model: mock.model, streamFn: mock.stream })
    const settings = new SettingsStore(runtimeHome)
    settings.set({
      ...settings.get(),
      models: { ...settings.get().models, scoped: { 'mock/work': '/Users/robin/work' } },
    })
    const chats = new ChatService(runtime, { resolver, settings, classify: async () => 'answer' })
    const config = {
      mode: 'orchestrated' as const,
      leadModel: 'mock/work',
      roster: [],
      judgeModel: 'mock/work',
    }
    await expect(chats.send('hello', config)).rejects.toThrow(
      'mock/work is kept for chats in /Users/robin/work',
    )
    await chats.stopAll()
  } finally {
    await runtime.dispose()
    rmSync(runtimeHome, { recursive: true, force: true })
  }
})
