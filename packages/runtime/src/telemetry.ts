import { createHash } from 'node:crypto'
import type { EventPayloads, MyrEvent } from '@myrmidon/protocol'
import { TELEMETRY } from './config.ts'

/**
 * Telemetry export over OTLP: when the person turns it on in Settings and gives a collector's address, each finished
 * round goes to it as a trace (the round, each agent's turns, its model calls and tool calls) and a set of metrics
 * (tokens, cost, calls, trials), read from the round's event log. Off by default, and nothing is sent until it is on
 * and has an address. Only names, counts, timings and outcomes leave: never a prompt, a reply, a tool's arguments or
 * its output. Headers (a collector's API key) are kept in the credential vault with the model providers' keys, so
 * they are hidden from models like those (provider-secrets.ts) and never sit in the settings file.
 *
 * After omp's telemetry export (pi-coding-agent/src/telemetry-export.ts, telemetry-export-otlp.ts): the OTLP endpoint
 * convention (a base address, with /v1/traces and /v1/metrics added), the GenAI semantic-convention names for spans
 * and attributes (gen_ai.operation.name, gen_ai.request.model, gen_ai.tool.name, gen_ai.usage.*), counters labelled
 * by tool and status, and its attribute cleaning. Unlike omp, which registers the OpenTelemetry SDK process-wide from
 * OTEL_* variables and exports while the agent runs, this builds OTLP/HTTP JSON from the log once a round ends, so the
 * person can change the address or turn it off at any time, and no SDK is loaded.
 */

/** The settings that decide whether and where to send. */
export interface TelemetrySettings {
  readonly enabled: boolean
  readonly endpoint: string
}

/** Where the headers are kept: the credential vault (omp's, as voice providers' keys are). */
export interface TelemetryVault {
  get(id: string): Promise<string | undefined>
  stored(id: string): boolean
  set(id: string, value: string): Promise<void>
  remove(id: string): Promise<void>
}

type Attr = {
  key: string
  value: { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean }
}

/** OTLP attributes from plain values; absent and empty ones are left out (after omp's `metricAttributes`). */
function attrs(fields: Readonly<Record<string, string | number | boolean | undefined>>): Attr[] {
  const out: Attr[] = []
  for (const [key, v] of Object.entries(fields)) {
    if (v === undefined || v === '') continue
    if (typeof v === 'string') out.push({ key, value: { stringValue: v } })
    else if (typeof v === 'boolean') out.push({ key, value: { boolValue: v } })
    else if (Number.isInteger(v)) out.push({ key, value: { intValue: String(v) } })
    else if (Number.isFinite(v)) out.push({ key, value: { doubleValue: v } })
  }
  return out
}

const nanos = (iso: string) => `${BigInt(Date.parse(iso)) * 1_000_000n}`
const hex = (text: string, length: number) => createHash('sha256').update(text).digest('hex').slice(0, length)

/**
 * The person's headers as OTEL_EXPORTER_OTLP_HEADERS writes them: `name=value` pairs split by commas, values
 * percent-encoded where they need to be. Throws on a pair that is not one.
 */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of text.split(/[,\n]/)) {
    const part = pair.trim()
    if (!part) continue
    const at = part.indexOf('=')
    const name = at > 0 ? part.slice(0, at).trim() : ''
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error(`not a header: ${part.slice(0, 40)}`)
    let value = part.slice(at + 1).trim()
    try {
      value = decodeURIComponent(value)
    } catch {
      // A value with a bare % is taken as written.
    }
    out[name] = value
  }
  return out
}

/** The collector's address for one signal: the base the person gave, with `/v1/<signal>` (OTLP's convention). */
export function signalUrl(endpoint: string, signal: 'traces' | 'metrics'): string {
  const base = endpoint
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1\/(traces|metrics|logs)$/, '')
  return `${base}/v1/${signal}`
}

/** The events of the round that `end` finished: from the round's (or its resume's) start up to `end`. */
export function roundEvents(events: readonly MyrEvent[], end: MyrEvent): MyrEvent[] {
  const upTo = events.filter((e) => e.seq <= end.seq)
  const start = upTo.findLastIndex((e) => e.type === 'colony/started' || e.type === 'round/started')
  return upTo.slice(Math.max(0, start))
}

const ENDS = new Set(['colony/completed', 'colony/failed', 'colony/stopped'])

interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Attr[]
  status: { code: number; message?: string }
  events?: { name: string; timeUnixNano: string; attributes: Attr[] }[]
}

