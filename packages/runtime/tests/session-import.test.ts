import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, foldColony } from '@myrmidon/protocol'
import { IMPORT_HISTORY_CHARS } from '../src/config.ts'
import {
  bootRuntime,
  ChatService,
  ChatShelf,
  type Classify,
  fitTurns,
  type ImportedTurn,
  importedConversation,
  ModelResolver,
  ProjectStore,
  type Runtime,
  SessionImports,
  type TeamConfig,
} from '../src/index.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel } from '../src/omp/mock.ts'

let home: string
let roots: string
let runtime: Runtime | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'myr-import-'))
  roots = realpathSync.native(mkdtempSync(join(tmpdir(), 'myr-import-roots-')))
})

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  rmSync(home, { recursive: true, force: true })
  rmSync(roots, { recursive: true, force: true })
})

const KEY = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789'
const jsonl = (records: readonly unknown[]) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`

/** A Claude Code session in `<root>/projects/<encoded cwd>/<id>.jsonl`, as Claude Code writes one. */
function claudeSession(
  cwd: string,
  id = '11111111-1111-4111-8111-111111111111',
  when = '2026-10-01T10:00:00Z',
) {
  const dir = join(roots, 'claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const base = { sessionId: id, cwd, timestamp: when }
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(
    file,
    jsonl([
      { type: 'summary', summary: 'Login bug summary', leafUuid: 'a2' },
      {
        ...base,
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        message: { role: 'user', content: 'Fix the login bug in auth.ts' },
      },
      {
        ...base,
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: {
          id: 'msg-1',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          stop_reason: 'tool_use',
          content: [
            { type: 'thinking', thinking: 'The check looks inverted.', signature: 'sig' },
            { type: 'text', text: 'Let me look at the file.' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'cat auth.ts' } },
          ],
        },
      },
      {
        ...base,
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: `const KEY = '${KEY}'` }],
        },
      },
      {
        ...base,
        type: 'user',
        uuid: 'u3',
        parentUuid: 'u2',
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' },
      },
      {
        ...base,
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u3',
        message: {
          id: 'msg-2',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Fixed: the token check was inverted.' }],
        },
      },
      {
        ...base,
        type: 'user',
        uuid: 'u4',
        parentUuid: 'a2',
        message: { role: 'user', content: '<command-name>/model</command-name>' },
      },
      { type: 'custom-title', customTitle: 'Login bug', sessionId: id },
    ]),
  )
  const at = new Date(when)
  utimesSync(file, at, at)
  return file
}

/** A Codex rollout in `<root>/sessions/YYYY/MM/DD/`, with no state database (the fallback listing). */
function codexSession(
  cwd: string,
  id = '22222222-2222-4222-8222-222222222222',
  when = '2026-10-02T10:00:00Z',
) {
  const dir = join(roots, 'codex', 'sessions', '2026', '10', '02')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-10-02T10-00-00-${id}.jsonl`)
  const item = (payload: unknown) => ({ timestamp: when, type: 'response_item', payload })
  writeFileSync(
    file,
    jsonl([
      {
        timestamp: when,
        type: 'session_meta',
        payload: { id, timestamp: when, cwd, originator: 'codex_cli_rs' },
      },
      item({
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>' },
        ],
      }),
      item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Rename foo to bar' }] }),
      { timestamp: when, type: 'event_msg', payload: { type: 'user_message', message: 'Rename foo to bar' } },
      item({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Search first.' }] }),
      item({
        type: 'function_call',
        name: 'shell',
        arguments: '{"command":["rg","foo"]}',
        call_id: 'call-1',
      }),
      item({ type: 'function_call_output', call_id: 'call-1', output: 'a.ts:1:foo' }),
      item({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Renamed foo to bar.' }],
      }),
    ]),
  )
  const at = new Date(when)
  utimesSync(file, at, at)
  return file
}

const imports = (projects?: ProjectStore) =>
  new SessionImports(home, {
    ...(projects ? { projects } : {}),
    claudeRoot: join(roots, 'claude'),
    codexRoot: join(roots, 'codex'),
  })

test('Claude Code sessions convert to user, assistant and tool turns, without thinking, commands or secrets', async () => {
  const project = join(roots, 'app')
  mkdirSync(project)
  claudeSession(project)
  const session = await imports().import('claude', '11111111-1111-4111-8111-111111111111')
  expect(session.title).toBe('Login bug')
  expect(session.cwd).toBe(project)
  expect(session.omitted).toBe(0)
  expect(session.turns).toEqual([
    { role: 'user', text: 'Fix the login bug in auth.ts' },
    { role: 'assistant', text: 'Let me look at the file.' },
    { role: 'tool', tool: 'Bash', text: 'cat auth.ts', result: "const KEY = '[api key redacted]'" },
    { role: 'assistant', text: 'Fixed: the token check was inverted.' },
  ])
  expect(JSON.stringify(session)).not.toContain(KEY)
})

