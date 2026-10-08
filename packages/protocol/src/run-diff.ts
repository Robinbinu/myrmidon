import { type ColonyMetrics, colonyMetrics, foldColony, reviewVerdicts, stopCause } from './colony-state.ts'
import type { MyrEvent } from './event.ts'
import type { EventPayloads } from './payloads.ts'

/** One run as the comparison shows it: how it ended and what it cost. */
export interface RunSide {
  id: string
  name: string
  status: string
  /** It stopped to wait for the person's answer. */
  awaiting?: true
  /** It stopped because a model failed. */
  failed?: true
  /** What the run was asked to do; a comparison means most when both had the same task. */
  task: string
  tier?: string
  /** The team's mode, only when the run used a team: a solo round carries the chat's team settings unused. */
  mode?: string
  models: string[]
  metrics: ColonyMetrics
  judge?: { pass: boolean; score?: number }
  finalReply?: string
}

export interface RunAgentRow {
  name: string
  a?: { model: string; turns: number; tokens: number; toolCalls: number }
  b?: { model: string; turns: number; tokens: number; toolCalls: number }
}

/** What differs between two runs, e.g. the same request before and after a prompt change. */
export interface RunDiff {
  a: RunSide
  b: RunSide
  /** Tool calls per tool in each run, biggest difference first. */
  tools: { tool: string; a: number; b: number }[]
  /** Files each run produced: only in one, or in both with the same or different final content. */
  files: { name: string; in: 'a' | 'b' | 'both'; same?: boolean }[]
  agents: RunAgentRow[]
}

function side(id: string, events: readonly MyrEvent[]) {
  const state = foldColony(id, events)
  const replies = state.chatMessages.filter((m) => m.from !== 'user')
  const final = replies.filter((m) => m.final).at(-1) ?? replies.at(-1)
  const verdict = reviewVerdicts(state)
    .filter((v) => v.target === 'colony')
    .at(-1)
  const run: RunSide = {
    id,
    name: state.name,
    status: state.status,
    ...stopCause(state),
    task: state.chat?.request ?? state.mission,
    ...(state.tier ? { tier: state.tier } : {}),
    ...(state.team?.mode && (state.tier ?? 'team') === 'team' ? { mode: state.team.mode } : {}),
    models: [...new Set(Object.values(state.agents).map((a) => a.info.model))],
    metrics: colonyMetrics(state),
    ...(verdict
      ? { judge: { pass: verdict.pass, ...(verdict.score !== undefined ? { score: verdict.score } : {}) } }
      : {}),
    ...(final ? { finalReply: final.text.slice(0, 600) } : {}),
  }
  const tools = new Map<string, number>()
  for (const e of events)
    if (e.type === 'tool/call') {
      const tool = (e.payload as EventPayloads['tool/call']).tool
      tools.set(tool, (tools.get(tool) ?? 0) + 1)
    }
  const files = new Map(
    Object.entries(state.artifacts)
      .filter(([, v]) => v.some((x) => x.author !== 'previous-round' && x.author !== 'user'))
      .map(([name, v]) => [name, v.at(-1)?.blob]),
  )
  return { run, state, tools, files }
}

export function runDiff(
  a: { id: string; events: readonly MyrEvent[] },
  b: { id: string; events: readonly MyrEvent[] },
): RunDiff {
  const left = side(a.id, a.events)
  const right = side(b.id, b.events)
  const tools = [...new Set([...left.tools.keys(), ...right.tools.keys()])]
    .map((tool) => ({ tool, a: left.tools.get(tool) ?? 0, b: right.tools.get(tool) ?? 0 }))
    .sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b) || x.tool.localeCompare(y.tool))
  const files = [...new Set([...left.files.keys(), ...right.files.keys()])].sort().map((name) => {
    const inA = left.files.has(name)
    const inB = right.files.has(name)
    return inA && inB
      ? { name, in: 'both' as const, same: left.files.get(name) === right.files.get(name) }
      : { name, in: inA ? ('a' as const) : ('b' as const) }
  })
  const agentOf = (s: typeof left.state, name: string) => {
    const v = s.agents[name]
    return v ? { model: v.info.model, turns: v.turns, tokens: v.tokens, toolCalls: v.toolCalls } : undefined
  }
  const agents = [...new Set([...Object.keys(left.state.agents), ...Object.keys(right.state.agents)])].map(
    (name): RunAgentRow => {
      const x = agentOf(left.state, name)
      const y = agentOf(right.state, name)
      return { name, ...(x ? { a: x } : {}), ...(y ? { b: y } : {}) }
    },
  )
  return { a: left.run, b: right.run, tools, files, agents }
}
