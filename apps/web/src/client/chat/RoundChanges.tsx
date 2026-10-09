import type { ColonyState } from '@myrmidon/protocol'
import { FolderGit2, History, RotateCcw, Undo2 } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { useEffect, useState } from 'react'
import { api, send } from '../api.ts'
import { copy } from '../copy.ts'
import { Button } from '../ui/primitives.tsx'
import { Sheet } from '../ui/Sheet.tsx'
import { useToast } from '../ui/Toast.tsx'
import { type DiffFile, DiffView } from './DiffView.tsx'
import { useOpenProjectFile } from './ProjectFiles.tsx'

interface Changes {
  files: DiffFile[]
  patch: string
  truncated: boolean
}

/**
 * What a project round changed in its folder, from the snapshots taken when it started and ended, with Rewind
 * (back to how the folder was before the round) and Undo.
 */
export function RoundChanges(props: {
  colonyId: string
  /** The chat round within the colony, when the colony has several. */
  round?: number
  /** The round's own snapshots (an end snapshot lands after the round's last event). */
  checkpoints: { start?: string; end?: string }
  state: ColonyState
  running: boolean
}) {
  const toast = useToast()
  const openFile = useOpenProjectFile()
  const { state, checkpoints } = props
  const project = state.chat?.project
  const [changes, setChanges] = useState<Changes>()
  const [failed, setFailed] = useState(false)
  /** Bumped by Retry to fetch again. */
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  /** Files the last rewind kept because they were edited again after the round. */
  const [skipped, setSkipped] = useState<string[]>([])
  const restored = state.checkpoints.restored
  const rewound = restored !== undefined && restored.commit === checkpoints.start
  const key = `${checkpoints.end ?? ''}:${restored?.time ?? ''}`
  const query = props.round === undefined ? '' : `?round=${props.round}`

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the round ends or is rewound (`key`), or on Retry
  useEffect(() => {
    if (!project || !checkpoints.start || props.running) return
    setFailed(false)
    api<Changes>(`/api/colonies/${props.colonyId}/changes${query}`)
      .then(setChanges)
      .catch(() => {
        setChanges(undefined)
        setFailed(true)
      })
  }, [props.colonyId, key, props.running, query, attempt])

  if (!project || !checkpoints.start || props.running) return null
  if (failed)
    return (
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-body" role="alert">
        <FolderGit2 className="size-4 shrink-0 text-muted" />
        <span className="text-bad-ink">{copy.roundChanges.failed(project.name)}</span>
        <span className="flex-1" />
        <Button size="sm" onClick={() => setAttempt((n) => n + 1)} icon={<RotateCcw className="size-3.5" />}>
          {copy.roundChanges.retry}
        </Button>
      </div>
    )
  // A round that changed nothing in the folder has nothing to say about it (and nothing until that is known).
  if (!changes || (changes.files.length === 0 && !rewound)) return null
  const added = changes.files.reduce((n, f) => n + (f.added ?? 0), 0)
  const removed = changes.files.reduce((n, f) => n + (f.removed ?? 0), 0)

  const rewind = async (undo: boolean, force = false) => {
    setBusy(true)
    try {
      const r = await send<{ changed: number; skipped: string[] }>(
        'POST',
        `/api/colonies/${props.colonyId}/rewind`,
        {
          ...(undo ? { undo } : {}),
          ...(force ? { force } : {}),
          ...(props.round === undefined ? {} : { round: props.round }),
        },
      )
      toast(
        undo
          ? copy.roundChanges.toast.undid(project.name)
          : copy.roundChanges.toast.rewound(r.changed, project.name),
        'success',
      )
      // Kept files stay listed in the sheet so the person can still choose to rewind them.
      setSkipped(r.skipped ?? [])
      if (!r.skipped?.length) setConfirm(false)
      // The Git panel shows the same folder; without this it would show the old state until its next poll.
      window.dispatchEvent(new CustomEvent('myr:folder-changed', { detail: { project: project.id } }))
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-body">
        <FolderGit2 className="size-4 shrink-0 text-muted" />
        {rewound ? (
          <span className="text-fg-2">
            {copy.roundChanges.rewound.before} <span className="font-medium text-fg">{project.name}</span>{' '}
            {copy.roundChanges.rewound.after}
          </span>
        ) : (
          <span className="text-fg-2">
            <span className="font-medium text-fg">{copy.roundChanges.files(changes.files.length)}</span>{' '}
            {copy.roundChanges.changedIn(project.name)}{' '}
            <span className="font-mono text-small tabular-nums">
              <span className="text-ok-ink">+{added}</span> <span className="text-bad-ink">−{removed}</span>
            </span>
          </span>
        )}
        <span className="flex-1" />
        {/* Rewound, the run's changes stay listed (they are the snapshots, not the folder), so they can be read again. */}
        {changes.files.length > 0 && (
          <Button size="sm" variant="borderless" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? copy.roundChanges.hideDiff : copy.roundChanges.viewDiff}
          </Button>
        )}
        {rewound ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => rewind(true)}
            icon={<Undo2 className="size-3.5" />}
          >
            {copy.roundChanges.undoRewind}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => setConfirm(true)}
            icon={<History className="size-3.5" />}
          >
            {copy.roundChanges.rewind}
          </Button>
        )}
      </div>
      {open && (
        <div className="px-3 pb-3">
          <DiffView
            files={changes.files}
            patch={changes.patch}
            truncated={changes.truncated}
            {...(openFile ? { onOpen: openFile } : {})}
          />
        </div>
      )}
      <AnimatePresence>
        {confirm && changes && (
          <Sheet title={copy.roundChanges.confirm.title} onClose={() => !busy && setConfirm(false)} size="sm">
            <div className="flex flex-col gap-4">
              {skipped.length === 0 ? (
                <p className="text-reading leading-relaxed text-fg-2">
                  {copy.roundChanges.confirm.body(project.name, changes.files.length)}
                </p>
              ) : (
                <div className="flex flex-col gap-2 text-reading text-fg-2">
                  <p>{copy.roundChanges.confirm.skippedTitle(skipped.length)}</p>
                  <ul className="max-h-40 overflow-auto rounded-xl bg-fill/60 px-3 py-2 font-mono text-small">
                    {skipped.map((f) => (
                      <li key={f} className="truncate">
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {skipped.length > 0 ? (
                <div className="flex justify-end gap-2">
                  <Button
                    variant="borderless"
                    onClick={() => {
                      setSkipped([])
                      setConfirm(false)
                    }}
                    disabled={busy}
                  >
                    {copy.roundChanges.confirm.keep}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => rewind(false, true)}
                    disabled={busy}
                    icon={<History className="size-3.5" />}
                  >
                    {busy ? copy.roundChanges.confirm.rewinding : copy.roundChanges.confirm.rewindThemToo}
                  </Button>
                </div>
              ) : (
                <div className="flex justify-end gap-2">
                  <Button variant="borderless" onClick={() => setConfirm(false)} disabled={busy}>
                    {copy.roundChanges.confirm.cancel}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => rewind(false)}
                    disabled={busy}
                    icon={<History className="size-3.5" />}
                  >
                    {busy ? copy.roundChanges.confirm.rewinding : copy.roundChanges.confirm.rewindFiles}
                  </Button>
                </div>
              )}
            </div>
          </Sheet>
        )}
      </AnimatePresence>
    </div>
  )
}
