import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Company } from '@myrmidon/protocol'
import { CompanyStore, ModelResolver, SettingsStore } from '@myrmidon/runtime'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function start() {
  const dir = mkdtempSync(join(tmpdir(), 'myr-companies-api-'))
  homes.push(dir)
  const companies = new CompanyStore(dir)
  const server = startServer({
    home: dir,
    port: 0,
    settings: new SettingsStore(dir),
    companies,
    resolver: new ModelResolver(),
  })
  servers.push(server)
  const base = server.url.replace(/#.*$/, '')
  const raw = (method: string, path: string, body?: unknown) =>
    fetch(new URL(path, base), {
      method,
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await raw(method, path, body)
    return { status: res.status, body: (await res.json()) as T }
  }
  return { companies, call, raw }
}

test('companies over the API: from a template, edited, versioned, rolled back, exported, imported, removed', async () => {
  const { companies, call, raw } = start()
  const listed = await call<{ companies: Company[]; templates: { id: string; kind: string }[] }>(
    'GET',
    '/api/companies',
  )
  expect(listed.body.companies).toEqual([])
  expect(listed.body.templates.map((t) => t.kind)).toEqual(['software', 'marketing', 'research'])

  const made = await call<{ company: Company }>('POST', '/api/companies', { template: 'research-lab' })
  expect(made.status).toBe(200)
  const id = made.body.company.id
  expect(made.body.company).toMatchObject({ name: 'Research lab', version: 1, template: 'research-lab' })

  // An invalid edit comes back with every problem and where it is; the company stays as it was.
  const bad = await call<{ problems: { path: string }[] }>('PUT', `/api/companies/${id}`, {
    company: { ...made.body.company, head: 'nobody', roles: [{ name: 'x', title: '' }] },
  })
  expect(bad.status).toBe(400)
  expect(bad.body.problems.map((p) => p.path)).toContain('roles[0].name')
  const edited = await call<{ company: Company }>('PUT', `/api/companies/${id}`, {
    company: { ...made.body.company, name: 'Ant lab' },
    note: 'renamed',
  })
  expect(edited.body.company.version).toBe(2)
  const got = await call<{ history: { version: number; note?: string }[] }>('GET', `/api/companies/${id}`)
  expect(got.body.history.map((h) => h.version)).toEqual([2, 1])
  const back = await call<{ company: Company }>('POST', `/api/companies/${id}/rollback`, { version: 1 })
  expect([back.body.company.version, back.body.company.name]).toEqual([3, 'Research lab'])

  const exported = await raw('GET', `/api/companies/${id}/export`)
  expect(exported.headers.get('content-disposition')).toContain('.company.yaml')
  const text = await exported.text()
  const preview = await call<{ company: { name: string }; findings: unknown[] }>(
    'POST',
    '/api/companies/import',
    {
      text,
    },
  )
  expect(preview.body).toMatchObject({ company: { name: 'Research lab' }, findings: [] })
  // Import only previews; saving it is a separate, ordinary create.
  expect(companies.list()).toHaveLength(1)
  expect((await call('POST', '/api/companies/import', { text: 'hello' })).status).toBe(400)

  const estimate = await call<{ estimate: { roles: unknown[]; capUsd?: number } }>(
    'POST',
    `/api/companies/${id}/estimate`,
    { leadModel: 'openai/gpt-4o', mode: 'orchestrated', roster: [], judgeModel: 'openai/gpt-4o' },
  )
  expect(estimate.status).toBe(200)
  expect(estimate.body.estimate.roles).toHaveLength(5)
  expect(estimate.body.estimate.capUsd).toBe(3)

  expect((await call('DELETE', `/api/companies/${id}`)).status).toBe(200)
  expect((await call('GET', `/api/companies/${id}`)).status).toBe(404)
})
