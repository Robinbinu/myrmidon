import { ChevronRight, ChevronsDownUp, File, Folder, FolderOpen, RotateCw, X } from 'lucide-react'
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.ts'
import { copy } from '../copy.ts'
import { cn, IconButton, Skeleton, TextInput } from '../ui/primitives.tsx'
import { STATUS } from './DiffView.tsx'
import { useOpenProjectFile } from './ProjectFiles.tsx'

interface Entry {
  name: string
  path: string
  dir: boolean
  status?: string
  changed?: true
  ignored?: true
}

interface Listing {
  entries: Entry[]
  truncated: boolean
}

/** A row of the tree as shown: an entry at its depth, or a folder's "loading" line. */
type Row = { entry: Entry; depth: number; ignored: boolean } | { loading: string; depth: number }

/** How long typing pauses before the name search runs. */
const FIND_DELAY_MS = 200

/**
 * The project folder as a tree, like an editor's explorer: folders open one level at a time, files open in the viewer,
 * git's status on each file (and folders with changes inside tinted, as an editor does), ignored entries dimmed, and
 * files the crew changed in this chat ringed. Typing in the box finds files by name across the whole folder.
 */
export function ProjectExplorer(props: {
  project: { id: string; name: string }
  /** Files the crew changed in this chat; a new one refreshes the open folders. */
  edited: readonly string[]
}) {
  const openFile = useOpenProjectFile()
  const [dirs, setDirs] = useState<ReadonlyMap<string, Listing | { error: string }>>(new Map())
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ q: string; paths: string[]; truncated: boolean }>()
  const [focus, setFocus] = useState(0)
  const tree = useRef<HTMLDivElement>(null)
  const base = `/api/projects/${props.project.id}`

  const load = useCallback(
    (path: string) =>
      api<Listing>(`${base}/tree?path=${encodeURIComponent(path)}`)
        .then((l) => setDirs((d) => new Map(d).set(path, l)))
        .catch((err) => setDirs((d) => new Map(d).set(path, { error: String((err as Error).message) }))),
    [base],
  )

  // The open folders read again: after a rewind or commit elsewhere in the app, and when the crew changes a file.
  const shown = useRef<string[]>([''])
  shown.current = ['', ...open]
  const refresh = useCallback(() => {
    for (const path of shown.current) void load(path)
  }, [load])
  const editedKey = props.edited.join('\n')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `editedKey` is the trigger, not an input
  useEffect(() => refresh(), [refresh, editedKey])
  useEffect(() => {
    const changed = (e: Event) => {
      if ((e as CustomEvent<{ project?: string }>).detail?.project === props.project.id) refresh()
    }
    window.addEventListener('myr:folder-changed', changed)
    return () => window.removeEventListener('myr:folder-changed', changed)
  }, [refresh, props.project.id])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setFound(undefined)
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      api<{ paths: string[]; truncated: boolean }>(`${base}/find?q=${encodeURIComponent(q)}`)
        .then((r) => !cancelled && setFound({ q, ...r }))
        .catch(() => !cancelled && setFound({ q, paths: [], truncated: false }))
    }, FIND_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, base])

  const edited = useMemo(() => new Set(props.edited), [props.edited])
  const rows = useMemo(() => {
    const out: Row[] = []
    const walk = (path: string, depth: number, ignored: boolean) => {
      const listing = dirs.get(path)
      if (!listing) {
        out.push({ loading: path, depth })
        return
      }
      if ('error' in listing) return
      for (const entry of listing.entries) {
        const dim = ignored || !!entry.ignored
        out.push({ entry, depth, ignored: dim })
        if (entry.dir && open.has(entry.path)) walk(entry.path, depth + 1, dim)
      }
    }
    walk('', 0, false)
    return out
  }, [dirs, open])
  // Found files are rows too, so the keyboard moves through them the same way.
  const items: Row[] = found
    ? found.paths.map((path) => ({
        entry: { name: path.split('/').pop() ?? path, path, dir: false },
        depth: 0,
        ignored: false,
      }))
    : rows
  const at = Math.min(focus, Math.max(0, items.length - 1))

  const toggle = (path: string) => {
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        if (!dirs.has(path)) void load(path)
      }
      return next
    })
  }
  const activate = (row: Row | undefined) => {
    if (!row || 'loading' in row) return
    if (row.entry.dir) toggle(row.entry.path)
    else openFile?.(row.entry.path)
  }
  const moveTo = (i: number) => {
    const next = Math.max(0, Math.min(items.length - 1, i))
    setFocus(next)
    tree.current?.querySelector<HTMLElement>(`[data-row="${next}"]`)?.focus()
  }
  // The tree's keys, as in an editor: arrows move, → opens a folder or steps in, ← closes it or steps out.
  const onKey = (e: KeyboardEvent) => {
    const row = items[at]
    const entry = row && !('loading' in row) ? row.entry : undefined
    if (e.key === 'ArrowDown') moveTo(at + 1)
    else if (e.key === 'ArrowUp') moveTo(at - 1)
    else if (e.key === 'Home') moveTo(0)
    else if (e.key === 'End') moveTo(items.length - 1)
    else if (e.key === 'ArrowRight' && entry?.dir) {
      if (!open.has(entry.path)) toggle(entry.path)
      else moveTo(at + 1)
    } else if (e.key === 'ArrowLeft' && entry) {
      if (entry.dir && open.has(entry.path)) toggle(entry.path)
      else {
        const parent = entry.path.split('/').slice(0, -1).join('/')
        const i = items.findIndex((r) => !('loading' in r) && r.entry.path === parent)
        if (i >= 0) moveTo(i)
      }
    } else if (e.key === 'Enter' || e.key === ' ') activate(row)
    else return
    e.preventDefault()
  }

  const top = dirs.get('')
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1.5">
        <div className="relative min-w-0 flex-1">
          <TextInput
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setFocus(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation()
                setQuery('')
              } else if (e.key === 'ArrowDown' && items.length) {
                e.preventDefault()
                moveTo(0)
              }
            }}
            placeholder={copy.explorer.filterPlaceholder}
            aria-label={copy.explorer.filter}
            className="h-8 w-full pr-7"
          />
          {query && (
            <IconButton
              size="sm"
              label={copy.explorer.filter}
              onClick={() => setQuery('')}
              className="absolute top-1 right-1"
            >
              <X className="size-3.5" />
            </IconButton>
          )}
        </div>
        <IconButton size="sm" label={copy.explorer.refresh} onClick={refresh}>
          <RotateCw className="size-3.5" />
        </IconButton>
        <IconButton
          size="sm"
          label={copy.explorer.collapseAll}
          onClick={() => setOpen(new Set())}
          disabled={!open.size}
        >
          <ChevronsDownUp className="size-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
        {!top ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3.5 w-1/2" />
          </div>
        ) : 'error' in top ? (
          <p className="px-2 py-2 text-callout text-bad-ink" role="alert">
            {top.error}
          </p>
        ) : found && found.paths.length === 0 ? (
          <p className="px-2 py-2 text-callout text-muted">{copy.explorer.noMatches(found.q)}</p>
        ) : !found && top.entries.length === 0 ? (
          <p className="px-2 py-2 text-callout text-muted">{copy.explorer.empty}</p>
        ) : (
          <div
            ref={tree}
            role="tree"
            aria-label={copy.explorer.label(props.project.name)}
            onKeyDown={onKey}
            className="font-mono text-callout"
          >
            {items.map((row, i) =>
              'loading' in row ? (
                <div
                  key={`loading:${row.loading}`}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-disabled
                  aria-busy
                  tabIndex={-1}
                  className="py-1 font-sans text-footnote text-muted"
                  style={{ paddingLeft: `${row.depth * 12 + 28}px` }}
                >
                  {copy.explorer.loading}
                </div>
              ) : (
                <TreeRow
                  key={row.entry.path}
                  row={row}
                  index={i}
                  focused={i === at}
                  open={open.has(row.entry.path)}
                  edited={edited.has(row.entry.path)}
                  full={!!found}
                  onFocus={() => setFocus(i)}
                  onActivate={() => activate(row)}
                />
              ),
            )}
          </div>
        )}
        {found?.truncated && (
          <p className="px-2 py-2 text-footnote text-muted">{copy.explorer.moreMatches}</p>
        )}
        {!found && top && !('error' in top) && top.truncated && (
          <p className="px-2 py-2 text-footnote text-muted">{copy.explorer.truncated}</p>
        )}
      </div>
    </div>
  )
}

