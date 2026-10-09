import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
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
import type { AgentToolResult } from '@oh-my-pi/pi-agent-core'
import { createMockModel } from '@oh-my-pi/pi-ai/providers/mock'
import type { ComputerRunOk } from '@oh-my-pi/pi-coding-agent/tools/computer/protocol'
import {
  ComputerSupervisor,
  type ComputerWorkerHandle,
} from '@oh-my-pi/pi-coding-agent/tools/computer/supervisor'
import {
  bootRuntime,
  ChatService,
  type ColonyHost,
  ComputerHub,
  computerTool,
  DESKTOP_GRANT,
  DesktopEngine,
  desktopTool,
  launchApp,
  ModelResolver,
  type Runtime,
  SettingsStore,
  type TeamConfig,
} from '../src/index.ts'

// omp's worker never runs here: a stand-in controller answers each script, and the person's answers come from `decide`.

interface Ran {
  code: string
  readOnly: boolean
  timeoutMs: number
}

let home: string
let runs: Ran[]
let closed: number
let launched: string[]
/** What a script does in the stand-in: calls `tool.open_app` when it says so. */
let bridgeOf: (name: string, args: unknown) => Promise<unknown>
let engine: 'cua' | 'omp'
let hub: ComputerHub

const PNG = Buffer.from('fake png').toString('base64')

function fakeController(bridge: (name: string, args: unknown) => Promise<unknown>) {
  bridgeOf = bridge
  return {
    async run(code: string, timeoutMs: number, snapshot: { readOnly: boolean }): Promise<ComputerRunOk> {
      runs.push({ code, readOnly: snapshot.readOnly, timeoutMs })
      const opened = /open_app\(\{ app: "(\w+)" \}\)/.exec(code)
      const value = opened
        ? await bridgeOf('open_app', { app: opened[1] })
        : [{ app: 'Notes', title: 'Groceries' }]
      return {
        displays: [
          { type: 'text', text: 'screenshot 1 1280×800 → /nonexistent.png' },
          { type: 'image', data: PNG, mimeType: 'image/png' },
        ],
        returnValue: value,
        screenshots: [{ path: join(home, 'none.png'), width: 1280, height: 800, target: '1' }],
      }
    },
    async capabilities() {
      return undefined
    },
    async close() {
      closed++
    },
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'myr-desktop-'))
  runs = []
  closed = 0
  launched = []
  engine = 'omp'
  hub = new ComputerHub(home, {
    enabled: () => true,
    platform: 'darwin',
    grants: () => ({ accessibility: true, screenRecording: true }),
    engine: () => engine,
    desktop: new DesktopEngine({
      factory: (bridge) => fakeController(bridge),
      launch: async (app) => {
        launched.push(app)
        return `${app} is open`
      },
    }),
  })
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

const textOf = (r: AgentToolResult) =>
  r.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')

/** A round's host as far as the desktop tool uses it. */
function fakeHost(options: { decide?: (summary: string) => boolean; rules?: PermissionRule[] } = {}) {
  const events: EventDraft[] = []
  const cards: { summary: string; offers: boolean }[] = []
  let apps: ComputerApp[] = []
  let rules = options.rules ?? []
  const host = {
    id: 'colony-test',
    spec: {},
    permit: (_agent: string, call: PermissionCall) =>
      decide({ global: { preset: 'full', rules: [] }, chat: { rules } }, call),
    boundary: 'b0undary',
    blobs: new BlobStore(join(home, 'blobs')),
    workspace: { scratch: () => home },
    computer: hub,
    state: () => ({ status: 'running', computerApps: apps, signals: [] }) as unknown as ColonyState,
    huddling: () => false,
    rememberUntrusted() {},
    async append(draft: EventDraft) {
      events.push(draft)
      if (draft.type === 'computer/apps') apps = (draft.payload as { apps: ComputerApp[] }).apps
      return draft
    },
    async reviewChange(_agent: string, _tool: string, summary: string, opts: { permission?: unknown }) {
      cards.push({ summary, offers: opts.permission !== undefined })
      return { approved: options.decide ? options.decide(summary) : true }
    },
  } as unknown as ColonyHost
  return { host, events, cards, allowForChat: (r: PermissionRule[]) => (rules = r) }
}

const run = (host: ColonyHost, args: Record<string, unknown>) =>
  desktopTool('nova', host).execute('c1', args as never, undefined, undefined, undefined as never)

