import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony, type MyrEvent } from '@myrmidon/protocol'
import type { Context as LlmContext } from '@oh-my-pi/pi-ai'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import {
  bootRuntime,
  CALL_SIGNS,
  ChatService,
  type Classify,
  ModelResolver,
  normalizeTeamConfig,
  type Runtime,
  type TeamConfig,
} from '../src/index.ts'

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-chat-'))
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

type Step = MockContent[] | ((ctx: LlmContext) => MockContent[])

/** A model that answers each of its own calls with the next step; steps may inspect the conversation. */
function scripted(resolver: ModelResolver, ref: string, script: Step[]) {
  let call = 0
  const mock = createMockModel({
    handler: (ctx: LlmContext) => {
      const step = script[call++]
      return { content: typeof step === 'function' ? step(ctx) : (step ?? ['ok']) }
    },
  })
  resolver.register(ref, { model: mock.model, streamFn: mock.stream })
}

function judge(resolver: ModelResolver, score = 0.9) {
  const m = createMockModel({ handler: () => ({ content: [`{"score": ${score}, "reasons": "complete"}`] }) })
  resolver.register('mock/judge', { model: m.model, streamFn: m.stream })
}

const fixed =
  (tier: 'answer' | 'solo' | 'team'): Classify =>
  async () =>
    tier

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

const solo = (model: string): TeamConfig => ({
  mode: 'orchestrated',
  leadModel: model,
  roster: [],
  judgeModel: model,
})

const events = (colonyId: string) => runtime.ctx.log.read(colonyId as never)
const turnsOf = (log: readonly MyrEvent[], agent: string) =>
  log.filter((e) => e.type === 'agent/turn' && (e.payload as EventPayloads['agent/turn']).agent === agent)

test('orchestrated: workers sleep until assigned, the final answer verifies itself, and the plan carries over', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [
    [
      tool('append_note', { text: 'Plan: the writer drafts poem.txt; I review it.', section: 'plan' }),
      tool('create_task', { subject: 'Write a four-line poem about ants', outputs: ['poem.txt'] }),
    ],
    ['waiting for the writer'],
    [tool('reply_user', { text: 'Done: poem.txt has the poem.', final: true })],
  ])
  scripted(resolver, 'mock/writer', [
    [tool('claim_task', { id: 'task-1', revision: 1 })],
    [tool('publish_artifact', { name: 'poem.txt', content: 'Small and many,\nwe carry the hill.\n' })],
    [tool('submit_task', { id: 'task-1', revision: 2, artifacts: ['poem.txt'] })],
    ['done'],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('team') })
  const config: TeamConfig = {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [{ role: 'writer', model: 'mock/writer' }],
    judgeModel: 'mock/judge',
  }
  const first = await chats.send('Write a short poem about ants', config)
  const round1 = await waitFor(first.colonyId)
  expect(round1.status).toBe('completed')
  expect(round1.tier).toBe('team')
  const writer = Object.keys(round1.agents).find((n) => n !== 'lead') ?? ''
  expect(CALL_SIGNS as readonly string[]).toContain(writer)
  expect(round1.agents[writer]?.info.specialty).toBe('writer')
  expect(round1.agents.lead?.info.tools).not.toContain('shell')
  expect(round1.agents.lead?.info.tools).not.toContain('web_search')

  const log = await events(first.colonyId)
  const firstTask = log.findIndex((e) => e.type === 'task/changed')
  const writerStart = log.findIndex(
    (e) => e.type === 'agent/turn' && (e.payload as EventPayloads['agent/turn']).agent === writer,
  )
  expect(writerStart).toBeGreaterThan(firstTask)
  expect(round1.chatMessages.map((m) => m.from)).toEqual(['user', 'lead'])
  expect(round1.artifacts['poem.txt']?.at(-1)?.author).toBe(writer)

  const second = await chats.send('Now make it rhyme', config, first.chatId)
  const round2 = await waitFor(
    second.colonyId,
    (s) => s.notes.length > 0 && Object.keys(s.artifacts).length > 0,
  )
  expect(round2.chat?.round).toBe(2)
  expect(round2.artifacts['poem.txt']?.[0]?.author).toBe('previous-round')
  expect(round2.notes[0]?.section).toBe('plan')
  await chats.stopAll()
})

