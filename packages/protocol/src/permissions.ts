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
  // Cua Driver's computer tool with the tools that open and list the apps it works in, and omp's desktop engine.
  computer: ['computer', 'open_app', 'list_apps', 'desktop'],
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
  /** No preset lets it run on its own: it asks unless a rule allows it (omp's desktop scripts, run outside the sandbox). */
  readonly asks?: boolean
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
  // A deny rule cannot tell whether a command it cannot read in full is the one it names: the person decides.
  if (call.kind === 'command' && commandUnknown(call.command ?? ''))
    for (const { scope, level } of order) {
      const rule = level.rules.find(
        (r) => r.decision === 'deny' && r.kind === 'command' && appliesTo(r, options.role),
      )
      if (rule) return verdict('ask', { by: 'rule', scope, rule })
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
  if (call.asks) return 'ask'
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
 * One command of a line. `text`: its words with harmless leading assignments and plain wrappers (`timeout 30`,
 * `env NO_COLOR=1`) taken off, which allow rules, Ask's read-only check and the card's offers read. `views`: `text`
 * and what it runs once wrappers that change who runs it (`sudo`, `xargs`), a program's path and case, and git's
 * global options are taken off too, which deny and ask rules and the destructive check read, so
 * `sudo /usr/bin/git -C . push` is still `git push` to a deny rule.
 */
interface Segment {
  readonly words: Words
  readonly text: string
  readonly views: readonly string[]
}

/**
 * A line as the permission model reads it. `simple`: rules may match it (see `scan`). `loose`: the views of the
 * commands the line holds read with every quote ignored, which deny and ask rules and the destructive check also
 * look at, so quoting this reader gets wrong cannot hide a command from them. `unknown`: what some part runs is known
 * only when the line runs (its program is a variable, a glob or a substitution), or the line is too long or too
 * deeply nested to read in full.
 */
interface ParsedLine {
  readonly segments: readonly Segment[]
  readonly loose: readonly string[]
  readonly simple: boolean
  readonly unknown: boolean
}

/** The longest command line read; a longer one is not read past this, so it asks (see ParsedLine.unknown). */
export const MAX_COMMAND_READ = 8_192
/** How deep `sh -c '…'`, `eval` and the like inside a command are read before giving up on them. */
const MAX_NESTING = 4
/** How many wrappers in front of one command are taken off before giving up on it. */
const MAX_WRAPPERS = 64

/**
 * A line's commands, read as /bin/sh would: quotes (`$'…'` decoded), backslashes, comments, `$(…)`, `${…}`,
 * backticks, subshells and function bodies (whose commands are read too), heredoc bodies skipped, split where the
 * shell would run another command (`&&`, `||`, `;`, `|`, `&`, newlines). `simple`: nothing in it is substituted,
 * redirected, commented out, defined, or left unbalanced, so rules may match it (as Codex and Claude Code both
 * require); anything this cannot read for sure is not simple. `literal`: where heredoc bodies the shell never expands
 * lie, which hold text, not commands.
 */
function scan(line: string): { commands: Words[]; simple: boolean; literal: [number, number][] } {
  const commands: Words[] = []
  const literal: [number, number][] = []
  let simple = true
  let words: string[] = []
  let word = ''
  let inWord = false
  // The word after a redirection operator is its target (a file or here-string body), not an argument, so it is
  // dropped: an interpreter fed a here-string (`sh <<< rm`) keeps no fake script argument and reads as running input.
  let skipWord = false
  let quote: '"' | "'" | undefined
  const heredocs: { delimiter: string; tabs: boolean; quoted: boolean }[] = []
  // Open substitutions, parameters and subshells, each with what was being read outside it.
  const outer: {
    close: ')' | '`' | '}'
    sub: boolean
    words: string[]
    word: string
    inWord: boolean
    quote: '"' | "'" | undefined
  }[] = []
  const endWord = () => {
    if (inWord) {
      if (!skipWord) words.push(word)
      skipWord = false
    }
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    skipWord = false
    if (words.length) commands.push(words)
    words = []
  }
  const open = (close: ')' | '`' | '}', sub: boolean) => {
    // A parameter (`${x}`) runs nothing of its own; substitutions inside it are frames of their own.
    if (close !== '}') simple = false
    outer.push({ close, sub, words, word, inWord, quote })
    words = []
    word = ''
    inWord = false
    quote = undefined
  }
  const close = () => {
    const o = outer.pop()
    if (!o) return
    // A parameter's words are not a command.
    if (o.close === '}') {
      words = []
      word = ''
      inWord = false
    } else endCommand()
    words = o.words
    // What a substitution or parameter gives is part of a word whose value is only known when the line runs.
    word = o.sub ? `${o.word}$()` : o.word
    inWord = o.inWord || o.sub
    quote = o.quote
  }
  // The bodies of the heredocs opened on the line just ended, from `from`; returns where the next line starts.
  const bodies = (from: number): number => {
    let at = from
    for (const h of heredocs.splice(0)) {
      const start = at
      let end = line.length
      while (at < line.length) {
        const nl = line.indexOf('\n', at)
        const stop = nl < 0 ? line.length : nl
        const text = line.slice(at, stop)
        const lineStart = at
        at = stop + 1
        if ((h.tabs ? text.replace(/^\t+/, '') : text) === h.delimiter) {
          end = lineStart
          break
        }
      }
      if (h.quoted) literal.push([start, end])
    }
    return Math.min(at, line.length)
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
    const top = outer.at(-1)?.close
    if (c === '`') {
      if (top === '`') close()
      else open('`', true)
      continue
    }
    if (c === '$' && (next === '(' || next === '{')) {
      i++
      open(next === '(' ? ')' : '}', true)
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = undefined
      else word += c
      continue
    }
    if (c === '}' && top === '}') {
      close()
      continue
    }
    if (c === '$' && next === "'") {
      const end = ansiC(line, i + 2, (s) => {
        word += s
      })
      if (end >= line.length) simple = false
      inWord = true
      i = end
      continue
    }
    // `$"…"` is a double-quoted string (translated by locale): the `$` is not part of it.
    if (c === '$' && next === '"') continue
    if (c === '"' || c === "'") {
      quote = c
      inWord = true
      continue
    }
    if (c === '#' && !inWord && top !== '}') {
      // A comment runs to the end of the line (inside backticks, to their end).
      simple = false
      while (i + 1 < line.length && line[i + 1] !== '\n' && !(top === '`' && line[i + 1] === '`')) i++
      continue
    }
    if (c === '(') {
      // `name()` defines a function: its body is read as commands, and the line is not simple.
      const shut = /^[ \t]*\)/.exec(line.slice(i + 1, i + 64))
      if (shut) {
        simple = false
        endCommand()
        i += shut[0].length
        continue
      }
      open(')', false)
      continue
    }
    if (c === ')') {
      if (top === ')') close()
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
      if (c === '<' && next === '<' && line[i + 2] !== '<') {
        // A heredoc: its body, on the lines after this one, is text up to the delimiter (see `bodies`).
        i++
        const tabs = line[i + 1] === '-'
        if (tabs) i++
        while (line[i + 1] === ' ' || line[i + 1] === '\t') i++
        let delimiter = ''
        let quoted = false
        while (i + 1 < line.length && !/[\s;&|<>()]/.test(line[i + 1] as string)) {
          const d = line[++i] as string
          if (d === "'" || d === '"') {
            quoted = true
            const end = line.indexOf(d, i + 1)
            delimiter += line.slice(i + 1, end < 0 ? line.length : end)
            i = end < 0 ? line.length : end
          } else if (d === '\\') {
            quoted = true
            delimiter += line[++i] ?? ''
          } else delimiter += d
        }
        heredocs.push({ delimiter, tabs, quoted })
        continue
      }
      // The rest of the operator (`>>`, `>&`, `&>`, `<<<`, `>|`).
      while ('<>&|'.includes(line[i + 1] ?? ' ')) i++
      // The next word is the redirection's target (file or here-string body), not a command argument.
      skipWord = true
      continue
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      endCommand()
      if ((c === '|' || c === '&' || c === ';') && next === c) i++
      else if (c === '|' && next === '&') i++
      if (c === '\n' && heredocs.length) i = bodies(i + 1) - 1
      continue
    }
    word += c
    inWord = true
  }
  if (quote || outer.length || heredocs.length) simple = false
  while (outer.length) close()
  endCommand()
  return { commands, simple, literal }
}