/** A number counted per set of attributes, for one metric of the round. */
class Counter {
  private readonly _points = new Map<string, { attributes: Attr[]; value: number }>()
  constructor(
    readonly name: string,
    readonly unit: string,
    readonly description: string,
    readonly integer: boolean,
  ) {}
  add(value: number, fields: Readonly<Record<string, string | number | boolean | undefined>>) {
    if (!Number.isFinite(value) || value <= 0) return
    const attributes = attrs(fields)
    const key = JSON.stringify(attributes)
    const point = this._points.get(key) ?? { attributes, value: 0 }
    point.value += value
    this._points.set(key, point)
  }
  otlp(start: string, end: string) {
    if (!this._points.size) return undefined
    return {
      name: this.name,
      unit: this.unit,
      description: this.description,
      // Each round sends what happened in it alone (delta temporality), so nothing is kept between rounds.
      sum: {
        aggregationTemporality: 1,
        isMonotonic: true,
        dataPoints: [...this._points.values()].map((p) => ({
          attributes: p.attributes,
          startTimeUnixNano: start,
          timeUnixNano: end,
          ...(this.integer ? { asInt: String(Math.round(p.value)) } : { asDouble: p.value }),
        })),
      },
    }
  }
}

export interface RoundTelemetry {
  readonly traces: Record<string, unknown>
  readonly metrics: Record<string, unknown>
  readonly spans: number
}

/**
 * A finished round as OTLP/HTTP JSON: one trace (the round, each agent's turns, its model calls and tool calls under
 * them) and its metrics, from `events` (see `roundEvents`). Ids are derived from the log, so sending a round twice
 * sends the same spans.
 */
