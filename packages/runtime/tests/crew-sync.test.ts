import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony, type MyrEvent } from '@myrmidon/protocol'
import type { Context as LlmContext } from '@oh-my-pi/pi-ai'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import {
  bootRuntime,
  ChatService,
  type Classify,
  ModelResolver,
  type Runtime,
  SettingsStore,
  type TeamConfig,
} from '../src/index.ts'

/**
 * A crew chats like people in a group chat: a round does not end on someone mid-reply, and a message someone never
 * got to read waits for them in the next round instead of leaving them answering old news.
 */

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-sync-'))
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
type Step = MockContent[] | ((ctx: LlmContext) => MockContent[] | Promise<MockContent[]>)

function scripted(resolver: ModelResolver, ref: string, script: Step[]) {
  let call = 0
  const mock = createMockModel({
    handler: async (ctx: LlmContext) => {
      const step = script[call++]
      return { content: typeof step === 'function' ? await step(ctx) : (step ?? ['ok']) }
    },
  })
  resolver.register(ref, { model: mock.model, streamFn: mock.stream })
}

const team: Classify = async () => 'team'
const config: TeamConfig = {
  mode: 'orchestrated',
  leadModel: 'mock/lead',
  roster: [{ role: 'friend', model: 'mock/friend' }],
  judgeModel: 'mock/lead',
}

/** A chat like the person's: a crew talking, nobody reviewing the answer. */
function chatService(resolver: ModelResolver) {
  const settings = new SettingsStore(home)
  settings.set({ ...settings.get(), verification: { ...settings.get().verification, reviewer: 'off' } })
  return new ChatService(runtime, { resolver, classify: team, settings })
}

async function waitFor(colonyId: string, until: (s: ColonyState) => boolean) {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (until(s)) return s
    await Bun.sleep(25)
  }
  throw new Error('colony did not reach the expected state')
}

const events = (colonyId: string) => runtime.ctx.log.read(colonyId as never)
const seqOf = (log: readonly MyrEvent[], test: (e: MyrEvent) => boolean) => log.find(test)?.seq ?? -1
const friendIn = (ctx: LlmContext) =>
  /- ([a-z]+): friend \(/.exec(ctx.systemPrompt?.join('\n') ?? '')?.[1] ?? ''

test('a final answer lets a crewmate finish its reply, and everyone reads it before the round ends', async () => {
  const resolver = new ModelResolver()
  let friend = ''
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [
        tool('create_group', {
          name: 'pub',
          members: [friend],
          text: `@${friend} brains in computers: thoughts?`,
        }),
      ]
    },
    [tool('reply_user', { text: 'We had a good chat.', final: true })],
    ['nice point'],
  ])
  scripted(resolver, 'mock/friend', [
    async () => {
      // Still writing when the lead has already summed up for the person.
      await Bun.sleep(400)
      return [tool('message', { to: 'pub', text: 'Understanding is the bottleneck, not hardware.' })]
    },
    ['done'],
  ])
  const chats = chatService(resolver)
  const { colonyId } = await chats.send('Chat about brains in computers', config)
  const state = await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
  expect(state.statusReason ?? state.status).toBe('completed')
  const log = await events(colonyId)
  const said = log.find(
    (e) =>
      e.type === 'mail/sent' && (e.payload as EventPayloads['mail/sent']).body.startsWith('Understanding'),
  )
  expect(said).toBeDefined()
  const completed = seqOf(log, (e) => e.type === 'colony/completed')
  const final = seqOf(log, (e) => e.type === 'chat/reply')
  // The crewmate's reply came after the final answer and still made it, and the lead read it, before the round closed.
  expect(said?.seq ?? 0).toBeGreaterThan(final)
  const read = seqOf(
    log,
    (e) =>
      e.type === 'mail/delivered' &&
      (e.payload as EventPayloads['mail/delivered']).mail === said?.id &&
      (e.payload as EventPayloads['mail/delivered']).to === 'lead',
  )
  expect(read).toBeGreaterThan(0)
  expect(read).toBeLessThan(completed)
  expect(state.mail.find((m) => m.id === said?.id)?.delivered).toBe(true)
  // Nobody was cut off: the crewmate's turn ended on its own, before completion.
  const friendEnds = log.filter(
    (e) =>
      e.type === 'agent/turn' &&
      (e.payload as EventPayloads['agent/turn']).agent === friend &&
      (e.payload as EventPayloads['agent/turn']).phase === 'end',
  )
  expect(friendEnds.at(0)?.seq ?? Number.POSITIVE_INFINITY).toBeLessThan(completed)
  await chats.stopAll()
})

test('a message a crewmate never read when the round stopped is the first thing it sees in the next round', async () => {
  const resolver = new ModelResolver()
  let friend = ''
  let release = () => {}
  const seen: string[] = []
  scripted(resolver, 'mock/lead', [
    (ctx) => {
      friend = friendIn(ctx)
      return [tool('create_group', { name: 'game', members: [friend], text: `@${friend} is it a book?` })]
    },
    [tool('message', { to: 'game', text: "YES! It's a BOOK!" })],
    ['waiting'],
    // Round 2: a new topic.
    [tool('message', { to: 'game', text: 'New topic: brains in computers.' })],
    ['ok'],
  ])
  scripted(resolver, 'mock/friend', [
    // Round 1: busy with the first message when the answer arrives; the round is stopped before it reads it.
    () =>
      new Promise((resolve) => {
        release = () => resolve(['thinking'])
      }),
    (ctx) => {
      seen.push(JSON.stringify(ctx.messages))
      return ['caught up']
    },
    ['ok'],
  ])
  const chats = chatService(resolver)
  const first = await chats.send('Play twenty questions', config)
  // The answer reached the group while the crewmate was mid-turn.
  await waitFor(first.colonyId, (s) => s.mail.some((m) => m.body.startsWith('YES')))
  const book = (await waitFor(first.colonyId, () => true)).mail.find((m) => m.body.startsWith('YES'))
  await chats.stop(first.chatId)
  release()
  const stopped = await waitFor(first.colonyId, (s) => s.status !== 'running')
  expect(stopped.mail.find((m) => m.id === book?.id)?.readBy).not.toContain(friend)

  const second = await chats.send('Now talk about brains in computers', config, first.chatId)
  const state = await waitFor(
    second.colonyId,
    (s) => seen.length > 0 && s.mail.some((m) => m.body.startsWith('New')),
  )
  // Its first turn of the new round opens with what it missed, marked as older than the new topic.
  const prompt = seen[0] ?? ''
  expect(prompt).toContain('Messages you had not read yet')
  expect(prompt).toContain("YES! It's a BOOK!")
  expect(prompt.indexOf("YES! It's a BOOK!")).toBeLessThan(prompt.indexOf('New topic'))
  await waitFor(
    second.colonyId,
    (s) => s.mail.find((m) => m.id === book?.id)?.readBy.includes(friend) ?? false,
  )
  expect(state.mail.length).toBeGreaterThan(0)
  await chats.stopAll()
})
