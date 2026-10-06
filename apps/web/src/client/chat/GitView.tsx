import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.ts'
import { cn, Empty, IconButton } from '../ui/primitives.tsx'
import { type DiffFile, DiffView } from './DiffView.tsx'

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

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function CommitRow({ project, commit }: { project: string; commit: Commit }) {
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<Changes>()
  useEffect(() => {
    if (open && !diff)
      api<Changes>(`/api/projects/${project}/git/commits/${commit.hash}`)
        .then(setDiff)
        .catch(() => setDiff({ files: [], patch: '', truncated: false }))
  }, [open, diff, project, commit.hash])
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
      >
        <ChevronRight
          className={cn('mt-0.5 size-3.5 shrink-0 text-muted transition-transform', open && 'rotate-90')}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{commit.subject}</span>
          <span className="text-[11.5px] text-muted">
            <span className="font-mono">{commit.short}</span> · {commit.author} · {ago(commit.date)}
          </span>
        </span>
      </button>
      {open && (
        <div className="py-1.5 pl-6">
          {diff ? (
            <DiffView files={diff.files} patch={diff.patch} truncated={diff.truncated} />
          ) : (
            <LoaderCircle className="size-4 animate-spin text-muted" />
          )}
        </div>
      )}
    </div>
  )
}

/** The project's own git repository, read-only: branch, uncommitted changes with their diff, and history. */
export function GitView({ project }: { project: string }) {
  const [status, setStatus] = useState<Status>()
  const [changes, setChanges] = useState<Changes>()
  const [error, setError] = useState<string>()

  const load = useCallback(() => {
    api<Status>(`/api/projects/${project}/git`)
      .then((s) => {
        setStatus(s)
        setError(undefined)
        if (s.repo) return api<Changes>(`/api/projects/${project}/git/changes`).then(setChanges)
      })
      .catch((err) => setError(String((err as Error).message)))
  }, [project])

  // Agents edit the folder while you watch, so status refreshes on its own.
  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  if (error) return <p className="p-4 text-[13px] text-bad">{error}</p>
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

  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-[13px]">
        <GitBranch className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 truncate font-medium">{status.branch ?? 'detached HEAD'}</span>
        {status.upstream && (
          <span
            className="flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] text-muted"
            title={status.upstream}
          >
            <span className="flex items-center">
              <ArrowUp className="size-3" />
              {status.ahead}
            </span>
            <span className="flex items-center">
              <ArrowDown className="size-3" />
              {status.behind}
            </span>
          </span>
        )}
        <span className="flex-1" />
        <IconButton label="Refresh" size="sm" onClick={load}>
          <RefreshCw className="size-3.5" />
        </IconButton>
      </div>

      <section>
        <h4 className="mb-1.5 px-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">
          Uncommitted changes{changes ? ` · ${changes.files.length}` : ''}
        </h4>
        {changes ? (
          <DiffView files={changes.files} patch={changes.patch} truncated={changes.truncated} />
        ) : (
          <LoaderCircle className="size-4 animate-spin text-muted" />
        )}
      </section>

      <section>
        <h4 className="mb-1 flex items-center gap-1.5 px-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">
          <GitCommitHorizontal className="size-3.5" /> History
        </h4>
        {status.log.length === 0 ? (
          <p className="px-1 text-[12.5px] text-muted">No commits yet.</p>
        ) : (
          status.log.map((c) => <CommitRow key={c.hash} project={project} commit={c} />)
        )}
      </section>
    </div>
  )
}
