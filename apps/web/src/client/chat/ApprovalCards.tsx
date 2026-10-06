import type { ColonyState } from '@myrmidon/protocol'
import { Check, ShieldQuestion, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { send } from '../api.ts'
import { Button, spring } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'

/** What an agent asked to do, as a verb for the card. */
const action = (tool: string) =>
  tool === 'shell' ? 'run a command' : tool.startsWith('tool_') ? `use ${tool}` : 'change a file'

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
