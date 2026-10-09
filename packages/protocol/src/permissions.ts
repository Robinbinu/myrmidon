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
  computer: ['computer'],
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

/** Whether a rule names this call; for commands, see `commandRuleMatches`. */
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
    case 'command':
      return call.kind === 'command' && commandRuleMatches(rule, call.command ?? '')
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
  const readOnly = eff.preset === 'read-only'
  if (readOnly && call.kind === 'edit' && call.where !== 'private')
    return verdict('deny', { by: 'read-only', scope: eff.scope })
  const order = present(levels)
  for (const { scope, level } of order) {
    const rule = level.rules.find((r) => r.decision === 'deny' && ruleMatches(r, call, options.role))
    if (rule) return verdict('deny', { by: 'rule', scope, rule })
  }
  // A proposed file is the one way into a read-only project (the agents' prompt says so), and only through the
  // person's card: no rule or preset writes it unseen.
  if (readOnly && call.kind === 'proposal' && call.edits)
    return verdict('ask', { by: 'read-only', scope: eff.scope })
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

/** One command's words as the shell passes them on: quotes and backslashes resolved. */
type Words = readonly string[]

/**
 * One command of a line. `text`: its words with leading assignments and plain wrappers (`timeout 30`, `env A=1`)
 * taken off, which allow rules, Ask's read-only check and the card's offers read. `views`: `text` and what it runs
 * once wrappers that change who runs it (`sudo`, `xargs`), a program's path and case, and git's global options are
 * taken off too, which deny and ask rules and the destructive check read, so `sudo /usr/bin/git -C . push` is still
 * `git push` to a deny rule.
 */
interface Segment {
  readonly words: Words
  readonly text: string
  readonly views: readonly string[]
}

/** How deep `sh -c '…'`, `eval` and `env -S` strings inside a command are read before giving up on them. */
const MAX_NESTING = 4

/**
 * A line's commands, read as /bin/sh would: quotes, backslashes, `$(…)`, backticks and subshells (whose commands are
 * read too), split where the shell would run another command (`&&`, `||`, `;`, `|`, `&`, newlines). `simple`: nothing
 * in it is substituted, redirected, run as a string, or left unbalanced, so rules may match it (as Codex and Claude
 * Code both require); anything this cannot read for sure is not simple.
 */
function scan(line: string): { commands: Words[]; simple: boolean } {
  const commands: Words[] = []
  let simple = true
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | undefined
  // Open substitutions and subshells, each with what was being read outside it.
  const outer: {
    close: ')' | '`'
    sub: boolean
    words: string[]
    word: string
    inWord: boolean
    quote: '"' | "'" | undefined
  }[] = []
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  const open = (close: ')' | '`', sub: boolean) => {
    simple = false
    outer.push({ close, sub, words, word, inWord, quote })
    words = []
    word = ''
    inWord = false
    quote = undefined
  }
  const close = () => {
    endCommand()
    const o = outer.pop()
    if (!o) return
    words = o.words
    // A substitution's output is part of a word whose value is only known when it runs.
    word = o.sub ? `${o.word}$()` : o.word
    inWord = o.inWord || o.sub
    quote = o.quote
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    const next = line[i + 1]
    if (quote === "'") {
      if (c === "'") quote = undefined
      else word += c
      continue
    }
    if (c === '\\') {
      if (next === undefined) {
        simple = false
        continue
      }
      i++
      if (next === '\n') continue
      // Inside double quotes a backslash escapes only these; before anything else it stays.
      if (quote === '"' && !'$`"\\'.includes(next)) word += c
      word += next
      inWord = true
      continue
    }
    if (c === '`') {
      if (outer.at(-1)?.close === '`') close()
      else open('`', true)
      continue
    }
    if (c === '$' && next === '(') {
      i++
      open(')', true)
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = undefined
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      inWord = true
      continue
    }
    if (c === '(') {
      open(')', false)
      continue
    }
    if (c === ')') {
      if (outer.at(-1)?.close === ')') close()
      else {
        simple = false
        endCommand()
      }
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord()
      continue
    }
    if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      simple = false
      // `2>&1`: the digits right before the operator name a file descriptor, not an argument.
      if (/^\d+$/.test(word) && inWord) {
        word = ''
        inWord = false
      } else endWord()
      // The rest of the operator (`>>`, `>&`, `&>`, `<<<`, `>|`); a heredoc's lines are then read as commands, which
      // can only make a rule match more often (ask, deny), never allow more.
      while ('<>&|'.includes(line[i + 1] ?? ' ')) i++
      if (line[i + 1] === '-' && line[i] === '<') i++
      continue
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      endCommand()
      if ((c === '|' || c === '&' || c === ';') && next === c) i++
      else if (c === '|' && next === '&') i++
      continue
    }
    word += c
    inWord = true
  }
  if (quote || outer.length) simple = false
  while (outer.length) close()
  endCommand()
  return { commands, simple }
}

