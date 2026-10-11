import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony } from '@myrmidon/protocol'
import {
  BudgetExceededError,
  bootRuntime,
  ChatService,
  type Classify,
  ModelResolver,
  monthOf,
  normalizeBudget,
  ProjectStore,
  type Runtime,
  runCap,
  runLimit,
  SettingsStore,
  spentFor,
  type TeamConfig,
  totalReached,
} from '../src/index.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-budgets-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(home, { recursive: true, force: true })
})

// Cap resolution and the running totals, on their own.

test('the per-run cap is the most specific one set: chat, then project, then global; 0 or empty sets none', () => {
  expect(runCap({ global: { runUsd: 5 } })).toEqual({ usd: 5, scope: 'global' })
  expect(runCap({ global: { runUsd: 5 }, project: { runUsd: 2 } })).toEqual({ usd: 2, scope: 'project' })
  expect(runCap({ global: { runUsd: 5 }, project: { runUsd: 2 }, chat: { runUsd: 9 } })).toEqual({
    usd: 9,
    scope: 'chat',
  })
  // A level that sets only a total leaves the per-run cap to the next one out.
  expect(runCap({ global: { runUsd: 5 }, project: { totalUsd: 50 }, chat: { totalUsd: 10 } })).toEqual({
    usd: 5,
    scope: 'global',
  })
  expect(runCap({ global: {} })).toBeUndefined()
  // Saved budgets keep only the caps that are set.
  expect(normalizeBudget({ runUsd: 0, totalUsd: 12.5 })).toEqual({ totalUsd: 12.5 })
  expect(normalizeBudget(undefined)).toEqual({})
  expect(() => normalizeBudget({ runUsd: -1 })).toThrow('runUsd')
  expect(() => normalizeBudget({ totalUsd: 'lots' })).toThrow('totalUsd')
  expect(() => normalizeBudget('5')).toThrow()
})

test('a total used up names itself, the chat first; a run may spend the least of its cap and what totals have left', () => {
  const caps = { global: { runUsd: 5, totalUsd: 100 }, project: { totalUsd: 20 }, chat: { totalUsd: 10 } }
  expect(totalReached(caps, { chat: 3, project: 4, month: 50 })).toBeUndefined()
  expect(totalReached(caps, { chat: 10, project: 25, month: 50 })).toEqual({
    scope: 'chat',
    spent: 10,
    cap: 10,
  })
  expect(totalReached(caps, { chat: 3, project: 25, month: 150 })).toEqual({
    scope: 'project',
    spent: 25,
    cap: 20,
  })
  // Plenty left everywhere: the per-run cap, as before totals existed.
  expect(runLimit(5, caps, { chat: 1, project: 1, month: 1 })).toEqual({ costUsd: 5 })
  // The chat has $2.50 left, less than a run's $5: that is the run's limit, and it says which total set it.
  expect(runLimit(5, caps, { chat: 7.5, project: 1, month: 1 })).toEqual({
    costUsd: 2.5,
    total: { scope: 'chat', usd: 10 },
  })
  // The tightest total wins; a round that already spent $1 keeps counting from there.
  expect(runLimit(5, caps, { chat: 7, project: 19, month: 1 }, 1)).toEqual({
    costUsd: 2,
    total: { scope: 'project', usd: 20 },
  })
  // No per-run cap at all: a total still bounds the run.
  expect(runLimit(undefined, { global: { totalUsd: 3 } }, { chat: 0, project: 0, month: 1 })).toEqual({
    costUsd: 2,
    total: { scope: 'global', usd: 3 },
  })
  expect(runLimit(undefined, { global: {} }, { chat: 0, project: 0, month: 0 })).toEqual({})
})

test('monthly totals start again on the 1st; a chat total counts its whole life', () => {
  const now = new Date(2026, 1, 1, 9)
  expect(monthOf(now)).toBe('2026-02')
  const entries = [
    { chatId: 'c1', projectId: 'p1', startedAt: new Date(2026, 0, 31, 23, 50).toISOString(), cost: 4 },
    { chatId: 'c1', projectId: 'p1', startedAt: new Date(2026, 1, 1, 8).toISOString(), cost: 1 },
    { chatId: 'c2', projectId: 'p2', startedAt: new Date(2026, 1, 2).toISOString(), cost: 2 },
    { chatId: 'c3', startedAt: new Date(2025, 1, 10).toISOString(), cost: 7 },
  ]
  expect(spentFor(entries, { chatId: 'c1', projectId: 'p1' }, now)).toEqual({ chat: 5, project: 1, month: 3 })
  expect(spentFor(entries, { chatId: 'c1', projectId: 'p1' }, new Date(2026, 0, 31, 23, 59))).toEqual({
    chat: 5,
    project: 4,
    month: 4,
  })
  // February of a year earlier is another month.
  expect(spentFor(entries, { chatId: 'c3' }, now)).toEqual({ chat: 7, project: 0, month: 3 })
})

