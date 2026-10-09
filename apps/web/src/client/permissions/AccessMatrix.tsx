import {
  type AccessGroup,
  type AgentRole,
  type PermissionLevel,
  type PermissionLevels,
  type PermissionScope,
  roleAccess,
} from '@myrmidon/protocol'
import { RotateCcw } from 'lucide-react'
import { copy } from '../copy.ts'
import { cn, IconButton, Switch } from '../ui/primitives.tsx'
import { ACCESS_INFO, scopeLabel } from './describe.ts'

const t = copy.permissions.access
const ROLES: { role: AgentRole; label: string; hint: string }[] = [
  { role: 'lead', label: t.lead, hint: t.leadHint },
  { role: 'crew', label: t.crew, hint: t.crewHint },
]

/**
 * Who can use what: tool groups down the side, the lead and its crew across, each a switch showing what holds here and,
 * when another level decides it, which. A switch sets the value at this level; at a project or chat a reset takes it
 * back to the level above. The global level only keeps what is off, since on is the default.
 */
export function AccessMatrix(props: {
  /** The levels as they apply here, this one included. */
  levels: PermissionLevels
  scope: PermissionScope
  onChange(access: PermissionLevel['access']): void
  disabled?: boolean
  /** Tighter rows without each group's line, for a sheet with more below it. */
  compact?: boolean
}) {
  const own = props.levels[props.scope]?.access
  const set = (role: AgentRole, group: AccessGroup, on: boolean | undefined) => {
    const groups = { ...own?.[role] }
    if (on === undefined || (props.scope === 'global' && on)) delete groups[group]
    else groups[group] = on
    const next = { ...own, [role]: groups }
    if (!Object.keys(groups).length) delete next[role]
    props.onChange(next.lead || next.crew ? next : undefined)
  }
  return (
    <div className="overflow-hidden rounded-base border border-line bg-surface">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="px-4 py-2 text-caption font-semibold text-muted">
              <span className="sr-only">{t.title}</span>
            </th>
            {ROLES.map((r) => (
              <th key={r.role} scope="col" className="w-36 px-3 py-2 text-center">
                <span className="block text-body font-semibold text-fg">{r.label}</span>
                <span className="block text-caption font-normal text-muted">{r.hint}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {ACCESS_INFO.map((g) => (
            <tr key={g.group}>
              <th scope="row" className={cn('px-4 font-normal', props.compact ? 'py-1.5' : 'py-2.5')}>
                <span className="flex items-center gap-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-fill text-fg-2">
                    <g.icon className="size-3.5" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-body font-medium text-fg">{g.label}</span>
                    {!props.compact && <span className="block truncate text-small text-muted">{g.hint}</span>}
                  </span>
                </span>
              </th>
              {ROLES.map((r) => {
                const now = roleAccess(props.levels, r.role, g.group)
                const here = own?.[r.role]?.[g.group] !== undefined
                return (
                  <td
                    key={r.role}
                    className={cn('px-3 text-center align-middle', props.compact ? 'py-1.5' : 'py-2.5')}
                  >
                    <div className="flex flex-col items-center gap-0.5">
                      <div className="flex items-center gap-1">
                        <Switch
                          checked={now.on}
                          label={t.toggle(g.label, r.label)}
                          disabled={props.disabled}
                          onChange={(on) => set(r.role, g.group, on)}
                        />
                        {here && props.scope !== 'global' && (
                          <IconButton
                            size="sm"
                            label={t.resetLabel(g.label, r.label)}
                            title={t.reset}
                            disabled={props.disabled}
                            onClick={() => set(r.role, g.group, undefined)}
                          >
                            <RotateCcw className="size-3" />
                          </IconButton>
                        )}
                      </div>
                      {/* On is the default everywhere: only a value some level set says where it comes from. */}
                      {now.scope !== 'default' && (
                        <span
                          className={cn(
                            'text-caption',
                            now.scope === props.scope ? 'text-accent-fg' : 'text-muted',
                          )}
                        >
                          {copy.permissions.from(scopeLabel(now.scope))}
                        </span>
                      )}
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-4 py-2 text-small leading-snug text-muted">{t.leadTip}</p>
    </div>
  )
}
