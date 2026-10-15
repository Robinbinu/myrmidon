import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newColonyId, SqliteLogStore } from '@myrmidon/core'
import { type ColonyState, type EventPayloads, foldColony, type MyrEvent } from '@myrmidon/protocol'
import { classifyModelError } from '../src/agent.ts'
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
import type { AssistantMessage, Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'
import type { OmpRuntime } from '../src/omp/runtime.ts'

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-chat-'))
  runtime = await bootRuntime(home)
})

/** Browsers and MCP servers a test opened, closed even when it fails, so no Chrome or server is left running. */
const opened: { close(): Promise<void> }[] = []

afterEach(async () => {
  for (const o of opened.splice(0)) await o.close().catch(() => {})
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

/** How long a crew's round stays open once everyone is quiet after the answer; the real wait would outlast a test. */
const QUIET_MS = 500

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
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), quietMs: QUIET_MS })
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
  // Changed with the permission model: a team's lead is hands-on by default (it has the crew's build tools too);
  // Permissions → Who can use what turns them off for it (see role-access.test.ts).
  expect(round1.agents.lead?.info.tools).toContain('shell')
  expect(round1.agents.lead?.info.tools).toContain('web_search')
  expect(round1.agents.lead?.info.tools).toContain('assign_task')

  const log = await events(first.colonyId)
  const firstTask = log.findIndex((e) => e.type === 'task/changed')
  const writerStart = log.findIndex(
    (e) => e.type === 'agent/turn' && (e.payload as EventPayloads['agent/turn']).agent === writer,
  )
  expect(writerStart).toBeGreaterThan(firstTask)
  expect(round1.chatMessages.map((m) => m.from)).toEqual(['user', 'lead'])
  expect(round1.artifacts['poem.txt']?.at(-1)?.author).toBe(writer)

  // The follow-up continues the same colony: its files, plan and team are simply still there.
  const second = await chats.send('Now make it rhyme', config, first.chatId)
  expect(second.colonyId).toBe(first.colonyId)
  const round2 = await waitFor(second.colonyId, (s) => s.rounds.length === 2)
  expect(round2.chat?.round).toBe(2)
  expect(round2.rounds.map((r) => r.request)).toEqual(['Write a short poem about ants', 'Now make it rhyme'])
  expect(round2.artifacts['poem.txt']?.[0]?.author).toBe(writer)
  expect(round2.notes[0]?.section).toBe('plan')
  expect(round2.agents[writer]).toBeDefined()
  await chats.stopAll()
})

test('a round has no time limit unless the person sets one, and agents are told so', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/clockless', [
    [tool('read_task', {})],
    [tool('reply_user', { text: 'Done.', final: true })],
  ])
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), quietMs: QUIET_MS })
  const { colonyId } = await chats.send('Take your time', solo('mock/clockless'))
  const s = await waitFor(colonyId)
  // It ends the usual way, waiting on the person, never on a clock.
  expect(s.statusReason).toBe('awaiting your reply')
  expect(s.budget.wallMs).toBe(0)
  const read = (await events(colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
    .find((r) => r.tool === 'read_task')
  expect(read?.output).toContain('TIME LEFT: no time limit')
  // No clock means no "time is running out" nudges.
  expect(
    (await events(colonyId)).some(
      (e) => e.type === 'observer/signal' && (e.payload as { kind?: string }).kind === 'deadline',
    ),
  ).toBe(false)
})

test('crew messages are a conversation: a question left unanswered gets a reminder, and replies thread', async () => {
  const resolver = new ModelResolver()
  const prompts: Record<string, string[]> = {}
  const seen = (who: string) => (ctx: LlmContext) => {
    prompts[who] = [...(prompts[who] ?? []), JSON.stringify(ctx.messages)]
  }
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      seen('lead')(ctx)
      const writer = /- ([a-z]+): writer \(/.exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''
      return [tool('message', { to: writer, text: 'Playful or solemn? Tell me which you pick.' })]
    },
    (ctx) => {
      seen('lead')(ctx)
      return ['waiting']
    },
    (ctx) => {
      seen('lead')(ctx)
      return [tool('reply_user', { text: 'Done.', final: true })]
    },
  ])
  let mailNumber = 0
  scripted(resolver, 'mock/writer', [
    (ctx) => {
      seen('writer')(ctx)
      mailNumber = Number(/#(\d+) from lead/.exec(JSON.stringify(ctx.messages))?.[1] ?? 0)
      return ['busy with the poem']
    },
    (ctx) => {
      seen('writer')(ctx)
      return [tool('message', { to: 'lead', text: 'Playful.', reply_to: mailNumber })]
    },
    ['done'],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), quietMs: QUIET_MS })
  const { colonyId } = await chats.send('Write a short poem about ants', {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [{ role: 'writer', model: 'mock/writer' }],
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId, (x) => x.mail.length >= 2)
  expect(mailNumber).toBeGreaterThan(0)
  // The mail asked for a reply, and the writer's turn ended without one, so it was reminded.
  expect(prompts.writer?.join('\n')).toContain(`Someone is waiting on your answer: #${mailNumber} from lead`)
  expect(s.mail.map((m) => [m.from, m.to, m.replyTo])).toEqual([
    ['lead', expect.any(String), undefined],
    [expect.any(String), 'lead', mailNumber],
  ])
  await chats.stopAll()
})

test('group chats wake their members, the team chat wakes only @mentions, and only asks are chased', async () => {
  const resolver = new ModelResolver()
  const seen: Record<string, string[]> = {}
  const look = (who: string, ctx: LlmContext) => {
    seen[who] = [...(seen[who] ?? []), JSON.stringify(ctx.messages)]
  }
  const names: Record<string, string> = {}
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      look('lead', ctx)
      for (const role of ['writer', 'editor', 'researcher'])
        names[role] =
          new RegExp(`- ([a-z]+): ${role} \\(`).exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''
      return [
        tool('message', { to: 'team', text: 'FYI: the poem is about ants.' }),
        tool('create_group', {
          name: 'poem',
          members: [names.writer, names.editor],
          text: `@${names.writer} can you draft it? @${names.editor} please review it after.`,
        }),
      ]
    },
    ...Array.from({ length: 8 }, () => (ctx: LlmContext) => {
      look('lead', ctx)
      return ['ok']
    }),
  ])
  scripted(resolver, 'mock/writer', [
    (ctx) => {
      look('writer', ctx)
      const n = Number(/\[group:poem\] #(\d+)/.exec(JSON.stringify(ctx.messages))?.[1] ?? 0)
      return [
        tool('message', { to: 'poem', text: 'On it.', reply_to: n }),
        tool('message', { to: 'lead', text: 'thanks' }),
      ]
    },
    ['done'],
    ['done'],
  ])
  scripted(resolver, 'mock/editor', [
    (ctx) => {
      look('editor', ctx)
      return ['reading']
    },
    ...Array.from({ length: 3 }, () => (ctx: LlmContext) => {
      look('editor', ctx)
      return ['ok']
    }),
  ])
  scripted(resolver, 'mock/researcher', [['should not run']])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), quietMs: QUIET_MS })
  const { colonyId } = await chats.send('Write a short poem about ants', {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [
      { role: 'writer', model: 'mock/writer' },
      { role: 'editor', model: 'mock/editor' },
      { role: 'researcher', model: 'mock/researcher' },
    ],
    judgeModel: 'mock/judge',
  })
  await waitFor(colonyId, () => (seen.editor?.length ?? 0) >= 3)
  await Bun.sleep(300)
  const log = await events(colonyId)
  // Both members heard the group message; the one left out of the group was not woken by the team chat FYI.
  expect(seen.writer?.[0]).toContain('[group:poem]')
  expect(seen.editor?.[0]).toContain('[group:poem]')
  expect(turnsOf(log, names.researcher ?? '')).toHaveLength(0)
  // The team chat FYI reached the members quietly, with their next turn.
  expect(seen.writer?.[0]).toContain('[team]')
  // The editor was asked and did not answer, so it is chased; the writer answered, and "thanks" is never chased.
  expect(seen.editor?.at(-1)).toContain('Someone is waiting on your answer')
  expect(seen.writer?.join('\n')).not.toContain('Someone is waiting on your answer')
  expect(seen.lead?.join('\n')).not.toContain('Someone is waiting on your answer')
  await chats.stopAll()
})

test('@name writes to a crew member directly: it answers the person; an idle crew starts a round with it', async () => {
  const resolver = new ModelResolver()
  const seen: Record<string, string[]> = {}
  const look = (who: string, ctx: LlmContext) => {
    seen[who] = [...(seen[who] ?? []), JSON.stringify(ctx.messages)]
  }
  let writer = ''
  let release = () => {}
  const held = new Promise<void>((done) => {
    release = done
  })
  let leadCalls = 0
  const lead = createMockModel({
    // Round 1: the lead is mid-call (the round runs) while the person writes to the writer; then it answers.
    handler: async (ctx: LlmContext) => {
      look('lead', ctx)
      if (leadCalls++ > 0) return { content: ['ok'] }
      writer = /- ([a-z]+): writer \(/.exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''
      await held
      return { content: [tool('reply_user', { text: 'Poem done.', final: true })] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  // The writer answers each message the person sent it once, whenever it is called: how often it is woken in between
  // (to read the lead's final answer, say) depends on how fast the machine is.
  const asked = ['how is it going?', 'make it shorter']
  const answers = ['Hi! I am on the rhymes.', 'Shorter now: ants march.']
  let answered = 0
  const writerModel = createMockModel({
    handler: (ctx: LlmContext) => {
      if (answered < asked.length && JSON.stringify(ctx.messages).includes(asked[answered] ?? '')) {
        look('writer', ctx)
        return { content: [tool('reply_person', { text: answers[answered++] ?? '' })] }
      }
      return { content: [answered === 1 ? 'back to it' : 'done'] }
    },
  })
  resolver.register('mock/writer', { model: writerModel.model, streamFn: writerModel.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), quietMs: QUIET_MS })
  const config = {
    mode: 'orchestrated' as const,
    leadModel: 'mock/lead',
    roster: [{ role: 'writer', model: 'mock/writer' }],
    judgeModel: 'mock/judge',
  }
  const { chatId, colonyId } = await chats.send('Write a poem about ants', config)
  await waitFor(colonyId, () => writer !== '')

  // While the round runs: the writer hears it and answers the person itself; the lead is not woken by it.
  await chats.send(`@${writer} how is it going?`, config, chatId)
  const live = await waitFor(colonyId, (x) => x.chatMessages.some((m) => m.from === writer))
  expect(live.chatMessages.find((m) => m.from === 'user' && m.text.startsWith('@'))?.to).toEqual([writer])
  expect(live.chatMessages.find((m) => m.from === writer)).toMatchObject({
    text: 'Hi! I am on the rhymes.',
    final: false,
  })
  expect(seen.writer?.[0]).toContain('wrote this to you directly')
  expect(seen.lead).toHaveLength(1)
  release()
  await waitFor(colonyId)

  // The crew is idle: writing to the writer starts a round with it, and its answer finishes the round.
  const next = await chats.send(`@${writer} make it shorter`, config, chatId)
  const done = await waitFor(next.colonyId)
  expect(done.status).toBe('completed')
  expect(done.chatMessages.at(-1)).toMatchObject({
    from: writer,
    text: 'Shorter now: ants march.',
    final: true,
  })
  // The round remembers who opened it, so the page shows it as a conversation with them.
  expect(done.chat?.addressed).toEqual([writer])
  const from = done.rounds.at(-1)?.startSeq ?? 0
  const round2 = (await events(next.colonyId)).filter((e) => e.seq >= from)
  expect(turnsOf(round2, 'lead')).toHaveLength(0)
  expect(seen.writer?.at(-1)).toContain('make it shorter')
  await chats.stopAll()
})

test('a crew member written to directly that answers in plain text still reaches the person, and the round ends', async () => {
  const resolver = new ModelResolver()
  let writer = ''
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      writer ||= /- ([a-z]+): writer \(/.exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''
      return { content: [tool('reply_user', { text: 'Poem done.', final: true })] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  scripted(resolver, 'mock/writer', [['The rhyme for "ant" was the hardest to land.']])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), quietMs: QUIET_MS })
  const config = {
    mode: 'orchestrated' as const,
    leadModel: 'mock/lead',
    roster: [{ role: 'writer', model: 'mock/writer' }],
    judgeModel: 'mock/judge',
  }
  const first = await chats.send('Write a poem about ants', config)
  await waitFor(first.colonyId)
  expect(writer).not.toBe('')

  const next = await chats.send(`@${writer} in one sentence, which line was hardest?`, config, first.chatId)
  const done = await waitFor(next.colonyId)
  expect(done.status).toBe('completed')
  expect(done.chatMessages.at(-1)).toMatchObject({
    from: writer,
    text: 'The rhyme for "ant" was the hardest to land.',
    final: true,
  })
  expect(done.signals.filter((x) => x.kind === 'stall')).toHaveLength(0)
  await chats.stopAll()
})

test('a crew member written to directly that asks the lead first answers once the lead replies', async () => {
  const resolver = new ModelResolver()
  let writer = ''
  const lead = createMockModel({
    handler: async (ctx: LlmContext) => {
      writer ||= /- ([a-z]+): writer \(/.exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''
      const said = JSON.stringify(ctx.messages)
      if (!said.includes('confirm scope'))
        return { content: [tool('reply_user', { text: 'Poem done.', final: true })] }
      if (ctx.messages.at(-1)?.role === 'toolResult') return { content: ['ok'] }
      // The lead answers after the writer's turn has ended on its holding line.
      await Bun.sleep(300)
      return { content: [tool('message', { to: writer, text: 'Scope: the chorus only.' })] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  scripted(resolver, 'mock/writer', [
    [tool('message', { to: 'lead', text: 'Please confirm scope for the rewrite.' })],
    ["I've asked the lead to confirm scope and will reply then."],
    ['The chorus is now four lines, as the lead asked.'],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), quietMs: QUIET_MS })
  const config = {
    mode: 'orchestrated' as const,
    leadModel: 'mock/lead',
    roster: [{ role: 'writer', model: 'mock/writer' }],
    judgeModel: 'mock/judge',
  }
  const first = await chats.send('Write a poem about ants', config)
  await waitFor(first.colonyId)

  const next = await chats.send(`@${writer} rewrite it shorter`, config, first.chatId)
  const done = await waitFor(next.colonyId)
  expect(done.status).toBe('completed')
  const replies = done.chatMessages.filter((m) => m.from === writer)
  expect(replies).toEqual([
    expect.objectContaining({ text: 'The chorus is now four lines, as the lead asked.', final: true }),
  ])
  await chats.stopAll()
})

test('saved specialists: kept by name, joined from the team picker or by the lead, as the person set them up', async () => {
  const { SpecialistStore } = await import('../src/specialists.ts')
  const specialists = new SpecialistStore(home)
  expect(() => specialists.save({ name: 'Lead', specialty: 'x', instructions: '', off: [] })).toThrow(
    'uses itself',
  )
  expect(() => specialists.save({ name: 'a', specialty: 'x', instructions: '', off: [] })).toThrow('2-24')
  const ada = specialists.save({
    name: 'Ada',
    specialty: 'data analyst',
    instructions: 'Always show the numbers behind a claim.',
    model: 'mock/ada',
    off: ['web', 'shell'],
  })
  expect(ada.name).toBe('ada')
  expect(() => specialists.save({ name: 'ada', specialty: 'y', instructions: '', off: [] })).toThrow(
    'already',
  )
  specialists.save({ name: 'scout', specialty: 'web researcher', instructions: 'Cite sources.', off: [] })

  const resolver = new ModelResolver()
  const prompts: Record<string, string> = {}
  const look = (who: string) => (ctx: LlmContext) => {
    prompts[who] ??= ctx.systemPrompt?.join('\n') ?? ''
  }
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      look('lead')(ctx)
      return [tool('add_crewmate', { specialist: 'scout', focus: 'Find three sources on ant colonies' })]
    },
    [tool('reply_user', { text: 'Done.', final: true })],
  ])
  scripted(resolver, 'mock/ada', [(ctx) => (look('ada')(ctx), ['ok'])])
  judge(resolver)
  const chats = new ChatService(runtime, {
    resolver,
    classify: fixed('team'),
    specialists,
    quietMs: QUIET_MS,
  })
  const { colonyId } = await chats.send('Analyse ant colonies', {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [{ role: 'analyst', model: 'mock/ada', specialist: 'ada' }],
    extraWorkers: 0,
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId)
  // From the team picker: Ada joins under her own name, with her instructions, and without the tools switched off.
  expect(s.agents.ada?.info).toMatchObject({ role: 'worker', model: 'mock/ada', specialty: 'data analyst' })
  expect(s.agents.ada?.info.tools).not.toContain('web_search')
  expect(s.agents.ada?.info.tools).not.toContain('shell')
  expect(s.agents.ada?.info.tools).toContain('fs_write')
  // The lead sees the specialists it can bring in, and brings Scout in by name though it had no spare slot.
  const keeps = prompts.lead?.split('Specialists the person keeps')[1]?.split('\n- You plan')[0] ?? ''
  expect(keeps).toContain('- scout: web researcher')
  // Ada is already on the team, so she is not offered again.
  expect(keeps).not.toContain('- ada:')
  expect(s.agents.scout?.info).toMatchObject({ role: 'worker', specialty: 'web researcher' })
  await chats.stopAll()
})

test('crewmates on call: a lead working alone asks them for work and gets their answers back as results', async () => {
  const resolver = new ModelResolver()
  const seen: { system?: string; tools?: string[]; results?: string; job?: unknown } = {}
  const names = (system: string) =>
    [
      // Only the roster lines, up to the instructions after them.
      ...((system.split('Your crewmates on call')[1] ?? '').split('\n- Ask')[0] ?? '').matchAll(
        /^- (\w+): (\w+) \(/gm,
      ),
    ].map((m) => [m[2], m[1]])
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      seen.system = ctx.systemPrompt?.join('\n') ?? ''
      seen.tools = ctx.tools?.map((t) => t.name)
      const by = Object.fromEntries(names(seen.system))
      // Two independent jobs in one step: both crewmates work at once.
      return [
        tool('ask_crewmate', { to: by.researcher, job: 'Find how many ants live in a typical colony.' }),
        tool('ask_crewmate', { to: by.writer, job: 'Draft a one-line title for an ant poem.' }),
      ]
    },
    (ctx) => {
      seen.results = JSON.stringify(ctx.messages.filter((m) => m.role === 'toolResult'))
      return [tool('reply_user', { text: 'About 300,000 ants.', final: true })]
    },
  ])
  // The researcher answers the lead by message; the writer stops without answering.
  scripted(resolver, 'mock/researcher', [
    (ctx) => {
      seen.job = ctx.messages[0]?.content
      return [tool('message', { to: 'lead', text: 'Typically 300,000 ants.' })]
    },
    ['Answered the lead.'],
  ])
  scripted(resolver, 'mock/writer', [['Thinking about titles.']])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), quietMs: QUIET_MS })
  const { colonyId } = await chats.send('How many ants are in a colony?', {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [
      { role: 'researcher', model: 'mock/researcher' },
      { role: 'writer', model: 'mock/writer' },
    ],
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(seen.tools).toContain('ask_crewmate')
  expect(names(seen.system ?? '').map(([role]) => role)).toEqual(['researcher', 'writer'])
  // A crewmate opens with its job alone: not the person's request, not a mail to answer.
  expect(JSON.stringify(seen.job)).toBe(
    JSON.stringify([{ type: 'text', text: 'Find how many ants live in a typical colony.' }]),
  )
  // The answer came back as the tool's result, and a crewmate that went quiet is reported, not waited on.
  expect(seen.results).toContain('answered:\\nTypically 300,000 ants.')
  expect(seen.results).toContain('stopped without answering')
  const joined = Object.values(s.agents).filter((a) => a.info.role === 'worker')
  expect(joined.map((a) => a.info.specialty).sort()).toEqual(['researcher', 'writer'])
  // Crewmates answer the lead, never the person.
  for (const a of joined) expect(a.info.tools).not.toContain('reply_user')
  expect(s.chatMessages.filter((m) => m.from !== 'lead' && m.from !== 'user')).toEqual([])
  await chats.stopAll()
})

test('ask_crewmate refuses a name not on call, listing who is, and list_agents shows them before they join', async () => {
  const resolver = new ModelResolver()
  const seen: { results?: string } = {}
  // Not a call sign (identity.ts CALL_SIGNS), so the researcher can never be drawn under it.
  scripted(resolver, 'mock/lead', [
    [
      tool('list_agents', {}),
      tool('ask_crewmate', { to: 'bramble', job: 'Write a test for the parser module.' }),
    ],
    (ctx) => {
      seen.results = JSON.stringify(ctx.messages.filter((m) => m.role === 'toolResult'))
      return [tool('reply_user', { text: 'Done.', final: true })]
    },
  ])
  scripted(resolver, 'mock/researcher', [['ok']])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), quietMs: QUIET_MS })
  const { colonyId } = await chats.send('Test the parser', {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [{ role: 'researcher', model: 'mock/researcher' }],
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId)
  const onCall = /\b([a-z]+) \(researcher\) on call/.exec(seen.results ?? '')?.[1]
  expect(onCall).toBeDefined()
  expect(seen.results).toContain(`bramble is not one of your crewmates on call`)
  expect(seen.results).toContain(`${onCall} (researcher)`)
  // Nobody joined under the unknown name, or at all.
  expect(Object.values(s.agents).map((a) => a.info.name)).toEqual(['lead'])
  await chats.stopAll()
})

