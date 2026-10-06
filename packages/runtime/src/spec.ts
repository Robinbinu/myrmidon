import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Schema } from '@myrmidon/core'

export type AcceptanceCheck =
  | {
      verifier: 'checks'
      rules: {
        artifact: string
        exists?: boolean
        contains?: string
        notContains?: string
        minBytes?: number
        maxBytes?: number
      }[]
    }
  | { verifier: 'command'; run: string; against: string[]; timeoutMs?: number }
  | { verifier: 'llm-judge'; model: string; rubric: string; threshold: number }

export interface AgentSpec {
  name: string
  role: string
  model: string
  /** Extra role instructions appended to the pattern's role prompt. */
  instructions?: string
  tools?: string[]
}

export interface ColonySpec {
  name: string
  mission: string
  pattern: 'blackboard' | 'lead-workers'
  agents: AgentSpec[]
  acceptance: AcceptanceCheck[]
  budget: { wallMs: number; costUsd?: number; maxTurns: number }
  observer: { intervalMs: number }
  /** Model used to review individual task submissions; omit to accept tasks whose artifacts exist. */
  taskJudge?: string
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/

export function parseDuration(value: string | number): number {
  if (typeof value === 'number') return value
  const m = DURATION.exec(value.trim())
  if (!m) throw new Error(`invalid duration: ${value} (use e.g. 90s, 15m, 1h)`)
  const n = Number(m[1])
  return Math.round(n * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as 'ms' | 's' | 'm' | 'h'])
}

const rawSchema = Schema.object({
  name: Schema.string().required(),
  mission: Schema.string().required(),
  pattern: Schema.union(['blackboard', 'lead-workers']).default('blackboard'),
  agents: Schema.array(
    Schema.object({
      name: Schema.string()
        .pattern(/^[a-z][a-z0-9-]{0,31}$/)
        .required(),
      role: Schema.string().default('worker'),
      model: Schema.string().required(),
      instructions: Schema.string(),
      tools: Schema.array(Schema.string()),
      count: Schema.natural().min(1).max(16).default(1),
    }),
  ).required(),
  acceptance: Schema.array(Schema.any()).default([]),
  budget: Schema.object({
    wall: Schema.union([String, Number]).default('15m'),
    costUsd: Schema.number(),
    maxTurns: Schema.natural().default(40),
  }).default({ wall: '15m', maxTurns: 40 }),
  observer: Schema.object({ interval: Schema.union([String, Number]).default('30s') }).default({
    interval: '30s',
  }),
  taskJudge: Schema.string(),
})

/** Loads a colony YAML file; `mission` and `rubric` values ending in .md are read relative to it. */
export function loadColonySpec(path: string): ColonySpec {
  const file = resolve(path)
  const base = dirname(file)
  return parseColonySpec(Bun.YAML.parse(readFileSync(file, 'utf8')), (p) =>
    readFileSync(resolve(base, p), 'utf8'),
  )
}

export function parseColonySpec(input: unknown, readFile: (path: string) => string = () => ''): ColonySpec {
  const raw = rawSchema(input as Parameters<typeof rawSchema>[0])
  const inline = (v: string) => (/\.(md|txt)$/i.test(v.trim()) ? readFile(v.trim()) : v)
  const agents: AgentSpec[] = []
  for (const a of raw.agents) {
    for (let i = 1; i <= a.count; i++) {
      agents.push({
        name: a.count === 1 ? a.name : `${a.name}-${i}`,
        role: a.role,
        model: a.model,
        ...(a.instructions ? { instructions: a.instructions } : {}),
        ...(a.tools && a.tools.length > 0 ? { tools: a.tools } : {}),
      })
    }
  }
  const names = new Set<string>()
  for (const a of agents) {
    if (names.has(a.name)) throw new Error(`duplicate agent name: ${a.name}`)
    names.add(a.name)
  }
  const acceptance = raw.acceptance.map((c, i) => parseCheck(c, i, inline))
  return {
    name: raw.name,
    mission: inline(raw.mission),
    pattern: raw.pattern as ColonySpec['pattern'],
    agents,
    acceptance,
    budget: {
      wallMs: parseDuration(raw.budget.wall),
      ...(raw.budget.costUsd !== undefined ? { costUsd: raw.budget.costUsd } : {}),
      maxTurns: raw.budget.maxTurns,
    },
    observer: { intervalMs: parseDuration(raw.observer.interval) },
    ...(raw.taskJudge ? { taskJudge: raw.taskJudge } : {}),
  }
}

function parseCheck(c: unknown, i: number, inline: (v: string) => string): AcceptanceCheck {
  const check = c as Record<string, unknown>
  switch (check?.verifier) {
    case 'checks':
      if (!Array.isArray(check.rules) || check.rules.length === 0)
        throw new Error(`acceptance[${i}]: checks needs rules`)
      return {
        verifier: 'checks',
        rules: check.rules as Extract<AcceptanceCheck, { verifier: 'checks' }>['rules'],
      }
    case 'command':
      if (typeof check.run !== 'string') throw new Error(`acceptance[${i}]: command needs run`)
      return {
        verifier: 'command',
        run: check.run,
        against: Array.isArray(check.against) ? (check.against as string[]) : [],
        ...(typeof check.timeoutMs === 'number' ? { timeoutMs: check.timeoutMs } : {}),
      }
    case 'llm-judge':
      if (typeof check.model !== 'string' || typeof check.rubric !== 'string') {
        throw new Error(`acceptance[${i}]: llm-judge needs model and rubric`)
      }
      return {
        verifier: 'llm-judge',
        model: check.model,
        rubric: inline(check.rubric),
        threshold: typeof check.threshold === 'number' ? check.threshold : 0.7,
      }
    default:
      throw new Error(`acceptance[${i}]: unknown verifier ${JSON.stringify(check?.verifier)}`)
  }
}
