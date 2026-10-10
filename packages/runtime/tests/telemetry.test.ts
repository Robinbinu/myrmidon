import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, foldColony, type MyrEvent } from '@myrmidon/protocol'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import {
  bootRuntime,
  ChatService,
  ModelResolver,
  type Runtime,
  SettingsStore,
  type TeamConfig,
} from '../src/index.ts'
import {
  parseHeaders,
  roundEvents,
  roundTelemetry,
  signalUrl,
  TelemetryExport,
  type TelemetrySettings,
  type TelemetryVault,
} from '../src/telemetry.ts'

/** A stand-in OTLP collector: it keeps what each signal's path received, with the request's headers. */
const received: { path: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
let failWith = 0
let collector: ReturnType<typeof Bun.serve>
let endpoint: string

beforeAll(() => {
  collector = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      received.push({
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers),
        body: (await req.json()) as Record<string, unknown>,
      })
      return failWith ? new Response('nope', { status: failWith }) : Response.json({})
    },
  })
  endpoint = `http://127.0.0.1:${collector.port}`
})
afterAll(() => collector.stop(true))
beforeEach(() => {
  received.length = 0
  failWith = 0
})

function vault(initial: Record<string, string> = {}): TelemetryVault {
  const kept = new Map(Object.entries(initial))
  return {
    get: async (id) => kept.get(id),
    stored: (id) => kept.has(id),
    set: async (id, value) => void kept.set(id, value),
    remove: async (id) => void kept.delete(id),
  }
}

let seq = 0
const at = (s: number) => new Date(Date.UTC(2026, 9, 10, 12, 0, s)).toISOString()
const event = (type: string, payload: unknown, s: number): MyrEvent =>
  ({
    colonyId: 'colony-x',
    seq: ++seq,
    id: `e${seq}`,
    time: at(s),
    type,
    actor: { kind: 'system', id: 'myrmidon' },
    trace: { traceId: 't', spanId: 's' },
    schema: 1,
    payload,
  }) as MyrEvent

/** A round of one agent: a turn with a model call, a tool call that failed, and the round completing. */
function round(): MyrEvent[] {
  seq = 0
  return [
    event('colony/created', { tier: 'solo', agents: [{ name: 'lead' }], chat: { round: 2 } }, 0),
    event('colony/started', {}, 1),
    event('agent/turn', { agent: 'lead', phase: 'start', turn: 1, trigger: 'kickoff' }, 1),
    event(
      'llm/response',
      {
        agent: 'lead',
        model: 'anthropic/claude-x',
        text: 'SECRET PLAN',
        toolCalls: [],
        usage: { input: 1000, output: 200, totalTokens: 1200, cost: 0.02 },
        stopReason: 'toolUse',
      },
      4,
    ),
    event('tool/call', { agent: 'lead', callId: 'c1', tool: 'shell', args: { command: 'cat .env' } }, 4),
    event('tool/result', { agent: 'lead', callId: 'c1', tool: 'shell', ok: false, output: 'TOKEN=abc' }, 6),
    event(
      'experiment/trial',
      { agent: 'lead', trial: 1, outcome: 'kept', metric: 8, best: 8, ms: 10, description: '' },
      7,
    ),
    event('agent/turn', { agent: 'lead', phase: 'end', turn: 1, trigger: 'kickoff' }, 8),
    event('colony/completed', { verdicts: [] }, 9),
  ]
}

/** The first list under `path` of an OTLP JSON body (each level holds one resource and one scope here). */
const first = (body: Record<string, unknown>, ...path: string[]): unknown =>
  path.reduce<unknown>((at, key) => {
    const v = (at as Record<string, unknown> | undefined)?.[key]
    return Array.isArray(v) && key !== path.at(-1) ? v[0] : v
  }, body)
const spansOf = (traces: Record<string, unknown>) =>
  (first(traces, 'resourceSpans', 'scopeSpans', 'spans') ?? []) as {
    name: string
    spanId: string
    parentSpanId?: string
    traceId: string
    startTimeUnixNano: string
    endTimeUnixNano: string
    attributes: { key: string; value: Record<string, unknown> }[]
    status: { code: number }
    events?: unknown[]
  }[]
const metricsOf = (metrics: Record<string, unknown>) =>
  (first(metrics, 'resourceMetrics', 'scopeMetrics', 'metrics') ?? []) as {
    name: string
    sum: {
      aggregationTemporality: number
      dataPoints: { attributes: unknown[]; asInt?: string; asDouble?: number }[]
    }
  }[]
