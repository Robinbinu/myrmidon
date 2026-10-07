import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, memoryLines } from '../src/memory.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'myr-memory-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

test('memories are kept per scope, deduplicated, edited and recalled only once kept', () => {
  const store = new MemoryStore(home)
  const spelling = store.add({
    text: 'Use British spelling.',
    kind: 'preference',
    status: 'active',
    source: { by: 'person' },
  })
  expect(
    store.add({
      text: '  use british   spelling. ',
      kind: 'preference',
      status: 'active',
      source: { by: 'person' },
    }).id,
  ).toBe(spelling.id)
  const lesson = store.add({
    text: 'Run bun test from the repo root.',
    kind: 'lesson',
    project: 'demo',
    status: 'proposed',
    source: { by: 'agent', agent: 'kai', why: 'tests failed from a subfolder' },
  })
  // A proposal is not recalled until the person keeps it, and a project memory only in that project.
  expect(store.recall('demo').map((m) => m.id)).toEqual([spelling.id])
  store.update(lesson.id, { status: 'active' })
  expect(store.recall('demo').map((m) => m.id)).toEqual([spelling.id, lesson.id])
  expect(store.recall('other').map((m) => m.id)).toEqual([spelling.id])
  expect(memoryLines(store.recall('demo'))).toEqual([
    '- [preference] Use British spelling.',
    '- [lesson, this project] Run bun test from the repo root.',
  ])
  // Moving it to every chat, then removing it.
  expect(store.update(lesson.id, { project: null }).project).toBeUndefined()
  expect(store.remove(lesson.id)).toBe(true)
  expect(store.list()).toHaveLength(1)
  expect(() =>
    store.add({ text: 'x', kind: 'preference', status: 'active', source: { by: 'person' } }),
  ).toThrow()
  expect(() =>
    store.add({ text: 'Fine text', kind: 'mood', status: 'active', source: { by: 'person' } }),
  ).toThrow()
})
