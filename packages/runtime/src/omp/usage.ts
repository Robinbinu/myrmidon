import { resolveUsedFraction, type UsageLimit, type UsageReport } from '@oh-my-pi/pi-ai'
import {
  accountIdentityLabel,
  collectUnreportedAccounts,
  selectReportableAccounts,
  type UsageAccountIdentity,
} from '@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-accounts'
import { PROVIDER_USAGE_CACHE_MS, PROVIDER_USAGE_TIMEOUT_MS, PROVIDER_USAGE_WARN } from '../config.ts'

/**
 * How close each signed-in account is to its plan's limits (Claude Pro/Max's 5-hour and weekly windows, ChatGPT's,
 * Copilot's premium requests…), read through omp's usage reporting: the same provider endpoints and per-account cache
 * omp's `/usage` uses. Only limits, plans and an account's name leave here; never a token.
 */

export type QuotaStatus = 'ok' | 'warning' | 'exhausted' | 'unknown'

export interface QuotaWindow {
  readonly id: string
  /** omp's label for it ("Claude 5 Hour", "Premium Requests"), with the window when the label leaves it out. */
  readonly label: string
  /** Share used, 0–100 (past 100 when the provider allows overage); absent when the provider gives no amount. */
  readonly usedPercent?: number
  /** Epoch ms. */
  readonly resetsAt?: number
  readonly status: QuotaStatus
}

/**
 * One account's limits, or why there are none: `unreachable` when omp has a usage endpoint for the provider but got
 * no answer for this account (offline, expired sign-in, rate-limited), `unsupported` when the provider has none.
 */
export interface AccountQuota {
  readonly provider: string
  /** Who the account is (an email, an account id), when the provider says; omitted for a chats-only device. */
  readonly account?: string
  readonly plan?: string
  readonly windows: readonly QuotaWindow[]
  /** The worst of its windows. */
  readonly status: QuotaStatus
  readonly error?: 'unreachable' | 'unsupported'
  readonly fetchedAt?: number
}

export interface QuotaSnapshot {
  readonly fetchedAt: number
  readonly accounts: readonly AccountQuota[]
  /** The whole read failed; the accounts are then empty. */
  readonly error?: string
}

/** What the quota reader needs from omp; a stub stands in for it in tests. */
export interface UsageSource {
  /** omp's live reports, per account (`AuthStorage.usage.reports`). */
  reports(signal: AbortSignal): Promise<UsageReport[] | null>
  /** Every stored credential, identity only (no secret). */
  accounts(): UsageAccountIdentity[]
  /** omp knows a usage endpoint for this provider. */
  supported(provider: string): boolean
  /** Drops omp's cached reports, for a refresh the person asked for. */
  invalidate(): Promise<void>
}

const RANK: Record<QuotaStatus, number> = { unknown: 0, ok: 1, warning: 2, exhausted: 3 }
const worst = (statuses: QuotaStatus[]): QuotaStatus =>
  statuses.reduce<QuotaStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), 'unknown')

function statusOf(limit: UsageLimit, fraction: number | undefined): QuotaStatus {
  // A provider's own verdict wins: some flag a limit exhausted before the amount says so.
  if (limit.status && limit.status !== 'unknown') return limit.status
  if (fraction === undefined) return 'unknown'
  if (fraction >= 1) return 'exhausted'
  return fraction >= PROVIDER_USAGE_WARN ? 'warning' : 'ok'
}