const attr = (span: { attributes: { key: string; value: Record<string, unknown> }[] }, key: string) =>
  Object.values(span.attributes.find((a) => a.key === key)?.value ?? {})[0]

test('headers read as OTEL_EXPORTER_OTLP_HEADERS writes them, and the address takes each signal path', () => {
  expect(parseHeaders('x-api-key=abc, Authorization=Bearer%20t0k')).toEqual({
    'x-api-key': 'abc',
    Authorization: 'Bearer t0k',
  })
  expect(() => parseHeaders('just a key')).toThrow('not a header')
  expect(signalUrl('http://localhost:4318/', 'traces')).toBe('http://localhost:4318/v1/traces')
  expect(signalUrl('https://otel.example.com/v1/traces', 'metrics')).toBe(
    'https://otel.example.com/v1/metrics',
  )
})

test('a finished round is one trace of its turns, model and tool calls, and metrics, with none of its content', () => {
  const events = round()
  expect(roundTelemetry('colony-x', events.slice(0, -1))).toBeUndefined()
  const out = roundTelemetry('colony-x', events)
  if (!out) throw new Error('no telemetry')
  const spans = spansOf(out.traces)
  expect(spans.map((s) => s.name)).toEqual([
    'myrmidon.round',
    'chat anthropic/claude-x',
    'execute_tool shell',
    'invoke_agent lead',
  ])
  const [root, chat, tool, turn] = spans
  if (!root || !chat || !tool || !turn) throw new Error('missing spans')
  expect(new Set(spans.map((s) => s.traceId)).size).toBe(1)
  expect(root.parentSpanId).toBeUndefined()
  expect(turn.parentSpanId).toBe(root.spanId)
  // The calls hang under the turn they happened in.
  expect(chat.parentSpanId).toBe(turn.spanId)
  expect(tool.parentSpanId).toBe(turn.spanId)
  expect(attr(chat, 'gen_ai.usage.input_tokens')).toBe('1000')
  expect(attr(tool, 'gen_ai.tool.name')).toBe('shell')
  expect(tool.status.code).toBe(2)
  expect(BigInt(tool.endTimeUnixNano) - BigInt(tool.startTimeUnixNano)).toBe(2_000_000_000n)
  expect(attr(root, 'myrmidon.round.status')).toBe('completed')
  expect(root.events).toHaveLength(1)
  const metrics = metricsOf(out.metrics)
  const metric = (name: string) => metrics.find((m) => m.name === name)
  expect(
    metric('myrmidon.tokens')
      ?.sum.dataPoints.map((p) => p.asInt)
      .sort(),
  ).toEqual(['1000', '200'])
  expect(metric('myrmidon.cost')?.sum.dataPoints[0]?.asDouble).toBe(0.02)
  expect(metric('myrmidon.tool.calls')?.sum.dataPoints[0]?.asInt).toBe('1')
  expect(metric('myrmidon.rounds')?.sum.aggregationTemporality).toBe(1)
  expect(metric('myrmidon.experiment.trials')?.sum.dataPoints[0]?.asInt).toBe('1')
  // Names, counts and timings only: the model's text, the command and its output stay home.
  const sent = JSON.stringify(out)
  for (const content of ['SECRET PLAN', 'cat .env', 'TOKEN=abc']) expect(sent).not.toContain(content)
  // Sending a round again sends the same spans.
  expect(spansOf(roundTelemetry('colony-x', round())?.traces ?? {}).map((s) => s.spanId)).toEqual(
    spans.map((s) => s.spanId),
  )
})

test('a resumed round is sent from where it resumed, not from the round before', () => {
  const events = [...round().slice(0, -1), event('colony/stopped', { reason: 'server stopped' }, 20)]
  seq = 100
  const resumed = [
    ...events,
    event('colony/started', { resumed: true }, 30),
    event('colony/completed', { verdicts: [] }, 31),
  ]
  const end = resumed.at(-1) as MyrEvent
  expect(roundEvents(resumed, end).map((e) => e.type)).toEqual(['colony/started', 'colony/completed'])
  const stop = events.at(-1) as MyrEvent
  expect(roundEvents(resumed, stop)[0]?.type).toBe('colony/started')
  expect(roundEvents(resumed, stop)).toHaveLength(events.length - 1)
})

