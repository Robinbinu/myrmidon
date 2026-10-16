import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony } from '@myrmidon/protocol'
import { bootRuntime, ChatService, ModelResolver, type Runtime, type TeamConfig } from '../src/index.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'
import { ProjectStore } from '../src/projects.ts'

let home: string
let runtime: Runtime
const folders: string[] = []

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-recall-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  for (const dir of [home, ...folders.splice(0)]) rmSync(dir, { recursive: true, force: true })
})

const tool = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})

const solo = (model: string): TeamConfig => ({
  mode: 'orchestrated',
  leadModel: model,
  roster: [],
  judgeModel: 'mock/judge',
})

/** Waits for a send's round (not an earlier one of the same colony) to end. */
async function ended(sent: { colonyId: string; round?: number }) {
  return waitFor(
    sent.colonyId,
    (s) => s.rounds.length >= (sent.round ?? 1) && !['running', 'created'].includes(s.status),
  )
}

async function waitFor(
  colonyId: string,
  until = (s: ColonyState) => !['running', 'created'].includes(s.status),
) {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (until(s)) return s
    await Bun.sleep(50)
  }
  throw new Error('colony did not reach the expected state')
}

/** What search_chats returned in a round, in order. */
async function searches(colonyId: string): Promise<{ ok: boolean; output: string }[]> {
  return (await runtime.ctx.log.read(colonyId as never))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
    .filter((p) => p.tool === 'search_chats')
    .map((p) => ({ ok: p.ok, output: p.output }))
}

function project(store: ProjectStore) {
  const dir = mkdtempSync(join(tmpdir(), 'myr-recall-project-'))
  folders.push(dir)
  return store.add(dir)
}

/**
 * A model that answers a plain request at once, and on a request starting "search:" runs the search_chats calls the
 * test queued for it (one per step), then answers.
 */