test('a round that took real work is reviewed for a skill; kept, it is learned, and /learn can improve it', async () => {
  const { SkillLibrary } = await import('../src/skills.ts')
  const { SkillProposalStore, parseReview } = await import('../src/skill-learning.ts')
  expect(parseReview('{"skip": true}')).toBeUndefined()
  expect(() => parseReview('{"name": "Bad Name", "description": "x", "body": "y"}')).toThrow('lowercase')
  const skills = new SkillLibrary(home, join(home, 'no-claude-skills'))
  const skillProposals = new SkillProposalStore(home)
  const resolver = new ModelResolver()
  let reviews = 0
  const body =
    '## Steps\n1. Read the CSV header first.\n2. Convert dates to ISO before grouping.\n## Pitfalls\n- Excel dates.'
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      if (ctx.systemPrompt?.join('\n').includes('You review a finished piece of work')) {
        reviews++
        // The second review (/learn) sees the skill it learned and improves it.
        const asked = JSON.stringify(ctx.messages).includes('csv-date-report')
        return {
          content: [
            JSON.stringify({
              name: 'csv-date-report',
              description:
                'Build a report from a CSV with dates: read the header, normalise dates, then group.',
              body: asked ? `${body}\n- Time zones: convert to UTC.` : body,
              why: 'Dates broke the first two attempts.',
            }),
          ],
        }
      }
      const calls = ctx.messages.filter((m) => m.role === 'toolResult').length
      // A round with real work: 21 tool calls, then the answer.
      if (calls < 21) return { content: [tool('update_todo', { items: [{ text: `step ${calls}` }] })] }
      return { content: [tool('reply_user', { text: 'Report done.', final: true })] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), skills, skillProposals })
  const { chatId, colonyId } = await chats.send('Make a report from sales.csv', {
    ...solo('mock/lead'),
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId, (x) => Object.keys(x.skillProposals).length > 0)
  const proposal = Object.values(s.skillProposals)[0]
  expect(proposal).toMatchObject({ name: 'csv-date-report', why: 'Dates broke the first two attempts.' })
  expect(skillProposals.list('proposed')).toHaveLength(1)

  // Kept with the person's edit: it is written as a learned skill every chat can use.
  await chats.decideSkill(proposal?.id ?? '', true, { body: `${body}\n- Keep the original column order.` })
  expect(skills.learned().map((l) => l.name)).toEqual(['csv-date-report'])
  expect(skills.read('csv-date-report')).toContain('Keep the original column order.')
  expect(skillProposals.list('kept')).toHaveLength(1)
  expect((await waitFor(colonyId, (x) => x.skillProposals[proposal?.id ?? '']?.kept === true)).status).toBe(
    'completed',
  )

  // Asked (/learn): the reviewer proposes an update to the skill it learned, shown against what it says now.
  const update = await chats.learnNow(chatId)
  expect(update?.update?.body).toContain('Keep the original column order.')
  expect(update?.body).toContain('Time zones')
  expect(reviews).toBe(2)
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
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), quietMs: QUIET_MS })
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
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), quietMs: QUIET_MS })
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
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), quietMs: QUIET_MS })
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
    const me = /You are "([a-z]+)", an agent/.exec(system)?.[1] ?? '?'
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
        tool('message', {
          to: 'team',
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
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), quietMs: QUIET_MS })
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

test('a new message starts the lead at once: one agent with every tool, sizing the work itself', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [[tool('reply_user', { text: '4', final: true })]])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver })
  const { colonyId } = await chats.send('What is 2+2?', {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [{ role: 'researcher', model: 'mock/lead' }],
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId)
  expect(s.tier).toBe('solo')
  expect(Object.keys(s.agents)).toEqual(['lead'])
  expect(s.agents.lead?.info.tools).toContain('shell')
  expect(s.agents.lead?.info.tools).toContain('escalate')
  expect(s.chatMessages.at(-1)?.text).toBe('4')
  await chats.stopAll()
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

test("the speaker's reply streams to listeners as it is written, and never into the log", async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [['Let me check.', tool('reply_user', { text: 'It is 4.', final: true })]])
  const chats = new ChatService(runtime, { resolver, classify: fixed('answer') })
  const seen: { colonyId: string; agent: string; text: string; done: boolean; plain: boolean }[] = []
  const stop = chats.onStream((colonyId, agent, text, done, plain) =>
    seen.push({ colonyId, agent, text, done, plain }),
  )
  const { colonyId } = await chats.send('What is 2+2?', solo('mock/lead'))
  const s = await waitFor(colonyId)
  stop()
  expect(s.chatMessages.at(-1)?.text).toBe('It is 4.')
  // The reply_user text is what streams, not the words around the call.
  expect(seen.filter((x) => !x.done).map((x) => x.text)).toContain('It is 4.')
  expect(seen.at(-1)).toMatchObject({ colonyId, agent: 'lead', text: 'It is 4.', done: true, plain: false })
  expect((await events(colonyId)).some((e) => (e.type as string).includes('stream'))).toBe(false)
})

test('text written before a tool call streams as plain, so a voice call can tell it from the answer', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [
    ['Let me look.', tool('append_note', { text: 'checked', section: 'notes' })],
    ['It is 4, as the notes say.'],
  ])
  const chats = new ChatService(runtime, { resolver, classify: fixed('answer') })
  const seen: { text: string; done: boolean; plain: boolean }[] = []
  const stop = chats.onStream((_c, _a, text, done, plain) => seen.push({ text, done, plain }))
  const { colonyId } = await chats.send('What is 2+2?', solo('mock/lead'))
  const s = await waitFor(colonyId)
  stop()
  expect(s.chatMessages.at(-1)?.text).toBe('It is 4, as the notes say.')
  expect(seen).toContainEqual({ text: 'Let me look.', done: true, plain: true })
  expect(s.chatMessages.some((m) => m.text === 'Let me look.')).toBe(false)
})

test('a round left running by a Myrmidon that is gone is stopped, and the chat takes messages again', async () => {
  // The first process: its lead is mid-call when the process "dies".
  // Its model never answers: a dead process writes nothing more.
  const gate = new Promise<void>(() => {})
  const first = new ModelResolver()
  const slow = createMockModel({
    handler: async () => {
      await gate
      return { content: ['late'] }
    },
  })
  first.register('mock/slow', { model: slow.model, streamFn: slow.stream })
  const gone = new ChatService(runtime, { resolver: first, classify: fixed('solo') })
  const { chatId, colonyId } = await gone.send('a long job', solo('mock/slow'))
  await waitFor(colonyId, (s) => s.status === 'running')
  // It was waiting on the person when it died.
  await runtime.ctx.log.appendOne(colonyId as never, {
    type: 'approval/requested',
    actor: { kind: 'agent', id: 'lead' },
    payload: { id: 'approval-gone', agent: 'lead', tool: 'shell', summary: 'ls' },
  })
  const dead = Bun.spawn(['true'])
  await dead.exited
  writeFileSync(join(home, 'runs', colonyId), String(dead.pid))

  // The next process finds the round still "running" in the log, with nobody running it.
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [[tool('reply_user', { text: 'Picked up.', final: true })]])
  const chats = new ChatService(runtime, { resolver, classify: fixed('answer') })
  const listed = (await chats.list()).find((c) => c.chatId === chatId)
  expect(listed?.status).toBe('stopped')
  const stopped = (await events(colonyId)).findLast((e) => e.type === 'colony/stopped')
  expect((stopped?.payload as EventPayloads['colony/stopped'] | undefined)?.reason).toContain('restarted')
  expect(existsSync(join(home, 'runs', colonyId))).toBe(false)
  // What it asked can no longer be answered: closed as stopped, so no card offers buttons that do nothing.
  const closed = (await events(colonyId)).find((e) => e.type === 'approval/decided')
  expect(closed?.payload).toMatchObject({ id: 'approval-gone', approved: false, by: 'stopped' })

  const next = await chats.send('carry on', solo('mock/lead'), chatId)
  expect(next.started).toBe(true)
  const s = await waitFor(colonyId)
  expect(s.chatMessages.at(-1)?.text).toBe('Picked up.')
})

test("the chat list tells a running round's waiting approval, so a call can open with it", async () => {
  const gate = new Promise<void>(() => {})
  const resolver = new ModelResolver()
  const slow = createMockModel({
    handler: async () => {
      await gate
      return { content: ['late'] }
    },
  })
  resolver.register('mock/slow', { model: slow.model, streamFn: slow.stream })
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { chatId, colonyId } = await chats.send('a long job', solo('mock/slow'))
  await waitFor(colonyId, (s) => s.status === 'running')
  const approving = async () => (await chats.list()).find((c) => c.chatId === chatId)?.approving
  expect(await approving()).toBeUndefined()
  const decide = async (
    type: 'approval/requested' | 'approval/decided',
    payload: Record<string, unknown>,
  ) => {
    await runtime.ctx.log.appendOne(colonyId as never, {
      type,
      actor:
        type === 'approval/requested' ? { kind: 'agent', id: 'lead' } : { kind: 'system', id: 'myrmidon' },
      payload: { id: 'approval-1', ...payload } as never,
    })
    await waitFor(
      colonyId,
      (s) => (s.approvals['approval-1']?.decided !== undefined) === (type === 'approval/decided'),
    )
  }
  await decide('approval/requested', { agent: 'lead', tool: 'shell', summary: 'ls' })
  expect(await approving()).toBe(true)
  await decide('approval/decided', { approved: false, by: 'stopped' })
  expect(await approving()).toBeUndefined()
  await chats.stop(chatId)
})

test('a short remark after the final answer is not taken for a second answer', async () => {
  const resolver = new ModelResolver()
  let judged = 0
  const reviewer = createMockModel({
    // A slow review (a project's checks take seconds): its verdict arrives after the lead's turn has ended.
    handler: async () => {
      judged += 1
      await Bun.sleep(150)
      return { content: ['{"score": 0.2, "reasons": "incomplete"}'] }
    },
  })
  resolver.register('mock/judge', { model: reviewer.model, streamFn: reviewer.stream })
  // The review fails, the lead is told to fix it, and its next turn is only a short remark.
  scripted(resolver, 'mock/lead', [
    [tool('reply_user', { text: 'The answer is 4.', final: true })],
    ['Sent.'],
    ['looking'],
  ])
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { colonyId } = await chats.send('What is 2+2?', { ...solo('mock/lead'), judgeModel: 'mock/judge' })
  await waitFor(colonyId, (x) => x.verdicts.some((v) => v.target === 'colony'))
  await Bun.sleep(300)
  const s = foldColony(colonyId, await events(colonyId))
  expect(s.chatMessages.filter((m) => m.from === 'lead').map((m) => m.text)).toEqual(['The answer is 4.'])
  expect(judged).toBe(1)
  await chats.stopAll()
})

test('helpers on "always" start every round as the team; otherwise the lead starts alone', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [[tool('reply_user', { text: 'Hi.', final: true })]])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver })
  const config = {
    mode: 'orchestrated' as const,
    leadModel: 'mock/lead',
    roster: [{ role: 'coder', model: 'mock/lead' }],
    judgeModel: 'mock/judge',
  }
  const alone = await chats.send('hello', config)
  expect((await waitFor(alone.colonyId, (x) => x.tier !== undefined)).tier).toBe('solo')
  await chats.stopAll()
  const team = await chats.send('hello', normalizeTeamConfig({ ...config, helpers: 'always' }))
  const s = await waitFor(team.colonyId, (x) => x.tier !== undefined)
  expect(s.tier).toBe('team')
  expect(Object.keys(s.agents).length).toBeGreaterThan(1)
  await chats.stopAll()
})