test('export is off by default, sends nothing without an address, and sends each round with the vault headers', async () => {
  let settings: TelemetrySettings = { enabled: false, endpoint: '' }
  const events = round()
  const keys = vault()
  const telemetry = new TelemetryExport({ settings: () => settings, vault: keys, read: async () => events })
  const end = events.at(-1) as MyrEvent
  telemetry.appended('colony-x', [end])
  settings = { enabled: true, endpoint: '' }
  telemetry.appended('colony-x', [end])
  settings = { enabled: false, endpoint }
  telemetry.appended('colony-x', [end])
  await telemetry.flush()
  expect(received).toEqual([])
  expect(telemetry.status()).toBeUndefined()

  settings = { enabled: true, endpoint }
  await expect(telemetry.setHeaders('not a header')).rejects.toThrow('not a header')
  await telemetry.setHeaders('x-api-key=k3y')
  expect(telemetry.headersSet()).toBe(true)
  // Only a batch with a round's end sends anything.
  telemetry.appended('colony-x', events.slice(2, 4))
  telemetry.appended('colony-x', [end])
  await telemetry.flush()
  expect(received.map((r) => r.path)).toEqual(['/v1/traces', '/v1/metrics'])
  expect(received[0]?.headers['x-api-key']).toBe('k3y')
  expect(received[0]?.headers['content-type']).toBe('application/json')
  expect(spansOf(received[0]?.body ?? {})).toHaveLength(4)
  expect(telemetry.status()).toMatchObject({ ok: true, spans: 4 })

  // A collector that refuses is reported, not retried.
  failWith = 500
  expect(await telemetry.test()).toMatchObject({ ok: false, error: 'traces: 500 Internal Server Error' })
  failWith = 0
  expect(await telemetry.test()).toMatchObject({ ok: true, spans: 1 })
  expect(spansOf(received.at(-1)?.body ?? {})[0]?.name).toBe('myrmidon.telemetry.test')
  await telemetry.setHeaders('')
  expect(telemetry.headersSet()).toBe(false)
})

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-telemetry-'))
  runtime = await bootRuntime(home)
})
afterEach(async () => {
  await runtime.dispose()
  rmSync(home, { recursive: true, force: true })
})

test('a chat round that finishes is read from its log and sent once export is on', async () => {
  const settings = new SettingsStore(home)
  expect(settings.get().telemetry).toEqual({ enabled: false, endpoint: '' })
  expect(() =>
    settings.set({ ...settings.get(), telemetry: { enabled: true, endpoint: 'ftp://x' } }),
  ).toThrow()
  settings.set({ ...settings.get(), telemetry: { enabled: true, endpoint } })
  const telemetry = new TelemetryExport({
    settings: () => settings.get().telemetry,
    read: (id) => runtime.ctx.log.read(id as never),
  })
  runtime.ctx.on('log/appended', (id, events) => telemetry.appended(id, events))
  const tool = (name: string, args: Record<string, unknown>): MockContent => ({
    type: 'toolCall',
    name,
    arguments: args,
  })
  const script: MockContent[][] = [[tool('reply_user', { text: 'Hello there.', final: true })]]
  let call = 0
  const resolver = new ModelResolver()
  const lead = createMockModel({ handler: () => ({ content: script[call++] ?? ['ok'] }) })
  resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
  const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
  resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
  const config: TeamConfig = {
    mode: 'orchestrated',
    leadModel: 'mock/lead',
    roster: [],
    judgeModel: 'mock/judge',
  }
  const chats = new ChatService(runtime, { resolver, settings })
  const { colonyId } = await chats.send('Say hello', config)
  let state: ColonyState | undefined
  for (let i = 0; i < 400 && !received.some((r) => r.path === '/v1/metrics'); i++) {
    state = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    await Bun.sleep(25)
  }
  await telemetry.flush()
  expect(state?.status === 'running' || state?.status === 'completed').toBe(true)
  const spans = spansOf(received.find((r) => r.path === '/v1/traces')?.body ?? {})
  expect(spans[0]?.name).toBe('myrmidon.round')
  expect(spans.some((s) => s.name === 'execute_tool reply_user')).toBe(true)
  expect(spans.some((s) => s.name === 'chat mock/mock-model')).toBe(true)
  expect(spans.some((s) => s.name === 'invoke_agent lead')).toBe(true)
  // Every span hangs under one that was sent.
  const ids = new Set(spans.map((s) => s.spanId))
  expect(spans.filter((s) => s.parentSpanId && !ids.has(s.parentSpanId))).toEqual([])
  expect(JSON.stringify(received)).not.toContain('Hello there.')
  await chats.stopAll()
})
