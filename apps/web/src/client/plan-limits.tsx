import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from './api.ts'
import { copy } from './copy.ts'
import { ago } from './ui/hooks.ts'
import { FEATURE_ICONS } from './ui/icons.ts'
import { ProviderLogo } from './ui/ProviderGlyph.tsx'
import { Badge, Button, Card, cn, SectionHeader } from './ui/primitives.tsx'
import { PLAN_LEVEL_LEFT, PLAN_LIMITS_POLL_MS } from './ui-config.ts'

/** What `GET /api/usage` answers (the runtime's omp/usage.ts). */
export type QuotaStatus = 'ok' | 'warning' | 'exhausted' | 'unknown'

export interface QuotaWindow {
  id: string
  label: string
  usedPercent?: number
  resetsAt?: number
  status: QuotaStatus
}

export interface AccountQuota {
  provider: string
  /** Absent for a chats-only device. */
  account?: string
  plan?: string
  windows: QuotaWindow[]
  status: QuotaStatus
  error?: 'unreachable' | 'unsupported'
}

export interface QuotaSnapshot {
  fetchedAt: number
  accounts?: AccountQuota[]
  error?: string
}

/** Plan limits, asked again every PLAN_LIMITS_POLL_MS while mounted; `refresh` makes the gateway ask every provider. */
export function usePlanLimits(): {
  snapshot?: QuotaSnapshot
  refreshing: boolean
  refresh(): Promise<void>
} {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot>()
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => {
    let live = true
    // A gateway without the chat runtime, or an older one without the route, simply shows no limits.
    const load = () =>
      api<QuotaSnapshot>('/api/usage')
        .then((s) => live && setSnapshot(s))
        .catch(() => {})
    void load()
    const timer = setInterval(load, PLAN_LIMITS_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      setSnapshot(await api<QuotaSnapshot>('/api/usage?refresh=1'))
    } catch {
      // The poll keeps the last good answer on screen.
    } finally {
      setRefreshing(false)
    }
  }, [])
  return { ...(snapshot ? { snapshot } : {}), refreshing, refresh }
}

/** Time until a reset the way the meters say it: 3d 4h, 2h 10m, 12m. */
export function untilText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const resetText = (w: QuotaWindow, now: number) =>
  w.resetsAt !== undefined && w.resetsAt > now
    ? copy.planLimits.resetsIn(untilText(w.resetsAt - now))
    : undefined

const RANK: Record<QuotaStatus, number> = { unknown: 0, ok: 1, warning: 2, exhausted: 3 }

/**
 * What the composer says about a model's provider: only when every account omp could use for it is near or at a
 * limit, since omp moves to another account of the same provider when one runs out. Undefined when there is room.
 */
export function limitNotice(
  snapshot: QuotaSnapshot | undefined,
  provider: string,
  now = Date.now(),
): string | undefined {
  const accounts = (snapshot?.accounts ?? []).filter((a) => a.provider === provider && a.windows.length)
  if (!accounts.length) return undefined
  const roomiest = accounts.reduce((a, b) => (RANK[b.status] < RANK[a.status] ? b : a))
  if (roomiest.status !== 'warning' && roomiest.status !== 'exhausted') return undefined
  const tightest = roomiest.windows.reduce((a, b) =>
    RANK[b.status] > RANK[a.status] ||
    (RANK[b.status] === RANK[a.status] && (b.usedPercent ?? 0) > (a.usedPercent ?? 0))
      ? b
      : a,
  )
  const resets = resetText(tightest, now)
  return tightest.status === 'exhausted'
    ? copy.planLimits.atLimit(tightest.label, resets)
    : copy.planLimits.nearLimit(tightest.label, Math.round(tightest.usedPercent ?? 0), resets)
}

/** How full the battery on the model chip shows: what is left of the plan, in four steps. */
export type PlanLevel = 'full' | 'mid' | 'low' | 'empty'

/**
 * The battery for a model's provider: its roomiest account (omp moves to another when one runs out), read by its
 * tightest window. Undefined when no account of that provider reports its use (an API key, or a provider omp cannot
 * ask), so the chip shows no battery rather than a guess.
 */
