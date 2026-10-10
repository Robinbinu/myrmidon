import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Schema } from '@myrmidon/core'
import type { PermissionLevels, ProjectPermissions, RoundGoal } from '@myrmidon/protocol'

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
  /** What a specialist worker is for, e.g. `researcher`; shown to the lead for routing. */
  specialty?: string
  /** A spawned worker's brief from the lead. */
  focus?: string
  /** Tools this agent may not use, whatever its role gives it (a saved specialist's switched-off groups). */
  withoutTools?: string[]
}

export interface ColonySpec {
  name: string
  mission: string
  pattern: 'blackboard' | 'lead-workers'
  agents: AgentSpec[]
  acceptance: AcceptanceCheck[]
  budget: { wallMs: number; costUsd?: number; tokens?: number; maxTurns: number }
  observer: { intervalMs: number }
  /** Model used to review individual task submissions; omit to accept tasks whose artifacts exist. */
  taskJudge?: string
  /** Set when the colony is one round of a chat conversation. */
  chat?: {
    chatId: string
    round: number
    request: string
    history: string
    /** The project folder this chat works in, if any. */
    project?: { id: string; name: string; path: string; permissions?: ProjectPermissions }
    /** Bigger tiers this round's agent may hand the request to with escalate. */
    escalate?: ('solo' | 'team')[]
    /** What the person keeps across chats, as prompt lines. */
    memory?: string[]
    /** Kept memories left out of `memory` for room, which agents search with recall. */
    memoryMore?: number
    /** The person started this round by writing to these crew members directly (@name): they start it, not the lead. */
    addressed?: string[]
    /** The opening message was said aloud on a voice call (its answer is read aloud). */
    voice?: boolean
    /** What the agents should know that the chat does not show, e.g. a voice call's transcript. */
    context?: string
    /**
     * What the person changed about what each agent may do since the round before, in words, by agent; it opens that
     * agent's first message of the round. Not logged: the round's `access` is, and this is worked out from it.
     */
    accessNotices?: Readonly<Record<string, string>>
  }
  /** How the team may grow at run time. */
  team?: TeamPolicy
  /**
   * Models an agent goes on with, in order, when its own fails in a way another model could get past: `lead` for the
   * lead, `workers` for crewmates and swarm peers. Taken from the settings each time a round starts or resumes; not
   * logged, the `agent/fallback` events say what happened.
   */
  fallbacks?: { lead?: string[]; workers?: string[] }
  /**
   * The advisor's model: it reads each agent's latest steps and steers the agent with a short note when it sees a
   * concrete problem (advisor.ts). Taken from the team config or settings each time a round starts or resumes, like
   * the fallbacks; absent, there is none.
   */
  advisor?: string
  /** Tools removed from every agent regardless of role. */
  disabledTools?: string[]
  /**
   * The permission model's levels for this round (global, the project's, the chat's): presets, rules, who may use
   * what. Re-read every round, and replaced in a running round when the person changes any of them. Absent on a bare
   * colony (`myr run`), which keeps the rules from before the model: commands and edits run, MCP tools that change
   * things ask (see `levelsOf`).
   */
  permissions?: PermissionLevels
  /**
   * Every call that changes something outside the colony waits for approval, whatever the person allowed: the round
   * was started by someone other than the person (a channel member), who must not borrow the person's permissions.
   */
  askAll?: boolean
  /**
   * Full access (the Full access preset in effect): commands run without the OS sandbox, file tools reach any path,
   * and the web and browser any address. It never holds while `askAll` does, nor in a read-only project
   * (see `fullAccessIn`).
   */
  fullAccess?: boolean
  /**
   * Folders the person lets sandboxed agents read beyond the defaults, from Settings and the project (absolute; the
   * chat's own grants are in its state). Never set while `askAll` holds, and ignored from the moment it does.
   */
  reads?: string[]
  /**
   * Computer use: agents may see and control the person's Mac, one app at a time once the person approves it. Set by
   * the chat when Settings → Computer use is on; never while `askAll` holds (see ColonyRun.computer).
   */
  computerUse?: boolean
  /** Chat rounds: when the reviewer (the judge) runs. Absent means on every final answer. */
  review?: 'off' | 'auto' | 'always'
  /** Chat rounds: how much machinery this request gets (solo unless the lead escalates to a team). */
  tier?: Tier
  /** How hard reasoning models think in work rounds; omitted lets each role decide. */
  thinking?: 'low' | 'medium' | 'high'
  /** Plan mode: present the plan for approval (ask_user) before any work. */
  planFirst?: boolean
  /**
   * Goal mode: each final answer is checked against the goal's condition, and the round goes on while it fails, up to
   * its cap (see `RoundGoal`, ColonyRun._goalHolds).
   */
  goal?: RoundGoal
  /**
   * Prewalk: the lead plans on its own (strong) model, then hands off once to this cheaper model to carry the plan out,
   * at its first change (ColonyRun._handOff). Taken from the team config or settings when a round starts.
   */
  prewalk?: string
}

/** `answer`: one agent replies directly; `solo`: one agent with every tool; `team`: the configured team. */
export type Tier = 'answer' | 'solo' | 'team'

export interface TeamPolicy {
  /**
   * `orchestrated`: a lead plans and assigns tasks to specialist workers (and may add more up to
   * `maxWorkers`); `swarm`: equal peers coordinate through shared notes and tasks.
   */
  mode: 'orchestrated' | 'swarm'
  maxWorkers: number
  /** Models the lead may assign to spawned workers; the first is the default. */
  workerModels: string[]
  /** The person's saved specialists the lead may bring in by name (add_crewmate), as they would join. */
  specialists?: AgentSpec[]
  /**
   * In a round the lead works alone: the crewmates the person set up, on call. The lead asks one for a piece of work
   * with ask_crewmate (it joins then, and waits for the answer) instead of handing the whole request to the team.
   */
  crewmates?: AgentSpec[]
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
    tokens: Schema.natural(),
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
      ...(raw.budget.tokens !== undefined ? { tokens: raw.budget.tokens } : {}),
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