test('a chat round starts without test-calling its models first; only credentials are checked', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [[tool('reply_user', { text: 'Hi.', final: true })]])
  judge(resolver)
  const probe = spyOn(resolver, 'probe')
  const credentials = spyOn(resolver, 'requireCredentials')
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { colonyId } = await chats.send('hello', { ...solo('mock/lead'), judgeModel: 'mock/judge' })
  await waitFor(colonyId)
  expect(probe).not.toHaveBeenCalled()
  expect(credentials.mock.calls.map((c) => c[0]).sort()).toEqual(['mock/judge', 'mock/lead'])
  await chats.stopAll()
})

test('a short answer in plain text reaches the person at once, without waiting for a nudge', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [['2 + 2 = 4.']])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { colonyId } = await chats.send('What is 2+2?', { ...solo('mock/lead'), judgeModel: 'mock/judge' })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(s.chatMessages.filter((m) => m.from === 'lead')).toMatchObject([{ final: true, text: '2 + 2 = 4.' }])
  expect(s.agents.lead?.turns).toBe(1)
  await chats.stopAll()
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
            tool('dismiss_crewmate', {
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
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), quietMs: QUIET_MS })
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
  // The colony keeps the dismissed coder in its history; round 2 started without it.
  const started = (await events(second.colonyId)).findLast((e) => e.type === 'round/started')
    ?.payload as EventPayloads['round/started']
  expect(started.agents.map((a) => `${a.name}:${a.specialty ?? a.role}`)).toEqual([
    'lead:lead',
    `${scout}:researcher`,
  ])
  expect(names(r2)).toContain(`${scout}:researcher`)
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
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), quietMs: QUIET_MS })
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

test('agents call MCP tools: read-only ones run at once, others wait for the person, and calls are logged', async () => {
  const { McpHub } = await import('../src/mcp.ts')
  const hub = new McpHub(join(home, 'agent'))
  opened.push(hub)
  await hub.add('echo', { command: 'bun', args: [join(import.meta.dir, 'fixtures', 'echo-mcp.ts')] })
  const echo = hub.tools().find((t) => t.name.endsWith('_echo'))?.name ?? 'missing'
  const shout = hub.tools().find((t) => t.name.endsWith('_shout'))?.name ?? 'missing'
  // The server's read-only mark comes through omp's MCP client.
  expect(hub.readOnly(echo)).toBe(true)
  expect(hub.readOnly(shout)).toBe(false)
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/solo', [
    [tool(echo, { text: 'from the colony' })],
    [tool(shout, { text: 'hi' })],
    [tool('reply_user', { text: 'Echoed and shouted.', final: true })],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), mcp: hub })
  const { colonyId } = await chats.send('Echo something', { ...solo('mock/solo'), judgeModel: 'mock/judge' })
  const waiting = await waitFor(colonyId, (x) => Object.values(x.approvals).some((a) => !a.decided))
  const approvals = Object.values(waiting.approvals)
  expect(approvals.map((a) => a.tool)).toEqual([shout])
  await chats.decideApproval(colonyId, approvals[0]?.id ?? '', true)
  await waitFor(colonyId)
  const results = (await events(colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
  expect(results.find((r) => r.tool === echo)).toMatchObject({ ok: true, output: 'echo: from the colony' })
  expect(results.find((r) => r.tool === shout)).toMatchObject({ ok: true, output: 'HI!' })
  await hub.close()
})

