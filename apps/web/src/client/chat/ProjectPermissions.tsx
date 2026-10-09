import {
  DEFAULT_PRESET,
  effectivePreset,
  type PermissionLevel,
  type PermissionPreset,
  type ProjectPermissions as ProjectLevel,
} from '@myrmidon/protocol'
import { useEffect, useState } from 'react'
import { api, type Project, send } from '../api.ts'
import { copy } from '../copy.ts'
import { AccessMatrix } from '../permissions/AccessMatrix.tsx'
import { type CatalogTool, PRESET_ICONS, presetLabel } from '../permissions/describe.ts'
import { PresetChoice } from '../permissions/PresetChoice.tsx'
import { RulesEditor } from '../permissions/RulesEditor.tsx'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Badge, Button, SectionHeader, TextArea } from '../ui/primitives.tsx'
import { Sheet } from '../ui/Sheet.tsx'
import { useToast } from '../ui/Toast.tsx'

const t = copy.permissions

/** The preset a project's chats start on: its own, or the global one. */
export function presetFor(project: Pick<Project, 'permissions'> | undefined, global: PermissionPreset) {
  return effectivePreset({
    global: { preset: global, rules: [] },
    ...(project?.permissions ? { project: project.permissions } : {}),
  }).preset
}

/** Shown where a chat runs without the sandbox: in the run's header. */
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

/** The small mark beside a project's name for its own preset; nothing when it uses the global one or is Auto. */
export function PermissionMark({ preset }: { preset?: PermissionPreset | undefined }) {
  if (!preset || preset === 'auto') return null
  const Icon = PRESET_ICONS[preset]
  const label = preset === 'read-only' ? t.mark.readOnly : preset === 'ask' ? t.mark.ask : t.mark.full
  return (
    <Icon
      className={preset === 'read-only' ? 'size-3 shrink-0 text-muted' : 'size-3 shrink-0 text-warn-ink'}
      aria-label={label}
    />
  )
}

/**
 * The choices for a project folder in the setup assistant: "use global" or a preset of its own, without Full access
 * (that is given from the folder's own permissions, with a warning to confirm).
 */
export function PermissionChoices(props: {
  value: PermissionPreset | undefined
  global: PermissionPreset
  onChange(preset: PermissionPreset | undefined): void
}) {
  return (
    <PresetChoice
      value={props.value}
      onChange={props.onChange}
      inherit={{ label: t.inherit.global(presetLabel(props.global)), preset: props.global }}
      presets={['read-only', 'ask', 'auto']}
    />
  )
}

/**
 * A project's level of the permission model: its preset ("Use global" first), who can use what, its rules, and the
 * folders its chats' agents may also read. Applies at once to its running chats, and to every later one.
 */
export function ProjectPermissions(props: {
  project: Project
  onClose(): void
  onSaved(projects: Project[]): void
}) {
  const toast = useToast()
  const saved = props.project.permissions ?? { rules: [] }
  const [level, setLevel] = useState<PermissionLevel>(() => {
    const { read: _, ...own } = saved
    return own
  })
  const [read, setRead] = useState((saved.read ?? []).join('\n'))
  const [busy, setBusy] = useState(false)
  const [global, setGlobal] = useState<PermissionLevel & { preset: PermissionPreset }>()
  const [catalog, setCatalog] = useState<{ tools: CatalogTool[]; servers: string[] }>()
  useEffect(() => {
    api<{
      settings: { permissions: PermissionLevel & { preset: PermissionPreset } }
      toolCatalog: CatalogTool[]
      mcpServers?: string[]
    }>('/api/settings')
      .then((r) => {
        setGlobal(r.settings.permissions)
        setCatalog({ tools: r.toolCatalog, servers: r.mcpServers ?? [] })
      })
      .catch(() => {})
  }, [])
  const globalPreset = global?.preset ?? DEFAULT_PRESET
  const save = async () => {
    setBusy(true)
    try {
      const body: ProjectLevel = {
        ...level,
        read: read
          .split('\n')
          .map((f) => f.trim())
          .filter(Boolean),
      }
      const r = await send<{ projects: Project[] }>('PUT', `/api/projects/${props.project.id}/permissions`, {
        ...body,
        preset: level.preset ?? null,
      })
      props.onSaved(r.projects)
      toast(`${props.project.name}: ${presetLabel(level.preset ?? globalPreset)}`, 'success')
      props.onClose()
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }
  const levels = { global: global ?? { preset: globalPreset, rules: [] }, project: level }
  return (
    <Sheet
      title={t.title(props.project.name)}
      onClose={props.onClose}
      size="md"
      actions={
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => void save()}
          icon={<FEATURE_ICONS.permissions className="size-3.5" />}
        >
          {t.save}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <PresetChoice
          value={level.preset}
          fullConfirmed={saved.preset === 'full'}
          inherit={{ label: t.inherit.global(presetLabel(globalPreset)), preset: globalPreset }}
          onChange={(preset) => {
            const { preset: _, ...rest } = level
            setLevel(preset ? { ...rest, preset } : rest)
          }}
        />
        <SectionHeader
          className="mt-4"
          icon={<FEATURE_ICONS.roleAccess className="size-4 text-muted" />}
          title={t.access.title}
          note={t.access.note}
        />
        <AccessMatrix
          compact
          levels={levels}
          scope="project"
          onChange={(access) => {
            const { access: _, ...rest } = level
            setLevel(access ? { ...rest, access } : rest)
          }}
        />
        <SectionHeader
          className="mt-4"
          icon={<FEATURE_ICONS.toolRules className="size-4 text-muted" />}
          title={t.rules.title}
          note={t.rules.note}
        />
        <RulesEditor
          rules={level.rules}
          {...(catalog ? { catalog } : {})}
          onChange={(rules) => setLevel({ ...level, rules })}
        />
        {/* Full access reads everything already. */}
        {effectivePreset(levels).preset !== 'full' && (
          <div className="mt-4 flex flex-col gap-1.5">
            <label htmlFor="read-folders" className="text-callout text-muted">
              {t.read.label}
            </label>
            <TextArea
              id="read-folders"
              value={read}
              onChange={(e) => setRead(e.target.value)}
              rows={2}
              placeholder={t.read.placeholder}
              className="font-mono"
            />
            <p className="text-small text-muted">{t.read.hint}</p>
          </div>
        )}
        <p className="text-small text-muted">{t.appliesFrom}</p>
      </div>
    </Sheet>
  )
}
