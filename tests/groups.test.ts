import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { groupFiles, INTEGRATION, TEST_GROUPS } from './groups.ts'

const root = join(import.meta.dir, '..')

test('every entry of every test group names at least one test file', () => {
  const empty = Object.entries(TEST_GROUPS).flatMap(([name, group]) =>
    group.files
      .filter((pattern) => groupFiles({ ...group, files: [pattern] }, root).length === 0)
      .map((p) => `${name}: ${p}`),
  )
  expect(empty).toEqual([])
  for (const file of Object.values(TEST_GROUPS).flatMap((g) => groupFiles(g, root)))
    expect(file).toMatch(/\.test\.tsx?$/)
})

test('every perf-*.test file is in the perf group, and every integration group exists', () => {
  const perf = new Set(groupFiles(TEST_GROUPS.perf, root))
  const all = [...new Bun.Glob('{packages,apps}/*/tests/perf-*.test.{ts,tsx}').scanSync({ cwd: root })]
  expect(all.length).toBeGreaterThan(0)
  for (const file of all) expect(perf.has(file)).toBe(true)
  for (const name of INTEGRATION) expect(TEST_GROUPS[name]).toBeDefined()
})