test('fs_edit changes part of a scratch file instead of rewriting it', async () => {
  const resolver = new ModelResolver()
  // A model omp gives exact-text edits (DeepSeek); others edit by hashline anchors (the next test).
  scripted(resolver, 'mock/deepseek-v4', [
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
  const { colonyId } = await chats.send('Make a page', {
    ...solo('mock/deepseek-v4'),
    judgeModel: 'mock/judge',
  })
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

test('fs_edit with hashline anchors edits the lines fs_read showed, and refuses a stale anchor', async () => {
  const resolver = new ModelResolver()
  const tags: string[] = []
  /** The header tag in the conversation's latest tool result, as the model would copy it. */
  const tagIn = (ctx: LlmContext) => {
    const last = ctx.messages.filter((m) => m.role === 'toolResult').at(-1)
    const tag = /\[page\.html#([0-9A-F]{4})\]/.exec(JSON.stringify(last))?.[1]
    if (!tag) throw new Error('no header in the last tool result')
    tags.push(tag)
    return tag
  }
  const input = (tag: string, ops: string) => `[page.html#${tag}]\n${ops}`
  scripted(resolver, 'mock/solo', [
    [tool('fs_write', { path: 'page.html', content: '<h1>Hello</h1>\n<p>draft</p>\n<p>draft</p>\n' })],
    [tool('fs_read', { path: 'page.html' })],
    (ctx) => [
      tool('fs_edit', { path: 'page.html', input: input(tagIn(ctx), 'PUT 1.=1:\n+<h1>Weather</h1>\n') }),
    ],
    // The reply's header carries on: both drafts in one call, on the numbers that header showed.
    (ctx) => [
      tool('fs_edit', {
        path: 'page.html',
        input: input(tagIn(ctx), 'PUT 2.=2:\n+<p>final</p>\nPUT 3.=3:\n+<p>final</p>\n'),
      }),
    ],
    // The first read's tag, on a line changed since: refused.
    () => [tool('fs_edit', { path: 'page.html', input: input(tags[0] ?? '', 'PUT 2.=2:\n+<p>sunny</p>\n') })],
    [tool('publish_artifact', { name: 'page.html', fromScratch: 'page.html' })],
    [tool('reply_user', { text: 'Done.', final: true })],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { colonyId } = await chats.send('Make a page', { ...solo('mock/solo'), judgeModel: 'mock/judge' })
  const s = await waitFor(colonyId)
  const log = await events(colonyId)
  const results = log
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
    .filter((r) => r.tool === 'fs_edit')
  expect(results.map((r) => r.ok)).toEqual([true, true, false])
  expect(results[2]?.output).toContain('Edit rejected for page.html')
  // The person's diff comes with each anchored edit's result.
  expect(results[0]?.change).toEqual({
    before: '<h1>Hello</h1>\n<p>draft</p>\n<p>draft</p>',
    after: '<h1>Weather</h1>\n<p>draft</p>\n<p>draft</p>',
  })
  const blob = s.artifacts['page.html']?.at(-1)?.blob ?? ''
  const { BlobStore } = await import('@myrmidon/core')
  const text = await new BlobStore(join(home, 'colonies', colonyId, 'blobs')).text(blob)
  expect(text).toBe('<h1>Weather</h1>\n<p>final</p>\n<p>final</p>\n')
  expect(new Set(tags).size).toBe(2)
})

test('plan mode presents the plan for approval before any work, and thinking can be set per chat', async () => {
  const resolver = new ModelResolver()
  const prompts: string[] = []
  const plan = '1. Hero with the headline\n2. Three feature sections\n3. Sign-up form'
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      prompts.push(JSON.stringify(ctx.messages))
      return prompts.length === 1
        ? { content: [tool('ask_user', { question: "Here's the plan. OK to proceed?", plan })] }
        : { content: ['Waiting for approval.'] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const config: TeamConfig = { ...solo('mock/lead'), thinking: 'low' }
  const { colonyId } = await chats.send('Make a landing page', config, undefined, { planFirst: true })
  const s = await waitFor(colonyId)
  expect(prompts[0]).toContain('Plan first')
  expect(prompts[0]).toContain('`plan`')
  expect(s.statusReason).toBe('awaiting your reply')
  // The plan itself reaches the person, not just the question about it.
  expect(s.chatMessages.at(-1)).toMatchObject({ question: true, plan })
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
  // The test site stands in for a server the run started: agents reach no other localhost port.
  const browser = new BrowserHub(join(home, 'browser'), undefined, {
    localPorts: () => new Set([site.port as number]),
  })
  opened.push(browser)
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
  // The test site stands in for a server the run started: agents reach no other localhost port.
  const browser = new BrowserHub(join(home, 'browser'), undefined, {
    localPorts: () => new Set([site.port as number]),
  })
  opened.push(browser)
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

// create_tool makes commands too, so it is offered only with the OS sandbox.
test.skipIf(!findChrome() || detectSandbox().kind === 'none')(
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
    // The test site stands in for a server the run started: agents reach no other localhost port.
    const browser = new BrowserHub(join(home, 'browser'), undefined, {
      localPorts: () => new Set([site.port as number]),
    })
    opened.push(browser)
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
  // A real Chrome launch and three model rounds: well past the default 5s on a busy machine.
  60_000,
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
  // The test site stands in for a server the run started: agents reach no other localhost port.
  const browser = new BrowserHub(join(home, 'browser'), undefined, {
    localPorts: () => new Set([site.port as number]),
  })
  opened.push(browser)
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
    // The test site stands in for a server the run started: agents reach no other localhost port.
    const browser = new BrowserHub(join(home, 'browser'), undefined, {
      localPorts: () => new Set([site.port as number]),
    })
    opened.push(browser)
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
    opened.push(browser)
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

test.skipIf(!findChrome())(
  'a published page loads its sibling files (fetch, ES modules) in the agent browser',
  async () => {
    const browser = new BrowserHub(join(home, 'browser'))
    opened.push(browser)
    const resolver = new ModelResolver()
    const page =
      '<!doctype html><title>Ants</title><p id="out">loading</p><script type="module">' +
      "import { label } from './lib/label.js'; const r = await fetch('data.json'); " +
      "document.getElementById('out').textContent = label((await r.json()).count)</script>"
    scripted(resolver, 'mock/solo', [
      [
        tool('publish_artifact', { name: 'data.json', content: '{"count": 300000}' }),
        tool('publish_artifact', {
          name: 'lib/label.js',
          content: "export const label = (n) => n + ' ants'",
        }),
        tool('publish_artifact', { name: 'index.html', content: page }),
      ],
      [tool('browser_open', { url: 'artifact:index.html' })],
      [tool('browser_console', {})],
      [tool('reply_user', { text: 'Tested.', final: true })],
    ])
    judge(resolver)
    const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), browser })
    const { colonyId } = await chats.send('Build an ant counter page', {
      ...solo('mock/solo'),
      judgeModel: 'mock/judge',
    })
    await waitFor(colonyId)
    const results = (await events(colonyId))
      .filter((e) => e.type === 'tool/result')
      .map((e) => e.payload as EventPayloads['tool/result'])
    const page_ = results.find((r) => r.tool === 'browser_open')
    expect(page_?.output).toContain('300000 ants')
    // Served from the colony's own origin, not from the person's disk.
    expect(page_?.output).toContain('.artifacts.localhost/index.html')
    expect(page_?.output).not.toContain('file://')
    expect(results.find((r) => r.tool === 'browser_console')?.output).not.toContain('CORS')
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
  // The chat list tells a failed model apart from an ordinary stop.
  expect((await chats.list()).find((c) => c.chatId === chatId)?.failed).toBe(true)

  await chats.resume(chatId, 'mock/backup')
  const done = await waitFor(colonyId, (st) => st.status === 'completed')
  expect((await chats.list()).find((c) => c.chatId === chatId)?.failed).toBeUndefined()
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

test('a context the provider calls too long is folded and retried once, then pauses with the sizes', async () => {
  const resolver = new ModelResolver()
  const seen: string[] = []
  const tight = createMockModel({
    contextWindow: 8_000,
    handler: (ctx: LlmContext) => {
      const text = JSON.stringify(ctx.messages)
      seen.push(text)
      if (/summar/i.test(JSON.stringify(ctx.systemPrompt ?? ''))) return { content: ['Wrote notes.md.'] }
      if (seen.length === 1)
        return { content: [tool('fs_write', { path: 'notes.md', content: 'x'.repeat(12_000) })] }
      if (!text.includes('Summary of your earlier work'))
        return { stopReason: 'error', errorMessage: 'prompt is too long: 9000 tokens > 8000 maximum' }
      return { content: [tool('reply_user', { text: 'Done after folding.', final: true })] }
    },
  })
  resolver.register('mock/tight', { model: tight.model, streamFn: tight.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { colonyId } = await chats.send('Write the notes', {
    ...solo('mock/tight'),
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(s.modelError).toBeUndefined()
  expect((await events(colonyId)).some((e) => e.type === 'agent/compacted')).toBe(true)

  // With nothing left to fold, the round pauses and says how big the conversation is against the window.
  const stuck = createMockModel({
    contextWindow: 8_000,
    handler: () => ({ stopReason: 'error', errorMessage: 'prompt is too long: 9000 tokens > 8000 maximum' }),
  })
  resolver.register('mock/stuck', { model: stuck.model, streamFn: stuck.stream })
  const second = await chats.send('Answer me', { ...solo('mock/stuck'), judgeModel: 'mock/judge' })
  const paused = await waitFor(second.colonyId)
  expect(paused.status).toBe('stopped')
  expect(paused.statusReason).toContain('ran out of context')
  expect(paused.modelError).toMatchObject({ agent: 'lead', kind: 'overflow', window: 8_000 })
  expect(paused.modelError?.tokens).toBeGreaterThan(0)
})

/** A model that always fails with `errorMessage`, counting its calls. */
function failing(resolver: ModelResolver, ref: string, errorMessage: string, window?: number) {
  const calls = { n: 0 }
  const m = createMockModel({
    ...(window ? { contextWindow: window } : {}),
    handler: () => {
      calls.n += 1
      return { stopReason: 'error', errorMessage }
    },
  })
  resolver.register(ref, { model: m.model, streamFn: m.stream })
  return calls
}

async function withFallbacks(team: { leadFallbacks?: string[]; workerFallbacks?: string[] }) {
  const { SettingsStore } = await import('../src/settings.ts')
  const settings = new SettingsStore(home)
  settings.set({ ...settings.get(), team: { ...settings.get().team, ...team } })
  return settings
}

const fallbacksOf = async (colonyId: string) =>
  (await events(colonyId))
    .filter((e) => e.type === 'agent/fallback')
    .map((e) => e.payload as EventPayloads['agent/fallback'])

test('a lead whose model fails goes on with its first fallback that has credentials, and the round completes', async () => {
  const resolver = new ModelResolver()
  const primary = failing(resolver, 'mock/primary', '401 Unauthorized: the sign-in has expired')
  const seen: string[] = []
  const backup = createMockModel({
    handler: (ctx: LlmContext) => {
      seen.push(JSON.stringify(ctx.messages))
      return { content: [tool('reply_user', { text: 'Done on the backup.', final: true })] }
    },
  })
  resolver.register('mock/backup', { model: backup.model, streamFn: backup.stream })
  judge(resolver)
  // A model the resolver does not know is skipped, as one removed from the provider list would be.
  const settings = await withFallbacks({ leadFallbacks: ['mock/gone', 'mock/backup'] })
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), settings })
  const { colonyId } = await chats.send('Answer me', { ...solo('mock/primary'), judgeModel: 'mock/judge' })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(s.modelError).toBeUndefined()
  // Not a transient failure: no retries on the failing model before it moves on.
  expect(primary.n).toBe(1)
  expect(await fallbacksOf(colonyId)).toEqual([
    {
      agent: 'lead',
      model: 'mock/backup',
      previous: 'mock/primary',
      kind: 'error',
      message: '401 Unauthorized: the sign-in has expired',
    },
  ])
  expect(s.agents.lead?.info.model).toBe('mock/backup')
  expect(s.agents.lead?.fellBackFrom).toBe('mock/primary')
  expect(seen[0]).not.toContain('Unauthorized')
})

test('a transient failure is retried on the same model before the fallback takes over', async () => {
  const resolver = new ModelResolver()
  const primary = failing(resolver, 'mock/busy', 'Overloaded: the server is temporarily busy')
  scripted(resolver, 'mock/backup', [[tool('reply_user', { text: 'Answered.', final: true })]])
  judge(resolver)
  const settings = await withFallbacks({ leadFallbacks: ['mock/backup'] })
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), settings })
  const { colonyId } = await chats.send('Answer me', { ...solo('mock/busy'), judgeModel: 'mock/judge' })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  // The first call and MODEL_RETRIES (2) retries.
  expect(primary.n).toBe(3)
  expect((await fallbacksOf(colonyId)).map((f) => f.model)).toEqual(['mock/backup'])
}, 20_000)

test('a request over the per-minute limit, or a retired model, is not retried and says why', async () => {
  const resolver = new ModelResolver()
  // Groq's 413 and 400 as they came back (organization id left out).
  const tooBig = failing(
    resolver,
    'mock/tpm',
    '413 Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 13557, please reduce your message size and try again. (type=tokens param=rate_limit_exceeded)',
  )
  const retired = failing(
    resolver,
    'mock/retired',
    '400 The model `llama3-70b-8192` has been decommissioned and is no longer supported. (type=invalid_request_error param=model_decommissioned)',
  )
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const first = await chats.send('Answer me', { ...solo('mock/tpm'), judgeModel: 'mock/judge' })
  const paused = await waitFor(first.colonyId)
  expect(tooBig.n).toBe(1)
  expect(paused.modelError).toMatchObject({ kind: 'error', cause: 'per-minute', limit: 8000, tokens: 13557 })
  const second = await chats.send('Answer me', { ...solo('mock/retired'), judgeModel: 'mock/judge' })
  const stopped = await waitFor(second.colonyId)
  expect(retired.n).toBe(1)
  expect(stopped.modelError).toMatchObject({ kind: 'error', cause: 'retired' })
})

test('a per-minute limit one request fits under is still waited out', () => {
  const m = {
    role: 'assistant',
    stopReason: 'error',
    errorMessage: 'Rate limit reached on tokens per min (TPM): Limit 8000, Used 7000, Requested 1500.',
  } as AssistantMessage
  expect(classifyModelError(m)).toEqual({ kind: 'error', message: m.errorMessage as string, transient: true })
})

test("a swarm's peer falls back on the crew's chain, not the lead's", async () => {
  const resolver = new ModelResolver()
  failing(resolver, 'mock/peer', '404 model not found')
  scripted(resolver, 'mock/crew-backup', [[tool('reply_user', { text: 'Peer answer.', final: true })]])
  judge(resolver)
  const settings = await withFallbacks({
    leadFallbacks: ['mock/lead-backup'],
    workerFallbacks: ['mock/crew-backup'],
  })
  const chats = new ChatService(runtime, { resolver, classify: fixed('answer'), settings })
  const { colonyId } = await chats.send('Answer me', {
    mode: 'swarm',
    leadModel: 'mock/peer',
    roster: [{ role: 'peer', model: 'mock/peer' }],
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect((await fallbacksOf(colonyId)).map((f) => f.model)).toEqual(['mock/crew-backup'])
})

test('without fallbacks, or once they fail too, the round pauses on the error as before', async () => {
  const resolver = new ModelResolver()
  failing(resolver, 'mock/primary', '401 Unauthorized')
  failing(resolver, 'mock/backup', '403 Forbidden')
  judge(resolver)
  const bare = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const first = await bare.send('Answer me', { ...solo('mock/primary'), judgeModel: 'mock/judge' })
  const paused = await waitFor(first.colonyId)
  expect(paused.statusReason).toBe('model failed: lead on mock/primary')
  expect(await fallbacksOf(first.colonyId)).toEqual([])

  const settings = await withFallbacks({ leadFallbacks: ['mock/backup'] })
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), settings })
  const second = await chats.send('Answer me', { ...solo('mock/primary'), judgeModel: 'mock/judge' })
  const stopped = await waitFor(second.colonyId)
  // The last model tried is the one named; the primary failed too recently to be tried again.
  expect(stopped.statusReason).toBe('model failed: lead on mock/backup')
  expect((await fallbacksOf(second.colonyId)).map((f) => f.model)).toEqual(['mock/backup'])
})

test('a conversation too long for the model never falls back: folding it is the remedy, then the round pauses', async () => {
  const resolver = new ModelResolver()
  failing(resolver, 'mock/stuck', 'prompt is too long: 9000 tokens > 8000 maximum', 8_000)
  scripted(resolver, 'mock/backup', [['should not run']])
  judge(resolver)
  const settings = await withFallbacks({ leadFallbacks: ['mock/backup'] })
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), settings })
  const { colonyId } = await chats.send('Answer me', { ...solo('mock/stuck'), judgeModel: 'mock/judge' })
  const s = await waitFor(colonyId)
  expect(s.statusReason).toContain('ran out of context')
  expect(await fallbacksOf(colonyId)).toEqual([])
})

test('a chat in a project works in that folder, follow-ups stay in it, and a round can be rewound', async () => {
  const { ProjectStore } = await import('../src/projects.ts')
  const { Checkpoints } = await import('../src/checkpoints.ts')
  const checkpoints = new Checkpoints(join(home, 'checkpoints'))
  const folder = mkdtempSync(join(tmpdir(), 'myr-project-'))
  await Bun.write(join(folder, 'README.md'), '# Demo project')
  const projects = new ProjectStore(home)
  // Autonomous, as a folder added before new ones started on ask.
  const project = projects.setPermissions(projects.add(folder).id, { mode: 'auto', allow: [] })
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
  // The read and write in one step finish in either order; the read outside the folder is refused.
  expect(results.find((r) => r.tool === 'fs_read' && !r.ok)?.output).toContain('outside your project')
  expect(s.chat?.project?.id).toBe(project.id)

  const second = await chats.send('And now?', config, first.chatId)
  const s2 = await waitFor(second.colonyId)
  expect(s2.chat?.project?.path).toBe(project.path)
  expect((await chats.list()).find((c) => c.chatId === first.chatId)?.project?.name).toBe(project.name)

  // Each round is snapshotted at its start and end: its changes are the diff, and rewinding undoes them.
  // Both rounds ran in one colony; each keeps its own snapshots.
  expect(second.colonyId).toBe(first.colonyId)
  await waitFor(first.colonyId, (x) => x.rounds.length === 2 && x.rounds.every((r) => r.checkpoints.end))
  const changes = await chats.changes(first.colonyId, 1)
  expect(changes.files).toEqual([{ path: 'src/hello.ts', status: 'A', added: 1, removed: 0 }])
  expect((await chats.changes(first.colonyId, 2)).files).toEqual([])
  // Work done after the round, by the person or anyone else, is not the round's to undo: an unrelated file stays,
  // and a file the round wrote that changed since is left alone and reported unless the person insists.
  await Bun.write(join(folder, 'NOTES.md'), 'written after the round\n')
  await Bun.write(join(folder, 'src', 'hello.ts'), 'export const hi = 2\n')
  expect(await chats.rewind(first.colonyId, false, 1)).toEqual({ changed: 0, skipped: ['src/hello.ts'] })
  expect(await Bun.file(join(folder, 'src', 'hello.ts')).text()).toBe('export const hi = 2\n')
  expect(await chats.rewind(first.colonyId, false, 1, true)).toEqual({ changed: 1, skipped: [] })
  expect(existsSync(join(folder, 'src', 'hello.ts'))).toBe(false)
  expect(await Bun.file(join(folder, 'README.md')).text()).toBe('# Demo project')
  expect(await Bun.file(join(folder, 'NOTES.md')).text()).toBe('written after the round\n')
  // Undoing the rewind puts back exactly the files it changed.
  await chats.rewind(first.colonyId, true, 1)
  expect(await Bun.file(join(folder, 'src', 'hello.ts')).text()).toBe('export const hi = 2\n')
  expect(await Bun.file(join(folder, 'NOTES.md')).text()).toBe('written after the round\n')
  rmSync(folder, { recursive: true, force: true })
})

test.skipIf(detectSandbox().kind === 'none')(
  "what commands cache under HOME stays out of the agent's file listing",
  async () => {
    const resolver = new ModelResolver()
    scripted(resolver, 'mock/lead', [
      [tool('shell', { command: 'mkdir -p "$HOME/.npm/_cacache" && touch "$HOME/.npm/_cacache/x" out.txt' })],
      [tool('fs_list', {})],
      [tool('reply_user', { text: 'Done.', final: true })],
    ])
    judge(resolver)
    const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
    const { colonyId } = await chats.send('Make out.txt', { ...solo('mock/lead'), judgeModel: 'mock/judge' })
    await waitFor(colonyId)
    const listed = (await events(colonyId))
      .map((e) => e.payload as EventPayloads['tool/result'])
      .find((p) => p.tool === 'fs_list' && p.ok !== undefined)
    expect(listed?.output).toContain('out.txt')
    expect(listed?.output).not.toContain('.npm')
  },
)

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
    // Autonomous, as a folder added before new ones started on ask.
    const project = projects.setPermissions(projects.add(folder).id, { mode: 'auto', allow: [] })
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
  'run_checks runs commands, so it asks under Ask like shell, and runs nothing the person declines',
  async () => {
    const { ProjectStore } = await import('../src/projects.ts')
    const folder = mkdtempSync(join(tmpdir(), 'myr-checks-ask-'))
    await Bun.write(
      join(folder, 'package.json'),
      JSON.stringify({ scripts: { test: 'touch ran.txt', lint: 'echo lint ok' } }),
    )
    await Bun.write(join(folder, 'bun.lock'), '')
    const projects = new ProjectStore(home)
    const project = projects.setPermissions(projects.add(folder).id, { preset: 'ask', rules: [] })
    const resolver = new ModelResolver()
    scripted(resolver, 'mock/checker', [
      [tool('run_checks', {})],
      [tool('reply_user', { text: 'Not run.', final: true })],
    ])
    judge(resolver)
    const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), projects })
    const { colonyId } = await chats.send(
      'Check the project',
      { ...solo('mock/checker'), judgeModel: 'mock/judge' },
      undefined,
      { project: project.id },
    )
    const waiting = await waitFor(colonyId, (x) => Object.values(x.approvals).some((a) => !a.decided))
    const card = Object.values(waiting.approvals).find((a) => !a.decided)
    expect(card).toMatchObject({ tool: 'run_checks', summary: 'bun run lint && bun run test' })
    await chats.decideApproval(colonyId, card?.id ?? '', false)
    await waitFor(colonyId)
    const result = (await events(colonyId))
      .filter((e) => e.type === 'tool/result')
      .map((e) => e.payload as EventPayloads['tool/result'])[0]
    expect(result?.ok).toBe(false)
    expect(existsSync(join(folder, 'ran.txt'))).toBe(false)
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
    // Autonomous, as a folder added before new ones started on ask.
    const project = projects.setPermissions(projects.add(folder).id, { mode: 'auto', allow: [] })
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

test('review cards: the person sees a change in full and may rewrite it; an approved call never runs twice', async () => {
  const { ProjectStore } = await import('../src/projects.ts')
  const { git } = await import('../src/git.ts')
  const folder = mkdtempSync(join(tmpdir(), 'myr-review-'))
  writeFileSync(join(folder, 'notes.txt'), 'one\ntwo\n')
  await git(folder, ['init', '-q'])
  await git(folder, ['config', 'user.email', 'test@example.com'])
  await git(folder, ['config', 'user.name', 'Test'])
  await git(folder, ['add', '--all'])
  await git(folder, ['commit', '-q', '-m', 'start'])
  const projects = new ProjectStore(home)
  const project = projects.add(folder)
  projects.setPermissions(project.id, { mode: 'ask', allow: [] })
  const resolver = new ModelResolver()
  const write = tool('fs_write', { path: join(folder, 'notes.txt'), content: 'one\nTWO\n' })
  scripted(resolver, 'mock/careful', [
    [write],
    // The same call again (a retry): the approved write already ran, so it is not asked for or run again.
    [write],
    [tool('propose', { kind: 'commit', message: 'Shout two', why: 'Save the change' })],
    [tool('propose', { kind: 'file', path: 'draft.md', content: 'hello', why: 'A first draft' })],
    [tool('reply_user', { text: 'Done.', final: true })],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), projects })
  const { colonyId } = await chats.send(
    'Tidy notes',
    { ...solo('mock/careful'), judgeModel: 'mock/judge' },
    undefined,
    { project: project.id },
  )
  const pending = async () => {
    const s = await waitFor(colonyId, (x) => Object.values(x.approvals).some((a) => !a.decided))
    return Object.values(s.approvals).find((a) => !a.decided)
  }
  const file = await pending()
  expect(file?.review).toMatchObject({ kind: 'file', title: 'Write notes.txt' })
  expect(file?.review?.fields[0]).toMatchObject({
    before: 'one\ntwo\n',
    value: 'one\nTWO\n',
    editable: true,
  })
  await chats.decideApproval(colonyId, file?.id ?? '', true, { edits: { content: 'one\nTwo!\n' } })

  const commit = await pending()
  expect(commit?.review?.kind).toBe('commit')
  expect(commit?.summary).toBe('Save the change')
  expect(commit?.review?.fields.find((f) => f.key === 'patch')?.value).toContain('+Two!')
  await chats.decideApproval(colonyId, commit?.id ?? '', true, { edits: { message: 'Make two louder' } })

  const draft = await pending()
  expect(draft?.review?.title).toBe('Write draft.md')
  await chats.decideApproval(colonyId, draft?.id ?? '', false, { note: 'Not now' })

  const s = await waitFor(colonyId)
  const results = (await events(colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
  expect(readFileSync(join(folder, 'notes.txt'), 'utf8')).toBe('one\nTwo!\n')
  expect(results[0]?.output).toContain('edited this before approving')
  expect(results[1]).toMatchObject({ ok: true })
  expect(results[1]?.output).toStartWith('Already done')
  expect((await git(folder, ['log', '-1', '--format=%s'])).trim()).toBe('Make two louder')
  expect(results[3]?.output).toContain('They said: Not now')
  expect(existsSync(join(folder, 'draft.md'))).toBe(false)
  expect(Object.values(s.approvals)).toHaveLength(3)
  rmSync(folder, { recursive: true, force: true })
})

// Changed with the permission model: the card's "Allow all file changes in this chat" (a chat grant) is now a rule
// remembered at the chat's level, and chat grants already in a chat's log read as such rules.
test('allowing all file changes for a chat approves the waiting one and later ones, there only, until taken back', async () => {
  const { ProjectStore } = await import('../src/projects.ts')
  const folder = mkdtempSync(join(tmpdir(), 'myr-grant-'))
  const projects = new ProjectStore(home)
  const project = projects.setPermissions(projects.add(folder).id, { preset: 'ask', rules: [] })
  const resolver = new ModelResolver()
  const writes = (ref: string, ...files: string[]) =>
    scripted(resolver, ref, [
      ...files.map((f) => [tool('fs_write', { path: f, content: f })]),
      [tool('reply_user', { text: 'Done.', final: true })],
    ])
  judge(resolver)
  const config = (model: string) => ({ ...solo(model), judgeModel: 'mock/judge' })
  const asked = (colonyId: string) =>
    waitFor(colonyId, (x) => Object.values(x.approvals).some((a) => !a.decided))
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), projects })

  writes('mock/a1', 'a.txt', 'b.txt')
  const a = await chats.send('Write two files', config('mock/a1'), undefined, { project: project.id })
  const waiting = Object.values((await asked(a.colonyId)).approvals)
  expect(waiting.map((x) => [x.summary, x.offer])).toEqual([['write a.txt', [{ kind: 'edit', target: '*' }]]])
  expect(waiting[0]?.why).toEqual({ by: 'preset', scope: 'project', preset: 'ask' })
  // One click: the waiting write goes ahead, and so does the next without a card.
  const allowEdits = { kind: 'edit', target: '*', decision: 'allow' } as const
  await chats.remember(a.colonyId, 'chat', [allowEdits])
  expect(await chats.chatPermissions(a.chatId)).toEqual({ rules: [allowEdits] })
  const done = await waitFor(a.colonyId)
  expect(done.status).toBe('completed')
  expect(Object.values(done.approvals).map((x) => x.decided?.approved)).toEqual([true])
  expect(readFileSync(join(folder, 'b.txt'), 'utf8')).toBe('b.txt')

  // Another chat in the same project still asks.
  writes('mock/b1', 'c.txt')
  const b = await chats.send('Write c', config('mock/b1'), undefined, { project: project.id })
  const other = Object.values((await asked(b.colonyId)).approvals)
  expect(other.map((x) => x.summary)).toEqual(['write c.txt'])
  await chats.decideApproval(b.colonyId, other[0]?.id ?? '', false)
  await waitFor(b.colonyId)

  // After a restart (a new service reading the logs) the chat keeps it, and lists it.
  const again = new ChatService(runtime, { resolver, classify: fixed('solo'), projects })
  expect((await again.list()).find((c) => c.chatId === a.chatId)?.permissions).toEqual({
    rules: [allowEdits],
  })
  expect((await again.list()).find((c) => c.chatId === b.chatId)?.permissions).toBeUndefined()
  // A chat grant from before the permission model reads as the same kind of rule.
  await runtime.ctx.log.appendOne(b.colonyId as never, {
    type: 'chat/allowed',
    actor: { kind: 'user', id: 'user' },
    payload: { grants: ['command'] },
  })
  expect((await again.list()).find((c) => c.chatId === b.chatId)?.permissions).toEqual({
    rules: [{ kind: 'command', target: '*', decision: 'allow' }],
  })
  // A file the lead proposes is a file change too: allowed, it lands without a card.
  scripted(resolver, 'mock/a2', [
    [tool('fs_write', { path: 'd.txt', content: 'd.txt' })],
    [tool('propose', { kind: 'file', why: 'Add f', path: 'f.txt', content: 'f' })],
    [tool('reply_user', { text: 'Done.', final: true })],
  ])
  const next = await again.send('One more', config('mock/a2'), a.chatId)
  const s2 = await waitFor(next.colonyId, (x) => x.rounds.length === 2 && x.status !== 'running')
  expect(s2.status).toBe('completed')
  expect(Object.values(s2.approvals)).toHaveLength(1)
  expect(existsSync(join(folder, 'd.txt'))).toBe(true)
  expect(readFileSync(join(folder, 'f.txt'), 'utf8')).toBe('f')

  // Taken back, the next write asks again.
  expect(await again.setChatPermissions(a.chatId, { rules: [] })).toEqual({ rules: [] })
  writes('mock/a3', 'e.txt')
  const last = await again.send('And another', config('mock/a3'), a.chatId)
  const s3 = await waitFor(
    last.colonyId,
    (x) => x.rounds.length === 3 && Object.values(x.approvals).some((p) => !p.decided),
  )
  expect(Object.values(s3.approvals).filter((p) => !p.decided)[0]?.summary).toBe('write e.txt')
  await again.stopAll()
  rmSync(folder, { recursive: true, force: true })
})