const C_ESCAPES: Readonly<Record<string, string>> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
}

/**
 * Decodes an ANSI-C quoted string (`$'…'`) as bash does, from `from` (just inside the quote), passing what it reads
 * to `put`; returns the index of its closing quote (the line's length when it has none).
 */
function ansiC(line: string, from: number, put: (s: string) => void): number {
  let i = from
  for (; i < line.length && line[i] !== "'"; i++) {
    const c = line[i] as string
    if (c !== '\\' || i + 1 >= line.length) {
      put(c)
      continue
    }
    const e = line[++i] as string
    const named = C_ESCAPES[e]
    if (named !== undefined) {
      put(named)
      continue
    }
    const digits = (re: RegExp, max: number) => re.exec(line.slice(i + 1, i + 1 + max))?.[0] ?? ''
    if (e === 'x' || e === 'u' || e === 'U') {
      const hex = digits(/^[0-9a-fA-F]+/, e === 'x' ? 2 : e === 'u' ? 4 : 8)
      const code = Number.parseInt(hex, 16)
      if (hex && code <= 0x10ffff) {
        put(String.fromCodePoint(code))
        i += hex.length
      } else put(`\\${e}`)
      continue
    }
    if (e >= '0' && e <= '7') {
      const oct = e + digits(/^[0-7]+/, 2)
      put(String.fromCharCode(Number.parseInt(oct, 8) & 0xff))
      i += oct.length - 1
      continue
    }
    if (e === 'c' && i + 1 < line.length) {
      put(String.fromCharCode(line.charCodeAt(++i) & 0x1f))
      continue
    }
    put(`\\${e}`)
  }
  return i
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
  'coproc',
])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Variables a command may be given that change how it prints, its locale or the mode it runs in, never what it runs:
 * the ones Claude Code also lets through (CI, colour, terminal, locale, time zone) and common test or log switches.
 * Any other (PATH, LD_ and DYLD_ variables, NODE_OPTIONS, GIT_*, PAGER, EDITOR, LESSOPEN, BASH_ENV, PYTHONPATH…) can
 * make a command run something else, so a line setting one is not simple.
 */
