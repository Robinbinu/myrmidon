import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  Folder,
  GitBranch,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
} from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { api, send } from '../api.ts'
import { Modal } from '../ui/Modal.tsx'
import { Button, cn, Empty, IconButton } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'
import {
  type DiffFile,
  DiffModeToggle,
  FileDiff,
  FilePatch,
  FilePath,
  STATUS,
  StatBar,
  useDiffMode,
} from './DiffView.tsx'
import { fileTree, splitPatch, type TreeNode } from './diff.ts'

interface Commit {
  hash: string
  short: string
  subject: string
  author: string
  date: string
}

type Status =
  | { repo: false }
  | {
      repo: true
      branch?: string
      upstream?: string
      ahead: number
      behind: number
      files: { path: string; index: string; worktree: string }[]
      log: Commit[]
    }

interface Changes {
  files: DiffFile[]
  patch: string
  truncated: boolean
}

type Kind = 'staged' | 'unstaged' | 'untracked'
type Target = { kind: 'working' } | { kind: 'commit'; commit: Commit }

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()

/** A stable colour per author, for the avatar dots in the history. */
const hue = (name: string) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)

const SECTIONS_KEY = 'myr-git-closed'

function useClosedSections(): [ReadonlySet<string>, (key: string) => void] {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  return [
    closed,
    (key) =>
      setClosed((s) => {
        const next = new Set(s)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        try {
          localStorage.setItem(SECTIONS_KEY, JSON.stringify([...next]))
        } catch {
          // Which sections are folded is a convenience; private mode simply forgets it.
        }
        return next
      }),
  ]
}

function Section(props: {
  id: string
  title: string
  count: number
  closed: boolean
  onToggle(): void
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      <div className="group flex items-center gap-1 px-1">
        <button
          type="button"
          onClick={props.onToggle}
          aria-expanded={!props.closed}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left font-mono text-[11px] uppercase tracking-[0.14em] text-muted hover:text-fg"
        >
          <ChevronRight
            className={cn('size-3.5 shrink-0 transition-transform', !props.closed && 'rotate-90')}
          />
          {props.title}
          <span className="rounded-full bg-surface-2 px-1.5 text-[11px] tabular-nums tracking-normal">
            {props.count}
          </span>
        </button>
        <span className="flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {props.actions}
        </span>
      </div>
      {!props.closed && <div className="mt-0.5">{props.children}</div>}
    </section>
  )
}

function RowAction(props: { label: string; onClick(): void; children: ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={(e) => {
        e.stopPropagation()
        props.onClick()
      }}
      className={cn(
        'grid size-6 place-items-center rounded-md text-muted hover:bg-surface-3',
        props.danger ? 'hover:text-bad-ink' : 'hover:text-fg',
      )}
    >
      {props.children}
    </button>
  )
}

