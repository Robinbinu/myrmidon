import {
  ACCESS_GROUPS,
  type AgentRole,
  decide,
  type PermissionLevel,
  type RuleDecision,
} from '@myrmidon/protocol'
import { Ban, Check } from 'lucide-react'
import { useId, useState } from 'react'
import type { Project } from '../api.ts'
import { copy } from '../copy.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { cn, Select, TextInput } from '../ui/primitives.tsx'
import { ACCESS_INFO, type CatalogTool, callFor, mcpToolPrefix, sourceText } from './describe.ts'

const t = copy.permissions.explain
const OUTCOME: Record<RuleDecision, { tone: string; icon: typeof Check }> = {
  allow: { tone: 'bg-ok-soft text-ok-ink', icon: Check },
  ask: { tone: 'bg-warn-soft text-warn-ink', icon: FEATURE_ICONS.approvalAsk },
  deny: { tone: 'bg-bad-soft text-bad-ink', icon: Ban },
}

/** A tool's name for people, from the list of names or, for an MCP tool, its own name after the server's. */
function toolName(tool: CatalogTool) {
  if (tool.server) return tool.name.replace(mcpToolPrefix(tool.server), '').replace(/_/g, ' ')
  return t.names[tool.name] ?? tool.name
}

/**
 * The tools as the list shows them: built-in ones under the "who can use what" groups (the crew's own work together
 * last), then each MCP server's.
 */
function toolGroups(tools: readonly CatalogTool[]): { label: string; tools: CatalogTool[] }[] {
  // `mcp` itself (every MCP tool) has no server: it sits with the built-in MCP group.
  const builtIn = tools.filter((x) => !x.server)
  const grouped = new Set(Object.values(ACCESS_GROUPS).flat())
  const groups = ACCESS_INFO.map((g) => ({
    label: g.label,
    tools: builtIn.filter((x) => ACCESS_GROUPS[g.group].includes(x.name)),
  }))
  groups.push({ label: t.otherGroup, tools: builtIn.filter((x) => !grouped.has(x.name)) })
  const servers = [...new Set(tools.flatMap((x) => x.server ?? []))]
  for (const server of servers)
    groups.push({ label: t.mcpGroup(server), tools: tools.filter((x) => x.server === server) })
  return groups.filter((g) => g.tools.length)
}

/**
 * "Check a tool": pick a tool (and for the shell, a command) and where it runs, and see what happens for the lead and
 * for the crew, with the level and rule or preset that decided it. It asks the same engine the agents' calls go
 * through, so what it says is what happens (a chat's own choices aside: see the chat's control).
 */
export function Explainer(props: {
  global: PermissionLevel
  projects: readonly Project[]
  tools: CatalogTool[]
}) {
  const id = useId()
  const [tool, setTool] = useState('shell')
  const [command, setCommand] = useState('git push origin main')
  const [where, setWhere] = useState('')
  const project = props.projects.find((p) => p.id === where)
  const chosen = props.tools.find((x) => x.name === tool) ?? { name: tool, description: '' }
  const call = callFor(chosen, command)
  const levels = { global: props.global, ...(project?.permissions ? { project: project.permissions } : {}) }
  return (
    <div className="rounded-base border border-line bg-surface">
      <div className="grid gap-3 px-4 py-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}tool`} className="text-callout text-muted">
            {t.tool}
          </label>
          <Select id={`${id}tool`} value={tool} onChange={(e) => setTool(e.target.value)}>
            {toolGroups(props.tools).map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.tools.map((x) => (
                  <option key={x.name} value={x.name}>
                    {t.option(toolName(x), x.name)}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}where`} className="text-callout text-muted">
            {t.where}
          </label>
          <Select id={`${id}where`} value={where} onChange={(e) => setWhere(e.target.value)}>
            <option value="">{t.noProject}</option>
            {props.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {t.inProject(p.name)}
              </option>
            ))}
          </Select>
        </div>
        {call.kind === 'command' && (
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label htmlFor={`${id}command`} className="text-callout text-muted">
              {t.command}
            </label>
            <TextInput
              id={`${id}command`}
              value={command}
              placeholder={t.commandPlaceholder}
              onChange={(e) => setCommand(e.target.value)}
              className="font-mono"
            />
          </div>
        )}
      </div>
      <ul aria-live="polite" className="divide-y divide-line border-t border-line">
        {(['lead', 'crew'] as AgentRole[]).map((role) => {
          const verdict = decide(levels, call, { role })
          const outcome = OUTCOME[verdict.decision]
          return (
            <li key={role} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-12 shrink-0 text-body font-medium">
                {role === 'lead' ? copy.permissions.access.lead : copy.permissions.access.crew}
              </span>
              <span
                className={cn(
                  'inline-flex h-[20px] shrink-0 items-center gap-1 rounded-full px-2 text-small font-medium',
                  outcome.tone,
                )}
              >
                <outcome.icon className="size-3" aria-hidden />
                {t.outcome[verdict.decision]}
              </span>
              <span className="min-w-0 text-callout text-fg-2">
                {sourceText(verdict.source, verdict.decision)}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
