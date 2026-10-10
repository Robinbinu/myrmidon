import { CircleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, type ImportableSession, type ImportedSession, type ImportedTurn, post } from '../api.ts'
import { copy } from '../copy.ts'
import { ago } from '../ui/hooks.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Banner, cn, Empty, Skeleton, TextInput } from '../ui/primitives.tsx'
import { IMPORT_RESULT_CHARS, IMPORT_SHOWN_PER_PROJECT } from '../ui-config.ts'
import { FoldChevron } from './Folds.tsx'

const t = copy.importSessions

/** The folder's last name, as a project row shows it ("/work/app" → "app"). */
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

export interface SessionGroup {
  readonly source: ImportableSession['source']
  readonly folders: {
    readonly key: string
    readonly name: string
    readonly cwd: string
    sessions: ImportableSession[]
  }[]
}

/**
 * The sessions that match `query`, grouped by tool and then by the project (or folder) they worked in, each list
 * newest first as the server sends them. Matches the title, the first message, the folder and the tool's name.
 */
export function groupSessions(sessions: readonly ImportableSession[], query: string): SessionGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const groups: SessionGroup[] = []
  for (const s of sessions) {
    const name = s.project?.name ?? folderName(s.cwd)
    const haystack = [s.title, s.preview, s.cwd, name, t.tools[s.source]].join(' ').toLowerCase()
    if (!words.every((w) => haystack.includes(w))) continue
    let group = groups.find((g) => g.source === s.source)
    if (!group) {
      group = { source: s.source, folders: [] }
      groups.push(group)
    }
    const key = s.project?.id ?? s.cwd
    const folder = group.folders.find((f) => f.key === key)
    if (folder) folder.sessions.push(s)
    else group.folders.push({ key, name, cwd: s.cwd, sessions: [s] })
  }
  return groups
}

/**
 * Import a session: the person's Claude Code and Codex sessions on the server's machine, by tool and project, with
 * search. Picking one imports it, and the caller opens a new chat that continues it.
 */
export function ImportSessions(props: { onImported(session: ImportedSession): void }) {
  const [sessions, setSessions] = useState<ImportableSession[]>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [importing, setImporting] = useState<string>()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    let live = true
    api<{ sessions: ImportableSession[] }>('/api/import-sessions')
      .then((r) => live && setSessions(r.sessions))
      .catch((err: Error) => live && setError(err.message))
    return () => {
      live = false
    }
  }, [])
  const groups = useMemo(() => groupSessions(sessions ?? [], query), [sessions, query])
  const pick = (s: ImportableSession) => {
    if (importing) return
    setImporting(`${s.source}:${s.id}`)
    setError(undefined)
    post<ImportedSession>('/api/import-sessions', { source: s.source, id: s.id })
      .then(props.onImported)
      .catch((err: Error) => setError(err.message))
      .finally(() => setImporting(undefined))
  }
  if (!sessions && !error)
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <p className="text-callout text-muted">{t.loading}</p>
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </div>
    )
  if (!sessions)
    return (
      <Banner tone="bad" role="alert">
        {t.failed}: {error}
      </Banner>
    )
  if (!sessions.length)
    return (
      <Empty icon={<FEATURE_ICONS.sessionImport className="size-5" />} title={t.empty}>
        {t.emptyHint}
      </Empty>
    )
  return (
    <div className="flex flex-col gap-4">
      <TextInput
        type="search"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t.search}
        aria-label={t.search}
      />
      {error && (
        <Banner tone="bad" role="alert">
          {error}
        </Banner>
      )}
      {!groups.length && <p className="text-callout text-muted">{t.noMatch(query.trim())}</p>}
      {groups.map((group) => (
        <section key={group.source} className="flex flex-col gap-3">
          <h3 className="text-small font-semibold uppercase tracking-wide text-muted">
            {t.tools[group.source]}
          </h3>
          {group.folders.map((folder) => {
            const key = `${group.source}:${folder.key}`
            const all = query.trim() !== '' || expanded.has(key)
            const shown = all ? folder.sessions : folder.sessions.slice(0, IMPORT_SHOWN_PER_PROJECT)
            return (
              <div key={key} className="flex flex-col">
                <div className="flex items-baseline gap-2 px-1 pb-1">
                  <span className="shrink-0 whitespace-nowrap text-callout font-medium text-fg">
                    {folder.name}
                  </span>
                  <span className="min-w-0 truncate text-small text-muted" title={folder.cwd}>
                    {folder.cwd}
                  </span>
                </div>
                <ul className="flex flex-col overflow-hidden rounded-lg border border-line">
                  {shown.map((s) => (
                    <li key={s.id} className="border-line border-t first:border-t-0">
                      <SessionRow
                        session={s}
                        busy={importing === `${s.source}:${s.id}`}
                        disabled={!!importing}
                        onPick={() => pick(s)}
                      />
                    </li>
                  ))}
                </ul>
                {shown.length < folder.sessions.length && (
                  <button
                    type="button"
                    className="self-start px-1 pt-1 text-small text-muted hover:text-fg"
                    onClick={() => setExpanded((e) => new Set(e).add(key))}
                  >
                    {t.showAll(folder.sessions.length)}
                  </button>
                )}
              </div>
            )
          })}
        </section>
      ))}
      <p className="text-small text-muted">{t.footnote}</p>
    </div>
  )
}

