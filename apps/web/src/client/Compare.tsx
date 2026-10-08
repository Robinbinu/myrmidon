import type { RunDiff, RunSide } from '@myrmidon/protocol'
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type ColonySummary } from './api.ts'
import { copy } from './copy.ts'
import { duration, knownCost, money } from './ui/hooks.ts'
import { cn, IconButton, Pill, toneFor } from './ui/primitives.tsx'
import { runPhase } from './ui/status.ts'

/** Side-by-side run metrics for research comparisons; tick two runs to see what differs between them. */
export function Compare(props: { colonies: ColonySummary[]; onOpen(id: string): void }) {
  const [picked, setPicked] = useState<string[]>([])
  const [diff, setDiff] = useState<RunDiff>()
  const [error, setError] = useState<string>()
  // The older run is A, so "B vs A" reads as what changed since.
  const created = (id: string) => props.colonies.find((c) => c.id === id)?.createdAt ?? ''
  const [a, b] = [...picked].sort((x, y) => created(x).localeCompare(created(y)))
  useEffect(() => {
    setDiff(undefined)
    setError(undefined)
    if (!a || !b) return
    let stop = false
    api<RunDiff>(`/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)
      .then((d) => !stop && setDiff(d))
      .catch((err: Error) => !stop && setError(err.message))
    return () => {
      stop = true
    }
  }, [a, b])
  // Picking a third run replaces the older pick, so the two newest choices are compared.
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)))

  if (props.colonies.length === 0) return <div className="empty">{copy.compare.noCrews}</div>
  return (
    <div className="compare">
      {picked.length < 2 ? (
        <p className="mb-3 text-[12.5px] text-muted">{copy.compare.tickTwo}</p>
      ) : diff ? (
        <RunDiffView diff={diff} onOpen={props.onOpen} onClose={() => setPicked([])} />
      ) : (
        <p className="mb-3 text-[12.5px] text-muted">{error ?? copy.compare.comparing}</p>
      )}
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>
                <span className="sr-only">{copy.compare.columns.compare}</span>
              </th>
              <th>{copy.compare.columns.crew}</th>
              <th>{copy.compare.columns.status}</th>
              <th>{copy.compare.columns.pattern}</th>
              <th>{copy.compare.columns.models}</th>
              <th className="num">{copy.compare.columns.wall}</th>
              <th className="num">{copy.compare.columns.tokens}</th>
              <th className="num">{copy.compare.columns.cost}</th>
              <th className="num">{copy.compare.columns.turns}</th>
              <th className="num">{copy.compare.columns.toolCalls}</th>
              <th className="num">{copy.compare.columns.messages}</th>
              <th className="num">{copy.compare.columns.artifactVersions}</th>
              <th className="num">{copy.compare.columns.rejections}</th>
              <th className="num">{copy.compare.columns.bestScore}</th>
            </tr>
          </thead>
          <tbody>
            {props.colonies.map((c) => (
              <tr key={c.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={copy.compare.pick(c.name)}
                    checked={picked.includes(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                </td>
                <td>
                  <button type="button" className="link" onClick={() => props.onOpen(c.id)}>
                    {c.name}
                  </button>
                  <div className="muted small mono max-w-48 truncate" title={c.id}>
                    {c.id}
                  </div>
                </td>
                <td>
                  <Pill tone={toneFor(runPhase(c))}>{copy.status.run[runPhase(c)]}</Pill>
                  {c.statusReason && <div className="muted small">{c.statusReason}</div>}
                </td>
                <td>{copy.compare.patterns[c.pattern] ?? c.pattern}</td>
                <td className="small">{[...new Set(c.agents.map((a) => a.model))].join(', ')}</td>
                <td className="num">{duration(c.metrics.wallMs)}</td>
                <td className="num">{c.metrics.tokens.toLocaleString()}</td>
                <td className="num">{money(c.metrics.cost, c.metrics.tokens)}</td>
                <td className="num">{c.metrics.turns}</td>
                <td className="num">{c.metrics.toolCalls}</td>
                <td className="num">{c.metrics.messages}</td>
                <td className="num">{c.metrics.artifactVersions}</td>
                <td className="num">{c.metrics.rejections}</td>
                <td className="num">
                  {c.metrics.bestScore === undefined ? '—' : c.metrics.bestScore.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

type Metric = {
  label: string
  a?: number
  b?: number
  format(n: number): string
  better: 'lower' | 'higher'
  /** Shown for a side without this measure. */
  none?: string
}

function metricRows(a: RunSide, b: RunSide): Metric[] {
  const n = (x: number) => x.toLocaleString()
  const costA = knownCost(a.metrics.cost, a.metrics.tokens)
  const costB = knownCost(b.metrics.cost, b.metrics.tokens)
  return [
    {
      label: copy.compare.metrics.wallTime,
      a: a.metrics.wallMs,
      b: b.metrics.wallMs,
      format: duration,
      better: 'lower',
    },
    {
      label: copy.compare.metrics.tokens,
      a: a.metrics.tokens,
      b: b.metrics.tokens,
      format: n,
      better: 'lower',
    },
    ...(costA !== undefined || costB !== undefined
      ? [
          {
            label: copy.compare.metrics.cost,
            a: costA,
            b: costB,
            format: (x: number) => `$${x.toFixed(3)}`,
            better: 'lower' as const,
            none: copy.unknownCost,
          },
        ]
      : []),
    { label: copy.compare.metrics.turns, a: a.metrics.turns, b: b.metrics.turns, format: n, better: 'lower' },
    {
      label: copy.compare.metrics.toolCalls,
      a: a.metrics.toolCalls,
      b: b.metrics.toolCalls,
      format: n,
      better: 'lower',
    },
    {
      label: copy.compare.metrics.rejections,
      a: a.metrics.rejections,
      b: b.metrics.rejections,
      format: n,
      better: 'lower',
    },
    {
      label: copy.compare.metrics.judgeScore,
      a: a.judge?.score ?? a.metrics.bestScore,
      b: b.judge?.score ?? b.metrics.bestScore,
      format: (x: number) => x.toFixed(2),
      better: 'higher',
    },
  ]
}

/** B against A: green when B is better on that measure, red when worse. */
function Delta({ m }: { m: Metric }) {
  if (m.a === undefined || m.b === undefined || m.a === m.b) return <span className="text-muted">—</span>
  const up = m.b > m.a
  const good = m.better === 'higher' ? up : !up
  const pct = m.a !== 0 ? ` (${up ? '+' : ''}${Math.round(((m.b - m.a) / Math.abs(m.a)) * 100)}%)` : ''
  return (
    <span className={good ? 'text-ok-ink' : 'text-bad-ink'}>
      {up ? '+' : '−'}
      {m.format(Math.abs(m.b - m.a))}
      {pct}
    </span>
  )
}

function SideHead({ label, run, onOpen }: { label: string; run: RunSide; onOpen(id: string): void }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="grid size-5 place-items-center rounded-md bg-surface-2 font-mono text-[11px] font-bold">
          {label}
        </span>
        <button
          type="button"
          onClick={() => onOpen(run.id)}
          className="min-w-0 truncate text-left text-[13.5px] font-semibold hover:underline"
        >
          {run.name}
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        <Pill tone={toneFor(runPhase(run))}>{copy.status.run[runPhase(run)]}</Pill>
        {run.tier && <span>{run.tier}</span>}
        {run.mode && <span>· {run.mode}</span>}
        {run.judge && (
          <span>
            {copy.compare.judge(run.judge.pass)}
            {run.judge.score !== undefined ? ` ${run.judge.score.toFixed(2)}` : ''}
          </span>
        )}
      </div>
      <div className="mt-1 truncate font-mono text-[11.5px] text-muted">{run.models.join(', ')}</div>
    </div>
  )
}

function RunDiffView(props: { diff: RunDiff; onOpen(id: string): void; onClose(): void }) {
  const { a, b, tools, files, agents } = props.diff
  const most = Math.max(1, ...tools.flatMap((t) => [t.a, t.b]))
  const [allTools, setAllTools] = useState(false)
  const shownTools = allTools ? tools : tools.slice(0, 10)
  const head = 'px-2 py-1.5 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-muted'
  const cell = 'px-2 py-1.5 tabular-nums'
  return (
    <section
      aria-label={copy.compare.runDiff}
      className="mb-5 flex flex-col gap-4 rounded-2xl border border-line bg-surface-2/40 p-4"
    >
      <div className="flex items-start gap-3">
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
          <SideHead label="A" run={a} onOpen={props.onOpen} />
          <SideHead label="B" run={b} onOpen={props.onOpen} />
        </div>
        <IconButton label={copy.compare.close} onClick={props.onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      {a.task.trim() !== b.task.trim() && (
        <p role="note" className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn-ink">
          {copy.compare.differentTasks}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr>
              <th className={head}>{copy.compare.measure}</th>
              <th className={cn(head, 'text-right')}>A</th>
              <th className={cn(head, 'text-right')}>B</th>
              <th className={cn(head, 'text-right')}>{copy.compare.versus}</th>
            </tr>
          </thead>
          <tbody>
            {metricRows(a, b).map((m) => (
              <tr key={m.label} className="border-t border-line">
                <td className="px-2 py-1.5">{m.label}</td>
                <td className={cn(cell, 'text-right')}>
                  {m.a === undefined ? (m.none ?? '—') : m.format(m.a)}
                </td>
                <td className={cn(cell, 'text-right')}>
                  {m.b === undefined ? (m.none ?? '—') : m.format(m.b)}
                </td>
                <td className={cn(cell, 'text-right')}>
                  <Delta m={m} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {tools.length > 0 && (
        <div>
          <h3 className={cn(head, 'px-0')}>{copy.compare.toolCalls}</h3>
          <ul className="mt-1 flex flex-col gap-1">
            {shownTools.map((t) => (
              <li
                key={t.tool}
                className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-3 text-[12px]"
              >
                <span className="truncate font-mono">{t.tool}</span>
                <span className="flex flex-col gap-0.5">
                  {(['a', 'b'] as const).map((k) => (
                    <span key={k} className="flex items-center gap-2">
                      <span className="w-3 font-mono text-[11px] text-muted">{k.toUpperCase()}</span>
                      <span
                        className={cn('h-1.5 rounded-full', k === 'a' ? 'bg-fg-2/50' : 'bg-accent')}
                        style={{ width: `${(t[k] / most) * 100}%`, minWidth: t[k] ? 4 : 0 }}
                      />
                      <span className="tabular-nums text-muted">{t[k]}</span>
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          {tools.length > 10 && (
            <button
              type="button"
              onClick={() => setAllTools(!allTools)}
              className="mt-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted hover:bg-surface-2 hover:text-fg"
            >
              {allTools ? copy.compare.showFewer : copy.compare.showAllTools(tools.length)}
            </button>
          )}
        </div>
      )}

      {files.length > 0 && (
        <div>
          <h3 className={cn(head, 'px-0')}>{copy.compare.files}</h3>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {files.map((f) => (
              <li
                key={f.name}
                className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-[12px]"
              >
                <span className="font-mono">{f.name}</span>
                <Pill tone={f.in === 'both' ? (f.same ? 'neutral' : 'warn') : 'accent'}>
                  {f.in === 'both'
                    ? f.same
                      ? copy.compare.same
                      : copy.compare.differs
                    : copy.compare.onlyIn(f.in.toUpperCase())}
                </Pill>
              </li>
            ))}
          </ul>
        </div>
      )}

      {agents.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr>
                <th className={head}>{copy.compare.agent}</th>
                <th className={head}>A</th>
                <th className={head}>B</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((ag) => (
                <tr key={ag.name} className="border-t border-line">
                  <td className="px-2 py-1.5 font-medium">{ag.name}</td>
                  {[ag.a, ag.b].map((x, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the two fixed sides
                    <td key={i} className="px-2 py-1.5 text-muted">
                      {x ? (
                        <>
                          <span className="font-mono text-[11.5px]">{x.model}</span>
                          {copy.compare.agentStats(x.turns, x.tokens.toLocaleString(), x.toolCalls)}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(a.finalReply || b.finalReply) && (
        <details>
          <summary className={cn(head, 'px-0')}>{copy.compare.finalAnswers}</summary>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[a, b].map((r, i) => (
              <p
                key={r.id}
                className="whitespace-pre-wrap rounded-xl border border-line bg-surface p-3 text-[12.5px] text-fg-2"
              >
                <span className="mr-1 font-mono text-[11px] font-bold">{i === 0 ? 'A' : 'B'}</span>
                {r.finalReply ?? copy.compare.noAnswer}
              </p>
            ))}
          </div>
        </details>
      )}
    </section>
  )
}