export function roundTelemetry(colonyId: string, events: readonly MyrEvent[]): RoundTelemetry | undefined {
  const first = events[0]
  const last = events.at(-1)
  if (!first || !last || !ENDS.has(last.type)) return undefined
  const traceId = hex(`${colonyId}\0${first.id}`, 32)
  const spanId = (key: string) => hex(`${traceId}\0${key}`, 16)
  const rootId = spanId('round')
  const created = events.find((e) => e.type === 'round/started' || e.type === 'colony/created')?.payload as
    | EventPayloads['colony/created']
    | undefined
  const spans: Span[] = []
  const turns = new Map<string, { id: string; start: MyrEvent }>()
  const lastSeen = new Map<string, string>()
  const calls = new Map<string, MyrEvent>()
  const trials: NonNullable<Span['events']> = []
  const span = (
    key: string,
    name: string,
    start: string,
    end: string,
    fields: Record<string, string | number | boolean | undefined>,
    parent = rootId,
    error?: string,
  ) =>
    spans.push({
      traceId,
      spanId: spanId(key),
      parentSpanId: parent,
      name,
      kind: 1,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(end),
      attributes: attrs(fields),
      status: error === undefined ? { code: 0 } : { code: 2, message: error },
    })
  const tokens = new Counter(
    'myrmidon.tokens',
    '{token}',
    'Tokens models processed, by model and type.',
    true,
  )
  const cost = new Counter(
    'myrmidon.cost',
    'USD',
    'What model calls cost, as their providers reported it.',
    false,
  )
  const modelCalls = new Counter(
    'myrmidon.model.calls',
    '{call}',
    'Model calls, by model and how they ended.',
    true,
  )
  const toolCalls = new Counter('myrmidon.tool.calls', '{call}', 'Tool calls, by tool and status.', true)
  const toolTime = new Counter('myrmidon.tool.duration', 'ms', 'Time spent in tool calls, by tool.', false)
  const rounds = new Counter('myrmidon.rounds', '{round}', 'Rounds that ended, by how.', true)
  const experiments = new Counter(
    'myrmidon.experiment.trials',
    '{trial}',
    'Autoresearch trials, by outcome.',
    true,
  )
  const parentOf = (agent: string) => turns.get(agent)?.id ?? rootId

  const closeTurn = (agent: string, end: string) => {
    const open = turns.get(agent)
    if (!open) return
    const t = open.start.payload as EventPayloads['agent/turn']
    spans.push({
      traceId,
      spanId: open.id,
      parentSpanId: rootId,
      name: `invoke_agent ${agent}`,
      kind: 1,
      startTimeUnixNano: nanos(open.start.time),
      endTimeUnixNano: nanos(end),
      attributes: attrs({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': agent,
        'myrmidon.turn': t.turn,
        'myrmidon.trigger': t.trigger,
      }),
      status: { code: 0 },
    })
    turns.delete(agent)
  }

  for (const e of events) {
    switch (e.type) {
      case 'agent/turn': {
        const t = e.payload as EventPayloads['agent/turn']
        closeTurn(t.agent, e.time)
        if (t.phase === 'start') turns.set(t.agent, { id: spanId(`turn:${e.id}`), start: e })
        break
      }
      case 'llm/response': {
        const r = e.payload as EventPayloads['llm/response']
        // The call started after the agent's previous step: the last thing it did, or its turn starting.
        const start = lastSeen.get(`${r.agent}\0step`) ?? turns.get(r.agent)?.start.time ?? e.time
        span(
          `llm:${e.id}`,
          `chat ${r.model}`,
          start,
          e.time,
          {
            'gen_ai.operation.name': 'chat',
            'gen_ai.request.model': r.model,
            'gen_ai.agent.name': r.agent,
            'gen_ai.usage.input_tokens': r.usage?.input,
            'gen_ai.usage.output_tokens': r.usage?.output,
            'gen_ai.response.finish_reasons': r.stopReason,
            'myrmidon.cost_usd': r.usage?.cost,
          },
          parentOf(r.agent),
          r.error,
        )
        tokens.add(r.usage?.input ?? 0, { 'gen_ai.request.model': r.model, 'gen_ai.token.type': 'input' })
        tokens.add(r.usage?.output ?? 0, { 'gen_ai.request.model': r.model, 'gen_ai.token.type': 'output' })
        cost.add(r.usage?.cost ?? 0, { 'gen_ai.request.model': r.model })
        modelCalls.add(1, { 'gen_ai.request.model': r.model, 'gen_ai.response.finish_reasons': r.stopReason })
        lastSeen.set(`${r.agent}\0step`, e.time)
        break
      }
      case 'tool/call':
        calls.set((e.payload as EventPayloads['tool/call']).callId, e)
        break
      case 'tool/result': {
        const r = e.payload as EventPayloads['tool/result']
        const call = calls.get(r.callId)
        const start = call?.time ?? e.time
        span(
          `tool:${e.id}`,
          `execute_tool ${r.tool}`,
          start,
          e.time,
          {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': r.tool,
            'gen_ai.tool.call.id': r.callId,
            'gen_ai.agent.name': r.agent,
          },
          parentOf(r.agent),
          r.ok ? undefined : 'error',
        )
        toolCalls.add(1, { 'gen_ai.tool.name': r.tool, 'myrmidon.tool.status': r.ok ? 'ok' : 'error' })
        toolTime.add(Date.parse(e.time) - Date.parse(start), { 'gen_ai.tool.name': r.tool })
        if (r.usage) {
          tokens.add(r.usage.totalTokens, { 'gen_ai.tool.name': r.tool, 'gen_ai.token.type': 'total' })
          cost.add(r.usage.cost ?? 0, { 'gen_ai.tool.name': r.tool })
        }
        lastSeen.set(`${r.agent}\0step`, e.time)
        break
      }
      case 'experiment/trial': {
        const t = e.payload as EventPayloads['experiment/trial']
        experiments.add(1, { 'myrmidon.experiment.outcome': t.outcome })
        trials.push({
          name: 'experiment.trial',
          timeUnixNano: nanos(e.time),
          attributes: attrs({
            'gen_ai.agent.name': t.agent,
            'myrmidon.experiment.trial': t.trial,
            'myrmidon.experiment.outcome': t.outcome,
            'myrmidon.experiment.metric': t.metric,
          }),
        })
        break
      }
    }
  }
  // A turn still going when the round ended (its end is logged after) ends with the round.
  for (const agent of [...turns.keys()]) closeTurn(agent, last.time)
  const status = last.type.slice('colony/'.length)
  rounds.add(1, { 'myrmidon.round.status': status, 'myrmidon.round.tier': created?.tier })
  const totalSpans = spans.length + 1
  const kept = spans.slice(0, TELEMETRY.maxSpans - 1)
  // A turn is written after its calls, so a cut can leave a call without its turn: it hangs under the round instead.
  const sent = new Set([rootId, ...kept.map((s) => s.spanId)])
  for (const s of kept) if (s.parentSpanId && !sent.has(s.parentSpanId)) s.parentSpanId = rootId
  const root: Span = {
    traceId,
    spanId: rootId,
    name: 'myrmidon.round',
    kind: 1,
    startTimeUnixNano: nanos(first.time),
    endTimeUnixNano: nanos(last.time),
    attributes: attrs({
      'myrmidon.colony.id': colonyId,
      'myrmidon.chat.round': created?.chat?.round,
      'myrmidon.round.tier': created?.tier,
      'myrmidon.round.status': status,
      'myrmidon.agents': created?.agents.length,
      'myrmidon.spans.left_out':
        totalSpans > TELEMETRY.maxSpans ? totalSpans - TELEMETRY.maxSpans : undefined,
    }),
    status:
      last.type === 'colony/failed'
        ? { code: 2, message: (last.payload as EventPayloads['colony/failed']).reason }
        : { code: 0 },
    ...(trials.length ? { events: trials } : {}),
  }
  const resource = { attributes: attrs({ 'service.name': TELEMETRY.serviceName }) }
  const scope = { name: TELEMETRY.serviceName }
  const start = nanos(first.time)
  const end = nanos(last.time)
  const metrics = [tokens, cost, modelCalls, toolCalls, toolTime, rounds, experiments]
    .map((c) => c.otlp(start, end))
    .filter((m) => m !== undefined)
  return {
    traces: { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: [root, ...kept] }] }] },
    metrics: { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics }] }] },
    spans: kept.length + 1,
  }
}

