/**
 * One permission model for every chat, after Codex's presets and Claude Code's rules: a preset (Read only, Ask, Auto,
 * Full access) and allow / ask / deny rules at three levels (global, project, chat), the nearer level overriding the
 * one above. `decide` is the only place a tool call's fate is worked out; the runtime calls it before every call
 * that may need the person, and the UI calls it to explain a result. Pure: no I/O, no clock.
 * Design: docs/superpowers/specs/2026-10-09-permissions-design.md.
 */

export type PermissionPreset = 'read-only' | 'ask' | 'auto' | 'full'
export const PERMISSION_PRESETS: readonly PermissionPreset[] = ['read-only', 'ask', 'auto', 'full']
/** What a chat with nothing set runs on (Codex's Auto, Claude Code's accept-edits). */
export const DEFAULT_PRESET: PermissionPreset = 'auto'

export type RuleDecision = 'allow' | 'ask' | 'deny'
export const RULE_DECISIONS: readonly RuleDecision[] = ['allow', 'ask', 'deny']

/**
 * What a rule names. `tool`: a built-in, plugin or made tool by name. `edit`: `*`, every file change. `command`: a
 * command prefix (`bun test`), or `*` for every command. `mcp-server`: a server's name, or `*` for every MCP tool.
 * `mcp-tool`: one MCP tool's full name (`mcp__github_create_issue`).
 */
export type RuleKind = 'tool' | 'edit' | 'command' | 'mcp-server' | 'mcp-tool'
export const RULE_KINDS: readonly RuleKind[] = ['tool', 'edit', 'command', 'mcp-server', 'mcp-tool']

/** Who a rule or a tool group applies to: the lead (the agent that speaks for the chat), or its crew. */
export type AgentRole = 'lead' | 'crew'
export type RoleScope = 'all' | AgentRole

export interface PermissionRule {
  readonly kind: RuleKind
  readonly target: string
  readonly decision: RuleDecision
  /** Everyone when absent. */
  readonly who?: RoleScope
}

/** Groups of tools a role may be given or not ("who can use what"). */
export type AccessGroup = 'files' | 'shell' | 'web' | 'browser' | 'mcp' | 'computer' | 'messaging' | 'plugins'
export const ACCESS_GROUPS: Readonly<Record<AccessGroup, readonly string[]>> = {
  files: ['fs_write', 'fs_edit', 'fs_read', 'fs_list', 'grep', 'glob', 'request_read'],
  shell: ['shell', 'run_checks', 'start_server', 'server_logs', 'stop_server', 'create_tool'],
  web: ['web_search', 'web_fetch'],
  browser: [
    'browser_open',
    'request_login',
    'browser_tabs',
    'browser_downloads',
    'browser_extract',
    'browser_network',
    'browser_upload',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_screenshot',
    'browser_console',
    'browser_eval',
  ],
  // `mcp` stands for every tool of the connected MCP servers.
  mcp: ['mcp'],
  // The computer tool and the tools that open and list the apps it works in, which come and go with it.
  computer: ['computer', 'open_app', 'list_apps'],
  messaging: ['message', 'create_group', 'update_group', 'append_note'],
  plugins: ['create_plugin', 'test_plugin', 'propose_plugin'],
}
export const ACCESS_GROUP_ORDER = Object.keys(ACCESS_GROUPS) as AccessGroup[]
/** Groups a hands-on lead gets beside its planning tools when it leads a crew (the crew's build tools). */
export const LEAD_WORK_GROUPS: readonly AccessGroup[] = [
  'files',
  'shell',
  'web',
  'browser',
  'mcp',
  'computer',
]

export type RoleAccess = Partial<Record<AccessGroup, boolean>>

export interface PermissionLevel {
  /** Absent: the level above decides. */
  readonly preset?: PermissionPreset
  readonly rules: readonly PermissionRule[]
  readonly access?: { readonly lead?: RoleAccess; readonly crew?: RoleAccess }
}

export type PermissionScope = 'global' | 'project' | 'chat'

export interface PermissionLevels {
  readonly global: PermissionLevel
  readonly project?: PermissionLevel
  readonly chat?: PermissionLevel
}

