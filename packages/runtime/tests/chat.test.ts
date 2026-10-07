import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteLogStore } from '@myrmidon/core'
import { type ColonyState, type EventPayloads, foldColony, type MyrEvent } from '@myrmidon/protocol'
import type { Context as LlmContext } from '@oh-my-pi/pi-ai'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import {
  BrowserHub,
  bootRuntime,
  CALL_SIGNS,
  ChatService,
  type Classify,
  detectSandbox,
  findChrome,
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

test('orchestrated: a worker assigned a blocked task sleeps until its blockers are verified', async () => {
  const resolver = new ModelResolver()
  const specialist = (ctx: LlmContext, role: string) =>
    new RegExp(`- ([a-z]+): ${role} \\(`).exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''
  scripted(resolver, 'mock/lead', [
    (ctx) => [
      tool('create_task', { subject: 'Gather the facts', assignee: specialist(ctx, 'researcher') }),
      tool('create_task', {
        subject: 'Build the page',
        assignee: specialist(ctx, 'coder'),
        blockedBy: ['task-1'],
      }),
    ],
    ['waiting'],
  ])
  scripted(resolver, 'mock/researcher', [['on it'], ['ok']])
  scripted(resolver, 'mock/coder', [['should not run yet']])
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
  const coder = Object.values(s.agents).find((a) => a.info.specialty === 'coder')?.info.name ?? ''
  expect(coder).not.toBe('')
  expect(turnsOf(await events(colonyId), coder)).toHaveLength(0)
  await chats.stopAll()
})

test('tasks created together in one message can depend on each other', async () => {
  const resolver = new ModelResolver()
  const researcher = (ctx: LlmContext) =>
    /- ([a-z]+): researcher \(/.exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''
  scripted(resolver, 'mock/lead', [
    (ctx) => [
      tool('create_task', { subject: 'Gather the facts', assignee: researcher(ctx) }),
      tool('create_task', {
        subject: 'Summarise the facts',
        assignee: researcher(ctx),
        blockedBy: ['task-1'],
      }),
      tool('create_task', {
        subject: 'Review the summary',
        assignee: researcher(ctx),
        blockedBy: ['task-2'],
      }),
    ],
    ['waiting'],
  ])
  scripted(resolver, 'mock/researcher', [['on it'], ['ok']])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('team') })
  const { colonyId } = await chats.send('Research it', {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [{ role: 'researcher', model: 'mock/researcher' }],
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId, (st) => Object.keys(st.tasks).length >= 3)
  const failed = (await events(colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as { ok: boolean; output: string })
    .filter((r) => !r.ok)
  expect(failed.map((r) => r.output)).toEqual([])
  expect(s.tasks['task-1']?.subject).toBe('Gather the facts')
  expect(s.tasks['task-2']?.blockedBy).toEqual(['task-1'])
  expect(s.tasks['task-3']?.blockedBy).toEqual(['task-2'])
  await chats.stopAll()
})

test('swarm: peers huddle before working, the first proposer plans, and a speaker answers once', async () => {
  const resolver = new ModelResolver()
  let answered = false
  const progress = new Map<string, { phase: string; task?: string; out?: string }>()
  // Who proposes first is a race, so each mock peer acts on what it is told rather than on a fixed script.
  const brain = (ctx: LlmContext): MockContent[] => {
    const system = ctx.systemPrompt?.join('\n') ?? ''
    const me = /You are ([a-z]+), one of/.exec(system)?.[1] ?? '?'
    const others = [...system.matchAll(/^- ([a-z]+): peer \(/gm)].map((m) => m[1] as string)
    const last = JSON.stringify(ctx.messages.at(-1) ?? '')
    const st = progress.get(me) ?? { phase: 'idle' }
    progress.set(me, st)
    if (last.includes('task-final') && !answered) {
      answered = true
      return [
        tool('reply_user', { text: 'Your haiku and its title are in haiku.txt and title.txt.', final: true }),
      ]
    }
    if (last.includes('Huddle first'))
      return [
        tool('publish_artifact', { name: 'early.txt', content: 'starting alone' }),
        tool('post', {
          text: `I propose a title task and a haiku task; I (${me}) will take whichever is left.`,
        }),
      ]
    if (last.includes('You proposed first')) {
      st.phase = 'planned'
      return [
        tool('append_note', { text: 'Plan: a title, then the haiku.', section: 'plan' }),
        tool('create_task', {
          subject: 'Write a title for the haiku',
          assignee: others[0],
          outputs: ['title.txt'],
        }),
        tool('create_task', { subject: 'Draft the haiku about rain', assignee: me, outputs: ['haiku.txt'] }),
      ]
    }
    const mine = /Task (task-\d+) r1 is yours.*?Outputs: ([a-z.]+)/.exec(last)
    if (mine) {
      Object.assign(st, { phase: 'claimed', task: mine[1], out: mine[2] })
      return [tool('claim_task', { id: mine[1], revision: 1 })]
    }
    if (st.phase === 'planned') {
      st.phase = 'checked'
      return [
        tool('create_task', { subject: 'Draft the haiku about rain please' }),
        tool('append_note', { text: 'A second plan', section: 'plan' }),
      ]
    }
    if (st.phase === 'claimed') {
      st.phase = 'published'
      return [tool('publish_artifact', { name: st.out ?? '', content: `${st.out} by ${me}\n` })]
    }
    if (st.phase === 'published') {
      st.phase = 'submitted'
      return [tool('submit_task', { id: st.task ?? '', revision: 2, artifacts: [st.out ?? ''] })]
    }
    return ['ok']
  }
  for (const ref of ['mock/p1', 'mock/p2', 'mock/p3']) {
    const m = createMockModel({ handler: (ctx: LlmContext) => ({ content: brain(ctx) }) })
    resolver.register(ref, { model: m.model, streamFn: m.stream })
  }
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
  expect(Object.keys(s.agents)).not.toContain('lead')
  expect(s.chatMessages.filter((m) => m.final)).toHaveLength(1)

  const log = await events(colonyId)
  const results = log
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
  // Nobody worked alone during the huddle, and every peer proposed before the plan existed.
  expect(results.filter((r) => r.tool === 'publish_artifact' && r.output.includes('huddling'))).toHaveLength(
    3,
  )
  expect(s.artifacts['early.txt']).toBeUndefined()
  const planAt = log.findIndex((e) => e.type === 'note/appended')
  const proposals = log.slice(0, planAt).filter((e) => e.type === 'board/posted')
  expect(new Set(proposals.map((e) => (e.payload as EventPayloads['board/posted']).agent)).size).toBe(3)
  // The plan's tasks went to the peers who took them, and re-planning or duplicating is refused.
  const planned = Object.values(s.tasks).filter((t) => t.outputs?.length)
  expect(planned.every((t) => t.assignee && t.status === 'verified')).toBe(true)
  expect(results.some((r) => r.tool === 'create_task' && !r.ok && r.output.includes('similar to'))).toBe(true)
  expect(
    results.some((r) => r.tool === 'append_note' && !r.ok && r.output.includes('plan already exists')),
  ).toBe(true)
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

test('a message sent mid-turn steers the next step or waits its turn, and shows as read', async () => {
  const resolver = new ModelResolver()
  const seen = (ctx: LlmContext, text: string) => JSON.stringify(ctx.messages).includes(text)
  let release!: () => void
  const busy = new Promise<void>((r) => {
    release = r
  })
  const calls: LlmContext[] = []
  const lead = createMockModel({
    handler: async (ctx: LlmContext) => {
      calls.push(ctx)
      if (calls.length === 1) {
        await busy
        return { content: [tool('list_artifacts', {})] }
      }
      if (seen(ctx, 'QUEUED-NOTE'))
        return { content: [tool('reply_user', { text: 'All done.', final: true })] }
      if (seen(ctx, 'STEER-NOTE')) return { content: ['Noted the steer, finishing up.'] }
      return { content: ['working'] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const config = { ...solo('mock/lead'), judgeModel: 'mock/judge' }
  const { chatId, colonyId } = await chats.send('Tidy the files', config)
  await waitFor(colonyId, () => calls.length === 1)
  await chats.send('STEER-NOTE use tabs', config, chatId, { delivery: 'steer' })
  await chats.send('QUEUED-NOTE also add a README', config, chatId, { delivery: 'queue' })
  release()
  const s = await waitFor(colonyId)
  // The steer joined the step right after the running tool batch; the queued note waited until the
  // agent had finished that work, then started its own step.
  const steerAt = calls.findIndex((c) => seen(c, 'STEER-NOTE'))
  const queueAt = calls.findIndex((c) => seen(c, 'QUEUED-NOTE'))
  expect(steerAt).toBe(1)
  expect(queueAt).toBeGreaterThan(steerAt)
  const mid = s.chatMessages.filter((m) => m.from === 'user' && m.mode)
  expect(mid.map((m) => m.mode)).toEqual(['steer', 'queue'])
  expect(mid.map((m) => m.readBy)).toEqual([['lead'], ['lead']])
  expect(s.chatMessages.at(-1)?.text).toBe('All done.')
})

test('attached files land in the workspace and the lead is told to read them', async () => {
  const resolver = new ModelResolver()
  const prompts: string[] = []
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      prompts.push(JSON.stringify(ctx.messages))
      return prompts.length === 1
        ? { content: [tool('read_artifact', { name: 'uploads/notes.md' })] }
        : { content: [tool('reply_user', { text: 'Summarised.', final: true })] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { colonyId } = await chats.send(
    'Summarise my notes',
    { ...solo('mock/lead'), judgeModel: 'mock/judge' },
    undefined,
    { attachments: [{ name: 'notes.md', bytes: new TextEncoder().encode('# Notes\nShip on Friday.') }] },
  )
  const s = await waitFor(colonyId)
  expect(s.artifacts['uploads/notes.md']?.[0]?.author).toBe('user')
  expect(s.artifacts['uploads/notes.md']?.[0]?.mediaType).toBe('text/markdown')
  expect(s.chatMessages[0]?.attachments).toEqual(['uploads/notes.md'])
  expect(prompts[0]).toContain('The person attached uploads/notes.md')
  expect(prompts[1]).toContain('Ship on Friday.')
})

test('a stopped round resumes where it left off, with a summary for its fresh agents', async () => {
  const resolver = new ModelResolver()
  const calls: string[] = []
  let hold: Promise<void> | undefined = new Promise(() => {})
  const lead = createMockModel({
    handler: async (ctx: LlmContext) => {
      calls.push(JSON.stringify(ctx.messages))
      if (calls.length === 1) return { content: [tool('fs_write', { path: 'draft.md', content: '# Draft' })] }
      if (calls.length === 2 && hold) await hold
      return { content: [tool('reply_user', { text: 'Finished after the restart.', final: true })] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const config = { ...solo('mock/lead'), judgeModel: 'mock/judge' }
  const { chatId, colonyId } = await chats.send('Write the draft', config)
  await waitFor(colonyId, () => calls.length === 2)
  await chats.stop(chatId)
  await waitFor(colonyId)
  hold = undefined

  const resumed = await chats.resume(chatId)
  expect(resumed.colonyId).toBe(colonyId)
  const s = await waitFor(colonyId, (st) => st.status === 'completed')
  expect(calls.at(-1)).toContain('This round was interrupted (stopped by user)')
  expect(calls.at(-1)).toContain('Write the draft')
  // The lead's own conversation came back from its transcript, not just a summary.
  expect(calls.at(-1)).toContain('Your conversation so far is restored')
  expect(calls.at(-1)).toContain('# Draft')
  expect(s.chatMessages.at(-1)?.text).toBe('Finished after the restart.')
  const starts = (await events(colonyId)).filter((e) => e.type === 'colony/started')
  expect(starts.map((e) => (e.payload as { resumed?: boolean }).resumed ?? false)).toEqual([false, true])
})

test('swarm mode never has a lead: work goes to every peer, a direct answer to one peer', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/peer', [['ok']])
  const swarm = {
    mode: 'swarm' as const,
    leadModel: 'mock/peer',
    roster: [0, 1, 2].map(() => ({ role: 'peer', model: 'mock/peer' })),
    judgeModel: 'mock/peer',
  }
  const work = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const a = await work.send('Build a small site', swarm)
  const s1 = foldColony(a.colonyId, await events(a.colonyId))
  expect(s1.tier).toBe('team')
  expect(Object.values(s1.agents).map((x) => x.info.role)).toEqual(['peer', 'peer', 'peer'])
  await work.stopAll()

  const chat = new ChatService(runtime, { resolver, classify: fixed('answer') })
  const b = await chat.send('hi', swarm)
  const s2 = foldColony(b.colonyId, await events(b.colonyId))
  expect(Object.values(s2.agents).map((x) => x.info.role)).toEqual(['peer'])
  expect(Object.keys(s2.agents)).not.toContain('lead')
  await chat.stopAll()
})

test('a chat keeps its workers and their memory across rounds; the lead can dismiss one', async () => {
  const resolver = new ModelResolver()
  const specialist = (ctx: LlmContext, role: string) =>
    new RegExp(`- ([a-z]+): ${role} \\(`).exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''
  let leadCalls = 0
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      leadCalls += 1
      if (leadCalls === 1)
        return {
          content: [
            tool('create_task', { subject: 'Collect the facts', assignee: specialist(ctx, 'researcher') }),
            tool('dismiss_worker', {
              name: specialist(ctx, 'coder'),
              reason: 'no code in this conversation',
            }),
          ],
        }
      return { content: [tool('reply_user', { text: `Answer ${leadCalls}.`, final: true })] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  const seenByResearcher: string[] = []
  const researcher = createMockModel({
    handler: (ctx: LlmContext) => {
      seenByResearcher.push(JSON.stringify(ctx.messages))
      return { content: ['Noted: the facts are about tides.'] }
    },
  })
  resolver.register('mock/researcher', { model: researcher.model, streamFn: researcher.stream })
  scripted(resolver, 'mock/coder', [['should not run']])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('team') })
  const config: TeamConfig = {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [
      { role: 'researcher', model: 'mock/researcher' },
      { role: 'coder', model: 'mock/coder' },
    ],
    judgeModel: 'mock/judge',
  }
  const first = await chats.send('Explain tides', config)
  const r1 = await waitFor(first.colonyId)
  const names = (st: ColonyState) =>
    Object.values(st.agents).map((a) => `${a.info.name}:${a.info.specialty ?? a.info.role}`)
  const scout = Object.values(r1.agents).find((a) => a.info.specialty === 'researcher')?.info.name
  expect(Object.values(r1.agents).find((a) => a.info.specialty === 'coder')?.dismissed).toBe(true)

  const second = await chats.send('Now explain spring tides', config, first.chatId)
  const r2 = await waitFor(second.colonyId)
  expect(names(r2)).toEqual(['lead:lead', `${scout}:researcher`])
  expect(existsSync(join(home, 'colonies', second.colonyId, 'agents', `${scout}.jsonl`))).toBe(true)
  expect(existsSync(join(home, 'colonies', second.colonyId, 'agents', 'lead.jsonl'))).toBe(true)
  expect(seenByResearcher.length).toBeGreaterThan(0)
})

test('a worker that stops while holding its task is reminded to finish it', async () => {
  const resolver = new ModelResolver()
  const specialist = (ctx: LlmContext, role: string) =>
    new RegExp(`- ([a-z]+): ${role} \\(`).exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''
  scripted(resolver, 'mock/lead', [
    (ctx) => [
      tool('create_task', {
        subject: 'Write the notes',
        assignee: specialist(ctx, 'researcher'),
        outputs: ['notes.md'],
      }),
    ],
    ['waiting'],
  ])
  const seen: string[] = []
  const worker = createMockModel({
    handler: (ctx: LlmContext) => {
      const last = JSON.stringify(ctx.messages.at(-1) ?? '')
      seen.push(last)
      const id = /(task-\d+) r1 is yours/.exec(last)?.[1]
      if (id) return { content: [tool('claim_task', { id, revision: 1 })] }
      if (last.includes('Reminder 1 of 2'))
        return {
          content: [
            tool('publish_artifact', { name: 'notes.md', content: '# Notes' }),
            tool('submit_task', { id: 'task-1', revision: 2, artifacts: ['notes.md'] }),
          ],
        }
      return { content: ['I will get to it.'] }
    },
  })
  resolver.register('mock/researcher', { model: worker.model, streamFn: worker.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('team') })
  const { colonyId } = await chats.send('Take notes', {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [{ role: 'researcher', model: 'mock/researcher' }],
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId, (st) => st.tasks['task-1']?.status === 'verified').catch(async (err) => {
    if (process.env.MYR_DEBUG)
      for (const e of await events(colonyId))
        console.log(e.seq, e.type, JSON.stringify(e.payload).slice(0, 200))
    throw err
  })
  expect(s.artifacts['notes.md']).toBeDefined()
  expect(seen.some((m) => m.includes('You stopped while holding task-1'))).toBe(true)
  await chats.stopAll()
})

test('agents can call the tools of connected MCP servers, and the calls are logged', async () => {
  const { McpHub } = await import('../src/mcp.ts')
  const hub = new McpHub(join(home, 'agent'))
  await hub.add('echo', { command: 'bun', args: [join(import.meta.dir, 'fixtures', 'echo-mcp.ts')] })
  const echo = hub.tools().find((t) => t.name.endsWith('echo'))?.name ?? 'missing'
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/solo', [
    [tool(echo, { text: 'from the colony' })],
    [tool('reply_user', { text: 'Echoed.', final: true })],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), mcp: hub })
  const { colonyId } = await chats.send('Echo something', { ...solo('mock/solo'), judgeModel: 'mock/judge' })
  await waitFor(colonyId)
  const results = (await events(colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
  expect(results.find((r) => r.tool === echo)).toMatchObject({ ok: true, output: 'echo: from the colony' })
  await hub.close()
})

test('fs_edit changes part of a scratch file instead of rewriting it', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/solo', [
    [tool('fs_write', { path: 'page.html', content: '<h1>Hello</h1>\n<p>draft</p>\n<p>draft</p>\n' })],
    [
      tool('fs_edit', { path: 'page.html', old: '<h1>Hello</h1>', new: '<h1>Weather</h1>' }),
      tool('fs_edit', { path: 'page.html', old: 'draft', new: 'final', all: true }),
      tool('fs_edit', { path: 'page.html', old: 'missing', new: 'x' }),
    ],
    [tool('publish_artifact', { name: 'page.html', fromScratch: 'page.html' })],
    [tool('reply_user', { text: 'Done.', final: true })],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { colonyId } = await chats.send('Make a page', { ...solo('mock/solo'), judgeModel: 'mock/judge' })
  const s = await waitFor(colonyId)
  const results = (await events(colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
    .filter((r) => r.tool === 'fs_edit')
  expect(results.map((r) => r.ok)).toEqual([true, true, false])
  expect(results[2]?.output).toContain('not found')
  const blob = s.artifacts['page.html']?.at(-1)?.blob ?? ''
  const { BlobStore } = await import('@myrmidon/core')
  const text = await new BlobStore(join(home, 'colonies', colonyId, 'blobs')).text(blob)
  expect(text).toBe('<h1>Weather</h1>\n<p>final</p>\n<p>final</p>\n')
})

test('plan mode presents the plan for approval before any work, and thinking can be set per chat', async () => {
  const resolver = new ModelResolver()
  const prompts: string[] = []
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      prompts.push(JSON.stringify(ctx.messages))
      return prompts.length === 1
        ? { content: [tool('ask_user', { question: 'Plan: one page, three sections. Approve?' })] }
        : { content: ['Waiting for approval.'] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const config: TeamConfig = { ...solo('mock/lead'), thinking: 'low' }
  const { colonyId } = await chats.send('Make a landing page', config, undefined, { planFirst: true })
  const s = await waitFor(colonyId)
  expect(prompts[0]).toContain('Plan first')
  expect(s.statusReason).toBe('awaiting your reply')
  expect(s.artifacts).toEqual({})
  const created = (await events(colonyId)).find((e) => e.type === 'colony/created')
  expect((created?.payload as { thinking?: string } | undefined)?.thinking).toBe('low')
})

test.skipIf(!findChrome())('browser_extract reads tables, links and repeating items as JSON', async () => {
  const html = `<title>Shop</title>
    <table><caption>Plans</caption><tr><th>Plan</th><th>Price</th></tr><tr><td>Free</td><td>$0</td></tr><tr><td>Pro</td><td>$12</td></tr></table>
    <div class="product"><h2>Lamp</h2><span class="price">$30</span><a href="/lamp">see</a></div>
    <div class="product"><h2>Desk</h2><span class="price">$250</span><a href="/desk">see</a></div>`
  const site = Bun.serve({
    port: 0,
    fetch: () => new Response(html, { headers: { 'content-type': 'text/html' } }),
  })
  const base = `http://localhost:${site.port}`
  const browser = new BrowserHub(join(home, 'browser'))
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/extractor', [
    [tool('browser_open', { url: `${base}/` })],
    [
      tool('browser_extract', { what: 'tables' }),
      tool('browser_extract', {
        what: 'items',
        selector: '.product',
        fields: '{"name":"h2","price":".price","url":"a@href"}',
      }),
      tool('browser_extract', { what: 'links', selector: '.product' }),
      tool('browser_extract', { what: 'items', selector: '.nothing', fields: '{"x":"b"}' }),
    ],
    [tool('reply_user', { text: 'Done.', final: true })],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), browser })
  const { colonyId } = await chats.send('Read the shop', {
    ...solo('mock/extractor'),
    judgeModel: 'mock/judge',
  })
  await waitFor(colonyId)
  const log = await events(colonyId)
  const args = new Map(
    log
      .filter((e) => e.type === 'tool/call')
      .map((e) => {
        const p = e.payload as EventPayloads['tool/call']
        return [p.callId, JSON.stringify(p.args)] as const
      }),
  )
  const out = (what: string) =>
    log
      .filter((e) => e.type === 'tool/result')
      .map((e) => e.payload as EventPayloads['tool/result'])
      .find((r) => r.tool === 'browser_extract' && args.get(r.callId)?.includes(what))?.output ?? ''
  const json = (text: string) => JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1))
  expect(json(out('"tables"'))).toEqual([
    {
      caption: 'Plans',
      headers: ['Plan', 'Price'],
      rows: [
        { Plan: 'Free', Price: '$0' },
        { Plan: 'Pro', Price: '$12' },
      ],
    },
  ])
  expect(json(out('.product","fields'))).toEqual([
    { name: 'Lamp', price: '$30', url: `${base}/lamp` },
    { name: 'Desk', price: '$250', url: `${base}/desk` },
  ])
  expect(json(out('"links"'))).toEqual([
    { text: 'see', href: `${base}/lamp` },
    { text: 'see', href: `${base}/desk` },
  ])
  expect(out('.nothing')).toContain('Nothing matched')
  await browser.close()
  site.stop(true)
})

test.skipIf(!findChrome())('browser_network lists requests, failures and API bodies', async () => {
  const site = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname
      if (path === '/api/items') return Response.json([{ id: 1, name: 'Lamp' }])
      if (path === '/missing.js') return new Response('nope', { status: 404 })
      return new Response(
        `<title>App</title><script src="/missing.js"></script><script>fetch('/api/items').then(r => r.json())</script>`,
        { headers: { 'content-type': 'text/html' } },
      )
    },
  })
  const base = `http://localhost:${site.port}`
  const browser = new BrowserHub(join(home, 'browser'))
  const resolver = new ModelResolver()
  let apiId = '0'
  const model = createMockModel({
    handler: (ctx: LlmContext) => {
      const text = JSON.stringify(ctx.messages.at(-1))
      const m = /#(\d+) GET 200 fetch/.exec(text)
      if (m?.[1]) apiId = m[1]
      const n = ctx.messages.filter((x) => x.role === 'assistant').length
      const steps = [
        [tool('browser_open', { url: `${base}/` })],
        [tool('browser_network', { only: 'failed' })],
        [tool('browser_network', { only: 'api' })],
        [tool('browser_network', { body: Number(apiId) })],
        [tool('reply_user', { text: 'Done.', final: true })],
      ]
      return { content: steps[n] ?? ['done'] }
    },
  })
  resolver.register('mock/netdebug', { model: model.model, streamFn: model.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), browser })
  const { colonyId } = await chats.send('Debug the app', {
    ...solo('mock/netdebug'),
    judgeModel: 'mock/judge',
  })
  await waitFor(colonyId)
  const out = (await events(colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
    .filter((r) => r.tool === 'browser_network')
    .map((r) => r.output)
  // Chrome aborts a 404 script after its response: both the status and the failure are shown.
  expect(out[0]).toMatch(
    /GET 404( FAILED \(net::ERR_ABORTED\))? script \d+ms http:\/\/localhost:\d+\/missing\.js/,
  )
  expect(out[0]).not.toContain('/api/items')
  expect(out[1]).toMatch(/GET 200 fetch \d+ms .*\/api\/items/)
  expect(out[2]).toContain('[{"id":1,"name":"Lamp"}]')
  await browser.close()
  site.stop(true)
})

test.skipIf(!findChrome())(
  'a browser flow is saved after its test run and replays with new inputs',
  async () => {
    const site = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url)
        if (url.pathname === '/search') {
          const q = url.searchParams.get('q') ?? ''
          return new Response(
            `<title>Results</title><div class="result"><h3>${q} one</h3></div><div class="result"><h3>${q} two</h3></div>`,
            {
              headers: { 'content-type': 'text/html' },
            },
          )
        }
        return new Response(
          `<title>Shop</title><form action="/search"><input name="q" aria-label="Query"><button>Go</button></form>`,
          { headers: { 'content-type': 'text/html' } },
        )
      },
    })
    const base = `http://localhost:${site.port}`
    const steps = [
      { open: `${base}/` },
      { type: 'aria=Query', text: '{query}', submit: true },
      { wait: '.result' },
      { extract: { what: 'items', selector: '.result', fields: { name: 'h3' } } },
    ]
    const browser = new BrowserHub(join(home, 'browser'))
    const resolver = new ModelResolver()
    const flow = (name: string, source: unknown[]) => ({
      name,
      description: 'Search the shop and list the results by name.',
      inputs: [{ name: 'query', type: 'string' }],
      language: 'browser',
      source: JSON.stringify(source),
      test: '{"query": "lamp"}',
    })
    scripted(resolver, 'mock/flows', [
      [tool('create_tool', flow('broken_search', [{ open: `${base}/` }, { click: 'text=No such button' }]))],
      [tool('create_tool', flow('shop_search', steps))],
      [tool('tool_shop_search', { query: 'desk' })],
      [tool('reply_user', { text: 'Done.', final: true })],
    ])
    judge(resolver)
    const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), browser })
    const { colonyId } = await chats.send('Search the shop', {
      ...solo('mock/flows'),
      judgeModel: 'mock/judge',
    })
    const s = await waitFor(colonyId)
    const out = (await events(colonyId))
      .filter((e) => e.type === 'tool/result')
      .map((e) => e.payload as EventPayloads['tool/result'])
    expect(out[0]).toMatchObject({ tool: 'create_tool', ok: false })
    expect(out[0]?.output).toContain('step 2 ({"click":"text=No such button"}) failed')
    expect(out[1]).toMatchObject({ tool: 'create_tool', ok: true })
    expect(out[1]?.output).toContain('"name": "lamp one"')
    expect(out[2]).toMatchObject({ tool: 'tool_shop_search', ok: true })
    expect(out[2]?.output).toContain('"name": "desk one"')
    expect(out[2]?.output).toContain('"name": "desk two"')
    expect(s.madeTools.shop_search?.language).toBe('browser')
    expect(s.madeTools.broken_search).toBeUndefined()
    await browser.close()
    site.stop(true)
  },
)

