import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony, type MyrEvent } from '@myrmidon/protocol'
import {
  bootRuntime,
  ChatService,
  type Classify,
  detectSandbox,
  ModelResolver,
  type Runtime,
  type TeamConfig,
} from '../src/index.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-jobs-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(home, { recursive: true, force: true })
})

const tool = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})

const solo: Classify = async () => 'solo'
const QUIET_MS = 500

/** Who is calling: a delegated job's helper (by a word of its brief) or the lead. */
const brief = (ctx: LlmContext) => {
  const first = ctx.messages.find((m) => m.role === 'user')
  return typeof first?.content === 'string' ? first.content : JSON.stringify(first?.content ?? '')
}
const isHelper = (ctx: LlmContext) => (ctx.systemPrompt?.join('\n') ?? '').includes('doing one job that')
const said = (ctx: LlmContext) => JSON.stringify(ctx.messages)

/** One mock for the lead and every fresh helper (they share its model): `lead` and `helper` answer by turn. */
function router(
  resolver: ModelResolver,
  ref: string,
  lead: (ctx: LlmContext, call: number) => MockContent[],
  helper: (ctx: LlmContext, job: string, call: number) => MockContent[],
  /** How long each helper call takes, so the lead's turn can overlap its helpers' work. */
  helperMs = 0,
) {
  const calls = new Map<string, number>()
  const mock = createMockModel({
    handler: (ctx: LlmContext) => {
      const who = isHelper(ctx) ? brief(ctx) : 'lead'
      const n = calls.get(who) ?? 0
      calls.set(who, n + 1)
      return who === 'lead'
        ? { content: lead(ctx, n) }
        : { content: helper(ctx, who, n), ...(helperMs ? { delayMs: helperMs } : {}) }
    },
  })
  resolver.register(ref, { model: mock.model, streamFn: mock.stream })
}

function judge(resolver: ModelResolver) {
  const m = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "complete"}'] }) })
  resolver.register('mock/judge', { model: m.model, streamFn: m.stream })
}

const config = (subagents?: number): TeamConfig => ({
  mode: 'orchestrated',
  leadModel: 'mock/lead',
  roster: [],
  judgeModel: 'mock/judge',
  ...(subagents === undefined ? {} : { subagents }),
})

async function waitFor(
  colonyId: string,
  until = (s: ColonyState) => s.status !== 'running' && s.status !== 'created',
) {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (until(s)) return s
    await Bun.sleep(50)
  }
  throw new Error('colony did not reach the expected state')
}

const events = (colonyId: string) => runtime.ctx.log.read(colonyId as never)
const payloads = <T extends keyof EventPayloads>(log: readonly MyrEvent[], type: T) =>
  log.filter((e) => e.type === type).map((e) => ({ ...(e.payload as EventPayloads[T]), seq: e.seq }))

const MONEY_JOB =
  'Goal: fix formatCents in money.ts. Context: tests are the spec. Deliverable: the fix. Done when: tests pass. Not yours: dates.ts.'
const DATES_JOB =
  'Goal: fix daysBetween in dates.ts. Context: tests are the spec. Deliverable: the fix. Done when: tests pass. Not yours: money.ts.'