/**
 * What a call is, for deciding it. `readOnly`: it changes nothing outside the colony (a round that asks for everything
 * still lets it run). `where`, for a file change: the project, the agent's own scratch or worktree (`private`), or
 * elsewhere on the computer (only reachable with full access). `edits`: a proposal that writes a file.
 */
export interface PermissionCall {
  readonly tool: string
  readonly kind: 'read' | 'colony' | 'web' | 'edit' | 'command' | 'mcp' | 'proposal' | 'other'
  readonly command?: string
  readonly mcp?: { readonly server: string; readonly readOnly: boolean }
  readonly where?: 'project' | 'private' | 'outside'
  readonly edits?: boolean
  readonly readOnly?: boolean
}

/** Why a call got its decision: shown on approval cards and in the explainer. */
export type PermissionSource =
  | { readonly by: 'read-only'; readonly scope: PermissionScope | 'default' }
  | { readonly by: 'askAll' }
  | { readonly by: 'rule'; readonly scope: PermissionScope; readonly rule: PermissionRule }
  | { readonly by: 'preset'; readonly scope: PermissionScope | 'default'; readonly preset: PermissionPreset }

export interface PermissionVerdict {
  readonly decision: RuleDecision
  readonly source: PermissionSource
  /** The preset in effect, whatever decided. */
  readonly preset: PermissionPreset
}

const ORDER: readonly PermissionScope[] = ['chat', 'project', 'global']

function present(levels: PermissionLevels): { scope: PermissionScope; level: PermissionLevel }[] {
  return ORDER.flatMap((scope) => {
    const level = levels[scope]
    return level ? [{ scope, level }] : []
  })
}

/** Every rule of every level, nearest level first. */
export function rulesIn(levels: PermissionLevels): (PermissionRule & { scope: PermissionScope })[] {
  return present(levels).flatMap(({ scope, level }) => level.rules.map((r) => ({ ...r, scope })))
}

/**
 * The preset in effect and the level it comes from: the nearest that sets one, except that a read-only project is a
 * floor no chat can lift (only the project's own permissions change it).
 */
export function effectivePreset(levels: PermissionLevels): {
  preset: PermissionPreset
  scope: PermissionScope | 'default'
} {
  if (levels.project?.preset === 'read-only') return { preset: 'read-only', scope: 'project' }
  for (const { scope, level } of present(levels)) if (level.preset) return { preset: level.preset, scope }
  return { preset: DEFAULT_PRESET, scope: 'default' }
}

const appliesTo = (rule: PermissionRule, role: AgentRole | undefined) =>
  !rule.who || rule.who === 'all' || rule.who === role

/** Whether a rule names this call; `allow` rules match commands only when every part of a plain command does. */
export function ruleMatches(rule: PermissionRule, call: PermissionCall, role?: AgentRole): boolean {
  if (!appliesTo(rule, role)) return false
  switch (rule.kind) {
    case 'tool':
      return rule.target === call.tool
    case 'mcp-tool':
      return call.kind === 'mcp' && rule.target === call.tool
    case 'mcp-server':
      return call.kind === 'mcp' && !!call.mcp && (rule.target === '*' || rule.target === call.mcp.server)
    case 'edit':
      return call.kind === 'edit' || (call.kind === 'proposal' && !!call.edits)
    case 'command': {
      if (call.kind !== 'command') return false
      if (rule.target === '*') return true
      const { segments, simple } = splitCommand(call.command ?? '')
      if (segments.length === 0) return false
      const hit = (s: string) => prefixMatch(s, rule.target)
      return rule.decision === 'allow' ? simple && segments.every(hit) : segments.some(hit)
    }
  }
}