test.skipIf(!findChrome())('browser tabs, downloads and uploads', async () => {
  const site = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname
      if (path === '/data.csv')
        return new Response('a,b\n1,2\n', {
          headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="data.csv"' },
        })
      if (path === '/other')
        return new Response('<title>Other</title><h1>Second page</h1>', {
          headers: { 'content-type': 'text/html' },
        })
      return new Response(
        `<title>Home</title><a href="/data.csv">Get data</a> <a href="/other" target="_blank">Open other</a>
           <input type="file" aria-label="Report" onchange="document.title = 'got ' + this.files[0].name">`,
        { headers: { 'content-type': 'text/html' } },
      )
    },
  })
  const base = `http://localhost:${site.port}`
  const browser = new BrowserHub(join(home, 'browser'))
  const resolver = new ModelResolver()
  let snapshot = ''
  const refFor = (name: string) =>
    new RegExp(`\\[(e\\d+)\\][^\\n]*${name}|${name}[^\\n]*\\[(e\\d+)\\]`).exec(snapshot)
  const ref = (name: string) => {
    const m = refFor(name)
    return m?.[1] ?? m?.[2] ?? 'e0'
  }
  const agentModel = createMockModel({
    handler: (ctx: LlmContext) => {
      const last = ctx.messages.at(-1) as { content?: { text?: string }[] } | undefined
      const text = last?.content?.map((c) => c.text ?? '').join('') ?? ''
      if (text.includes('url:')) snapshot = text
      const n = ctx.messages.filter((m) => m.role === 'assistant').length
      const steps = [
        () => [tool('browser_open', { url: `${base}/` })],
        () => [tool('browser_click', { ref: ref('Get data') })],
        () => [tool('browser_downloads', {})],
        () => [tool('browser_click', { ref: ref('Open other') })],
        () => [tool('browser_tabs', { switch: 1 })],
        () => [tool('fs_write', { path: 'report.txt', content: 'hello' })],
        () => [tool('browser_upload', { ref: ref('Report'), path: 'report.txt' })],
        () => [tool('browser_tabs', { close: 2 })],
        () => [tool('reply_user', { text: 'Done.', final: true })],
      ]
      return { content: steps[n]?.() ?? ['done'] }
    },
  })
  resolver.register('mock/surfer', { model: agentModel.model, streamFn: agentModel.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), browser })
  const { colonyId } = await chats.send('Use the site', { ...solo('mock/surfer'), judgeModel: 'mock/judge' })
  await waitFor(colonyId)
  const out = (await events(colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
  const of = (tool: string, i = 0) => out.filter((r) => r.tool === tool)[i]?.output ?? ''
  expect(of('browser_downloads')).toContain('downloads/data.csv (8 bytes)')
  // The link with target=_blank opened a second tab and the browser switched to it.
  expect(of('browser_click', 1)).toContain('Second page')
  expect(of('browser_tabs', 0)).toMatch(/\* 1\. Home — http/)
  expect(of('browser_tabs', 0)).toMatch(/ {2}2\. Other — http/)
  expect(of('browser_upload')).toContain('Chose report.txt')
  expect(of('browser_upload')).toContain('title: got report.txt')
  expect(of('browser_tabs', 1)).not.toContain('Other')
  await browser.close()
  site.stop(true)
})