// The card is for a shell command, and shell needs the OS sandbox.
test.skipIf(detectSandbox().kind === 'none')(
  'a new chat can start on its own preset, chosen before its first message',
  async () => {
    const resolver = new ModelResolver()
    scripted(resolver, 'mock/own', [
      [tool('shell', { command: 'bun test' })],
      [tool('reply_user', { text: 'Done.', final: true })],
    ])
    judge(resolver)
    const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
    const { chatId, colonyId } = await chats.send(
      'Run the tests',
      { ...solo('mock/own'), judgeModel: 'mock/judge' },
      undefined,
      { permissions: { preset: 'ask', rules: [] } },
    )
    // Ask: a command that does more than look waits, where Auto (the default) would have run it.
    const s = await waitFor(colonyId, (x) => Object.values(x.approvals).some((a) => !a.decided))
    const waiting = Object.values(s.approvals).find((a) => !a.decided)
    expect(waiting).toMatchObject({ tool: 'shell', why: { by: 'preset', scope: 'chat', preset: 'ask' } })
    expect(await chats.chatPermissions(chatId)).toEqual({ preset: 'ask', rules: [] })
    await chats.decideApproval(colonyId, waiting?.id ?? '', false)
    await waitFor(colonyId)
    await chats.stopAll()
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
    // Each part must be allowed: `echo` is, `touch` is not. The card offers the part's prefix to remember.
    expect(first).toMatchObject({
      tool: 'shell',
      summary: 'echo chained && touch chained.txt',
      offer: [
        { kind: 'command', target: 'echo' },
        { kind: 'command', target: 'touch' },
        { kind: 'command', target: '*' },
      ],
    })
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
    const done = await waitFor(next.colonyId)
    const from = done.rounds.at(-1)?.startSeq ?? 0
    const after = (await events(next.colonyId))
      .filter((e) => e.type === 'tool/result' && e.seq > from)
      .map((e) => e.payload as EventPayloads['tool/result'])
    expect(after[0]?.output).toContain('is read-only for agents')
    expect(after[1]?.output).not.toMatch(/^exit 0/)
    expect(existsSync(join(folder, 'nope.txt'))).toBe(false)
    expect(existsSync(join(folder, 'sneaky.txt'))).toBe(false)
    rmSync(folder, { recursive: true, force: true })
  },
)

test('team workers in a git project each get a worktree, and their changes merge into the folder', async () => {
  const { ProjectStore } = await import('../src/projects.ts')
  const folder = mkdtempSync(join(tmpdir(), 'myr-project-'))
  await Bun.write(join(folder, 'README.md'), '# Demo\n')
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: folder }).stdout.toString()
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  const projects = new ProjectStore(home)
  // Autonomous, as a folder added before new ones started on ask.
  const project = projects.setPermissions(projects.add(folder).id, { mode: 'auto', allow: [] })
  const resolver = new ModelResolver()
  const specialist = (ctx: LlmContext, role: string) =>
    new RegExp(`- ([a-z]+): ${role} \\(`).exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''
  scripted(resolver, 'mock/lead', [
    (ctx) => [
      tool('create_task', { subject: 'Write the API', assignee: specialist(ctx, 'backend') }),
      tool('create_task', { subject: 'Write the page', assignee: specialist(ctx, 'frontend') }),
    ],
    ['waiting'],
    ['waiting'],
    [tool('reply_user', { text: 'Both parts are in.', final: true })],
  ])
  const coder = (file: string): Step[] => [
    (ctx) => [
      tool('claim_task', {
        id: /task-\d/.exec(JSON.stringify(ctx.messages))?.[0] ?? 'task-1',
        revision: 1,
      }),
    ],
    (ctx) => {
      const prompt = ctx.systemPrompt?.join('\n') ?? ''
      expect(prompt).toContain('git worktree')
      return [tool('fs_write', { path: file, content: `// ${file}\n` })]
    },
    (ctx) => [
      tool('submit_task', {
        id: /task-\d/.exec(JSON.stringify(ctx.messages))?.[0] ?? 'task-1',
        revision: 2,
        artifacts: [],
      }),
    ],
    ['done'],
  ]
  scripted(resolver, 'mock/backend', coder('api.ts'))
  scripted(resolver, 'mock/frontend', coder('page.ts'))
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), projects, quietMs: QUIET_MS })
  const { colonyId } = await chats.send(
    'Build the API and the page',
    {
      mode: 'orchestrated',
      leadModel: 'mock/lead',
      roster: [
        { role: 'backend', model: 'mock/backend' },
        { role: 'frontend', model: 'mock/frontend' },
      ],
      judgeModel: 'mock/judge',
    },
    undefined,
    { project: project.id },
  )
  const s = await waitFor(
    colonyId,
    (x) => Object.values(x.worktrees).every((w) => w.kept !== undefined) && x.status !== 'running',
  )
  const trees = Object.values(s.worktrees)
  expect(trees).toHaveLength(2)
  expect(trees.every((w) => w.branch.startsWith('myr/') && w.merges === 1 && w.kept === false)).toBe(true)
  expect(await Bun.file(join(folder, 'api.ts')).text()).toBe('// api.ts\n')
  expect(await Bun.file(join(folder, 'page.ts')).text()).toBe('// page.ts\n')
  // The person's repository is as they left it: same branch, nothing committed or staged, no worker branches left.
  expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
  expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1)
  expect(git('branch', '--list', 'myr/*')).toBe('')
  expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1)
  await chats.stopAll()
  rmSync(folder, { recursive: true, force: true })
})

test('an answer round that turns out bigger escalates, and a solo round reruns it with its notes', async () => {
  const resolver = new ModelResolver()
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      const seen = JSON.stringify(ctx.messages)
      // The answer round asks to move up once; the solo round (no escalate tool) does the work.
      if (ctx.tools?.some((t) => t.name === 'escalate'))
        return {
          content: seen.includes('"escalate"')
            ? ['handed over']
            : [tool('escalate', { to: 'solo', reason: 'It needs a script and a file, not a quick answer.' })],
        }
      if (seen.includes('needs a script') && seen.includes('Build me a CSV of primes'))
        return { content: [tool('reply_user', { text: 'primes.csv is ready.', final: true })] }
      return { content: ['missing context'] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('answer') })
  const config = { ...solo('mock/lead'), judgeModel: 'mock/judge' }
  const first = await chats.send('Build me a CSV of primes', config)
  const round1 = await waitFor(first.colonyId)
  expect(round1.escalated).toEqual({
    by: 'lead',
    to: 'solo',
    reason: 'It needs a script and a file, not a quick answer.',
  })
  expect(round1.status).toBe('stopped')
  // No team is configured, so an answer round can only move to one agent.
  expect(round1.agents.lead?.info.tools).toContain('escalate')
  let rounds: { colonyId: string }[] = []
  for (let i = 0; i < 100 && rounds.length < 2; i++) {
    rounds = (await chats.list()).find((c) => c.chatId === first.chatId)?.rounds ?? []
    await Bun.sleep(50)
  }
  expect(rounds).toHaveLength(2)
  const round2 = await waitFor(rounds[1]?.colonyId ?? '')
  expect(round2.tier).toBe('solo')
  expect(round2.status).toBe('completed')
  // The rerun is the same colony's next round, and it repeats the request.
  expect(rounds[1]?.colonyId).toBe(first.colonyId)
  const from = round2.rounds.at(-1)?.startSeq ?? 0
  expect(round2.chatMessages.find((m) => m.seq > from)).toMatchObject({
    from: 'user',
    text: 'Build me a CSV of primes',
  })
  expect(round2.notes.some((n) => n.section === 'decision' && n.text.includes('needs a script'))).toBe(true)
  expect(round2.chat?.history ?? '').not.toContain('Build me a CSV of primes')
  expect(round2.agents.lead?.info.tools).not.toContain('escalate')
  await expect(chats.resume(first.chatId)).rejects.toThrow()
  await chats.stopAll()
})

test('the judge of a research round checks the cited pages, reusing what the agent fetched', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/solo', [
    [tool('web_fetch', { url: 'https://example.org/sky' })],
    [
      tool('publish_artifact', {
        name: 'report.md',
        content:
          'The sky is blue ([source](https://example.org/sky)). Grass is green: https://example.com/grass.',
      }),
    ],
    [tool('reply_user', { text: 'report.md has both facts with sources.', final: true })],
  ])
  let judged = ''
  const m = createMockModel({
    handler: (ctx: LlmContext) => {
      judged = `${ctx.systemPrompt?.join('\n')}\n${JSON.stringify(ctx.messages)}`
      return { content: ['{"score": 0.9, "reasons": "supported"}'] }
    },
  })
  resolver.register('mock/judge', { model: m.model, streamFn: m.stream })
  const fetched: string[] = []
  const web = {
    search: async () => 'no results',
    read: async (url: string) => {
      fetched.push(url)
      return { url, method: 'test', contentType: 'text/html', output: `Page ${url} says the fact is true.` }
    },
  }
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), web })
  const { colonyId } = await chats.send('Find two facts with sources', {
    ...solo('mock/solo'),
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(judged).toContain('This work is research + writing')
  expect(judged).toContain('CITED SOURCES')
  expect(judged).toContain('https://example.org/sky (as the agent saw it)')
  expect(judged).toContain('https://example.com/grass (fetched by you now)')
  // The agent's own fetch, then the reviewer's fetch of the page the agent never opened.
  expect(fetched).toEqual(['https://example.org/sky', 'https://example.com/grass'])
  await chats.stopAll()
})

test('the lead sends verified work back with a reason, and its owner redoes it', async () => {
  const resolver = new ModelResolver()
  type Msg = LlmContext['messages'][number]
  const calls = (ctx: LlmContext, name: string) =>
    ctx.messages
      .filter((m: Msg) => m.role === 'assistant')
      .flatMap((m: Msg) => (Array.isArray(m.content) ? m.content : []))
      .filter(
        (c) =>
          (c as { type?: string; name?: string }).type === 'toolCall' &&
          (c as { name?: string }).name === name,
      ).length
  const specialist = (ctx: LlmContext) =>
    /- ([a-z]+): writer \(/.exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      const seen = JSON.stringify(ctx.messages)
      const verified = seen.split('was VERIFIED').length - 1
      if (calls(ctx, 'create_task') === 0)
        return {
          content: [
            tool('create_task', {
              subject: 'Write a haiku',
              assignee: specialist(ctx),
              outputs: ['haiku.txt'],
            }),
          ],
        }
      if (verified === 1 && calls(ctx, 'reject_task') === 0)
        return {
          content: [
            tool('reject_task', {
              id: 'task-1',
              revision: 4,
              reason: 'It has four lines; a haiku has three.',
            }),
          ],
        }
      if (verified >= 2 && calls(ctx, 'reply_user') === 0)
        return { content: [tool('reply_user', { text: 'haiku.txt is ready.', final: true })] }
      return { content: ['waiting'] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  const writer = createMockModel({
    handler: (ctx: LlmContext) => {
      const redo = JSON.stringify(ctx.messages).includes('sent task-1 back') ? 1 : 0
      if (calls(ctx, 'claim_task') === redo)
        return { content: [tool('claim_task', { id: 'task-1', revision: redo ? 5 : 1 })] }
      if (calls(ctx, 'publish_artifact') === redo)
        return {
          content: [
            tool('publish_artifact', { name: 'haiku.txt', content: redo ? 'a\nb\nc\n' : 'a\nb\nc\nd\n' }),
          ],
        }
      if (calls(ctx, 'submit_task') === redo)
        return {
          content: [tool('submit_task', { id: 'task-1', revision: redo ? 6 : 2, artifacts: ['haiku.txt'] })],
        }
      return { content: ['done'] }
    },
  })
  resolver.register('mock/writer', { model: writer.model, streamFn: writer.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('team'), quietMs: QUIET_MS })
  const { colonyId } = await chats.send('Write a haiku', {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [{ role: 'writer', model: 'mock/writer' }],
    judgeModel: 'mock/judge',
  })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  const changes = (await events(colonyId))
    .filter((e) => e.type === 'task/changed')
    .map((e) => e.payload as EventPayloads['task/changed'])
  const sentBack = changes.find((c) => c.task.status === 'rejected')
  expect(sentBack).toMatchObject({ by: 'lead', reason: 'It has four lines; a haiku has three.' })
  expect(changes.filter((c) => c.task.status === 'verified')).toHaveLength(2)
  expect(s.tasks['task-1']?.status).toBe('verified')
  await chats.stopAll()
})

test('check_in asks without pausing: the work goes on under the stated assumption', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/solo', [
    [
      tool('check_in', {
        question: 'Dark or light theme?',
        assumption: 'Dark, since the rest of the app is dark.',
      }),
    ],
    [tool('publish_artifact', { name: 'theme.css', content: 'body { background: #000 }\n' })],
    [tool('reply_user', { text: 'theme.css is in, dark as assumed.', final: true })],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { colonyId } = await chats.send('Style the page', { ...solo('mock/solo'), judgeModel: 'mock/judge' })
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(s.chatMessages.find((m) => m.assumption)).toMatchObject({
    from: 'lead',
    text: 'Dark or light theme?',
    assumption: 'Dark, since the rest of the app is dark.',
  })
  expect(s.artifacts['theme.css']).toBeDefined()
  await chats.stopAll()
})

test('an agent proposes a memory, the person keeps it, and the next chat starts with it', async () => {
  const { MemoryStore } = await import('../src/memory.ts')
  const memory = new MemoryStore(home)
  const resolver = new ModelResolver()
  let secondPrompt = ''
  const solo1 = createMockModel({
    handler: (ctx: LlmContext) => {
      const seen = JSON.stringify(ctx.messages)
      if (seen.includes('Say hello')) {
        secondPrompt = ctx.systemPrompt?.join('\n') ?? ''
        return {
          content: seen.includes('reply_user')
            ? ['done']
            : [tool('reply_user', { text: 'Hello.', final: true })],
        }
      }
      if (!seen.includes('"remember"'))
        return {
          content: [
            tool('remember', {
              text: 'The person wants answers in British English.',
              kind: 'preference',
              scope: 'everywhere',
              why: 'they asked for colour, not color',
            }),
          ],
        }
      return {
        content: seen.includes('reply_user')
          ? ['done']
          : [tool('reply_user', { text: 'Noted.', final: true })],
      }
    },
  })
  resolver.register('mock/solo', { model: solo1.model, streamFn: solo1.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), memory })
  const config = { ...solo('mock/solo'), judgeModel: 'mock/judge' }
  const first = await chats.send('Please write colour, not color, from now on', config)
  const s1 = await waitFor(first.colonyId)
  const proposed = Object.values(s1.memories)[0]
  expect(proposed).toMatchObject({
    agent: 'lead',
    kind: 'preference',
    why: 'they asked for colour, not color',
  })
  expect(memory.recall()).toHaveLength(0)

  await chats.decideMemory(proposed?.id ?? '', true)
  expect((await waitFor(first.colonyId, (s) => s.memories[proposed?.id ?? '']?.kept === true)).status).toBe(
    'completed',
  )
  expect(memory.get(proposed?.id ?? '')).toMatchObject({
    status: 'active',
    source: { by: 'agent', agent: 'lead' },
  })

  const second = await chats.send('Say hello', config)
  await waitFor(second.colonyId)
  expect(secondPrompt).toContain('- [preference] The person wants answers in British English.')
  await chats.stopAll()
})