/** How the last send went, for Settings. */
export interface TelemetryStatus {
  readonly at: string
  readonly ok: boolean
  readonly spans?: number
  readonly error?: string
}

export interface TelemetryExportOptions {
  /** Read at each round's end, so a change in Settings applies to the next one. */
  readonly settings: () => TelemetrySettings
  readonly vault?: TelemetryVault
  /** A colony's whole log. */
  readonly read: (colonyId: string) => Promise<readonly MyrEvent[]>
  readonly fetch?: typeof fetch
}

/** Sends each finished round to the person's OTLP collector, one at a time, when Settings says to. */
export class TelemetryExport {
  private _queue: Promise<unknown> = Promise.resolve()
  private _last?: TelemetryStatus

  constructor(private readonly options: TelemetryExportOptions) {}

  /** What the last send did; none before the first. */
  status(): TelemetryStatus | undefined {
    return this._last
  }

  /** Whether headers are kept in the vault. */
  headersSet(): boolean {
    return this.options.vault?.stored(TELEMETRY.headersId) ?? false
  }

  /** Keeps the person's headers in the vault, after checking they read as headers; empty removes them. */
  async setHeaders(text: string): Promise<void> {
    const vault = this.options.vault
    if (!vault) throw new Error('headers need the credential vault')
    if (!text.trim()) return vault.remove(TELEMETRY.headersId)
    parseHeaders(text)
    await vault.set(TELEMETRY.headersId, text.trim())
  }

  /** Called with every batch the log appends: a round that ended is sent, if export is on. */
  appended(colonyId: string, events: readonly MyrEvent[]): void {
    const end = events.find((e) => ENDS.has(e.type))
    if (!end) return
    const { enabled, endpoint } = this.options.settings()
    if (!enabled || !endpoint.trim()) return
    this._queue = this._queue.then(() => this.sendRound(colonyId, end)).catch(() => {})
  }

  /** Waits for the sends under way (shutting down). */
  flush(): Promise<unknown> {
    return this._queue
  }

  /** Sends the round `end` finished. */
  async sendRound(colonyId: string, end: MyrEvent): Promise<TelemetryStatus> {
    const round = roundTelemetry(colonyId, roundEvents(await this.options.read(colonyId), end))
    if (!round) return this._record({ at: new Date().toISOString(), ok: true, spans: 0 })
    return this._send(round.traces, round.metrics, round.spans)
  }

  /** Settings' test: one span, so the person sees whether the collector takes what Myrmidon sends. */
  async test(): Promise<TelemetryStatus> {
    const now = new Date().toISOString()
    const traceId = hex(`test\0${now}`, 32)
    const traces = {
      resourceSpans: [
        {
          resource: { attributes: attrs({ 'service.name': TELEMETRY.serviceName }) },
          scopeSpans: [
            {
              scope: { name: TELEMETRY.serviceName },
              spans: [
                {
                  traceId,
                  spanId: hex(traceId, 16),
                  name: 'myrmidon.telemetry.test',
                  kind: 1,
                  startTimeUnixNano: nanos(now),
                  endTimeUnixNano: nanos(now),
                  attributes: [],
                  status: { code: 0 },
                },
              ],
            },
          ],
        },
      ],
    }
    return this._send(traces, undefined, 1)
  }

  private async _send(
    traces: Record<string, unknown>,
    metrics: Record<string, unknown> | undefined,
    spans: number,
  ): Promise<TelemetryStatus> {
    const at = new Date().toISOString()
    const { endpoint } = this.options.settings()
    if (!endpoint.trim()) return this._record({ at, ok: false, error: 'no collector address' })
    try {
      const stored = await this.options.vault?.get(TELEMETRY.headersId)
      const headers = { 'content-type': 'application/json', ...(stored ? parseHeaders(stored) : {}) }
      const post = async (signal: 'traces' | 'metrics', body: unknown) => {
        const res = await (this.options.fetch ?? fetch)(signalUrl(endpoint, signal), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TELEMETRY.timeoutMs),
        })
        if (!res.ok) throw new Error(`${signal}: ${res.status} ${res.statusText}`.trim())
      }
      await post('traces', traces)
      if (metrics) await post('metrics', metrics)
      return this._record({ at, ok: true, spans })
    } catch (err) {
      return this._record({ at, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private _record(status: TelemetryStatus): TelemetryStatus {
    this._last = status
    return status
  }
}
