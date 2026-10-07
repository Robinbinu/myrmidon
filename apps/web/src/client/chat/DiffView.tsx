import { ChevronRight, Columns2, Rows2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { copy } from '../copy.ts'
import { cn } from '../ui/primitives.tsx'
import { type DiffLine, parseFilePatch, sideBySide, splitPatch } from './diff.ts'

export interface DiffFile {
  path: string
  /** git's status letter: A added, M modified, D deleted, R renamed, ? untracked. */
  status: string
  added?: number
  removed?: number
}

export type DiffMode = 'unified' | 'split'

export const STATUS: Record<string, { label: string; className: string; title: string }> = {
  A: {
    label: copy.diffView.status.added.label,
    className: 'text-ok-ink',
    title: copy.diffView.status.added.title,
  },
  M: {
    label: copy.diffView.status.modified.label,
    className: 'text-warn-ink',
    title: copy.diffView.status.modified.title,
  },
  D: {
    label: copy.diffView.status.deleted.label,
    className: 'text-bad-ink',
    title: copy.diffView.status.deleted.title,
  },
  R: {
    label: copy.diffView.status.renamed.label,
    className: 'text-accent-fg',
    title: copy.diffView.status.renamed.title,
  },
  '?': {
    label: copy.diffView.status.untracked.label,
    className: 'text-ok-ink',
    title: copy.diffView.status.untracked.title,
  },
}

const MODE_KEY = 'myr-diff-mode'

export function useDiffMode(): [DiffMode, (m: DiffMode) => void] {
  const [mode, setMode] = useState<DiffMode>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'unified'
    } catch {
      return 'unified'
    }
  })
  return [
    mode,
    (m) => {
      setMode(m)
      try {
        localStorage.setItem(MODE_KEY, m)
      } catch {
        // The preference is a convenience; private mode simply forgets it.
      }
    },
  ]
}

/** GitLab's five-block bar: the share of added (green) and removed (red) lines. */
export function StatBar({ added = 0, removed = 0 }: { added?: number; removed?: number }) {
  const total = added + removed
  const green = total ? Math.round((added / total) * 5) : 0
  const red = total ? Math.min(5 - green, Math.round((removed / total) * 5)) : 0
  return (
    <span className="flex gap-px" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: five fixed blocks
          key={i}
          className={cn(
            'size-[7px] rounded-[1px]',
            i < green ? 'bg-ok' : i < green + red ? 'bg-bad' : 'bg-surface-3',
          )}
        />
      ))}
    </span>
  )
}