test.skipIf(!findChrome())(
  'request_login waits for the person to sign in and hand the browser back',
  async () => {
    const site = Bun.serve({
      port: 0,
      fetch: () =>
        new Response('<title>Sign in</title><h1>Please sign in</h1>', {
          headers: { 'content-type': 'text/html' },
        }),
    })
    const browser = new BrowserHub(join(home, 'browser'))
    const resolver = new ModelResolver()
    scripted(resolver, 'mock/needs-login', [
      [
        tool('request_login', {
          url: `http://localhost:${site.port}/login`,
          site: 'Example',
          reason: 'The report is behind a login.',
        }),
      ],
      [tool('reply_user', { text: 'Signed in, thanks.', final: true })],
    ])
    judge(resolver)
    const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), browser })
    const { colonyId } = await chats.send('Get the report', {
      ...solo('mock/needs-login'),
      judgeModel: 'mock/judge',
    })
    const waiting = await waitFor(colonyId, (s) => Object.values(s.logins).some((l) => !l.finished))
    expect(Object.values(waiting.logins)[0]).toMatchObject({
      site: 'Example',
      reason: 'The report is behind a login.',
    })
    // Handing back (what the Computer view does after the person signs in) ends the wait.
    await chats.handBack(colonyId, Object.keys(waiting.logins)[0] ?? '')
    const s = await waitFor(colonyId)
    expect(Object.values(s.logins)[0]?.finished).toBe('handed-back')
    const result = (await events(colonyId)).find((e) => e.type === 'tool/result')
      ?.payload as EventPayloads['tool/result']
    expect(result.ok).toBe(true)
    expect(result.output).toContain('The person signed in to Example and handed the browser back.')
    expect(result.output).toContain('Please sign in')
    await browser.close()
    site.stop(true)
  },
)

