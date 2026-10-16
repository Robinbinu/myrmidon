import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony } from '@myrmidon/protocol'
import { bootRuntime, ChatService, ModelResolver, type Runtime, type TeamConfig } from '../src/index.ts'
import { MemoryStore } from '../src/memory.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'
import { ProjectStore } from '../src/projects.ts'
import { SettingsStore } from '../src/settings.ts'

let home: string
let runtime: Runtime
const folders: string[] = []

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-continue-'))
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

const config: TeamConfig = {
  mode: 'orchestrated',
  leadModel: 'mock/solo',
  roster: [],
  judgeModel: 'mock/judge',
}

async function waitFor(colonyId: string, until: (s: ColonyState) => boolean, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (until(s)) return s
    await Bun.sleep(50)
  }
  throw new Error('colony did not reach the expected state')
}

const ended = (s: ColonyState) => !['running', 'created'].includes(s.status)

const NOTE = '## Done\n- Added src/parse.ts on 2026-10-15\n\n## Waiting on the person\n- "Keep the old API?"'

/**
 * One mock for every call: the lead writes two files and answers; the cheap jobs (the note of where a chat left off,
 * memory suggestions, project summaries) answer by their system prompt. Records what each call was sent.
 */
function setup(opts: { note?: string } = {}) {
  const resolver = new ModelResolver()
  const seen = { kickoffs: [] as string[], systems: [] as string[], notes: 0, summaries: [] as string[] }
  const mock = createMockModel({
    handler: (ctx: LlmContext) => {
      const system = ctx.systemPrompt?.join('\n') ?? ''
      if (system.includes('the note a chat in Myrmidon keeps')) {
        seen.notes++
        return { content: [opts.note ?? NOTE] }
      }
      if (system.includes('pick out what is worth remembering')) return { content: ['{"memories": []}'] }
      if (system.includes('You summarize the memories')) {
        seen.summaries.push(JSON.stringify(ctx.messages))
        return { content: ['## Conventions\n- Tests run with bun test'] }
      }
      const messages = ctx.messages as { role: string; toolName?: string; content?: unknown }[]
      const opened = messages.findLastIndex((m) => m.role === 'user')
      const since = messages.slice(opened + 1)
      if (since.some((m) => m.toolName === 'reply_user')) return { content: ['done'] }
      if (!since.length) {
        seen.kickoffs.push(JSON.stringify(messages[opened]))
        seen.systems.push(system)
        return {
          content: [
            tool('fs_write', { path: 'a.txt', content: 'a' }),
            tool('fs_write', { path: 'b.txt', content: 'b' }),
          ],
        }
      }
      return { content: [tool('reply_user', { text: 'Wrote a.txt and b.txt.', final: true })] }
    },
  })
  resolver.register('mock/solo', { model: mock.model, streamFn: mock.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  const settings = new SettingsStore(home)
  settings.set({ ...settings.get(), profile: { ...settings.get().profile, titles: 'first-message' } })
  const memory = new MemoryStore(home)
  const projects = new ProjectStore(home)
  const chats = new ChatService(runtime, {
    resolver,
    classify: async () => 'solo',
    settings,
    memory,
    projects,
    handoffMs: 100,
  })
  return { chats, seen, settings, memory, projects }
}

test('a chat that did real work notes where it left off once quiet, and a fork that does not remember it starts from the note', async () => {
  const { chats, seen } = setup()
  const first = await chats.send('Write the parser files', config)
  const s = await waitFor(first.colonyId, (x) => x.handoff !== undefined)
  expect(s.handoff).toMatchObject({ round: 1, text: NOTE })
  expect(seen.notes).toBe(1)
  const logged = (await runtime.ctx.log.read(first.colonyId as never)).find((e) => e.type === 'chat/handoff')
  expect(logged?.actor).toEqual({ kind: 'system', id: 'myrmidon' })
  expect((logged?.payload as EventPayloads['chat/handoff'] | undefined)?.text).toBe(NOTE)

  // A fork starts in a colony of its own: its agent has none of the conversation, so it gets the history and the note.
  const fork = await chats.send('carry on', config, undefined, { forkOf: first.chatId })
  await waitFor(fork.colonyId, ended)
  const kickoff = seen.kickoffs.at(-1) ?? ''
  expect(kickoff).toContain('Where this chat left off')
  expect(kickoff).toContain('Keep the old API?')
  expect(kickoff).toContain('Earlier in this conversation, for reference')
  // The note goes to the opening message, never the system prompt every call carries.
  expect(seen.systems.at(-1)).not.toContain('Where this chat left off')
  await chats.stopAll()
})

test('a follow-up whose agent remembers the chat gets no note, and a round that starts first cancels the pending one', async () => {
  const { chats, seen } = setup()
  const first = await chats.send('Write the parser files', config)
  await waitFor(first.colonyId, ended)
  // Sent before the chat went quiet: no note is written for the first round.
  const next = await chats.send('Now the tests', config, first.chatId)
  await waitFor(next.colonyId, (x) => x.rounds.length === 2 && ended(x))
  expect(seen.kickoffs.at(-1)).not.toContain('Where this chat left off')
  const s = await waitFor(first.colonyId, (x) => x.handoff !== undefined)
  // Only the latest round is noted, once.
  expect(s.handoff?.round).toBe(2)
  expect(seen.notes).toBe(1)
  await chats.stopAll()
})

test('with nothing to pick up the note is not written, and with the setting off no call is made', async () => {
  const quiet = setup({ note: 'NOTHING' })
  const a = await quiet.chats.send('Write the parser files', config)
  await waitFor(a.colonyId, ended)
  await Bun.sleep(400)
  expect(quiet.seen.notes).toBe(1)
  expect(foldColony(a.colonyId, await runtime.ctx.log.read(a.colonyId as never)).handoff).toBeUndefined()
  await quiet.chats.stopAll()

  const off = setup()
  off.settings.set({ ...off.settings.get(), memory: { ...off.settings.get().memory, handoffs: false } })
  const b = await off.chats.send('Write the parser files', config)
  await waitFor(b.colonyId, ended)
  await Bun.sleep(400)
  expect(off.seen.notes).toBe(0)
  await off.chats.stopAll()
})

test('search_chats shows where a past chat left off', async () => {
  const { chats } = setup()
  const first = await chats.send('Write the parser files', config)
  await waitFor(first.colonyId, (x) => x.handoff !== undefined)
  const index = (chats as unknown as { index: import('../src/chat-index.ts').ChatIndex }).index
  await index.rounds(() => undefined)
  const { recallChats } = await import('../src/chat-recall.ts')
  const read = recallChats(index, { project: undefined, chatId: 'other' }, { chat: first.chatId })
  expect(read).toContain('Where it left off')
  expect(read).toContain('Keep the old API?')
  await chats.stopAll()
})

test('a project with more memories than a prompt carries starts from a summary built only from the ones kept', async () => {
  const { chats, seen, settings, memory, projects } = setup()
  settings.set({
    ...settings.get(),
    memory: { ...settings.get().memory, suggest: false, projectSummaries: true },
  })
  const dir = mkdtempSync(join(tmpdir(), 'myr-continue-project-'))
  folders.push(dir)
  const project = projects.add(dir)
  for (let i = 0; i < 20; i++)
    memory.add({
      text: `Convention number ${i} for the build`,
      kind: 'fact',
      project: project.id,
      status: 'active',
      source: { by: 'person' },
    })
  memory.add({
    text: 'An unreviewed idea about deploys',
    kind: 'fact',
    project: project.id,
    status: 'proposed',
    source: { by: 'agent', agent: 'lead' },
  })
  const first = await chats.send('Write the parser files', config, undefined, { project: project.id })
  await waitFor(first.colonyId, ended)
  // The first round does not wait for the summary; it is built meanwhile, from kept memories only.
  for (let i = 0; i < 100 && !seen.summaries.length; i++) await Bun.sleep(20)
  expect(seen.summaries).toHaveLength(1)
  expect(seen.summaries[0]).toContain('Convention number 19')
  expect(seen.summaries[0]).not.toContain('unreviewed idea')
  // None of the memories shares a word with the request, so the prompt carries none of them yet.
  expect(seen.systems.at(-1)).not.toContain('<project_memory_summary>')
  await Bun.sleep(100)
  const second = await chats.send('Write more files', config, undefined, { project: project.id })
  await waitFor(second.colonyId, ended)
  expect(seen.systems.at(-1)).toContain('<project_memory_summary>\n## Conventions\n- Tests run with bun test')
  // Built once for these memories; a change to them makes it stale.
  expect(seen.summaries).toHaveLength(1)
  await chats.stopAll()
})

test('the suggestion backlog counts what waits, how much was kept, and recalls only a waiting suggestion matched', async () => {
  const memory = new MemoryStore(home)
  const waiting = memory.add({
    text: 'Deploys go through the staging cluster first',
    kind: 'decision',
    status: 'proposed',
    source: { by: 'agent', agent: 'lead' },
  })
  memory.add({ text: 'Prefers pnpm', kind: 'preference', status: 'proposed', source: { by: 'extract' } })
  expect(memory.backlog()).toMatchObject({ waiting: 2, kept: 0, discarded: 0, missed: 0 })
  expect(memory.backlog().oldest).toBe(waiting.createdAt)
  expect(memory.waitingMatches('staging deploys', undefined)).toBe(1)
  expect(memory.waitingMatches('kubernetes', undefined)).toBe(0)
  memory.count('missed')
  memory.keep(waiting.id)
  memory.count('kept')
  expect(memory.backlog()).toMatchObject({ waiting: 1, kept: 1, missed: 1 })
})
