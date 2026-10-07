import type { ColonyState } from '@myrmidon/protocol'
import { BookmarkPlus, Check, KeyRound, MonitorSmartphone, ShieldQuestion, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { send } from '../api.ts'
import { Button, spring } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'

/** What an agent asked to do, as a verb for the card. */
const action = (tool: string) =>
  tool === 'shell'
    ? 'run a command'
    : tool === 'fs_write' || tool === 'fs_edit'
      ? 'change a file'
      : `use ${tool.replace(/^mcp__/, '').replaceAll('_', ' ')}`

/** Tool calls waiting for the person in an "Ask first" project: Approve or Deny each, right in the chat. */
export function ApprovalCards({ colonyId, state }: { colonyId: string; state: ColonyState }) {
  const toast = useToast()
  const [busy, setBusy] = useState<string>()
  const pending = Object.values(state.approvals).filter((a) => !a.decided)
  const decide = async (id: string, approved: boolean) => {
    setBusy(id)
    try {
      await send('POST', `/api/colonies/${colonyId}/approvals/${id}`, { approved })
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <AnimatePresence initial={false}>
      {pending.map((a) => (
        <motion.div
          key={a.id}
          layout
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={spring}
          role="alert"
          className="flex flex-col gap-2.5 rounded-2xl border border-warn/40 bg-warn-soft/40 px-4 py-3"
        >
          <div className="flex items-center gap-2 text-[13.5px]">
            <ShieldQuestion className="size-4 shrink-0 text-warn" />
            <span>
              <span className="font-semibold">{a.agent}</span> wants to {action(a.tool)}
            </span>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-surface px-3 py-2 font-mono text-[12.5px]">
            {a.summary}
          </pre>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === a.id}
              onClick={() => void decide(a.id, false)}
              icon={<X className="size-3.5" />}
            >
              Deny
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy === a.id}
              onClick={() => void decide(a.id, true)}
              icon={<Check className="size-3.5" />}
            >
              Approve
            </Button>
          </div>
        </motion.div>
      ))}
    </AnimatePresence>
  )
}

/**
 * Sign-ins an agent is waiting for: the person opens that agent's browser in the Computer view, takes control,
 * signs in themselves, and hands it back. Agents never see or type the credentials.
 */
export function LoginCards({ state }: { state: ColonyState }) {
  const waiting = Object.values(state.logins).filter((l) => !l.finished)
  return (
    <AnimatePresence initial={false}>
      {waiting.map((l) => (
        <motion.div
          key={l.agent}
          layout
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={spring}
          role="alert"
          className="flex flex-col gap-2.5 rounded-2xl border border-accent/40 bg-accent-soft/40 px-4 py-3"
        >
          <div className="flex items-center gap-2 text-[13.5px]">
            <KeyRound className="size-4 shrink-0 text-accent" />
            <span>
              <span className="font-semibold">{l.agent}</span> needs you to sign in to{' '}
              <span className="font-semibold">{l.site}</span>
            </span>
          </div>
          <p className="text-[12.5px] leading-relaxed text-fg-2">
            {l.reason} Open {l.agent}’s browser, choose Take control, sign in, then Hand back. The agent never
            sees what you type, and the sign-in is kept for later rounds.
          </p>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              icon={<MonitorSmartphone className="size-3.5" />}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('myr:open-view', { detail: { view: 'computer', agent: l.agent } }),
                )
              }
            >
              Open {l.agent}’s browser
            </Button>
          </div>
        </motion.div>
      ))}
    </AnimatePresence>
  )
}

/**
 * Memories an agent proposed this round: the person keeps or discards each. Kept ones reach every later chat
 * (or every chat in the project); Settings → Memory lists and edits them.
 */
export function MemoryCards({ state }: { state: ColonyState }) {
  const toast = useToast()
  const [busy, setBusy] = useState<string>()
  const pending = Object.values(state.memories).filter((m) => m.kept === undefined)
  const decide = async (id: string, keep: boolean) => {
    setBusy(id)
    try {
      await send('POST', `/api/memory/${id}/decide`, { keep })
      if (keep) toast('Kept: later chats start with it', 'success')
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <AnimatePresence initial={false}>
      {pending.map((m) => (
        <motion.div
          key={m.id}
          layout
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={spring}
          className="flex flex-col gap-2.5 rounded-2xl border border-accent/30 bg-accent-soft/40 px-4 py-3"
        >
          <div className="flex items-center gap-2 text-[13.5px]">
            <BookmarkPlus className="size-4 shrink-0 text-accent" />
            <span>
              <span className="font-semibold">{m.agent}</span> wants to remember
              {m.project ? ' for this project' : ' in every chat'}
            </span>
          </div>
          <p className="rounded-lg bg-surface px-3 py-2 text-[13.5px]">
            <span className="mr-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
              {m.kind}
            </span>
            {m.text}
          </p>
          {m.why && <p className="text-[12px] text-muted">Why: {m.why}</p>}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === m.id}
              onClick={() => void decide(m.id, false)}
              icon={<X className="size-3.5" />}
            >
              Discard
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy === m.id}
              onClick={() => void decide(m.id, true)}
              icon={<Check className="size-3.5" />}
            >
              Keep
            </Button>
          </div>
        </motion.div>
      ))}
    </AnimatePresence>
  )
}
