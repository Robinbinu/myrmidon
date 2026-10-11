import type { Budget, BudgetScope } from '@myrmidon/protocol'
import { MAX_BUDGET_USD } from './config.ts'
import { prompts } from './prompts.ts'

/**
 * Spend caps at three levels (global, a project, a chat), as OpenAI's and Anthropic's consoles, Cursor and LiteLLM
 * cap spend: a per-run cap, where the most specific level that sets one wins, and running totals, each a hard cap
 * (no new run starts once one is used up, and a running one stops at it) with the existing warning at 80% of what a
 * run may spend. A chat's total covers its whole life; a project's and the global one cover a calendar month in this
 * machine's time, starting again on the 1st. Spend is what models and tools reported: models without a known price
 * count as $0.
 */

/** A running total that is used up: which one, what was spent toward it and its cap. */
export interface CapHit {
  readonly scope: BudgetScope
  readonly spent: number
  readonly cap: number
}

/** A run refused because a running total is used up; the person raises the cap to go on. */
export class BudgetExceededError extends Error {
  constructor(readonly hit: CapHit) {
    super(prompts.budget.refused(hit.scope, hit.spent, hit.cap))
    this.name = 'BudgetExceededError'
  }
}

/** The caps a chat runs under, one level each. */
export interface Caps {
  readonly global: Budget
  readonly project?: Budget
  readonly chat?: Budget
}

/** What has been spent toward each running total: the chat's life, its project's month, everyone's month. */
export interface Spent {
  readonly chat: number
  readonly project: number
  readonly month: number
}

/** One round's spend and where it counts. */
export interface SpendEntry {
  readonly chatId: string
  readonly projectId?: string
  readonly startedAt?: string
  readonly cost: number
}

/** A budget as saved: positive caps only, each a number of dollars up to MAX_BUDGET_USD. Throws on anything else. */
export function normalizeBudget(raw: unknown): Budget {
  const given = (raw ?? {}) as Record<string, unknown>
  if (typeof given !== 'object' || Array.isArray(given)) throw new Error('a budget is { runUsd, totalUsd }')
  const cap = (key: 'runUsd' | 'totalUsd') => {
    const v = given[key]
    if (v === undefined || v === null || v === 0) return {}
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_BUDGET_USD)
      throw new Error(`${key} is a number of dollars from 0 to ${MAX_BUDGET_USD}`)
    return { [key]: v }
  }
  return { ...cap('runUsd'), ...cap('totalUsd') }
}

/** The calendar month a moment falls in, in this machine's time: `YYYY-MM`. */
export function monthOf(at: Date | string): string {
  const d = typeof at === 'string' ? new Date(at) : at
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** A round counts toward the month it started in, so a round running past midnight on the 31st stays in its month. */
export function spentFor(
  entries: readonly SpendEntry[],
  where: { chatId: string; projectId?: string | undefined },
  now = new Date(),
): Spent {
  const month = monthOf(now)
  let chat = 0
  let project = 0
  let all = 0
  for (const e of entries) {
    if (e.chatId === where.chatId) chat += e.cost
    const thisMonth = !!e.startedAt && monthOf(e.startedAt) === month
    if (!thisMonth) continue
    all += e.cost
    if (where.projectId && e.projectId === where.projectId) project += e.cost
  }
  return { chat, project, month: all }
}

/** The running totals set for a chat, most specific first, with what was spent toward each. */
function totals(caps: Caps, spent: Spent): CapHit[] {
  const out: CapHit[] = []
  if (caps.chat?.totalUsd) out.push({ scope: 'chat', spent: spent.chat, cap: caps.chat.totalUsd })
  if (caps.project?.totalUsd) out.push({ scope: 'project', spent: spent.project, cap: caps.project.totalUsd })
  if (caps.global.totalUsd) out.push({ scope: 'global', spent: spent.month, cap: caps.global.totalUsd })
  return out
}

/** Whether any running total is set at all, so a chat with none never reads what was spent. */
export function hasTotals(caps: Caps): boolean {
  return !!(caps.chat?.totalUsd || caps.project?.totalUsd || caps.global.totalUsd)
}

/** The first running total that is used up, the chat's before its project's before the global one. */
export function totalReached(caps: Caps, spent: Spent): CapHit | undefined {
  return totals(caps, spent).find((t) => t.spent >= t.cap)
}

/** The per-run cap: the chat's, else its project's, else the global one; none when no level sets one. */
export function runCap(caps: Caps): { usd: number; scope: BudgetScope } | undefined {
  if (caps.chat?.runUsd) return { usd: caps.chat.runUsd, scope: 'chat' }
  if (caps.project?.runUsd) return { usd: caps.project.runUsd, scope: 'project' }
  if (caps.global.runUsd) return { usd: caps.global.runUsd, scope: 'global' }
  return undefined
}

/**
 * The spend limit of a run (ColonySpec.budget): its per-run cap (`run`, see runCap), unless a running total has less
 * left, when it is what the run has spent so far (`counted`, as the colony counts it) plus what is left of that
 * total, and `total` names it. Rounded to cents, as it is shown.
 */
export function runLimit(
  run: number | undefined,
  caps: Caps,
  spent: Spent,
  counted = 0,
): { costUsd?: number; total?: { scope: BudgetScope; usd: number } } {
  let limit: { costUsd?: number; total?: { scope: BudgetScope; usd: number } } = run ? { costUsd: run } : {}
  let more = run ? run - counted : Number.POSITIVE_INFINITY
  for (const t of totals(caps, spent)) {
    const left = Math.max(0, t.cap - t.spent)
    if (left >= more) continue
    more = left
    limit = { costUsd: cents(counted + left), total: { scope: t.scope, usd: t.cap } }
  }
  return limit
}

const cents = (usd: number) => Math.max(0.01, Math.round(usd * 100) / 100)
