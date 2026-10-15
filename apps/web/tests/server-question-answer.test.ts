import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, foldColony } from '@myrmidon/protocol'
import { bootRuntime, ChatService, ModelResolver, type Runtime } from '@myrmidon/runtime'
import type { Context as LlmContext } from '../../../packages/runtime/src/omp/ai.ts'
import { createMockModel, type MockContent } from '../../../packages/runtime/src/omp/mock.ts'
import { startServer, type WebServer } from '../src/server.ts'

const homes: string[] = []
const servers: WebServer[] = []
const runtimes: Runtime[] = []
const services: ChatService[] = []
afterEach(async () => {
  for (const c of services.splice(0)) await c.stopAll()
  for (const s of servers.splice(0)) await s.stop()
  for (const r of runtimes.splice(0)) await r.dispose()
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

const questions = [
  { question: 'Who is the site for?', options: [{ label: 'Me' }, { label: 'A studio' }] },
  { question: 'Which pages?', options: [{ label: 'Work' }, { label: 'About' }], multiSelect: true },
]
const answer = {
  text: 'Who is the site for? → Me\nWhich pages? → Work, About',
  picks: [
    { picked: ['Me'], skipped: false },
    { picked: ['Work', 'About'], skipped: false },
  ],
}
const config = { mode: 'orchestrated', leadModel: 'mock/lead', judgeModel: 'mock/lead', roster: [] }

/**
 * The real server and chat runtime with a scripted lead: it asks with options, then (once `gate` opens) ends its turn,
 * and on its next call replies with what it was told, as an agent picking the work back up does.
 */
async function setup(gate: Promise<unknown> = Promise.resolve()) {
  const home = mkdtempSync(join(tmpdir(), 'myr-question-'))
  homes.push(home)
  const runtime = await bootRuntime(home)
  runtimes.push(runtime)
  const heard: string[] = []
  const script: ((ctx: LlmContext) => MockContent[])[] = [
    () => [{ type: 'toolCall', name: 'ask_user', arguments: { question: 'Before I start:', questions } }],
    () => ['waiting'],
    (ctx) => {
      heard.push(JSON.stringify(ctx.messages.at(-1)))
      return [
        { type: 'toolCall', name: 'reply_user', arguments: { text: 'Building it for you.', final: true } },
      ]
    },
  ]
  let call = 0
  const mock = createMockModel({
    handler: (ctx: LlmContext) => ({ content: (script[call++] ?? (() => ['ok']))(ctx) }),
  })
  const resolver = new ModelResolver()
  let calls = 0
  resolver.register('mock/lead', {
    model: mock.model,
    // The turn after asking is held at `gate`, the way a slow model keeps the round running after a question.
    streamFn: (async (...args: Parameters<typeof mock.stream>) => {
      if (++calls === 2) await gate
      return mock.stream(...args)
    }) as unknown as typeof mock.stream,
  })
  const chats = new ChatService(runtime, { resolver, classify: async () => 'solo' })
  services.push(chats)
  const server = startServer({ home, port: 0, chats })
  servers.push(server)
  const post = async (body: unknown) => {
    const res = await fetch(new URL('/api/chats', server.url.replace(/#.*$/, '')), {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return {
      status: res.status,
      body: (await res.json()) as { chatId: string; colonyId: string; started: boolean },
    }
  }
  const first = await post({ text: 'build me a site', config })
  const state = async () =>
    foldColony(first.body.colonyId, await runtime.ctx.log.read(first.body.colonyId as never))
  const until = async (ok: (s: ColonyState) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const s = await state()
      if (ok(s)) return s
      await Bun.sleep(25)
    }
    throw new Error(`the colony did not get there: ${JSON.stringify((await state()).chatMessages)}`)
  }
  return { first: first.body, post, state, until, heard }
}

test('answering a question card after the round paused resumes the agent with the answers', async () => {
  const { first, post, until, heard } = await setup()
  const paused = await until((s) => s.status === 'stopped')
  expect(paused.statusReason).toBe('awaiting your reply')
  const asked = paused.chatMessages.at(-1)
  expect(asked?.choices).toEqual(questions)

  const sent = await post({
    text: answer.text,
    chatId: first.chatId,
    config,
    delivery: 'steer',
    answers: { seq: asked?.seq, picks: answer.picks },
  })
  expect(sent.status).toBe(200)
  expect(sent.body).toMatchObject({ chatId: first.chatId, colonyId: first.colonyId, started: true })

  const done = await until((s) => s.chatMessages.some((m) => m.text === 'Building it for you.'))
  // The answer is kept with the question it answers, so the card shows it after a reload.
  expect(done.chatMessages.find((m) => m.from === 'user' && m.answers)).toMatchObject({
    text: answer.text,
    answers: { seq: asked?.seq, picks: answer.picks },
  })
  // The lead picked the work back up in the next round, hearing exactly what was answered.
  expect(done.rounds.map((r) => r.round)).toEqual([1, 2])
  expect(heard).toHaveLength(1)
  expect(JSON.parse(heard[0] ?? '{}')).toMatchObject({
    role: 'user',
    content: [{ type: 'text', text: `[user] ${answer.text}` }],
  })
}, 20_000)

test('a question answered before the asking turn ends steers the running round', async () => {
  let open = () => {}
  const { first, post, state, until, heard } = await setup(new Promise<void>((r) => (open = r)))
  const asked = (await until((s) => s.chatMessages.some((m) => m.question))).chatMessages.at(-1)
  expect((await state()).status).toBe('running')

  const sent = await post({
    text: answer.text,
    chatId: first.chatId,
    config,
    delivery: 'steer',
    answers: { seq: asked?.seq, picks: answer.picks },
  })
  expect(sent.status).toBe(200)
  expect(sent.body).toMatchObject({ colonyId: first.colonyId, started: false })
  open()

  const done = await until((s) => s.chatMessages.some((m) => m.text === 'Building it for you.'))
  // One round: the answer reached the lead mid-round, and the round never paused on a question already answered.
  expect(done.rounds).toHaveLength(1)
  expect(done.chatMessages.find((m) => m.answers)?.answers).toEqual({
    seq: asked?.seq ?? -1,
    picks: answer.picks,
  })
  expect(done.rounds[0]?.statusReason).not.toBe('awaiting your reply')
  // Steered in, the answer is the next thing the lead reads.
  expect(heard).toHaveLength(1)
  expect(heard[0]).toContain(JSON.stringify(`[user] ${answer.text}`).slice(1, -1))
  expect(done.chatMessages.filter((m) => m.from === 'lead').map((m) => m.text)).toEqual([
    'Before I start:',
    'Building it for you.',
  ])
}, 20_000)
