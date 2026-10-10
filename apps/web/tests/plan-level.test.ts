import { expect, test } from 'bun:test'
import type { QuotaSnapshot } from '../src/client/plan-limits.tsx'
import { withDom } from './dom.ts'

// plan-limits reads the page's address (its API client) when it loads.
withDom()
const { planLevel } = await import('../src/client/plan-limits.tsx')

const snap = (
  ...accounts: { used?: number; status?: 'ok' | 'warning' | 'exhausted' }[][]
): QuotaSnapshot => ({
  fetchedAt: 0,
  accounts: accounts.map((windows) => ({
    provider: 'anthropic',
    status: windows.some((w) => w.status === 'exhausted')
      ? 'exhausted'
      : windows.some((w) => w.status === 'warning')
        ? 'warning'
        : 'ok',
    windows: windows.map((w, i) => ({
      id: `w${i}`,
      label: i ? 'Weekly' : '5-hour',
      status: w.status ?? 'ok',
      ...(w.used !== undefined ? { usedPercent: w.used } : {}),
    })),
  })),
})

test('the battery reads the tightest window of the roomiest account, in four steps', () => {
  expect(planLevel(snap([{ used: 10 }, { used: 20 }]), 'anthropic')?.level).toBe('full')
  expect(planLevel(snap([{ used: 10 }, { used: 55 }]), 'anthropic')).toMatchObject({ level: 'mid', left: 45 })
  expect(planLevel(snap([{ used: 85, status: 'warning' }]), 'anthropic')?.level).toBe('low')
  expect(planLevel(snap([{ used: 100, status: 'exhausted' }]), 'anthropic')?.level).toBe('empty')
  // Another account with room is what omp moves to, so the battery shows that one.
  expect(planLevel(snap([{ used: 100, status: 'exhausted' }], [{ used: 30 }]), 'anthropic')?.level).toBe(
    'full',
  )
  expect(planLevel(snap([{ used: 30 }]), 'anthropic')?.text).toContain('70% left')
})

test('no battery without a reported use: an API key, another provider, or no numbers', () => {
  expect(planLevel(undefined, 'anthropic')).toBeUndefined()
  expect(planLevel(snap([{ used: 10 }]), 'openai')).toBeUndefined()
  expect(planLevel(snap([{}]), 'anthropic')).toBeUndefined()
})

test('the tooltip names every window, the one the battery shows first', () => {
  const text = planLevel(snap([{ used: 16 }, { used: 71 }]), 'anthropic')?.text ?? ''
  expect(text.split('\n')).toEqual(['Weekly: 29% left', '5-hour: 84% left'])
})