test('orchestrated: an assigned task wakes only its assignee', async () => {
  const resolver = new ModelResolver()
  const specialist = (ctx: LlmContext, role: string) =>
    new RegExp(`- ([a-z]+): ${role} \\(`).exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''
  scripted(resolver, 'mock/lead', [
    (ctx) => [tool('create_task', { subject: 'Check the facts', assignee: specialist(ctx, 'researcher') })],
    ['waiting'],
  ])
  scripted(resolver, 'mock/researcher', [['on it'], ['ok']])
  scripted(resolver, 'mock/coder', [['should not run']])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('team') })
  const { colonyId } = await chats.send('Research and build', {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [
      { role: 'researcher', model: 'mock/researcher' },
      { role: 'coder', model: 'mock/coder' },
    ],
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId, (st) =>
    Object.values(st.agents).some((a) => a.info.specialty === 'researcher' && a.turns > 0),
  )
  await Bun.sleep(300)
  const log = await events(colonyId)
  const coder = Object.values(s.agents).find((a) => a.info.specialty === 'coder')?.info.name ?? ''
  expect(coder).not.toBe('')
  expect(turnsOf(log, coder)).toHaveLength(0)
  await chats.stopAll()
})

test('swarm: one seed plans, duplicates and second plans are refused, and a speaker answers once', async () => {
  const resolver = new ModelResolver()
  // Calls in one batch run concurrently, so task numbers are not fixed; find tasks by the file they produce.
  const taskFor = (ctx: LlmContext, output: string) =>
    new RegExp(`(task-\\d+) r1 \\[pending\\][^"\\\\]*?outputs=${output.replace('.', '\\.')}`).exec(
      JSON.stringify(ctx.messages),
    )?.[1] ?? 'task-missing'
  const asksForFinal = (ctx: LlmContext) => JSON.stringify(ctx.messages.at(-1) ?? '').includes('task-final')
  const peer = (ref: string, steps: Step[]) => {
    let answered = false
    let i = 0
    scripted(resolver, ref, [
      ...Array.from({ length: 20 }, () => (ctx: LlmContext) => {
        if (asksForFinal(ctx) && !answered) {
          answered = true
          return [
            tool('reply_user', {
              text: 'Your haiku and its title are in haiku.txt and title.txt.',
              final: true,
            }),
          ]
        }
        const step = steps[i++]
        return typeof step === 'function' ? step(ctx) : (step ?? ['ok'])
      }),
    ])
  }
  peer('mock/p1', [
    [
      tool('append_note', { text: 'Plan: a title, then the haiku.', section: 'plan' }),
      tool('create_task', { subject: 'Write a title for the haiku', outputs: ['title.txt'] }),
      tool('create_task', { subject: 'Draft the haiku about rain', outputs: ['haiku.txt'] }),
    ],
    [tool('create_task', { subject: 'Draft the haiku about rain please' })],
    (ctx) => [tool('claim_task', { id: taskFor(ctx, 'haiku.txt'), revision: 1 })],
    [tool('publish_artifact', { name: 'haiku.txt', content: 'Rain on the tin roof\n' })],
    (ctx) => [tool('submit_task', { id: taskFor(ctx, 'haiku.txt'), revision: 2, artifacts: ['haiku.txt'] })],
    ['done'],
  ])
  peer('mock/p2', [
    (ctx) => [tool('claim_task', { id: taskFor(ctx, 'title.txt'), revision: 1 })],
    [tool('publish_artifact', { name: 'title.txt', content: 'Tin Roof\n' })],
    (ctx) => [tool('submit_task', { id: taskFor(ctx, 'title.txt'), revision: 2, artifacts: ['title.txt'] })],
    ['done'],
  ])
  peer('mock/p3', [[tool('append_note', { text: 'My own plan', section: 'plan' })], ['nothing for me']])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('team') })
  const { colonyId } = await chats.send('Write a haiku with a title', {
    mode: 'swarm',
    leadModel: 'mock/p1',
    roster: [
      { role: 'peer', model: 'mock/p1' },
      { role: 'peer', model: 'mock/p2' },
      { role: 'peer', model: 'mock/p3' },
    ],
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId).catch(async (err) => {
    if (process.env.MYR_DEBUG)
      for (const e of await events(colonyId))
        console.log(e.seq, e.type, JSON.stringify(e.payload).slice(0, 220))
    throw err
  })
  expect(s.status).toBe('completed')
  expect(s.pattern).toBe('blackboard')
  const [seed, second] = Object.keys(s.agents)
  expect(s.tasks['task-final']?.owner).toBe(seed)
  expect(s.chatMessages.filter((m) => m.final)).toHaveLength(1)

  const log = await events(colonyId)
  const results = log
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
  expect(results.some((r) => r.tool === 'create_task' && !r.ok && r.output.includes('similar to'))).toBe(true)
  expect(
    results.some((r) => r.tool === 'append_note' && !r.ok && r.output.includes('plan already exists')),
  ).toBe(true)
  const firstTask = log.findIndex((e) => e.type === 'task/changed')
  const early = log.slice(0, firstTask).filter((e) => e.type === 'agent/turn')
  expect(early.every((e) => (e.payload as EventPayloads['agent/turn']).agent === seed)).toBe(true)
  expect(turnsOf(log, second ?? '').length).toBeGreaterThan(0)
})

