import { expect, test } from 'bun:test'
import { withDom } from './dom.ts'

// ComputerUse reads the page's address (its API client) when it loads, so it is imported once the page is up.
withDom()

test('a driver version is older part by part as numbers, not as text', async () => {
  const { olderVersion } = await import('../src/client/ComputerUse.tsx')
  expect(olderVersion('0.28.2', '0.34.0')).toBe(true)
  expect(olderVersion('0.9.0', '0.10.0')).toBe(true)
  expect(olderVersion('0.34.0', '0.34.0')).toBe(false)
  expect(olderVersion('1.0.0', '0.34.0')).toBe(false)
  expect(olderVersion('0.34', '0.34.1')).toBe(true)
})