/** A changed file, VS Code style: status letter, name with its folder, hover actions; opens to its diff. */
function ChangeRow(props: {
  project: string
  path: string
  status: string
  kind: Kind
  actions: ReactNode
  version: number
}) {
  const [open, setOpen] = useState(false)
  const [patch, setPatch] = useState<string>()
  const s = STATUS[props.status] ?? { label: props.status, className: 'text-fg-2', title: '' }
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` refetches after the folder changes
  useEffect(() => {
    if (!open) return
    api<{ patch: string }>(
      `/api/projects/${props.project}/git/diff?kind=${props.kind}&path=${encodeURIComponent(props.path)}`,
    )
      .then((r) => setPatch(r.patch))
      .catch(() => setPatch(''))
  }, [open, props.project, props.kind, props.path, props.version])
  return (
    <div>
      <div className="group flex items-center gap-2 rounded-lg px-2 hover:bg-surface-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
        >
          <ChevronRight
            className={cn('size-3 shrink-0 text-muted transition-transform', open && 'rotate-90')}
          />
          <FilePath path={props.path} />
        </button>
        <span className="flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {props.actions}
        </span>
        <span
          title={s.title}
          className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-bold', s.className)}
        >
          {s.label}
        </span>
      </div>
      {open && (
        <div className="mx-2 mb-1.5 mt-0.5 overflow-hidden rounded-lg border border-line">
          {patch === undefined ? (
            <LoaderCircle className="m-2 size-4 animate-spin text-muted" />
          ) : (
            <FilePatch text={patch} mode="unified" />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The project's own git repository, like VS Code's Source Control: branch, a commit box, staged / changes /
 * untracked with stage, unstage and discard, and the history; "Open" shows any of it GitLab style.
 */
export function GitView({ project }: { project: string }) {
  const toast = useToast()
  const [status, setStatus] = useState<Status>()
  const [error, setError] = useState<string>()
  const [closed, toggle] = useClosedSections()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [discard, setDiscard] = useState<{ paths: string[]; untracked: number }>()
  const [full, setFull] = useState<Target>()
  const [version, setVersion] = useState(0)

  const load = useCallback(() => {
    api<Status>(`/api/projects/${project}/git`)
      .then((s) => {
        setStatus(s)
        setError(undefined)
        setVersion((v) => v + 1)
      })
      .catch((err) => setError(String((err as Error).message)))
  }, [project])

  // Agents edit the folder while you watch, so status refreshes on its own.
  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  const act = async (action: string, body: object, done?: string) => {
    setBusy(true)
    try {
      const r = await send<{ commit?: string }>('POST', `/api/projects/${project}/git/${action}`, body)
      if (done) toast(r.commit ? `${done} ${r.commit}` : done, 'success')
      load()
      return true
    } catch (err) {
      toast(String((err as Error).message), 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  if (error) return <p className="p-4 text-[13px] text-bad-ink">{error}</p>
  if (!status)
    return (
      <div className="p-4">
        <LoaderCircle className="size-4 animate-spin text-muted" />
      </div>
    )
  if (!status.repo)
    return (
      <Empty icon={<GitBranch className="size-5" />} title="Not a git repository">
        This project folder has no git repository. Each round’s changes are still checkpointed and can be
        rewound from the chat.
      </Empty>
    )

  const staged = status.files.filter((f) => f.index !== '.' && f.index !== '?')
  const unstaged = status.files.filter((f) => f.worktree !== '.' && f.worktree !== '?')
  const untracked = status.files.filter((f) => f.index === '?')
  const paths = (list: { path: string }[]) => list.map((f) => f.path)
  const commit = async () => {
    if (await act('commit', { message, all: staged.length === 0 }, 'Committed')) setMessage('')
  }
  const nothing = status.files.length === 0

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-1.5">
        <span className="flex min-w-0 items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1 text-[12.5px]">
          <GitBranch className="size-3.5 shrink-0 text-muted" />
          <span className="truncate font-medium">{status.branch ?? 'detached HEAD'}</span>
          {status.upstream && (
            <span
              className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-muted"
              title={status.upstream}
            >
              <ArrowUp className="size-3" />
              {status.ahead}
              <ArrowDown className="size-3" />
              {status.behind}
            </span>
          )}
        </span>
        <span className="flex-1" />
        <IconButton label="Refresh" size="sm" onClick={load}>
          <RefreshCw className="size-3.5" />
        </IconButton>
        <IconButton
          label="Open all changes in the full view"
          size="sm"
          onClick={() => setFull({ kind: 'working' })}
        >
          <Maximize2 className="size-3.5" />
        </IconButton>
      </div>

      <div className="flex flex-col gap-1.5">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && message.trim() && !nothing) {
              e.preventDefault()
              void commit()
            }
          }}
          rows={2}
          placeholder={`Message (⌘↵ to commit on “${status.branch ?? 'HEAD'}”)`}
          aria-label="Commit message"
          className="w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-muted focus:border-line-strong"
        />
        <Button
          size="sm"
          variant="primary"
          disabled={busy || nothing || !message.trim()}
          onClick={() => void commit()}
          icon={<Check className="size-3.5" />}
          title={staged.length ? 'Commit the staged changes' : 'Stage every change and commit'}
        >
          {staged.length ? `Commit ${staged.length} staged` : 'Commit all'}
        </Button>
      </div>

      {nothing && <p className="px-1 text-[12.5px] text-muted">No uncommitted changes.</p>}
      {staged.length > 0 && (
        <Section
          id="staged"
          title="Staged"
          count={staged.length}
          closed={closed.has('staged')}
          onToggle={() => toggle('staged')}
          actions={
            <RowAction label="Unstage all" onClick={() => void act('unstage', { paths: paths(staged) })}>
              <Minus className="size-3.5" />
            </RowAction>
          }
        >
          {staged.map((f) => (
            <ChangeRow
              key={`s:${f.path}`}
              project={project}
              path={f.path}
              status={f.index}
              kind="staged"
              version={version}
              actions={
                <RowAction label="Unstage" onClick={() => void act('unstage', { paths: [f.path] })}>
                  <Minus className="size-3.5" />
                </RowAction>
              }
            />
          ))}
        </Section>
      )}
      {unstaged.length > 0 && (
        <Section
          id="changes"
          title="Changes"
          count={unstaged.length}
          closed={closed.has('changes')}
          onToggle={() => toggle('changes')}
          actions={
            <>
              <RowAction
                label="Discard all changes"
                danger
                onClick={() => setDiscard({ paths: paths(unstaged), untracked: 0 })}
              >
                <Undo2 className="size-3.5" />
              </RowAction>
              <RowAction
                label="Stage all changes"
                onClick={() => void act('stage', { paths: paths(unstaged) })}
              >
                <Plus className="size-3.5" />
              </RowAction>
            </>
          }
        >
          {unstaged.map((f) => (
            <ChangeRow
              key={`u:${f.path}`}
              project={project}
              path={f.path}
              status={f.worktree}
              kind="unstaged"
              version={version}
              actions={
                <>
                  <RowAction
                    label="Discard changes"
                    danger
                    onClick={() => setDiscard({ paths: [f.path], untracked: 0 })}
                  >
                    <Undo2 className="size-3.5" />
                  </RowAction>
                  <RowAction label="Stage" onClick={() => void act('stage', { paths: [f.path] })}>
                    <Plus className="size-3.5" />
                  </RowAction>
                </>
              }
            />
          ))}
        </Section>
      )}
      {untracked.length > 0 && (
        <Section
          id="untracked"
          title="Untracked"
          count={untracked.length}
          closed={closed.has('untracked')}
          onToggle={() => toggle('untracked')}
          actions={
            <RowAction
              label="Stage all untracked"
              onClick={() => void act('stage', { paths: paths(untracked) })}
            >
              <Plus className="size-3.5" />
            </RowAction>
          }
        >
          {untracked.map((f) => (
            <ChangeRow
              key={`n:${f.path}`}
              project={project}
              path={f.path}
              status="?"
              kind="untracked"
              version={version}
              actions={
                <>
                  <RowAction
                    label="Delete file"
                    danger
                    onClick={() => setDiscard({ paths: [f.path], untracked: 1 })}
                  >
                    <Undo2 className="size-3.5" />
                  </RowAction>
                  <RowAction label="Stage" onClick={() => void act('stage', { paths: [f.path] })}>
                    <Plus className="size-3.5" />
                  </RowAction>
                </>
              }
            />
          ))}
        </Section>
      )}

      <Section
        id="history"
        title="History"
        count={status.log.length}
        closed={closed.has('history')}
        onToggle={() => toggle('history')}
      >
        {status.log.length === 0 ? (
          <p className="px-2 text-[12.5px] text-muted">No commits yet.</p>
        ) : (
          <ol className="relative ml-[15px] border-l border-line">
            {status.log.map((c, i) => (
              <li key={c.hash} className="relative">
                <span
                  className={cn(
                    'absolute -left-[5px] top-[11px] size-[9px] rounded-full border-2 border-surface',
                    i === 0 ? 'bg-accent' : 'bg-fg-2',
                  )}
                />
                <button
                  type="button"
                  onClick={() => setFull({ kind: 'commit', commit: c })}
                  className="flex w-full items-start gap-2 rounded-lg py-1.5 pl-3 pr-2 text-left hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{c.subject}</span>
                    <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
                      <span
                        className="grid size-4 place-items-center rounded-full text-[8px] font-bold text-white"
                        style={{ background: `hsl(${hue(c.author)} 45% 45%)` }}
                      >
                        {initials(c.author)}
                      </span>
                      {c.author} · {ago(c.date)}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted">{c.short}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <AnimatePresence>
        {discard && (
          <Modal title="Discard changes?" onClose={() => !busy && setDiscard(undefined)} size="sm">
            <div className="flex flex-col gap-4">
              <p className="text-[13.5px] leading-relaxed text-fg-2">
                {discard.untracked
                  ? `${discard.paths[0]} is not tracked by git, so it will be deleted.`
                  : `${discard.paths.length === 1 ? discard.paths[0] : `${discard.paths.length} files`} go back to their last staged or committed content.`}{' '}
                Git cannot bring this work back.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDiscard(undefined)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  icon={<Undo2 className="size-3.5" />}
                  onClick={async () => {
                    if (await act('discard', { paths: discard.paths }, 'Discarded')) setDiscard(undefined)
                  }}
                >
                  {discard.untracked ? 'Delete file' : 'Discard'}
                </Button>
              </div>
            </div>
          </Modal>
        )}
        {full && <FullView key="full" project={project} target={full} onClose={() => setFull(undefined)} />}
      </AnimatePresence>
    </div>
  )
}

function Tree(props: {
  nodes: TreeNode[]
  files: Map<string, DiffFile>
  depth: number
  onPick(path: string): void
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  return (
    <>
      {props.nodes.map((n) => {
        const pad = { paddingLeft: `${8 + props.depth * 12}px` }
        if (n.file) {
          const f = props.files.get(n.file)
          const s = STATUS[f?.status ?? 'M'] ?? { label: f?.status ?? '', className: '', title: '' }
          return (
            <button
              key={n.path}
              type="button"
              style={pad}
              onClick={() => props.onPick(n.file as string)}
              className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[12.5px] hover:bg-surface-2"
            >
              <span className="min-w-0 flex-1 truncate font-mono">{n.name}</span>
              {f?.added !== undefined && (
                <span className="shrink-0 font-mono text-[11px] tabular-nums">
                  <span className="text-ok-ink">+{f.added}</span>{' '}
                  <span className="text-bad-ink">−{f.removed}</span>
                </span>
              )}
              <span className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-bold', s.className)}>
                {s.label}
              </span>
            </button>
          )
        }
        const shut = closed.has(n.path)
        return (
          <div key={n.path}>
            <button
              type="button"
              style={pad}
              onClick={() =>
                setClosed((c) => {
                  const next = new Set(c)
                  if (next.has(n.path)) next.delete(n.path)
                  else next.add(n.path)
                  return next
                })
              }
              className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[12.5px] text-fg-2 hover:bg-surface-2"
            >
              <ChevronRight className={cn('size-3 shrink-0 transition-transform', !shut && 'rotate-90')} />
              <Folder className="size-3.5 shrink-0 text-muted" />
              <span className="truncate font-mono">{n.name}</span>
            </button>
            {!shut && (
              <Tree nodes={n.children} files={props.files} depth={props.depth + 1} onPick={props.onPick} />
            )}
          </div>
        )
      })}
    </>
  )
}

/**
 * GitLab-style view of uncommitted changes or one commit: header with message, author and SHA; a file tree beside
 * every file's diff, unified or side by side.
 */
function FullView(props: { project: string; target: Target; onClose(): void }) {
  const toast = useToast()
  const [data, setData] = useState<
    Changes & { subject?: string; body?: string; author?: string; date?: string }
  >()
  const [mode, setMode] = useDiffMode()
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const { target } = props
  useEffect(() => {
    const path =
      target.kind === 'working'
        ? `/api/projects/${props.project}/git/changes`
        : `/api/projects/${props.project}/git/commits/${target.commit.hash}`
    api<Changes>(path)
      .then(setData)
      .catch((err) => toast(String((err as Error).message), 'error'))
  }, [props.project, target, toast])
  const sections = useMemo(() => splitPatch(data?.patch ?? ''), [data])
  const files = useMemo(() => new Map((data?.files ?? []).map((f) => [f.path, f])), [data])
  const tree = useMemo(() => fileTree((data?.files ?? []).map((f) => f.path)), [data])
  const added = data?.files.reduce((n, f) => n + (f.added ?? 0), 0) ?? 0
  const removed = data?.files.reduce((n, f) => n + (f.removed ?? 0), 0) ?? 0
  const anchor = (path: string) => `diff-${path.replace(/[^a-zA-Z0-9]/g, '-')}`

  return (
    <Modal
      title={target.kind === 'working' ? 'Uncommitted changes' : target.commit.subject}
      onClose={props.onClose}
      size="full"
      flush
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3 text-[12.5px] text-muted">
          {target.kind === 'commit' && (
            <>
              <span className="flex items-center gap-1.5">
                <span
                  className="grid size-5 place-items-center rounded-full text-[11px] font-bold text-white"
                  style={{ background: `hsl(${hue(target.commit.author)} 45% 45%)` }}
                >
                  {initials(target.commit.author)}
                </span>
                <span className="text-fg">{data?.author ?? target.commit.author}</span> committed{' '}
                {ago(target.commit.date)}
              </span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(target.commit.hash)
                  toast('Copied the commit SHA', 'success')
                }}
                className="flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] text-fg-2 hover:text-fg"
                title="Copy the full SHA"
              >
                {target.commit.short} <Copy className="size-3" />
              </button>
            </>
          )}
          {data && (
            <span className="flex items-center gap-2">
              {data.files.length} file{data.files.length === 1 ? '' : 's'}
              <span className="font-mono text-ok-ink">+{added}</span>
              <span className="font-mono text-bad-ink">−{removed}</span>
              <StatBar added={added} removed={removed} />
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            className="rounded-md px-1.5 py-0.5 hover:bg-surface-2 hover:text-fg"
            onClick={() =>
              setClosed(closed.size === 0 ? new Set((data?.files ?? []).map((f) => f.path)) : new Set())
            }
          >
            {closed.size === 0 ? 'Collapse all' : 'Expand all'}
          </button>
          <DiffModeToggle mode={mode} onMode={setMode} />
        </div>
        {target.kind === 'commit' && data?.body && (
          <pre className="whitespace-pre-wrap border-b border-line px-5 py-2.5 font-sans text-[13px] text-fg-2">
            {data.body}
          </pre>
        )}
        {!data ? (
          <div className="p-5">
            <LoaderCircle className="size-5 animate-spin text-muted" />
          </div>
        ) : data.files.length === 0 ? (
          <p className="p-5 text-[13px] text-muted">No changes.</p>
        ) : (
          <div className="flex min-h-0 flex-1">
            <nav
              aria-label="Changed files"
              className="hidden w-64 shrink-0 overflow-y-auto border-r border-line p-2 md:block"
            >
              <Tree
                nodes={tree}
                files={files}
                depth={0}
                onPick={(p) =>
                  document.getElementById(anchor(p))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
              />
            </nav>
            <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
              {data.files.map((f) => (
                <FileDiff
                  key={f.path}
                  id={anchor(f.path)}
                  file={f}
                  text={sections.get(f.path) ?? ''}
                  mode={mode}
                  open={!closed.has(f.path)}
                  onToggle={() =>
                    setClosed((c) => {
                      const next = new Set(c)
                      if (next.has(f.path)) next.delete(f.path)
                      else next.add(f.path)
                      return next
                    })
                  }
                />
              ))}
              {data.truncated && (
                <p className="text-[12px] text-muted">The diff is large; only its first 512 KB is shown.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
