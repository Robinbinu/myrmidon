import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony, type MyrEvent } from '@myrmidon/protocol'
import { GOAL } from '../src/config.ts'
import { parseGoal } from '../src/goal.ts'
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
  home = mkdtempSync(join(tmpdir(), 'myr-goal-'))
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
/** How long a round stays open once everyone is quiet after the answer; the real wait would outlast a test. */
const QUIET_MS = 500

/** A model whose `n`th call (from 1) answers `step(n, ctx)`; the calls it got are counted. */
function model(
  resolver: ModelResolver,
  ref: string,
  step: (n: number, ctx: LlmContext) => MockContent[] | Promise<MockContent[]>,
) {
  const seen: LlmContext[] = []
  const mock = createMockModel({
    handler: async (ctx: LlmContext) => {
      seen.push(ctx)
      return { content: await step(seen.length, ctx) }
    },
  })
  resolver.register(ref, { model: mock.model, streamFn: mock.stream })
  return seen
}

/** Works, then answers, again and again: odd calls write a file, even ones send the final answer. */
const worker = (n: number): MockContent[] =>
  n % 2 === 1
    ? [tool('fs_write', { path: `step-${n}.md`, content: `step ${n}` })]
    : [tool('reply_user', { text: `Done (pass ${n / 2}).`, final: true })]

/**
 * The reviewer: a goal check (its rubric names the goal) scores with `goal(n)` for the nth goal check; the round's
 * own review always passes.
 */
function judge(resolver: ModelResolver, goal: (n: number) => number) {
  let checks = 0
  model(resolver, 'mock/judge', (_n, ctx) => {
    const asked = JSON.stringify(ctx.messages)
    const score = asked.includes('The goal the person set') ? goal(++checks) : 0.9
    return [`{"score": ${score}, "reasons": "judged"}`]
  })
}

const team = (extra: Partial<TeamConfig> = {}): TeamConfig => ({
  mode: 'orchestrated',
  leadModel: 'mock/lead',
  roster: [],
  judgeModel: 'mock/judge',
  ...extra,
})

const events = (colonyId: string) => runtime.ctx.log.read(colonyId as never)

async function waitFor(
  colonyId: string,
  until = (s: ColonyState) => s.status !== 'running' && s.status !== 'created',
) {
  for (let i = 0; i < 600; i++) {
    const s = foldColony(colonyId, await events(colonyId))
    if (until(s)) return s
    await Bun.sleep(50)
  }
  throw new Error('colony did not reach the expected state')
}

const goalVerdicts = (s: ColonyState) => s.verdicts.filter((v) => v.target === 'goal')
const ofType = <T extends keyof EventPayloads>(log: readonly MyrEvent[], type: T) =>
  log.filter((e) => e.type === type).map((e) => e.payload as EventPayloads[T])

test('a goal reads its condition and how it is checked from the message', () => {
  expect(parseGoal('until the tests pass: fix the parser')).toEqual({
    condition: 'the tests pass',
    check: { kind: 'checks' },
  })
  expect(parseGoal('`bun run check:all` exits 0: tidy the types')).toEqual({
    condition: '`bun run check:all` exits 0',
    check: { kind: 'command', run: 'bun run check:all' },
  })
  expect(parseGoal('Until the README explains setup: write the docs')).toEqual({
    condition: 'the README explains setup',
    check: { kind: 'judge' },
  })
  // Without a colon the whole message is the goal.
  expect(parseGoal('every link on the page works')).toEqual({
    condition: 'every link on the page works',
    check: { kind: 'judge' },
  })
})