const SAFE_VARIABLES = new Set([
  'CI',
  'NO_COLOR',
  'FORCE_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'TERM',
  'COLUMNS',
  'LINES',
  'TZ',
  'LANG',
  'LANGUAGE',
  'NODE_ENV',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'DEBUG',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
])
const safeAssignment = (w: string) => {
  const name = w.slice(0, w.indexOf('='))
  return SAFE_VARIABLES.has(name) || name.startsWith('LC_')
}

/**
 * Leaves `words` after its leading options: `withArg` options take the next word unless written `--opt=value`; in a
 * cluster of short options (`-iu X`), the first that takes an argument takes the rest of the cluster or the next word.
 */
function afterOptions(words: Words, withArg: ReadonlySet<string> = new Set()): Words {
  let i = 0
  while (i < words.length) {
    const w = words[i] as string
    if (w === '--') return words.slice(i + 1)
    if (!w.startsWith('-') || w === '-') break
    if (w.startsWith('--')) {
      i += withArg.has(w) ? 2 : 1
      continue
    }
    let take = 1
    for (let k = 1; k < w.length; k++)
      if (withArg.has(`-${w[k]}`)) {
        take = k === w.length - 1 ? 2 : 1
        break
      }
    i += take
  }
  return words.slice(i)
}

/** `words` after its options and then `skip` words of its own (a lock file, a new root), or undefined when none follow. */
function afterOperands(words: Words, withArg: ReadonlySet<string>, skip: number): Words | undefined {
  const after = afterOptions(words, withArg).slice(skip)
  return after.length ? after : undefined
}

const ARGS = {
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-t']),
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  exec: new Set(['-a']),
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  caffeinate: new Set(['-t', '-w']),
  setsid: new Set<string>(),
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U', '--user', '--group']),
  doas: new Set(['-u', '-C']),
  xargs: new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--arg-file', '--delimiter']),
  script: new Set(['-t', '-T', '-E', '-I', '-O', '-B', '-m', '--timing', '--log-in', '--log-out']),
  chroot: new Set(['--userspec', '--groups']),
  flock: new Set(['-w', '--timeout', '-E', '--conflict-exit-code']),
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']),
} as const

