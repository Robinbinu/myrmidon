import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Answers each request from `routes` by path, and records what the page sent. */
function server(routes: Record<string, unknown>) {
  const sent: { method: string; path: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost/')
    const method = init?.method ?? 'GET'
    sent.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return Response.json(routes[url.pathname] ?? {})
  }) as unknown as typeof fetch
  return sent
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => await Bun.sleep(10))
}

/**
 * Types a dollar amount and presses Enter, as React hears it here: react-dom listens for key presses on the focused
 * field (live-share.test.tsx).
 */
async function enter(field: HTMLInputElement | null | undefined, value: string) {
  await act(async () => {
    field?.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
    field?.dispatchEvent(new Event('input', { bubbles: true }))
    field?.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.at(-1) ?? '' }))
    field?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
  })
}

const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)

const MODELS = [
  { ref: 'anthropic/claude-x', provider: 'anthropic', id: 'claude-x', name: 'Claude X', reasoning: true },
]
const CONFIG = {
  mode: 'orchestrated',
  leadModel: 'anthropic/claude-x',
  roster: [],
  judgeModel: 'anthropic/claude-x',
}

test("the crew panel shows the chat's budget and spend; Settings' default crew has none", async () => {
  server({ '/api/settings': { settings: { team: { costUsd: 5 }, verification: { reviewer: 'auto' } } } })
  const { TeamSettings } = await import('../src/client/chat/Composer.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const changes: unknown[] = []
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <TeamSettings
        models={MODELS as never}
        config={CONFIG as never}
        onConfig={() => {}}
        budget={{
          value: { totalUsd: 10 },
          spent: 1.234,
          project: { runUsd: 2 },
          onChange: (b) => changes.push(b),
        }}
      />
    </MotionConfig>,
  )
  await settle()
  try {
    const text = document.body.textContent ?? ''
    expect(text).toContain(copy.budget.chatTitle)
    expect(text).toContain('$1.23 of $10 spent')
    expect(text).toContain(copy.budget.unpriced)
    // An empty per-run cap falls back to the project's before the global one.
    expect(text).toContain(copy.budget.perRunHint(copy.budget.inheritProject(2)))
    const perRun = field(copy.budget.field(copy.budget.perRun))
    const total = field(copy.budget.field(copy.budget.chatTotal))
    expect(perRun?.value).toBe('')
    expect(total?.value).toBe('10')
    await enter(perRun, '3')
    expect(changes.at(-1)).toEqual({ totalUsd: 10, runUsd: 3 })
    // Emptied, the chat's total is none of its own again.
    await enter(total, '')
    expect(changes.at(-1)).toEqual({})
  } finally {
    await view.unmount()
  }
  const plain = await mount(
    <MotionConfig reducedMotion="always">
      <TeamSettings models={MODELS as never} config={CONFIG as never} onConfig={() => {}} />
    </MotionConfig>,
  )
  try {
    expect(document.body.textContent).not.toContain(copy.budget.chatTitle)
  } finally {
    await plain.unmount()
  }
})

test("a project's Budget sheet shows this month's spend and saves its caps together", async () => {
  const project = { id: 'site-1', name: 'site', path: '/tmp/site', addedAt: '', budget: { totalUsd: 20 } }
  const sent = server({
    '/api/settings': { settings: { team: { costUsd: 5 } } },
    '/api/spend': { month: '2026-10', total: 9, projects: { 'site-1': 4.5 } },
    '/api/projects/site-1/budget': { project, projects: [project] },
  })
  const { ProjectBudget } = await import('../src/client/chat/Budget.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const saved: unknown[] = []
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <ToastProvider>
        <ProjectBudget project={project} onClose={() => {}} onSaved={(p) => saved.push(p)} />
      </ToastProvider>
    </MotionConfig>,
  )
  await settle()
  try {
    const text = document.body.textContent ?? ''
    expect(text).toContain(copy.budget.sheetTitle('site'))
    expect(text).toContain('$4.50 of $20 spent this month')
    expect(text).toContain(copy.budget.perRunHint(copy.budget.inheritGlobal(5)))
    await enter(field(copy.budget.field(copy.budget.perRun)), '2.5')
    const save = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === copy.budget.save,
    )
    await act(async () => save?.click())
    await settle()
    expect(sent.find((r) => r.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/api/projects/site-1/budget',
      body: { totalUsd: 20, runUsd: 2.5 },
    })
    expect(saved).toEqual([[project]])
  } finally {
    await view.unmount()
  }
})

test('a refused run says which running total stopped it, for the toast that offers to raise it', async () => {
  const { ApiError, budgetHit } = await import('../src/client/api.ts')
  const hit = { scope: 'project', spent: 1.2, cap: 1 }
  expect(budgetHit(new ApiError('used up', { error: 'used up', budget: hit }))).toEqual(hit as never)
  expect(budgetHit(new ApiError('no such chat', { error: 'no such chat' }))).toBeUndefined()
  expect(budgetHit(new Error('offline'))).toBeUndefined()
})