/** Shell words that start or end a compound command rather than name a program. */
const RESERVED = new Set([
  '{',
  '}',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'for',
  'case',
  'esac',
  'select',
  'function',
])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Leaves `words` after its leading options: `withArg` options take the next word unless written `--opt=value`. */
function afterOptions(words: Words, withArg: ReadonlySet<string>): Words {
  let i = 0
  while (i < words.length) {
    const w = words[i] as string
    if (w === '--') return words.slice(i + 1)
    if (!w.startsWith('-') || w === '-') break
    i += withArg.has(w) ? 2 : 1
  }
  return words.slice(i)
}

const TIMEOUT_ARGS = new Set(['-s', '--signal', '-k', '--kill-after'])
const NICE_ARGS = new Set(['-n', '--adjustment'])
const ENV_ARGS = new Set(['-u', '--unset', '-C', '--chdir'])
const EXEC_ARGS = new Set(['-a'])
const SUDO_ARGS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U', '--user', '--group'])
const DOAS_ARGS = new Set(['-u', '-C'])
const XARGS_ARGS = new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--arg-file', '--delimiter'])
const GIT_ARGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix',
])

/**
 * `words` without one wrapper in front that runs the rest as it is: an assignment, `timeout 30`, `time`, `nice`,
 * `nohup`, `env` (without `-S`), `command`, `builtin`, `exec`. With `deep`, also those that change who runs it or
 * feed it arguments (`sudo`, `doas`, `xargs`). Undefined when there is none to take off.
 */
function unwrap(words: Words, deep: boolean): Words | undefined {
  const [w, ...rest] = words
  if (w === undefined) return undefined
  if (ASSIGNMENT.test(w)) return rest
  switch (w) {
    case 'time':
    case 'nohup':
    case 'builtin':
    case 'noglob':
    case 'nocorrect':
      return afterOptions(rest, new Set())
    case 'nice':
      return afterOptions(rest, NICE_ARGS)
    case 'exec':
      return afterOptions(rest, EXEC_ARGS)
    case 'timeout': {
      const [, ...after] = afterOptions(rest, TIMEOUT_ARGS)
      return after.length ? after : undefined
    }
    case 'command':
      // `command -v rm` looks rm up; it runs nothing.
      return rest[0] === '-v' || rest[0] === '-V' ? undefined : afterOptions(rest, new Set())
    case 'env': {
      // `env -S 'rm -rf x'` runs a string: read as a nested command instead (see nestedLine).
      if (rest.some((a) => a === '-S' || a.startsWith('--split-string'))) return undefined
      const after = afterOptions(rest, ENV_ARGS)
      let i = 0
      while (i < after.length && ASSIGNMENT.test(after[i] as string)) i++
      return after.slice(i)
    }
  }
  if (!deep) return undefined
  switch (w) {
    case 'sudo':
      return afterOptions(rest, SUDO_ARGS)
    case 'doas':
      return afterOptions(rest, DOAS_ARGS)
    case 'xargs': {
      const after = afterOptions(rest, XARGS_ARGS)
      return after.length ? after : ['echo']
    }
  }
  return undefined
}