/** omp's `limitTitle` (usage CLI): the tier and window join the label unless it already names them. */
function windowLabel(limit: UsageLimit): string {
  let label = limit.label
  const tier = limit.scope.tier
  if (tier && !label.toLowerCase().includes(tier.toLowerCase())) label = `${label} (${tier})`
  const window = limit.window?.label ?? limit.scope.windowId
  if (
    !window ||
    window.toLowerCase() === 'quota window' ||
    label.toLowerCase().includes(window.toLowerCase())
  )
    return label
  return `${label} (${window})`
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** Who a report is for, as omp's `/usage` names it: email, else account or project id; with the org when it differs. */
function reportAccount(report: UsageReport): string | undefined {
  const meta = report.metadata ?? {}
  const scoped = report.limits.map((l) => l.scope.accountId ?? l.scope.projectId).find(Boolean)
  const base = text(meta.email) ?? text(meta.accountId) ?? text(meta.projectId) ?? scoped
  const org = text(meta.orgName) ?? text(meta.orgId)
  if (!base) return org
  return org && org !== base ? `${base} · ${org}` : base
}

/**
 * One quota several routes report (a Claude window behind two model ids) is shown once, as pi-tui's
 * `collapseSharedUsageReports` does; that package is not a dependency of the runtime.
 */
function distinctLimits(limits: readonly UsageLimit[]): UsageLimit[] {
  const groups = new Set<string>()
  return limits.filter((l) => {
    const group = l.scope.sharedGroup
    if (group === undefined) return true
    if (groups.has(group)) return false
    groups.add(group)
    return true
  })
}

function quotaFor(report: UsageReport): AccountQuota {
  const windows = distinctLimits(report.limits).map((limit): QuotaWindow => {
    const fraction = resolveUsedFraction(limit)
    const resetsAt = limit.window?.resetsAt
    return {
      id: limit.id,
      label: windowLabel(limit),
      ...(fraction !== undefined && Number.isFinite(fraction)
        ? { usedPercent: Math.round(Math.max(0, fraction) * 1000) / 10 }
        : {}),
      ...(resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {}),
      status: statusOf(limit, fraction),
    }
  })
  const account = reportAccount(report)
  const plan = text(report.metadata?.planType) ?? text(report.metadata?.plan)
  return {
    provider: report.provider,
    ...(account ? { account } : {}),
    ...(plan ? { plan } : {}),
    windows,
    status: worst(windows.map((w) => w.status)),
    fetchedAt: report.fetchedAt,
  }
}

/**
 * omp's reports and stored accounts, as accounts with limits, then the ones omp could not report on. A provider with
 * no usage endpoint is listed only for a subscription sign-in: an API key there is billed per call, with no plan to
 * run out of (omp's `/usage` leaves those out too).
 */
export function shapeQuota(
  reports: readonly UsageReport[],
  stored: readonly UsageAccountIdentity[],
  supported: (provider: string) => boolean,
): AccountQuota[] {
  const reported = reports.filter((r) => r.limits.length > 0)
  const reportable = selectReportableAccounts([...stored], supported)
  const unreachable = collectUnreportedAccounts([...reported], reportable).map(
    (a): AccountQuota => ({
      provider: a.provider,
      account: accountIdentityLabel(a),
      windows: [],
      status: 'unknown',
      error: 'unreachable',
    }),
  )
  const unsupported = stored
    .filter((a) => a.type === 'oauth' && !supported(a.provider))
    .map(
      (a): AccountQuota => ({
        provider: a.provider,
        account: accountIdentityLabel(a),
        windows: [],
        status: 'unknown',
        error: 'unsupported',
      }),
    )
  const byName = (a: AccountQuota, b: AccountQuota) =>
    a.provider.localeCompare(b.provider) || (a.account ?? '').localeCompare(b.account ?? '')
  return [...reported.map(quotaFor).sort(byName), ...[...unreachable, ...unsupported].sort(byName)]
}

export interface QuotaReader {
  /** The cached snapshot while it is fresh; `force` asks omp to reach every provider again. */
  read(options?: { force?: boolean }): Promise<QuotaSnapshot>
}

/**
 * Reads plan limits at most once per `cacheMs`; callers that ask while a read is under way share it, so any number of
 * open pages polling cost one round of provider calls.
 */
export function createQuotaReader(
  source: UsageSource,
  options: { cacheMs?: number; timeoutMs?: number; now?: () => number } = {},
): QuotaReader {
  const cacheMs = options.cacheMs ?? PROVIDER_USAGE_CACHE_MS
  const timeoutMs = options.timeoutMs ?? PROVIDER_USAGE_TIMEOUT_MS
  const now = options.now ?? Date.now
  let cached: QuotaSnapshot | undefined
  let pending: Promise<QuotaSnapshot> | undefined

  const fetchNow = async (force: boolean): Promise<QuotaSnapshot> => {
    try {
      if (force) await source.invalidate()
      const reports = (await source.reports(AbortSignal.timeout(timeoutMs))) ?? []
      return {
        fetchedAt: now(),
        accounts: shapeQuota(reports, source.accounts(), (p) => source.supported(p)),
      }
    } catch (err) {
      // Kept for the cache's time like a good read, so a failing provider is not retried on every poll.
      return { fetchedAt: now(), accounts: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  return {
    read({ force = false } = {}) {
      if (pending) return pending
      if (!force && cached && now() - cached.fetchedAt < cacheMs) return Promise.resolve(cached)
      pending = fetchNow(force).then((snapshot) => {
        cached = snapshot
        pending = undefined
        return snapshot
      })
      return pending
    },
  }
}
