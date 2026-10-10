import type { PermissionLevel, PermissionPreset } from '@myrmidon/protocol'
import { type ReactNode, useEffect, useState } from 'react'
import { api, type Project } from '../api.ts'
import { copy } from '../copy.ts'
import { settingRow } from '../settings/Setting.tsx'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { PageHeader, SectionHeader } from '../ui/primitives.tsx'
import { AccessMatrix } from './AccessMatrix.tsx'
import type { CatalogTool } from './describe.ts'
import { Explainer } from './Explainer.tsx'
import { PresetChoice } from './PresetChoice.tsx'
import { RulesEditor } from './RulesEditor.tsx'

const t = copy.permissions

export type GlobalPermissions = PermissionLevel & { preset: PermissionPreset }

/**
 * Settings → Permissions: the default preset every chat starts from, who can use what, the global rules, a check of
 * what happens with any tool, and (from Settings) the folders sandboxed agents may also read. Changes autosave, like
 * the rest of Settings, and reach running chats at once.
 */
export function PermissionsPage(props: {
  permissions: GlobalPermissions
  onChange(next: GlobalPermissions, immediate?: boolean): void
  tools: CatalogTool[]
  servers: string[]
  sandbox: string
  /** The readable-folders section, kept with the rest of Settings' sandbox controls. */
  reads?: ReactNode
  /** Whether computer use is on in Settings; while it is off, no switch here can give it. */
  computerUse: boolean
  onSetUpComputer(): void
}) {
  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => {
    api<{ projects: Project[] }>('/api/projects')
      .then((r) => setProjects(r.projects))
      .catch(() => setProjects([]))
  }, [])
  const level = props.permissions
  return (
    <>
      <PageHeader title={t.page.title}>{t.page.intro}</PageHeader>
      <div {...settingRow('permissions.preset')}>
        <SectionHeader
          className="mb-2"
          icon={<FEATURE_ICONS.permissions className="size-4 text-muted" />}
          title={t.page.presetTitle}
          note={t.page.presetNote}
        />
        <PresetChoice
          value={level.preset}
          fullConfirmed={level.preset === 'full'}
          onChange={(preset) => props.onChange({ ...level, preset: preset ?? 'auto' }, true)}
        />
        <p className="mt-2 text-small text-muted">{t.page.sandbox(props.sandbox)}</p>
      </div>

      <div {...settingRow('permissions.access')}>
        <SectionHeader
          className="mb-2 mt-8"
          icon={<FEATURE_ICONS.roleAccess className="size-4 text-muted" />}
          title={t.access.title}
          note={t.access.note}
        />
        <AccessMatrix
          levels={{ global: level }}
          scope="global"
          {...(props.computerUse ? {} : { computerOff: { onSetUp: props.onSetUpComputer } })}
          onChange={(access) => {
            const { access: _, ...rest } = level
            props.onChange(access ? { ...rest, access } : rest, true)
          }}
        />
      </div>

      <div {...settingRow('permissions.rules')}>
        <SectionHeader
          className="mb-2 mt-8"
          icon={<FEATURE_ICONS.toolRules className="size-4 text-muted" />}
          title={t.rules.title}
          note={t.rules.note}
        />
        <RulesEditor
          rules={level.rules}
          catalog={{ tools: props.tools, servers: props.servers }}
          onChange={(rules) => props.onChange({ ...level, rules }, true)}
        />
      </div>

      <div {...settingRow('permissions.check')}>
        <SectionHeader
          className="mb-2 mt-8"
          icon={<FEATURE_ICONS.permissionCheck className="size-4 text-muted" />}
          title={t.explain.title}
          note={t.explain.note}
        />
        <Explainer global={level} projects={projects} tools={props.tools} />
      </div>

      {props.reads && <div className="mt-8">{props.reads}</div>}
    </>
  )
}
