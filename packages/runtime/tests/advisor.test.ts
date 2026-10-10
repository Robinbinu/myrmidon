import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, emptyColonyState, foldColony } from '@myrmidon/protocol'
import type { AgentMessage } from '@oh-my-pi/pi-agent-core'
import type { Context as LlmContext } from '@oh-my-pi/pi-ai'
import { createMockModel, type MockContent, type MockResponse } from '@oh-my-pi/pi-ai/providers/mock'
import { removeTempDir } from '../../../tests/platform.ts'
import { Advisor, type AdvisorHost, parseAdvice } from '../src/advisor.ts'
import { ADVISOR } from '../src/config.ts'
import {
  bootRuntime,
  ChatService,
  type Classify,
  ModelResolver,
  type Runtime,
  type TeamConfig,
} from '../src/index.ts'
import type { AgentSpec, ColonySpec } from '../src/spec.ts'

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-advisor-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  removeTempDir(home)
})

const tool = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})

const NOTE = 'You edited notes, but the request names app.ts and you have not opened it.'
const ADVISORY = '<advisory'

/** A model answering each call with the next step; steps may wait (on the advisor) and read the conversation. */
function scripted(
  resolver: ModelResolver,
  ref: string,
  script: ((ctx: LlmContext) => MockContent[] | Promise<MockContent[]>)[],
) {
  let call = 0
  const mock = createMockModel({
    handler: async (ctx: LlmContext) => {
      const step = script[call++]
      return { content: step ? await step(ctx) : ['ok'] }
    },
  })
  resolver.register(ref, { model: mock.model, streamFn: mock.stream })
}

/** The advisor's model: each call answers with the next reply (the last one repeats), counted. */
function advisorModel(resolver: ModelResolver, replies: readonly (string | MockResponse)[]) {
  const seen: LlmContext[] = []
  let first!: () => void
  const called = new Promise<void>((resolve) => {
    first = resolve
  })
  const mock = createMockModel({
    handler: (ctx: LlmContext) => {
      seen.push(ctx)
      first()
      const reply = replies[Math.min(seen.length, replies.length) - 1] ?? '{"note": null}'
      return typeof reply === 'string' ? { content: [reply] } : reply
    },
  })
  resolver.register('mock/advisor', { model: mock.model, streamFn: mock.stream })
  return { seen, called }
}

function judge(resolver: ModelResolver) {
  const m = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "complete"}'] }) })
  resolver.register('mock/judge', { model: m.model, streamFn: m.stream })
}

const solo: Classify = async () => 'solo'

function config(advisor?: string): TeamConfig {
  return {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [],
    judgeModel: 'mock/judge',
    ...(advisor ? { advisorModel: advisor } : {}),
  }
}

async function finished(colonyId: string): Promise<ColonyState> {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (s.status !== 'running' && s.status !== 'created') return s
    await Bun.sleep(50)
  }
  throw new Error('the round did not finish')
}

const advised = async (colonyId: string) =>
  (await runtime.ctx.log.read(colonyId as never))
    .filter((e) => e.type === 'agent/advised')
    .map((e) => e.payload as EventPayloads['agent/advised'])

const shows = (messages: string, text: string) => messages.includes(text)

/**
 * A lead that works in three tool steps and then answers. Its second step waits for the advisor to have answered
 * its first review, so a note (if any) is in by the step after; `contexts` keeps what each step was shown.
 */
function lead(resolver: ModelResolver, waitFor?: Promise<void>) {
  const contexts: string[] = []
  const keep = (ctx: LlmContext) => void contexts.push(JSON.stringify(ctx.messages))
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      keep(ctx)
      return [tool('append_note', { text: 'Plan: edit the notes.', section: 'plan' })]
    },
    async (ctx) => {
      keep(ctx)
      if (waitFor) await waitFor
      // The review's reply and its note's log entry land a moment after the advisor's model is called.
      await Bun.sleep(100)
      return [tool('append_note', { text: 'Edited the notes.' })]
    },
    (ctx) => {
      keep(ctx)
      return [tool('append_note', { text: 'Checked the notes.' })]
    },
    (ctx) => {
      keep(ctx)
      return [tool('reply_user', { text: 'Done: the notes are updated.', final: true })]
    },
  ])
  return contexts
}

