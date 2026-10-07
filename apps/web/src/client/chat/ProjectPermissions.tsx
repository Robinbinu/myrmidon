import { Lock, ShieldCheck, ShieldQuestion, Zap } from 'lucide-react'
import { useState } from 'react'
import { type Project, send } from '../api.ts'
import { Modal } from '../ui/Modal.tsx'
import { Button, cn, TextArea } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'

export type PermissionMode = 'auto' | 'ask' | 'read-only'

const MODES: { value: PermissionMode; label: string; icon: typeof Zap; hint: string }[] = [
  {
    value: 'auto',
    label: 'Autonomous',
    icon: Zap,
    hint: 'Agents edit files and run commands in the sandbox without asking. Every round is checkpointed, so you can rewind it.',
  },
  {
    value: 'ask',
    label: 'Ask first',
    icon: ShieldQuestion,
    hint: 'Each change to a project file and each shell command waits for your Approve in the chat, except the commands you allow below.',
  },
  {
    value: 'read-only',
    label: 'Read-only',
    icon: Lock,
    hint: 'Agents read and analyse the project but cannot change it; the sandbox keeps the folder untouched. They propose changes instead.',
  },
]

/** The small mark shown beside a project's name for its mode; nothing for autonomous. */
export function PermissionMark({ mode }: { mode?: PermissionMode }) {
  if (mode === 'read-only')
    return <Lock className="size-3 shrink-0 text-muted" aria-label="Read-only for agents" />
  if (mode === 'ask')
    return <ShieldQuestion className="size-3 shrink-0 text-warn" aria-label="Agents ask before changes" />
  return null
}

/** How freely agents may change one project folder; applies from each chat's next message. */
export function ProjectPermissions(props: {
  project: Project
  onClose(): void
  onSaved(projects: Project[]): void
}) {
  const toast = useToast()
  const [mode, setMode] = useState<PermissionMode>(props.project.permissions?.mode ?? 'auto')
  const [allow, setAllow] = useState((props.project.permissions?.allow ?? []).join('\n'))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const r = await send<{ projects: Project[] }>('PUT', `/api/projects/${props.project.id}/permissions`, {
        mode,
        allow: allow.split('\n'),
      })
      props.onSaved(r.projects)
      toast(`${props.project.name}: ${MODES.find((m) => m.value === mode)?.label}`, 'success')
      props.onClose()
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={`Permissions · ${props.project.name}`}
      onClose={props.onClose}
      size="sm"
      actions={
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => void save()}
          icon={<ShieldCheck className="size-3.5" />}
        >
          Save
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <fieldset aria-label="What agents may do" className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          {MODES.map((m) => (
            <label
              key={m.value}
              className={cn(
                'flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-soft',
                mode === m.value ? 'border-accent/50 bg-accent-soft/50' : 'border-line hover:bg-surface-2',
              )}
            >
              <input
                type="radio"
                name="permission-mode"
                value={m.value}
                checked={mode === m.value}
                onChange={() => setMode(m.value)}
                className="sr-only"
              />
              <m.icon
                className={cn('mt-0.5 size-4 shrink-0', mode === m.value ? 'text-accent-fg' : 'text-muted')}
              />
              <span>
                <span className="block text-[13.5px] font-medium">{m.label}</span>
                <span className="block text-[12.5px] leading-snug text-muted">{m.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode === 'ask' && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="allow-commands" className="text-[12.5px] text-muted">
              Commands that run without asking, one prefix per line (chained or piped commands always ask)
            </label>
            <TextArea
              id="allow-commands"
              value={allow}
              onChange={(e) => setAllow(e.target.value)}
              rows={4}
              placeholder={'bun test\nbun run typecheck\ngit status'}
              className="font-mono text-[12.5px]"
            />
          </div>
        )}
        <p className="text-[12px] text-muted">Applies from each chat’s next message in this project.</p>
      </div>
    </Modal>
  )
}