function SessionRow(props: { session: ImportableSession; busy: boolean; disabled: boolean; onPick(): void }) {
  const s = props.session
  const heading = s.title ?? s.preview ?? t.untitled
  return (
    <button
      type="button"
      disabled={props.disabled}
      aria-busy={props.busy || undefined}
      onClick={props.onPick}
      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-fill disabled:opacity-60"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-fg">{heading}</span>
        {s.title && s.preview && <span className="truncate text-small text-muted">{s.preview}</span>}
      </span>
      <span className="shrink-0 text-right text-small text-muted">
        {props.busy ? t.importing : ago(s.updatedAt)}
        <br />
        {s.messages ? t.messages(s.messages) : t.size(s.bytes)}
      </span>
    </button>
  )
}

/** An imported conversation, folded under one line until the person opens it. */
export function ImportedTranscript(props: { session: ImportedSession; className?: string }) {
  const [open, setOpen] = useState(false)
  const s = props.session
  const Icon = FEATURE_ICONS.sessionImport
  return (
    <div className={cn('rounded-lg border border-line bg-fill/40', props.className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-callout text-fg-2 hover:text-fg"
      >
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted" />
        <span className="shrink-0 font-medium">{t.block(t.tools[s.source])}</span>
        <span className="min-w-0 flex-1 truncate text-muted">
          {s.title} · {t.turns(s.turns.length)}
        </span>
        <span className="sr-only">{open ? t.hide : t.show}</span>
        <FoldChevron open={open} className="text-muted" />
      </button>
      {open && (
        <div className="flex max-h-[45vh] flex-col gap-3 overflow-y-auto border-line border-t px-4 py-3">
          {s.omitted > 0 && <p className="text-small italic text-muted">{t.omitted(s.omitted)}</p>}
          {s.turns.map((turn, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: an import's turns are fixed
            <Turn key={i} turn={turn} />
          ))}
        </div>
      )}
    </div>
  )
}

function Turn(props: { turn: ImportedTurn }) {
  const turn = props.turn
  if (turn.role === 'tool')
    return (
      <div className="flex flex-col gap-0.5 font-mono text-small">
        <span className="break-words text-fg-2">
          <span className="font-semibold">{turn.tool}</span>
          {turn.text && ` ${turn.text}`}
        </span>
        {turn.result && (
          <span className={cn('whitespace-pre-wrap break-words', turn.error ? 'text-bad-ink' : 'text-muted')}>
            {turn.error && `${t.failedResult}: `}
            {turn.result.length > IMPORT_RESULT_CHARS
              ? `${turn.result.slice(0, IMPORT_RESULT_CHARS - 1)}…`
              : turn.result}
          </span>
        )}
      </div>
    )
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-small font-semibold text-muted">{t.roles[turn.role]}</span>
      <p
        className={cn(
          'whitespace-pre-wrap break-words text-callout',
          turn.role === 'user' ? 'text-fg' : 'text-fg-2',
          turn.role === 'summary' && 'italic',
        )}
      >
        {turn.text}
      </p>
    </div>
  )
}

/** At the top of a chat that continues an imported session: its transcript, loaded when the chat opens. */
export function ImportedChatBlock(props: { importId: string }) {
  const [session, setSession] = useState<ImportedSession | 'gone'>()
  useEffect(() => {
    let live = true
    api<ImportedSession>(`/api/imported/${encodeURIComponent(props.importId)}`)
      .then((s) => live && setSession(s))
      .catch(() => live && setSession('gone'))
    return () => {
      live = false
    }
  }, [props.importId])
  if (!session) return null
  if (session === 'gone')
    return (
      <p className="flex items-center gap-2 text-small text-muted">
        <CircleAlert aria-hidden className="size-3.5" />
        {t.gone}
      </p>
    )
  return <ImportedTranscript session={session} />
}

/** Above a new chat's composer: which session it continues, its transcript, and a way to start fresh instead. */
export function ImportNote(props: { session: ImportedSession; onCancel(): void }) {
  return (
    <div className="mb-2 flex w-full flex-col gap-2">
      <div className="flex items-center gap-2 px-1 text-callout text-fg-2">
        <span className="min-w-0 flex-1 truncate">
          {t.note(t.tools[props.session.source], props.session.title)}
        </span>
        <button type="button" onClick={props.onCancel} className="shrink-0 text-muted hover:text-fg">
          {t.cancel}
        </button>
      </div>
      <ImportedTranscript session={props.session} />
    </div>
  )
}