test('Codex rollouts convert too: environment context and duplicate event records are left out', async () => {
  codexSession('/elsewhere/repo')
  const session = await imports().import('codex', '22222222-2222-4222-8222-222222222222')
  expect(session.cwd).toBe('/elsewhere/repo')
  expect(session.turns).toEqual([
    { role: 'user', text: 'Rename foo to bar' },
    { role: 'tool', tool: 'shell', text: 'rg foo', result: 'a.ts:1:foo' },
    { role: 'assistant', text: 'Renamed foo to bar.' },
  ])
  // A rollout without a title is named after what the person asked.
  expect(session.title).toBe('Rename foo to bar')
})

test('listing reads both tools, newest first, with titles, first messages and the project holding each folder', async () => {
  const folder = join(roots, 'app')
  mkdirSync(join(folder, 'src'), { recursive: true })
  const projects = new ProjectStore(home)
  const app = projects.add(folder)
  claudeSession(join(folder, 'src'))
  codexSession('/elsewhere/repo')
  const list = await imports(projects).list()
  expect(list.map((s) => s.source)).toEqual(['codex', 'claude'])
  const [codex, claude] = list
  expect(codex).toMatchObject({
    id: '22222222-2222-4222-8222-222222222222',
    cwd: '/elsewhere/repo',
    preview: 'Rename foo to bar',
  })
  expect(codex?.project).toBeUndefined()
  expect(claude).toMatchObject({
    title: 'Login bug',
    preview: 'Fix the login bug in auth.ts',
    updatedAt: '2026-10-01T10:00:00.000Z',
    project: { id: app.id, name: app.name },
  })
  expect(claude?.bytes).toBeGreaterThan(0)
  await expect(imports().import('claude', 'nope')).rejects.toThrow('no such session')
})

test('a long conversation keeps its latest messages within the size the round reads, counting what it left out', () => {
  const turns: ImportedTurn[] = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: `${i} ${'x'.repeat(1_000)}`,
  }))
  const fit = fitTurns(turns)
  expect(fit.omitted).toBeGreaterThan(0)
  expect(fit.omitted + fit.turns.length).toBe(200)
  expect(fit.turns.at(-1)?.text.startsWith('199 ')).toBe(true)
  const history = importedConversation({
    id: 'import-x',
    source: 'claude',
    sourceId: 's',
    title: 't',
    cwd: '/w',
    updatedAt: '',
    importedAt: '',
    ...fit,
  })
  expect(history.length).toBeLessThan(IMPORT_HISTORY_CHARS + 1_000)
  expect(history).toContain(`the ${fit.omitted} earliest messages left out`)
})

const solo = (model: string): TeamConfig => ({
  mode: 'orchestrated',
  leadModel: model,
  roster: [],
  judgeModel: model,
})
const answerOnly: Classify = async () => 'answer'

async function waitFor(rt: Runtime, colonyId: string): Promise<ColonyState> {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await rt.ctx.log.read(colonyId as never))
    if (s.status !== 'running' && s.status !== 'created') return s
    await Bun.sleep(25)
  }
  throw new Error('the round did not end')
}

test('a chat started from an import sees its conversation in the first round; deleting the chat forgets the import', async () => {
  runtime = await bootRuntime(home)
  const project = join(roots, 'app')
  mkdirSync(project)
  claudeSession(project)
  const store = imports()
  const session = await store.import('claude', '11111111-1111-4111-8111-111111111111')

  const asked: string[] = []
  const resolver = new ModelResolver()
  const mock = createMockModel({
    handler: (ctx: LlmContext) => {
      asked.push(JSON.stringify(ctx))
      return { content: ['Adding the test now.'] }
    },
  })
  resolver.register('mock/lead', { model: mock.model, streamFn: mock.stream })
  const shelf = new ChatShelf(home)
  const chats = new ChatService(runtime, { resolver, classify: answerOnly, shelf, imports: store })
  const sent = await chats.send('Now add a test for it', solo('mock/lead'), undefined, {
    importOf: session.id,
  })
  await waitFor(runtime, sent.colonyId)

  const call = asked.at(-1) ?? ''
  expect(call).toContain('This conversation began in Claude Code')
  expect(call).toContain('Fix the login bug in auth.ts')
  expect(call).toContain('Fixed: the token check was inverted.')
  expect(call).toContain('Now add a test for it')
  expect(call).not.toContain(KEY)
  expect(shelf.place(sent.chatId)).toEqual({ importOf: session.id })
  expect((await chats.list()).find((c) => c.chatId === sent.chatId)?.importOf).toBe(session.id)

  await chats.delete(sent.chatId)
  expect(store.get(session.id)).toBeUndefined()
  expect(existsSync(join(home, 'imports', `${session.id}.json`))).toBe(false)
  await expect(
    chats.send('hello', solo('mock/lead'), undefined, { importOf: 'import-gone-1' }),
  ).rejects.toThrow('the imported session is gone')
})