/**
 * `words` without one wrapper in front that runs the rest as it is: an assignment, `timeout 30`, `time`, `nice`,
 * `ionice`, `nohup`, `setsid`, `stdbuf`, `caffeinate`, `unbuffer`, `env` (without `-S`), `command`, `builtin`,
 * `exec`. With `deep`, also those that change who or where it runs or feed it arguments (`sudo`, `doas`, `xargs`,
 * `script`, `chroot`, `flock`). Undefined when there is none to take off.
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
    case 'unbuffer':
      return afterOptions(rest)
    case 'setsid':
      return afterOptions(rest, ARGS.setsid)
    case 'nice':
      return afterOptions(rest, ARGS.nice)
    case 'ionice':
      return afterOptions(rest, ARGS.ionice)
    case 'stdbuf':
      return afterOptions(rest, ARGS.stdbuf)
    case 'caffeinate':
      return afterOptions(rest, ARGS.caffeinate)
    case 'exec':
      return afterOptions(rest, ARGS.exec)
    case 'timeout':
      return afterOperands(rest, ARGS.timeout, 1)
    case 'command':
      // `command -v rm` looks rm up; it runs nothing.
      return rest[0] === '-v' || rest[0] === '-V' ? undefined : afterOptions(rest)
    case 'env': {
      // `env -S 'rm -rf x'` runs a string: read as a nested command instead (see nestedLines).
      if (rest.some((a) => a === '-S' || a.startsWith('--split-string'))) return undefined
      const after = afterOptions(rest, ARGS.env)
      let i = 0
      while (i < after.length && ASSIGNMENT.test(after[i] as string)) i++
      return after.slice(i)
    }
  }
  if (!deep) return undefined
  switch (w) {
    case 'sudo':
      return afterOptions(rest, ARGS.sudo)
    case 'doas':
      return afterOptions(rest, ARGS.doas)
    case 'xargs': {
      const after = afterOptions(rest, ARGS.xargs)
      return after.length ? after : ['echo']
    }
    // `script -q log cmd …` (macOS), `chroot root cmd …`, `flock lock cmd …`; their `-c` forms are nested lines.
    case 'script':
      return afterOperands(rest, ARGS.script, 1)
    case 'chroot':
      return afterOperands(rest, ARGS.chroot, 1)
    case 'flock':
      return afterOperands(rest, ARGS.flock, 1)
  }
  return undefined
}

/** `words` with the program named as found on the PATH (`/bin/rm`, `RM` → `rm`), and git's global options dropped. */
function canonical(words: Words): Words | undefined {
  const [program, ...rest] = words
  if (program === undefined) return undefined
  const name = (program.split('/').at(-1) ?? program).toLowerCase()
  if (name && name !== program) return [name, ...rest]
  if (program === 'git' && rest[0]?.startsWith('-')) return ['git', ...afterOptions(rest, ARGS.git)]
  return undefined
}

/** `words` with harmless assignments, plain wrappers and control-flow words taken off the front. */
function bare(raw: Words): { words: Words; control: boolean; unsafe: boolean } {
  let words = raw
  let control = false
  let unsafe = false
  for (let n = 0; n < MAX_WRAPPERS * 4; n++) {
    const first = words[0]
    if (first !== undefined && RESERVED.has(first)) {
      control = true
      // `function name { … }`: the name is not the program either.
      words = words.slice(first === 'function' ? 2 : 1)
      continue
    }
    const w = unwrap(words, false)
    if (!w) break
    if (words.slice(0, words.length - w.length).some((x) => ASSIGNMENT.test(x) && !safeAssignment(x)))
      unsafe = true
    words = w
  }
  return { words, control, unsafe }
}

/** A command and what it runs once wrappers, paths and global options are off (see Segment); `whole`: read to the end. */
function viewsOf(words: Words): { views: Words[]; whole: boolean } {
  const views: Words[] = [words]
  let v: Words | undefined = words
  for (let n = 0; n < MAX_WRAPPERS; n++) {
    v = unwrap(v, true) ?? canonical(v)
    if (!v?.length) return { views, whole: true }
    views.push(v)
  }
  return { views, whole: false }
}

/** Whether a program word names a program only when the line runs: a variable, a substitution, a glob, braces. */
const unknownProgram = (p: string) =>
  /[$*?]/.test(p) || /\[.+\]/.test(p) || /\{[^}]*(?:,|\.\.)[^}]*\}/.test(p)