/** Every call is allowed, asked about or denied; this is the one function that says which, and why. */
export function decide(
  levels: PermissionLevels,
  call: PermissionCall,
  options: { askAll?: boolean; role?: AgentRole } = {},
): PermissionVerdict {
  const eff = effectivePreset(levels)
  const verdict = (decision: RuleDecision, source: PermissionSource): PermissionVerdict => ({
    decision,
    source,
    preset: eff.preset,
  })
  if (eff.preset === 'read-only' && call.kind === 'edit' && call.where !== 'private')
    return verdict('deny', { by: 'read-only', scope: eff.scope })
  const order = present(levels)
  for (const { scope, level } of order) {
    const rule = level.rules.find((r) => r.decision === 'deny' && ruleMatches(r, call, options.role))
    if (rule) return verdict('deny', { by: 'rule', scope, rule })
  }
  const quiet =
    call.readOnly ?? (call.kind === 'colony' || (call.kind === 'mcp' && call.mcp?.readOnly === true))
  if (options.askAll && !quiet) return verdict('ask', { by: 'askAll' })
  for (const { scope, level } of order) {
    const ask = level.rules.find((r) => r.decision === 'ask' && ruleMatches(r, call, options.role))
    if (ask) return verdict('ask', { by: 'rule', scope, rule: ask })
    const allow = level.rules.find((r) => r.decision === 'allow' && ruleMatches(r, call, options.role))
    if (allow) return verdict('allow', { by: 'rule', scope, rule: allow })
  }
  return verdict(presetDecision(eff.preset, call), { by: 'preset', scope: eff.scope, preset: eff.preset })
}

/** What a preset does with a call no rule names (the table in the design doc). */
export function presetDecision(preset: PermissionPreset, call: PermissionCall): RuleDecision {
  switch (call.kind) {
    case 'read':
    case 'colony':
    case 'web':
    case 'other':
      return 'allow'
    case 'proposal':
      return 'ask'
    case 'mcp':
      return call.mcp?.readOnly || preset === 'full' ? 'allow' : 'ask'
    case 'edit': {
      if (call.where === 'private' || preset === 'full') return 'allow'
      if (preset === 'read-only') return 'deny'
      if (preset === 'ask') return 'ask'
      return call.where === 'outside' ? 'ask' : 'allow'
    }
    case 'command': {
      const line = call.command ?? ''
      if (preset === 'full' || preset === 'read-only') return 'allow'
      if (preset === 'ask') return readOnlyCommand(line) ? 'allow' : 'ask'
      return destructiveCommand(line) ? 'ask' : 'allow'
    }
  }
}

/**
 * Whether a whole tool is denied to this role (by its name, its MCP server, or every MCP tool): such a tool is left
 * out of the agent's tools altogether, since no level could let it run.
 */
export function toolHidden(
  levels: PermissionLevels,
  tool: string,
  role?: AgentRole,
  server?: string,
): boolean {
  return present(levels).some(({ level }) =>
    level.rules.some(
      (r) =>
        r.decision === 'deny' &&
        appliesTo(r, role) &&
        (((r.kind === 'tool' || r.kind === 'mcp-tool') && r.target === tool) ||
          (r.kind === 'mcp-server' &&
            (r.target === '*'
              ? tool === 'mcp' || tool.startsWith('mcp__')
              : server !== undefined && r.target === server))),
    ),
  )
}

/** Whether a role gets a tool group, and from which level: the nearest that sets it, else on. */
export function roleAccess(
  levels: PermissionLevels,
  role: AgentRole,
  group: AccessGroup,
): { on: boolean; scope: PermissionScope | 'default' } {
  for (const { scope, level } of present(levels)) {
    const on = level.access?.[role]?.[group]
    if (on !== undefined) return { on, scope }
  }
  return { on: true, scope: 'default' }
}

/** The tool groups a role does not get. */
export function groupsOff(levels: PermissionLevels, role: AgentRole): AccessGroup[] {
  return ACCESS_GROUP_ORDER.filter((g) => !roleAccess(levels, role, g).on)
}

// --- Commands -------------------------------------------------------------------------------------------------------

/**
 * A command's parts, split where the shell would run another command (`&&`, `||`, `;`, `|`, `&`, newlines) outside
 * quotes, each with leading variable assignments and wrappers (`timeout 30`, `nice`, `nohup`, `time`, `env`) taken
 * off. `simple`: no substitution or redirection, so rules may match it (as Codex and Claude Code both require).
 */
export function splitCommand(line: string): { segments: string[]; simple: boolean } {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let simple = true
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    const next = line[i + 1]
    if (quote) {
      if (c === quote) quote = undefined
      else if (quote === '"' && (c === '`' || (c === '$' && next === '('))) simple = false
      current += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current += c
      continue
    }
    if (c === '`' || (c === '$' && next === '(') || c === '<' || c === '>') simple = false
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      parts.push(current)
      current = ''
      if ((c === '|' || c === '&') && next === c) i++
      continue
    }
    current += c
  }
  if (quote) simple = false
  parts.push(current)
  const segments = parts.map(normalizeSegment).filter(Boolean)
  return { segments, simple }
}

