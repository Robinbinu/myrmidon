import { ChevronRight, Columns2, Folder, Rows2 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { copy } from '../copy.ts'
import { cn } from '../ui/primitives.tsx'
import { FOLDER_FOLD_AT } from '../ui-config.ts'
import { type DiffLine, parseFilePatch, sideBySide, splitPatch } from './diff.ts'
import { FoldChevron, type Folds, useFolds } from './Folds.tsx'

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
  if (hunks.length === 0) return <p className="px-3 py-2 text-small text-muted">{copy.diffView.binary}</p>
  return (
    <div className="overflow-x-auto">
      <table
        className={cn(
          'w-full border-collapse font-mono text-footnote leading-[1.6]',
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

/**
 * A file's name with its folder dimmed, like GitLab's file headers. A long path gives up its folder first, so the
 * name stays readable; `full` is the whole path, for the tooltip, when `path` is shown relative to a folder.
 */
export function FilePath({ path, full }: { path: string; full?: string }) {
  const cut = path.lastIndexOf('/')
  return (
    <span className="flex min-w-0 font-mono text-callout" title={full ?? path}>
      {cut >= 0 && <span className="truncate text-muted">{path.slice(0, cut + 1)}</span>}
      <span className="max-w-full shrink-0 truncate font-medium">{path.slice(cut + 1)}</span>
    </span>
  )
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

/** Changed files by their top folder: files at the project's top level first, then folders A to Z, each sorted. */
export function groupByFolder<T extends { path: string }>(
  items: readonly T[],
): { folder: string; items: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const cut = item.path.indexOf('/')
    const folder = cut < 0 ? '' : item.path.slice(0, cut)
    const list = groups.get(folder)
    if (list) list.push(item)
    else groups.set(folder, [item])
  }
  return [...groups]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : byName(a, b)))
    .map(([folder, list]) => ({ folder, items: list.sort((a, b) => byName(a.path, b.path)) }))
}

/**
 * Whether a folder's group starts open: a folder of many files starts folded, so a pile of caches or build output
 * cannot bury the few files that matter, unless it holds the file the list was opened on (`open`).
 */
export function folderStartsOpen(items: readonly { path: string }[], folder: string, open?: string): boolean {
  if (open?.startsWith(`${folder}/`)) return true
  return items.filter((i) => i.path.startsWith(`${folder}/`)).length <= FOLDER_FOLD_AT
}

/** The folders a list groups its files under, for folding them all at once. */
export const folderIds = (items: readonly { path: string }[]) =>
  groupByFolder(items).flatMap((g) => (g.folder ? [g.folder] : []))

/** Open/closed state for a list's folder groups, for a list that folds them itself (Expand all). */
export function useFolderFolds(items: readonly { path: string }[], open?: string): Folds {
  return useFolds((folder) => folderStartsOpen(items, folder, open))
}

/**
 * Changed files under their top folder, each folder folding (see folderStartsOpen). `name` is the path within its
 * folder. Pass `folds` (useFolderFolds) when the list also folds its folders from outside.
 */
export function FolderGroups<T extends { path: string }>(props: {
  items: readonly T[]
  /** Spacing between a folder's own rows. */
  className?: string
  folds?: Folds
  children(item: T, name: string): ReactNode
}) {
  const groups = groupByFolder(props.items)
  const own = useFolderFolds(props.items)
  const folds = props.folds ?? own
  return (
    <>
      {groups.map((g) =>
        g.folder === '' ? (
          g.items.map((item) => props.children(item, item.path))
        ) : (
          <div key={`folder:${g.folder}`} className="flex flex-col">
            <button
              type="button"
              onClick={() => folds.toggle(g.folder)}
              aria-expanded={folds.isOpen(g.folder)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-callout text-fg-2 hover:bg-surface-2"
            >
              <FoldChevron open={folds.isOpen(g.folder)} className="text-muted" />
              <Folder className="size-3.5 shrink-0 text-muted" />
              <span className="min-w-0 truncate font-mono">{g.folder}/</span>
              <span className="rounded-full bg-surface-2 px-1.5 text-caption tabular-nums text-muted">
                {g.items.length}
              </span>
            </button>
            {folds.isOpen(g.folder) && (
              <div className={cn('flex flex-col pl-3', props.className)}>
                {g.items.map((item) => props.children(item, item.path.slice(g.folder.length + 1)))}
              </div>
            )}
          </div>
        ),
      )}
    </>
  )
}

/** git's line for a file it will not diff line by line (no line counts alone is not enough: see gitWorkingChanges). */
const BINARY = /^Binary files .* differ$/m

/** A file card: header with status, path and stats; opens to its patch. */
export function FileDiff(props: {
  file: DiffFile
  text: string
  mode: DiffMode
  open: boolean
  onToggle(): void
  id?: string
  /** The path as shown, when the list groups files under their folder. */
  name?: string
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
        <span title={s.title} className={cn('w-3 shrink-0 font-mono text-caption font-bold', s.className)}>
          {s.label}
        </span>
        <FilePath path={props.name ?? props.file.path} full={props.file.path} />
        <span className="flex-1" />
        {BINARY.test(props.text) && (
          <span className="shrink-0 rounded bg-surface-3 px-1.5 font-mono text-caption text-muted">
            {copy.diffView.binaryTag}
          </span>
        )}
        {props.file.added !== undefined && (
          <span className="flex shrink-0 items-center gap-2 font-mono text-footnote tabular-nums">
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
  const folds = useFolderFolds(props.files, props.open)
  if (props.files.length === 0)
    return <p className="px-1 py-2 text-callout text-muted">{copy.diffView.noChanges}</p>
  const added = props.files.reduce((n, f) => n + (f.added ?? 0), 0)
  const removed = props.files.reduce((n, f) => n + (f.removed ?? 0), 0)
  // A file in a folded folder is out of sight however it is set, so "all open" takes its folder too.
  const folders = folderIds(props.files)
  const allOpen = open.size === props.files.length && folders.every((f) => folds.isOpen(f))
  const setAllOpen = (to: boolean) => {
    setOpen(to ? new Set(props.files.map((f) => f.path)) : new Set())
    folds.setAll(folders, to)
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1 text-small text-muted">
        <span>
          {copy.diffView.fileCount(props.files.length)} ·{' '}
          <span className="font-mono text-ok-ink">+{added}</span>{' '}
          <span className="font-mono text-bad-ink">−{removed}</span>
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="rounded-md px-1.5 py-0.5 hover:bg-surface-2 hover:text-fg"
          onClick={() => setAllOpen(!allOpen)}
        >
          {allOpen ? copy.diffView.collapseAll : copy.diffView.expandAll}
        </button>
        <DiffModeToggle mode={mode} onMode={setMode} />
      </div>
      <FolderGroups items={props.files} folds={folds} className="gap-2 pt-1">
        {(f, name) => (
          <FileDiff
            key={f.path}
            file={f}
            name={name}
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
        )}
      </FolderGroups>
      {props.truncated && <p className="px-1 text-small text-muted">{copy.diffView.truncated}</p>}
    </div>
  )
}