/**
 * Whether a view runs a subcommand nobody can read before the line runs: a dispatching program (`git`, `bun`, `npm`…)
 * whose subcommand word is an expansion. What these do turns entirely on that word, so `git $x` could be `git push`
 * as easily as `git status`; the deny rules and destructive check must not clear it.
 */
const unknownSub = ([program, sub]: Words) =>
  program !== undefined && sub !== undefined && SUBCOMMANDS.has(program) && unknownProgram(sub)

/** Interpreters that run code from their input when given no script or code of their own (`… | sh`). */
const STDIN_RUNNERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'python',
  'python3',
  'node',
  'perl',
  'ruby',
  'php',
])
/** Whether a command runs code it reads from its input, which nothing here can see. */
const runsInput = ([program, ...args]: Words) =>
  program !== undefined &&
  STDIN_RUNNERS.has(program) &&
  !args.some((a) => ['-v', '-V', '--version', '-h', '--help'].includes(a)) &&
  args.every((a) => a.startsWith('-') && !/^-[a-zA-Z]*[ce]/.test(a))

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
/** A nested line standing for a command nobody can know before it runs (sed's `e` flag). */
const UNKNOWN_LINE = '$?'

/** The values a command gives these options, as `--opt=value` or `--opt value`. */
function optionValues(words: Words, names: readonly string[]): string[] {
  const out: string[] = []
  words.forEach((w, i) => {
    for (const name of names) {
      if (w === name && words[i + 1] !== undefined) out.push(words[i + 1] as string)
      else if (w.startsWith(`${name}=`)) out.push(w.slice(name.length + 1))
    }
  })
  return out
}

/** Git settings whose value is a command git runs. */
const GIT_RUNS =
  /^(?:core\.(?:pager|editor|sshcommand|fsmonitor|askpass)|sequence\.editor|diff\.external|gpg\.program|credential\.helper|.*\.(?:command|textconv|helper|cmd))$/i

/**
 * The command lines a command runs as strings: `sh -c '…'`, `eval …`, `env -S '…'`, `script -c`, `flock … -c`,
 * tar's `--to-command`, rsync's `-e`, zip's `-TT`, ssh's ProxyCommand, vim's `-c '!…'`, sed's `e` command, and git's
 * `-c` settings that run commands or name aliases (`git -c alias.p=push p` is `git push`).
 */
function nestedLines(words: Words): string[] {
  const [program, ...rest] = words
  if (program === undefined) return []
  if (program === 'eval') return [rest.join(' ')]
  if (SHELLS.has(program)) {
    const flag = rest.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
    const line = flag >= 0 ? rest.slice(flag + 1).find((a) => !a.startsWith('-')) : undefined
    return line === undefined ? [] : [line]
  }
  switch (program) {
    case 'env':
      return optionValues(rest, ['-S', '--split-string'])
    case 'script':
    case 'flock':
      return optionValues(rest, ['-c', '--command'])
    case 'tar':
    case 'gtar':
    case 'bsdtar':
      return optionValues(rest, [
        '--to-command',
        '--use-compress-program',
        '-I',
        '--info-script',
        '--new-volume-script',
        '-F',
      ]).concat(
        optionValues(rest, ['--checkpoint-action']).flatMap((a) =>
          a.startsWith('exec=') ? [a.slice(5)] : [],
        ),
      )
    case 'rsync':
      return optionValues(rest, ['-e', '--rsh', '--rsync-path'])
    case 'zip':
      return optionValues(rest, ['-TT', '--unzip-command'])
    case 'ssh':
      return optionValues(rest, ['-o']).flatMap((o) => {
        const m = /^(?:ProxyCommand|LocalCommand)[= ](.*)$/is.exec(o)
        return m ? [m[1] as string] : []
      })
    case 'vim':
    case 'nvim':
    case 'vi':
    case 'ex':
      return [
        ...optionValues(rest, ['-c', '--cmd']),
        ...rest.filter((a) => a.startsWith('+')).map((a) => a.slice(1)),
      ]
        .map((c) => c.replace(/^:/, ''))
        .flatMap((c) => (c.startsWith('!') ? [c.slice(1)] : []))
    case 'sed':
    case 'gsed': {
      const scripts = optionValues(rest, ['-e', '--expression'])
      const after = afterOptions(rest, new Set(['-e', '--expression', '-f', '--file', '-l']))
      const all = scripts.length ? scripts : after.slice(0, 1)
      return all.flatMap((s) => {
        const e = /(?:^|[\s;{}\d$/!])e(?:\s+([^\n;}]*))?$/m.exec(s)
        if (e) return [e[1]?.trim() || UNKNOWN_LINE]
        return /\/[gpiImM0-9w]*e[gpiImM0-9]*$/.test(s) ? [UNKNOWN_LINE] : []
      })
    }
    case 'git': {
      const out: string[] = []
      const settings = optionValues(rest.slice(0, rest.length - afterOptions(rest, ARGS.git).length), ['-c'])
      const [sub, ...args] = afterOptions(rest, ARGS.git)
      for (const s of settings) {
        const at = s.indexOf('=')
        const key = at < 0 ? s : s.slice(0, at)
        const value = at < 0 ? '' : s.slice(at + 1)
        const alias = /^alias\.(.+)$/i.exec(key)?.[1]
        if (alias !== undefined && alias === sub)
          out.push(value.startsWith('!') ? value.slice(1) : `git ${value} ${join(args)}`)
        else if (GIT_RUNS.test(key)) out.push(value)
      }
      return out
    }
  }
  return []
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