function setup() {
  const resolver = new ModelResolver()
  const queued: Record<string, unknown>[] = []
  const mock = createMockModel({
    handler: (ctx: LlmContext) => {
      const messages = ctx.messages as { role: string; toolName?: string }[]
      // Each round opens with a message from the person; what came after it is this round's work.
      const opened = messages.findLastIndex((m) => m.role === 'user')
      const since = messages.slice(opened + 1)
      if (since.some((m) => m.toolName === 'reply_user')) return { content: ['done'] }
      const asked = JSON.stringify(messages[opened])
      const done = since.filter((m) => m.toolName === 'search_chats').length
      if (asked.includes('search:') && done < queued.length)
        return { content: [tool('search_chats', queued[done] as Record<string, unknown>)] }
      const said = /\[user\] ([^"\\]+)/.exec(asked)?.[1] ?? 'ok'
      return { content: [tool('reply_user', { text: `Done: ${said.slice(0, 80)}`, final: true })] }
    },
  })
  resolver.register('mock/solo', { model: mock.model, streamFn: mock.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  const projects = new ProjectStore(home)
  const chats = new ChatService(runtime, { resolver, classify: async () => 'solo', projects })
  return { chats, projects, queued }
}

const config = solo('mock/solo')

test("search_chats reads only this project's chats the person wrote in: never another project's, no project's, a member's or its own", async () => {
  const { chats, projects, queued } = setup()
  const p = project(projects)
  const q = project(projects)
  const inP = await chats.send('Build the rate limiter with the pluto token bucket', config, undefined, {
    project: p.id,
  })
  await waitFor(inP.colonyId)
  const inQ = await chats.send('Build the rate limiter with the quasar sliding window', config, undefined, {
    project: q.id,
  })
  await waitFor(inQ.colonyId)
  const nowhere = await chats.send('Notes on the rate limiter nebula idea', config)
  await waitFor(nowhere.colonyId)
  // A channel member started this one in Q: the person's other chats are not theirs to read, nor theirs the agents'.
  const member = await chats.send('a member says: rate limiter mercury secret', config, undefined, {
    project: q.id,
    askAll: true,
  })
  await waitFor(member.colonyId)

  queued.push({ query: 'rate limiter' }, { chat: inP.chatId }, { chat: member.chatId }, {})
  const asking = await chats.send('search: extend the rate limiter we built', config, undefined, {
    project: q.id,
  })
  await waitFor(asking.colonyId)
  const [found, otherProject, memberChat, browse] = await searches(asking.colonyId)
  expect(found?.ok).toBe(true)
  expect(found?.output).toContain('quasar sliding window')
  expect(found?.output).toContain(`chat ${inQ.chatId}`)
  for (const leak of ['pluto', 'nebula', 'mercury', 'extend the rate limiter'])
    expect(found?.output).not.toContain(leak)
  // Naming a chat out of scope reads exactly as naming one that does not exist.
  expect(otherProject?.output).toContain('No such chat among the past chats you can read here.')
  expect(otherProject?.output).not.toContain('pluto')
  expect(memberChat?.output).toContain('No such chat among the past chats you can read here.')
  expect(browse?.output).toContain(inQ.chatId)
  expect(browse?.output).not.toContain(inP.chatId)
  expect(browse?.output).not.toContain(member.chatId)

  // A chat in no project reads only chats in none.
  queued.length = 0
  queued.push({ query: 'rate limiter' })
  const loose = await chats.send('search: what did we say about the rate limiter', config)
  await waitFor(loose.colonyId)
  const [outside] = await searches(loose.colonyId)
  expect(outside?.output).toContain('nebula')
  for (const leak of ['pluto', 'quasar', 'mercury']) expect(outside?.output).not.toContain(leak)
  await chats.stopAll()
})

test('a round someone other than the person started cannot search past chats at all', async () => {
  const { chats, projects, queued } = setup()
  const q = project(projects)
  const mine = await chats.send('The deploy password lives in the vault', config, undefined, {
    project: q.id,
  })
  await waitFor(mine.colonyId)
  queued.push({ query: 'deploy password' })
  const member = await chats.send('search: what is the deploy password', config, undefined, {
    project: q.id,
    askAll: true,
  })
  await waitFor(member.colonyId)
  const [refused] = await searches(member.colonyId)
  expect(refused?.ok).toBe(false)
  expect(refused?.output).toContain('not available in this round')
  expect(refused?.output).not.toContain('vault')
  await chats.stopAll()
})

test('search_chats returns real messages with numbers, scrolls around one, and caps long messages and results', async () => {
  const { chats, projects, queued } = setup()
  const q = project(projects)
  const first = await chats.send('Set up the parser for the orchid format', config, undefined, {
    project: q.id,
  })
  await waitFor(first.colonyId)
  const long = `orchid ${'x'.repeat(5_000)}`
  await ended(await chats.send(long, config, first.chatId))
  await ended(await chats.send('Rename the orchid parser to bloom', config, first.chatId))

  queued.push({ query: 'orchid parser' }, { chat: first.chatId, around: 5 }, { chat: first.chatId })
  const asking = await chats.send('search: carry on with the orchid parser', config, undefined, {
    project: q.id,
  })
  await waitFor(asking.colonyId)
  const [found, scrolled, read] = await searches(asking.colonyId)
  // The person's own words come back as they were written, numbered for a scroll.
  expect(found?.output).toContain('#1 person')
  expect(found?.output).toContain('Set up the parser for the orchid format')
  expect(found?.output).toContain('Rename the orchid parser to bloom')
  expect(scrolled?.output).toContain('#5 person')
  expect(scrolled?.output).toContain('#3 person')
  // A message is cut, never returned whole: a read shows at most 2,000 of its characters.
  expect(read?.output).toContain('[3007 more chars]')
  expect(read?.output.length).toBeLessThan(12_200)
  await chats.stopAll()
})
