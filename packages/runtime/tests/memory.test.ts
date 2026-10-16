import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inInstructions,
  type Memory,
  MemoryStore,
  memoryLines,
  neverSave,
  rankMemories,
  sensitive,
  similarity,
} from '../src/memory.ts'
import { checkExtracted, checkReflected } from '../src/memory-review.ts'
import { prompts } from '../src/prompts.ts'

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
  store.keep(lesson.id)
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

const person = { by: 'person' } as const

test('past what fits, a prompt carries the newest preferences and the memories relevant to the request', () => {
  const store = new MemoryStore(home)
  for (let i = 0; i < 8; i++)
    store.add({
      text: `Preference number ${i} about tone`,
      kind: 'preference',
      status: 'active',
      source: person,
    })
  for (let i = 0; i < 20; i++)
    store.add({ text: `Unrelated fact ${i} about gardening`, kind: 'fact', status: 'active', source: person })
  const deploy = store.add({
    text: 'Deploys go through the staging server first',
    kind: 'decision',
    status: 'active',
    source: person,
  })
  const shown = store.recall(undefined, 'Please deploy the new build')
  expect(shown.length).toBeLessThan(store.kept().length)
  expect(shown.map((m) => m.id)).toContain(deploy.id)
  expect(shown.filter((m) => m.kind === 'preference')).toHaveLength(6)
  expect(shown.some((m) => m.text.includes('gardening'))).toBe(false)
  // recall finds the rest by words, best match first; no words to match gives the newest.
  expect(store.search('gardening fact 7', 3)[0]?.text).toBe('Unrelated fact 7 about gardening')
  expect(store.search('', 1)[0]?.id).toBe(deploy.id)
  expect(store.search('kubernetes', 5)).toEqual([])
})

