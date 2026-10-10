import { expect, test } from 'bun:test'
import { olderVersion } from '../src/client/ComputerUse.tsx'

test('a driver version is older part by part as numbers, not as text', () => {
  expect(olderVersion('0.28.2', '0.34.0')).toBe(true)
  expect(olderVersion('0.9.0', '0.10.0')).toBe(true)
  expect(olderVersion('0.34.0', '0.34.0')).toBe(false)
  expect(olderVersion('1.0.0', '0.34.0')).toBe(false)
  expect(olderVersion('0.34', '0.34.1')).toBe(true)
})
