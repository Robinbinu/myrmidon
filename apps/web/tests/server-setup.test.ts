import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ChatService,
  canLeadACrew,
  detectSetup,
  firstSetup,
  ProjectStore,
  SettingsStore,
} from '@myrmidon/runtime'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
const fakes: { stop(): unknown }[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const f of fakes.splice(0)) f.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'myr-setup-'))
  homes.push(dir)
  return dir
}

/** An Ollama stand-in on a free port: it lists models the way Ollama's OpenAI-compatible API does. */
function fakeOllama(models: string[]) {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) =>
      new URL(req.url).pathname === '/v1/models'
        ? Response.json({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) })
        : new Response('not found', { status: 404 }),
  })
  fakes.push(server)
  return `http://127.0.0.1:${server.port}/v1`
}

/** A port nothing listens on: a server is started and stopped again to find one. */
function deadPort() {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
  const port = server.port
  server.stop(true)
  return `http://127.0.0.1:${port}/v1`
}

function client(server: WebServer) {
  const base = server.url.replace(/#.*$/, '')
  return async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(new URL(path, base), {
      method,
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: (await res.json()) as T }
  }
}

test('detect finds provider keys in the environment by name only, and model servers answering on this computer', async () => {
  const ollama = fakeOllama(['llama3.2', 'qwen3:8b'])
  const found = await detectSetup({
    providers: [
      { id: 'openai', models: 12, ready: true, custom: false },
      { id: 'anthropic', models: 9, ready: false, custom: false },
    ],
    env: { ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-secret', GROQ_API_KEY: '   ' },
    servers: [
      { id: 'ollama', baseUrl: ollama, provider: 'ollama-local' },
      { id: 'lm-studio', baseUrl: deadPort(), provider: 'lmstudio' },
    ],
    timeoutMs: 500,
  })
  expect(found.ready).toEqual([{ id: 'openai', models: 12 }])
  // A blank variable is no key; a key's value never leaves the server.
  expect(found.env).toEqual([
    { provider: 'anthropic', variable: 'ANTHROPIC_API_KEY', ready: false },
    { provider: 'openai', variable: 'OPENAI_API_KEY', ready: true },
  ])
  expect(JSON.stringify(found)).not.toContain('secret')
  expect(found.local).toEqual([
    {
      id: 'ollama',
      baseUrl: ollama,
      provider: 'ollama-local',
      models: ['llama3.2', 'qwen3:8b'],
      added: false,
    },
  ])
})

test('a model server already added as a provider is said to be added', async () => {
  const ollama = fakeOllama(['llama3.2'])
  const found = await detectSetup({
    providers: [{ id: 'my-ollama', models: 1, ready: true, custom: true, baseUrl: `${ollama}/` }],
    env: {},
    servers: [{ id: 'ollama', baseUrl: ollama, provider: 'ollama-local' }],
  })
  expect(found.local[0]?.added).toBe(true)
})

test("omp's own provider for a local server is offered once, as that server", async () => {
  const ollama = fakeOllama(['llama3.2'])
  const found = await detectSetup({
    providers: [
      { id: 'ollama', models: 1, ready: true, custom: false },
      { id: 'openai', models: 3, ready: true, custom: false },
    ],
    env: {},
    servers: [{ id: 'ollama', baseUrl: ollama, provider: 'ollama-local' }],
  })
  expect(found.local).toMatchObject([{ id: 'ollama', provider: 'ollama', added: true }])
  expect(found.ready.map((p) => p.id)).toEqual(['openai'])
})

test('only a model the person connected, or a chat, makes an install count as set up already', () => {
  const now = new Date('2026-10-09T10:00:00Z')
  expect(firstSetup({ chats: 0, modelConnected: false }, now)).toEqual({ steps: {} })
  expect(firstSetup({ chats: 2, modelConnected: false }, now).finishedAt).toBe(now.toISOString())
  expect(firstSetup({ chats: 0, modelConnected: true }, now).finishedAt).toBe(now.toISOString())
  // An on-device model with a small window cannot lead a crew; one whose window is not known may.
  expect(canLeadACrew([{ contextWindow: 4096 }])).toBe(false)
  expect(canLeadACrew([{ contextWindow: 4096 }, {}])).toBe(true)
  expect(canLeadACrew([])).toBe(false)
})

test('GET /api/setup/detect answers with what the page can offer, from the servers it was told to look at', async () => {
  const ollama = fakeOllama(['llama3.2'])
  const previous = process.env.MISTRAL_API_KEY
  process.env.MISTRAL_API_KEY = 'mistral-secret'
  try {
    const server = startServer({
      home: home(),
      port: 0,
      setupServers: [{ id: 'ollama', baseUrl: ollama, provider: 'ollama-local' }],
    })
    servers.push(server)
    const { status, body } = await client(server)<{
      env: { variable: string }[]
      local: { id: string; models: string[] }[]
    }>('GET', '/api/setup/detect')
    expect(status).toBe(200)
    expect(body.env.map((e) => e.variable)).toContain('MISTRAL_API_KEY')
    expect(body.local).toMatchObject([{ id: 'ollama', models: ['llama3.2'] }])
    expect(JSON.stringify(body)).not.toContain('mistral-secret')
  } finally {
    if (previous === undefined) delete process.env.MISTRAL_API_KEY
    else process.env.MISTRAL_API_KEY = previous
  }
})

test('a new install starts setup at the beginning; marks, finishing and starting again are kept', async () => {
  const dir = home()
  const settings = new SettingsStore(dir)
  const server = startServer({ home: dir, port: 0, settings })
  servers.push(server)
  const call = client(server)
  type Answer = {
    setup: { finishedAt?: string; steps: Record<string, string> }
    have: Record<string, boolean>
  }
  const first = await call<Answer>('GET', '/api/setup')
  expect(first.body.setup).toEqual({ steps: {} })
  expect(first.body.have.models).toBe(false)
  await call('PUT', '/api/setup', { step: 'welcome', mark: 'done' })
  const later = await call<Answer>('PUT', '/api/setup', { step: 'models', mark: 'later' })
  expect(later.body.setup.steps).toEqual({ welcome: 'done', models: 'later' })
  expect((await call('PUT', '/api/setup', { step: 'nope', mark: 'done' })).status).toBe(400)
  expect((await call('PUT', '/api/setup', { step: 'you', mark: 'maybe' })).status).toBe(400)

  // Saving settings from a page that read them before setup moved on keeps setup where it is.
  const stale = await call<{ settings: Record<string, unknown> }>('GET', '/api/settings')
  await call('PUT', '/api/setup', { step: 'you', mark: 'done' })
  await call('PUT', '/api/settings', { ...stale.body.settings, setup: { steps: {} } })
  expect(settings.get().setup?.steps).toEqual({ welcome: 'done', models: 'later', you: 'done' })

  // Finishing marks what is left: done where it exists already, later otherwise.
  const finished = await call<Answer>('PUT', '/api/setup', { finish: true })
  expect(finished.body.setup.finishedAt).toBeString()
  expect(finished.body.setup.steps).toEqual({
    welcome: 'done',
    you: 'done',
    models: 'later',
    crew: 'later',
    project: 'later',
    voice: 'later',
    channels: 'later',
    alerts: 'later',
  })
  expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).setup.finishedAt).toBeString()
  const again = await call<Answer>('PUT', '/api/setup', { restart: true })
  expect(again.body.setup).toEqual({ steps: {} })
})

