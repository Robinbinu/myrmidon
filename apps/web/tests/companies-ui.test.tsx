import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Answers each request from `routes` by method and path, and records what the page sent. */
function server(routes: Record<string, unknown | ((body: unknown) => [number, unknown])>) {
  const sent: { method: string; path: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost/')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    sent.push({ method, path: url.pathname, body })
    const route = routes[`${method} ${url.pathname}`] ?? routes[url.pathname]
    if (typeof route === 'function') {
      const [status, data] = (route as (b: unknown) => [number, unknown])(body)
      return Response.json(data, { status })
    }
    return Response.json(route ?? {})
  }) as unknown as typeof fetch
  return sent
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await Bun.sleep(15))
}

const MODELS = [
  { ref: 'deepseek/chat', provider: 'deepseek', id: 'chat', name: 'DeepSeek Chat', reasoning: false },
  {
    ref: 'deepseek/reasoner',
    provider: 'deepseek',
    id: 'reasoner',
    name: 'DeepSeek Reasoner',
    reasoning: true,
  },
]
const CONFIG = {
  mode: 'orchestrated',
  leadModel: 'deepseek/reasoner',
  roster: [],
  extraWorkers: 0,
  judgeModel: 'deepseek/chat',
}
const NOW = new Date().toISOString()
const COMPANY = {
  id: 'tiny-1',
  name: 'Tiny press',
  kind: 'publishing',
  description: 'A writer and a boss.',
  head: 'boss',
  start: 'lead',
  version: 1,
  savedAt: NOW,
  budget: { perRunUsd: 2 },
  roles: [
    { name: 'boss', title: 'Boss', responsibilities: [], tier: 'frontier', access: 'full', prompt: 'Lead.' },
    {
      name: 'writer',
      title: 'Writer',
      responsibilities: [],
      tier: 'smart',
      access: 'no-shell',
      reportsTo: 'boss',
      stage: 'draft',
      prompt: 'Write.',
    },
  ],
  playbook: [{ id: 'draft', title: 'Draft', after: [], output: 'draft.md', brief: 'Write it.' }],
}

test('Style is Lead + team | Swarm | Company; Company reveals the chooser, tier models and the cost of a run', async () => {
  const sent = server({
    '/api/specialists': { specialists: [] },
    '/api/companies': { companies: [COMPANY], templates: [] },
    '/api/companies/tiny-1/estimate': { estimate: { usd: 0.042, unpriced: [], roles: [], capUsd: 2 } },
    '/api/settings': { settings: { team: {}, verification: { reviewer: 'auto' } } },
  })
  const { TeamSettings } = await import('../src/client/chat/Composer.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const { useState } = await import('react')
  const withHelpers = { ...CONFIG, roster: [{ role: 'coder', model: 'deepseek/chat' }], extraWorkers: 1 }
  let config: Record<string, unknown> = withHelpers
  function Panel(props: { companies?: boolean }) {
    const [c, setC] = useState(withHelpers as never)
    config = c
    return (
      <MotionConfig reducedMotion="always" skipAnimations>
        <TeamSettings
          models={MODELS as never}
          config={c}
          onConfig={(next) => setC(next as never)}
          {...(props.companies ? { companies: true } : {})}
        />
      </MotionConfig>
    )
  }
  const e = copy.teamControls.editor
  const styles = () =>
    [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].filter((b) =>
      [e.orchestrated, e.swarm, e.company].includes(b.textContent ?? ''),
    )
  // The helper list remembers being open, so it is opened only when folded.
  const openHelpers = async () => {
    if (styles().length) return
    const toggle = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(copy.composer.helperList),
    )
    await act(async () => toggle?.click())
    await settle()
  }
  const chooser = () =>
    document.querySelector<HTMLSelectElement>(`select[aria-label="${copy.teamControls.company.label}"]`)
  const view = await mount(<Panel companies />)
  await settle()
  await openHelpers()
  expect(styles().map((b) => b.textContent)).toEqual(['Lead + team', 'Swarm', 'Company'])
  expect(chooser()).toBeNull()
  // Company picks the first saved company and reveals the chooser right below, with "New company…".
  await act(async () => styles()[2]?.click())
  await act(async () => await Bun.sleep(400))
  await settle()
  expect(config).toMatchObject({ company: 'tiny-1', mode: 'orchestrated' })
  expect([...(chooser()?.options ?? [])].map((o) => o.textContent)).toEqual([
    'Tiny press',
    copy.teamControls.company.newCompany,
  ])
  const text = document.body.textContent ?? ''
  expect(text).toContain(copy.teamControls.company.roles(2))
  expect(text).toContain(copy.teamControls.company.estimate('$0.04'))
  expect(text).toContain(copy.teamControls.company.cap('$2.00'))
  // The company's roles are the crew: the panel's own helper rows go while it is chosen.
  expect(document.querySelector(`input[aria-label="${e.roleOf(1)}"]`)).toBeNull()
  expect(sent.some((s) => s.method === 'POST' && s.path === '/api/companies/tiny-1/estimate')).toBe(true)
  // "New company…" opens Settings → Companies instead of picking.
  const opened: unknown[] = []
  const listen = (ev: Event) => opened.push((ev as CustomEvent).detail)
  window.addEventListener('myr:open-settings', listen)
  await act(async () => {
    const s = chooser()
    if (s) s.value = '__new'
    s?.dispatchEvent(new Event('change', { bubbles: true }))
  })
  window.removeEventListener('myr:open-settings', listen)
  expect(opened).toEqual(['companies'])
  expect(config.company).toBe('tiny-1')
  // Back to Lead + team: the company goes and the helpers are as they were.
  await act(async () => styles()[0]?.click())
  await settle()
  expect(config.company).toBeUndefined()
  expect(config.roster).toEqual(withHelpers.roster)
  expect(chooser()).toBeNull()
  await view.unmount()
  // Settings' default crew keeps two styles: a company is chosen per chat.
  const settingsView = await mount(<Panel />)
  await settle()
  await openHelpers()
  expect(styles().map((b) => b.textContent)).toEqual(['Lead + team', 'Swarm'])
  await settingsView.unmount()
})

