import { type AuditKind, auditOf, type MyrEvent } from '@myrmidon/protocol'
import { Ban, FileCode, Globe, Search, ShieldCheck, SquareTerminal, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn, Empty, Pill, Select, TextInput } from '../ui/primitives.tsx'
import { FoldAll, FoldChevron, useFolds } from './Folds.tsx'

const KINDS: { value: AuditKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'file', label: 'Files' },
  { value: 'url', label: 'URLs' },
  { value: 'command', label: 'Commands' },
  { value: 'search', label: 'Searches' },
  { value: 'other', label: 'Other' },
]

const ICONS: Record<AuditKind, typeof FileCode> = {
  file: FileCode,
  url: Globe,
  command: SquareTerminal,
  search: Search,
  other: Wrench,
}

const STOPPED_BY = {
  person: 'you declined',
  timeout: 'no answer in time',
  hook: 'a hook blocked it',
  safety: 'flagged',
}

/** Every file, URL and command the round's agents touched, and what was stopped, from the event log. */
export function AuditView(props: { events: readonly MyrEvent[] }) {
  const audit = useMemo(() => auditOf(props.events), [props.events])
  const [kind, setKind] = useState<AuditKind | 'all'>('all')
  const [agent, setAgent] = useState('')
  const [query, setQuery] = useState('')
  const folds = useFolds(() => false)
  const agents = useMemo(() => [...new Set(audit.entries.map((e) => e.agent))].sort(), [audit])
  const q = query.trim().toLowerCase()
  const targets = audit.targets.filter(
    (t) =>
      (kind === 'all' || t.kind === kind) &&
      (!agent || t.agents.includes(agent)) &&
      (!q || t.target.toLowerCase().includes(q)),
  )
  const count = (k: AuditKind | 'all') =>
    k === 'all' ? audit.targets.length : audit.targets.filter((t) => t.kind === k).length
  const keyOf = (t: { kind: string; target: string }) => `${t.kind}\0${t.target}`

  if (audit.entries.length === 0 && audit.stops.length === 0)
    return (
      <Empty icon={<ShieldCheck className="size-5" />} title="Nothing touched yet">
        Every file, URL and command the agents use is listed here, with who used it and whether it worked.
      </Empty>
    )

  return (
    <div className="flex flex-col gap-3 p-3">
      {audit.stops.length > 0 && (
        <section className="rounded-xl border border-warn/30 bg-warn-soft p-3">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold text-warn-ink">
            <Ban className="size-3.5" /> Stopped ({audit.stops.length})
          </h3>
          <ul className="flex flex-col gap-1">
            {audit.stops.map((s) => (
              <li key={`${s.time}-${s.tool}-${s.why}`} className="text-[12.5px] text-fg-2">
                <span className="text-muted">
                  {s.time.slice(11, 19)} · {s.agent || 'agent'} · {s.tool} ·{' '}
                </span>
                <span className="break-all">{s.why}</span>{' '}
                <span className="text-muted">({STOPPED_BY[s.by]})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <fieldset className="flex min-w-0 flex-wrap gap-1" aria-label="What to show">
        {KINDS.filter((k) => k.value === 'all' || count(k.value) > 0).map((k) => (
          <button
            key={k.value}
            type="button"
            aria-pressed={kind === k.value}
            onClick={() => setKind(k.value)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[12px] transition-colors',
              kind === k.value
                ? 'border-accent/40 bg-accent-soft text-accent-fg'
                : 'border-line text-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            {k.label} <span className="tabular-nums opacity-70">{count(k.value)}</span>
          </button>
        ))}
      </fieldset>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by path, URL or command"
            aria-label="Filter"
          />
        </div>
        {agents.length > 1 && (
          <Select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className="flex items-center justify-between px-1 text-[12px] text-muted">
        <span>
          {targets.length} of {audit.targets.length} · {audit.entries.length} calls
        </span>
        <FoldAll ids={targets.map(keyOf)} folds={folds} />
      </div>
      {targets.length === 0 ? (
        <p className="px-1 py-6 text-center text-[13px] text-muted">Nothing matches.</p>
      ) : (
        <ul className="flex flex-col">
          {targets.map((t) => {
            const key = keyOf(t)
            const open = folds.isOpen(key)
            const Icon = ICONS[t.kind]
            const calls = open
              ? audit.entries.filter(
                  (e) => e.kind === t.kind && e.target === t.target && (!agent || e.agent === agent),
                )
              : []
            return (
              <li key={key} className="border-b border-line last:border-0">
                <button
                  type="button"
                  onClick={() => folds.toggle(key)}
                  aria-expanded={open}
                  className="flex w-full items-start gap-2 rounded-lg px-1.5 py-2 text-left hover:bg-surface-2"
                >
                  <FoldChevron open={open} className="mt-1 text-muted" />
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span
                      title={t.target}
                      className={cn(
                        'block font-mono text-[12.5px] text-fg',
                        open ? 'whitespace-pre-wrap break-all' : 'truncate',
                      )}
                    >
                      {t.target}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1 text-[11.5px] text-muted">
                      {t.actions.map((a) => (
                        <Pill key={a}>{a}</Pill>
                      ))}
                      <span>{t.agents.join(', ')}</span>
                      {t.failed > 0 && <Pill tone="bad">{t.failed} failed</Pill>}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-[11.5px] tabular-nums text-muted">
                    {t.count > 1 && <span className="block">×{t.count}</span>}
                    <time>{t.last.slice(11, 19)}</time>
                  </span>
                </button>
                {open && (
                  <ol className="mb-2 ml-9 flex flex-col gap-0.5 text-[12px]">
                    {calls.map((e) => (
                      <li key={e.id} className="flex gap-2 text-fg-2">
                        <time className="tabular-nums text-muted">{e.time.slice(11, 19)}</time>
                        <span className="min-w-0 flex-1 truncate">
                          {e.agent} · {e.tool}
                        </span>
                        <span
                          className={
                            e.ok === undefined ? 'text-work-ink' : e.ok ? 'text-ok-ink' : 'text-bad-ink'
                          }
                        >
                          {e.ok === undefined ? 'running' : e.ok ? 'ok' : 'failed'}
                        </span>
                      </li>
                    ))}
                    {t.kind === 'url' && /^https?:\/\//.test(t.target) && (
                      <li>
                        <a
                          href={t.target}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent-fg hover:underline"
                        >
                          Open link
                        </a>
                      </li>
                    )}
                  </ol>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