export function DiffModeToggle({ mode, onMode }: { mode: DiffMode; onMode(m: DiffMode): void }) {
  return (
    <fieldset
      aria-label={copy.diffView.layout}
      className="m-0 inline-flex min-w-0 rounded-lg border border-line p-0.5"
    >
      {(
        [
          ['unified', Rows2, copy.diffView.unified],
          ['split', Columns2, copy.diffView.split],
        ] as const
      ).map(([value, Icon, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          title={label}
          onClick={() => onMode(value)}
          className={cn(
            'grid size-6 place-items-center rounded-md transition-colors',
            mode === value ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg',
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </fieldset>
  )
}

const ROW = {
  add: 'bg-ok-soft',
  del: 'bg-bad-soft',
  context: '',
} as const
const SIGN = { add: '+', del: '−', context: ' ' } as const

function Num({ n }: { n?: number }) {
  return (
    <td className="w-10 select-none border-r border-line px-1.5 text-right align-top tabular-nums text-muted/70">
      {n ?? ''}
    </td>
  )
}

function Code({ line, wrap }: { line?: DiffLine; wrap?: boolean }) {
  return (
    <td
      className={cn(
        'px-2 align-top',
        // Side by side, each half is fixed-width and long lines wrap, as GitLab does; unified scrolls instead.
        wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
        line ? ROW[line.kind] : 'bg-surface-2/60',
      )}
    >
      {line && (
        <>
          <span
            className={cn(
              'mr-1.5 select-none',
              line.kind === 'add' ? 'text-ok-ink' : line.kind === 'del' ? 'text-bad-ink' : 'text-muted',
            )}
          >
            {SIGN[line.kind]}
          </span>
          {line.text || ' '}
        </>
      )}
    </td>
  )
}

/** One file's hunks with old/new line numbers, unified or side by side. */
export function FilePatch({ text, mode }: { text: string; mode: DiffMode }) {
  const hunks = useMemo(() => parseFilePatch(text), [text])
  if (hunks.length === 0) return <p className="px-3 py-2 text-[12px] text-muted">{copy.diffView.binary}</p>
  return (
    <div className="overflow-x-auto">
      <table
        className={cn(
          'w-full border-collapse font-mono text-[11.5px] leading-[1.6]',
          mode === 'split' && 'table-fixed',
        )}
      >
        {mode === 'split' && (
          <colgroup>
            <col className="w-10" />
            <col />
            <col className="w-10" />
            <col />
          </colgroup>
        )}
        <tbody>
          {hunks.map((h) => (
            <HunkRows key={h.header} header={h.header} lines={h.lines} mode={mode} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HunkRows({ header, lines, mode }: { header: string; lines: DiffLine[]; mode: DiffMode }) {
  return (
    <>
      <tr>
        <td colSpan={mode === 'split' ? 4 : 3} className="bg-accent-soft/40 px-2 py-0.5 text-muted">
          {header}
        </td>
      </tr>
      {mode === 'split'
        ? sideBySide(lines).map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows of a fixed hunk
            <tr key={i}>
              <Num {...(r.left?.old !== undefined ? { n: r.left.old } : {})} />
              <Code wrap {...(r.left ? { line: r.left.kind === 'add' ? undefined : r.left } : {})} />
              <Num {...(r.right?.new !== undefined ? { n: r.right.new } : {})} />
              <Code wrap {...(r.right ? { line: r.right.kind === 'del' ? undefined : r.right } : {})} />
            </tr>
          ))
        : lines.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows of a fixed hunk
            <tr key={i}>
              <Num {...(l.old !== undefined ? { n: l.old } : {})} />
              <Num {...(l.new !== undefined ? { n: l.new } : {})} />
              <Code line={l} />
            </tr>
          ))}
    </>
  )
}

/** A file's name with its folder dimmed, like GitLab's file headers. */
export function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf('/')
  return (
    <span className="min-w-0 truncate font-mono text-[12.5px]">
      {cut >= 0 && <span className="text-muted">{path.slice(0, cut + 1)}</span>}
      <span className="font-medium">{path.slice(cut + 1)}</span>
    </span>
  )
}

/** A file card: header with status, path and stats; opens to its patch. */
export function FileDiff(props: {
  file: DiffFile
  text: string
  mode: DiffMode
  open: boolean
  onToggle(): void
  id?: string
}) {
  const s = STATUS[props.file.status] ?? { label: props.file.status, className: 'text-fg-2', title: '' }
  return (
    <div id={props.id} className="overflow-hidden rounded-xl border border-line bg-surface">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.open}
        className="flex w-full items-center gap-2 bg-surface-2/50 px-3 py-2 text-left hover:bg-surface-2"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-muted transition-transform', props.open && 'rotate-90')}
        />
        <span title={s.title} className={cn('w-3 shrink-0 font-mono text-[11px] font-bold', s.className)}>
          {s.label}
        </span>
        <FilePath path={props.file.path} />
        <span className="flex-1" />
        {props.file.added !== undefined && (
          <span className="flex shrink-0 items-center gap-2 font-mono text-[11.5px] tabular-nums">
            <span className="text-ok-ink">+{props.file.added}</span>
            <span className="text-bad-ink">−{props.file.removed}</span>
            <StatBar
              added={props.file.added}
              {...(props.file.removed !== undefined ? { removed: props.file.removed } : {})}
            />
          </span>
        )}
      </button>
      {props.open && (
        <div className="border-t border-line">
          <FilePatch text={props.text} mode={props.mode} />
        </div>
      )}
    </div>
  )
}

/** Changed files with totals, expand/collapse all, and a unified / side-by-side switch. */
export function DiffView(props: { files: DiffFile[]; patch: string; truncated?: boolean; open?: string }) {
  const sections = useMemo(() => splitPatch(props.patch), [props.patch])
  const [mode, setMode] = useDiffMode()
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(props.open ? [props.open] : []))
  if (props.files.length === 0)
    return <p className="px-1 py-2 text-[12.5px] text-muted">{copy.diffView.noChanges}</p>
  const added = props.files.reduce((n, f) => n + (f.added ?? 0), 0)
  const removed = props.files.reduce((n, f) => n + (f.removed ?? 0), 0)
  const allOpen = open.size === props.files.length
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1 text-[12px] text-muted">
        <span>
          {copy.diffView.fileCount(props.files.length)} ·{' '}
          <span className="font-mono text-ok-ink">+{added}</span>{' '}
          <span className="font-mono text-bad-ink">−{removed}</span>
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="rounded-md px-1.5 py-0.5 hover:bg-surface-2 hover:text-fg"
          onClick={() => setOpen(allOpen ? new Set() : new Set(props.files.map((f) => f.path)))}
        >
          {allOpen ? copy.diffView.collapseAll : copy.diffView.expandAll}
        </button>
        <DiffModeToggle mode={mode} onMode={setMode} />
      </div>
      {props.files.map((f) => (
        <FileDiff
          key={f.path}
          file={f}
          text={sections.get(f.path) ?? ''}
          mode={mode}
          open={open.has(f.path)}
          onToggle={() =>
            setOpen((s) => {
              const next = new Set(s)
              if (next.has(f.path)) next.delete(f.path)
              else next.add(f.path)
              return next
            })
          }
        />
      ))}
      {props.truncated && <p className="px-1 text-[12px] text-muted">{copy.diffView.truncated}</p>}
    </div>
  )
}