test('advisor off (the default): no advisor calls, no notes', async () => {
  const resolver = new ModelResolver()
  const adv = advisorModel(resolver, [`{"note": "${NOTE}", "kind": "wrong-target"}`])
  const contexts = lead(resolver)
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: 300 })
  const { colonyId } = await chats.send('Fix the bug in app.ts', config())
  expect((await finished(colonyId)).status).toBe('completed')
  expect(adv.seen).toHaveLength(0)
  expect(await advised(colonyId)).toEqual([])
  expect(contexts.some((c) => shows(c, ADVISORY))).toBe(false)
})

test('a step with a problem gets one steering note, read at a later step and logged for the UI', async () => {
  const resolver = new ModelResolver()
  const adv = advisorModel(resolver, [`{"note": "${NOTE}", "kind": "wrong-target"}`, '{"note": null}'])
  const contexts = lead(resolver, adv.called)
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: 300 })
  const { colonyId } = await chats.send('Fix the bug in app.ts', config('mock/advisor'))
  expect((await finished(colonyId)).status).toBe('completed')
  // It reviewed what the lead was asked and the call it made.
  const review = JSON.stringify(adv.seen[0]?.messages)
  expect(review).toContain('Fix the bug in app.ts')
  expect(review).toContain('append_note')
  expect(await advised(colonyId)).toEqual([
    { agent: 'lead', model: 'mock/advisor', note: NOTE, kind: 'wrong-target' },
  ])
  // Not in the step it was about, but in a later one, once, framed as advice to weigh.
  expect(shows(contexts[0] ?? '', ADVISORY)).toBe(false)
  const later = contexts.slice(2)
  expect(later.some((c) => shows(c, NOTE))).toBe(true)
  const last = contexts.at(-1) ?? ''
  expect(last.split(ADVISORY).length - 1).toBe(1)
  expect(last).toContain('[advisor]')
})

test('a review with nothing to say injects nothing and logs nothing', async () => {
  const resolver = new ModelResolver()
  const adv = advisorModel(resolver, ['{"note": null}'])
  const contexts = lead(resolver, adv.called)
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: solo, quietMs: 300 })
  const { colonyId } = await chats.send('Fix the bug in app.ts', config('mock/advisor'))
  expect((await finished(colonyId)).status).toBe('completed')
  expect(adv.seen.length).toBeGreaterThanOrEqual(1)
  expect(await advised(colonyId)).toEqual([])
  expect(contexts.some((c) => shows(c, ADVISORY))).toBe(false)
})

test('a team round: the advisor watches the lead and its crewmates alike', async () => {
  const resolver = new ModelResolver()
  const adv = advisorModel(resolver, ['{"note": null}'])
  scripted(resolver, 'mock/lead', [
    () => [
      tool('append_note', { text: 'Plan: the writer drafts poem.txt; I review it.', section: 'plan' }),
      tool('create_task', { subject: 'Write a four-line poem about ants', outputs: ['poem.txt'] }),
    ],
    () => ['waiting for the writer'],
    () => [tool('reply_user', { text: 'Done: poem.txt has the poem.', final: true })],
  ])
  scripted(resolver, 'mock/writer', [
    () => [tool('claim_task', { id: 'task-1', revision: 1 })],
    () => [tool('publish_artifact', { name: 'poem.txt', content: 'Small and many,\nwe carry the hill.\n' })],
    () => [tool('submit_task', { id: 'task-1', revision: 2, artifacts: ['poem.txt'] })],
    () => ['done'],
  ])
  judge(resolver)
  const chats = new ChatService(runtime, { resolver, classify: async () => 'team', quietMs: 300 })
  const { colonyId } = await chats.send('Write a short poem about ants', {
    ...config('mock/advisor'),
    roster: [{ role: 'writer', model: 'mock/writer' }],
  })
  expect((await finished(colonyId)).status).toBe('completed')
  const views = adv.seen.map((c) => String(c.messages[0]?.content))
  expect(views.some((v) => v.includes('AGENT: lead, the lead'))).toBe(true)
  expect(views.some((v) => /AGENT: \S+, a worker \(writer\)/.test(v))).toBe(true)
  // The writer's view carries the task it holds.
  expect(views.some((v) => v.includes('- Write a four-line poem about ants [in_progress]'))).toBe(true)
})

// The cost caps, on the advisor alone with a round that only reports its budget and spend.

