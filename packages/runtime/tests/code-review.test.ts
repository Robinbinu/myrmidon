import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, foldColony } from '@myrmidon/protocol'
import { reviewGroups, reviewScope } from '../src/code-review.ts'
import { bootRuntime, ChatService, ModelResolver, type Runtime, type TeamConfig } from '../src/index.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel } from '../src/omp/mock.ts'
import { toolsFor } from '../src/patterns.ts'
import { ProjectStore } from '../src/projects.ts'

let repo: string
let home: string
let runtime: Runtime

const git = (...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}
const write = (path: string, text: string) => {
  mkdirSync(join(repo, path, '..'), { recursive: true })
  writeFileSync(join(repo, path), text)
}

beforeEach(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'myr-review-repo-')))
  home = mkdtempSync(join(tmpdir(), 'myr-review-'))
  runtime = await bootRuntime(home)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'robin@example.com')
  git('config', 'user.name', 'Robin')
  git('config', 'commit.gpgsign', 'false')
  write('src/cart.ts', 'export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0)\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'Start')
})

afterEach(async () => {
  await runtime.dispose()
  for (const dir of [repo, home]) rmSync(dir, { recursive: true, force: true })
})

test('the scope is the uncommitted work, else the branch against its base, a commit, a range or named files', async () => {
  git('checkout', '-q', '-b', 'coupons')
  write('src/coupons.ts', 'export const off = (p: number) => p * 0.9\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'Add coupons')
  const sha = git('rev-parse', '--short', 'HEAD')
  // Nothing uncommitted: the branch against main.
  const branch = await reviewScope(repo)
  expect(branch.mode).toBe('branch coupons against main')
  expect(branch.files.map((f) => f.path)).toEqual(['src/coupons.ts'])
  expect((await reviewScope(repo, sha)).mode).toBe(`commit ${sha}`)
  expect((await reviewScope(repo, 'main..coupons')).files).toHaveLength(1)
  expect((await reviewScope(repo, '#12')).diff).toBe('fs_read pr://12/diff')
  write('src/cart.ts', 'export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 1)\n')
  write('notes.md', '# notes\n')
  const local = await reviewScope(repo)
  expect(local.mode).toContain('uncommitted')
  expect(local.files.map((f) => f.path).sort()).toEqual(['notes.md', 'src/cart.ts'])
  expect((await reviewScope(repo, 'src')).files.map((f) => f.path)).toEqual(['src/cart.ts'])
})

test('files are grouped by folder for parallel reviewers, tests with their code, at most four groups', () => {
  const f = (path: string, n = 10) => ({ path, added: n, removed: 0 })
  const files = [
    f('src/a.ts'),
    f('tests/a.test.ts'),
    ...['web', 'db', 'cli', 'ops'].flatMap((d) => [f(`${d}/a.ts`), f(`${d}/b.ts`)]),
    f('docs/x.md', 1),
  ]
  const groups = reviewGroups(files)
  // Eleven files, six a reviewer: two groups; the test stays with its code, and a stem shared across folders moves nothing.
  expect(groups).toHaveLength(2)
  expect(groups.find((g) => g.some((x) => x.path === 'src/a.ts'))?.map((x) => x.path)).toContain(
    'tests/a.test.ts',
  )
  expect(groups.flat()).toHaveLength(files.length)
  const many = reviewGroups(Array.from({ length: 60 }, (_, i) => f(`m${i}/x${i}.ts`)))
  expect(many).toHaveLength(4)
})

test('/review runs a lead and read-only reviewers in parallel, one group each, with the notes the person pinned', async () => {
  for (const dir of ['api', 'web', 'db', 'jobs', 'cli', 'lib', 'ops', 'ui'])
    for (let i = 0; i < 2; i++) write(`${dir}/f${i}.ts`, `export const v${i} = ${i}\n`)
  const resolver = new ModelResolver()
  const openings: string[] = []
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      openings.push(JSON.stringify(ctx.messages[0]?.content))
      return {
        content: [
          { type: 'toolCall', name: 'reply_user', arguments: { text: 'Verdict: correct', final: true } },
        ],
      }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
  resolver.register('mock/reviewer', { model: judge.model, streamFn: judge.stream })
  const projects = new ProjectStore(home)
  const project = projects.add(repo)
  const chats = new ChatService(runtime, { resolver, projects, classify: async () => 'answer' })
  const config: TeamConfig = {
    mode: 'swarm',
    leadModel: 'mock/lead',
    roster: [],
    judgeModel: 'mock/reviewer',
  }
  // A first round, then a note pinned to its diff.
  const first = await chats.send('hello', config, undefined, { project: project.id })
  await ended(first.colonyId)
  const id = await chats.annotate(first.chatId, {
    path: 'api/f1.ts',
    line: 1,
    text: 'Should v1 be exported?',
  })
  await chats
    .annotate(first.chatId, { path: 'web/f0.ts', line: 1, text: 'gone soon' })
    .then((x) => chats.unannotate(first.chatId, x))
  const s0 = foldColony(first.colonyId, await runtime.ctx.log.read(first.colonyId as never))
  expect(Object.keys(s0.annotations ?? {})).toEqual([id])

  const sent = await chats.send('Use the review skill on the changes on this branch.', config, first.chatId, {
    codeReview: { target: '' },
  })
  const s = await ended(sent.colonyId)
  expect(s.tier).toBe('team')
  // The first round's lone peer stays in the chat's state; the reviewers are this round's workers.
  const reviewers = Object.values(s.agents).filter((a) => a.info.role === 'worker')
  // 16 files, six a reviewer: three reviewers, each on the reviewer model.
  expect(reviewers).toHaveLength(3)
  expect(reviewers.every((r) => r.info.model === 'mock/reviewer')).toBe(true)
  const opening = openings.find((o) => o.includes('Code review request')) ?? ''
  expect(opening).toContain('Mode: uncommitted changes')
  expect(opening).toContain('| api/f0.ts | +1/-0 |')
  for (const r of reviewers) expect(opening).toContain(`- ${r.info.name}: `)
  expect(opening).toContain('api/f1.ts:1: Should v1 be exported?')
  expect(opening).not.toContain('gone soon')
  await chats.stopAll()
})

test('reviewers are kept off every tool that changes the code', () => {
  const spec = {
    name: 'r',
    mission: 'm',
    pattern: 'lead-workers',
    tier: 'team',
    agents: [
      { name: 'lead', role: 'lead', model: 'm' },
      {
        name: 'ann',
        role: 'worker',
        model: 'm',
        withoutTools: ['fs_write', 'fs_edit', 'ast_edit', 'split_commits', 'propose'],
      },
    ],
    acceptance: [],
    budget: { wallMs: 0, maxTurns: 10 },
    observer: { intervalMs: 1000 },
    chat: { chatId: 'c', round: 1, request: 'r', history: '', project: { id: 'p', name: 'p', path: repo } },
    team: { mode: 'orchestrated', maxWorkers: 1, workerModels: ['m'] },
  } as unknown as import('../src/spec.ts').ColonySpec
  const tools = toolsFor(spec, spec.agents[1] as never)
  expect(tools).toContain('fs_read')
  for (const t of ['fs_write', 'fs_edit', 'split_commits', 'propose']) expect(tools).not.toContain(t)
})

async function ended(colonyId: string): Promise<ColonyState> {
  for (let i = 0; i < 600; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (s.rounds.length && !['running', 'created'].includes(s.status)) return s
    await Bun.sleep(25)
  }
  throw new Error('the round did not end')
}