test('after a round the reviewer suggests a memory from what the person said; agents recall it and propose its replacement', async () => {
  const { MemoryStore } = await import('../src/memory.ts')
  const { SettingsStore } = await import('../src/settings.ts')
  const memory = new MemoryStore(home)
  const settings = new SettingsStore(home)
  settings.set({ ...settings.get(), profile: { ...settings.get().profile, titles: 'first-message' } })
  const resolver = new ModelResolver()
  let recalled = ''
  let tidied = 0
  const model = createMockModel({
    handler: (ctx: LlmContext) => {
      const system = ctx.systemPrompt?.join('\n') ?? ''
      const seen = JSON.stringify(ctx.messages)
      if (system.includes('pick out what is worth remembering'))
        return {
          content: [
            JSON.stringify({
              memories: [
                // The person said it: suggested. The crew said it: dropped. A secret: dropped.
                {
                  text: 'Prefers pnpm over npm',
                  kind: 'preference',
                  scope: 'everywhere',
                  evidence: 'use pnpm',
                },
                { text: 'Likes long answers', kind: 'preference', evidence: 'Here is a long answer' },
                { text: 'Token ghp_abcdefghijklmnopqrstuvwxyz123456', kind: 'fact', evidence: 'use pnpm' },
              ],
            }),
          ],
        }
      if (system.includes('You tidy up the memories')) {
        tidied++
        const ids = [...seen.matchAll(/mem-[a-z0-9]+-[a-z0-9]+/g)].map((m) => m[0])
        return {
          content: [
            JSON.stringify({
              memories: [
                { text: 'Uses pnpm, never npm or yarn', kind: 'preference', replaces: [...new Set(ids)] },
              ],
            }),
          ],
        }
      }
      if (seen.includes('Which package manager')) {
        if (!seen.includes('"recall"'))
          return { content: [tool('recall', { query: 'package manager pnpm' })] }
        if (!seen.includes('"remember"')) {
          recalled = seen
          const id = /mem-[a-z0-9]+-[a-z0-9]+/.exec(seen)?.[0] ?? ''
          return {
            content: [
              tool('remember', {
                text: 'Uses pnpm, never yarn',
                kind: 'preference',
                scope: 'everywhere',
                why: 'they ruled out yarn',
                replaces: [id],
              }),
            ],
          }
        }
        return {
          content: seen.includes('reply_user')
            ? ['done']
            : [tool('reply_user', { text: 'pnpm.', final: true })],
        }
      }
      return {
        content: seen.includes('reply_user')
          ? ['done']
          : [tool('reply_user', { text: 'Here is a long answer.', final: true })],
      }
    },
  })
  resolver.register('mock/solo', { model: model.model, streamFn: model.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), memory, settings })
  const config = { ...solo('mock/solo'), judgeModel: 'mock/judge' }
  const first = await chats.send('Please use pnpm for this project', config)
  const s1 = await waitFor(first.colonyId, (s) => Object.keys(s.memories).length > 0)
  const suggested = Object.values(s1.memories)
  expect(suggested).toHaveLength(1)
  expect(suggested[0]).toMatchObject({
    agent: 'myrmidon',
    text: 'Prefers pnpm over npm',
    why: 'use pnpm',
    suggested: true,
  })
  expect(memory.recall()).toHaveLength(0)
  await chats.decideMemory(suggested[0]?.id ?? '', true)
  const kept = memory.get(suggested[0]?.id ?? '')
  expect(kept).toMatchObject({ status: 'active', source: { by: 'extract' } })

  // An agent searches memory, finds it by its words, and proposes a correction that replaces it.
  const second = await chats.send('Which package manager, and never yarn?', config)
  const s2 = await waitFor(second.colonyId, (s) =>
    Object.values(s.memories).some((m) => m.agent === 'lead' && m.replaces?.length),
  )
  expect(recalled).toContain('Prefers pnpm over npm')
  const correction = Object.values(s2.memories).find((m) => m.agent === 'lead')
  expect(correction?.replaces).toEqual([{ id: kept?.id ?? '', text: 'Prefers pnpm over npm' }])
  await chats.decideMemory(correction?.id ?? '', true)
  expect(memory.kept().map((m) => m.text)).toEqual(['Uses pnpm, never yarn'])

  // Tidying up proposes a merge, which waits for the person.
  memory.add({
    text: 'Never use yarn for installs',
    kind: 'preference',
    status: 'active',
    source: { by: 'person' },
  })
  expect(await chats.tidyMemories('mock/solo')).toBe(1)
  expect(tidied).toBe(1)
  const merge = memory.list().find((m) => m.source.by === 'reflect')
  expect(merge).toMatchObject({ status: 'proposed', text: 'Uses pnpm, never npm or yarn' })
  expect(merge?.replaces).toHaveLength(2)
  await chats.decideMemory(merge?.id ?? '', true)
  expect(memory.kept().map((m) => m.text)).toEqual(['Uses pnpm, never npm or yarn'])
  await chats.stopAll()
})

test('a follow-up continues the same colony, and its agent remembers the earlier round', async () => {
  const resolver = new ModelResolver()
  let followUp = ''
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      const seen = JSON.stringify(ctx.messages)
      if (seen.includes('What number did you pick?')) {
        followUp = seen
        return {
          content:
            seen.includes('reply_user') && seen.includes('You picked')
              ? ['done']
              : [tool('reply_user', { text: 'You picked 7.', final: true })],
        }
      }
      return {
        content: seen.includes('reply_user')
          ? ['done']
          : [tool('reply_user', { text: 'I pick 7.', final: true })],
      }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const config = { ...solo('mock/lead'), judgeModel: 'mock/judge' }
  const first = await chats.send('Pick a number', config)
  await waitFor(first.colonyId)
  const second = await chats.send('What number did you pick?', config, first.chatId)
  expect(second.colonyId).toBe(first.colonyId)
  const s = await waitFor(
    second.colonyId,
    (x) => x.rounds.at(-1)?.status === 'completed' && x.rounds.length === 2,
  )
  // Its own earlier turn is in its context, so the history is not repeated in the kickoff.
  expect(followUp).toContain('I pick 7.')
  expect(followUp).not.toContain('Earlier in this conversation')
  expect(s.rounds.map((r) => [r.round, r.status])).toEqual([
    [1, 'completed'],
    [2, 'completed'],
  ])
  const chat = (await chats.list()).find((c) => c.chatId === first.chatId)
  expect(chat?.rounds.map((r) => [r.colonyId, r.round, r.request])).toEqual([
    [first.colonyId, 1, 'Pick a number'],
    [first.colonyId, 2, 'What number did you pick?'],
  ])
  await chats.stopAll()
})

test('a follow-up sent as the last round stops waits for it to end: one answer gets one review, and both rounds end', async () => {
  const resolver = new ModelResolver()
  scripted(
    resolver,
    'mock/lead',
    Array.from({ length: 12 }, () => [tool('reply_user', { text: 'Done.', final: true })]),
  )
  judge(resolver, 0.1)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const config = { ...solo('mock/lead'), judgeModel: 'mock/judge' }
  const first = await chats.send('Write notes', config)
  // Sent the moment round 1 is logged as stopped, while that round is still shutting down.
  const second = new Promise<{ chatId: string; colonyId: string }>((resolve, reject) => {
    const off = runtime.ctx.on('log/appended', (colonyId, appended) => {
      if (colonyId !== first.colonyId || !appended.some((e) => e.type === 'colony/stopped')) return
      off()
      chats.send('And a summary', config, first.chatId).then(resolve, reject)
    })
  })
  const { colonyId } = await second
  const s = await waitFor(colonyId, (x) => x.rounds.length === 2 && x.status === 'stopped')
  expect(s.statusReason).toBe('verification failed 3 times; see the last verdict')
  const log = await events(colonyId)
  const round2 = log.slice(log.findIndex((e) => e.type === 'round/started'))
  const answers = round2.filter((e) => e.type === 'chat/reply' && (e.payload as { final?: boolean }).final)
  expect(answers).toHaveLength(3)
  expect(round2.filter((e) => e.type === 'verifier/requested')).toHaveLength(3)
  expect(round2.filter((e) => e.type === 'colony/stopped')).toHaveLength(1)
  const stopped = round2.findIndex((e) => e.type === 'colony/stopped')
  expect(round2.slice(stopped).filter((e) => e.type === 'llm/response' || e.type === 'tool/call')).toEqual([])
  // Both rounds have wound up, so shutting down does not wait on either.
  const t = Date.now()
  await chats.stopAll()
  expect(Date.now() - t).toBeLessThan(1000)
})

test('shutting down waits a few seconds at most for a round that cannot finish wrapping up', async () => {
  const chats = new ChatService(runtime, { resolver: new ModelResolver(), classify: fixed('answer') })
  // A wrap-up that never settles (an end checkpoint stuck on git, say).
  ;(chats as unknown as { _wrapUps: Set<Promise<unknown>> })._wrapUps.add(new Promise(() => {}))
  const t = Date.now()
  await chats.stopAll()
  expect(Date.now() - t).toBeLessThan(5000)
})

test('on-demand tools stay out of model calls until find_tools loads them', async () => {
  const resolver = new ModelResolver()
  const offered: string[][] = []
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      offered.push((ctx.tools ?? []).map((t) => t.name))
      const seen = JSON.stringify(ctx.messages)
      if (!seen.includes('"find_tools"')) return { content: [tool('find_tools', { query: 'browser' })] }
      return {
        content: seen.includes('reply_user')
          ? ['done']
          : [tool('reply_user', { text: 'Ready.', final: true })],
      }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { colonyId } = await chats.send('Look something up', {
    ...solo('mock/lead'),
    judgeModel: 'mock/judge',
  })
  await waitFor(colonyId)
  const [before, after] = offered
  expect(before).toContain('find_tools')
  expect(before).toContain('fs_read')
  expect(before).not.toContain('browser_open')
  expect(after).toContain('browser_open')
  expect(after).toContain('browser_click')
  expect(after?.length).toBeGreaterThan(before?.length ?? 0)
  await chats.stopAll()
})

test('agents see the skills by name and load one when the task matches', async () => {
  const { SkillLibrary } = await import('../src/skills.ts')
  const claude = mkdtempSync(join(tmpdir(), 'myr-claude-skills-'))
  mkdirSync(join(claude, 'haiku-style'))
  await Bun.write(
    join(claude, 'haiku-style', 'SKILL.md'),
    '---\nname: haiku-style\ndescription: How the person likes haiku written. Use for any haiku.\n---\n\nAlways 5-7-5, no rhyme, end on a season word.\n',
  )
  const skills = new SkillLibrary(home, claude)
  const resolver = new ModelResolver()
  let prompt = ''
  let loaded = ''
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      prompt = ctx.systemPrompt?.join('\n') ?? ''
      const seen = JSON.stringify(ctx.messages)
      if (!seen.includes('"use_skill"')) return { content: [tool('use_skill', { name: 'haiku-style' })] }
      loaded = seen
      return {
        content: seen.includes('reply_user')
          ? ['done']
          : [tool('reply_user', { text: 'A haiku.', final: true })],
      }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), skills })
  const { colonyId } = await chats.send('Write a haiku about ants', {
    ...solo('mock/lead'),
    judgeModel: 'mock/judge',
  })
  await waitFor(colonyId)
  expect(prompt).toContain('- haiku-style: How the person likes haiku written.')
  expect(loaded).toContain('Always 5-7-5, no rhyme')
  const used = (await events(colonyId)).find((e) => e.type === 'skill/used')
  expect(used?.payload).toEqual({ agent: 'lead', name: 'haiku-style' })
  // Each load is counted, so a learned skill nobody uses can be retired.
  const usage = JSON.parse(readFileSync(join(home, 'skills-usage.json'), 'utf8'))
  expect(usage['haiku-style']).toMatchObject({ uses: 1 })
  await chats.stopAll()
  rmSync(claude, { recursive: true, force: true })
})

test("the person's hooks block a tool, comment on a result, and run when the round ends", async () => {
  const { HookStore } = await import('../src/hooks.ts')
  const hooks = new HookStore(home)
  const stopped = join(home, 'stopped.json')
  hooks.write({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write',
          hooks: [
            {
              type: 'command',
              command: `grep -q '\\.env"' && { echo 'never write .env files' >&2; exit 2; } || true`,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'fs_write',
          hooks: [{ type: 'command', command: "echo 'formatted with prettier' >&2; exit 2" }],
        },
      ],
      // The redirect creates the file before cat fills it; renaming makes it appear only when complete.
      Stop: [
        {
          hooks: [{ type: 'command', command: `cat > '${stopped}.tmp' && mv '${stopped}.tmp' '${stopped}'` }],
        },
      ],
    },
  })
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/solo', [
    [tool('fs_write', { path: '.env', content: 'KEY=1' })],
    [tool('fs_write', { path: 'notes.txt', content: 'hello' })],
    [tool('reply_user', { text: 'Done.', final: true })],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), hooks })
  const { colonyId } = await chats.send('Save my notes', { ...solo('mock/solo'), judgeModel: 'mock/judge' })
  await waitFor(colonyId)
  const results = (await events(colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
  expect(results[0]).toMatchObject({ tool: 'fs_write', ok: false })
  expect(results[0]?.output).toContain('a hook blocked this call: never write .env files')
  expect(results[1]).toMatchObject({ tool: 'fs_write', ok: true })
  expect(results[1]?.output).toContain('[hook] formatted with prettier')
  const ran = (await events(colonyId))
    .filter((e) => e.type === 'hook/ran')
    .map((e) => (e.payload as EventPayloads['hook/ran']).outcome)
  expect(ran).toContain('blocked')
  expect(ran).toContain('feedback')
  for (let i = 0; i < 40 && !existsSync(stopped); i++) await Bun.sleep(50)
  expect(JSON.parse(await Bun.file(stopped).text())).toMatchObject({
    hook_event_name: 'Stop',
    status: 'completed',
  })
  await chats.stopAll()
})

test('a secret an agent reads is kept out of the log and its transcript', async () => {
  const { ProjectStore } = await import('../src/projects.ts')
  const folder = mkdtempSync(join(tmpdir(), 'myr-secret-'))
  const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
  await Bun.write(join(folder, '.env'), `OPENAI_API_KEY=${key}\nPORT=3000\n`)
  const project = new ProjectStore(home).add(folder)
  const resolver = new ModelResolver()
  let seen = ''
  scripted(resolver, 'mock/solo', [
    [tool('fs_read', { path: '.env' })],
    (ctx) => {
      seen = JSON.stringify(ctx.messages)
      return [tool('reply_user', { text: 'The port is 3000.', final: true })]
    },
  ])
  judge(resolver)
  const chats = new ChatService(runtime, {
    resolver,
    classify: fixed('solo'),
    projects: new ProjectStore(home),
  })
  const { colonyId } = await chats.send(
    'Which port does .env set?',
    { ...solo('mock/solo'), judgeModel: 'mock/judge' },
    undefined,
    {
      project: project.id,
    },
  )
  await waitFor(colonyId)
  // The model was sent a placeholder for the key (provider-secrets.ts), the rest of the file as it is; what was
  // stored did not keep the key either.
  expect(seen).not.toContain(key)
  expect(seen).toContain('OPENAI_API_KEY=[[secret:api-key:')
  expect(seen).toContain('PORT=3000')
  const log = JSON.stringify(await events(colonyId))
  expect(log).not.toContain(key)
  expect(log).toContain('[api key redacted]')
  expect(log).toContain('PORT=3000')
  const transcript = await Bun.file(join(home, 'colonies', colonyId, 'agents', 'lead.jsonl')).text()
  expect(transcript).not.toContain(key)
  await chats.stopAll()
  rmSync(folder, { recursive: true, force: true })
})

test('per-tool rules turn a tool off and make another wait for approval', async () => {
  const { SettingsStore } = await import('../src/settings.ts')
  const settings = new SettingsStore(home)
  settings.set({ ...settings.get(), permissions: { web_search: 'off', fs_write: 'ask' } })
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/solo', [
    [tool('fs_write', { path: 'a.txt', content: 'x' })],
    [tool('reply_user', { text: 'Wrote it.', final: true })],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), settings })
  const { colonyId } = await chats.send('Write a.txt', { ...solo('mock/solo'), judgeModel: 'mock/judge' })
  const waiting = await waitFor(colonyId, (x) => Object.values(x.approvals).some((a) => !a.decided))
  expect(waiting.agents.lead?.info.tools).not.toContain('web_search')
  const ask = Object.values(waiting.approvals)[0]
  expect(ask).toMatchObject({ tool: 'fs_write' })
  expect(ask?.summary).toContain('a.txt')
  await chats.decideApproval(colonyId, ask?.id ?? '', true)
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  const write = (await events(colonyId)).find(
    (e) => e.type === 'tool/result' && (e.payload as EventPayloads['tool/result']).tool === 'fs_write',
  )
  expect((write?.payload as EventPayloads['tool/result'] | undefined)?.ok).toBe(true)
  await chats.stopAll()
})