const WRAPPERS = /^(?:(?:timeout\s+(?:-\S+\s+)*\d+[smhd]?|time|nice(?:\s+-n\s*-?\d+)?|nohup|env)\s+)/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/

function normalizeSegment(segment: string): string {
  let s = segment.trim().replace(/\s+/g, ' ')
  for (let changed = true; changed; ) {
    const before = s
    s = s.replace(ASSIGNMENT, '').replace(WRAPPERS, '')
    changed = s !== before
  }
  return s.trim()
}

function prefixMatch(segment: string, prefix: string): boolean {
  const p = prefix.trim().replace(/\s+/g, ' ')
  return p.length > 0 && (segment === p || segment.startsWith(`${p} `))
}

/** Commands that delete, rewrite history, publish, or reach past the sandbox: Auto asks before these. */
export const DESTRUCTIVE_COMMANDS: readonly RegExp[] = [
  /^rm\s+(?:\S+\s+)*-(?:-recursive|\w*[rR]\w*)\b/,
  /^git\s+push\b/,
  /^git\s+reset\s+(?:\S+\s+)*--hard\b/,
  /^git\s+clean\b/,
  /^git\s+checkout\s+(?:\S+\s+)*--(?:\s|$)/,
  /^git\s+restore\b/,
  /^git\s+branch\s+(?:\S+\s+)*-(?:D|-delete\s+--force)\b/,
  /^git\s+rebase\b/,
  /^git\s+stash\s+(?:drop|clear)\b/,
  /^sudo\b/,
  /^(?:npm|bun|pnpm|yarn)\s+publish\b/,
  /^dd\b/,
  /^mkfs/,
  /^(?:shutdown|reboot|halt)\b/,
  /^kill\s+-9\b/,
  /^killall\b/,
  /^ch(?:mod|own)\s+-R\b/,
  /^find\s.*\s-delete\b/,
]

/** A download piped straight into a shell, anywhere in the line. */
const PIPED_INSTALL = /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/

export function destructiveCommand(line: string): boolean {
  if (PIPED_INSTALL.test(line)) return true
  return splitCommand(line).segments.some((s) => DESTRUCTIVE_COMMANDS.some((re) => re.test(s)))
}

/** Commands that only look (Claude Code's built-in read-only set): Ask runs them without asking. */
const READ_ONLY_PROGRAMS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'echo',
  'which',
  'diff',
  'stat',
  'du',
  'df',
  'grep',
  'rg',
  'tree',
  'file',
  'date',
  'whoami',
  'uname',
])
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files'])
const READ_ONLY_GIT_BRANCH_FLAGS = new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current'])

export function readOnlyCommand(line: string): boolean {
  const { segments, simple } = splitCommand(line)
  if (!simple || segments.length === 0) return false
  return segments.every((s) => {
    const [program, ...args] = s.split(' ')
    if (!program) return false
    if (program === 'find') return !args.some((a) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fls)/.test(a))
    if (program === 'git') {
      const [sub, ...rest] = args
      if (sub === 'branch') return rest.every((a) => READ_ONLY_GIT_BRANCH_FLAGS.has(a))
      return sub !== undefined && READ_ONLY_GIT.has(sub)
    }
    return READ_ONLY_PROGRAMS.has(program)
  })
}

/** Programs whose next word says what they do (`git push`, `bun test`): a remembered prefix keeps it. */
const SUBCOMMANDS = new Set([
  'git',
  'bun',
  'bunx',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'cargo',
  'go',
  'docker',
  'kubectl',
  'gh',
  'make',
  'python',
  'python3',
  'node',
  'deno',
  'uv',
  'pip',
  'brew',
])
/** Their words that run something named next (`bun run build`): the prefix keeps that name too. */
const RUNNERS = new Set(['run', 'exec', 'x', '-m'])