test('a lead working alone delegates jobs that start at once, keeps working, and gets typed, checked results', async () => {
  const resolver = new ModelResolver()
  const seen: { delegated?: string; refused?: string; results?: string; tools?: string[] } = {}
  router(
    resolver,
    'mock/lead',
    (ctx, n) => {
      if (n === 0) {
        seen.tools = ctx.tools?.map((t) => t.name)
        return [
          tool('delegate', {
            context: 'Two independent modules; each job owns one file.',
            jobs: [
              { brief: MONEY_JOB, files: ['money.ts'] },
              { brief: DATES_JOB, files: ['./dates.ts'] },
            ],
          }),
        ]
      }
      if (n === 1) {
        seen.delegated = said(ctx)
        // Answering while the jobs run is refused: their results would be lost.
        return [tool('reply_user', { text: 'Done.', final: true })]
      }
      if (n === 2) {
        seen.refused = said(ctx)
        return [tool('await_results', { all: true })]
      }
      seen.results = said(ctx)
      return [tool('reply_user', { text: 'Both modules are fixed.', final: true })]
    },
    (_ctx, job, n) => {
      if (n > 0) return ['reported']
      return job.includes('formatCents')
        ? // Claims a check it never ran: the harness lowers its confidence.
          [
            tool('report_result', {
              status: 'done',
              summary: 'Fixed formatCents to group thousands.',
              checks: [{ command: 'bun test money.test.ts', passed: true }],
              confidence: 'high',
            }),
          ]
        : [
            tool('report_result', {
              status: 'blocked',
              summary: 'dates.ts is not in this folder.',
              blockers: ['dates.ts does not exist'],
              confidence: 'medium',
            }),
          ]
    },
    800,
  )
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS })
  const { colonyId } = await chats.send('Fix money.ts and dates.ts', config())
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(seen.tools).toEqual(expect.arrayContaining(['delegate', 'await_results']))
  // The round did not move to a team: delegating replaces escalating to one.
  expect(seen.tools).not.toContain('escalate')
  expect(s.rounds).toHaveLength(1)
  // Ids come back at once; both jobs started (the default runs four at a time).
  expect(seen.delegated).toContain('Started job-1')
  expect(seen.delegated).toContain('job-2')
  expect(seen.refused).toContain('Delegated jobs are still open')
  const log = await events(colonyId)
  expect(payloads(log, 'job/queued').map((j) => j.files)).toEqual([['money.ts'], ['dates.ts']])
  expect(payloads(log, 'job/started')).toHaveLength(2)
  const finished = payloads(log, 'job/finished')
  const money = finished.find((f) => f.id === 'job-1')?.result
  expect(money).toMatchObject({
    status: 'done',
    confidence: 'medium',
    claimedConfidence: 'high',
    checks: [{ command: 'bun test money.test.ts', passed: true, seen: false }],
  })
  expect(finished.find((f) => f.id === 'job-2')?.result).toMatchObject({
    status: 'blocked',
    blockers: ['dates.ts does not exist'],
  })
  // Each result reached the lead as one envelope, with the lowered confidence and why.
  expect(seen.results).toContain('<job-result id=\\"job-1\\"')
  expect(seen.results).toContain('Confidence lowered from high')
  expect(seen.results).toContain('status=\\"blocked\\"')
  // A helper sees its brief and the shared context, never the person's request or the conversation.
  const helpers = Object.values(s.agents).filter((a) => a.info.role === 'worker')
  expect(helpers).toHaveLength(2)
  for (const h of helpers) {
    expect(h.info.tools).toContain('report_result')
    expect(h.info.tools).not.toContain('reply_user')
    expect(h.dismissed).toBe(true)
  }
  const kickoffs = payloads(log, 'job/queued').map((j) => j.brief)
  expect(kickoffs[0]).toContain('Context shared by every job:\nTwo independent modules')
  expect(kickoffs[0]).not.toContain('Fix money.ts and dates.ts')
  await chats.stopAll()
})

test('crewmates on call run jobs under their own names, models and roles, opening with the job alone', async () => {
  const resolver = new ModelResolver()
  const seen: { job?: string; results?: string } = {}
  const COUNT = 'Goal: count the ants in a typical colony. Done when: one number with a source.'
  const roles = (ctx: LlmContext) =>
    Object.fromEntries(
      [...(ctx.systemPrompt?.join('\n') ?? '').matchAll(/^- (\w+): (researcher|writer) \(/gm)].map((m) => [
        m[2],
        m[1],
      ]),
    )
  router(
    resolver,
    'mock/lead',
    (ctx, n) => {
      if (n === 0) {
        const by = roles(ctx)
        return [
          tool('delegate', {
            jobs: [
              { brief: COUNT, readOnly: true, crewmate: by.researcher },
              {
                brief: 'Goal: a one-line title for an ant poem. Done when: one line.',
                readOnly: true,
                crewmate: by.writer,
              },
            ],
          }),
        ]
      }
      if (n === 1) return [tool('await_results', { all: true })]
      seen.results = said(ctx)
      return [tool('reply_user', { text: 'About 300,000 ants.', final: true })]
    },
    () => ['unused'],
  )
  for (const [ref, summary] of [
    ['mock/researcher', 'Typically 300,000 ants.'],
    ['mock/writer', 'Small Feet, Great Hills.'],
  ] as const) {
    const m = createMockModel({
      handler: (ctx: LlmContext) => {
        if (ref === 'mock/researcher') seen.job ??= brief(ctx)
        return ctx.messages.some((x) => x.role === 'toolResult')
          ? { content: ['reported'] }
          : { content: [tool('report_result', { status: 'done', summary, confidence: 'medium' })] }
      },
    })
    resolver.register(ref, { model: m.model, streamFn: m.stream })
  }
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS })
  const { colonyId } = await chats.send('How many ants are in a colony?', {
    ...config(),
    roster: [
      { role: 'researcher', model: 'mock/researcher' },
      { role: 'writer', model: 'mock/writer' },
    ],
  })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  const joined = Object.values(s.agents).filter((a) => a.info.role === 'worker')
  expect(joined.map((a) => [a.info.specialty, a.info.model]).sort()).toEqual([
    ['researcher', 'mock/researcher'],
    ['writer', 'mock/writer'],
  ])
  // A read-only job gets no hands to change anything.
  for (const a of joined) expect(a.info.tools).not.toContain('fs_write')
  // A crewmate opens with its job alone: not the person's request, not a mail to answer.
  expect(seen.job).toBe(JSON.stringify([{ type: 'text', text: COUNT }]))
  expect(seen.results).toContain('Typically 300,000 ants.')
  expect(seen.results).toContain('Small Feet, Great Hills.')
  expect(s.chatMessages.filter((m) => m.from !== 'lead' && m.from !== 'user')).toEqual([])
  await chats.stopAll()
})