test('a round someone else started asks before every call that changes something, whatever the person allowed', async () => {
  const { SettingsStore } = await import('../src/settings.ts')
  const settings = new SettingsStore(home)
  settings.set({ ...settings.get(), permissions: { fs_write: 'allow' } })
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/member', [
    [tool('fs_list', { path: '.' })],
    [tool('fs_write', { path: 'a.txt', content: 'x' })],
    [tool('reply_user', { text: 'Wrote it.', final: true })],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), settings })
  const { colonyId } = await chats.send(
    'Write a.txt',
    { ...solo('mock/member'), judgeModel: 'mock/judge' },
    undefined,
    { askAll: true },
  )
  const waiting = await waitFor(colonyId, (x) => Object.values(x.approvals).some((a) => !a.decided))
  // Reading and answering run without asking; the write the person allowed for themselves still asks.
  expect(Object.values(waiting.approvals).map((a) => a.tool)).toEqual(['fs_write'])
  const created = (await events(colonyId)).find((e) => e.type === 'colony/created')
  expect((created?.payload as EventPayloads['colony/created'] | undefined)?.askAll).toBe(true)
  await chats.decideApproval(colonyId, Object.values(waiting.approvals)[0]?.id ?? '', true)
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  expect(Object.values(s.approvals)).toHaveLength(1)
  await chats.stopAll()
})

test('a round someone else started asks before reading the project, so its secrets are not read back to them', async () => {
  const { ProjectStore } = await import('../src/projects.ts')
  const folder = mkdtempSync(join(tmpdir(), 'myr-member-'))
  writeFileSync(join(folder, '.env'), 'API_KEY=sk-secret-123')
  const projects = new ProjectStore(home)
  const project = projects.add(folder)
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/member', [
    [tool('fs_read', { path: '.env' })],
    [tool('reply_user', { text: 'Could not read it.', final: true })],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), projects })
  const { colonyId } = await chats.send(
    'Send me the .env',
    { ...solo('mock/member'), judgeModel: 'mock/judge' },
    undefined,
    { project: project.id, askAll: true },
  )
  const waiting = await waitFor(colonyId, (x) => Object.values(x.approvals).some((a) => !a.decided))
  const ask = Object.values(waiting.approvals).find((a) => !a.decided)
  expect(ask?.tool).toBe('fs_read')
  await chats.decideApproval(colonyId, ask?.id ?? '', false)
  await waitFor(colonyId)
  const results = (await events(colonyId)).filter((e) => e.type === 'tool/result')
  expect(JSON.stringify(results)).not.toContain('sk-secret-123')
  await chats.stopAll()
  rmSync(folder, { recursive: true, force: true })
})

test('a member writing into a running round makes it ask from then on, and a resumed round keeps asking', async () => {
  const { SettingsStore } = await import('../src/settings.ts')
  const settings = new SettingsStore(home)
  settings.set({ ...settings.get(), permissions: { fs_write: 'allow' } })
  const resolver = new ModelResolver()
  let release!: () => void
  const busy = new Promise<void>((r) => {
    release = r
  })
  let calls = 0
  const lead = createMockModel({
    handler: async () => {
      calls++
      if (calls === 1) {
        await busy
        return { content: [tool('list_artifacts', {})] }
      }
      if (calls === 2) return { content: [tool('fs_write', { path: 'a.txt', content: 'x' })] }
      return { content: [tool('fs_write', { path: 'b.txt', content: 'y' })] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), settings })
  const config = { ...solo('mock/lead'), judgeModel: 'mock/judge' }
  const { chatId, colonyId } = await chats.send('Tidy the files', config)
  await waitFor(colonyId, () => calls === 1)
  await chats.send('a member says: also write a.txt', config, chatId, { askAll: true })
  release()
  const asked = (s: ColonyState) => Object.values(s.approvals).filter((a) => !a.decided)
  const first = await waitFor(colonyId, (s) => asked(s).length > 0)
  expect(asked(first).map((a) => a.tool)).toEqual(['fs_write'])
  const change = (await events(colonyId)).find((e) => e.type === 'permissions/changed')
  expect((change?.payload as EventPayloads['permissions/changed'] | undefined)?.askAll).toBe(true)

  await chats.stop(chatId)
  await waitFor(colonyId)
  await chats.resume(chatId)
  const again = await waitFor(colonyId, (s) => s.status === 'running' && asked(s).length > 0)
  expect(asked(again).map((a) => a.tool)).toEqual(['fs_write'])
  await chats.stopAll()
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

test('ask_user can offer options to click, and the round waits for the answer', async () => {
  const resolver = new ModelResolver()
  const questions = [
    {
      question: 'Who is the site for?',
      header: 'Audience',
      options: [
        { label: 'Me', description: 'A personal portfolio' },
        { label: 'A studio', description: 'An agency site' },
      ],
    },
    {
      question: 'Which pages?',
      header: 'Pages',
      options: [{ label: 'Work' }, { label: 'About' }, { label: 'Contact' }],
      multiSelect: true,
    },
  ]
  scripted(resolver, 'mock/lead', [
    [tool('ask_user', { question: 'A few choices before I start:', questions })],
    ['waiting'],
  ])
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { colonyId } = await chats.send('build me a portfolio site', solo('mock/lead'))
  const s = await waitFor(colonyId)
  expect(s.statusReason).toBe('awaiting your reply')
  expect(s.chatMessages.at(-1)).toMatchObject({
    question: true,
    text: 'A few choices before I start:',
    choices: questions,
  })
  await chats.stopAll()
})

test("a plugin's tool and prompt section reach the agent, and its calls are logged like any tool", async () => {
  const { PluginStore } = await import('../src/plugins.ts')
  const { PluginHost } = await import('../src/plugin-host.ts')
  const at = join(home, 'plugins', 'nova')
  mkdirSync(join(at, 'server'), { recursive: true })
  await Bun.write(
    join(at, 'server', 'index.ts'),
    `export function activate(ctx) {
      ctx.tools.add({ name: 'shout', description: 'Shouts', run: (a) => String(a.text).toUpperCase() })
      ctx.prompts.add('House style', 'Sign every reply as Nova.', 'lead')
    }`,
  )
  const plugins = new PluginHost(new PluginStore(home))
  await plugins.start()
  const resolver = new ModelResolver()
  const prompts: string[] = []
  scripted(resolver, 'mock/lead', [
    (ctx: LlmContext) => {
      prompts.push(JSON.stringify(ctx.systemPrompt))
      return [tool('nova_shout', { text: 'hello' })]
    },
    [tool('reply_user', { text: 'HELLO — Nova', final: true })],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), plugins })
  const { colonyId } = await chats.send('shout hello', { ...solo('mock/lead'), judgeModel: 'mock/judge' })
  await waitFor(colonyId)
  expect(prompts[0]).toContain('Sign every reply as Nova.')
  const results = (await events(colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
  expect(results.find((r) => r.tool === 'nova_shout')?.output).toBe('HELLO')
  await chats.stopAll()
  await plugins.stop()
})

test('asked for a Myrmidon feature, the lead builds a plugin, tests it, and the person switches it on', async () => {
  const { PluginStore } = await import('../src/plugins.ts')
  const { PluginHost } = await import('../src/plugin-host.ts')
  const plugins = new PluginHost(new PluginStore(home))
  const files = {
    'server/index.ts': `export function activate(ctx) {
      ctx.tools.add({ name: 'word_count', description: 'Counts words', run: (a) => String(String(a.text).split(/\\s+/).filter(Boolean).length) })
    }`,
    'commands/count.md': '---\ndescription: Count words\n---\nCount the words in: $ARGUMENTS',
  }
  const resolver = new ModelResolver()
  const results: string[] = []
  scripted(resolver, 'mock/lead', [
    [tool('create_plugin', { name: 'words', description: 'Counts words in a text', files })],
    (ctx: LlmContext) => {
      results.push(JSON.stringify(ctx.messages.at(-1)))
      return [
        tool('test_plugin', {
          name: 'words',
          tests: [{ tool: 'word_count', args: { text: 'one two three' } }],
        }),
      ]
    },
    (ctx: LlmContext) => {
      results.push(JSON.stringify(ctx.messages.at(-1)))
      return [
        tool('create_plugin', {
          name: 'words',
          description: 'A bad rewrite',
          files: { '../escape.ts': 'no' },
        }),
      ]
    },
    (ctx: LlmContext) => {
      results.push(JSON.stringify(ctx.messages.at(-1)))
      return [
        tool('propose_plugin', { name: 'words', summary: 'Adds a word_count tool and a /count command.' }),
      ]
    },
    (ctx: LlmContext) => {
      results.push(JSON.stringify(ctx.messages.at(-1)))
      return [tool('reply_user', { text: 'Added the words plugin.', final: true })]
    },
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), plugins })
  const { colonyId } = await chats.send('Add a word counter to Myrmidon', {
    ...solo('mock/lead'),
    judgeModel: 'mock/judge',
  })
  const pending = await waitFor(colonyId, (x) => Object.values(x.approvals).some((a) => !a.decided))
  const approval = Object.values(pending.approvals).find((a) => !a.decided)
  expect(approval?.summary).toContain('Switch on the words plugin?')
  expect(approval?.summary).toContain('commands: /count')
  // Until the person says yes, the draft is off and its code has not run in Myrmidon.
  expect(plugins.store.list().find((p) => p.name === 'words')?.enabled).toBe(false)
  expect(plugins.tools({ colonyId, agent: 'lead' })).toEqual([])
  await chats.decideApproval(colonyId, approval?.id ?? '', true)
  await waitFor(colonyId)
  expect(results[0]).toContain('draft words written')
  if (detectSandbox().kind !== 'none') expect(results[1]).toContain('word_count → 3')
  else expect(results[1]).toContain('code builds')
  expect(results[2]).toContain('is not a plugin file')
  // The refused rewrite left the tested draft as it was.
  expect(existsSync(join(home, 'plugins', 'words', 'server', 'index.ts'))).toBe(true)
  expect(results[3]).toContain('words is on')
  expect(plugins.store.list().find((p) => p.name === 'words')).toMatchObject({ enabled: true })
  expect(plugins.tools({ colonyId, agent: 'lead' }).map((t) => t.name)).toEqual(['words_word_count'])
  await chats.stopAll()
  await plugins.stop()
})

test('tightening permissions mid-turn stops the agent at once and tells it what changed', async () => {
  const { PluginStore } = await import('../src/plugins.ts')
  const { PluginHost } = await import('../src/plugin-host.ts')
  const { SettingsStore } = await import('../src/settings.ts')
  const at = join(home, 'plugins', 'slow')
  mkdirSync(join(at, 'server'), { recursive: true })
  await Bun.write(
    join(at, 'server', 'index.ts'),
    `export function activate(ctx) {
      ctx.tools.add({ name: 'wait', description: 'Takes a while', run: () => new Promise((r) => setTimeout(() => r('done waiting'), 4000)) })
    }`,
  )
  const plugins = new PluginHost(new PluginStore(home))
  await plugins.start()
  const settings = new SettingsStore(home)
  const resolver = new ModelResolver()
  const seen: string[] = []
  // A step cut short by the abort still uses up a scripted step, so every later step answers the same way.
  const after = (ctx: LlmContext) => {
    const last = JSON.stringify(ctx.messages.at(-1))
    seen.push(last)
    return last.includes('The person changed what you may do')
      ? [tool('reply_user', { text: 'Carried on without the web.', final: true })]
      : ['thinking']
  }
  scripted(resolver, 'mock/lead', [[tool('slow_wait', {})], after, after, after])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), plugins, settings })
  const { colonyId } = await chats.send('Do it', { ...solo('mock/lead'), judgeModel: 'mock/judge' })
  for (let i = 0; i < 100; i++) {
    if ((await events(colonyId)).some((e) => e.type === 'tool/call')) break
    await Bun.sleep(20)
  }
  const started = Date.now()
  // The web group switched off for everyone (Permissions → Who can use what; once Settings → Tools' web switch).
  const now = settings.get()
  settings.set({
    ...now,
    permissions: { ...now.permissions, access: { lead: { web: false }, crew: { web: false } } },
  })
  await chats.permissionsChanged()
  const s = await waitFor(colonyId)
  // The turn was cut short well before the slow tool would have finished.
  expect(Date.now() - started).toBeLessThan(3500)
  expect(s.status).toBe('completed')
  const change = (await events(colonyId)).find((e) => e.type === 'permissions/changed')
  expect(change?.payload).toMatchObject({ interrupted: ['lead'] })
  expect((change?.payload as { off?: string[] } | undefined)?.off).toContain('web_search')
  const note = seen.find((m) => m.includes('The person changed what you may do'))
  expect(note).toContain('web_search')
  expect(s.chatMessages.at(-1)?.text).toBe('Carried on without the web.')
  await chats.stopAll()
  await plugins.stop()
})

test('a note that reached an agent mid-turn and was cut off with the turn opens its next turn as it was sent', async () => {
  const { PluginStore } = await import('../src/plugins.ts')
  const { PluginHost } = await import('../src/plugin-host.ts')
  const { SettingsStore } = await import('../src/settings.ts')
  const at = join(home, 'plugins', 'slow')
  mkdirSync(join(at, 'server'), { recursive: true })
  await Bun.write(
    join(at, 'server', 'index.ts'),
    `export function activate(ctx) {
      ctx.tools.add({ name: 'wait', description: 'Takes a while', run: () => new Promise((r) => setTimeout(() => r('done waiting'), 4000)) })
    }`,
  )
  const plugins = new PluginHost(new PluginStore(home))
  await plugins.start()
  const settings = new SettingsStore(home)
  const resolver = new ModelResolver()
  const seen: string[] = []
  const after = (ctx: LlmContext) => {
    const last = JSON.stringify(ctx.messages.at(-1))
    seen.push(last)
    return last.includes('The person changed what you may do')
      ? [tool('reply_user', { text: 'Carried on.', final: true })]
      : ['thinking']
  }
  scripted(resolver, 'mock/lead', [[tool('slow_wait', {})], after, after, after])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), plugins, settings })
  const { colonyId } = await chats.send('Do it', { ...solo('mock/lead'), judgeModel: 'mock/judge' })
  for (let i = 0; i < 100; i++) {
    if ((await events(colonyId)).some((e) => e.type === 'tool/call')) break
    await Bun.sleep(20)
  }
  // A note from outside arrives while the slow tool runs, then the turn is cut short before the agent reads it.
  chats.wakeAgent(colonyId, 'lead', 'Your browser was handed back.')
  settings.set({ ...settings.get(), permissions: { web_search: 'off', web_fetch: 'off' } })
  await chats.permissionsChanged()
  const s = await waitFor(colonyId)
  expect(s.status).toBe('completed')
  const next = turnsOf(await events(colonyId), 'lead').find(
    (e) =>
      (e.payload as EventPayloads['agent/turn']).phase === 'start' &&
      (e.payload as EventPayloads['agent/turn']).turn === 2,
  )
  // It keeps its own trigger, not a stand-in, and reads as sent.
  expect((next?.payload as EventPayloads['agent/turn'] | undefined)?.trigger).toBe('permissions,person')
  const note = seen.find((m) => m.includes('Your browser was handed back.')) ?? ''
  expect(note).toContain('[person] Your browser was handed back.')
  expect(note).not.toContain('[mail]')
  await chats.stopAll()
  await plugins.stop()
})

