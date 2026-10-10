import { expect, test } from 'bun:test'
import type { UsageReport } from '../src/omp/ai.ts'
import { createQuotaReader, shapeQuota, type UsageSource } from '../src/omp/usage.ts'

const HOUR = 3_600_000
const T = 1_800_000_000_000

/** A Claude Max account as omp's usage provider reports it: a 5-hour and a weekly window, one copied for another route. */
const claude: UsageReport = {
  provider: 'anthropic',
  fetchedAt: T,
  metadata: { email: 'ada@example.com', orgName: 'Ada Labs', endpoint: 'https://api.anthropic.com/usage' },
  limits: [
    {
      id: 'anthropic:5h',
      label: 'Claude 5 Hour',
      scope: { provider: 'anthropic', shared: true, sharedGroup: 'anthropic:5h' },
      window: { id: '5h', label: '5 Hour', durationMs: 5 * HOUR, resetsAt: T + HOUR },
      amount: { usedFraction: 0.923, unit: 'percent' },
    },
    {
      id: 'anthropic:5h:copy',
      label: 'Claude 5 Hour',
      scope: { provider: 'anthropic', shared: true, sharedGroup: 'anthropic:5h' },
      amount: { usedFraction: 0.923, unit: 'percent' },
    },
    {
      id: 'anthropic:7d',
      label: 'Claude 7 Day',
      scope: { provider: 'anthropic', shared: true },
      window: { id: '7d', label: '7 Day', resetsAt: T + 72 * HOUR },
      amount: { used: 30, unit: 'percent' },
    },
  ],
  raw: { secret: 'never shown' },
}

const codex: UsageReport = {
  provider: 'openai-codex',
  fetchedAt: T,
  metadata: { email: 'ada@example.com', planType: 'pro' },
  limits: [
    {
      id: 'openai-codex:primary',
      label: 'Usage',
      scope: { provider: 'openai-codex', windowId: '5h' },
      window: { id: '5h', label: '5 hours' },
      amount: { usedFraction: 1, unit: 'percent' },
    },
    {
      id: 'openai-codex:credits',
      label: 'Credits',
      scope: { provider: 'openai-codex' },
      amount: { unit: 'credits' },
      status: 'warning',
    },
  ],
}

const SUPPORTED = new Set(['anthropic', 'openai-codex', 'github-copilot'])
const supported = (p: string) => SUPPORTED.has(p)

test('reports become one row per account: its plan, each window used and when it resets, and the worst status', () => {
  const accounts = shapeQuota([claude, codex], [], supported)
  expect(accounts).toEqual([
    {
      provider: 'anthropic',
      account: 'ada@example.com · Ada Labs',
      windows: [
        // The copy for another route is the same quota, shown once.
        {
          id: 'anthropic:5h',
          label: 'Claude 5 Hour',
          usedPercent: 92.3,
          resetsAt: T + HOUR,
          status: 'warning',
        },
        { id: 'anthropic:7d', label: 'Claude 7 Day', usedPercent: 30, resetsAt: T + 72 * HOUR, status: 'ok' },
      ],
      status: 'warning',
      fetchedAt: T,
    },
    {
      provider: 'openai-codex',
      account: 'ada@example.com',
      plan: 'pro',
      windows: [
        { id: 'openai-codex:primary', label: 'Usage (5 hours)', usedPercent: 100, status: 'exhausted' },
        // No amount, but the provider's own verdict stands.
        { id: 'openai-codex:credits', label: 'Credits', status: 'warning' },
      ],
      status: 'exhausted',
      fetchedAt: T,
    },
  ])
  // Nothing of omp's raw provider answer, or anything else it carried, comes through.
  expect(JSON.stringify(accounts)).not.toContain('never shown')
  expect(JSON.stringify(accounts)).not.toContain('endpoint')
})

test('signed-in accounts without a report say why: unreachable, or a provider with no usage endpoint', () => {
  const accounts = shapeQuota(
    [claude],
    [
      { provider: 'anthropic', type: 'oauth', email: 'ada@example.com', orgName: 'Ada Labs' },
      { provider: 'github-copilot', type: 'oauth', accountId: 'ada-gh' },
      { provider: 'kimi-code', type: 'oauth', email: 'ada@example.com' },
      // A pay-per-call key has no plan to run out of: not listed.
      { provider: 'openrouter', type: 'api_key' },
    ],
    supported,
  )
  expect(accounts.map((a) => [a.provider, a.account, a.error])).toEqual([
    ['anthropic', 'ada@example.com · Ada Labs', undefined],
    ['github-copilot', 'ada-gh', 'unreachable'],
    ['kimi-code', 'ada@example.com', 'unsupported'],
  ])
})

/** A stub of omp's usage reporting that counts the provider rounds it made. */
function stubSource(reports: () => Promise<UsageReport[] | null>) {
  const calls = { reports: 0, invalidate: 0 }
  const source: UsageSource = {
    reports: async () => {
      calls.reports++
      return reports()
    },
    accounts: () => [],
    supported,
    invalidate: async () => {
      calls.invalidate++
    },
  }
  return { source, calls }
}

test('reads are cached for a while, shared while one is under way, and a forced read asks omp to fetch afresh', async () => {
  let clock = T
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const { source, calls } = stubSource(async () => {
    await gate
    return [claude]
  })
  const reader = createQuotaReader(source, { cacheMs: 60_000, now: () => clock })
  const first = reader.read()
  const second = reader.read()
  release()
  const [a, b] = await Promise.all([first, second])
  expect(a).toBe(b)
  expect(calls.reports).toBe(1)
  expect(a.accounts.map((x) => x.provider)).toEqual(['anthropic'])

  clock += 59_000
  expect(await reader.read()).toBe(a)
  expect(calls.reports).toBe(1)

  clock += 2_000
  await reader.read()
  expect(calls.reports).toBe(2)

  await reader.read({ force: true })
  expect(calls).toEqual({ reports: 3, invalidate: 1 })
})

test('a failed read says so and is cached too, so a broken provider is not asked on every poll', async () => {
  const { source, calls } = stubSource(async () => {
    throw new Error('usage fetch aborted')
  })
  const reader = createQuotaReader(source, { cacheMs: 60_000, now: () => T })
  expect(await reader.read()).toEqual({ fetchedAt: T, accounts: [], error: 'usage fetch aborted' })
  await reader.read()
  expect(calls.reports).toBe(1)
})

test('omp having no usage reporting at all reads as no accounts, not an error', async () => {
  const { source } = stubSource(async () => null)
  expect(await createQuotaReader(source, { now: () => T }).read()).toEqual({ fetchedAt: T, accounts: [] })
})