test('looking at the screen asks once per chat, then a read-only script runs with its output and screenshot', async () => {
  const { host, events, cards } = fakeHost()
  const look = await run(host, { code: 'return await desktop.windows()', read_only: true })
  expect(look.isError).toBe(false)
  expect(cards.map((c) => c.summary)).toEqual(['Let the agent see your screen'])
  expect(runs[0]).toMatchObject({ readOnly: true, timeoutMs: 30_000 })
  // What the screen shows is outside content; the latest screenshot comes back as an image.
  expect(textOf(look)).toContain('⟦untrusted b0undary · computer:desktop⟧')
  expect(textOf(look)).toContain('"title": "Groceries"')
  expect(look.content.some((c) => c.type === 'image')).toBe(true)
  expect(events.find((e) => e.type === 'computer/apps')?.payload).toEqual({
    apps: [{ bundleId: DESKTOP_GRANT, name: 'Your screen (omp desktop engine)', tier: 'view' }],
  })
  expect(events.find((e) => e.type === 'computer/control')?.payload).toEqual({
    agent: 'nova',
    app: 'the desktop',
    active: true,
  })
  expect(events.some((e) => e.type === 'computer/keyframe')).toBe(true)
  expect(hub.controls().map((c) => `${c.agent}:${c.app}`)).toEqual(['nova:the desktop'])

  await run(host, { code: 'return await (await desktop.window({ app: "Notes" })).ax()', read_only: true })
  expect(cards).toHaveLength(1)
  expect(runs).toHaveLength(2)
})

test('a script that acts asks every time, even under full access, until the person allows desktop for the chat', async () => {
  const { host, cards, allowForChat } = fakeHost()
  const code = 'const win = await desktop.window({ app: "Notes" })\nawait win.type("milk")'
  await run(host, { code })
  await run(host, { code })
  expect(cards).toHaveLength(2)
  expect(cards[0]?.summary).toStartWith('Let the agent run this script on your Mac: const win')
  // The card offers to remember the answer (this chat, the project, everywhere).
  expect(cards[0]?.offers).toBe(true)
  expect(runs.map((r) => r.readOnly)).toEqual([false, false])
  allowForChat([{ kind: 'tool', target: 'desktop', decision: 'allow' }])
  await run(host, { code })
  expect(cards).toHaveLength(2)
  expect(runs).toHaveLength(3)
})

test('a declined script never runs; a rule can refuse desktop, or ask before every script that only looks', async () => {
  const declined = fakeHost({ decide: () => false })
  const r = await run(declined.host, { code: 'await desktop.press("cmd+q")' })
  expect(r.isError).toBe(true)
  expect(textOf(r)).toContain('did not approve that script')
  expect(runs).toHaveLength(0)

  const denied = fakeHost({ rules: [{ kind: 'tool', target: 'desktop', decision: 'deny' }] })
  expect(textOf(await run(denied.host, { code: 'return 1', read_only: true }))).toContain('ERROR')
  expect(denied.cards).toHaveLength(0)

  const asks = fakeHost({ rules: [{ kind: 'tool', target: 'desktop', decision: 'ask' }] })
  await run(asks.host, { code: 'return 1', read_only: true })
  await run(asks.host, { code: 'return 2', read_only: true })
  expect(asks.cards.map((c) => c.summary.split(':')[0])).toEqual([
    'Let the agent run this script on your Mac',
    'Let the agent run this script on your Mac',
  ])
  expect(runs.map((r) => r.readOnly)).toEqual([true, true])
})

test('a script opens an app with tool.open_app only when it may act, and secrets are never run', async () => {
  const { host } = fakeHost()
  const looking = await run(host, { code: 'return await tool.open_app({ app: "Notes" })', read_only: true })
  expect(textOf(looking)).toContain('a read_only script cannot')
  expect(launched).toEqual([])
  const acting = await run(host, { code: 'return await tool.open_app({ app: "Notes" })' })
  expect(acting.isError).toBe(false)
  expect(launched).toEqual(['Notes'])
  expect(textOf(acting)).toContain('Notes is open')
  // Only open_app crosses from a script to Myrmidon.
  await expect(bridgeOf('shell', { command: 'ls' })).rejects.toThrow('only tool.open_app')
  const secret = await run(host, { code: 'await win.type("sk-ant-abcdefghijklmnopqrstuvwxyz0123")' })
  expect(textOf(secret)).toContain('never types secrets')
  // Launching refuses Myrmidon itself and anything that reads as a flag, before running `open`.
  await expect(launchApp('Myrmidon')).rejects.toThrow('never shown to or driven by agents')
  await expect(launchApp('-n')).rejects.toThrow('needs app')
})