test('a round stopped after reaching outside Myrmidon tells its agents what was already done when it resumes', async () => {
  const { McpHub } = await import('../src/mcp.ts')
  const { SettingsStore } = await import('../src/settings.ts')
  const hub = new McpHub(join(home, 'agent'))
  opened.push(hub)
  await hub.add('echo', { command: 'bun', args: [join(import.meta.dir, 'fixtures', 'echo-mcp.ts')] })
  const shout = hub.tools().find((t) => t.name.endsWith('_shout'))?.name ?? 'missing'
  const settings = new SettingsStore(home)
  settings.set({ ...settings.get(), permissions: { [shout]: 'allow' } })
  const resolver = new ModelResolver()
  const seen: string[] = []
  // The second step hangs, so the round is still working when the person stops it.
  let calls = 0
  const lead = createMockModel({
    handler: async (ctx: LlmContext) => {
      calls += 1
      if (calls === 1) return { content: [tool(shout, { text: 'order placed' })] }
      if (calls === 2) {
        await Bun.sleep(3000)
        return { content: ['waiting for the supplier'] }
      }
      seen.push(JSON.stringify(ctx.messages.at(-1)))
      return { content: [tool('reply_user', { text: 'Done; the order was already placed.', final: true })] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), mcp: hub, settings })
  const { chatId, colonyId } = await chats.send('Place the order', {
    ...solo('mock/lead'),
    judgeModel: 'mock/judge',
  })
  // The call outside Myrmidon has run, and the lead is working on its next step, before the person stops: the MCP
  // server can take seconds to start on a slow machine, and a round stopped before the call has nothing to tell.
  for (let i = 0; !(await events(colonyId)).some((e) => e.type === 'tool/result') || calls < 2; i++) {
    if (i >= 400) throw new Error('the call outside Myrmidon never ran')
    await Bun.sleep(50)
  }
  await chats.stop(chatId)
  await waitFor(colonyId, (x) => x.status === 'stopped')
  await chats.resume(chatId)
  await waitFor(colonyId, (x) => x.status === 'completed')
  expect(seen[0]).toContain('already did these outside Myrmidon')
  expect(seen[0]).toContain(`called ${shout} {\\"text\\":\\"order placed\\"}`)
  await hub.close()
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

test('chats are found by what was said in them, with the words around the match', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/searched', [
    [
      tool('reply_user', {
        text: `Checked the ledger at the ÉCOLE.\nİİİ The total is 391 units, all paid.${' More.'.repeat(40)}`,
        final: true,
      }),
    ],
  ])
  const chats = new ChatService(runtime, { resolver, classify: fixed('answer') })
  expect(await chats.search('391')).toEqual([])
  const reads = spyOn(SqliteLogStore.prototype, 'read')
  try {
    const { chatId, colonyId } = await chats.send('add up the invoices', solo('mock/searched'))
    await waitFor(colonyId)
    await chats.stopAll()
    await Bun.sleep(50)
    reads.mockClear()
    // The round left the index current as it ended: searching reads no log.
    const [hit] = await chats.search('  391 ')
    expect(reads).toHaveBeenCalledTimes(0)
    expect(hit).toMatchObject({ chatId, from: 'lead' })
    expect(hit?.snippet).toContain('The total is 391 units')
    expect(hit?.snippet.endsWith('…')).toBe(true)
    // İ lower-cases to two characters; the match is still found where it is.
    expect(hit?.snippet.slice(hit.match?.start, hit.match?.end)).toBe('391')

    // After a restart, from the index: case folds beyond ASCII, the person's words count, wildcards are literal.
    const later = new ChatService(runtime, { resolver })
    expect((await later.search('école'))[0]?.chatId).toBe(chatId)
    expect((await later.search('INVOICES'))[0]).toMatchObject({ chatId, from: 'user' })
    expect(await later.search('39_')).toEqual([])
    expect(await later.search('39%')).toEqual([])
    expect(await later.search('   ')).toEqual([])

    await later.delete(chatId)
    expect(await later.search('391')).toEqual([])
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

/** A model that names chats: answers `title` once `open` resolves, and counts its calls. */
function namer(
  resolver: ModelResolver,
  ref: string,
  title: string,
  open: Promise<unknown> = Promise.resolve(),
) {
  const calls = { n: 0 }
  const mock = createMockModel({ handler: () => ({ content: [JSON.stringify({ title })] }) })
  resolver.register(ref, {
    model: mock.model,
    streamFn: (async (...args: Parameters<typeof mock.stream>) => {
      calls.n += 1
      await open
      return mock.stream(...args)
    }) as unknown as typeof mock.stream,
  })
  return calls
}

/** Runs the chat namer the way a finished round does. */
const nameNow = (chats: ChatService, chatId: string, model: string) =>
  (chats as unknown as { _nameChat(chatId: string, model: string): Promise<void> })._nameChat(chatId, model)

test("an older chat the person named in an earlier round's colony keeps their name", async () => {
  const { SettingsStore } = await import('../src/settings.ts')
  const settings = new SettingsStore(home)
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/asker', [
    [tool('ask_user', { question: 'Which format do you want?' })],
    ['waiting'],
  ])
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), settings })
  const { chatId, colonyId } = await chats.send('make a report', solo('mock/asker'))
  await waitFor(colonyId)
  await chats.rename(chatId, 'My report')
  // Older chats ran each round in a colony of its own: round 2 here, without the rename.
  const created = (await events(colonyId)).find((e) => e.type === 'colony/created')
  const payload = structuredClone(created?.payload) as EventPayloads['colony/created']
  if (payload.chat) payload.chat = { ...payload.chat, round: 2, request: 'now as a PDF' }
  await runtime.ctx.log.appendOne(newColonyId(), {
    type: 'colony/created',
    actor: { kind: 'user', id: 'user' },
    payload,
  })
  const calls = namer(resolver, 'mock/titler', 'Auto name')
  await nameNow(chats, chatId, 'mock/titler')
  expect(calls.n).toBe(0)
  expect((await chats.list()).find((c) => c.chatId === chatId)?.title).toBe('My report')
  await chats.stopAll()
})

test('a chat deleted while it is being named stays deleted', async () => {
  const { SettingsStore } = await import('../src/settings.ts')
  const settings = new SettingsStore(home)
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/asker', [
    [tool('ask_user', { question: 'Which format do you want?' })],
    ['waiting'],
  ])
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), settings })
  const { chatId, colonyId } = await chats.send('make a report', solo('mock/asker'))
  await waitFor(colonyId)
  let open = () => {}
  const calls = namer(resolver, 'mock/titler', 'Quarterly report', new Promise<void>((r) => (open = r)))
  const naming = nameNow(chats, chatId, 'mock/titler')
  while (calls.n === 0) await Bun.sleep(5)
  expect(await chats.delete(chatId)).toEqual([colonyId])
  open()
  await naming
  expect(existsSync(join(home, 'colonies', colonyId))).toBe(false)
  expect(await chats.list()).toEqual([])
  await chats.stopAll()
})

async function reviewerRound(mode: 'off' | 'auto' | 'always', script: Step[]) {
  const { SettingsStore } = await import('../src/settings.ts')
  const settings = new SettingsStore(home)
  settings.set({ ...settings.get(), verification: { ...settings.get().verification, reviewer: mode } })
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/solo', script)
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), settings })
  const { colonyId } = await chats.send('Write a poem', { ...solo('mock/solo'), judgeModel: 'mock/judge' })
  const s = await waitFor(colonyId)
  const log = await events(colonyId)
  await chats.stopAll()
  const reviews = log.filter((e) => e.type === 'verifier/requested').map((e) => e.seq)
  const final = log.find((e) => e.type === 'chat/reply')?.seq ?? 0
  return { s, reviews, final }
}

test('reviewer off: the final answer completes the round unreviewed', async () => {
  const { s, reviews } = await reviewerRound('off', [[tool('reply_user', { text: 'A poem.', final: true })]])
  expect(s.status).toBe('completed')
  expect(reviews).toEqual([])
  expect(s.agents.lead?.info.tools).not.toContain('request_review')
  expect(s.verdicts.map((v) => v.verifierId)).toEqual(['delivered'])
})

test('reviewer auto: the lead asks for a review when it wants one, and the final answer completes the round', async () => {
  const asked = await reviewerRound('auto', [
    [tool('request_review', { summary: 'the poem is in the reply' })],
    [tool('reply_user', { text: 'A poem.', final: true })],
  ])
  expect(asked.s.status).toBe('completed')
  expect(asked.s.agents.lead?.info.tools).toContain('request_review')
  expect(asked.reviews).toHaveLength(1)
  expect(asked.reviews[0]).toBeLessThan(asked.final)
  const skipped = await reviewerRound('auto', [[tool('reply_user', { text: 'Hi.', final: true })]])
  expect(skipped.s.status).toBe('completed')
  expect(skipped.reviews).toEqual([])
})

test('reviewer always: every final answer is reviewed before the round completes', async () => {
  const { s, reviews, final } = await reviewerRound('always', [
    [tool('reply_user', { text: 'A poem.', final: true })],
  ])
  expect(s.status).toBe('completed')
  expect(s.agents.lead?.info.tools).not.toContain('request_review')
  expect(reviews).toHaveLength(1)
  expect(reviews[0]).toBeGreaterThan(final)
})

test('a message said on a call reaches the lead marked as spoken, with what the chat does not show', async () => {
  const resolver = new ModelResolver()
  let seen = ''
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      seen = JSON.stringify(ctx.messages)
      return {
        content: seen.includes('reply_user')
          ? ['done']
          : [tool('reply_user', { text: 'It went well.', final: true })],
      }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const { colonyId } = await chats.send(
    'how did the call go',
    { ...solo('mock/lead'), judgeModel: 'mock/judge' },
    undefined,
    {
      voice: true,
      context: 'CALL TRANSCRIPT: [18:32] Person: Hello.',
    },
  )
  await waitFor(colonyId)
  expect(seen).toContain('CALL TRANSCRIPT: [18:32] Person: Hello.')
  expect(seen).toContain('Said aloud on a voice call')
  const user = (await events(colonyId)).find((e) => e.type === 'chat/user')
  // The chat shows the person's words; the transcript was for the agents.
  expect(user?.payload).toMatchObject({ text: 'how did the call go', voice: true })
  await chats.stopAll()
})

test('a chat is named from what it is about once there is something to name, and a given name is kept', async () => {
  const { SettingsStore } = await import('../src/settings.ts')
  const settings = new SettingsStore(home)
  const resolver = new ModelResolver()
  const lead = createMockModel({
    handler: (ctx: LlmContext) => {
      const sys = ctx.systemPrompt?.join('\n') ?? ''
      const seen = JSON.stringify(ctx.messages)
      if (sys.includes('You name conversations'))
        return { content: [seen.includes('sales') ? '{"title": "Weekly sales summary"}' : '{"title": null}'] }
      return {
        content: seen.includes('reply_user')
          ? ['done']
          : [tool('reply_user', { text: 'Hello!', final: true })],
      }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), settings })
  const team = { ...solo('mock/lead'), judgeModel: 'mock/judge' }
  const first = await chats.send('hi', team)
  await waitFor(first.colonyId)
  await Bun.sleep(50)
  // "hi" has nothing to name: the chat keeps its first message for now.
  expect((await chats.list()).find((c) => c.chatId === first.chatId)?.title).toBe('hi')
  const second = await chats.send('summarize this week’s sales', team, first.chatId)
  await waitFor(second.colonyId, (x) => x.rounds.length === 2 && x.rounds.at(-1)?.status === 'completed')
  const named = async () => (await chats.list()).find((c) => c.chatId === first.chatId)?.title
  const end = Date.now() + 3000
  while ((await named()) !== 'Weekly sales summary' && Date.now() < end) await Bun.sleep(20)
  expect(await named()).toBe('Weekly sales summary')
  // A name the person gives is theirs: later rounds do not rename it.
  await chats.rename(first.chatId, 'Sales')
  const third = await chats.send('and last week’s sales?', team, first.chatId)
  await waitFor(third.colonyId, (x) => x.rounds.length === 3 && x.rounds.at(-1)?.status === 'completed')
  await Bun.sleep(50)
  expect(await named()).toBe('Sales')
  await chats.stopAll()
})

test('a chat is named on the cheapest model the person can use, and on the lead’s when that one fails', async () => {
  const { SettingsStore } = await import('../src/settings.ts')
  const settings = new SettingsStore(home)
  const available = [
    { provider: 'mock', id: 'lead', cost: { input: 3 }, contextWindow: 200_000 },
    { provider: 'cheap', id: 'namer-mini', cost: { input: 0.1 }, contextWindow: 128_000 },
    // Cheaper still, but the person hid it.
    { provider: 'cheap', id: 'hidden-nano', cost: { input: 0.01 }, contextWindow: 128_000 },
  ]
  settings.set({ ...settings.get(), models: { ...settings.get().models, hidden: ['cheap/hidden-nano'] } })
  const resolver = new ModelResolver({ available: () => available } as unknown as OmpRuntime)
  const namedBy: string[] = []
  let cheapWorks = true
  const answer = (who: string) => (ctx: LlmContext) => {
    const sys = ctx.systemPrompt?.join('\n') ?? ''
    if (sys.includes('You name conversations')) {
      namedBy.push(who)
      if (who === 'cheap' && !cheapWorks) throw new Error('key revoked')
      return { content: [`{"title": "Named by ${who}"}`] }
    }
    return { content: [tool('reply_user', { text: 'Hello!', final: true })] }
  }
  for (const [ref, who] of [
    ['mock/lead', 'lead'],
    ['cheap/namer-mini', 'cheap'],
    ['cheap/hidden-nano', 'hidden'],
  ] as const) {
    const m = createMockModel({ handler: answer(who) })
    resolver.register(ref, { model: m.model, streamFn: m.stream })
  }
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), settings })
  const team = { ...solo('mock/lead'), judgeModel: 'mock/judge' }
  const title = async (chatId: string, want: string) => {
    const now = async () => (await chats.list()).find((c) => c.chatId === chatId)?.title
    const end = Date.now() + 3000
    while ((await now()) !== want && Date.now() < end) await Bun.sleep(20)
    return now()
  }
  const first = await chats.send('plan the offsite', team)
  await waitFor(first.colonyId)
  expect(await title(first.chatId, 'Named by cheap')).toBe('Named by cheap')
  expect(namedBy).toEqual(['cheap'])
  cheapWorks = false
  const second = await chats.send('book the venue', team)
  await waitFor(second.colonyId)
  expect(await title(second.chatId, 'Named by lead')).toBe('Named by lead')
  expect(namedBy).toEqual(['cheap', 'cheap', 'lead'])
  await chats.stopAll()
})

test('a photo sent without words is still a message: it says what was sent, and the file is there', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [[tool('reply_user', { text: 'Nice photo.', final: true })]])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo') })
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
  const { colonyId } = await chats.send('', { ...solo('mock/lead'), judgeModel: 'mock/judge' }, undefined, {
    attachments: [{ name: 'photo-6.jpg', bytes: jpeg }],
  })
  const s = await waitFor(colonyId)
  const user = (await events(colonyId)).find((e) => e.type === 'chat/user')
  expect(user?.payload).toMatchObject({ text: '(sent photo-6.jpg)' })
  expect(Object.keys(s.artifacts).some((name) => name.endsWith('photo-6.jpg'))).toBe(true)
  // Neither words nor files is still nothing to send.
  await expect(chats.send('  ', { ...solo('mock/lead'), judgeModel: 'mock/judge' })).rejects.toThrow(
    'message is empty',
  )
  await chats.stopAll()
})

test('the spend limit is per run: a follow-up gets all of it again, and a run that hits it says so', async () => {
  const { SettingsStore } = await import('../src/settings.ts')
  const settings = new SettingsStore(home)
  // A home with no settings file starts at the $5 default.
  expect(settings.get().team.costUsd).toBe(5)
  settings.set({ ...settings.get(), team: { ...settings.get().team, costUsd: 1 } })
  const resolver = new ModelResolver()
  let overspend = false
  const lead = createMockModel({
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    handler: () => ({
      content: overspend
        ? [tool('message', { to: 'team', text: 'still working' })]
        : [tool('reply_user', { text: 'Done.', final: true })],
      usage: { input: 400, output: 100, cost: { total: 0.6 } },
    }),
  })
  resolver.register('mock/priced', { model: lead.model, streamFn: lead.stream })
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: fixed('solo'), settings })
  const config = { ...solo('mock/priced'), judgeModel: 'mock/judge' }
  const first = await chats.send('First question', config)
  expect((await waitFor(first.colonyId)).status).toBe('completed')
  // The chat has now spent $0.60 in all; the follow-up's $0.60 is under its own $1, though the total is not.
  const second = await chats.send('Second question', config, first.chatId)
  const s2 = await waitFor(second.colonyId, (x) => x.rounds.length === 2 && x.status !== 'running')
  expect(s2.status).toBe('completed')
  overspend = true
  const third = await chats.send('Keep going', config, first.chatId)
  const s3 = await waitFor(third.colonyId, (x) => x.rounds.length === 3 && x.status !== 'running')
  expect(s3.status).toBe('stopped')
  expect(s3.statusReason).toBe('spend limit reached: $1.20 of $1 for this run')
  // Resumed, it counts at most half the limit as spent, like the clock, so it can go on for a while.
  await chats.resume(first.chatId)
  const resumed = await waitFor(
    third.colonyId,
    (x) => x.status === 'stopped' && x.statusReason !== s3.statusReason,
  )
  expect(resumed.statusReason).toBe('spend limit reached: $1.10 of $1 for this run')
  await chats.stopAll()
})