test.skipIf(!findChrome())(
  'an agent opens the page it built in a real browser, clicks, and reads the console',
  async () => {
    const browser = new BrowserHub(join(home, 'browser'))
    const resolver = new ModelResolver()
    const page =
      "<!doctype html><title>Counter</title><button onclick=\"this.textContent='Clicked';console.log('clicked ok')\">Go</button>"
    const seen: string[] = []
    const agent = createMockModel({
      handler: (ctx: LlmContext) => {
        const last = JSON.stringify(ctx.messages.at(-1) ?? '')
        seen.push(last)
        if (seen.length === 1)
          return { content: [tool('publish_artifact', { name: 'index.html', content: page })] }
        if (seen.length === 2) return { content: [tool('browser_open', { url: 'artifact:index.html' })] }
        const ref = /button \\"Go\\" \[(e\d+)\]/.exec(last)?.[1]
        if (ref) return { content: [tool('browser_click', { ref })] }
        if (last.includes('Clicked') && !last.includes('clicked ok'))
          return { content: [tool('browser_console', {}), tool('browser_screenshot', {})] }
        return { content: [tool('reply_user', { text: 'Tested.', final: true })] }
      },
    })
    resolver.register('mock/solo', { model: agent.model, streamFn: agent.stream })
    judge(resolver)
    const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), browser })
    const { colonyId } = await chats.send('Build and test a counter', {
      ...solo('mock/solo'),
      judgeModel: 'mock/judge',
    })
    await waitFor(colonyId)
    const results = (await events(colonyId))
      .filter((e) => e.type === 'tool/result')
      .map((e) => e.payload as EventPayloads['tool/result'])
    const out = (tool: string) => results.find((r) => r.tool === tool)
    expect(out('browser_open')?.output).toContain('title: Counter')
    expect(out('browser_click')?.output).toContain('button "Clicked"')
    expect(out('browser_console')?.output).toContain('clicked ok')
    expect(out('browser_screenshot')?.ok).toBe(true)
    // Each action left a keyframe to replay.
    const frames = (await events(colonyId)).filter((e) => e.type === 'browser/keyframe')
    expect(frames.map((e) => (e.payload as { action: string }).action)).toEqual(['open', 'click'])
    await browser.close()
  },
  60_000,
)

