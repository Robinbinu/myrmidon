import { Lock } from 'lucide-react'
import { useState } from 'react'
import { type Project, send } from '../api.ts'
import { copy } from '../copy.ts'
import { ConfirmButton } from '../ui/ConfirmButton.tsx'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Badge, Button, cn, TextArea } from '../ui/primitives.tsx'
import { Sheet } from '../ui/Sheet.tsx'
import { useToast } from '../ui/Toast.tsx'

export type PermissionMode = 'auto' | 'ask' | 'read-only' | 'full'

const MODES: { value: PermissionMode; label: string; icon: typeof FEATURE_ICONS.autonomous; hint: string }[] =
  [
    {
      value: 'auto',
      label: copy.permissions.modes.auto.label,
      icon: FEATURE_ICONS.autonomous,
      hint: copy.permissions.modes.auto.hint,
    },
    {
      value: 'ask',
      label: copy.permissions.modes.ask.label,
      icon: FEATURE_ICONS.approvalAsk,
      hint: copy.permissions.modes.ask.hint,
    },
    {
      value: 'read-only',
      label: copy.permissions.modes.readOnly.label,
      icon: Lock,
      hint: copy.permissions.modes.readOnly.hint,
    },
    {
      value: 'full',
      label: copy.permissions.modes.full.label,
      icon: FEATURE_ICONS.fullAccess,
      hint: copy.permissions.modes.full.hint,
    },
  ]

/**
 * Whether a new chat in a project with this mode gets full access, as the server decides it: the project is set to it,
 * or the sandbox is off in Settings and the project is not read-only.
 */
export function fullAccessFor(mode: PermissionMode | undefined, sandboxOff: boolean): boolean {
  return mode === 'full' || (sandboxOff && mode !== 'read-only')
}

/** Shown where a chat runs without the sandbox: beside the composer's project and in the run's header. */
export function FullAccessBadge() {
  return (
    <span title={copy.fullAccess.title} className="inline-flex shrink-0">
      <Badge tone="warn">
        <FEATURE_ICONS.fullAccess className="size-3" aria-hidden />
        {copy.fullAccess.badge}
      </Badge>
    </span>
  )
}

/** The small mark shown beside a project's name for its mode; nothing for autonomous. */
export function PermissionMark({ mode }: { mode?: PermissionMode }) {
  if (mode === 'read-only')
    return <Lock className="size-3 shrink-0 text-muted" aria-label={copy.permissions.mark.readOnly} />
  if (mode === 'ask')
    return (
      <FEATURE_ICONS.approvalAsk
        className="size-3 shrink-0 text-warn-ink"
        aria-label={copy.permissions.mark.ask}
      />
    )
  if (mode === 'full')
    return (
      <FEATURE_ICONS.fullAccess
        className="size-3 shrink-0 text-warn-ink"
        aria-label={copy.permissions.mark.full}
      />
    )
  return null
}

/**
 * The ways agents may treat a folder, one to choose; also in the setup assistant's project step, which leaves out
 * Full access (`full`): that is given from the folder's own permissions, with a warning to confirm.
 */
export function PermissionChoices(props: {
  mode: PermissionMode
  onChange(mode: PermissionMode): void
  full?: boolean
}) {
  return (
    <fieldset
      aria-label={copy.permissions.modesLabel}
      className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
    >
      {MODES.filter((m) => props.full || m.value !== 'full').map((m) => (
        <label
          key={m.value}
          className={cn(
            'flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-soft',
            props.mode === m.value ? 'border-accent/50 bg-accent-soft/50' : 'border-line hover:bg-fill',
          )}
        >
          <input
            type="radio"
            name="permission-mode"
            value={m.value}
            checked={props.mode === m.value}
            onChange={() => props.onChange(m.value)}
            className="sr-only"
          />
          <m.icon
            className={cn('mt-0.5 size-4 shrink-0', props.mode === m.value ? 'text-accent-fg' : 'text-muted')}
          />
          <span>
            <span className="block text-reading font-medium">{m.label}</span>
            <span className="block text-callout leading-snug text-muted">{m.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
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
  const [read, setRead] = useState((props.project.permissions?.read ?? []).join('\n'))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const r = await send<{ projects: Project[] }>('PUT', `/api/projects/${props.project.id}/permissions`, {
        mode,
        allow: allow.split('\n'),
        read: read.split('\n'),
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
    <Sheet
      title={copy.permissions.title(props.project.name)}
      onClose={props.onClose}
      size="sm"
      actions={
        // Giving full access takes a second click, with what it means beside it.
        mode === 'full' && props.project.permissions?.mode !== 'full' ? (
          <ConfirmButton
            label={copy.permissions.save}
            confirm={copy.permissions.confirmFull}
            warning={copy.fullAccess.warning}
            disabled={busy}
            onConfirm={() => void save()}
          />
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => void save()}
            icon={<FEATURE_ICONS.permissions className="size-3.5" />}
          >
            {copy.permissions.save}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <PermissionChoices mode={mode} onChange={setMode} full />
        {mode === 'ask' && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="allow-commands" className="text-callout text-muted">
              {copy.permissions.allow.label}
            </label>
            <TextArea
              id="allow-commands"
              value={allow}
              onChange={(e) => setAllow(e.target.value)}
              rows={4}
              placeholder={'bun test\nbun run typecheck\ngit status'}
              className="font-mono"
            />
          </div>
        )}
        {/* Full access reads everything already. */}
        {mode !== 'full' && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="read-folders" className="text-callout text-muted">
              {copy.permissions.read.label}
            </label>
            <TextArea
              id="read-folders"
              value={read}
              onChange={(e) => setRead(e.target.value)}
              rows={2}
              placeholder={copy.permissions.read.placeholder}
              className="font-mono"
            />
            <p className="text-small text-muted">{copy.permissions.read.hint}</p>
          </div>
        )}
        <p className="text-small text-muted">{copy.permissions.appliesFrom}</p>
      </div>
    </Sheet>
  )
}
