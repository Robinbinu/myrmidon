import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony } from '@myrmidon/protocol'
import { bootRuntime, ChatService, ModelResolver, type Runtime, type TeamConfig } from '../src/index.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-checkpoint-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(home, { recursive: true, force: true })
})

const call = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})

const config: TeamConfig = {
  mode: 'orchestrated',
  leadModel: 'mock/explorer',
  roster: [],
  judgeModel: 'mock/judge',
}

async function ended(colonyId: string): Promise<ColonyState> {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (!['running', 'created'].includes(s.status)) return s
    await Bun.sleep(25)
  }
  throw new Error('the round did not end')
}

type Seen = { role: string; toolName?: string; content?: unknown }[]

/** An agent that runs `script` step by step, keeping the context each model call was sent. */
function setup(script: MockContent[][]) {
  const resolver = new ModelResolver()
  const contexts: Seen[] = []
  let step = 0
  const agent = createMockModel({
    handler: (ctx: LlmContext) => {
      contexts.push(structuredClone(ctx.messages) as Seen)
      const next = script[step++]
      return { content: next ?? [call('reply_user', { text: 'Done.', final: true })] }
    },
  })
  resolver.register('mock/explorer', { model: agent.model, streamFn: agent.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  const chats = new ChatService(runtime, { resolver, classify: async () => 'solo' })
  return { chats, contexts }
}

const text = (m: Seen[number]) => JSON.stringify(m.content)

test('rewind folds the exploration since the checkpoint into the report, in the context and the transcript', async () => {
  const { chats, contexts } = setup([
    [call('fs_write', { path: 'notes.txt', content: 'the parser lives in src/parse.ts' })],
    [call('checkpoint', { goal: 'find where the parser lives' })],
    [call('fs_read', { path: 'notes.txt' })],
    [call('fs_list', {})],
    [call('rewind', { report: 'The parser is src/parse.ts (from notes.txt).' })],
  ])
  const { colonyId } = await chats.send('Where does the parser live?', config)
  const s = await ended(colonyId)
  // The call after the rewind: the checkpoint step, then the report, and none of the exploration.
  const after = contexts[5] ?? []
  expect(after.some((m) => m.toolName === 'checkpoint')).toBe(true)
  expect(
    after.some((m) => m.toolName === 'fs_read' || m.toolName === 'fs_list' || m.toolName === 'rewind'),
  ).toBe(false)
  const last = after.at(-1)
  expect(last?.role).toBe('user')
  expect(text(last ?? { role: '' })).toContain('Report:\\nThe parser is src/parse.ts')
  // Work from before the checkpoint stays.
  expect(after.some((m) => m.toolName === 'fs_write')).toBe(true)
  const events = await runtime.ctx.log.read(colonyId as never)
  const rewound = events.find((e) => e.type === 'agent/rewound')?.payload as EventPayloads['agent/rewound']
  expect(rewound).toMatchObject({ agent: 'lead', goal: 'find where the parser lives', dropped: 6 })
  // A resume reads the folded context too.
  const transcript = readFileSync(join(home, 'colonies', colonyId, 'agents', 'lead.jsonl'), 'utf8')
  expect(transcript).not.toContain('"toolName":"fs_list"')
  expect(transcript).toContain('The parser is src/parse.ts')
  expect(s.chatMessages.at(-1)?.text).toBe('Done.')
  await chats.stopAll()
})

test('one checkpoint at a time, no rewind without one, and an agent stopping with one open is told to rewind', async () => {
  const { chats, contexts } = setup([
    [call('rewind', { report: 'nothing' })],
    [call('checkpoint', { goal: 'look around' })],
    [call('checkpoint', { goal: 'again' })],
    // Stops with plain text while the checkpoint is open.
    [{ type: 'text', text: 'Looked around.' }],
    [call('rewind', { report: 'Nothing to find.' })],
    [call('rewind', { report: 'twice' })],
  ])
  const { colonyId } = await chats.send('Have a look', config)
  await ended(colonyId)
  const results = (n: number) => (contexts[n] ?? []).filter((m) => m.role === 'toolResult').map(text)
  expect(results(1).at(-1)).toContain('No active checkpoint')
  expect(results(3).at(-1)).toContain('Checkpoint already active')
  expect(text(contexts[4]?.at(-1) ?? { role: '' })).toContain('MUST `rewind` before yielding')
  expect(results(6).at(-1)).toContain('Checkpoint already completed')
  await chats.stopAll()
})
