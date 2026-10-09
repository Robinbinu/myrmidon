import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony } from '@myrmidon/protocol'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import {
  bootRuntime,
  ChatService,
  ColonyRun,
  type ColonySpec,
  detectSandbox,
  ModelResolver,
  ompWebTools,
  ProjectStore,
  type Runtime,
  type Sandbox,
  SettingsStore,
  type TeamConfig,
} from '../src/index.ts'
import type { OmpRuntime } from '../src/omp/runtime.ts'

let home: string
let outside: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-full-'))
  // A folder that is neither the project nor any agent's scratch: only full access reaches it.
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'myr-outside-')))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(home, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const tool = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})

/** The lead answers each call with the next step; `prompts` collects the system prompts it was given. */
function models(script: MockContent[][]) {
  const resolver = new ModelResolver()
  let call = 0
  const prompts: string[] = []
  const lead = createMockModel({
    handler: (ctx) => {
      prompts.push([ctx.systemPrompt ?? []].flat().join('\n'))
      return { content: script[call++] ?? ['ok'] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "complete"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  return Object.assign(resolver, { prompts })
}

const config: TeamConfig = {
  mode: 'orchestrated',
  leadModel: 'mock/lead',
  roster: [],
  judgeModel: 'mock/judge',
}

async function waitFor(
  colonyId: string,
  until = (s: ColonyState) => s.status !== 'running' && s.status !== 'created',
) {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (until(s)) return s
    await Bun.sleep(50)
  }
  throw new Error('colony did not reach the expected state')
}

const events = (colonyId: string) => runtime.ctx.log.read(colonyId as never)
const results = async (colonyId: string) =>
  (await events(colonyId))
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.payload as EventPayloads['tool/result'])
const created = async (colonyId: string) =>
  (await events(colonyId)).find((e) => e.type === 'colony/created')?.payload as
    | EventPayloads['colony/created']
    | undefined
const pending = (s: ColonyState) => Object.values(s.approvals).filter((a) => !a.decided)

function sandboxOff(store: SettingsStore) {
  store.set({ ...store.get(), sandbox: { enabled: false } })
}

test.skipIf(detectSandbox().kind === 'none')(
  'with the sandbox off a chat runs commands and file tools anywhere; with it on they stay in scratch',
  async () => {
    const settings = new SettingsStore(home)
    const script = (tag: string) => [
      [tool('shell', { command: `touch "${outside}/${tag}-cmd.txt"` })],
      [tool('fs_write', { path: `${outside}/${tag}-file.txt`, content: 'hi' })],
      [tool('fs_read', { path: `${outside}/${tag}-file.txt` })],
      [tool('reply_user', { text: 'Done.', final: true })],
    ]

    sandboxOff(settings)
    const told = models(script('free'))
    const free = new ChatService(runtime, { resolver: told, settings })
    const one = await free.send('Write outside', config)
    const done = await waitFor(one.colonyId)
    expect(done.status).toBe('completed')
    expect(done.fullAccess).toBe(true)
    expect((await created(one.colonyId))?.fullAccess).toBe(true)
    expect(existsSync(join(outside, 'free-cmd.txt'))).toBe(true)
    expect(existsSync(join(outside, 'free-file.txt'))).toBe(true)
    const [shell, write, read] = await results(one.colonyId)
    expect(shell?.output).toStartWith('exit 0')
    expect(write?.ok).toBe(true)
    expect(read?.output).toContain('hi')
    expect((await free.list())[0]?.fullAccess).toBe(true)
    // The lead is told it has full access, so it does not assume a sandbox.
    expect(told.prompts[0]).toContain('full access')
    await free.stopAll()

    settings.set({ ...settings.get(), sandbox: { enabled: true } })
    const boxed = models(script('boxed'))
    const confined = new ChatService(runtime, { resolver: boxed, settings })
    const two = await confined.send('Write outside', config)
    const after = await waitFor(two.colonyId)
    expect(after.fullAccess).toBeUndefined()
    expect((await created(two.colonyId))?.fullAccess).toBeUndefined()
    const [boxedShell, boxedWrite] = await results(two.colonyId)
    expect(boxedShell?.output).not.toStartWith('exit 0')
    expect(boxedWrite?.ok).toBe(false)
    expect(boxedWrite?.output).toContain('outside your scratch directory')
    expect(existsSync(join(outside, 'boxed-cmd.txt'))).toBe(false)
    expect(existsSync(join(outside, 'boxed-file.txt'))).toBe(false)
    expect(boxed.prompts[0]).not.toContain('full access')
    await confined.stopAll()
  },
)

test('a project set to full access has it with the sandbox on; a read-only project never does', async () => {
  const settings = new SettingsStore(home)
  const projects = new ProjectStore(home)
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'myr-full-project-')))
  const viewing = realpathSync(mkdtempSync(join(tmpdir(), 'myr-read-project-')))
  try {
    const full = projects.setPermissions(projects.add(folder).id, { mode: 'full', allow: [] })
    const readOnly = projects.setPermissions(projects.add(viewing).id, { mode: 'read-only', allow: [] })
    const reply = [[tool('reply_user', { text: 'Hi.', final: true })]]

    const chats = new ChatService(runtime, { resolver: models(reply), settings, projects })
    const a = await chats.send('Hello', config, undefined, { project: full.id })
    expect((await waitFor(a.colonyId)).fullAccess).toBe(true)
    await chats.stopAll()

    sandboxOff(settings)
    const others = new ChatService(runtime, { resolver: models(reply), settings, projects })
    const b = await others.send('Hello', config, undefined, { project: readOnly.id })
    expect((await waitFor(b.colonyId)).fullAccess).toBeUndefined()
    expect((await created(b.colonyId))?.fullAccess).toBeUndefined()
    await others.stopAll()
  } finally {
    rmSync(folder, { recursive: true, force: true })
    rmSync(viewing, { recursive: true, force: true })
  }
})