/** A line's commands with their texts and views (see Segment), whether it is simple, and whether all is known. */
function parseCommand(line: string, depth = 0): Omit<ParsedLine, 'loose'> & { literal: [number, number][] } {
  const { commands, simple: plain, literal } = scan(line)
  let simple = plain
  let unknown = false
  const segments: Segment[] = []
  const seen = new Set<string>()
  const add = (raw: Words, finds = 0) => {
    const { words, control, unsafe } = bare(raw)
    if (control || unsafe) simple = false
    if (!words.length) return
    const { views, whole } = viewsOf(words)
    if (!whole || views.some((v) => unknownProgram(v[0] as string) || runsInput(v) || unknownSub(v))) {
      simple = false
      unknown = true
    }
    segments.push({ words, text: join(words), views: [...new Set(views.map(join))] })
    for (const v of views) {
      for (const nested of nestedLines(v)) {
        if (seen.has(`sh:${nested}`)) continue
        seen.add(`sh:${nested}`)
        simple = false
        if (depth >= MAX_NESTING) {
          unknown = true
          continue
        }
        const inner = parseCommand(nested, depth + 1)
        segments.push(...inner.segments)
        unknown ||= inner.unknown
      }
      const each = findExec(v)
      if (each?.length && !seen.has(`find:${join(each)}`)) {
        seen.add(`find:${join(each)}`)
        if (finds >= MAX_NESTING) unknown = true
        else add(each, finds + 1)
      }
    }
  }
  for (const words of commands) add(words)
  return { segments, simple, unknown, literal }
}