test('jobs past the limit wait their turn, and two jobs may not own one file', async () => {
  const resolver = new ModelResolver()
  const seen: { overlap?: string } = {}
  router(
    resolver,
    'mock/lead',
    (ctx, n) => {
      if (n === 0)
        return [
          tool('delegate', {
            jobs: [
              { brief: MONEY_JOB, files: ['money.ts'] },
              { brief: `${MONEY_JOB} Also the README.`, files: ['money.ts', 'README.md'] },
            ],
          }),
        ]
      if (n === 1) {
        seen.overlap = said(ctx)
        return [
          tool('delegate', {
            jobs: [
              { brief: MONEY_JOB, files: ['money.ts'] },
              { brief: DATES_JOB, files: ['dates.ts'] },
            ],
          }),
        ]
      }
      if (n === 2) return [tool('await_results', { all: true })]
      return [tool('reply_user', { text: 'Done.', final: true })]
    },
    (_ctx, _job, n) =>
      n > 0
        ? ['reported']
        : [
            tool('report_result', {
              status: 'done',
              summary: 'Read it; nothing to change.',
              confidence: 'high',
            }),
          ],
  )
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS })
  const { colonyId } = await chats.send('Fix both', config(1))
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(seen.overlap).toContain('which jobs[0] owns')
  expect(seen.overlap).toContain('Nothing was started')
  const log = await events(colonyId)
  // One place: job-2 starts only after job-1's result is in.
  const started = payloads(log, 'job/started')
  const finished = payloads(log, 'job/finished')
  expect(started.map((j) => j.id)).toEqual(['job-1', 'job-2'])
  expect(started[1]?.seq ?? 0).toBeGreaterThan(finished.find((f) => f.id === 'job-1')?.seq ?? Infinity)
  await chats.stopAll()
})

test('a helper that never reports is reminded twice, then the harness reports it failed and the round goes on', async () => {
  const resolver = new ModelResolver()
  const seen: { result?: string; reminders: number } = { reminders: 0 }
  router(
    resolver,
    'mock/lead',
    (ctx, n) => {
      if (n === 0) return [tool('delegate', { jobs: [{ brief: MONEY_JOB, files: ['money.ts'] }] })]
      if (n === 1) return [tool('await_results', {})]
      seen.result = said(ctx)
      return [tool('reply_user', { text: 'The helper went quiet; I will do it myself.', final: true })]
    },
    (ctx) => {
      if (said(ctx).includes('without report_result')) seen.reminders += 1
      return ['Thinking about it.']
    },
  )
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS })
  const { colonyId } = await chats.send('Fix money', config())
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(seen.reminders).toBe(2)
  const [finished] = payloads(await events(colonyId), 'job/finished')
  expect(finished?.result).toMatchObject({ status: 'failed', byHarness: true, confidence: 'low' })
  expect(seen.result).toContain('ended its turns without reporting a result')
  await chats.stopAll()
})