test('a goal round keeps working until its check passes, then reviews and completes', async () => {
  const resolver = new ModelResolver()
  const lead = model(resolver, 'mock/lead', worker)
  judge(resolver, (n) => (n < 3 ? 0.2 : 0.9))
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS })
  const { colonyId } = await chats.send(
    'until the summary covers every chapter: summarize the book',
    team(),
    undefined,
    {
      goal: true,
    },
  )
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(goalVerdicts(s).map((v) => [v.verifierId, v.pass])).toEqual([
    ['goal#1', false],
    ['goal#2', false],
    ['goal#3', true],
  ])
  // The lead was told the goal at the start, and the result of each failed check after it.
  expect(JSON.stringify(lead[0]?.messages)).toContain('Goal mode: keep working until this holds')
  expect(JSON.stringify(lead.at(-1)?.messages)).toContain('GOAL NOT MET YET (check 2 of')
  const [created] = ofType(await events(colonyId), 'colony/created')
  expect(created?.goal).toMatchObject({
    condition: 'the summary covers every chapter',
    check: { kind: 'judge' },
    maxChecks: GOAL.maxChecks,
  })
  // A goal outlasts one answer's wall.
  expect(s.budget.wallMs).toBeGreaterThanOrEqual(GOAL.wallMinutes * 60_000)
})

test('a goal round stops once its checks run out', async () => {
  const resolver = new ModelResolver()
  model(resolver, 'mock/lead', worker)
  judge(resolver, () => 0.1)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS })
  const { colonyId } = await chats.send('until it is perfect: polish the essay', team(), undefined, {
    goal: true,
  })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('stopped')
  expect(s.statusReason).toBe(`goal not reached after ${GOAL.maxChecks} checks; see the last result`)
  expect(goalVerdicts(s)).toHaveLength(GOAL.maxChecks)
  expect(goalVerdicts(s).every((v) => !v.pass)).toBe(true)
})

test('a goal round that does nothing between checks stops instead of looping', async () => {
  const resolver = new ModelResolver()
  model(resolver, 'mock/lead', () => [tool('reply_user', { text: 'Done.', final: true })])
  judge(resolver, () => 0.1)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS })
  const { colonyId } = await chats.send('until it is perfect: polish the essay', team(), undefined, {
    goal: true,
  })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('stopped')
  expect(s.statusReason).toBe('goal not reached, and nothing was done since the last check')
  expect(goalVerdicts(s)).toHaveLength(2)
})

test("the person's stop ends a goal round between checks", async () => {
  const resolver = new ModelResolver()
  // After the first check fails the lead works slowly, so the person stops it mid-way.
  model(resolver, 'mock/lead', async (n) => {
    if (n > 2) await Bun.sleep(400)
    return worker(n)
  })
  judge(resolver, () => 0.1)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS })
  const { chatId, colonyId } = await chats.send('until it is perfect: polish the essay', team(), undefined, {
    goal: true,
  })
  await waitFor(colonyId, (s) => goalVerdicts(s).length === 1)
  await chats.stop(chatId)
  const s = await waitFor(colonyId)
  expect(s.status).toBe('stopped')
  expect(s.statusReason).not.toContain('goal')
  await Bun.sleep(600)
  expect(goalVerdicts(foldColony(colonyId, await events(colonyId)))).toHaveLength(1)
})

test('a goal message to a running round is refused: a goal starts its own round', async () => {
  const resolver = new ModelResolver()
  model(resolver, 'mock/lead', async () => {
    await Bun.sleep(300)
    return [tool('reply_user', { text: 'Done.', final: true })]
  })
  judge(resolver, () => 0.9)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS })
  const { chatId, colonyId } = await chats.send('Write a haiku', team())
  await waitFor(colonyId, (s) => s.status === 'running')
  await expect(chats.send('until it rhymes: rewrite it', team(), chatId, { goal: true })).rejects.toThrow(
    'a goal starts its own round',
  )
  await chats.stop(chatId)
})