test("a channel member's round stays sandboxed and asking even with the sandbox off", async () => {
  const settings = new SettingsStore(home)
  sandboxOff(settings)
  const resolver = models([
    [tool('fs_write', { path: `${outside}/member.txt`, content: 'x' })],
    [tool('fs_write', { path: 'member.txt', content: 'x' })],
    [tool('reply_user', { text: 'Could not.', final: true })],
  ])
  const chats = new ChatService(runtime, { resolver, settings })
  const { colonyId } = await chats.send('Write outside', config, undefined, { askAll: true })
  // A file change is decided once its path is known: a member's round cannot reach past its scratch, so the write
  // outside is refused before there is anything to ask about; the write it can make still waits for the person.
  const waiting = await waitFor(colonyId, (s) => pending(s).length > 0)
  expect(waiting.fullAccess).toBeUndefined()
  expect((await created(colonyId))?.fullAccess).toBeUndefined()
  const [refused] = await results(colonyId)
  expect(refused?.ok).toBe(false)
  expect(refused?.output).toContain('outside your scratch directory')
  expect(existsSync(join(outside, 'member.txt'))).toBe(false)
  expect(pending(waiting)[0]).toMatchObject({ tool: 'fs_write', why: { by: 'askAll' } })
  // Asked because someone else started the round: no rule could lift that, so the card offers to remember nothing.
  expect(pending(waiting)[0]?.offer).toBeUndefined()
  await chats.decideApproval(colonyId, pending(waiting)[0]?.id ?? '', true)
  await waitFor(colonyId)
  await chats.stopAll()
})

