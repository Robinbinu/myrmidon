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
  await chats.send('STEER-NOTE use tabs', config, chatId, 'steer')
  await chats.send('QUEUED-NOTE also add a README', config, chatId, 'queue')
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
    'steer',
    [{ name: 'notes.md', bytes: new TextEncoder().encode('# Notes\nShip on Friday.') }],
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
  const { colonyId } = await chats.send('Make a landing page', config, undefined, 'steer', [], true)
  const s = await waitFor(colonyId)
  expect(prompts[0]).toContain('Plan first')
  expect(s.statusReason).toBe('awaiting your reply')
  expect(s.artifacts).toEqual({})
  const created = (await events(colonyId)).find((e) => e.type === 'colony/created')
  expect((created?.payload as { thinking?: string } | undefined)?.thinking).toBe('low')
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