test('long pages are saved to scratch with an excerpt, and an unfinished todo list gets a reminder', async () => {
  const resolver = new ModelResolver()
  const web = {
    search: async () => 'results',
    read: async (url: string) => ({
      url,
      method: 'html',
      contentType: 'text/html',
      output: `START ${'lorem ipsum '.repeat(2000)} END-OF-PAGE`,
    }),
  }
  const seen: string[] = []
  const agent = createMockModel({
    handler: (ctx: LlmContext) => {
      const last = JSON.stringify(ctx.messages.at(-1) ?? '')
      seen.push(last)
      if (seen.length === 1)
        return {
          content: [
            tool('update_todo', { items: [{ text: 'Read the page' }, { text: 'Summarise it' }] }),
            tool('web_fetch', { url: 'https://example.com/long' }),
          ],
        }
      if (last.includes('open items on your todo list'))
        return {
          content: [
            tool('update_todo', {
              items: [
                { text: 'Read the page', done: true },
                { text: 'Summarise it', done: true },
              ],
            }),
            tool('reply_user', { text: 'Summarised.', final: true }),
          ],
        }
      return { content: ['Pausing here.'] }
    },
  })
  resolver.register('mock/solo', { model: agent.model, streamFn: agent.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), web })
  const { colonyId } = await chats.send('Summarise a long page', {
    ...solo('mock/solo'),
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  const fetched = (await events(colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
    .find((r) => r.tool === 'web_fetch')
  expect(fetched?.output).toContain('the full text is saved as web/')
  expect(fetched?.output).not.toContain('END-OF-PAGE')
  const name = /saved as (web\/[\w.-]+\.md)/.exec(fetched?.output ?? '')?.[1] ?? ''
  const saved = await Bun.file(join(home, 'colonies', colonyId, 'scratch', 'lead', name)).text()
  expect(saved).toContain('END-OF-PAGE')
  expect(seen.some((m) => m.includes('You stopped with 2 open items on your todo list'))).toBe(true)
})

test('searching for a past year gets a note that the results may be stale', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/solo', [
    [tool('web_search', { query: 'API pricing 2024' }), tool('web_search', { query: 'API pricing' })],
    [tool('reply_user', { text: 'Done.', final: true })],
  ])
  judge(resolver)
  const web = {
    search: async () => 'some results',
    read: async () => ({ url: '', method: '', contentType: '', output: '' }),
  }
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), web })
  const { colonyId } = await chats.send('Find pricing', { ...solo('mock/solo'), judgeModel: 'mock/judge' })
  await waitFor(colonyId)
  const outputs = (await events(colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
    .filter((r) => r.tool === 'web_search')
    .map((r) => r.output)
  // Searches run in parallel, so their results can land in either order.
  // The harness's note stays outside the untrusted block; the results are inside it.
  const noted = outputs.filter((o) => o.startsWith('Note: your query names 2024'))
  expect(noted).toHaveLength(1)
  expect(noted[0]).toMatch(/\n\n⟦untrusted \w+ · search: API pricing 2024⟧\nsome results\n⟦\/untrusted \w+⟧$/)
  expect(
    outputs.filter((o) => /^⟦untrusted \w+ · search: API pricing⟧\nsome results\n/.test(o)),
  ).toHaveLength(1)
})

