import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decide, type PermissionCall, type PermissionLevels } from '@myrmidon/protocol'
import { changedPaths, planCommits } from '../src/commit-split.ts'
import type { ColonyHost, ReviewDecision } from '../src/host.ts'
import { TOOL_DEFS } from '../src/tools.ts'

let repo: string

const git = (...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'myr-commits-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'robin@example.com')
  git('config', 'user.name', 'Robin')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'parse.ts'), 'export const parse = (s: string) => s\n')
  writeFileSync(join(repo, 'old.ts'), 'export const old = 1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'Start')
  // A new module, the code using it, its docs, a rename, and something already staged.
  writeFileSync(join(repo, 'tokens.ts'), 'export const tokens = (s: string) => s.split(" ")\n')
  writeFileSync(
    join(repo, 'parse.ts'),
    'import { tokens } from "./tokens"\nexport const parse = (s: string) => tokens(s)\n',
  )
  mkdirSync(join(repo, 'docs'))
  writeFileSync(join(repo, 'docs', 'parse.md'), '# Parsing\n')
  git('mv', 'old.ts', 'legacy.ts')
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

const PLAN = [
  { files: ['parse.ts'], subject: 'Parse through the tokenizer', dependsOn: [1] },
  { files: ['tokens.ts'], subject: 'Add a whitespace tokenizer' },
  {
    files: ['docs/parse.md', 'legacy.ts'],
    subject: 'Document parsing and rename old.ts',
    body: 'Old name read as dead code.',
  },
]

test('a plan must cover every changed file once, in an order without cycles, with messages that pass omp’s checks', async () => {
  expect((await changedPaths(repo)).map((c) => c.path).sort()).toEqual([
    'docs/parse.md',
    'legacy.ts',
    'parse.ts',
    'tokens.ts',
  ])
  const good = await planCommits(repo, PLAN)
  expect(good.errors).toEqual([])
  // Dependencies first: the tokenizer before the code that uses it.
  expect(good.order).toEqual([1, 2, 0])
  expect(good.preview.split('\n')[0]).toBe('1. Add a whitespace tokenizer')
  const bad = await planCommits(repo, [
    { files: ['parse.ts', 'nope.ts'], subject: 'Updated code in various places.', dependsOn: [1] },
    { files: ['parse.ts'], subject: 'x'.repeat(80), dependsOn: [0] },
  ])
  expect(bad.errors).toEqual(
    expect.arrayContaining([
      expect.stringContaining('nope.ts has no changes'),
      expect.stringContaining('File appears in multiple commits: parse.ts'),
      'Commit 1: Summary must not end with a period',
      'Commit 1: Avoid meta phrase: updated code',
      'Commit 2: Summary exceeds 72 characters',
      'Changed file missing from the plan: tokens.ts',
      'Circular dependency detected in split commit plan.',
    ]),
  )
  expect(bad.warnings).toContain('Commit 1: Avoid filler word: various')
})

/** A host whose permission model runs under Auto and whose cards answer `answer`, recording what they showed. */
function host(answer: ReviewDecision) {
  const levels: PermissionLevels = { global: { preset: 'auto', rules: [] } }
  const cards: { summary: string; plan?: string }[] = []
  const asked: PermissionCall[] = []
  const h = {
    spec: { agents: [] },
    permit: (_agent: string, call: PermissionCall) => {
      asked.push(call)
      return decide(levels, call)
    },
    reviewChange: async (
      _a: string,
      _t: string,
      summary: string,
      opts: { review?: { fields: { value: string }[] } },
    ) => {
      cards.push({ summary, plan: opts.review?.fields[0]?.value })
      return answer
    },
    state: () => ({ rounds: [], receipts: {}, approvals: {} }),
    workspace: { workdir: () => repo },
  } as unknown as ColonyHost
  return { h, cards, asked }
}

const split = TOOL_DEFS.find((d) => d.name === 'split_commits')

test('split_commits checks without writing, shows the person the plan before it commits, and never pushes', async () => {
  const declined = host({ approved: false, note: 'not yet' })
  // Without write: only the check.
  const checked = String(await split?.run({ commits: PLAN }, 'lead', declined.h))
  expect(checked).toContain('The plan is valid')
  expect(declined.cards).toEqual([])
  // With write, Auto still asks: the card holds the whole plan; declined, nothing is committed.
  await expect(
    split?.run({ commits: PLAN, write: true }, 'lead', declined.h) ?? Promise.resolve(),
  ).rejects.toThrow('not yet')
  expect(declined.cards[0]?.summary).toBe('Make 3 commits')
  expect(declined.cards[0]?.plan).toContain('1. Add a whitespace tokenizer')
  expect(git('rev-list', '--count', 'HEAD')).toBe('1')

  const approved = host({ approved: true })
  const out = String(await split?.run({ commits: PLAN, write: true }, 'lead', approved.h))
  expect(out).toContain('Made 3 commits (nothing was pushed)')
  expect(git('log', '--format=%s', '-3').split('\n')).toEqual([
    'Parse through the tokenizer',
    'Document parsing and rename old.ts',
    'Add a whitespace tokenizer',
  ])
  // The rename landed as one, with its body; the tree is clean.
  expect(git('show', '--stat', '--format=%b', 'HEAD~1')).toContain('Old name read as dead code.')
  expect(git('show', '--name-status', '--format=', 'HEAD~1')).toContain('R100\told.ts\tlegacy.ts')
  expect(git('status', '--porcelain')).toBe('')
  // Decided as the commits it makes, which no preset runs unasked.
  expect(approved.asked[0]).toMatchObject({
    tool: 'split_commits',
    kind: 'command',
    asks: true,
    readOnly: false,
  })
})