/** Every view of every command in `text` read with quotes, backslashes and grouping ignored (see ParsedLine.loose). */
function looseViews(text: string): string[] {
  const out = new Set<string>()
  for (const part of text.split(/[;&|\n\r`(){}]|\$\(|\$\{/)) {
    const words = part
      .replace(/\$(?=['"])/g, '')
      .replace(/['"\\]/g, '')
      .split(/\s+/)
      .filter(Boolean)
    const { words: plain } = bare(words)
    if (plain.length) for (const v of viewsOf(plain).views) out.add(join(v))
  }
  return [...out]
}

/** Lines read lately, so one decision reads its command once however many rules it is checked against. */
const READ_CACHE = new Map<string, ParsedLine>()
const READ_CACHE_SIZE = 256

/** A command line as the permission model reads it (see ParsedLine), at most MAX_COMMAND_READ characters of it. */
function readLine(line: string): ParsedLine {
  const cached = READ_CACHE.get(line)
  if (cached) return cached
  const long = line.length > MAX_COMMAND_READ
  const text = long ? line.slice(0, MAX_COMMAND_READ) : line
  const { literal, ...parsed } = parseCommand(text)
  // Heredoc bodies the shell never expands are text, not commands: the loose read leaves them out.
  let looseText = ''
  let at = 0
  for (const [start, end] of literal) {
    looseText += text.slice(at, start)
    at = end
  }
  looseText += text.slice(at)
  const read: ParsedLine = {
    ...parsed,
    loose: looseViews(looseText),
    simple: parsed.simple && !long,
    unknown: parsed.unknown || long,
  }
  if (READ_CACHE.size >= READ_CACHE_SIZE) READ_CACHE.delete(READ_CACHE.keys().next().value as string)
  READ_CACHE.set(line, read)
  return read
}

/**
 * A command's parts, split where the shell would run another command (see `scan`), each with harmless leading
 * variable assignments and plain wrappers (`timeout 30`, `nice`, `nohup`, `time`, `env`) taken off and its quoting
 * resolved. `simple`: no substitution, redirection, comment, string run as a command, variable that changes what runs,
 * or anything this could not read for sure, so rules may match it.
 */
export function splitCommand(line: string): { segments: string[]; simple: boolean } {
  const { segments, simple } = readLine(line)
  return { segments: segments.map((s) => s.text), simple }
}

/**
 * A command rule's target written the way segments are, so `git "push"` in a rule is `git push` and an offer's
 * quoted spaces survive being saved.
 */
export function commandTarget(target: string): string {
  if (target.trim() === '*') return '*'
  return readLine(target).segments[0]?.text ?? target.trim().replace(/\s+/g, ' ')
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

const destructiveView = (v: string) => DESTRUCTIVE_COMMANDS.some((re) => re.test(v))
const destructiveSegment = (s: Segment) => s.views.some(destructiveView)

/** The program a view runs, by its first word. */
const programOf = (view: string) => view.split(' ')[0] ?? ''

/** Whether the line downloads something and hands it to a shell (`curl … | sh`, `wget -O- … | /bin/bash`). */
function pipedInstall(line: string, read: ParsedLine): boolean {
  if (PIPED_INSTALL.test(line)) return true
  const views = [...read.segments.flatMap((s) => s.views), ...read.loose]
  const runs = (names: (p: string) => boolean) => views.some((v) => names(programOf(v)))
  return runs((p) => p === 'curl' || p === 'wget') && runs((p) => SHELLS.has(p))
}

/**
 * Whether Auto asks before a command: some part deletes, rewrites history, publishes or escalates (read exactly or
 * with quotes ignored), it pipes a download into a shell, or what it runs is known only when it runs.
 */
export function destructiveCommand(line: string): boolean {
  const read = readLine(line)
  return (
    read.unknown ||
    pipedInstall(line, read) ||
    read.segments.some(destructiveSegment) ||
    read.loose.some(destructiveView)
  )
}

/**
 * Whether a command rule names this command. Deny and ask rules catch it when any part matches in any view, read
 * exactly or with quotes ignored (see ParsedLine). They are best effort all the same: a script, an alias or a program
 * that runs commands of its own can still run what they name, which is why `decide` asks rather than allows when a
 * deny rule is set and what a line runs cannot be known. An allow rule covers it only when the line is simple and
 * every part matches as written; a destructive part only when the rule names it exactly, since a prefix remembered for
 * `rm -rf build` must not cover `rm -rf build ~`.
 */
function commandRuleMatches(rule: PermissionRule, line: string): boolean {
  if (rule.target === '*') return true
  const read = readLine(line)
  if (read.segments.length === 0) return false
  const target = commandTarget(rule.target)
  if (rule.decision !== 'allow')
    return [...read.segments.flatMap((s) => s.views), ...read.loose].some((v) => prefixMatch(v, target))
  if (!read.simple || pipedInstall(line, read)) return false
  return read.segments.every((s) => (destructiveSegment(s) ? s.text === target : prefixMatch(s.text, target)))
}

/** Whether what a command line runs is known only when it runs (see ParsedLine.unknown). */
export const commandUnknown = (line: string) => readLine(line).unknown

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
  const { segments, simple } = readLine(line)
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
      // Git takes any unambiguous start of a long option: `--out=x` is `--output=x`.
      const writes = (a: string) => {
        const name = a.split('=')[0] as string
        return (
          name === '-o' || (name.length >= 4 && ['--output', '--ext-diff'].some((o) => o.startsWith(name)))
        )
      }
      if (rest.some(writes)) return false
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
/**
 * Programs whose arguments are what they run or destroy, or that can run commands of their own (sed's `e`, tar's
 * `--to-command`, an editor's `:!`, a container): a prefix of them alone would allow anything.
 */
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
  'script',
  'chroot',
  'flock',
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
  'sed',
  'gsed',
  'tar',
  'gtar',
  'bsdtar',
  'zip',
  'rsync',
  'vim',
  'nvim',
  'vi',
  'ex',
  'docker',
  'podman',
])
/** Their subcommands that run the project's own code (scripts, tests, build files, install hooks). */
const PROJECT_SUBCOMMANDS = new Set([
  'test',
  'run',
  'start',
  'exec',
  'x',
  'dlx',
  'build',
  'bench',
  'check',
  'generate',
  'task',
  'install',
  'i',
  'ci',
  'add',
])
/** Programs that run the project's own code whatever comes next. */
const PROJECT_TOOLS = new Set([
  'make',
  'just',
  'rake',
  'pytest',
  'tox',
  'nox',
  'jest',
  'vitest',
  'mocha',
  'gradle',
  'mvn',
  'bunx',
  'npx',
  'tsx',
  'ts-node',
])

/**
 * The prefix a person would remember for one part of a command: `bun test src/a.test.ts` → `bun test`. Never wider
 * than the part shown when a wider one could allow something else entirely: a destructive part, an interpreter's
 * inline code, or a program like `rm`, `sudo` or `sed` is offered as written (an interpreter's script by its name), and
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

/** Whether a remembered prefix runs code the agents can change: a script, a test runner, a build tool. */
function projectCode(prefix: string): boolean {
  const [program, sub] = prefix.split(' ')
  if (!program) return false
  if (program.includes('/') && !program.startsWith('/')) return true
  if (PROJECT_TOOLS.has(program)) return true
  if (INTERPRETERS.has(program)) return sub !== undefined
  return SUBCOMMANDS.has(program) && sub !== undefined && PROJECT_SUBCOMMANDS.has(sub)
}

/** The prefix a person would remember for a command of one part (see the card's offers). */
export function commandPrefix(segment: string): string {
  const first = readLine(segment).segments[0]
  return first ? prefixOf(first) : ''
}

/**
 * What an approval card may remember. `projectCode`: the remembered prefix runs code the agents can change (a test
 * runner, a build tool, a script), so remembered for a project or everywhere it lets them run whatever they write into
 * it; the card says so.
 */
export interface PermissionOffer extends Omit<PermissionRule, 'decision'> {
  readonly projectCode?: true
}

/**
 * What an approval card may remember for a call, most specific first: a command's prefixes then every command; an
 * MCP tool then its server; file changes; or the tool itself. A command offers its prefixes only when remembering them
 * all would cover it: it is simple, no part lacks a prefix it may be remembered by, and it is not a download run by a
 * shell.
 */
export function offersFor(call: PermissionCall): PermissionOffer[] {
  switch (call.kind) {
    case 'command': {
      const line = call.command ?? ''
      const read = readLine(line)
      const each = read.segments.map(prefixOf)
      const prefixes =
        read.simple && !each.includes('') && !pipedInstall(line, read) ? [...new Set(each)].slice(0, 3) : []
      return [
        ...prefixes.map((target) => ({
          kind: 'command' as const,
          target,
          ...(projectCode(target) ? { projectCode: true as const } : {}),
        })),
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
 * request from before offers; nothing for a read request (allowed once or for the chat only), a card the permission
 * model offers nothing on (a round someone else started, a read-only project, a commit), or a command only "every
 * command" would cover, which one button must not allow everywhere.
 */
export function alwaysOffer(request: {
  readonly tool: string
  readonly offer?: readonly PermissionOffer[]
  readonly call?: PermissionCall
  readonly read?: string
}): PermissionOffer[] {
  if (request.read !== undefined) return []
  const offers = (request.offer ?? []).filter((o) => !(o.kind === 'command' && o.target === '*'))
  if (!request.offer?.length) return request.call ? [] : [{ kind: 'tool', target: request.tool }]
  const parts = offers.filter((o) => o.kind === 'command')
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
    const raw = typeof x.target === 'string' ? x.target : ''
    // A command target is kept the way commands are read, so quoted spaces in an offer survive being saved.
    const target = x.kind === 'command' ? commandTarget(raw) : raw.trim().replace(/\s+/g, ' ')
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