const AGENT: AgentSpec = { name: 'ada', role: 'worker', model: 'mock/worker' }
const STEPS = [
  { role: 'user', content: 'Update src/app.ts', timestamp: 1 },
  {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'c1', name: 'fs_read', arguments: { path: 'src/ap.ts' } }],
    timestamp: 2,
  },
  {
    role: 'toolResult',
    toolCallId: 'c1',
    toolName: 'fs_read',
    content: [{ type: 'text', text: 'ENOENT: no such file' }],
    isError: true,
    timestamp: 3,
  },
] as unknown as AgentMessage[]

function round(budget: ColonySpec['budget'], spent = { cost: 0, tokens: 0 }) {
  const logged: unknown[] = []
  const host: AdvisorHost = {
    spec: { name: 'r', mission: 'Update src/app.ts', budget } as ColonySpec,
    state: () => emptyColonyState('c'),
    spent: () => spent,
    append: async (draft) => {
      logged.push(draft.payload)
      return {} as never
    },
  }
  return { host, logged }
}

test('the advisor stops at its call cap per round', async () => {
  const resolver = new ModelResolver()
  const adv = advisorModel(resolver, ['{"note": null}'])
  const { host } = round({ wallMs: 60_000, maxTurns: 40 })
  const advisor = new Advisor(host, resolver, 'mock/advisor')
  for (let i = 0; i < ADVISOR.callsPerRound + 5; i++) await advisor.stepEnded(AGENT, STEPS, () => {})
  expect(adv.seen).toHaveLength(ADVISOR.callsPerRound)
  expect(advisor.calls).toBe(ADVISOR.callsPerRound)
  // It saw the failed call: the path it read and the error it got.
  const view = String(adv.seen[0]?.messages[0]?.content)
  expect(view).toContain('src/ap.ts')
  expect(view).toContain('[fs_read failed] ENOENT')
})

test('the advisor stays quiet once the round nears its limit, counting its own tokens', async () => {
  const resolver = new ModelResolver()
  const near = round({ wallMs: 60_000, maxTurns: 40, tokens: 1_000 }, { cost: 0, tokens: 900 })
  const adv = advisorModel(resolver, [{ content: ['{"note": null}'], usage: { totalTokens: 300 } }])
  await new Advisor(near.host, resolver, 'mock/advisor').stepEnded(AGENT, STEPS, () => {})
  expect(adv.seen).toHaveLength(0)
  // From nothing spent, its own 300 tokens a call reach 80% of 1,000 after three calls.
  const fresh = new Advisor(
    round({ wallMs: 60_000, maxTurns: 40, tokens: 1_000 }).host,
    resolver,
    'mock/advisor',
  )
  for (let i = 0; i < 6; i++) await fresh.stepEnded(AGENT, STEPS, () => {})
  expect(fresh.calls).toBe(3)
})

test('the same note is sent to an agent once, and is logged once', async () => {
  const resolver = new ModelResolver()
  advisorModel(resolver, [`{"note": "${NOTE}", "kind": "ignored-error"}`])
  const { host, logged } = round({ wallMs: 60_000, maxTurns: 40 })
  const advisor = new Advisor(host, resolver, 'mock/advisor')
  const notes: string[] = []
  for (let i = 0; i < 3; i++) await advisor.stepEnded(AGENT, STEPS, (n) => notes.push(n))
  expect(notes).toEqual([NOTE])
  expect(logged).toEqual([{ agent: 'ada', model: 'mock/advisor', note: NOTE, kind: 'ignored-error' }])
})

test('advice parsing: silence, a note, an unknown kind, and replies that are not the JSON asked for', () => {
  expect(parseAdvice('{"note": null}')).toBeUndefined()
  expect(parseAdvice('{"note": "  "}')).toBeUndefined()
  expect(parseAdvice('nothing to add')).toBeUndefined()
  expect(parseAdvice('{"note": ')).toBeUndefined()
  expect(parseAdvice('Here: {"note": "Re-run the test.", "kind": "unverified"}')).toEqual({
    note: 'Re-run the test.',
    kind: 'unverified',
  })
  expect(parseAdvice('{"note": "Stop.", "kind": "vibes"}')).toEqual({ note: 'Stop.' })
  expect(parseAdvice(`{"note": "${'x'.repeat(1_000)}"}`)?.note).toHaveLength(ADVISOR.noteChars)
})
