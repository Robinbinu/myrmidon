import {
  type ColonyMetrics,
  type ColonyState,
  colonyMetrics,
  foldColony,
  type RoundInfo,
} from './colony-state.ts'
import type { MyrEvent } from './event.ts'
import type { EventPayloads } from './payloads.ts'

/** One round of a chat colony, as a view on its own: its events, its state at its end, and what it cost. */
export interface RoundSlice {
  readonly info?: RoundInfo
  readonly events: readonly MyrEvent[]
  /** The colony as the round left it, with the round's own messages and verdicts only. */
  readonly state: ColonyState
  /** This round's time, tokens and tool calls, not the colony's running totals. */
  readonly metrics: ColonyMetrics
}

/**
 * A chat colony serves every round of its chat; this cuts one round out of it (the latest without `round`).
 * `full` is the colony's current state, already folded from `events`.
 */
export function roundSlice(full: ColonyState, events: readonly MyrEvent[], round?: number): RoundSlice {
  const info = round === undefined ? full.rounds.at(-1) : full.rounds.find((r) => r.round === round)
  if (!info) return { events, state: full, metrics: colonyMetrics(full) }
  const end = info.endSeq ?? Number.POSITIVE_INFINITY
  const inRound = (seq: number) => seq >= info.startSeq && seq <= end
  const latest = info === full.rounds.at(-1)
  const atEnd = latest ? full : foldColony(full.id, events, info.endSeq)
  const before = foldColony(full.id, events, info.startSeq - 1)
  // The round's agents: those it started with, and any that joined during it.
  const slice = events.filter((e) => inRound(e.seq))
  const names = new Set<string>()
  for (const e of slice) {
    if (e.type === 'colony/created' || e.type === 'round/started')
      for (const a of (e.payload as EventPayloads['colony/created']).agents) names.add(a.name)
    if (e.type === 'agent/joined') names.add((e.payload as EventPayloads['agent/joined']).agent.name)
  }
  const state: ColonyState = {
    ...atEnd,
    agents: names.size
      ? Object.fromEntries(Object.entries(atEnd.agents).filter(([name]) => names.has(name)))
      : atEnd.agents,
    status: info.status,
    ...(info.statusReason ? { statusReason: info.statusReason } : {}),
    chatMessages: atEnd.chatMessages.filter((m) => inRound(m.seq)),
    verdicts: atEnd.verdicts.filter((v) => inRound(v.seq)),
    signals: atEnd.signals.filter((s) => inRound(s.seq)),
  }
  const now = colonyMetrics(atEnd)
  const was = colonyMetrics(before)
  const scores = state.verdicts.map((v) => v.score).filter((s): s is number => s !== undefined)
  const metrics: ColonyMetrics = {
    wallMs: Math.max(0, Date.parse(info.endedAt ?? new Date().toISOString()) - Date.parse(info.startedAt)),
    tokens: now.tokens - was.tokens,
    ...(now.cost !== undefined && was.cost !== undefined ? { cost: now.cost - was.cost } : {}),
    turns: now.turns - was.turns,
    toolCalls: now.toolCalls - was.toolCalls,
    messages: now.messages - was.messages,
    artifactVersions: now.artifactVersions - was.artifactVersions,
    rejections: state.verdicts.filter((v) => !v.pass).length,
    ...(scores.length ? { bestScore: Math.max(...scores) } : {}),
  }
  return { info, events: slice, state, metrics }
}
