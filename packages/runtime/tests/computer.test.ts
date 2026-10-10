import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlobStore } from '@myrmidon/core'
import {
  type ColonyState,
  type ComputerApp,
  decide,
  type EventDraft,
  foldColony,
  type PermissionCall,
  type PermissionRule,
} from '@myrmidon/protocol'
import { bunShim, pendingOn } from '../../../tests/platform.ts'
import {
  appTool,
  bootRuntime,
  ChatService,
  type ColonyHost,
  ComputerHub,
  computerMember,
  computerTool,
  type Grants,
  McpHub,
  ModelResolver,
  type Runtime,
  SettingsStore,
  screenshotEdge,
  sessionOf,
  type TeamConfig,
} from '../src/index.ts'
import type { AgentTool, AgentToolResult } from '../src/omp/agent-core.ts'
import type { Model } from '../src/omp/ai.ts'
import { AssistantMessageEventStream } from '../src/omp/ai.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'

const FIXTURE = join(import.meta.dir, 'fixtures', 'fake-cua-driver.ts')

let home: string
let runtime: Runtime
let mcp: McpHub
let hub: ComputerHub
let settings: SettingsStore
let grants: Grants
let calls: string

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-computer-'))
  runtime = await bootRuntime(home)
  // The driver Myrmidon finds where the person installed theirs: here, a script standing in for Cua Driver.
  mkdirSync(join(home, 'bin'), { recursive: true })
  const driver = bunShim(join(home, 'bin', 'cua-driver'), FIXTURE)
  calls = join(home, 'calls.jsonl')
  process.env.FAKE_CUA_LOG = calls
  settings = new SettingsStore(home)
  settings.set({ ...settings.get(), computerUse: { enabled: true } })
  grants = { accessibility: true, screenRecording: true }
  mcp = new McpHub(join(home, 'agent'))
  hub = new ComputerHub(home, {
    mcp,
    enabled: () => settings.get().computerUse.enabled,
    paths: [driver],
    platform: 'darwin',
    grants: () => grants,
  })
})

afterEach(async () => {
  await hub.stop()
  await mcp.close()
  await runtime.dispose()
  delete process.env.FAKE_CUA_LOG
  rmSync(home, { recursive: true, force: true })
})

/** What the stand-in driver was asked, in order. */
const asked = () =>
  existsSync(calls)
    ? readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> })
    : []

const textOf = (r: AgentToolResult) =>
  r.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')

/** A round's host as far as the computer tool uses it; the person's answers to cards come from `decide`. */
function fakeHost(
  options: {
    decide?: (summary: string) => boolean | Promise<boolean>
    askAll?: boolean
    rules?: PermissionRule[]
    id?: string
  } = {},
) {
  const events: EventDraft[] = []
  const cards: string[] = []
  let apps: ComputerApp[] = []
  const host = {
    id: options.id ?? 'colony-test',
    spec: { askAll: options.askAll },
    permit: (_agent: string, call: PermissionCall) =>
      decide({ global: { preset: 'auto', rules: options.rules ?? [] } }, call, { askAll: !!options.askAll }),
    boundary: 'b0undary',
    blobs: new BlobStore(join(home, 'blobs')),
    get computer() {
      return options.askAll ? undefined : hub
    },
    state: () => ({ status: 'running', computerApps: apps, signals: [] }) as unknown as ColonyState,
    huddling: () => false,
    rememberUntrusted() {},
    async append(draft: EventDraft) {
      events.push(draft)
      if (draft.type === 'computer/apps') apps = (draft.payload as { apps: ComputerApp[] }).apps
      return draft
    },
    async reviewChange(_agent: string, _tool: string, summary: string) {
      cards.push(summary)
      return { approved: options.decide ? await options.decide(summary) : true }
    },
  } as unknown as ColonyHost
  return { host, events, cards }
}