test('a model refusal pauses the round, stays out of context, and the round continues on another model', async () => {
  const resolver = new ModelResolver()
  let calls = 0
  const refusing = createMockModel({
    handler: () => {
      calls += 1
      return calls === 1
        ? { content: [tool('fs_write', { path: 'notes.md', content: '# Notes' })] }
        : {
            stopReason: 'error',
            errorMessage: 'Refusal (cyber): This request triggered restrictions on violative cyber content.',
          }
    },
  })
  resolver.register('mock/refuser', { model: refusing.model, streamFn: refusing.stream })
  const seen: string[] = []
  const backup = createMockModel({
    handler: (ctx: LlmContext) => {
      seen.push(JSON.stringify(ctx.messages))
      return { content: [tool('reply_user', { text: 'Done on the backup model.', final: true })] }
    },
  })
  resolver.register('mock/backup', { model: backup.model, streamFn: backup.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { chatId, colonyId } = await chats.send('Write the notes', {
    ...solo('mock/refuser'),
    judgeModel: 'mock/judge',
  })
  const paused = await waitFor(colonyId)
  expect(paused.status).toBe('stopped')
  expect(paused.statusReason).toContain('model refused')
  expect(paused.modelError).toMatchObject({ agent: 'lead', kind: 'refusal' })
  expect(paused.modelError?.message).toContain('Refusal (cyber)')

  await chats.resume(chatId, 'mock/backup')
  const done = await waitFor(colonyId, (st) => st.status === 'completed')
  expect(done.agents.lead?.info.model).toBe('mock/backup')
  expect(done.modelError).toBeUndefined()
  // The backup model sees the work so far, but never the refusal.
  expect(seen[0]).toContain('# Notes')
  expect(seen[0]).not.toContain('Refusal')
})

test('a transient model error is retried quietly and never enters the context', async () => {
  const resolver = new ModelResolver()
  const seen: string[] = []
  const flaky = createMockModel({
    handler: (ctx: LlmContext) => {
      seen.push(JSON.stringify(ctx.messages))
      return seen.length === 1
        ? { stopReason: 'error', errorMessage: 'Overloaded: the server is temporarily busy' }
        : { content: [tool('reply_user', { text: 'Answered after a retry.', final: true })] }
    },
  })
  resolver.register('mock/flaky', { model: flaky.model, streamFn: flaky.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { colonyId } = await chats.send('Answer me', { ...solo('mock/flaky'), judgeModel: 'mock/judge' })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(s.modelError).toBeUndefined()
  expect(seen[1]).not.toContain('Overloaded')
}, 20_000)

test('a chat in a project works in that folder, follow-ups stay in it, and a round can be rewound', async () => {
  const { ProjectStore } = await import('../src/projects.ts')
  const { Checkpoints } = await import('../src/checkpoints.ts')
  const checkpoints = new Checkpoints(join(home, 'checkpoints'))
  const folder = mkdtempSync(join(tmpdir(), 'myr-project-'))
  await Bun.write(join(folder, 'README.md'), '# Demo project')
  const projects = new ProjectStore(home)
  const project = projects.add(folder)
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/solo', [
    [
      tool('fs_read', { path: 'README.md' }),
      tool('fs_write', { path: 'src/hello.ts', content: 'export const hi = 1\n' }),
      tool('fs_read', { path: '../outside.txt' }),
    ],
    [tool('reply_user', { text: 'Added src/hello.ts.', final: true })],
    ['done'],
    [tool('reply_user', { text: 'Still here.', final: true })],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), projects, checkpoints })
  const config = { ...solo('mock/solo'), judgeModel: 'mock/judge' }
  const first = await chats.send('Add a hello module', config, undefined, { project: project.id })
  const s = await waitFor(first.colonyId)
  const results = (await events(first.colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
  expect(results[0]?.output).toContain('# Demo project')
  expect(await Bun.file(join(folder, 'src', 'hello.ts')).text()).toBe('export const hi = 1\n')
  expect(results[2]?.output).toContain('outside your project')
  expect(s.chat?.project?.id).toBe(project.id)

  const second = await chats.send('And now?', config, first.chatId)
  const s2 = await waitFor(second.colonyId)
  expect(s2.chat?.project?.path).toBe(project.path)
  expect((await chats.list()).find((c) => c.chatId === first.chatId)?.project?.name).toBe(project.name)

  // Each round is snapshotted at its start and end: its changes are the diff, and rewinding undoes them.
  await waitFor(first.colonyId, (x) => x.checkpoints.end !== undefined)
  await waitFor(second.colonyId, (x) => x.checkpoints.end !== undefined)
  const changes = await chats.changes(first.colonyId)
  expect(changes.files).toEqual([{ path: 'src/hello.ts', status: 'A', added: 1, removed: 0 }])
  expect(await chats.rewind(first.colonyId)).toEqual({ changed: 1 })
  expect(existsSync(join(folder, 'src', 'hello.ts'))).toBe(false)
  expect(await Bun.file(join(folder, 'README.md')).text()).toBe('# Demo project')
  await chats.rewind(first.colonyId, true)
  expect(await Bun.file(join(folder, 'src', 'hello.ts')).text()).toBe('export const hi = 1\n')
  rmSync(folder, { recursive: true, force: true })
})

test.skipIf(detectSandbox().kind === 'none')(
  "run_checks runs the project's own checks and reports what failed",
  async () => {
    const { ProjectStore } = await import('../src/projects.ts')
    const folder = mkdtempSync(join(tmpdir(), 'myr-checks-'))
    await Bun.write(
      join(folder, 'package.json'),
      JSON.stringify({
        scripts: {
          typecheck: 'echo types ok',
          lint: "echo 'src/a.ts:3 unused variable' && exit 2",
          test: 'echo tests ok',
          build: 'echo built',
        },
      }),
    )
    await Bun.write(join(folder, 'bun.lock'), '')
    const projects = new ProjectStore(home)
    const project = projects.add(folder)
    const resolver = new ModelResolver()
    scripted(resolver, 'mock/checker', [
      [tool('run_checks', {})],
      [tool('run_checks', { only: 'deploy' })],
      [tool('reply_user', { text: 'Lint fails.', final: true })],
    ])
    judge(resolver)
    const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), projects })
    const { colonyId } = await chats.send(
      'Check the project',
      { ...solo('mock/checker'), judgeModel: 'mock/judge' },
      undefined,
      {
        project: project.id,
      },
    )
    await waitFor(colonyId)
    const results = (await events(colonyId))
      .filter((e) => e.type === 'tool/result')
      .map((e) => e.payload as EventPayloads['tool/result'])
    const first = results[0]?.output ?? ''
    expect(first).toContain('PASS typecheck (`bun run typecheck`')
    expect(first).toContain('FAIL lint (`bun run lint`')
    expect(first).toContain('PASS test (`bun run test`')
    expect(first).not.toContain('build')
    expect(first).toContain('src/a.ts:3 unused variable')
    expect(results[1]?.output).toContain(
      'this project has no deploy check; it has: typecheck, lint, test, build',
    )
    rmSync(folder, { recursive: true, force: true })
  },
)

