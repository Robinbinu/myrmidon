import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const HOUR = 3_600_000

function snapshot(now: number) {
  return {
    fetchedAt: now,
    accounts: [
      {
        provider: 'anthropic',
        account: 'ada@example.com',
        plan: 'max',
        status: 'warning',
        windows: [
          {
            id: 'anthropic:5h',
            label: 'Claude 5 Hour',
            usedPercent: 92.3,
            resetsAt: now + HOUR + 5 * 60_000,
            status: 'warning',
          },
          { id: 'anthropic:7d', label: 'Claude 7 Day', usedPercent: 30, status: 'ok' },
        ],
      },
      { provider: 'github-copilot', account: 'ada-gh', status: 'unknown', windows: [], error: 'unreachable' },
    ],
  }
}

/** A gateway answering `/api/usage`, noting each path asked. */
function serveUsage(body: unknown) {
  const asked: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.href)
    asked.push(url.pathname + url.search)
    return Response.json(body)
  }) as typeof fetch
  return asked
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => await Bun.sleep(10))
}

test('each account shows a meter per window: share left, reset, plan, and why an account has none', async () => {
  const asked = serveUsage(snapshot(Date.now()))
  const { PlanLimits } = await import('../src/client/plan-limits.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const view = await mount(<PlanLimits />)
  await settle()
  const meters = [...view.host.querySelectorAll('meter')]
  expect(meters.map((m) => [m.getAttribute('aria-label'), m.getAttribute('value')])).toEqual([
    // What is left of each window, as the bar shows it.
    ['Claude 5 Hour', '8'],
    ['Claude 7 Day', '70'],
  ])
  expect(meters[0]?.getAttribute('aria-valuetext')).toBe('Claude 5 Hour: 8% left, resets in 1h 5m')
  // The bar's colour follows the window's status: near its limit is yellow, with room is green.
  const bars = [...view.host.querySelectorAll('[aria-hidden] > div')].map((b) => b.className)
  expect(bars[0]).toContain('bg-warn')
  expect(bars[1]).toContain('bg-ok')
  const text = view.host.textContent ?? ''
  expect(text).toContain('ada@example.com')
  expect(text).toContain('max')
  expect(text).toContain(copy.planLimits.status.warning)
  expect(text).toContain(copy.planLimits.unreachable)

  // Checking again asks the gateway to reach every provider afresh.
  const again = [...view.host.querySelectorAll('button')].find(
    (b) => b.textContent === copy.planLimits.refresh,
  )
  await act(async () => again?.click())
  await settle()
  expect(asked).toEqual(['/api/usage', '/api/usage?refresh=1'])
  await view.unmount()
})

test('with no signed-in accounts, or no runtime to ask, the section is not shown', async () => {
  serveUsage({ fetchedAt: Date.now(), accounts: [] })
  const { PlanLimits } = await import('../src/client/plan-limits.tsx')
  const view = await mount(<PlanLimits />)
  await settle()
  expect(view.host.innerHTML).toBe('')
  await view.unmount()
})

test("the composer's model chip warns only when every account its provider could use is near a limit", async () => {
  const { limitNotice } = await import('../src/client/plan-limits.tsx')
  const now = 1_800_000_000_000
  const near = snapshot(now)
  expect(limitNotice(near as never, 'anthropic', now)).toBe(
    'Claude 5 Hour has only 8% left, resets in 1h 5m: agents on this model may slow down or stop',
  )
  // Another Claude account with room: omp moves to it, so nothing to warn about.
  const roomy = {
    ...near,
    accounts: [
      ...near.accounts,
      {
        provider: 'anthropic',
        account: 'bo@example.com',
        status: 'ok',
        windows: [{ id: 'anthropic:5h', label: 'Claude 5 Hour', usedPercent: 10, status: 'ok' }],
      },
    ],
  }
  expect(limitNotice(roomy as never, 'anthropic', now)).toBeUndefined()
  // An account with no data, or a provider with no account, says nothing either.
  expect(limitNotice(near as never, 'github-copilot', now)).toBeUndefined()
  expect(limitNotice(near as never, 'openai', now)).toBeUndefined()
  const out = {
    fetchedAt: now,
    accounts: [
      {
        provider: 'openai-codex',
        status: 'exhausted',
        windows: [
          {
            id: 'p',
            label: 'Usage (5 hours)',
            usedPercent: 100,
            resetsAt: now + 20 * 60_000,
            status: 'exhausted',
          },
        ],
      },
    ],
  }
  expect(limitNotice(out as never, 'openai-codex', now)).toBe(
    'Usage (5 hours) limit reached, resets in 20m: agents on this model will wait or fail until then',
  )
})

test('the chip shows the warning, readable by a screen reader too', async () => {
  const { ModelPicker } = await import('../src/client/chat/ModelPicker.tsx')
  const models = [{ ref: 'anthropic/opus', provider: 'anthropic', id: 'opus', name: 'Opus' }]
  const view = await mount(
    <ModelPicker
      variant="chip"
      label="Lead"
      value="anthropic/opus"
      models={models as never}
      onChange={() => {}}
      limitNotice="Claude 5 Hour is 92% used"
    />,
  )
  const button = view.host.querySelector('button')
  expect(button?.textContent).toContain('Claude 5 Hour is 92% used')
  expect(button?.querySelector('[title="Claude 5 Hour is 92% used"]')).not.toBeNull()
  await view.unmount()
})
