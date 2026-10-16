import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { copy } from '../../copy.ts'
import { cn } from '../../ui/primitives.tsx'
import { TABLE_FILTER_FROM, TABLE_ROWS_SHOWN } from '../../ui-config.ts'
import type { Cell } from './spec.ts'

const say = copy.visuals.table

/** A cell's number, when it reads as one (`1,204`, `12.5%`, `$3.40`, `-7`); text otherwise. */
export function cellNumber(cell: Cell): number | undefined {
  if (typeof cell === 'number') return cell
  if (typeof cell !== 'string') return undefined
  const t = cell
    .trim()
    .replace(/^[$€£¥]|[%×x]$/g, '')
    .replace(/,/g, '')
  return t !== '' && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : undefined
}

const text = (cell: Cell) => (cell === null ? '' : String(cell))

/** Rows ordered by column `by`: numbers by value, the rest as text in the person's language; empty cells last. */
export function sortRows(rows: readonly (readonly Cell[])[], by: number, dir: 'asc' | 'desc') {
  const sign = dir === 'asc' ? 1 : -1
  return rows
    .map((row, at) => ({ row, at }))
    .sort((a, b) => {
      const x = a.row[by] ?? null
      const y = b.row[by] ?? null
      if (x === null || x === '') return y === null || y === '' ? a.at - b.at : 1
      if (y === null || y === '') return -1
      const nx = cellNumber(x)
      const ny = cellNumber(y)
      const c =
        nx !== undefined && ny !== undefined
          ? nx - ny
          : text(x).localeCompare(text(y), undefined, { numeric: true, sensitivity: 'base' })
      return c === 0 ? a.at - b.at : c * sign
    })
    .map((r) => r.row)
}

/**
 * A table the person can sort (a column's header) and, from TABLE_FILTER_FROM rows, filter. Rows stay in the order
 * they came until a header is chosen; a third press puts them back. `render` draws a cell (a Markdown table's
 * inline markup); sorting and the filter read its text.
 */
export function DataTable(props: {
  columns: readonly string[]
  rows: readonly (readonly Cell[])[]
  caption?: string
  render?: (cell: Cell, column: number) => ReactNode
  renderHead?: (column: string) => ReactNode
}) {
  const [sort, setSort] = useState<{ by: number; dir: 'asc' | 'desc' }>()
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const filtering = props.rows.length >= TABLE_FILTER_FROM
  const numeric = useMemo(
    () =>
      props.columns.map((_, i) => {
        const filled = props.rows.map((r) => r[i] ?? null).filter((c) => c !== null && c !== '')
        return filled.length > 0 && filled.every((c) => cellNumber(c) !== undefined)
      }),
    [props.columns, props.rows],
  )
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const kept = q ? props.rows.filter((r) => r.some((c) => text(c).toLowerCase().includes(q))) : props.rows
    return sort ? sortRows(kept, sort.by, sort.dir) : kept
  }, [props.rows, query, sort])
  const visible = all ? shown : shown.slice(0, TABLE_ROWS_SHOWN)
  const press = (by: number) =>
    setSort((s) => (s?.by !== by ? { by, dir: 'asc' } : s.dir === 'asc' ? { by, dir: 'desc' } : undefined))
  return (
    <div className="min-w-0">
      {(filtering || props.caption) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
          {props.caption && <span className="text-callout font-medium text-fg-2">{props.caption}</span>}
          {filtering && (
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={say.filter}
              aria-label={say.filter}
              className="ml-auto w-full min-w-0 max-w-56 rounded-md border border-line bg-control px-2 py-1 text-callout text-fg placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-reading">
          <thead className="bg-fill">
            <tr>
              {props.columns.map((h, n) => {
                const on = sort?.by === n ? sort.dir : undefined
                const Icon = on === 'asc' ? ArrowUp : on === 'desc' ? ArrowDown : ArrowUpDown
                return (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: table cells are positional
                    key={n}
                    aria-sort={on === 'asc' ? 'ascending' : on === 'desc' ? 'descending' : undefined}
                    className={cn(
                      'border-b border-line p-0 font-semibold',
                      numeric[n] ? 'text-right' : 'text-left',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => press(n)}
                      title={say.sortBy(h)}
                      className={cn(
                        'group inline-flex w-full items-center gap-1 px-3 py-2 hover:text-fg',
                        numeric[n] && 'flex-row-reverse',
                      )}
                    >
                      <span>{props.renderHead ? props.renderHead(h) : h}</span>
                      <Icon
                        className={cn(
                          'size-3 shrink-0 text-muted',
                          !on && 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
                        )}
                      />
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: table rows are positional
              <tr key={n} className="border-b border-line last:border-0">
                {props.columns.map((_, m) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: table cells are positional
                    key={m}
                    className={cn('px-3 py-2 align-top', numeric[m] && 'text-right tabular-nums')}
                  >
                    {props.render ? props.render(r[m] ?? null, m) : text(r[m] ?? null)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length === 0 && <p className="px-3 py-2 text-callout text-muted">{say.noMatches}</p>}
      {(shown.length > visible.length || (filtering && query)) && (
        <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-1.5 text-footnote text-muted">
          <span>{say.shown(visible.length, props.rows.length)}</span>
          {shown.length > visible.length && (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="font-medium text-accent-fg hover:underline"
            >
              {say.showAll}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** A table as CSV, for its download. */
export function toCsv(columns: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const field = (v: Cell | string) => {
    const s = v === null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [columns, ...rows].map((r) => r.map(field).join(',')).join('\n')
}
