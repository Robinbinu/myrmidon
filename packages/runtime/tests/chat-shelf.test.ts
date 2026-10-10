import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, foldColony } from '@myrmidon/protocol'
import type { Context as LlmContext } from '@oh-my-pi/pi-ai'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import {
  bootRuntime,
  ChatService,
  ChatShelf,
  type Classify,
  ModelResolver,
  type Runtime,
  type TeamConfig,
} from '../src/index.ts'

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-shelf-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(home, { recursive: true, force: true })
})

const at = (iso: string) => new Date(iso)

test('a chat is pinned, archived and filed in a group, each taken back on its own', () => {
  const shelf = new ChatShelf(home)
  const work = shelf.addGroup('  Client   work ')
  expect(work.name).toBe('Client work')
  expect(shelf.file('chat-a', { pinned: true }, at('2026-10-10T10:00:00Z'))).toEqual({
    pinnedAt: '2026-10-10T10:00:00.000Z',
  })
  // Pinning again keeps when it was first pinned, so the order of pins holds.
  shelf.file('chat-a', { pinned: true, group: work.id }, at('2026-10-10T11:00:00Z'))
  expect(shelf.place('chat-a')).toEqual({ pinnedAt: '2026-10-10T10:00:00.000Z', group: work.id })
  shelf.file('chat-a', { archived: true, pinned: false }, at('2026-10-10T12:00:00Z'))
  expect(shelf.place('chat-a')).toEqual({ archivedAt: '2026-10-10T12:00:00.000Z', group: work.id })
  shelf.file('chat-a', { archived: false, group: null })
  expect(shelf.place('chat-a')).toEqual({})
  expect(() => shelf.file('chat-a', { group: 'group-nope' })).toThrow('no such group')
})

test('groups are renamed and removed; a removed group lets its chats go back to their project or date', () => {
  const shelf = new ChatShelf(home)
  const a = shelf.addGroup('Later')
  const b = shelf.addGroup('Now')
  shelf.file('chat-a', { group: a.id, pinned: true })
  shelf.file('chat-b', { group: b.id })
  expect(shelf.renameGroup(a.id, 'Someday')).toEqual({ id: a.id, name: 'Someday' })
  shelf.removeGroup(a.id)
  expect(shelf.groups()).toEqual([b])
  expect(shelf.place('chat-a').group).toBeUndefined()
  expect(shelf.place('chat-a').pinnedAt).toBeDefined()
  expect(shelf.place('chat-b').group).toBe(b.id)
  expect(() => shelf.addGroup('   ')).toThrow('needs a name')
  expect(() => shelf.addGroup('x'.repeat(41))).toThrow('at most 40')
  shelf.forget(['chat-b'])
  expect(shelf.place('chat-b')).toEqual({})
})

test('a broken shelf file files nothing instead of failing the chat list', () => {
  writeFileSync(join(home, 'chat-shelf.json'), '{ not json')
  const shelf = new ChatShelf(home)
  expect(shelf.groups()).toEqual([])
  expect(shelf.place('chat-a')).toEqual({})
})

const solo = (model: string): TeamConfig => ({
  mode: 'orchestrated',
  leadModel: model,
  roster: [],
  judgeModel: model,
})
const answerOnly: Classify = async () => 'answer'

async function waitFor(colonyId: string): Promise<ColonyState> {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (s.status !== 'running' && s.status !== 'created') return s
    await Bun.sleep(25)
  }
  throw new Error('the round did not end')
}

test('the chat list shows where each chat is filed; deleting a chat forgets it', async () => {
  const resolver = new ModelResolver()
  const mock = createMockModel({ handler: () => ({ content: ['Done.'] }) })
  resolver.register('mock/lead', { model: mock.model, streamFn: mock.stream })
  const shelf = new ChatShelf(home)
  const chats = new ChatService(runtime, { resolver, classify: answerOnly, shelf })
  const { chatId, colonyId } = await chats.send('tidy the notes', solo('mock/lead'))
  await waitFor(colonyId)
  await expect(chats.file('chat-unknown-1', { pinned: true })).rejects.toThrow('no such chat')
  await chats.file(chatId, { pinned: true, archived: true })
  const [listed] = await chats.list()
  expect(listed?.pinnedAt).toBeDefined()
  expect(listed?.archivedAt).toBeDefined()
  await chats.delete(chatId)
  expect(shelf.place(chatId)).toEqual({})
})

test('a fork starts from the conversation it came from, and the original chat is left as it was', async () => {
  const resolver = new ModelResolver()
  const asked: string[] = []
  let call = 0
  const mock = createMockModel({
    handler: (ctx: LlmContext) => {
      asked.push(JSON.stringify(ctx))
      const replies: MockContent[][] = [['The capital of France is Paris.'], ['About 2.1 million people.']]
      return { content: replies[call++] ?? ['ok'] }
    },
  })
  resolver.register('mock/lead', { model: mock.model, streamFn: mock.stream })
  const shelf = new ChatShelf(home)
  const chats = new ChatService(runtime, { resolver, classify: answerOnly, shelf })
  const first = await chats.send('What is the capital of France?', solo('mock/lead'))
  await waitFor(first.colonyId)

  const fork = await chats.send('And how many people live there?', solo('mock/lead'), undefined, {
    forkOf: first.chatId,
  })
  await waitFor(fork.colonyId)
  expect(fork.chatId).not.toBe(first.chatId)
  // The fork's lead read the earlier question and answer before the new one.
  const forkCall = asked.at(-1) ?? ''
  expect(forkCall).toContain('What is the capital of France?')
  expect(forkCall).toContain('The capital of France is Paris.')
  expect(shelf.place(fork.chatId)).toEqual({ forkOf: first.chatId })
  const list = await chats.list()
  expect(list.find((c) => c.chatId === first.chatId)?.rounds).toHaveLength(1)
  expect(list.find((c) => c.chatId === fork.chatId)?.forkOf).toBe(first.chatId)

  await expect(chats.send('hello', solo('mock/lead'), undefined, { forkOf: 'chat-gone-1' })).rejects.toThrow(
    'the chat to fork is gone',
  )
})