function TreeRow(props: {
  row: { entry: Entry; depth: number; ignored: boolean }
  index: number
  focused: boolean
  open: boolean
  edited: boolean
  /** A name-search result: shows the folder it is in. */
  full: boolean
  onFocus(): void
  onActivate(): void
}) {
  const { entry, depth, ignored } = props.row
  const status = entry.status
    ? (STATUS[entry.status] ?? {
        label: entry.status,
        className: 'text-bad-ink',
        title: copy.explorer.conflict,
      })
    : undefined
  const Icon = entry.dir ? (props.open ? FolderOpen : Folder) : File
  const folder = props.full ? entry.path.split('/').slice(0, -1).join('/') : ''
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the tree handles the keys for all its rows (Enter, Space, arrows)
    <div
      role="treeitem"
      data-row={props.index}
      tabIndex={props.focused ? 0 : -1}
      aria-level={depth + 1}
      aria-selected={props.focused}
      {...(entry.dir ? { 'aria-expanded': props.open } : {})}
      onClick={props.onActivate}
      onFocus={props.onFocus}
      title={ignored ? `${entry.path} · ${copy.explorer.ignored}` : entry.path}
      className={cn(
        'flex cursor-default items-center gap-1.5 rounded-md py-1 pr-2 outline-none hover:bg-fill focus-visible:ring-2 focus-visible:ring-accent',
        props.focused && 'bg-fill/60',
        ignored ? 'text-muted' : 'text-fg-2',
      )}
      style={{ paddingLeft: `${depth * 12 + 6}px` }}
    >
      <ChevronRight
        aria-hidden
        className={cn(
          'size-3.5 shrink-0 text-muted transition-transform',
          !entry.dir && 'invisible',
          props.open && 'rotate-90',
        )}
      />
      <Icon aria-hidden className={cn('size-3.5 shrink-0', entry.dir ? 'text-accent-fg' : 'text-muted')} />
      <span
        className={cn('min-w-0 truncate', status?.className, entry.changed && 'text-warn-ink')}
        {...(entry.changed ? { title: copy.explorer.changedInside } : {})}
      >
        {entry.name}
      </span>
      {folder && <span className="min-w-0 truncate font-sans text-footnote text-muted">{folder}</span>}
      <span className="flex-1" />
      {props.edited && (
        <span
          role="img"
          aria-label={copy.explorer.editedHere}
          title={copy.explorer.editedHere}
          className="size-2 shrink-0 rounded-full border-2 border-accent"
        />
      )}
      {status && (
        <span
          title={status.title}
          className={cn('w-3 shrink-0 text-center text-caption font-bold', status.className)}
        >
          {status.label}
        </span>
      )}
    </div>
  )
}
