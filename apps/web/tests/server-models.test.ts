import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type OmpRuntime, SettingsStore } from '@myrmidon/runtime'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

type FakeModel = { provider: string; id: string; name: string; cost?: { input: number } }

/** omp with a few models: a built-in provider's, and a custom endpoint that declares two. */
function fakeOmp(defaultModel: string) {
  let models: FakeModel[] = [
    { provider: 'anthropic', id: 'opus', name: 'Opus', cost: { input: 15 } },
    { provider: 'anthropic', id: 'sonnet', name: 'Sonnet', cost: { input: 3 } },
    { provider: 'anthropic', id: 'haiku', name: 'Haiku', cost: { input: 1 } },
    { provider: 'lmstudio', id: 'qwen', name: 'Qwen' },
    { provider: 'lmstudio', id: 'gemma', name: 'Gemma' },
  ]
  const omp = {
    available: () => models,
    all: () => models,
    find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    defaultModel: () => defaultModel,
    providers: () => [],
    async removeModel(provider: string, id: string) {
      if (provider !== 'lmstudio') return false
      models = models.filter((m) => !(m.provider === provider && m.id === id))
      return true
    },
  }
  return omp as unknown as OmpRuntime
}

function serve(omp: OmpRuntime) {
  const home = mkdtempSync(join(tmpdir(), 'myr-models-'))
  homes.push(home)
  const settings = new SettingsStore(home)
  const server = startServer({ home, port: 0, omp, settings })
  servers.push(server)
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, server.url.replace(/#.*$/, '')), {
      method,
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { settings, call }
}

const refs = (body: Record<string, unknown>) => (body.models as { ref: string }[]).map((m) => m.ref)

test("removing a built-in provider's model hides it, and the defaults that named it fall back", async () => {
  const { settings, call } = serve(fakeOmp('anthropic/opus'))
  settings.set({
    ...settings.get(),
    team: { ...settings.get().team, leadModel: 'anthropic/sonnet', judgeModel: 'anthropic/sonnet' },
    voice: { ...settings.get().voice, callModel: 'anthropic/sonnet' },
  })
  const removed = await call('POST', '/api/models/remove', { ref: 'anthropic/sonnet' })
  expect(removed.status).toBe(200)
  expect(removed.body).toMatchObject({
    removed: 'hidden',
    cleared: ['lead', 'reviewer', 'call'],
    // omp's default is still shown, so it leads now; the reviewer and call assistant follow the lead.
    lead: 'anthropic/opus',
    titles: 'anthropic/haiku',
  })
  expect(settings.get().team.leadModel).toBe('anthropic/opus')
  expect(settings.get().team.judgeModel).toBeUndefined()
  expect(settings.get().voice.callModel).toBeUndefined()
  expect(settings.get().models.hidden).toEqual(['anthropic/sonnet'])
  expect(refs((await call('GET', '/api/models')).body)).not.toContain('anthropic/sonnet')
  // Settings → Models still lists it, marked hidden, so it can be restored.
  const all = (await call('GET', '/api/models?hidden=1')).body.models as { ref: string; hidden: boolean }[]
  expect(all.find((m) => m.ref === 'anthropic/sonnet')?.hidden).toBe(true)
})

test('an automatic lead or chat namer that is removed moves on, preferring the same provider', async () => {
  const { settings, call } = serve(fakeOmp('anthropic/haiku'))
  const removed = await call('POST', '/api/models/remove', { ref: 'anthropic/haiku' })
  // Haiku was omp's default and the cheapest, so it led and named chats without either being set.
  expect(removed.body).toMatchObject({
    removed: 'hidden',
    cleared: ['lead', 'titles'],
    lead: 'anthropic/opus',
    titles: 'anthropic/sonnet',
  })
  expect(settings.get().team.leadModel).toBe('anthropic/opus')
  expect((await call('GET', '/api/models')).body.default).toBe('anthropic/opus')
})

test("removing a custom endpoint's model deletes it from the endpoint's list instead of hiding it", async () => {
  const { settings, call } = serve(fakeOmp('anthropic/opus'))
  settings.set({ ...settings.get(), team: { ...settings.get().team, workerModel: 'lmstudio/qwen' } })
  const removed = await call('POST', '/api/models/remove', { ref: 'lmstudio/qwen' })
  expect(removed.body).toMatchObject({ removed: 'deleted', cleared: ['crewmates'], lead: 'anthropic/opus' })
  expect(settings.get().models.hidden).toEqual([])
  expect(settings.get().team.workerModel).toBeUndefined()
  expect(refs((await call('GET', '/api/models?hidden=1')).body)).not.toContain('lmstudio/qwen')
})

test('a model omp does not know, or a ref without a provider, is refused', async () => {
  const { settings, call } = serve(fakeOmp('anthropic/opus'))
  expect((await call('POST', '/api/models/remove', { ref: 'anthropic/nope' })).status).toBe(404)
  expect((await call('POST', '/api/models/remove', { ref: 'opus' })).status).toBe(400)
  expect((await call('POST', '/api/models/remove', {})).status).toBe(400)
  expect(settings.get().models.hidden).toEqual([])
})
