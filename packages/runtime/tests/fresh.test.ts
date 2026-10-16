import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, foldColony } from '@myrmidon/protocol'
import { bootRuntime, ChatService, ModelResolver, type Runtime, type TeamConfig } from '../src/index.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel } from '../src/omp/mock.ts'

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-fresh-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(home, { recursive: true, force: true })
})

const config: TeamConfig = {
  mode: 'orchestrated',
  leadModel: 'mock/agent',
  roster: [],
  judgeModel: 'mock/judge',
}

async function until(colonyId: string, done: (s: ColonyState) => boolean): Promise<ColonyState> {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (done(s)) return s
    await Bun.sleep(25)
  }
  throw new Error('the round did not get there')
}
const ended = (s: ColonyState) => !['running', 'created'].includes(s.status)

/** An agent that answers each message; `hold` keeps its next reply waiting until released. */
function setup() {
  const resolver = new ModelResolver()
  const calls: { sessionId?: string; messages: number }[] = []
  let hold: Promise<void> | undefined
  const agent = createMockModel({
    handler: async (ctx: LlmContext, options) => {
      calls.push({ sessionId: options?.sessionId, messages: ctx.messages.length })
      if (hold) await hold
      return { content: [{ type: 'toolCall', name: 'reply_user', arguments: { text: 'ok', final: true } }] }
    },
  })
  resolver.register('mock/agent', { model: agent.model, streamFn: agent.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  const chats = new ChatService(runtime, { resolver, classify: async () => 'solo' })
  return {
    chats,
    calls,
    holdNext() {
      let release = () => {}
      hold = new Promise<void>((r) => {
        release = r
      })
      return () => {
        hold = undefined
        release()
      }
    },
  }
}

test('/fresh starts a new provider session for the chat, keeps the conversation, and holds in later rounds', async () => {
  const { chats, calls } = setup()
  const first = await chats.send('Hello', config)
  await until(first.colonyId, ended)
  // Before any reset nothing new is sent: no session id, as before.
  expect(calls.every((c) => c.sessionId === undefined)).toBe(true)
  expect(await chats.fresh(first.chatId)).toEqual({ closed: 0 })
  const s = foldColony(first.colonyId, await runtime.ctx.log.read(first.colonyId as never))
  expect(s.freshes).toBe(1)
  const before = calls.length
  const second = await chats.send('And again', config, first.chatId)
  await until(second.colonyId, (x) => x.rounds.length === 2 && ended(x))
  const next = calls.slice(before)
  expect(next[0]?.sessionId).toMatch(/\/lead\/fresh-1-/)
  // The conversation came back whole: the first round's messages are still in the context.
  expect(next[0]?.messages ?? 0).toBeGreaterThan(calls[0]?.messages ?? 0)
  // A second reset is a new session again.
  await chats.fresh(first.chatId)
  const third = await chats.send('Once more', config, first.chatId)
  await until(third.colonyId, (x) => x.rounds.length === 3 && ended(x))
  const id = calls.at(-1)?.sessionId ?? ''
  expect(id).toMatch(/\/lead\/fresh-2-/)
  expect(id).not.toBe(next[0]?.sessionId)
  await chats.stopAll()
})

test('/fresh is refused while an agent is mid-reply, as omp refuses while streaming', async () => {
  const { chats, calls, holdNext } = setup()
  const release = holdNext()
  const { chatId, colonyId } = await chats.send('Hello', config)
  for (let i = 0; i < 200 && calls.length === 0; i++) await Bun.sleep(10)
  await expect(chats.fresh(chatId)).rejects.toThrow('wait for the current step to finish')
  release()
  await until(colonyId, ended)
  await chats.stopAll()
})