test('an install from before setup existed counts as set up when it already has a chat', async () => {
  const dir = home()
  // Settings saved by an older Myrmidon: no setup in them at all.
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, profile: { name: 'Robin' } }))
  const settings = new SettingsStore(dir)
  expect(settings.get().setup).toBeUndefined()
  const chats = {
    onStream: () => () => {},
    onEvents: () => () => {},
    list: async () => [{ chatId: 'c1' }],
  } as unknown as ChatService
  const server = startServer({ home: dir, port: 0, settings, chats })
  servers.push(server)
  const { body } = await client(server)<{ setup: { finishedAt?: string }; have: Record<string, boolean> }>(
    'GET',
    '/api/setup',
  )
  expect(body.setup.finishedAt).toBeString()
  expect(body.have.you).toBe(true)
  // Decided once: the answer is kept, not worked out again on every look.
  expect(new SettingsStore(dir).get().setup?.finishedAt).toBe(body.setup.finishedAt)
})

test('an install with no chat and no model is not counted as set up', async () => {
  const dir = home()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1 }))
  const chats = {
    onStream: () => () => {},
    onEvents: () => () => {},
    list: async () => [],
  } as unknown as ChatService
  const server = startServer({ home: dir, port: 0, settings: new SettingsStore(dir), chats })
  servers.push(server)
  const { body } = await client(server)<{ setup: { finishedAt?: string } }>('GET', '/api/setup')
  expect(body.setup.finishedAt).toBeUndefined()
})

test('adding a project says whether its folder is a git repository', async () => {
  const dir = home()
  const repo = join(dir, 'repo')
  const notes = join(dir, 'notes')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(notes)
  const server = startServer({ home: dir, port: 0, projects: new ProjectStore(dir) })
  servers.push(server)
  const call = client(server)
  expect((await call<{ isGit: boolean }>('POST', '/api/projects', { path: repo })).body.isGit).toBe(true)
  expect((await call<{ isGit: boolean }>('POST', '/api/projects', { path: notes })).body.isGit).toBe(false)
})