/** The prefix a person would remember for one part of a command: `bun test src/a.test.ts` → `bun test`. */
export function commandPrefix(segment: string): string {
  const words = normalizeSegment(segment).split(' ')
  const [program, sub, name] = words
  if (!program) return ''
  if (!SUBCOMMANDS.has(program) || !sub || (sub.startsWith('-') && sub !== '-m')) return program
  if (RUNNERS.has(sub) && name && !name.startsWith('-')) return `${program} ${sub} ${name}`
  return `${program} ${sub}`
}

/**
 * What an approval card may remember for a call, most specific first: a command's prefixes then every command; an
 * MCP tool then its server; file changes; or the tool itself.
 */
export function offersFor(call: PermissionCall): Omit<PermissionRule, 'decision'>[] {
  switch (call.kind) {
    case 'command': {
      const { segments, simple } = splitCommand(call.command ?? '')
      const prefixes = simple ? [...new Set(segments.map(commandPrefix).filter(Boolean))].slice(0, 3) : []
      return [
        ...prefixes.map((target) => ({ kind: 'command' as const, target })),
        { kind: 'command', target: '*' },
      ]
    }
    case 'mcp':
      return [
        { kind: 'mcp-tool', target: call.tool },
        ...(call.mcp ? [{ kind: 'mcp-server' as const, target: call.mcp.server }] : []),
      ]
    case 'edit':
      return [{ kind: 'edit', target: '*' }]
    case 'proposal':
      return call.edits ? [{ kind: 'edit', target: '*' }] : []
    default:
      return [{ kind: 'tool', target: call.tool }]
  }
}

// --- Editing levels -------------------------------------------------------------------------------------------------

export const sameTarget = (a: Omit<PermissionRule, 'decision'>, b: Omit<PermissionRule, 'decision'>) =>
  a.kind === b.kind && a.target === b.target && (a.who ?? 'all') === (b.who ?? 'all')

/** The level with this rule in it, replacing one for the same target and role. */
export function withRule(level: PermissionLevel, rule: PermissionRule): PermissionLevel {
  return { ...level, rules: [...level.rules.filter((r) => !sameTarget(r, rule)), rule] }
}

export function withoutRule(level: PermissionLevel, rule: Omit<PermissionRule, 'decision'>): PermissionLevel {
  return { ...level, rules: level.rules.filter((r) => !sameTarget(r, rule)) }
}

export const MAX_RULES = 200
const MAX_TARGET = 300

/** A level as stored, from whatever was saved or sent: unknown fields and broken rules are dropped. */
export function normalizeLevel(raw: unknown): PermissionLevel {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const preset = PERMISSION_PRESETS.includes(o.preset as PermissionPreset)
    ? (o.preset as PermissionPreset)
    : undefined
  const rules: PermissionRule[] = []
  for (const r of Array.isArray(o.rules) ? o.rules : []) {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    const target = typeof x.target === 'string' ? x.target.trim().replace(/\s+/g, ' ') : ''
    if (!RULE_KINDS.includes(x.kind as RuleKind) || !RULE_DECISIONS.includes(x.decision as RuleDecision))
      continue
    if (!target || target.length > MAX_TARGET || (x.kind === 'edit' && target !== '*')) continue
    const who = x.who === 'lead' || x.who === 'crew' ? x.who : undefined
    const rule: PermissionRule = {
      kind: x.kind as RuleKind,
      target,
      decision: x.decision as RuleDecision,
      ...(who ? { who } : {}),
    }
    const at = rules.findIndex((k) => sameTarget(k, rule))
    if (at >= 0) rules.splice(at, 1)
    rules.push(rule)
  }
  const access = normalizeAccess(o.access)
  return {
    ...(preset ? { preset } : {}),
    rules: rules.slice(-MAX_RULES),
    ...(access ? { access } : {}),
  }
}

function normalizeAccess(raw: unknown): PermissionLevel['access'] {
  if (!raw || typeof raw !== 'object') return undefined
  const out: { lead?: RoleAccess; crew?: RoleAccess } = {}
  for (const role of ['lead', 'crew'] as const) {
    const given = (raw as Record<string, unknown>)[role]
    if (!given || typeof given !== 'object') continue
    const groups: RoleAccess = {}
    for (const g of ACCESS_GROUP_ORDER) {
      const v = (given as Record<string, unknown>)[g]
      if (typeof v === 'boolean') groups[g] = v
    }
    if (Object.keys(groups).length) out[role] = groups
  }
  return out.lead || out.crew ? out : undefined
}

