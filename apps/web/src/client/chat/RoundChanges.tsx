import type { ColonyState } from '@myrmidon/protocol'
import { FolderGit2, History, LoaderCircle, Undo2 } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { useEffect, useState } from 'react'
import { api, send } from '../api.ts'
import { Modal } from '../ui/Modal.tsx'
import { Button } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'
import { type DiffFile, DiffView } from './DiffView.tsx'

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
  const { state, checkpoints } = props
  const project = state.chat?.project
  const [changes, setChanges] = useState<Changes>()
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const restored = state.checkpoints.restored
  const rewound = restored !== undefined && restored.commit === checkpoints.start
  const key = `${checkpoints.end ?? ''}:${restored?.time ?? ''}`
  const query = props.round === undefined ? '' : `?round=${props.round}`

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the round ends or is rewound (`key`)
  useEffect(() => {
    if (!project || !checkpoints.start || props.running) return
    api<Changes>(`/api/colonies/${props.colonyId}/changes${query}`)
      .then(setChanges)
      .catch(() => setChanges(undefined))
  }, [props.colonyId, key, props.running, query])

  if (!project || !checkpoints.start || props.running) return null
  const added = changes?.files.reduce((n, f) => n + (f.added ?? 0), 0) ?? 0
  const removed = changes?.files.reduce((n, f) => n + (f.removed ?? 0), 0) ?? 0

  const rewind = async (undo: boolean) => {
    setBusy(true)
    try {
      const r = await send<{ changed: number }>('POST', `/api/colonies/${props.colonyId}/rewind`, {
        ...(undo ? { undo } : {}),
        ...(props.round === undefined ? {} : { round: props.round }),
      })
      toast(
        undo
          ? `Undid the rewind in ${project.name}`
          : `Rewound ${r.changed} file${r.changed === 1 ? '' : 's'} in ${project.name}`,
        'success',
      )
      setConfirm(false)
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]">
        <FolderGit2 className="size-4 shrink-0 text-muted" />
        {!changes ? (
          <span className="flex items-center gap-1.5 text-muted">
            <LoaderCircle className="size-3.5 animate-spin" /> Checking changes in {project.name}…
          </span>
        ) : rewound ? (
          <span className="text-fg-2">
            Rewound <span className="font-medium text-fg">{project.name}</span> to before this round
          </span>
        ) : (
          <span className="text-fg-2">
            {changes.files.length === 0 ? (
              <>No changes in {project.name}</>
            ) : (
              <>
                <span className="font-medium text-fg">
                  {changes.files.length} file{changes.files.length === 1 ? '' : 's'}
                </span>{' '}
                changed in {project.name}{' '}
                <span className="font-mono text-[12px] tabular-nums">
                  <span className="text-ok">+{added}</span> <span className="text-bad">−{removed}</span>
                </span>
              </>
            )}
          </span>
        )}
        <span className="flex-1" />
        {changes && changes.files.length > 0 && !rewound && (
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide diff' : 'View diff'}
          </Button>
        )}
        {rewound ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => rewind(true)}
            icon={<Undo2 className="size-3.5" />}
          >
            Undo rewind
          </Button>
        ) : (
          changes &&
          changes.files.length > 0 && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => setConfirm(true)}
              icon={<History className="size-3.5" />}
            >
              Rewind
            </Button>
          )
        )}
      </div>
      {open && changes && !rewound && (
        <div className="px-3 pb-3">
          <DiffView files={changes.files} patch={changes.patch} truncated={changes.truncated} />
        </div>
      )}
      <AnimatePresence>
        {confirm && changes && (
          <Modal title="Rewind this round’s changes?" onClose={() => !busy && setConfirm(false)} size="sm">
            <div className="flex flex-col gap-4">
              <p className="text-[13.5px] leading-relaxed text-fg-2">
                {project.name} goes back to how it was before this round: {changes.files.length} changed file
                {changes.files.length === 1 ? ' is' : 's are'} restored and files the round added are removed.
                Later edits to those files are rewound too. The current state is saved first, so you can undo
                this.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirm(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => rewind(false)}
                  disabled={busy}
                  icon={<History className="size-3.5" />}
                >
                  {busy ? 'Rewinding…' : 'Rewind files'}
                </Button>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  )
}