test('each engine refuses the other’s tool, and Stop ends the round’s scripts for good', async () => {
  const { host } = fakeHost()
  engine = 'cua'
  expect(textOf(await run(host, { code: 'return 1', read_only: true }))).toContain('runs on Cua Driver now')
  engine = 'omp'
  const computer = computerTool('nova', host, () => ({ id: 'm', api: 'mock', provider: 'mock' }) as never)
  const r = await computer.execute(
    'c2',
    { action: 'screenshot' } as never,
    undefined,
    undefined,
    undefined as never,
  )
  expect(textOf(r)).toContain('omp desktop engine now')

  let stopped = 0
  hub.newRound('colony-test', () => stopped++)
  await run(host, { code: 'return 1', read_only: true })
  expect(hub.stopAll()).toBe(1)
  expect(stopped).toBe(1)
  await Bun.sleep(0)
  expect(closed).toBe(1)
  expect(textOf(await run(host, { code: 'return 1', read_only: true }))).toContain('stopped computer use')
})

test("omp's own supervisor carries a script's tool.open_app to Myrmidon and its answer back", async () => {
  // A stand-in for omp's worker: on a run it asks for open_app, then reports what the host answered.
  const worker = (): ComputerWorkerHandle => {
    const handlers: ((m: never) => void)[] = []
    const emit = (m: unknown) =>
      queueMicrotask(() => {
        for (const h of handlers) h(m as never)
      })
    let runId = ''
    return {
      send(message) {
        if (message.type === 'run') {
          runId = message.id
          emit({ type: 'tool-call', id: 't1', runId, name: 'open_app', args: { app: 'Notes' } })
        }
        if (message.type === 'tool-reply')
          emit({
            type: 'result',
            id: runId,
            ok: true,
            payload: { displays: [], returnValue: message.reply, screenshots: [] },
          })
      },
      onMessage(handler) {
        handlers.push(handler as never)
        emit({ type: 'ready' })
        return () => {}
      },
      onError: () => () => {},
      terminate: async () => {},
    }
  }
  hub = new ComputerHub(home, {
    enabled: () => true,
    platform: 'darwin',
    grants: () => ({ accessibility: true, screenRecording: true }),
    engine: () => 'omp',
    desktop: new DesktopEngine({
      factory: (bridge) => new ComputerSupervisor({} as never, worker, undefined, (n, a) => bridge(n, a)),
      launch: async (app) => {
        launched.push(app)
        return `${app} is open`
      },
    }),
  })
  const { host } = fakeHost()
  const r = await run(host, { code: 'await tool.open_app({ app: "Notes" })' })
  expect(r.isError).toBe(false)
  expect(launched).toEqual(['Notes'])
  expect(textOf(r)).toContain('"value": "Notes is open"')
})

// The chat decides who gets which tool: the engine in Settings picks Cua Driver's tools or omp's.

let runtime: Runtime

test('a round gets the desktop tool with omp’s engine and the computer tools with Cua Driver, never both', async () => {
  runtime = await bootRuntime(join(home, 'rt'))
  try {
    const settings = new SettingsStore(home)
    settings.set({ ...settings.get(), computerUse: { enabled: true } })
    const offered: string[][] = []
    const resolver = new ModelResolver()
    const m = createMockModel({
      handler: (ctx) => {
        offered.push((ctx.tools ?? []).map((t) => t.name))
        return {
          content: [{ type: 'toolCall', name: 'reply_user', arguments: { text: 'Done.', final: true } }],
        }
      },
    })
    resolver.register('mock/lead', { model: m.model, streamFn: m.stream })
    const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
    resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
    const config: TeamConfig = {
      mode: 'orchestrated',
      leadModel: 'mock/lead',
      roster: [],
      judgeModel: 'mock/judge',
    }
    for (const e of ['omp', 'cua'] as const) {
      engine = e
      const chats = new ChatService(runtime, { resolver, settings, computer: hub })
      const sent = await chats.send('What is on my screen in Notes?', config)
      for (let i = 0; i < 400; i++) {
        const s = foldColony(sent.colonyId, await runtime.ctx.log.read(sent.colonyId as never))
        if (s.status !== 'running' && s.status !== 'created') break
        await Bun.sleep(25)
      }
    }
    expect(offered[0]).toContain('desktop')
    expect(offered[0]?.filter((n) => ['computer', 'open_app', 'list_apps'].includes(n))).toEqual([])
    expect(offered.at(-1)).toEqual(expect.arrayContaining(['computer', 'open_app', 'list_apps']))
    expect(offered.at(-1)).not.toContain('desktop')
  } finally {
    await runtime.dispose()
  }
})