// --- Migration ------------------------------------------------------------------------------------------------------

/** The old Settings → Tools per-tool rules (`{ tool: allow | ask | off }`) as global rules; `off` is a deny. */
export function rulesFromToolDict(dict: Readonly<Record<string, unknown>>): PermissionRule[] {
  return Object.entries(dict).flatMap(([tool, rule]): PermissionRule[] => {
    const decision = rule === 'off' ? 'deny' : rule === 'ask' || rule === 'allow' ? rule : undefined
    if (!decision || !tool.trim()) return []
    if (tool === 'mcp') return [{ kind: 'mcp-server', target: '*', decision }]
    return [{ kind: tool.startsWith('mcp__') ? 'mcp-tool' : 'tool', target: tool, decision }]
  })
}

/**
 * A project's permissions in the old shape (`{ mode, allow, read }`) or the new one, as a project level. Old `auto`
 * meant "whatever the global sandbox allows", so it becomes "use global"; the allowed prefixes become command rules.
 */
export function projectLevelFrom(raw: unknown): PermissionLevel & { read?: string[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const read = Array.isArray(o.read) ? o.read.filter((f): f is string => typeof f === 'string') : []
  const extra = read.length ? { read } : {}
  if (Array.isArray(o.rules)) return { ...normalizeLevel(o), ...extra }
  const mode = o.mode
  const preset = mode === 'ask' || mode === 'read-only' || mode === 'full' ? mode : undefined
  const allow = Array.isArray(o.allow) ? o.allow.filter((a): a is string => typeof a === 'string') : []
  return {
    ...normalizeLevel({
      ...(preset ? { preset } : {}),
      rules: allow.map((target) => ({ kind: 'command', target, decision: 'allow' })),
    }),
    ...extra,
  }
}

/** A chat's old grants from approval cards ("allow all file changes / commands in this chat") as chat rules. */
export function rulesFromGrants(grants: readonly string[]): PermissionRule[] {
  return grants.flatMap((g): PermissionRule[] =>
    g === 'file'
      ? [{ kind: 'edit', target: '*', decision: 'allow' }]
      : g === 'command'
        ? [{ kind: 'command', target: '*', decision: 'allow' }]
        : [],
  )
}

// --- Changes --------------------------------------------------------------------------------------------------------

const STRICTNESS: Record<PermissionPreset, number> = { full: 0, auto: 1, ask: 2, 'read-only': 3 }

/**
 * What got stricter between two sets of levels, for the agents told why their step stopped: rules that now deny or
 * ask (by target), tool groups taken from a role, and the preset when it tightened.
 */
export function tightened(
  before: PermissionLevels,
  after: PermissionLevels,
): { denied: string[]; asked: string[]; groups: AccessGroup[]; preset?: PermissionPreset } {
  const rules = (levels: PermissionLevels, decision: RuleDecision) =>
    new Set(
      present(levels).flatMap(({ level }) =>
        level.rules
          .filter((r) => r.decision === decision)
          .map((r) => `${r.kind}:${r.target}:${r.who ?? 'all'}`),
      ),
    )
  const added = (decision: RuleDecision) => {
    const was = rules(before, decision)
    return [...rules(after, decision)].filter((k) => !was.has(k)).map((k) => k.split(':')[1] as string)
  }
  const groups = ACCESS_GROUP_ORDER.filter((g) =>
    (['lead', 'crew'] as const).some(
      (role) => roleAccess(before, role, g).on && !roleAccess(after, role, g).on,
    ),
  )
  const a = effectivePreset(after).preset
  const stricter = STRICTNESS[a] > STRICTNESS[effectivePreset(before).preset]
  return { denied: added('deny'), asked: added('ask'), groups, ...(stricter ? { preset: a } : {}) }
}

// --- What agents were told ------------------------------------------------------------------------------------------

/**
 * What a round's agents may do, as they were last told it: logged when a round starts and when the person changes
 * permissions mid-round, so the next change can be told as a change. `preset` is absent only in logs from before this
 * was kept, which knew nothing but full access.
 */
export interface RoundAccess {
  readonly preset?: PermissionPreset
  readonly fullAccess?: boolean
  /** The folders beyond the defaults sandboxed agents may read (Settings, the project, the chat's grants). */
  readonly reads?: readonly string[]
  /** Every level's rules, nearest level first. */
  readonly rules?: readonly PermissionRule[]
  /** The tool groups each role does not get. */
  readonly off?: { readonly lead?: readonly AccessGroup[]; readonly crew?: readonly AccessGroup[] }
}

export function accessOf(
  levels: PermissionLevels,
  fullAccess: boolean,
  reads: readonly string[],
): RoundAccess {
  const rules = rulesIn(levels).map(({ scope: _, ...rule }) => rule)
  const lead = groupsOff(levels, 'lead')
  const crew = groupsOff(levels, 'crew')
  return {
    preset: effectivePreset(levels).preset,
    ...(fullAccess ? { fullAccess: true } : {}),
    ...(reads.length ? { reads: [...new Set(reads)].sort() } : {}),
    ...(rules.length ? { rules } : {}),
    ...(lead.length || crew.length
      ? { off: { ...(lead.length ? { lead } : {}), ...(crew.length ? { crew } : {}) } }
      : {}),
  }
}

/** What changed for one role between what it was told and what holds now; rules by target. */
export interface AccessChange {
  readonly preset?: { readonly from: PermissionPreset; readonly to: PermissionPreset }
  readonly fullAccess?: boolean
  readonly opened: readonly string[]
  readonly closed: readonly string[]
  readonly allowed: readonly string[]
  readonly asked: readonly string[]
  readonly denied: readonly string[]
  /** Targets no rule covers any more. */
  readonly dropped: readonly string[]
  readonly groupsOn: readonly AccessGroup[]
  readonly groupsOff: readonly AccessGroup[]
}

/**
 * The change `role` should be told about, or none when nothing it may do changed. Against a log from before this was
 * kept (no preset), only full access can be compared.
 */
export function accessChange(
  before: RoundAccess,
  after: RoundAccess,
  role: AgentRole,
): AccessChange | undefined {
  const known = before.preset !== undefined
  // The nearest rule for a target is the one that holds, as in `decide`.
  const rules = (a: RoundAccess) => {
    const out = new Map<string, { target: string; decision: RuleDecision }>()
    for (const r of known ? (a.rules ?? []) : [])
      if (appliesTo(r, role) && !out.has(`${r.kind}:${r.target}`))
        out.set(`${r.kind}:${r.target}`, { target: r.target, decision: r.decision })
    return out
  }
  const was = rules(before)
  const now = rules(after)
  const to = (decision: RuleDecision) =>
    [...now.entries()]
      .filter(([k, r]) => r.decision === decision && was.get(k)?.decision !== decision)
      .map(([, r]) => r.target)
  const minus = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined) =>
    known ? (a ?? []).filter((x) => !(b ?? []).includes(x)) : []
  const change: AccessChange = {
    ...(known && after.preset && after.preset !== before.preset
      ? { preset: { from: before.preset, to: after.preset } }
      : {}),
    ...(!!after.fullAccess !== !!before.fullAccess ? { fullAccess: !!after.fullAccess } : {}),
    opened: minus(after.reads, before.reads),
    closed: minus(before.reads, after.reads),
    allowed: to('allow'),
    asked: to('ask'),
    denied: to('deny'),
    dropped: [...was.entries()].filter(([k]) => !now.has(k)).map(([, r]) => r.target),
    groupsOn: minus(before.off?.[role], after.off?.[role]),
    groupsOff: minus(after.off?.[role], before.off?.[role]),
  }
  const { preset, fullAccess, ...lists } = change
  return preset || fullAccess !== undefined || Object.values(lists).some((l) => l.length) ? change : undefined
}

/** Whether a change lets the agent do something it could not before (so what it declined may work now). */
export function accessLoosened(c: AccessChange): boolean {
  return (
    c.fullAccess === true ||
    (!!c.preset?.from && STRICTNESS[c.preset.to] < STRICTNESS[c.preset.from]) ||
    c.opened.length > 0 ||
    c.allowed.length > 0 ||
    c.groupsOn.length > 0
  )
}