test.skipIf(detectSandbox().kind === 'none')(
  "a command goal holds when the command exits 0, and stops when the command can't run",
  async () => {
    const resolver = new ModelResolver()
    model(resolver, 'mock/lead', (n) =>
      n === 1
        ? [tool('reply_user', { text: 'Done.', final: true })]
        : n === 2
          ? [tool('fs_write', { path: 'done.txt', content: 'yes' })]
          : [tool('reply_user', { text: 'Done now.', final: true })],
    )
    judge(resolver, () => 0.9)
    const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS })
    const { colonyId } = await chats.send('`test -f done.txt`: make done.txt', team(), undefined, {
      goal: true,
    })
    const s = await waitFor(colonyId)
    expect(goalVerdicts(s).map((v) => v.pass)).toEqual([false, true])
    expect(goalVerdicts(s)[0]?.evidence).toContain('`test -f done.txt` exit 1')
    expect(s.status).toBe('completed')

    const broken = new ModelResolver()
    model(broken, 'mock/lead', () => [tool('reply_user', { text: 'Done.', final: true })])
    judge(broken, () => 0.9)
    const again = new ChatService(runtime, { resolver: broken, classify: solo, quietMs: QUIET_MS })
    const second = await again.send('`no-such-command-xyz`: anything', team(), undefined, { goal: true })
    const t = await waitFor(second.colonyId)
    expect(t.status).toBe('stopped')
    expect(t.statusReason).toStartWith(
      "the goal's condition could not be checked: `no-such-command-xyz` exit 127",
    )
    expect(goalVerdicts(t)).toHaveLength(1)
  },
)

test('prewalk: the lead plans on its model, then hands off once to the carry-out model at its first change', async () => {
  const resolver = new ModelResolver()
  const lead = model(resolver, 'mock/lead', (n) =>
    n === 1
      ? [tool('append_note', { text: 'Plan: write a.md, then b.md.', section: 'plan' })]
      : [tool('fs_write', { path: 'a.md', content: 'a' })],
  )
  const cheap = model(resolver, 'mock/cheap', (n) =>
    n === 1
      ? [tool('fs_write', { path: 'b.md', content: 'b' })]
      : [tool('reply_user', { text: 'Both files are written.', final: true })],
  )
  judge(resolver, () => 0.9)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS })
  const { colonyId } = await chats.send('Write a.md and b.md', team({ carryOutModel: 'mock/cheap' }))
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  // Planned on the lead's model, told what is coming; carried out on the cheaper one, told it switched.
  expect(lead).toHaveLength(2)
  expect(JSON.stringify(lead[0]?.messages)).toContain(
    'Prewalk: you plan on this model, then hand off to mock/cheap',
  )
  expect(cheap.length).toBeGreaterThanOrEqual(2)
  expect(JSON.stringify(cheap[0]?.messages)).toContain('You are now on mock/cheap')
  // One switch, logged, though the carry-out model changed files again.
  const log = await events(colonyId)
  expect(ofType(log, 'agent/handoff')).toEqual([
    { agent: 'lead', model: 'mock/cheap', previous: 'mock/lead', after: 'fs_write' },
  ])
  expect(s.agents.lead?.info.model).toBe('mock/cheap')
  expect(ofType(log, 'colony/created')[0]?.prewalk).toBe('mock/cheap')
})

test('prewalk stays off for a lead already on the carry-out model', async () => {
  const resolver = new ModelResolver()
  model(resolver, 'mock/cheap', (n) =>
    n === 1
      ? [tool('fs_write', { path: 'a.md', content: 'a' })]
      : [tool('reply_user', { text: 'Done.', final: true })],
  )
  judge(resolver, () => 0.9)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: QUIET_MS })
  const { colonyId } = await chats.send(
    'Write a.md',
    team({ leadModel: 'mock/cheap', carryOutModel: 'mock/cheap' }),
  )
  await waitFor(colonyId)
  const log = await events(colonyId)
  expect(ofType(log, 'agent/handoff')).toEqual([])
  expect(ofType(log, 'colony/created')[0]?.prewalk).toBe(undefined)
})