export function planLevel(
  snapshot: QuotaSnapshot | undefined,
  provider: string,
  now = Date.now(),
): { level: PlanLevel; left: number; text: string } | undefined {
  const accounts = (snapshot?.accounts ?? []).filter((a) => a.provider === provider && a.windows.length)
  if (!accounts.length) return undefined
  const usedOf = (a: AccountQuota) =>
    a.status === 'exhausted'
      ? 100
      : Math.max(...a.windows.map((w) => (w.status === 'exhausted' ? 100 : (w.usedPercent ?? 0))))
  const roomiest = accounts.reduce((a, b) => (usedOf(b) < usedOf(a) ? b : a))
  if (roomiest.windows.every((w) => w.usedPercent === undefined && w.status !== 'exhausted')) return undefined
  const tightest = roomiest.windows.reduce((a, b) =>
    (b.status === 'exhausted' ? 100 : (b.usedPercent ?? 0)) >
    (a.status === 'exhausted' ? 100 : (a.usedPercent ?? 0))
      ? b
      : a,
  )
  const left = Math.max(0, Math.round(100 - usedOf(roomiest)))
  const [full, mid] = PLAN_LEVEL_LEFT
  const level: PlanLevel =
    left <= 0 ? 'empty' : roomiest.status === 'warning' || left < mid ? 'low' : left < full ? 'mid' : 'full'
  return { level, left, text: copy.planLimits.left(tightest.label, left, resetText(tightest, now)) }
}

const BAR: Record<QuotaStatus, string> = {
  ok: 'bg-ok',
  warning: 'bg-warn',
  exhausted: 'bg-bad',
  unknown: 'bg-muted/60',
}

function WindowMeter(props: { window: QuotaWindow; now: number }) {
  const w = props.window
  const percent = w.usedPercent === undefined ? undefined : Math.round(w.usedPercent)
  const resets = resetText(w, props.now)
  return (
    <div className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-callout">
      <span className="truncate text-fg-2" title={w.label}>
        {w.label}
      </span>
      {/* The bar is drawn for the eye; a screen reader hears the meter, as Settings' other levels do. */}
      {percent !== undefined && (
        <meter
          className="sr-only"
          aria-label={w.label}
          aria-valuetext={[copy.planLimits.usedLong(w.label, percent), resets].filter(Boolean).join(', ')}
          min={0}
          max={100}
          value={Math.min(100, percent)}
        />
      )}
      <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-fill-strong">
        <div
          className={cn('h-full rounded-full', BAR[w.status])}
          style={{ width: `${Math.min(100, percent ?? (w.status === 'exhausted' ? 100 : 0))}%` }}
        />
      </div>
      <span className="whitespace-nowrap text-right font-mono text-footnote tabular-nums text-muted">
        {percent !== undefined ? copy.planLimits.used(percent) : copy.planLimits.noAmount}
        {resets && <span className="ml-2 font-sans">{resets}</span>}
      </span>
    </div>
  )
}

function AccountRow(props: { account: AccountQuota; now: number }) {
  const a = props.account
  const status = a.status === 'warning' || a.status === 'exhausted' ? a.status : undefined
  return (
    <div className="px-4 py-3" data-plan-account={a.provider}>
      <div className="flex flex-wrap items-center gap-2 text-reading font-medium">
        <ProviderLogo provider={a.provider} size={16} className="shrink-0" />
        <span className="font-mono text-callout">{a.provider}</span>
        {a.account && (
          <span className="min-w-0 truncate text-callout font-normal text-muted">{a.account}</span>
        )}
        {a.plan && <Badge>{a.plan}</Badge>}
        {status && (
          <Badge tone={status === 'exhausted' ? 'bad' : 'warn'}>{copy.planLimits.status[status]}</Badge>
        )}
      </div>
      {a.error ? (
        <p className="mt-1 text-callout text-muted">
          {a.error === 'unsupported' ? copy.planLimits.unsupported : copy.planLimits.unreachable}
        </p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {a.windows.map((w) => (
            <WindowMeter key={w.id} window={w} now={props.now} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Settings → Models & providers: a meter per window of each signed-in account; nothing when there are none. */
export function PlanLimits() {
  const { snapshot, refreshing, refresh } = usePlanLimits()
  const accounts = snapshot?.accounts ?? []
  if (!snapshot || (!accounts.length && !snapshot.error)) return null
  const now = Date.now()
  return (
    <section className="mb-8" aria-label={copy.planLimits.title}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <SectionHeader
          icon={<FEATURE_ICONS.planLimits className="size-4 text-muted" />}
          title={copy.planLimits.title}
          note={copy.planLimits.note}
        />
        <Button
          size="sm"
          variant="borderless"
          onClick={() => void refresh()}
          loading={refreshing}
          icon={<RefreshCw className="size-3.5" />}
          title={copy.planLimits.checked(ago(new Date(snapshot.fetchedAt).toISOString()))}
        >
          {refreshing ? copy.planLimits.refreshing : copy.planLimits.refresh}
        </Button>
      </div>
      {snapshot.error ? (
        <p className="text-callout text-bad-ink">{copy.planLimits.failed(snapshot.error)}</p>
      ) : (
        <Card>
          {accounts.map((a, i) => (
            <AccountRow key={`${a.provider}|${a.account ?? i}`} account={a} now={now} />
          ))}
        </Card>
      )}
    </section>
  )
}
