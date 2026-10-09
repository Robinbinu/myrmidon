import { useState } from 'react'
import type { ChatSummary } from '../api.ts'
import { copy } from '../copy.ts'
import { isMac } from '../ui/platform.ts'
import { comboLabel } from '../ui/shortcuts.ts'
import { useToastHandle } from '../ui/Toast.tsx'
import { holdBack } from '../ui/undo.ts'
import { UNDO_DELETE_COMBO, UNDO_DELETE_MS } from '../ui-config.ts'

/**
 * Chats deleted from this window: hidden at once, and deleted for good only once their undo lapses. Until then they
 * live in this window alone, so closing or reloading it keeps them: nothing is gone that the person could still have
 * taken back. Chats deleted together come back together, from one toast.
 */
export function useHeldDeletes(server: {
  remove(chatId: string): Promise<unknown>
  /** The chats now deleted for good. */
  gone(chatIds: readonly string[]): void
}) {
  const toast = useToastHandle()
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set())
  /** The deletes that can still be taken back, latest last. */
  const [undoable, setUndoable] = useState<readonly { undo(): void }[]>([])
  const show = (chatIds: readonly string[]) =>
    setDeleted((s) => {
      const next = new Set(s)
      for (const id of chatIds) next.delete(id)
      return next
    })

  /** Hides `chats` and deletes them once their undo lapses; `restored` runs if the person takes them back. */
  const hold = (chats: readonly ChatSummary[], restored?: () => void) => {
    const ids = chats.map((c) => c.chatId)
    if (!ids.length) return
    setDeleted((s) => new Set([...s, ...ids]))
    const entry = { undo: () => {} }
    const settle = () => setUndoable((u) => u.filter((x) => x !== entry))
    const takeBack = holdBack(() => {
      settle()
      void Promise.allSettled(ids.map((id) => server.remove(id))).then((results) => {
        const failed = chats.filter((_, i) => results[i]?.status === 'rejected')
        // A chat deleted for good stays hidden: the list forgets it at its next look.
        server.gone(ids.filter((id) => !failed.some((c) => c.chatId === id)))
        show(failed.map((c) => c.chatId))
        results.forEach((r, i) => {
          if (r.status !== 'rejected') return
          const reason = String((r.reason as Error)?.message ?? r.reason)
          toast(copy.app.toasts.deleteFailed(chats[i]?.title ?? '', reason), 'error')
        })
      })
    }, UNDO_DELETE_MS)
    entry.undo = () => {
      if (!takeBack()) return
      settle()
      show(ids)
      shown.close()
      restored?.()
    }
    const one = chats.length === 1 ? chats[0] : undefined
    const keys = comboLabel(UNDO_DELETE_COMBO, isMac)
    const shown = toast(
      one ? copy.app.toasts.deleted(one.title) : copy.app.toasts.deletedMany(chats.length),
      'success',
      {
        label: copy.app.toasts.undoDelete,
        title: one ? copy.app.toasts.undoDeleteTitle(keys) : copy.app.toasts.undoDeleteManyTitle(keys),
        run: () => entry.undo(),
      },
      { ms: UNDO_DELETE_MS },
    )
    setUndoable((u) => [...u, entry])
  }

  return { deleted, hold, undoLast: undoable.at(-1)?.undo }
}