test('a helper whose model fails fails its job, not the round', async () => {
  const resolver = new ModelResolver()
  const seen: { result?: string; coder?: string } = {}
  router(
    resolver,
    'mock/lead',
    (ctx, n) => {
      if (n === 0) {
        // The crewmate on call, by the name its roster line gives it.
        seen.coder = /^- (\w+): coder \(/m.exec(ctx.systemPrompt?.join('\n') ?? '')?.[1]
        return [tool('delegate', { jobs: [{ brief: MONEY_JOB, files: ['money.ts'], crewmate: seen.coder }] })]
      }
      if (n === 1) return [tool('await_results', {})]
      seen.result = said(ctx)
      return [tool('reply_user', { text: 'The coder failed; I did it myself.', final: true })]
    },
    () => ['unused'],
  )
  const broken = createMockModel({
    handler: () => {
      throw new Error('provider exploded')
    },
  })
  resolver.register('mock/broken', { model: broken.model, streamFn: broken.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS })
  const { colonyId } = await chats.send('Fix money', {
    ...config(),
    roster: [{ role: 'coder', model: 'mock/broken' }],
  })
  const s = await waitFor(colonyId)
  expect(seen.coder).toBeDefined()
  expect(s.status).toBe('completed')
  const [finished] = payloads(await events(colonyId), 'job/finished')
  expect(finished?.agent).toBe(seen.coder)
  expect(finished?.result).toMatchObject({ status: 'failed', byHarness: true })
  expect(seen.result).toContain(`${seen.coder} stopped`)
  await chats.stopAll()
})

test.skipIf(detectSandbox().kind === 'none')(
  'a job in a git project works in its own worktree, and its done work merges with the files taken from it',
  async () => {
    const { ProjectStore } = await import('../src/projects.ts')
    const folder = mkdtempSync(join(tmpdir(), 'myr-jobs-project-'))
    await Bun.write(join(folder, 'money.ts'), 'export const cents = (n: number) => `$${n}`\n')
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['add', '-A'],
      ['-c', 'user.name=t', '-c', 'user.email=t@local', 'commit', '-q', '-m', 'fixture'],
    ])
      expect(Bun.spawnSync(['git', ...args], { cwd: folder }).exitCode).toBe(0)
    const projects = new ProjectStore(home)
    const project = projects.setPermissions(projects.add(folder).id, { mode: 'auto', allow: [] })
    const resolver = new ModelResolver()
    const seen: { result?: string } = {}
    router(
      resolver,
      'mock/lead',
      (ctx, n) => {
        if (n === 0) return [tool('delegate', { jobs: [{ brief: MONEY_JOB, files: ['money.ts'] }] })]
        if (n === 1) return [tool('await_results', {})]
        seen.result = said(ctx)
        return [tool('reply_user', { text: 'Fixed.', final: true })]
      },
      (_ctx, _job, n) =>
        [
          [
            tool('fs_write', {
              path: 'money.ts',
              content: 'export const cents = (n: number) => `$${n / 100}`\n',
            }),
          ],
          [tool('shell', { command: 'grep -q "n / 100" money.ts' })],
          [
            tool('report_result', {
              status: 'done',
              summary: 'Divided by 100.',
              checks: [{ command: 'grep -q "n / 100" money.ts', passed: true }],
              confidence: 'high',
            }),
          ],
        ][n] ?? ['reported'],
    )
    judge(resolver)
    const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS, projects })
    const { colonyId } = await chats.send('Fix money', config(), undefined, { project: project.id })
    const s = await waitFor(colonyId)
    expect(s.status).toBe('completed')
    const log = await events(colonyId)
    const helper = payloads(log, 'job/started')[0]?.agent ?? ''
    expect(payloads(log, 'worktree/created').map((w) => w.agent)).toEqual([helper])
    expect(payloads(log, 'worktree/merged')[0]?.files).toEqual(['money.ts'])
    expect(payloads(log, 'job/finished')[0]?.result).toMatchObject({
      status: 'done',
      filesChanged: ['money.ts'],
      confidence: 'high',
      checks: [{ seen: true, passed: true }],
    })
    expect(await Bun.file(join(folder, 'money.ts')).text()).toContain('n / 100')
    expect(seen.result).toContain("merged into the person's folder")
    await chats.stopAll()
    // The round closes its worktrees after it completes: the repository must outlive that.
    await waitFor(colonyId, (x) => Object.values(x.worktrees).every((w) => w.kept !== undefined))
    rmSync(folder, { recursive: true, force: true })
  },
)