test.skipIf(detectSandbox().kind === 'none')(
  'in a project the judge reads the diff, runs the checks, and returns graded findings',
  async () => {
    const { ProjectStore } = await import('../src/projects.ts')
    const { Checkpoints } = await import('../src/checkpoints.ts')
    const folder = mkdtempSync(join(tmpdir(), 'myr-judge-'))
    await Bun.write(
      join(folder, 'package.json'),
      JSON.stringify({ scripts: { test: 'grep -q good src/state.txt' } }),
    )
    await Bun.write(join(folder, 'bun.lock'), '')
    await Bun.write(join(folder, 'src', 'state.txt'), 'good\n')
    const projects = new ProjectStore(home)
    const project = projects.add(folder)
    const resolver = new ModelResolver()
    scripted(resolver, 'mock/coder', [
      [tool('fs_write', { path: 'src/state.txt', content: 'broken\n' })],
      [tool('reply_user', { text: 'Changed the state file.', final: true })],
      ['waiting'],
    ])
    let seen = ''
    const reviewer = createMockModel({
      handler: (ctx: LlmContext) => {
        seen = JSON.stringify(ctx)
        return {
          content: [
            JSON.stringify({
              score: 0.2,
              reasons: 'The test fails.',
              findings: [
                { severity: 'minor', what: 'Reply could say which file changed.' },
                {
                  severity: 'blocker',
                  where: 'src/state.txt:1',
                  what: 'test fails: the file no longer says good',
                },
              ],
            }),
          ],
        }
      },
    })
    resolver.register('mock/judge', { model: reviewer.model, streamFn: reviewer.stream })
    const chats = new ChatService(runtime, {
      resolver,
      classify: fixed('solo'),
      projects,
      checkpoints: new Checkpoints(join(home, 'checkpoints')),
    })
    const { colonyId } = await chats.send(
      'Update the state file',
      { ...solo('mock/coder'), judgeModel: 'mock/judge' },
      undefined,
      { project: project.id },
    )
    const s = await waitFor(colonyId, (x) => x.verdicts.some((v) => v.target === 'colony'))
    await chats.stopAll()
    expect(seen).toContain('+broken')
    expect(seen).toContain('PROJECT CHECKS')
    expect(seen).toContain('FAIL test (`bun run test`')
    const verdict = s.verdicts.find((v) => v.target === 'colony')
    expect(verdict?.pass).toBe(false)
    // Most serious first, with where it is, then the checks the judge ran.
    expect(verdict?.evidence).toContain(
      '- [blocker] src/state.txt:1: test fails: the file no longer says good\n- [minor] Reply could say which file changed.',
    )
    expect(verdict?.evidence).toContain('Project checks run by the reviewer:\nFAIL test')
    rmSync(folder, { recursive: true, force: true })
  },
)