test('full access keeps the approvals the person set: per-tool ask rules, and Ask first beyond the project', async () => {
  const settings = new SettingsStore(home)
  settings.set({ ...settings.get(), sandbox: { enabled: false }, permissions: { fs_write: 'ask' } })
  const resolver = models([
    [tool('fs_write', { path: `${outside}/asked.txt`, content: 'x' })],
    [tool('reply_user', { text: 'Not written.', final: true })],
  ])
  const chats = new ChatService(runtime, { resolver, settings })
  const { colonyId } = await chats.send('Write outside', config)
  const waiting = await waitFor(colonyId, (s) => pending(s).length > 0)
  expect(waiting.fullAccess).toBe(true)
  expect(pending(waiting).map((a) => a.tool)).toEqual(['fs_write'])
  await chats.decideApproval(colonyId, pending(waiting)[0]?.id ?? '', false)
  await waitFor(colonyId)
  expect(existsSync(join(outside, 'asked.txt'))).toBe(false)
  await chats.stopAll()

  // Changed with the permission model: an Ask project used to run unsandboxed under a sandbox-off global and ask
  // before writes beyond it. Its preset is its own now: Ask is sandboxed, so the write outside cannot happen, and a
  // write in the project waits for the person.
  settings.set({ ...settings.get(), permissions: { preset: 'full', rules: [] } })
  const projects = new ProjectStore(home)
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'myr-ask-project-')))
  try {
    const project = projects.setPermissions(projects.add(folder).id, { mode: 'ask', allow: [] })
    const careful = models([
      [tool('fs_write', { path: `${outside}/beyond.txt`, content: 'y' })],
      [tool('fs_write', { path: 'inside.txt', content: 'y' })],
      [tool('reply_user', { text: 'Written.', final: true })],
    ])
    const asking = new ChatService(runtime, { resolver: careful, settings, projects })
    const run = await asking.send('Write outside', config, undefined, { project: project.id })
    const ask = await waitFor(run.colonyId, (s) => pending(s).length > 0)
    expect(ask.fullAccess).toBeUndefined()
    expect(pending(ask)[0]).toMatchObject({ tool: 'fs_write', summary: 'write inside.txt' })
    await asking.decideApproval(run.colonyId, pending(ask)[0]?.id ?? '', true)
    await waitFor(run.colonyId)
    expect(existsSync(join(outside, 'beyond.txt'))).toBe(false)
    expect(existsSync(join(folder, 'inside.txt'))).toBe(true)
    await asking.stopAll()
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('full access lets web_fetch read a local address; without it the fetch is refused', async () => {
  const local = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('local secret') })
  const omp = {
    read: async (url: string) => ({
      url,
      method: 'fetch',
      contentType: 'text/plain',
      output: await (await fetch(url)).text(),
    }),
  } as unknown as OmpRuntime
  const web = ompWebTools(omp, () => 'auto')
  const url = `http://127.0.0.1:${local.port}/`
  const script = () => [[tool('web_fetch', { url })], [tool('reply_user', { text: 'Read it.', final: true })]]
  try {
    const settings = new SettingsStore(home)
    const confined = new ChatService(runtime, { resolver: models(script()), settings, web })
    const one = await confined.send('Read the local page', config)
    await waitFor(one.colonyId)
    const [refused] = await results(one.colonyId)
    expect(refused?.ok).toBe(false)
    expect(refused?.output).toContain('is not a server you started')
    await confined.stopAll()

    sandboxOff(settings)
    const free = new ChatService(runtime, { resolver: models(script()), settings, web })
    const two = await free.send('Read the local page', config)
    await waitFor(two.colonyId)
    const [read] = await results(two.colonyId)
    expect(read?.ok).toBe(true)
    expect(read?.output).toContain('local secret')
    await free.stopAll()
  } finally {
    local.stop(true)
  }
})

test('turning the sandbox back on takes full access from a running round at once', async () => {
  const settings = new SettingsStore(home)
  sandboxOff(settings)
  let release!: () => void
  const busy = new Promise<void>((r) => {
    release = r
  })
  let calls = 0
  const lead = createMockModel({
    handler: async () => {
      calls++
      if (calls === 1) {
        await busy
        return { content: [tool('list_artifacts', {})] }
      }
      if (calls === 2) return { content: [tool('fs_write', { path: `${outside}/late.txt`, content: 'x' })] }
      return { content: [tool('reply_user', { text: 'Done.', final: true })] }
    },
  })
  const resolver = models([])
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  const chats = new ChatService(runtime, { resolver, settings })
  const { colonyId } = await chats.send('Work', config)
  await waitFor(colonyId, (s) => s.fullAccess === true && calls === 1)
  settings.set({ ...settings.get(), sandbox: { enabled: true } })
  await chats.permissionsChanged()
  release()
  const s = await waitFor(colonyId)
  expect(s.fullAccess).toBeUndefined()
  const change = (await events(colonyId)).find((e) => e.type === 'permissions/changed')
  expect((change?.payload as EventPayloads['permissions/changed'] | undefined)?.fullAccess).toBe(false)
  expect(existsSync(join(outside, 'late.txt'))).toBe(false)
  await chats.stopAll()
})