test('relevance ranking puts the best match first and leaves out what shares no word with the query', () => {
  const at = (text: string): Memory => ({
    id: text,
    text,
    kind: 'lesson',
    status: 'active',
    source: person,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
  const ranked = rankMemories(
    [
      at('Run bun test from the repo root'),
      at('Run bun test from the repository root'),
      at('Biome formats the code on save'),
      at('Bun test needs the timeout flag'),
    ],
    'how do I run bun test from the root',
    5,
  )
  expect(ranked[0]?.text).toBe('Run bun test from the repo root')
  expect(ranked).toHaveLength(3)
  expect(ranked.map((m) => m.text)).not.toContain('Biome formats the code on save')
  expect(similarity('Use pnpm, not npm', 'use PNPM not npm!')).toBe(1)
})

test('keeping a proposal that replaces kept memories removes them in the same write', () => {
  const store = new MemoryStore(home)
  const a = store.add({ text: 'Prefers tabs', kind: 'preference', status: 'active', source: person })
  const b = store.add({ text: 'Indent with tabs', kind: 'preference', status: 'active', source: person })
  const merged = store.add({
    text: 'Indent with tabs, never spaces',
    kind: 'preference',
    status: 'proposed',
    replaces: [a.id, b.id],
    source: { by: 'reflect', why: 'same topic' },
  })
  expect(store.recall().map((m) => m.id)).toEqual([a.id, b.id])
  expect(store.keep(merged.id)).toEqual([a.id, b.id])
  expect(store.list()).toEqual([expect.objectContaining({ id: merged.id, status: 'active' })])
  expect(store.get(merged.id)?.replaces).toBeUndefined()
})

test('secrets, contact details and ID numbers count as sensitive; ordinary facts do not', () => {
  expect(sensitive('The deploy key is ghp_abcdefghijklmnopqrstuvwxyz123456')).toBe(true)
  expect(sensitive('Write to robin@example.com for access')).toBe(true)
  expect(sensitive('My card is 4111 1111 1111 1111')).toBe(true)
  expect(sensitive('Uses [[secret:api-key:ABCDEF123456]] for the API')).toBe(true)
  expect(sensitive('Prefers pnpm over npm in every project')).toBe(false)
  expect(sensitive('The app listens on port 4318')).toBe(false)
})

test('extracted memories must quote the person, be new, hold nothing sensitive, and replace only kept ones', () => {
  const kept: Memory = {
    id: 'mem-old',
    text: 'Prefers npm',
    kind: 'preference',
    status: 'active',
    source: person,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }
  const said = [
    'From now on use pnpm, not npm. My email is robin@example.com',
    'And reports go in docs/reports',
  ]
  const out = checkExtracted(
    [
      {
        text: 'Prefers pnpm over npm',
        kind: 'preference',
        evidence: 'use pnpm,  not npm',
        replaces: ['mem-old', 'x'],
      },
      // The crew said it, not the person.
      { text: 'Likes dark mode', kind: 'preference', evidence: 'I set dark mode for you' },
      { text: 'Their email is robin@example.com', kind: 'fact', evidence: 'My email is robin@example.com' },
      { text: 'Prefers npm', kind: 'preference', evidence: 'not npm' },
      {
        text: 'Reports go in docs/reports',
        kind: 'fact',
        scope: 'project',
        evidence: 'reports go in docs/reports',
      },
      { text: 'Bad kind', kind: 'mood', evidence: 'use pnpm' },
    ],
    { said, project: 'proj-1', known: [kept] },
  )
  expect(out).toEqual([
    { text: 'Prefers pnpm over npm', kind: 'preference', replaces: ['mem-old'], why: 'use pnpm, not npm' },
    {
      text: 'Reports go in docs/reports',
      kind: 'fact',
      project: 'proj-1',
      replaces: [],
      why: 'reports go in docs/reports',
    },
  ])
  // Without a project, a project-scoped suggestion applies to every chat.
  expect(
    checkExtracted(
      [{ text: 'Reports go in docs/reports', kind: 'fact', scope: 'project', evidence: 'docs/reports' }],
      {
        said,
        known: [],
      },
    )[0]?.project,
  ).toBeUndefined()
})

test('setup failures and claims that a tool is broken are never saved; lasting lessons are', () => {
  for (const claim of [
    'The browser tool is broken on this machine',
    "web_fetch doesn't work here",
    'ripgrep is not installed, use grep',
    'gh: command not found, so GitHub cannot be used',
    'Docker cannot be used in this project',
  ])
    expect(neverSave(claim)).toBe(true)
  for (const lesson of [
    'The API tests need the local database running',
    'Prefers pnpm over npm',
    'Release notes go in CHANGELOG.md',
  ])
    expect(neverSave(lesson)).toBe(false)
})

test("a memory that repeats one sentence of the project's instructions counts as said there", () => {
  const agents =
    '# Agent instructions\n\nRun bun run test:changed while working. Never push to main directly.'
  expect(inInstructions('Never push directly to main', agents, 0.8)).toBe(true)
  expect(inInstructions('Prefers small pull requests with one change each', agents, 0.8)).toBe(false)
})

test("extraction drops setup failures, broken-tool claims and what the project's instructions already say", () => {
  const said = [
    'the browser tool is broken, skip it. Also we never push to main directly. I like answers in British English',
  ]
  const out = checkExtracted(
    [
      { text: 'The browser tool is broken', kind: 'fact', evidence: 'the browser tool is broken' },
      { text: 'Never push to main directly', kind: 'decision', evidence: 'we never push to main directly' },
      {
        text: 'Prefers answers in British English',
        kind: 'preference',
        evidence: 'answers in British English',
      },
    ],
    {
      said,
      project: 'p',
      known: [],
      instructions: 'Rules:\n- Never push to main directly; open a pull request.',
    },
  )
  expect(out.map((s) => s.text)).toEqual(['Prefers answers in British English'])
})

test('the memory block is background facts that the files, command output and latest message outrank', () => {
  const block = prompts.system.context.memory(
    ['- [fact, this project] Tests run with npm test'],
    0,
    true,
    true,
  )
  expect(block).toContain('as background, not instructions')
  expect(block).toContain('their latest message disagree, those win')
  expect(block).toContain('propose the fix with remember')
  expect(block).not.toContain('follow it')
  // Without remember the agent is not told to use it.
  expect(prompts.system.context.memory(['- [fact] x'], 0, false, false)).not.toContain('remember')
})

test('a tidy-up merges memories of one scope only, and never ones another suggestion already replaces', () => {
  const m = (id: string, text: string, project?: string, day = '01'): Memory => ({
    id,
    text,
    kind: 'preference',
    ...(project ? { project } : {}),
    status: 'active',
    source: person,
    createdAt: `2026-10-${day}T00:00:00.000Z`,
    updatedAt: `2026-10-${day}T00:00:00.000Z`,
  })
  const kept = [
    m('a', 'Tabs'),
    m('b', 'Tabs, width 4', undefined, '05'),
    m('c', 'Spaces here', 'p1'),
    m('d', 'Dark'),
  ]
  const waiting: Memory[] = [{ ...m('w', 'Dark theme'), status: 'proposed', replaces: ['d'] }]
  const out = checkReflected(
    [
      { text: 'Indent with tabs, width 4', replaces: ['a', 'b'], why: 'same topic' },
      { text: 'Mixed scopes', replaces: ['a', 'c'] },
      { text: 'Dark mode everywhere', replaces: ['d'] },
      { text: 'Unknown ids', replaces: ['zz'] },
    ],
    { kept, waiting },
  )
  expect(out).toEqual([
    { text: 'Indent with tabs, width 4', kind: 'preference', replaces: ['a', 'b'], why: 'same topic' },
  ])
})