const mockModel = { id: 'mock-model', api: 'mock', provider: 'mock' } as unknown as Model
const generic = (host: ColonyHost) => computerTool('nova', host, () => mockModel)
const opener = (host: ColonyHost) => appTool('open_app', 'nova', host, () => mockModel)
const call = (tool: AgentTool, args: Record<string, unknown>, context?: unknown) =>
  tool.execute('c1', args as never, undefined, undefined, context as never)

pendingOn('win32', 'cuaDriverOnWindows')(
  'Cua Driver runs embedded under Myrmidon, as an internal MCP server agents never see as MCP tools',
  async () => {
    expect(hub.driver()?.version).toBe('9.9.9')
    await hub.ensure()
    expect(hub.status().state).toBe('running')
    // The stand-in refuses to run unless embedded mode is set, so reaching here means the daemon and proxy both had it.
    expect(mcp.tools()).toHaveLength(0)
    expect(mcp.servers()).toHaveLength(0)
    expect(mcp.internalTool('myrmidon-computer', 'get_window_state')).toBeDefined()
    const r = await hub.call('list_apps', {})
    expect(r.isError).toBe(false)
    expect((r.structured?.apps as unknown[] | undefined)?.length).toBe(8)
    expect(hub.accepts('get_window_state', 'max_dimension')).toBe(true)
    expect(hub.accepts('get_window_state', 'tree_format')).toBe(false)
    await hub.stop()
    expect(mcp.internalTool('myrmidon-computer', 'get_window_state')).toBeUndefined()
    expect(hub.status().state).toBe('ready')
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  'opening an app asks the person once per chat, then each call returns a screenshot sized for the model',
  async () => {
    const { host, events, cards } = fakeHost()
    const tool = generic(host)
    const opened = await call(opener(host), { app: 'Notes' })
    expect(opened.isError).toBe(false)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toContain('Notes')
    expect(events.find((e) => e.type === 'computer/apps')?.payload).toEqual({
      apps: [{ bundleId: 'com.apple.Notes', name: 'Notes', tier: 'full' }],
    })
    expect(events.find((e) => e.type === 'computer/control')?.payload).toEqual({
      agent: 'nova',
      app: 'Notes',
      active: true,
    })
    expect(opened.content.some((c) => c.type === 'image')).toBe(true)
    // Elements come numbered, inside the untrusted block: what an app shows is outside content.
    expect(textOf(opened)).toContain('[1] Button "Send"')
    expect(textOf(opened)).toContain('⟦untrusted b0undary')
    const look = asked().find((c) => c.name === 'get_window_state')
    expect(look?.args.max_dimension).toBe(
      screenshotEdge({ width: 1600, height: 1000 }, { longEdge: 1568, megapixels: 1.15 }),
    )
    expect(events.some((e) => e.type === 'computer/keyframe')).toBe(true)

    // Approved for the chat: no second card.
    const typed = await call(tool, { action: 'type', text: 'Groceries' })
    expect(typed.isError).toBe(false)
    expect(cards).toHaveLength(1)
    expect(asked().find((c) => c.name === 'type_text')?.args).toMatchObject({
      pid: 101,
      window_id: 1010,
      text: 'Groceries',
    })
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  'an app the person does not approve stays out of reach, and Myrmidon itself is never offered',
  async () => {
    const { host } = fakeHost({ decide: () => false })
    const denied = await call(opener(host), { app: 'Notes' })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('did not let you use Notes')
    expect(asked().some((c) => c.name === 'launch_app')).toBe(false)
    const own = await call(opener(host), { app: 'Myrmidon' })
    expect(textOf(own)).toContain('never shown to or driven by agents')
    const before = await call(generic(fakeHost().host), { action: 'left_click', coordinate: [1, 1] })
    expect(textOf(before)).toContain('open_app')
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  'browsers are view-only, terminals click-only until the person gives full control',
  async () => {
    const { host, cards } = fakeHost()
    const tool = generic(host)
    await call(opener(host), { app: 'Safari' })
    const click = await call(tool, { action: 'left_click', coordinate: [10, 10] })
    expect(click.isError).toBe(true)
    expect(textOf(click)).toContain('view-only')
    expect(textOf(await call(opener(host), { app: 'Safari', full_control: true }))).toContain(
      'cannot be given',
    )

    await call(opener(host), { app: 'Terminal' })
    expect((await call(tool, { action: 'left_click', coordinate: [10, 10] })).isError).toBe(false)
    const typing = await call(tool, { action: 'type', text: 'ls' })
    expect(textOf(typing)).toContain('click-only')
    expect(cards).toHaveLength(2)
    await call(opener(host), { app: 'Terminal', full_control: true })
    expect(cards).toHaveLength(3)
    expect(cards[2]).toContain('full control')
    expect((await call(tool, { action: 'type', text: 'ls' })).isError).toBe(false)
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  "each agent drives in a driver session of its own; the overlay learns where it acted, and the driver's cursor hides while the overlay draws",
  async () => {
    process.env.FAKE_CUA_SESSIONS = '1'
    try {
      const { host } = fakeHost()
      const tool = generic(host)
      await call(opener(host), { app: 'Notes' })
      // Element 1, the Send button, spans 1500–1600 × 950–990 on the screen: its middle is where the cursor goes.
      expect((await call(tool, { action: 'click_element', element: 1 })).isError).toBe(false)
      const session = sessionOf('colony-test', 'nova')
      expect(asked().filter((c) => c.name === 'set_agent_cursor_enabled')).toEqual([])
      expect(hub.pointers()).toEqual([
        { colonyId: 'colony-test', agent: 'nova', x: 1550, y: 970, action: 'click', at: expect.any(Number) },
      ])
      // The overlay has asked, so it is up: the driver stops drawing its own cursor, once.
      await call(tool, { action: 'left_click', coordinate: [10, 10] })
      await call(tool, { action: 'left_click', coordinate: [20, 20] })
      expect(
        asked()
          .filter((c) => c.name === 'set_agent_cursor_enabled')
          .map((c) => c.args),
      ).toEqual([{ session, enabled: false }])
      const acting = asked().filter((c) => ['click', 'get_window_state'].includes(c.name))
      expect(acting.length).toBeGreaterThan(0)
      expect(acting.every((c) => c.args.session === session)).toBe(true)
      const [pointer] = hub.pointers()
      // A pixel click lands inside the window the screenshot showed (100, 50, 1600 × 1000 points).
      expect(pointer?.x).toBeGreaterThan(100)
      expect(pointer?.y).toBeGreaterThan(50)
      expect(pointer?.x).toBeLessThan(150)
    } finally {
      delete process.env.FAKE_CUA_SESSIONS
    }
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  'a consequential-looking step waits for the person, and secrets are never typed',
  async () => {
    let allow = true
    const { host, cards } = fakeHost({ decide: () => allow })
    const tool = generic(host)
    await call(opener(host), { app: 'Messages' })
    allow = false
    // Element 1 is the Send button; clicking its pixels counts too.
    const send = await call(tool, { action: 'click_element', element: 1 })
    expect(send.isError).toBe(true)
    expect(textOf(send)).toContain('did not approve')
    expect(cards.at(-1)).toContain('click element #1')
    const pixel = await call(tool, { action: 'left_click', coordinate: [1220, 780] })
    expect(textOf(pixel)).toContain('did not approve')
    // Return sends in Messages.
    expect(textOf(await call(tool, { action: 'key', text: 'Return' }))).toContain('did not approve')
    // So does a newline in typed text.
    expect(textOf(await call(tool, { action: 'type', text: 'on my way\n' }))).toContain('did not approve')
    expect(asked().some((c) => c.name === 'type_text')).toBe(false)
    expect(asked().some((c) => c.name === 'click' && c.args.element_index === 1)).toBe(false)
    const secret = await call(tool, { action: 'type', text: 'my key is sk-ant-abcdefghijklmnopqrstuvwxyz' })
    expect(textOf(secret)).toContain('never types secrets')
    const outside = await call(tool, { action: 'left_click', coordinate: [5000, 10] })
    expect(textOf(outside)).toContain('outside the latest screenshot')
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  'computer set to ask in Settings asks before every step',
  async () => {
    const { host, cards } = fakeHost({ rules: [{ kind: 'tool', target: 'computer', decision: 'ask' }] })
    const tool = generic(host)
    await call(opener(host), { app: 'Notes' })
    await call(tool, { action: 'scroll', coordinate: [10, 10], scroll_direction: 'down' })
    expect(cards.filter((c) => c.includes('Allow this step'))).toHaveLength(2)
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  "OpenAI's native computer call runs its batch and answers with a screenshot for the provider",
  async () => {
    const { host, cards } = fakeHost()
    const tool = generic(host)
    await call(opener(host), { app: 'Notes' })
    const meta = {
      type: 'computer',
      providerItemId: 'cu_1',
      actions: [
        { type: 'click', button: 'left', x: 20, y: 30 },
        { type: 'type', text: 'hi' },
      ],
      pendingSafetyChecks: [],
    }
    const r = (await call(tool, {}, { toolCall: { providerMetadata: meta } })) as AgentToolResult & {
      providerMetadata?: { screenshot: { image_url: string }; acknowledgedSafetyChecks: unknown[] }
    }
    expect(r.isError).toBe(false)
    expect(r.providerMetadata?.screenshot.image_url).toStartWith('data:image/png;base64,')
    const names = asked().map((c) => c.name)
    expect(names.slice(names.indexOf('click'))).toEqual(['click', 'type_text', 'get_window_state'])
    // A safety check from the provider is the person's to acknowledge.
    const checked = {
      ...meta,
      pendingSafetyChecks: [{ id: 'sc1', code: 'malicious_instructions', message: 'Suspicious text' }],
    }
    const acknowledged = (await call(
      tool,
      {},
      { toolCall: { providerMetadata: checked } },
    )) as AgentToolResult & {
      providerMetadata?: { acknowledgedSafetyChecks: unknown[] }
    }
    expect(cards.at(-1)).toContain('Suspicious text')
    expect(acknowledged.providerMetadata?.acknowledgedSafetyChecks).toEqual(checked.pendingSafetyChecks)
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  "Anthropic toolset members run in order and halt after the batch's first failure",
  async () => {
    const { host } = fakeHost()
    await call(opener(host), { app: 'Notes' })
    const ctx = { toolCall: { batchId: 'b1' } }
    const bad = await call(
      computerMember('left_click', 'nova', host, () => mockModel),
      { coordinate: [9999, 1] },
      ctx,
    )
    expect(bad.isError).toBe(true)
    const next = await call(
      computerMember('type', 'nova', host, () => mockModel),
      { text: 'x' },
      ctx,
    )
    expect(textOf(next)).toBe('Not executed: an earlier computer action in this turn failed.')
    expect(asked().some((c) => c.name === 'type_text')).toBe(false)
    const later = await call(
      computerMember('scroll', 'nova', host, () => mockModel),
      { scroll_direction: 'down' },
      {
        toolCall: { batchId: 'b2' },
      },
    )
    expect(later.isError).toBe(false)
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  'one agent drives an app at a time, and Stop ends a round’s computer use for good',
  async () => {
    await hub.take({ name: 'Notes', bundleId: 'com.apple.Notes' }, { colonyId: 'a', agent: 'nova' })
    await expect(
      hub.take({ name: 'Notes', bundleId: 'com.apple.Notes' }, { colonyId: 'b', agent: 'kai' }, 300),
    ).rejects.toThrow('nova is using Notes')
    // Another app is free meanwhile.
    await hub.take({ name: 'Safari', bundleId: 'com.apple.Safari' }, { colonyId: 'b', agent: 'kai' }, 300)
    hub.release('a')
    await hub.take({ name: 'Notes', bundleId: 'com.apple.Notes' }, { colonyId: 'b', agent: 'kai' }, 300)
    expect(hub.controls().map((c) => `${c.agent}:${c.app}`)).toEqual(['kai:Notes'])

    let stopped = 0
    hub.newRound('colony-test', () => stopped++)
    const { host } = fakeHost()
    await call(opener(host), { app: 'Messages' })
    expect(hub.stopAll()).toBe(2)
    expect(stopped).toBe(1)
    expect(hub.controls()).toHaveLength(0)
    expect(textOf(await call(generic(host), { action: 'screenshot' }))).toContain('stopped computer use')
    hub.newRound('colony-test', () => {})
    expect(hub.stopped('colony-test')).toBe(false)
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  'Stop also ends rounds waiting for an app or on its approval card: they never take it after',
  async () => {
    const { host } = fakeHost()
    await call(generic(host), { action: 'open_app', app: 'Notes' })
    // Another round waits for Notes; a third sits on its card for Messages.
    const waiter = fakeHost({ id: 'colony-waits' })
    let answer: (approved: boolean) => void = () => {}
    const card = fakeHost({ id: 'colony-card', decide: () => new Promise<boolean>((r) => (answer = r)) })
    hub.newRound('colony-waits', () => {})
    hub.newRound('colony-card', () => {})
    const waiting = call(
      computerTool('kai', waiter.host, () => mockModel),
      { action: 'open_app', app: 'Notes' },
    )
    const carded = call(
      computerTool('ivy', card.host, () => mockModel),
      { action: 'open_app', app: 'Messages' },
    )
    for (let i = 0; i < 100 && card.cards.length === 0; i++) await Bun.sleep(20)
    const started = Date.now()
    expect(hub.stopAll()).toBe(3)
    expect(textOf(await waiting)).toContain('stopped computer use')
    expect(textOf(await carded)).toContain('stopped computer use')
    expect(Date.now() - started).toBeLessThan(5_000)
    // Allowed after Stop, the app is neither recorded nor taken.
    answer(true)
    await Bun.sleep(50)
    expect(card.events.some((e) => e.type === 'computer/apps')).toBe(false)
    expect(hub.controls()).toHaveLength(0)
    expect(hub.stopped('colony-waits')).toBe(true)
  },
  40_000,
)

test('a wait Stop ended never takes the app, even once a new round of its chat has started', async () => {
  await hub.take({ name: 'Notes', bundleId: 'com.apple.Notes' }, { colonyId: 'a', agent: 'nova' })
  const waiting = hub.take({ name: 'Notes', bundleId: 'com.apple.Notes' }, { colonyId: 'b', agent: 'kai' })
  await Bun.sleep(50)
  hub.stopAll()
  // Before the waiting loop looks again: the chat's next round starts and Notes comes free.
  hub.newRound('b', () => {})
  hub.release('a')
  await expect(waiting).rejects.toThrow('stopped')
  await Bun.sleep(500)
  expect(hub.controls()).toHaveLength(0)
})

pendingOn('win32', 'cuaDriverOnWindows')(
  'a driver the person installed runs with a minimal environment, and the log says it is their own',
  async () => {
    const lines: string[] = []
    process.env.MYR_TEST_SECRET = 'leaked'
    const theirs = new ComputerHub(home, {
      mcp,
      enabled: () => true,
      paths: [join(home, 'bin', 'cua-driver')],
      platform: 'darwin',
      grants: () => grants,
      log: (line) => lines.push(line),
    })
    try {
      await theirs.ensure()
      for (let i = 0; i < 100 && !lines.some((l) => l.includes('env ')); i++) await Bun.sleep(20)
    } finally {
      delete process.env.MYR_TEST_SECRET
      await theirs.stop()
    }
    expect(theirs.driver()?.own).toBe(false)
    const env = lines.find((l) => l.includes('env '))
    expect(env).toContain('HOME')
    expect(env).not.toContain('MYR_TEST_SECRET')
    expect(lines.some((l) => l.includes('your own install'))).toBe(true)
  },
)

test('missing grants are explained once in the chat and stop the call; a channel member never gets the computer', async () => {
  grants = { accessibility: false, screenRecording: true }
  const { host, events } = fakeHost()
  const r = await call(opener(host), { app: 'Notes' })
  expect(textOf(r)).toContain('Accessibility')
  await call(opener(host), { app: 'Notes' })
  expect(events.filter((e) => e.type === 'computer/blocked').map((e) => e.payload)).toEqual([
    { agent: 'nova', reason: 'grants', missing: ['accessibility'] },
  ])
  const member = fakeHost({ askAll: true })
  expect(textOf(await call(generic(member.host), { action: 'screenshot' }))).toContain(
    'not available in this round',
  )
})

// The chat decides who gets the tool: the person's rounds while computer use is on, never a channel member's.

const tool = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})

function lead(script: MockContent[][], offered: string[][]) {
  const resolver = new ModelResolver()
  let n = 0
  const m = createMockModel({
    handler: (ctx) => {
      offered.push((ctx.tools ?? []).map((t) => t.name))
      return { content: script[n++] ?? [tool('reply_user', { text: 'Done.', final: true })] }
    },
  })
  resolver.register('mock/lead', { model: m.model, streamFn: m.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  return resolver
}

const config: TeamConfig = {
  mode: 'orchestrated',
  leadModel: 'mock/lead',
  roster: [],
  judgeModel: 'mock/judge',
}

async function finished(colonyId: string): Promise<ColonyState> {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (s.status !== 'running' && s.status !== 'created') return s
    await Bun.sleep(25)
  }
  throw new Error('the round did not finish')
}

test('the computer tool is offered only while computer use is on, and never to a channel member', async () => {
  const runs: { offered: string[][]; askAll?: boolean; on: boolean }[] = [
    { offered: [], on: true },
    { offered: [], on: false },
    { offered: [], on: true, askAll: true },
  ]
  for (const r of runs) {
    settings.set({ ...settings.get(), computerUse: { enabled: r.on } })
    const chats = new ChatService(runtime, { resolver: lead([], r.offered), settings, mcp, computer: hub })
    const sent = await chats.send(
      'What is on my screen in Notes?',
      config,
      undefined,
      r.askAll ? { askAll: true } : {},
    )
    const s = await finished(sent.colonyId)
    expect(s.status).toBe('completed')
  }
  expect(runs[0]?.offered[0]).toContain('computer')
  expect(runs[1]?.offered[0]).not.toContain('computer')
  expect(runs[2]?.offered[0]).not.toContain('computer')
})

/** Runs a chat round on a model with a native computer tool, approving each card; the tool results, in order. */
async function nativeRound(
  model: Partial<Model>,
  script: MockContent[][],
  wrap: (stream: AssistantMessageEventStream) => AssistantMessageEventStream = (stream) => stream,
  onRequest?: (context: { tools?: { name: string }[] }, onPayload: unknown) => void,
) {
  const resolver = new ModelResolver()
  let n = 0
  const m = createMockModel({
    handler: () => ({ content: script[n++] ?? [tool('reply_user', { text: 'Done.', final: true })] }),
  })
  resolver.register('mock/native', {
    model: { ...m.model, ...model } as Model,
    streamFn: (model, context, options) => {
      onRequest?.(context, options?.onPayload)
      return wrap(m.stream(model, context, options) as AssistantMessageEventStream)
    },
  })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  const chats = new ChatService(runtime, { resolver, settings, mcp, computer: hub })
  const sent = await chats.send('Look at my Notes on my Mac', { ...config, leadModel: 'mock/native' })
  for (let i = 0; i < 200; i++) {
    const s = foldColony(sent.colonyId, await runtime.ctx.log.read(sent.colonyId as never))
    const waiting = Object.values(s.approvals).find((a) => !a.decided)
    if (waiting) await chats.decideApproval(sent.colonyId, waiting.id, true)
    if (s.status !== 'running' && s.status !== 'created') break
    await Bun.sleep(25)
  }
  const s = await finished(sent.colonyId)
  expect(s.status).toBe('completed')
  const events = await runtime.ctx.log.read(sent.colonyId as never)
  return events.flatMap((e) =>
    e.type === 'tool/result' ? [e.payload as { tool: string; ok: boolean; output: string }] : [],
  )
}

pendingOn('win32', 'cuaDriverOnWindows')(
  "a Claude toolset model gets Anthropic's toolset and the app tools, opens an app, and its member calls reach it",
  async () => {
    const payloads: unknown[] = []
    const offered: string[][] = []
    const results = await nativeRound(
      { id: 'claude-opus-5-5', api: 'anthropic-messages', provider: 'anthropic' },
      [
        // The toolset calls each action by its own name; before an app is open, the error names a tool it has.
        [tool('screenshot', {})],
        [tool('open_app', { app: 'Notes' })],
        [tool('screenshot', {})],
        [tool('scroll', { coordinate: [10, 10], scroll_direction: 'down', scroll_amount: 2 })],
      ],
      undefined,
      (context, onPayload) => {
        offered.push((context.tools ?? []).map((t) => t.name))
        // What pi-ai's Anthropic provider would send, run through the hook the agent set.
        const body = { tools: (context.tools ?? []).map((t) => ({ name: t.name })), messages: [] }
        payloads.push((onPayload as ((b: unknown, m: unknown) => unknown) | undefined)?.(body, undefined))
      },
    )
    const first = (await payloads[0]) as { tools: Record<string, unknown>[] }
    expect(first.tools.some((t) => t.type === 'computer_toolset_20260801')).toBe(true)
    expect(first.tools.some((t) => t.name === 'computer')).toBe(false)
    expect(first.tools.filter((t) => t.name === 'open_app' || t.name === 'list_apps')).toHaveLength(2)
    expect(results[0]).toMatchObject({ tool: 'screenshot', ok: false })
    expect(results[0]?.output).toContain('open_app')
    expect(offered[0]).toContain('open_app')
    expect(results.slice(1, 4).map((r) => [r.tool, r.ok])).toEqual([
      ['open_app', true],
      ['screenshot', true],
      ['scroll', true],
    ])
    expect(asked().find((c) => c.name === 'scroll')?.args).toMatchObject({
      direction: 'down',
      amount: 2,
      x: 10,
      y: 10,
    })
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  'an OpenAI computer-use model gets the app tools beside its native tool, opens an app, then takes a screenshot',
  async () => {
    const offered: string[][] = []
    const meta = {
      type: 'computer',
      providerItemId: 'cu_1',
      actions: [{ type: 'screenshot' }],
      pendingSafetyChecks: [],
    }
    // pi-ai hands the native call's actions over as its metadata; the mock provider has none, so they are added here.
    const withMeta = (stream: AssistantMessageEventStream) => {
      const out = new AssistantMessageEventStream()
      void (async () => {
        for await (const e of stream) {
          if (e.type === 'done')
            for (const c of e.message.content)
              if (c.type === 'toolCall' && c.name === 'computer') c.providerMetadata = meta as never
          out.push(e)
        }
      })()
      return out
    }
    const results = await nativeRound(
      { id: 'computer-use-preview', api: 'openai-responses', provider: 'openai', supportsComputerUse: true },
      [[tool('open_app', { app: 'Notes' })], [tool('computer', {})]],
      withMeta,
      (context) => offered.push((context.tools ?? []).map((t) => t.name)),
    )
    expect(offered[0]).toEqual(expect.arrayContaining(['computer', 'open_app', 'list_apps']))
    expect(results.slice(0, 2).map((r) => [r.tool, r.ok])).toEqual([
      ['open_app', true],
      ['computer', true],
    ])
    expect(results[1]?.output).toContain('Notes')
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  "the person's Stop takes down the round's waiting computer card at once; the round goes on",
  async () => {
    const resolver = lead([[tool('open_app', { app: 'Notes' })]], [])
    const chats = new ChatService(runtime, { resolver, settings, mcp, computer: hub })
    const sent = await chats.send('Open Notes on my Mac', config)
    let card: string | undefined
    for (let i = 0; i < 200 && !card; i++) {
      const s = foldColony(sent.colonyId, await runtime.ctx.log.read(sent.colonyId as never))
      card = Object.values(s.approvals).find((a) => !a.decided)?.id
      if (!card) await Bun.sleep(25)
    }
    expect(card).toBeDefined()
    expect(hub.stopAll()).toBe(1)
    const s = await finished(sent.colonyId)
    expect(s.status).toBe('completed')
    const events = await runtime.ctx.log.read(sent.colonyId as never)
    const decided = events.findIndex(
      (e) => e.type === 'approval/decided' && (e.payload as { id: string }).id === card,
    )
    expect(events[decided]?.payload).toMatchObject({ approved: false, by: 'stopped' })
    // Closed by the Stop itself, not left up until the round ends (or the card times out).
    const result = events.findIndex(
      (e) => e.type === 'tool/result' && (e.payload as { tool: string }).tool === 'open_app',
    )
    expect(decided).toBeLessThan(result)
    expect((events[result]?.payload as { output?: string } | undefined)?.output).toContain(
      'stopped computer use',
    )
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  'an app with no accessibility tree (Arc, Chrome, Electron) is still seen and acted on by pixel',
  async () => {
    // A real chat: Arc opened, then every call failed with ax_window_unresolved and the agent never saw the window.
    const { host } = fakeHost()
    const opened = await call(opener(host), { app: 'Arc' })
    expect(opened.isError).toBe(false)
    expect(opened.content.some((c) => c.type === 'image')).toBe(true)
    expect(textOf(opened)).toContain('by pixel')
    const looked = await call(generic(host), { action: 'screenshot' })
    expect(looked.isError).toBe(false)
    expect(looked.content.some((c) => c.type === 'image')).toBe(true)
    // It asked for the tree once, then only for the screenshot.
    const looks = asked().filter((c) => c.name === 'get_window_state' && c.args.pid === 106)
    expect(looks.filter((c) => c.args.include_accessibility_tree !== false)).toHaveLength(1)
    expect(looks.some((c) => c.args.include_accessibility_tree === false)).toBe(true)
    // Arc is a browser, so view-only; an Electron app without a tree takes input, but the driver refuses it in the
    // background there, so a click and typing bring the window forward first.
    await call(opener(host), { app: 'Slack' })
    expect((await call(generic(host), { action: 'left_click', coordinate: [10, 10] })).isError).toBe(false)
    expect((await call(generic(host), { action: 'type', text: 'hello' })).isError).toBe(false)
    const inputs = asked().filter((c) => ['click', 'type_text'].includes(c.name) && c.args.pid === 108)
    expect(inputs).toHaveLength(2)
    expect(inputs.every((c) => c.args.delivery_mode === 'foreground')).toBe(true)
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  "a window the driver cannot capture says why, instead of blaming the app's accessibility",
  async () => {
    const { host } = fakeHost()
    const opened = await call(opener(host), { app: 'Figma' })
    expect(opened.isError).toBe(true)
    expect(textOf(opened)).toContain('no screenshot of Figma')
    expect(textOf(opened)).toContain('px_capture_unavailable: the window is not on screen')
  },
)

pendingOn('win32', 'cuaDriverOnWindows')(
  'an app with a tree is acted on in the background, never brought forward',
  async () => {
    const { host } = fakeHost()
    await call(opener(host), { app: 'Notes' })
    await call(generic(host), { action: 'left_click', coordinate: [10, 10] })
    const click = asked().find((c) => c.name === 'click' && c.args.pid === 101)
    expect(click?.args.delivery_mode).toBeUndefined()
  },
)
