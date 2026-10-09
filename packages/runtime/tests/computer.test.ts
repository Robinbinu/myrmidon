import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import type { AgentTool, AgentToolResult } from '@oh-my-pi/pi-agent-core'
import type { Model } from '@oh-my-pi/pi-ai'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import {
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
  type TeamConfig,
} from '../src/index.ts'

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
  const driver = join(home, 'bin', 'cua-driver')
  Bun.spawnSync(['mkdir', '-p', join(home, 'bin')])
  writeFileSync(driver, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`)
  chmodSync(driver, 0o755)
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
  options: { decide?: (summary: string) => boolean; askAll?: boolean; rules?: PermissionRule[] } = {},
) {
  const events: EventDraft[] = []
  const cards: string[] = []
  let apps: ComputerApp[] = []
  const host = {
    id: 'colony-test',
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
      return { approved: options.decide ? options.decide(summary) : true }
    },
  } as unknown as ColonyHost
  return { host, events, cards }
}

const mockModel = { id: 'mock-model', api: 'mock', provider: 'mock' } as unknown as Model
const generic = (host: ColonyHost) => computerTool('nova', host, () => mockModel)
const call = (tool: AgentTool, args: Record<string, unknown>, context?: unknown) =>
  tool.execute('c1', args as never, undefined, undefined, context as never)

test('Cua Driver runs embedded under Myrmidon, as an internal MCP server agents never see as MCP tools', async () => {
  expect(hub.driver()?.version).toBe('9.9.9')
  await hub.ensure()
  expect(hub.status().state).toBe('running')
  // The stand-in refuses to run unless embedded mode is set, so reaching here means the daemon and proxy both had it.
  expect(mcp.tools()).toHaveLength(0)
  expect(mcp.servers()).toHaveLength(0)
  expect(mcp.internalTool('myrmidon-computer', 'get_window_state')).toBeDefined()
  const r = await hub.call('list_apps', {})
  expect(r.isError).toBe(false)
  expect((r.structured?.apps as unknown[] | undefined)?.length).toBe(5)
  expect(hub.accepts('get_window_state', 'max_dimension')).toBe(true)
  expect(hub.accepts('get_window_state', 'tree_format')).toBe(false)
  await hub.stop()
  expect(mcp.internalTool('myrmidon-computer', 'get_window_state')).toBeUndefined()
  expect(hub.status().state).toBe('ready')
})

test('opening an app asks the person once per chat, then each call returns a screenshot sized for the model', async () => {
  const { host, events, cards } = fakeHost()
  const tool = generic(host)
  const opened = await call(tool, { action: 'open_app', app: 'Notes' })
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
})

test('an app the person does not approve stays out of reach, and Myrmidon itself is never offered', async () => {
  const { host } = fakeHost({ decide: () => false })
  const denied = await call(generic(host), { action: 'open_app', app: 'Notes' })
  expect(denied.isError).toBe(true)
  expect(textOf(denied)).toContain('did not let you use Notes')
  expect(asked().some((c) => c.name === 'launch_app')).toBe(false)
  const own = await call(generic(host), { action: 'open_app', app: 'Myrmidon' })
  expect(textOf(own)).toContain('never shown to or driven by agents')
  const before = await call(generic(fakeHost().host), { action: 'left_click', coordinate: [1, 1] })
  expect(textOf(before)).toContain('open_app')
})

test('browsers are view-only, terminals click-only until the person gives full control', async () => {
  const { host, cards } = fakeHost()
  const tool = generic(host)
  await call(tool, { action: 'open_app', app: 'Safari' })
  const click = await call(tool, { action: 'left_click', coordinate: [10, 10] })
  expect(click.isError).toBe(true)
  expect(textOf(click)).toContain('view-only')
  expect(textOf(await call(tool, { action: 'open_app', app: 'Safari', full_control: true }))).toContain(
    'cannot be given',
  )

  await call(tool, { action: 'open_app', app: 'Terminal' })
  expect((await call(tool, { action: 'left_click', coordinate: [10, 10] })).isError).toBe(false)
  const typing = await call(tool, { action: 'type', text: 'ls' })
  expect(textOf(typing)).toContain('click-only')
  expect(cards).toHaveLength(2)
  await call(tool, { action: 'open_app', app: 'Terminal', full_control: true })
  expect(cards).toHaveLength(3)
  expect(cards[2]).toContain('full control')
  expect((await call(tool, { action: 'type', text: 'ls' })).isError).toBe(false)
})

test('a consequential-looking step waits for the person, and secrets are never typed', async () => {
  let allow = true
  const { host, cards } = fakeHost({ decide: () => allow })
  const tool = generic(host)
  await call(tool, { action: 'open_app', app: 'Messages' })
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
  expect(asked().some((c) => c.name === 'click' && c.args.element_index === 1)).toBe(false)
  const secret = await call(tool, { action: 'type', text: 'my key is sk-ant-abcdefghijklmnopqrstuvwxyz' })
  expect(textOf(secret)).toContain('never types secrets')
  const outside = await call(tool, { action: 'left_click', coordinate: [5000, 10] })
  expect(textOf(outside)).toContain('outside the latest screenshot')
})

test('computer set to ask in Settings asks before every step', async () => {
  const { host, cards } = fakeHost({ rules: [{ kind: 'tool', target: 'computer', decision: 'ask' }] })
  const tool = generic(host)
  await call(tool, { action: 'open_app', app: 'Notes' })
  await call(tool, { action: 'scroll', coordinate: [10, 10], scroll_direction: 'down' })
  expect(cards.filter((c) => c.includes('Allow this step'))).toHaveLength(2)
})

test("OpenAI's native computer call runs its batch and answers with a screenshot for the provider", async () => {
  const { host, cards } = fakeHost()
  const tool = generic(host)
  await call(tool, { action: 'open_app', app: 'Notes' })
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
})

test("Anthropic toolset members run in order and halt after the batch's first failure", async () => {
  const { host } = fakeHost()
  await call(generic(host), { action: 'open_app', app: 'Notes' })
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
})

test('one agent drives an app at a time, and Stop ends a round’s computer use for good', async () => {
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
  await call(generic(host), { action: 'open_app', app: 'Messages' })
  expect(hub.stopAll()).toBe(2)
  expect(stopped).toBe(1)
  expect(hub.controls()).toHaveLength(0)
  expect(textOf(await call(generic(host), { action: 'screenshot' }))).toContain('stopped computer use')
  hub.newRound('colony-test', () => {})
  expect(hub.stopped('colony-test')).toBe(false)
})

test('missing grants are explained once in the chat and stop the call; a channel member never gets the computer', async () => {
  grants = { accessibility: false, screenRecording: true }
  const { host, events } = fakeHost()
  const r = await call(generic(host), { action: 'open_app', app: 'Notes' })
  expect(textOf(r)).toContain('Accessibility')
  await call(generic(host), { action: 'open_app', app: 'Notes' })
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

test("a Claude toolset model gets Anthropic's toolset in its request, and its member calls reach the computer", async () => {
  const resolver = new ModelResolver()
  const payloads: unknown[] = []
  let n = 0
  const script: MockContent[][] = [
    [tool('computer', { action: 'open_app', app: 'Notes' })],
    // The toolset calls each action by its own name.
    [tool('scroll', { coordinate: [10, 10], scroll_direction: 'down', scroll_amount: 2 })],
  ]
  const m = createMockModel({
    handler: () => ({ content: script[n++] ?? [tool('reply_user', { text: 'Done.', final: true })] }),
  })
  const claude = {
    ...m.model,
    id: 'claude-opus-5-5',
    api: 'anthropic-messages',
    provider: 'anthropic',
  } as Model
  resolver.register('mock/claude', {
    model: claude,
    streamFn: (model, context, options) => {
      // What pi-ai's Anthropic provider would send, run through the hook the agent set.
      const body = { tools: (context.tools ?? []).map((t) => ({ name: t.name })), messages: [] }
      payloads.push(options?.onPayload?.(body, model))
      return m.stream(model, context, options)
    },
  })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  const chats = new ChatService(runtime, { resolver, settings, mcp, computer: hub })
  const sent = await chats.send('Scroll my Notes on my Mac', { ...config, leadModel: 'mock/claude' })
  for (let i = 0; i < 200; i++) {
    const s = foldColony(sent.colonyId, await runtime.ctx.log.read(sent.colonyId as never))
    const waiting = Object.values(s.approvals).find((a) => !a.decided)
    if (waiting) await chats.decideApproval(sent.colonyId, waiting.id, true)
    if (s.status !== 'running' && s.status !== 'created') break
    await Bun.sleep(25)
  }
  const s = await finished(sent.colonyId)
  expect(s.status).toBe('completed')
  const first = (await payloads[0]) as { tools: Record<string, unknown>[] }
  expect(first.tools.some((t) => t.type === 'computer_toolset_20260801')).toBe(true)
  expect(first.tools.some((t) => t.name === 'computer')).toBe(false)
  expect(asked().find((c) => c.name === 'scroll')?.args).toMatchObject({
    direction: 'down',
    amount: 2,
    x: 10,
    y: 10,
  })
})