// The chat runtime holding runs to them.

const tool = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})

const solo: Classify = async () => 'solo'

/** A lead whose every answer costs $0.60: it answers at once, or (`busy`) keeps the run going. */
function pricedLead(resolver: ModelResolver) {
  const state = { busy: false }
  const lead = createMockModel({
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    handler: () => ({
      content: state.busy
        ? [tool('message', { to: 'team', text: 'still working' })]
        : [tool('reply_user', { text: 'Done.', final: true })],
      usage: { input: 400, output: 100, cost: { total: 0.6 } },
    }),
  })
  resolver.register('mock/priced', { model: lead.model, streamFn: lead.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "complete"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  return state
}

const config: TeamConfig = {
  mode: 'orchestrated',
  leadModel: 'mock/priced',
  roster: [],
  judgeModel: 'mock/judge',
}

async function waitFor(colonyId: string, until: (s: ColonyState) => boolean) {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (until(s)) return s
    await Bun.sleep(50)
  }
  throw new Error('colony did not reach the expected state')
}

const ended = (rounds: number) => (s: ColonyState) =>
  s.rounds.length === rounds && s.status !== 'running' && s.status !== 'created'

/** The budget the latest round started with, as its log records it. */
async function loggedBudget(colonyId: string) {
  const log = await runtime.ctx.log.read(colonyId as never)
  const start = log.findLast((e) => e.type === 'colony/created' || e.type === 'round/started')
  if (!start) throw new Error('the colony has no round')
  return (start.payload as EventPayloads['colony/created']).budget
}

test("a chat's total stops the run that reaches it and blocks the next until raised; each follow-up still has its per-run cap", async () => {
  const settings = new SettingsStore(home)
  const resolver = new ModelResolver()
  const lead = pricedLead(resolver)
  const chats = new ChatService(runtime, { resolver, classify: solo, settings })
  const first = await chats.send('First question', config)
  expect((await waitFor(first.colonyId, ended(1))).status).toBe('completed')
  // Nothing set but the $5 default: the run's limit is the per-run cap, as before totals.
  expect(await loggedBudget(first.colonyId)).toMatchObject({ costUsd: 5 })
  expect((await chats.list())[0]).toMatchObject({ chatId: first.chatId, spent: 0.6 })
  expect((await chats.list())[0]?.budget).toBeUndefined()

  expect(await chats.setChatBudget(first.chatId, { totalUsd: 1 })).toEqual({ totalUsd: 1 })
  expect((await chats.list())[0]?.budget).toEqual({ totalUsd: 1 })
  // $0.40 left of the chat's $1: the follow-up may spend that, and stops at the chat's total, saying so.
  lead.busy = true
  const second = await chats.send('Keep going', config, first.chatId)
  const s2 = await waitFor(second.colonyId, ended(2))
  expect(await loggedBudget(second.colonyId)).toMatchObject({
    costUsd: 0.4,
    total: { scope: 'chat', usd: 1 },
  })
  expect(s2.status).toBe('stopped')
  expect(s2.statusReason).toBe("this chat's budget reached: $1.20 of $1 spent; raise it to go on")

  // Used up: no new run starts, and neither does a resume, until the person raises it.
  const refused = await chats.send('And more', config, first.chatId).catch((err: unknown) => err)
  expect(refused).toBeInstanceOf(BudgetExceededError)
  expect((refused as BudgetExceededError).hit).toEqual({ scope: 'chat', spent: 1.2, cap: 1 })
  expect((refused as Error).message).toBe(
    "This chat's budget is used up: $1.20 of $1 spent. Raise it to start another run.",
  )
  await expect(chats.resume(first.chatId)).rejects.toBeInstanceOf(BudgetExceededError)

  await chats.setChatBudget(first.chatId, { totalUsd: 10, runUsd: 2 })
  lead.busy = false
  const third = await chats.send('Now finish', config, first.chatId)
  expect((await waitFor(third.colonyId, ended(3))).status).toBe('completed')
  // The chat's own per-run cap wins over the global one.
  expect(await loggedBudget(third.colonyId)).toMatchObject({ costUsd: 2 })
  expect((await loggedBudget(third.colonyId)).total).toBeUndefined()
  await chats.stopAll()
})

test("a project's monthly total blocks its chats until the month turns, and a new chat's caps come with its first message", async () => {
  const settings = new SettingsStore(home)
  const projects = new ProjectStore(home)
  const folder = mkdtempSync(join(tmpdir(), 'myr-budget-project-'))
  const project = projects.setBudget(projects.add(folder).id, { totalUsd: 1, runUsd: 3 })
  expect(project.budget).toEqual({ totalUsd: 1, runUsd: 3 })
  let now = new Date()
  const resolver = new ModelResolver()
  pricedLead(resolver)
  const chats = new ChatService(runtime, { resolver, classify: solo, settings, projects, now: () => now })
  try {
    const first = await chats.send('One', config, undefined, { project: project.id })
    expect((await waitFor(first.colonyId, ended(1))).status).toBe('completed')
    // The project's per-run cap wins over the global $5, less what its month has left ($1).
    expect(await loggedBudget(first.colonyId)).toMatchObject({
      costUsd: 1,
      total: { scope: 'project', usd: 1 },
    })
    // A new chat in the project, with a per-run cap of its own from before its first message.
    const second = await chats.send('Two', config, undefined, {
      project: project.id,
      budget: { runUsd: 0.25 },
    })
    expect((await waitFor(second.colonyId, ended(1))).status).not.toBe('running')
    expect(await loggedBudget(second.colonyId)).toMatchObject({ costUsd: 0.25 })
    const listed = (await chats.list()).find((c) => c.chatId === second.chatId)
    expect(listed?.budget).toEqual({ runUsd: 0.25 })
    expect(await chats.spend()).toMatchObject({
      month: monthOf(now),
      total: 1.2,
      projects: { [project.id]: 1.2 },
    })

    // $1.20 of the project's $1 this month: no chat in it starts another run, new or old.
    const refused = await chats
      .send('Three', config, undefined, { project: project.id })
      .catch((e: unknown) => e)
    expect((refused as BudgetExceededError).hit).toEqual({ scope: 'project', spent: 1.2, cap: 1 })
    await expect(chats.send('Again', config, first.chatId)).rejects.toBeInstanceOf(BudgetExceededError)
    // A chat outside the project is not held to it.
    const outside = await chats.send('Elsewhere', config)
    expect((await waitFor(outside.colonyId, ended(1))).status).toBe('completed')

    // The 1st of next month: the project's month starts again from nothing.
    now = new Date(now.getFullYear(), now.getMonth() + 1, 1, 9)
    expect(await chats.spend()).toMatchObject({ month: monthOf(now), total: 0, projects: {} })
    const next = await chats.send('Again', config, first.chatId)
    expect((await waitFor(next.colonyId, ended(2))).status).toBe('completed')
  } finally {
    await chats.stopAll()
    rmSync(folder, { recursive: true, force: true })
  }
})

test('the global monthly total counts every chat; lowering a cap under what a running round spent stops it there', async () => {
  const settings = new SettingsStore(home)
  settings.set({ ...settings.get(), team: { ...settings.get().team, monthlyUsd: 1 } })
  // Off unless set: the default leaves every run to its per-run cap alone.
  expect(new SettingsStore(mkdtempSync(join(tmpdir(), 'myr-budget-defaults-'))).get().team.monthlyUsd).toBe(0)
  const resolver = new ModelResolver()
  const lead = pricedLead(resolver)
  const chats = new ChatService(runtime, { resolver, classify: solo, settings })
  const first = await chats.send('One', config)
  expect((await waitFor(first.colonyId, ended(1))).status).toBe('completed')
  lead.busy = true
  const second = await chats.send('Two', config)
  const s2 = await waitFor(second.colonyId, ended(1))
  expect(s2.statusReason).toBe('your monthly budget reached: $1.20 of $1 spent; raise it to go on')
  const refused = await chats.send('Three', config).catch((e: unknown) => e)
  expect((refused as BudgetExceededError).hit).toEqual({ scope: 'global', spent: 1.2, cap: 1 })

  // Raised (and no per-run cap, so only a total can stop it), a run starts; the person then caps the chat below
  // what it has spent, and the running round stops.
  settings.set({ ...settings.get(), team: { ...settings.get().team, monthlyUsd: 100, costUsd: 0 } })
  const third = await chats.send('Three', config)
  await waitFor(third.colonyId, (s) => Object.values(s.agents).some((a) => a.cost >= 0.6))
  await chats.setChatBudget(third.chatId, { totalUsd: 0.5 })
  const s3 = await waitFor(third.colonyId, ended(1))
  expect(s3.status).toBe('stopped')
  expect(s3.statusReason).toMatch(
    /^this chat's budget reached: \$\d+\.\d\d of \$0\.5 spent; raise it to go on$/,
  )
  await chats.stopAll()
})
