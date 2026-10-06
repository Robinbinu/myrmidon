import { expect, test } from 'bun:test'
import { similar } from '../src/tools.ts'

test('task dedupe catches rewordings but not numbered siblings', () => {
  expect(similar('Research Flask in depth', 'Research Flask in depth: stats and features')).toBeGreaterThan(
    0.3,
  )
  expect(similar('Write the Flask example app', 'Write a Flask example app')).toBe(1)
  expect(similar('Write example app for framework #1', 'Write example app for framework #2')).toBe(0)
  expect(similar('Write example app for framework #1', 'Write example app for second-ranked framework')).toBe(
    0,
  )
  expect(similar('Compare bundler speed', 'Write the final report')).toBe(0)
})