test.skipIf(detectSandbox().kind === 'none')(
  'project permissions: ask mode waits for the person, read-only keeps the folder untouched',
  async () => {
    const { ProjectStore } = await import('../src/projects.ts')
    const folder = mkdtempSync(join(tmpdir(), 'myr-perm-'))
    const projects = new ProjectStore(home)
    const project = projects.add(folder)
    projects.setPermissions(project.id, { mode: 'ask', allow: ['echo'] })
    const resolver = new ModelResolver()
    scripted(resolver, 'mock/careful', [
      [tool('shell', { command: 'echo allowed' })],
      [tool('shell', { command: 'echo chained && touch chained.txt' })],
      [tool('fs_write', { path: 'denied.txt', content: 'no' })],
      [tool('reply_user', { text: 'Done.', final: true })],
    ])
    judge(resolver)
    const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), projects })
    const config = { ...solo('mock/careful'), judgeModel: 'mock/judge' }
    const { chatId, colonyId } = await chats.send('Try things', config, undefined, { project: project.id })
    const pending = async () => {
      const s = await waitFor(colonyId, (x) => Object.values(x.approvals).some((a) => !a.decided))
      return Object.values(s.approvals).find((a) => !a.decided)
    }
    const first = await pending()
    expect(first).toMatchObject({ tool: 'shell', summary: 'echo chained && touch chained.txt' })
    await chats.decideApproval(colonyId, first?.id ?? '', true)
    const second = await pending()
    expect(second).toMatchObject({ tool: 'fs_write', summary: 'write denied.txt' })
    await chats.decideApproval(colonyId, second?.id ?? '', false)
    const s = await waitFor(colonyId)
    const results = (await events(colonyId))
      .filter((e) => e.type === 'tool/result')
      .map((e) => e.payload as EventPayloads['tool/result'])
    expect(results[0]?.output).toContain('allowed')
    expect(results[1]?.ok).toBe(true)
    expect(existsSync(join(folder, 'chained.txt'))).toBe(true)
    expect(results[2]?.ok).toBe(false)
    expect(results[2]?.output).toContain('did not approve changing denied.txt')
    expect(existsSync(join(folder, 'denied.txt'))).toBe(false)
    expect(Object.values(s.approvals).map((a) => a.decided?.approved)).toEqual([true, false])

    // Read-only: no file tool writes, and the sandbox stops the shell from writing to the project.
    projects.setPermissions(project.id, { mode: 'read-only', allow: [] })
    scripted(resolver, 'mock/reader', [
      [tool('fs_write', { path: 'nope.txt', content: 'x' })],
      [tool('shell', { command: 'touch sneaky.txt' })],
      [tool('reply_user', { text: 'Read only.', final: true })],
    ])
    const next = await chats.send('Try again', { ...solo('mock/reader'), judgeModel: 'mock/judge' }, chatId)
    await waitFor(next.colonyId)
    const after = (await events(next.colonyId))
      .filter((e) => e.type === 'tool/result')
      .map((e) => e.payload as EventPayloads['tool/result'])
    expect(after[0]?.output).toContain('is read-only for agents')
    expect(after[1]?.output).not.toMatch(/^exit 0/)
    expect(existsSync(join(folder, 'nope.txt'))).toBe(false)
    expect(existsSync(join(folder, 'sneaky.txt'))).toBe(false)
    rmSync(folder, { recursive: true, force: true })
  },
)

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

test('the chat list reads only the logs that changed since the last listing', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/indexed', [
    [tool('ask_user', { question: 'Which format do you want?' })],
    ['waiting'],
  ])
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { chatId, colonyId } = await chats.send('make a report', solo('mock/indexed'))
  await waitFor(colonyId)
  await chats.stopAll()

  // A fresh service, as after a restart: nothing is live, so every listing goes through the index.
  const later = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const reads = spyOn(SqliteLogStore.prototype, 'read')
  try {
    expect((await later.list())[0]?.title).toBe('make a report')
    expect(reads).toHaveBeenCalledTimes(1)
    reads.mockClear()
    expect((await later.list())[0]?.rounds).toHaveLength(1)
    expect(reads).toHaveBeenCalledTimes(0)

    await later.rename(chatId, 'Quarterly report')
    reads.mockClear()
    expect((await later.list())[0]?.title).toBe('Quarterly report')
    expect(reads).toHaveBeenCalledTimes(1)
  } finally {
    reads.mockRestore()
  }
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
