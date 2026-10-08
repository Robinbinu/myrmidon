import { type AuditKind, auditOf, type MyrEvent } from '@myrmidon/protocol'
import { Ban, FileCode, Globe, Search, ShieldCheck, SquareTerminal, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { copy } from '../copy.ts'
import { clock } from '../ui/hooks.ts'
import { Badge, cn, Empty, Select, TextInput } from '../ui/primitives.tsx'
import { FoldAll, FoldChevron, useFolds } from './Folds.tsx'

const KINDS: { value: AuditKind | 'all'; label: string }[] = [
  { value: 'all', label: copy.audit.kinds.all },
  { value: 'file', label: copy.audit.kinds.file },
  { value: 'url', label: copy.audit.kinds.url },
  { value: 'command', label: copy.audit.kinds.command },
  { value: 'search', label: copy.audit.kinds.search },
  { value: 'other', label: copy.audit.kinds.other },
]

const ICONS: Record<AuditKind, typeof FileCode> = {
  file: FileCode,
  url: Globe,
  command: SquareTerminal,
  search: Search,
  other: Wrench,
}

const STOPPED_BY = {
  person: copy.audit.stoppedBy.person,
  timeout: copy.audit.stoppedBy.timeout,
  hook: copy.audit.stoppedBy.hook,
  safety: copy.audit.stoppedBy.safety,
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
      <Empty icon={<ShieldCheck className="size-5" />} title={copy.audit.empty.title}>
        {copy.audit.empty.body}
      </Empty>
    )

  return (
    <div className="flex flex-col gap-3 p-3">
      {audit.stops.length > 0 && (
        <section className="rounded-lg border border-warn/30 bg-warn-soft p-3">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-callout font-semibold text-warn-ink">
            <Ban className="size-3.5" /> {copy.audit.stopped(audit.stops.length)}
          </h3>
          <ul className="flex flex-col gap-1">
            {audit.stops.map((s) => (
              <li key={`${s.time}-${s.tool}-${s.why}`} className="text-callout text-fg-2">
                <span className="text-muted">
                  {clock(s.time, true)} · {s.agent || copy.audit.agentFallback} · {s.tool} ·{' '}
                </span>
                <span className="break-all">{s.why}</span>{' '}
                <span className="text-muted">({STOPPED_BY[s.by]})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <fieldset className="flex min-w-0 flex-wrap gap-1" aria-label={copy.audit.kindsLabel}>
        {KINDS.filter((k) => k.value === 'all' || count(k.value) > 0).map((k) => (
          <button
            key={k.value}
            type="button"
            aria-pressed={kind === k.value}
            onClick={() => setKind(k.value)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-small transition-colors',
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
            placeholder={copy.audit.filter.placeholder}
            aria-label={copy.audit.filter.label}
          />
        </div>
        {agents.length > 1 && (
          <Select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            aria-label={copy.audit.agentFilter.label}
          >
            <option value="">{copy.audit.agentFilter.all}</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className="flex items-center justify-between px-1 text-small text-muted">
        <span>{copy.audit.summary(targets.length, audit.targets.length, audit.entries.length)}</span>
        <FoldAll ids={targets.map(keyOf)} folds={folds} />
      </div>
      {targets.length === 0 ? (
        <p className="px-1 py-6 text-center text-body text-muted">{copy.audit.noMatches}</p>
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
                  className="flex w-full items-start gap-2 rounded-xl px-1.5 py-2 text-left hover:bg-surface-2"
                >
                  <FoldChevron open={open} className="mt-1 text-muted" />
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span
                      title={t.target}
                      className={cn(
                        'block font-mono text-callout text-fg',
                        open ? 'whitespace-pre-wrap break-all' : 'truncate',
                      )}
                    >
                      {t.target}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1 text-footnote text-muted">
                      {t.actions.map((a) => (
                        <Badge key={a}>{a}</Badge>
                      ))}
                      <span>{t.agents.join(', ')}</span>
                      {t.failed > 0 && <Badge tone="bad">{copy.audit.failed(t.failed)}</Badge>}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-footnote tabular-nums text-muted">
                    {t.count > 1 && <span className="block">×{t.count}</span>}
                    <time>{clock(t.last, true)}</time>
                  </span>
                </button>
                {open && (
                  <ol className="mb-2 ml-9 flex flex-col gap-0.5 text-small">
                    {calls.map((e) => (
                      <li key={e.id} className="flex gap-2 text-fg-2">
                        <time className="tabular-nums text-muted">{clock(e.time, true)}</time>
                        <span className="min-w-0 flex-1 truncate">
                          {e.agent} · {e.tool}
                        </span>
                        <span
                          className={
                            e.ok === undefined ? 'text-work-ink' : e.ok ? 'text-ok-ink' : 'text-bad-ink'
                          }
                        >
                          {e.ok === undefined
                            ? copy.audit.call.running
                            : e.ok
                              ? copy.audit.call.ok
                              : copy.audit.call.failed}
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
                          {copy.audit.openLink}
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
