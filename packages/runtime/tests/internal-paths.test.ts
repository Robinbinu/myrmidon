import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, foldColony } from '@myrmidon/protocol'
import { bootRuntime, ChatService, ModelResolver, type Runtime, type TeamConfig } from '../src/index.ts'
import { internalPath } from '../src/internal-paths.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-paths-'))
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
  leadModel: 'mock/agent',
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

/** Runs `script` one step at a time; returns each step's tool result text as the agent saw it. */
async function run(script: MockContent[][]): Promise<string[]> {
  const resolver = new ModelResolver()
  const results: string[] = []
  let step = 0
  const agent = createMockModel({
    handler: (ctx: LlmContext) => {
      const last = ctx.messages.at(-1) as { role: string; content?: { type: string; text?: string }[] }
      if (last?.role === 'toolResult') results.push((last.content ?? []).map((c) => c.text ?? '').join('\n'))
      return { content: script[step++] ?? [call('reply_user', { text: 'Done.', final: true })] }
    },
  })
  resolver.register('mock/agent', { model: agent.model, streamFn: agent.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  const chats = new ChatService(runtime, { resolver, classify: async () => 'solo' })
  const { colonyId } = await chats.send('Resolve the merge', config)
  await ended(colonyId)
  await chats.stopAll()
  return results
}

const CONFLICTED = [
  'header',
  '<<<<<<< HEAD',
  'const port = 3000',
  '=======',
  'const port = 8080',
  '>>>>>>> feature',
  'middle',
  '<<<<<<< HEAD',
  'log("ours")',
  '=======',
  'log("theirs")',
  '>>>>>>> feature',
  'footer',
].join('\n')

test('internal paths are told apart from file paths by their scheme', () => {
  expect(internalPath('pr://12')).toEqual({ scheme: 'pr', rest: '12' })
  expect(internalPath('conflict://*')).toEqual({ scheme: 'conflict', rest: '*' })
  expect(internalPath('skill://release-notes/template.md')?.scheme).toBe('skill')
  expect(internalPath('src/pr.ts')).toBeUndefined()
  expect(internalPath('https://example.com')).toBeUndefined()
})

test('a read numbers merge conflicts; conflict://N reads one side and fs_write resolves one or all of them', async () => {
  const results = await run([
    [call('fs_write', { path: 'server.ts', content: CONFLICTED })],
    [call('fs_read', { path: 'server.ts' })],
    [call('fs_read', { path: 'conflict://1/theirs' })],
    [call('fs_read', { path: 'conflict://*' })],
    [call('fs_write', { path: 'conflict://1/ours', content: 'x' })],
    [call('fs_write', { path: 'conflict://1', content: '@ours' })],
    [call('fs_write', { path: 'conflict://*', content: '2: @theirs' })],
    [call('fs_read', { path: 'server.ts' })],
    [call('fs_write', { path: 'pr://3', content: 'x' })],
    [call('fs_read', { path: 'agent://lead' })],
    [call('fs_read', { path: 'skill://' })],
  ])
  // The read: the file, then omp's footer naming both blocks, in fs_read/fs_write terms.
  expect(results[1]).toContain('⚠ 2 unresolved conflicts detected')
  expect(results[1]).toContain('──── #1  L2-6 ────')
  expect(results[1]).toContain('──── #2  L8-12 ────')
  expect(results[1]).toContain('fs_write({ path: "conflict://<N>", content })')
  // One side, with its file line numbers.
  expect(results[2]).toMatch(/^\s+5\tconst port = 8080$/)
  expect(results[3]).toContain('conflict://* is write-only')
  expect(results[4]).toContain('conflict://1/ours is read-only')
  expect(results[5]).toContain('Resolved conflict #1 in server.ts.')
  expect(results[6]).toContain('Resolved conflict #2 in server.ts.')
  // Only the marker blocks were replaced: ours for #1, theirs for #2, the lines around them untouched.
  expect(results[7]).toContain('1:header\n2:const port = 3000\n3:middle\n4:log("theirs")\n5:footer')
  expect(results[7]).not.toContain('unresolved')
  expect(results[8]).toContain('pr:// is read-only')
  expect(results[9]).toContain('lead (lead, mock/agent): working')
  expect(results[10]).toContain('Skills (read skill://<name>)')
})