test("a proposed company change shows the lead's evidence and the role's record; approving saves a version", async () => {
  const sent = server({
    'POST /api/colonies/c1/company-proposals/proposal-9': { version: 2 },
  })
  const { CompanyProposalCards } = await import('../src/client/chat/ApprovalCards.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const state = {
    companyProposals: {
      'proposal-9': {
        id: 'proposal-9',
        agent: 'lead',
        company: { id: 'tiny-1', name: 'Tiny press', version: 1, hash: 'abc' },
        change: 'fire',
        role: 'writer',
        why: 'Every draft was rewritten by the lead.',
        evidence: 'task-1 was sent back twice.',
        record: { tasks: 1, verified: 0, sentBack: 2, turns: 9, costUsd: 0.12 },
        time: NOW,
      },
    },
  }
  const view = await mount(
    <MotionConfig reducedMotion="always" skipAnimations>
      <ToastProvider>
        <CompanyProposalCards state={state as never} colonyId="c1" />
      </ToastProvider>
    </MotionConfig>,
  )
  await settle()
  const text = document.body.textContent ?? ''
  expect(text).toContain(copy.approvals.company.wants('lead', 'let go', 'writer', 'Tiny press'))
  expect(text).toContain('task-1 was sent back twice.')
  expect(text).toContain(copy.approvals.company.record(1, 0, 2, 9, '$0.12'))
  const approve = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === copy.approvals.company.approve,
  )
  await act(async () => approve?.click())
  await settle()
  expect(sent.find((s) => s.path === '/api/colonies/c1/company-proposals/proposal-9')?.body).toEqual({
    approve: true,
  })
  expect(document.body.textContent).toContain(copy.approvals.company.approved(2))
  await view.unmount()
})

test('the company editor lists every problem the server found, where it is', async () => {
  server({
    'PUT /api/companies/tiny-1': () => [
      400,
      { error: 'invalid', problems: [{ path: 'roles[1].stage', message: 'no stage is called nope' }] },
    ],
  })
  const { CompanyEditor } = await import('../src/client/CompaniesSection.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const view = await mount(
    <MotionConfig reducedMotion="always" skipAnimations>
      <ToastProvider>
        <CompanyEditor
          id="tiny-1"
          initial={COMPANY as never}
          findings={[]}
          onSaved={() => {}}
          onCancel={() => {}}
        />
      </ToastProvider>
    </MotionConfig>,
  )
  await settle()
  // Every role shows its tier, access and the stage it owns.
  const selects = [...document.querySelectorAll('select')].map((s) => s.value)
  expect(selects).toContain('frontier')
  expect(selects).toContain('draft')
  const save = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === copy.settings.companies.save,
  )
  await act(async () => save?.click())
  await settle()
  expect(document.body.textContent).toContain(copy.settings.companies.problems)
  expect(document.body.textContent).toContain('roles[1].stage')
  await view.unmount()
})