test('on a computer with no sandbox, commands are refused unless the round has full access', () => {
  // As on Windows, or Linux without bubblewrap.
  const none: Sandbox = {
    kind: 'none',
    argv: () => [],
    run: () => Promise.reject(new Error('confined run on a machine with no sandbox')),
    start: () => {
      throw new Error('confined start on a machine with no sandbox')
    },
  }
  const spec = (fullAccess: boolean) =>
    ({
      name: 'no-sandbox',
      mission: 'm',
      pattern: 'swarm',
      agents: [],
      acceptance: [],
      budget: { wallMs: 60_000, maxTurns: 1 },
      observer: { intervalMs: 60_000 },
      ...(fullAccess ? { fullAccess: true } : {}),
    }) as unknown as ColonySpec
  expect(new ColonyRun(runtime, spec(false), { sandbox: none }).sandbox.kind).toBe('none')
  const free = new ColonyRun(runtime, spec(true), { sandbox: none })
  expect(free.sandbox.kind).toBe('unconfined')
  expect(free.localPorts()).toBe('all')
})

/** Like `models`, and `seen` keeps the newest message each call was given, as text. */
function watching(script: MockContent[][]) {
  const resolver = new ModelResolver()
  let call = 0
  const seen: string[] = []
  const lead = createMockModel({
    handler: (ctx) => {
      const last = ctx.messages.filter((m) => m.role === 'user').at(-1)?.content
      seen.push(typeof last === 'string' ? last : JSON.stringify(last))
      return { content: script[call++] ?? ['ok'] }
    },
  })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "complete"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  return Object.assign(resolver, { seen })
}

test('a round after the person changed access opens by saying so; a round after no change does not', async () => {
  const settings = new SettingsStore(home)
  const answer = [tool('reply_user', { text: 'Done.', final: true })]
  const told = watching([answer, answer, answer])
  const chats = new ChatService(runtime, { resolver: told, settings })
  const one = await chats.send('list my ssh keys', config)
  await waitFor(one.colonyId)
  await chats.setChatPermissions(one.chatId, { preset: 'full', rules: [] })
  const two = await chats.send('now', config, one.chatId)
  expect((await waitFor(two.colonyId)).fullAccess).toBe(true)
  const opening = told.seen.find((m) => m.includes('[user] now'))
  expect(opening).toContain(
    'Since your last answer the person changed what you may do: full access is now on (no sandbox; your commands run as the person',
  )
  expect(opening).toContain('may work now: try it.')
  // The round logs what its agents were told, so the next change is told as a change.
  const started = (await events(two.colonyId)).filter((e) => e.type === 'round/started').at(-1)
  expect((started?.payload as EventPayloads['round/started'] | undefined)?.access).toMatchObject({
    preset: 'full',
    fullAccess: true,
  })
  const three = await chats.send('again', config, one.chatId)
  await waitFor(three.colonyId)
  expect(told.seen.find((m) => m.includes('[user] again'))).not.toContain('Since your last answer')
  await chats.stopAll()
})

test('a change mid-round reaches the agent at its next step, without stopping it', async () => {
  const settings = new SettingsStore(home)
  const told = watching([
    [tool('request_read', { path: outside, reason: 'the spec is there' })],
    [tool('reply_user', { text: 'Done.', final: true })],
  ])
  const chats = new ChatService(runtime, { resolver: told, settings })
  const { chatId, colonyId } = await chats.send('Read the spec', config)
  const waiting = await waitFor(colonyId, (s) => pending(s).length > 0)
  await chats.setChatPermissions(chatId, {
    rules: [{ kind: 'command', target: 'bun test', decision: 'allow' }],
  })
  await chats.decideApproval(colonyId, pending(waiting)[0]?.id ?? '', true)
  await waitFor(colonyId)
  expect(told.seen.at(-1)).toContain(
    'The person just changed what you may do: these now run without asking: `bun test`',
  )
  const changed = (await events(colonyId)).find((e) => e.type === 'permissions/changed')
  const p = changed?.payload as EventPayloads['permissions/changed']
  expect(p.interrupted).toEqual([])
  expect(p.access?.rules).toEqual([{ kind: 'command', target: 'bun test', decision: 'allow' }])
  await chats.stopAll()
})
