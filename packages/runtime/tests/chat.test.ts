import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foldColony } from '@myrmidon/protocol'
import type { Context as LlmContext } from '@oh-my-pi/pi-ai'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import { bootRuntime, ChatService, ModelResolver, type Runtime } from '../src/index.ts'

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

function scripted(resolver: ModelResolver, ref: string, script: MockContent[][]) {
  const mock = createMockModel({
    handler: (ctx: LlmContext) => ({
      content: script[ctx.messages.filter((m) => m.role === 'assistant').length] ?? ['ok'],
    }),
  })
  resolver.register(ref, { model: mock.model, streamFn: mock.stream })
}

test('a chat request plans, spawns a worker, answers, verifies, and carries files into the next round', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [
    [tool('reply_user', { text: 'Plan: a writer drafts the poem, I review.' })],
    [tool('spawn_worker', { name: 'writer', focus: 'Write a four-line poem about ants into poem.txt' })],
    ['waiting for the writer'],
    [tool('reply_user', { text: 'Done: poem.txt contains the poem.', final: true })],
    [tool('request_final_verification', { summary: 'poem.txt' })],
  ])
  scripted(resolver, 'mock/worker', [
    [tool('publish_artifact', { name: 'poem.txt', content: 'Small and many,\nwe carry the hill.\n' })],
    [tool('post', { text: '@lead poem.txt is published' })],
  ])
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "complete"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })

  const chats = new ChatService(runtime, { resolver })
  const config = {
    mode: 'auto' as const,
    leadModel: 'mock/lead',
    workerModel: 'mock/worker',
    workers: 2,
    judgeModel: 'mock/judge',
  }
  const first = await chats.send('Write a short poem about ants', config)
  expect(first.started).toBe(true)

  const waitFor = async (colonyId: string) => {
    for (let i = 0; i < 300; i++) {
      const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
      if (s.status !== 'running' && s.status !== 'created') return s
      await Bun.sleep(50)
    }
    throw new Error('colony did not finish')
  }
  const round1 = await waitFor(first.colonyId)
  expect(round1.status).toBe('completed')
  expect(Object.keys(round1.agents).sort()).toEqual(['lead', 'writer'])
  expect(round1.chatMessages.map((m) => m.from)).toEqual(['user', 'lead', 'lead'])
  expect(round1.chatMessages.at(-1)?.final).toBe(true)
  expect(round1.artifacts['poem.txt']?.at(-1)?.author).toBe('writer')

  const second = await chats.send('Now make it rhyme', config, first.chatId)
  expect(second.colonyId).not.toBe(first.colonyId)
  const round2 = await waitFor(second.colonyId)
  expect(round2.chat?.round).toBe(2)
  expect(round2.artifacts['poem.txt']?.[0]?.author).toBe('previous-round')

  const list = await chats.list()
  expect(list).toHaveLength(1)
  expect(list[0]?.rounds.map((r) => r.round)).toEqual([1, 2])
  expect(list[0]?.title).toBe('Write a short poem about ants')
})

test('a round that ends with a question waits for the user instead of stalling', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/greeter', [
    [tool('reply_user', { text: 'Hi! What should I build?' })],
    ['waiting'],
  ])
  const chats = new ChatService(runtime, { resolver })
  const config = {
    mode: 'auto' as const,
    leadModel: 'mock/greeter',
    workerModel: 'mock/greeter',
    workers: 0,
    judgeModel: 'mock/greeter',
  }
  const { colonyId } = await chats.send('hi', config)
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (s.status === 'stopped') {
      expect(s.statusReason).toBe('awaiting your reply')
      expect(s.signals.filter((x) => x.kind === 'stall')).toHaveLength(0)
      return
    }
    await Bun.sleep(50)
  }
  throw new Error('round did not end')
})

test('deleting a chat removes every round and its data', async () => {
  const { existsSync } = await import('node:fs')
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/brief', [[tool('reply_user', { text: 'Which format do you want?' })], ['waiting']])
  const chats = new ChatService(runtime, { resolver })
  const config = {
    mode: 'auto' as const,
    leadModel: 'mock/brief',
    workerModel: 'mock/brief',
    workers: 0,
    judgeModel: 'mock/brief',
  }
  const { chatId, colonyId } = await chats.send('make a report', config)
  const dir = join(home, 'colonies', colonyId)
  expect(existsSync(dir)).toBe(true)
  const deleted = await chats.delete(chatId)
  expect(deleted).toEqual([colonyId])
  expect(existsSync(dir)).toBe(false)
  expect(await chats.list()).toEqual([])
})
