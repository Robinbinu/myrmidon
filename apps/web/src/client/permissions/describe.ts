import type {
  AccessGroup,
  PermissionCall,
  PermissionPreset,
  PermissionRule,
  PermissionScope,
  PermissionSource,
  RuleDecision,
} from '@myrmidon/protocol'
import { Lock, type LucideIcon } from 'lucide-react'
import { copy } from '../copy.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'

const t = copy.permissions

/** One glyph per preset, the same wherever a preset shows: choices, the chat's control, a project's mark. */
export const PRESET_ICONS: Record<PermissionPreset, LucideIcon> = {
  'read-only': Lock,
  ask: FEATURE_ICONS.approvalAsk,
  auto: FEATURE_ICONS.autonomous,
  full: FEATURE_ICONS.fullAccess,
}

export const presetLabel = (preset: PermissionPreset) => t.presets[preset].label

export const scopeLabel = (scope: PermissionScope | 'default') => t.scopes[scope]

/** The tool groups of "who can use what", in the order the matrix lists them, with their glyphs. */
export const ACCESS_INFO: { group: AccessGroup; label: string; hint: string; icon: LucideIcon }[] = [
  { group: 'files', ...t.access.groups.files, icon: FEATURE_ICONS.fileTools },
  { group: 'shell', ...t.access.groups.shell, icon: FEATURE_ICONS.agentShell },
  { group: 'web', ...t.access.groups.web, icon: FEATURE_ICONS.web },
  { group: 'browser', ...t.access.groups.browser, icon: FEATURE_ICONS.computer },
  { group: 'mcp', ...t.access.groups.mcp, icon: FEATURE_ICONS.mcp },
  { group: 'computer', ...t.access.groups.computer, icon: FEATURE_ICONS.computerUse },
  { group: 'messaging', ...t.access.groups.messaging, icon: FEATURE_ICONS.mail },
  { group: 'plugins', ...t.access.groups.plugins, icon: FEATURE_ICONS.plugins },
]

/** A rule's kind as a glyph in the rules table. */
export const RULE_ICONS: Record<PermissionRule['kind'], LucideIcon> = {
  tool: FEATURE_ICONS.tools,
  edit: FEATURE_ICONS.fileTools,
  command: FEATURE_ICONS.agentShell,
  'mcp-server': FEATURE_ICONS.mcp,
  'mcp-tool': FEATURE_ICONS.mcp,
}

/** What a rule names, in words: "every command", `bun test …`, "everything from github". */
export function targetText(rule: Pick<PermissionRule, 'kind' | 'target'>): string {
  const c = t.card.target
  switch (rule.kind) {
    case 'command':
      return rule.target === '*' ? c.everyCommand : c.command(rule.target)
    case 'edit':
      return c.edit
    case 'mcp-server':
      return rule.target === '*' ? c.everyMcp : c.mcpServer(rule.target)
    case 'mcp-tool':
      return c.mcpTool(rule.target)
    case 'tool':
      return c.tool(rule.target)
  }
}

/** Why a call was decided as it was, in one sentence (the approval card's line, the explainer's answer). */
export function sourceText(source: PermissionSource, decision: RuleDecision): string {
  const w = t.why
  switch (source.by) {
    case 'askAll':
      return w.askAll
    case 'read-only':
      return w.readOnly(w.where[source.scope])
    case 'preset':
      return w.preset(presetLabel(source.preset), w.setOn[source.scope], w.presetWhat[decision])
    case 'rule':
      return w.rule(w.where[source.scope], w.ruleDecision[source.rule.decision], targetText(source.rule))
  }
}

/** A tool as the server lists it for rules and the explainer. */
export interface CatalogTool {
  name: string
  description: string
  mcp?: boolean
  readOnly?: boolean
  server?: string
  /** Built-in tools: `read` tools change nothing. */
  tier?: string
}

/** The call an agent would make with a tool, for the explainer: the same shapes the runtime decides. */
export function callFor(tool: CatalogTool, command: string): PermissionCall {
  const name = tool.name
  if (name === 'shell' || name === 'start_server')
    return { tool: name, kind: 'command', command: command.trim() || name, readOnly: false }
  if (name === 'fs_write' || name === 'fs_edit')
    return { tool: name, kind: 'edit', where: 'project', readOnly: false }
  if (name === 'propose') return { tool: name, kind: 'proposal', edits: true, readOnly: false }
  if (name === 'mcp' || tool.mcp)
    return {
      tool: name,
      kind: 'mcp',
      mcp: { server: tool.server ?? '', readOnly: !!tool.readOnly },
      readOnly: !!tool.readOnly,
    }
  const read = tool.tier === 'read'
  if (name.startsWith('web_') || name.startsWith('browser_'))
    return { tool: name, kind: 'web', readOnly: read }
  return { tool: name, kind: read ? 'read' : 'other', readOnly: read }
}