/** `words` with the program named as found on the PATH (`/bin/rm`, `RM` → `rm`), and git's global options dropped. */
function canonical(words: Words): Words | undefined {
  const [program, ...rest] = words
  if (program === undefined) return undefined
  const name = (program.split('/').at(-1) ?? program).toLowerCase()
  if (name && name !== program) return [name, ...rest]
  if (program === 'git' && rest[0]?.startsWith('-')) return ['git', ...afterOptions(rest, GIT_ARGS)]
  return undefined
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])

/** A command line a command runs as a string: `sh -c '…'`, `eval …`, `env -S '…'`. */
function nestedLine(words: Words): string | undefined {
  const [program, ...rest] = words
  if (program === undefined) return undefined
  if (program === 'eval') return rest.join(' ')
  if (SHELLS.has(program)) {
    const flag = rest.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
    return flag >= 0 ? rest.slice(flag + 1).find((a) => !a.startsWith('-')) : undefined
  }
  if (program === 'env') {
    const at = rest.findIndex((a) => a === '-S' || a.startsWith('--split-string'))
    if (at < 0) return undefined
    const flag = rest[at] as string
    return flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : rest[at + 1]
  }
  return undefined
}

/** The command `find … -exec CMD … ;` runs for each file. */
function findExec(words: Words): Words | undefined {
  if (words[0] !== 'find') return undefined
  const at = words.findIndex((w) => /^-(?:exec|execdir|ok|okdir)$/.test(w))
  if (at < 0) return undefined
  const after = words.slice(at + 1)
  const end = after.findIndex((w) => w === ';' || w === '+')
  return end < 0 ? after : after.slice(0, end)
}

