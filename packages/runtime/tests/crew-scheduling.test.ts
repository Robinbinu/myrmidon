import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony, type MyrEvent } from '@myrmidon/protocol'
import { LEASE_MS } from '../src/config.ts'
import { bootRuntime, ChatService, type Classify, ModelResolver, type Runtime } from '../src/index.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-sched-'))
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
const team: Classify = async () => 'team'
const QUIET_MS = 500
const said = (ctx: LlmContext) => JSON.stringify(ctx.messages)

function model(
  resolver: ModelResolver,
  ref: string,
  answer: (ctx: LlmContext, call: number) => MockContent[],
) {
  let call = 0
  const m = createMockModel({ handler: (ctx: LlmContext) => ({ content: answer(ctx, call++) }) })
  resolver.register(ref, { model: m.model, streamFn: m.stream })
}

function judge(resolver: ModelResolver) {
  model(resolver, 'mock/judge', () => ['{"score": 0.9, "reasons": "complete"}'])
}

async function waitFor(colonyId: string, until: (s: ColonyState) => boolean) {
  for (let i = 0; i < 600; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (until(s)) return s
    await Bun.sleep(50)
  }
  throw new Error('colony did not reach the expected state')
}
const ended = (s: ColonyState) => s.status !== 'running' && s.status !== 'created'
const events = (colonyId: string) => runtime.ctx.log.read(colonyId as never)
const turns = (log: readonly MyrEvent[]) =>
  log
    .filter((e) => e.type === 'agent/turn' && (e.payload as EventPayloads['agent/turn']).phase === 'start')
    .map((e) => ({ ...(e.payload as EventPayloads['agent/turn']), seq: e.seq }))

test('a new task nobody was given wakes one idle crewmate, not every one to race for it', async () => {
  const resolver = new ModelResolver()
  model(resolver, 'mock/lead', (ctx, n) =>
    n === 0
      ? [tool('create_task', { subject: 'Count the ants' })]
      : said(ctx).includes('VERIFIED')
        ? [tool('reply_user', { text: 'Counted.', final: true })]
        : ['waiting'],
  )
  for (const ref of ['mock/w1', 'mock/w2'])
    model(resolver, ref, (ctx) => {
      const last = JSON.stringify(ctx.messages.at(-1) ?? '')
      if (last.includes('task-1') && !said(ctx).includes('claim_task'))
        return [tool('claim_task', { id: 'task-1', revision: 1 })]
      if (said(ctx).includes('claim_task') && !said(ctx).includes('submit_task'))
        return [tool('submit_task', { id: 'task-1', revision: 2, artifacts: [] })]
      return ['done']
    })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: team, quietMs: QUIET_MS })
  const { colonyId } = await chats.send('Count the ants', {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [
      { role: 'counter', model: 'mock/w1' },
      { role: 'checker', model: 'mock/w2' },
    ],
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId, ended)
  expect(s.status).toBe('completed')
  const workers = Object.values(s.agents)
    .filter((a) => a.info.role === 'worker')
    .map((a) => a.info.name)
  const woke = new Set(turns(await events(colonyId)).map((t) => t.agent))
  // Exactly one crewmate was offered the task and did it; the other was never woken.
  expect(workers.filter((w) => woke.has(w))).toHaveLength(1)
  expect(s.tasks['task-1']?.status).toBe('verified')
  await chats.stopAll()
})

test('a holder that stops after its two reminders lets the task go at once, not after the lease', async () => {
  const resolver = new ModelResolver()
  const seen: { lead?: string } = {}
  model(resolver, 'mock/lead', (ctx, n) => {
    if (n === 0) {
      const counter = /^- (\w+): counter \(/m.exec(ctx.systemPrompt?.join('\n') ?? '')?.[1]
      return [tool('create_task', { subject: 'Count the ants', assignee: counter })]
    }
    if (said(ctx).includes('was released')) {
      seen.lead = said(ctx)
      return [tool('reply_user', { text: 'The counter gave up; I will ask again later.', final: true })]
    }
    return ['waiting']
  })
  model(resolver, 'mock/w1', (ctx) =>
    said(ctx).includes('claim_task')
      ? ['Still thinking.']
      : [tool('claim_task', { id: 'task-1', revision: 1 })],
  )
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: team, quietMs: QUIET_MS })
  const started = Date.now()
  const { colonyId } = await chats.send('Count the ants', {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [{ role: 'counter', model: 'mock/w1' }],
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId, ended)
  expect(s.status).toBe('completed')
  const released = (await events(colonyId)).find(
    (e) =>
      e.type === 'task/changed' &&
      (e.payload as EventPayloads['task/changed']).by === 'scheduler' &&
      (e.payload as EventPayloads['task/changed']).task.status === 'pending',
  )
  expect(released).toBeDefined()
  expect(Date.now() - started).toBeLessThan(LEASE_MS)
  expect(seen.lead).toContain('was released')
  await chats.stopAll()
})

test('a swarm huddle closes once a proposal is in and every peer is idle, without waiting out the clock', async () => {
  const resolver = new ModelResolver()
  const seen: { over?: string } = {}
  // The first peer to be asked proposes; the other ends its turn without proposing.
  let proposed = false
  const peer = (ctx: LlmContext): MockContent[] => {
    const last = JSON.stringify(ctx.messages.at(-1) ?? '')
    if (last.includes('The huddle is over')) {
      seen.over = last
      return [tool('append_note', { text: 'Plan: count the ants myself.', section: 'plan' })]
    }
    if (last.includes('Huddle first') && !proposed) {
      proposed = true
      return [tool('message', { to: 'team', text: 'I propose I count the ants alone.' })]
    }
    return ['Nothing to add.']
  }
  model(resolver, 'mock/p1', peer)
  model(resolver, 'mock/p2', peer)
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: team, quietMs: QUIET_MS })
  const started = Date.now()
  const { colonyId } = await chats.send('Count the ants', {
    mode: 'swarm',
    leadModel: 'mock/p1',
    roster: [
      { role: 'peer', model: 'mock/p1' },
      { role: 'peer', model: 'mock/p2' },
    ],
    judgeModel: 'mock/judge',
  })
  await waitFor(colonyId, (s) => s.notes.some((n) => n.section === 'plan'))
  expect(seen.over).toContain('every peer has had its say')
  // The huddle's backstop is 90 s; it closed on the peers' turns instead.
  expect(Date.now() - started).toBeLessThan(20_000)
  await chats.stopAll()
})