test('answer tier: one agent replies directly, with no team and no judge', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [
    [tool('reply_user', { text: 'Life is self-sustaining chemistry.', final: true })],
  ])
  const chats = new ChatService(runtime, { resolver, classify: fixed('answer') })
  const { colonyId } = await chats.send('what is life', {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [{ role: 'researcher', model: 'mock/lead' }],
    judgeModel: 'mock/lead',
  })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(Object.keys(s.agents)).toEqual(['lead'])
  expect(s.verdicts.map((v) => v.verifierId)).toEqual(['delivered'])
  expect(s.agents.lead?.info.tools).not.toContain('shell')
  expect(s.agents.lead?.turns).toBe(1)
})

test('an answer written as plain text still reaches the person', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [['Life is self-sustaining chemistry capable of evolution.']])
  const chats = new ChatService(runtime, { resolver, classify: fixed('answer') })
  const { colonyId } = await chats.send('what is life', solo('mock/lead'))
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(s.chatMessages.at(-1)).toMatchObject({
    from: 'lead',
    final: true,
    text: 'Life is self-sustaining chemistry capable of evolution.',
  })
})

test('ask_user pauses the round until the person answers', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/greeter', [
    [tool('ask_user', { question: 'Which format do you want?' })],
    ['waiting'],
  ])
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { colonyId } = await chats.send('make a report', {
    mode: 'orchestrated',
    leadModel: 'mock/greeter',
    roster: [],
    judgeModel: 'mock/greeter',
  })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('stopped')
  expect(s.statusReason).toBe('awaiting your reply')
  expect(s.chatMessages.at(-1)?.question).toBe(true)
  expect(s.signals.filter((x) => x.kind === 'stall')).toHaveLength(0)
})

test('older auto/manual team configs still work', () => {
  expect(
    normalizeTeamConfig({
      mode: 'auto',
      leadModel: 'a/b',
      workerModel: 'c/d',
      workers: 3,
      judgeModel: 'a/b',
    }),
  ).toEqual({ mode: 'orchestrated', leadModel: 'a/b', roster: [], extraWorkers: 3, judgeModel: 'a/b' })
  expect(
    normalizeTeamConfig({
      mode: 'manual',
      leadModel: 'a/b',
      workerModel: 'c/d',
      workers: 2,
      judgeModel: 'a/b',
    }).roster,
  ).toEqual([
    { role: 'worker', model: 'c/d' },
    { role: 'worker', model: 'c/d' },
  ])
})

test('deleting a chat removes every round and its data', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/brief', [
    [tool('ask_user', { question: 'Which format do you want?' })],
    ['waiting'],
  ])
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { chatId, colonyId } = await chats.send('make a report', solo('mock/brief'))
  const dir = join(home, 'colonies', colonyId)
  expect(existsSync(dir)).toBe(true)
  const deleted = await chats.delete(chatId)
  expect(deleted).toEqual([colonyId])
  expect(existsSync(dir)).toBe(false)
  expect(await chats.list()).toEqual([])
})

test('a double-clicked retry starts one round, not two', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/asker', [
    [tool('ask_user', { question: 'Which format do you want?' })],
    ['waiting'],
    [tool('ask_user', { question: 'Which format do you want?' })],
    ['waiting'],
  ])
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const first = await chats.send('make a report', solo('mock/asker'))
  await waitFor(first.colonyId)
  const [a, b] = await Promise.all([
    chats.send('make a report', solo('mock/asker'), first.chatId),
    chats.send('make a report', solo('mock/asker'), first.chatId),
  ])
  expect([a.started, b.started].filter(Boolean)).toHaveLength(1)
  expect(a.colonyId).toBe(b.colonyId)
  const [chat] = await chats.list()
  expect(chat?.rounds).toHaveLength(2)
  await chats.stopAll()
})

test('renaming a chat sticks, survives a restart, and rejects empty titles', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/namer', [
    [tool('ask_user', { question: 'Which format do you want?' })],
    ['waiting'],
  ])
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { chatId } = await chats.send('make a report', solo('mock/namer'))
  expect(await chats.rename(chatId, '  Quarterly   report ')).toBe('Quarterly report')
  expect((await chats.list())[0]?.title).toBe('Quarterly report')
  await expect(chats.rename(chatId, '   ')).rejects.toThrow('empty')
  await expect(chats.rename('chat-missing', 'x')).rejects.toThrow('no such chat')
  await chats.stopAll()
  const reopened = new ChatService(runtime, { resolver })
  expect((await reopened.list())[0]?.title).toBe('Quarterly report')
})