/** A word as the shell would need it written to read it back as one word. */
const quoteWord = (w: string) => (/^[^\s;&|<>()$`"'\\]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`)
const join = (words: Words) => words.map(quoteWord).join(' ')

/** A line's commands with their texts and views (see Segment), and whether it is simple (see scan). */
function parseCommand(line: string, depth = 0): { segments: Segment[]; simple: boolean } {
  const { commands, simple: plain } = scan(line)
  let simple = plain
  const segments: Segment[] = []
  const seen = new Set<string>()
  const add = (raw: Words) => {
    let words = raw
    // Words that open control flow (`if`, `do`, `{`, `!`) are not the program; a line using them is not simple.
    while (words.length && RESERVED.has(words[0] as string)) {
      simple = false
      words = words.slice(1)
    }
    for (let w = unwrap(words, false); w; w = unwrap(words, false)) words = w
    if (!words.length) return
    // The program is known only when the line runs.
    if ((words[0] as string).includes('$')) simple = false
    const views: Words[] = [words]
    for (let n = 0, v: Words | undefined = words; n < 16; n++) {
      v = unwrap(v, true) ?? canonical(v)
      if (!v?.length) break
      views.push(v)
    }
    segments.push({ words, text: join(words), views: [...new Set(views.map(join))] })
    for (const v of views) {
      const nested = nestedLine(v)
      if (nested !== undefined && !seen.has(`sh:${nested}`)) {
        seen.add(`sh:${nested}`)
        simple = false
        if (depth < MAX_NESTING) segments.push(...parseCommand(nested, depth + 1).segments)
      }
      const each = findExec(v)
      if (each?.length && !seen.has(`find:${join(each)}`)) {
        seen.add(`find:${join(each)}`)
        add(each)
      }
    }
  }
  for (const words of commands) add(words)
  return { segments, simple }
}

/**
 * A command's parts, split where the shell would run another command (see `scan`), each with leading variable
 * assignments and plain wrappers (`timeout 30`, `nice`, `nohup`, `time`, `env`) taken off and its quoting resolved.
 * `simple`: no substitution, redirection, string run as a command, or anything this could not read for sure, so rules
 * may match it.
 */
export function splitCommand(line: string): { segments: string[]; simple: boolean } {
  const { segments, simple } = parseCommand(line)
  return { segments: segments.map((s) => s.text), simple }
}

/** A rule's command prefix written the way segments are, so `git "push"` in a rule is `git push`. */
function targetText(target: string): string {
  return parseCommand(target).segments[0]?.text ?? target.trim().replace(/\s+/g, ' ')
}

function prefixMatch(segment: string, prefix: string): boolean {
  return prefix.length > 0 && (segment === prefix || segment.startsWith(`${prefix} `))
}

/** Commands that delete, rewrite history, publish, or reach past the sandbox: Auto asks before these. */
export const DESTRUCTIVE_COMMANDS: readonly RegExp[] = [
  /^rm\s+(?:\S+\s+)*-(?:-recursive|\w*[rR]\w*)\b/,
  /^git\s+push\b/,
  /^git\s+reset\s+(?:\S+\s+)*--hard\b/,
  /^git\s+clean\b/,
  /^git\s+checkout\s+(?:\S+\s+)*(?:--|\.|-f|--force)(?:\s|$)/,
  /^git\s+switch\s+(?:\S+\s+)*(?:-f|--force|--discard-changes)(?:\s|$)/,
  /^git\s+restore\b/,
  /^git\s+branch\s+(?:\S+\s+)*(?:-[a-zA-Z]*[dD]|--delete)(?:\s|$)/,
  /^git\s+rebase\b/,
  /^git\s+stash\s+(?:drop|clear)\b/,
  /^(?:sudo|doas|su)\b/,
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

const destructiveSegment = (s: Segment) => s.views.some((v) => DESTRUCTIVE_COMMANDS.some((re) => re.test(v)))

/** The program a view runs, by its first word. */
const programOf = (view: string) => view.split(' ')[0] ?? ''

/** Whether the line downloads something and hands it to a shell (`curl … | sh`, `wget -O- … | /bin/bash`). */
function pipedInstall(line: string, segments: readonly Segment[]): boolean {
  if (PIPED_INSTALL.test(line)) return true
  const runs = (names: (p: string) => boolean) =>
    segments.some((s) => s.views.some((v) => names(programOf(v))))
  return runs((p) => p === 'curl' || p === 'wget') && runs((p) => SHELLS.has(p))
}

export function destructiveCommand(line: string): boolean {
  const { segments } = parseCommand(line)
  return pipedInstall(line, segments) || segments.some(destructiveSegment)
}

/**
 * Whether a command rule names this command. Deny and ask rules catch it when any part matches in any view (see
 * Segment). An allow rule covers it only when the line is simple and every part matches as written; a destructive part
 * only when the rule names it exactly, since a prefix remembered for `rm -rf build` must not cover `rm -rf build ~`.
 */
function commandRuleMatches(rule: PermissionRule, line: string): boolean {
  if (rule.target === '*') return true
  const { segments, simple } = parseCommand(line)
  if (segments.length === 0) return false
  const target = targetText(rule.target)
  if (rule.decision !== 'allow') return segments.some((s) => s.views.some((v) => prefixMatch(v, target)))
  if (!simple || pipedInstall(line, segments)) return false
  return segments.every((s) => (destructiveSegment(s) ? s.text === target : prefixMatch(s.text, target)))
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
  const { segments, simple } = parseCommand(line)
  if (!simple || segments.length === 0) return false
  return segments.every((s) => {
    const [program, ...args] = s.words
    if (!program) return false
    if (program === 'find') return !args.some((a) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fls)/.test(a))
    // Options of otherwise read-only programs that run a program or write a file.
    if (program === 'rg' && args.some((a) => a.startsWith('--pre'))) return false
    if (program === 'tree' && args.some((a) => a === '-o')) return false
    if (program === 'git') {
      const [sub, ...rest] = args
      if (rest.some((a) => a.startsWith('--output') || a === '--ext-diff')) return false
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
  'deno',
  'uv',
  'pip',
  'brew',
])
/** Their words that run something named next (`bun run build`): the prefix keeps that name too. */
const RUNNERS = new Set(['run', 'exec', 'x'])
/** Their words that run code written right after them (`deno eval '…'`, `bun -e '…'`). */
const INLINE = new Set(['eval', '-e', '--eval', '-p', '--print', '-c'])
/** Programs that run code they are given, inline or from their input, or a script file named next. */
const INTERPRETERS = new Set([
  ...SHELLS,
  'python',
  'python3',
  'node',
  'perl',
  'ruby',
  'php',
  'lua',
  'osascript',
  'awk',
  'gawk',
])
/** Programs whose arguments are what they run or destroy: a prefix of them alone would allow anything. */
const UNBOUNDED = new Set([
  'sudo',
  'doas',
  'su',
  'env',
  'xargs',
  'eval',
  'exec',
  'command',
  'ssh',
  'watch',
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'truncate',
  'dd',
  'mkfs',
  'chmod',
  'chown',
  'kill',
  'killall',
  'pkill',
])

/**
 * The prefix a person would remember for one part of a command: `bun test src/a.test.ts` → `bun test`. Never wider
 * than the part shown when a wider one could allow something else entirely: a destructive part, an interpreter's
 * inline code, or a program like `rm` or `sudo` is offered as written (an interpreter's script by its name), and
 * nothing is offered for a bare shell or interpreter, which runs whatever it is fed.
 */
function prefixOf(segment: Segment): string {
  const [program, sub, name] = segment.words
  if (!program) return ''
  const whole = segment.text.length <= MAX_TARGET ? segment.text : ''
  if (destructiveSegment(segment)) return whole
  if (UNBOUNDED.has(program)) return sub === undefined ? '' : whole
  if (INTERPRETERS.has(program)) {
    if (sub === undefined) return ''
    if (!sub.startsWith('-')) return join([program, sub])
    return sub === '-m' && name && !name.startsWith('-') ? join([program, sub, name]) : whole
  }
  if (!SUBCOMMANDS.has(program) || !sub) return join([program])
  if (sub.startsWith('-') || INLINE.has(sub)) return whole
  if (RUNNERS.has(sub) && name && !name.startsWith('-')) return join([program, sub, name])
  return join([program, sub])
}

/** The prefix a person would remember for a command of one part (see the card's offers). */
export function commandPrefix(segment: string): string {
  const first = parseCommand(segment).segments[0]
  return first ? prefixOf(first) : ''
}

/**
 * What an approval card may remember for a call, most specific first: a command's prefixes then every command; an
 * MCP tool then its server; file changes; or the tool itself. A command offers its prefixes only when remembering them
 * all would cover it: it is simple, no part lacks a prefix it may be remembered by, and it is not a download run by a
 * shell.
 */
export function offersFor(call: PermissionCall): Omit<PermissionRule, 'decision'>[] {
  switch (call.kind) {
    case 'command': {
      const line = call.command ?? ''
      const { segments, simple } = parseCommand(line)
      const each = segments.map(prefixOf)
      const prefixes =
        simple && !each.includes('') && !pipedInstall(line, segments) ? [...new Set(each)].slice(0, 3) : []
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

/** Whether `rule` is one of a card's offers, as offered: same kind and target, for everyone. */
export function offered(offers: readonly Omit<PermissionRule, 'decision'>[], rule: PermissionRule): boolean {
  return offers.some((o) => sameTarget(o, rule))
}

/**
 * What one "always" remembers from an approval, where there is no menu to choose from (a channel's button): the
 * card's first choice (a compound command's parts together, else its most specific offer); the tool itself for a
 * request from before offers; nothing for a read request (allowed once or for the chat only) or a card the permission
 * model offers nothing on (a round someone else started, a read-only project, a commit).
 */
export function alwaysOffer(request: {
  readonly tool: string
  readonly offer?: readonly Omit<PermissionRule, 'decision'>[]
  readonly call?: PermissionCall
  readonly read?: string
}): Omit<PermissionRule, 'decision'>[] {
  if (request.read !== undefined) return []
  const offers = request.offer ?? []
  if (!offers.length) return request.call ? [] : [{ kind: 'tool', target: request.tool }]
  const parts = offers.filter((o) => o.kind === 'command' && o.target !== '*')
  return parts.length ? parts : offers.slice(0, 1)
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
