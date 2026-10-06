/**
 * Slash commands typed in the composer, modelled on omp's: one line, run instead of being sent. Like omp's, a command
 * can offer completions for its argument (`/model ` lists models, `/mode ` the two modes).
 */

export type CommandGroup = 'Round' | 'Team & model' | 'Chat' | 'App'
export const GROUPS: readonly CommandGroup[] = ['Round', 'Team & model', 'Chat', 'App']

export interface ArgOption {
  readonly value: string
  readonly label: string
  readonly description?: string
}

export interface SlashCommand {
  readonly name: string
  /** Shown after the name in the menu, e.g. `<title>`; omitted for commands that take nothing. */
  readonly args?: string
  readonly description: string
  /** The argument is required: picking the command from the menu asks for it rather than running it. */
  readonly needsArg?: boolean
  readonly group: CommandGroup
  /** When the command makes sense; outside it the menu shows it dimmed, with the reason. */
  readonly when?: 'running' | 'idle' | 'chat' | 'resumable'
  /** Fixed choices for the argument; commands with dynamic ones (models) get them from the composer. */
  readonly options?: readonly ArgOption[]
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'plan',
    args: '<request>',
    description: 'Plan first: see the plan and approve it before any work',
    needsArg: true,
    group: 'Round',
  },
  {
    name: 'steer',
    args: '<message>',
    description: 'Send to the running round, read at its next step',
    needsArg: true,
    group: 'Round',
    when: 'running',
  },
  {
    name: 'queue',
    args: '<message>',
    description: 'Send to the running round, read when it finishes its current work',
    needsArg: true,
    group: 'Round',
    when: 'running',
  },
  { name: 'stop', description: 'Stop the running round', group: 'Round', when: 'running' },
  {
    name: 'resume',
    description: 'Pick a stopped round back up where it left off',
    group: 'Round',
    when: 'resumable',
  },
  { name: 'retry', description: 'Run the last request again as a new round', group: 'Round', when: 'idle' },
  {
    name: 'model',
    args: '<name>',
    description: 'Switch the lead model, right away if a round is running',
    needsArg: true,
    group: 'Team & model',
  },
  {
    name: 'mode',
    args: 'orchestrated | swarm',
    description: 'Lead with specialists, or equal peers',
    needsArg: true,
    group: 'Team & model',
    options: [
      {
        value: 'orchestrated',
        label: 'Orchestrated',
        description: 'A lead plans and assigns work to specialists',
      },
      { value: 'swarm', label: 'Swarm', description: 'Equal peers agree a plan and claim the work' },
    ],
  },
  {
    name: 'thinking',
    args: 'low | medium | high | auto',
    description: 'How hard reasoning models think in work rounds',
    needsArg: true,
    group: 'Team & model',
    options: [
      {
        value: 'auto',
        label: 'Auto',
        description: 'Each role decides: leads think hard, quick answers think less',
      },
      { value: 'low', label: 'Low', description: 'Fastest and cheapest' },
      { value: 'medium', label: 'Medium', description: 'Balanced' },
      { value: 'high', label: 'High', description: 'Most careful; slower' },
    ],
  },
  { name: 'team', description: 'Open the team and model picker', group: 'Team & model' },
  { name: 'new', description: 'Start a new chat', group: 'Chat' },
  {
    name: 'rename',
    args: '<title>',
    description: 'Rename this chat',
    needsArg: true,
    group: 'Chat',
    when: 'chat',
  },
  { name: 'attach', description: 'Attach files to your next message', group: 'Chat' },
  { name: 'export', description: 'Download this chat as Markdown', group: 'Chat', when: 'chat' },
  { name: 'mcp', description: 'Manage MCP servers', group: 'App' },
  { name: 'settings', description: 'Open settings', group: 'App' },
  { name: 'help', description: 'Show every command', group: 'App' },
]

export interface SlashContext {
  readonly running: boolean
  readonly chat: boolean
  /** The chat's latest round stopped before finishing. */
  readonly resumable: boolean
}

/** Why a command can't run now, or undefined when it can. */
export function unavailable(command: SlashCommand, ctx: SlashContext): string | undefined {
  switch (command.when) {
    case 'running':
      return ctx.running ? undefined : 'Nothing is running'
    case 'idle':
      return !ctx.chat ? 'Open a chat first' : ctx.running ? 'Wait for the round to finish' : undefined
    case 'chat':
      return ctx.chat ? undefined : 'Open a chat first'
    case 'resumable':
      return ctx.resumable && !ctx.running ? undefined : 'No stopped round to resume'
    default:
      return undefined
  }
}

/** `/name rest` → the command and its argument; undefined for ordinary text or an unknown name. */
export function parseSlash(text: string): { command: SlashCommand; arg: string } | undefined {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  const command = m && SLASH_COMMANDS.find((c) => c.name === m[1])
  return command ? { command, arg: (m?.[2] ?? '').trim() } : undefined
}

/**
 * Where the composer's text is in a command: choosing a name (`/mo`), or giving a known command its argument
 * (`/model cla`). Undefined for ordinary text.
 */
export function slashStage(
  text: string,
): { stage: 'name'; query: string } | { stage: 'arg'; command: SlashCommand; query: string } | undefined {
  const name = /^\/([a-z]*)$/.exec(text)
  if (name) return { stage: 'name', query: name[1] ?? '' }
  const arg = /^\/([a-z]+) ([^\n]*)$/.exec(text)
  const command = arg && SLASH_COMMANDS.find((c) => c.name === arg[1])
  return command?.needsArg ? { stage: 'arg', command, query: arg?.[2] ?? '' } : undefined
}

/** Positions of `query`'s letters found in order in `text` (case-insensitive), or undefined if they aren't. */
export function fuzzy(query: string, text: string): number[] | undefined {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const hits: number[] = []
  let from = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const at = t.indexOf(ch, from)
    if (at < 0) return undefined
    hits.push(at)
    from = at + 1
  }
  return hits
}

export interface RankedCommand {
  readonly command: SlashCommand
  /** Matched letters in the command name, for highlighting. */
  readonly matches: number[]
  readonly unavailable?: string
}

/**
 * Commands for what was typed after the slash: name prefixes first, then other names containing the letters in
 * order, then commands whose description mentions the word. Commands that can't run now sink below the rest.
 */
export function rankCommands(query: string, ctx: SlashContext): RankedCommand[] {
  const scored: { ranked: RankedCommand; score: number }[] = []
  for (const command of SLASH_COMMANDS) {
    const reason = unavailable(command, ctx)
    const prefix = command.name.startsWith(query)
    const inName = prefix ? undefined : fuzzy(query, command.name)
    const inText =
      !prefix && !inName && query.length >= 3 && command.description.toLowerCase().includes(query)
    if (!prefix && !inName && !inText) continue
    const matches = prefix ? [...query].map((_, i) => i) : (inName ?? [])
    const score = (prefix ? 0 : inName ? 1 : 2) + (reason ? 10 : 0)
    scored.push({ ranked: { command, matches, ...(reason ? { unavailable: reason } : {}) }, score })
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.ranked)
}

/**
 * Argument choices matching what was typed, best first: a word of the label starting with it ("op" → Claude Opus),
 * then the label's letters in order, then the value or description containing it (a provider name).
 */
export function rankOptions(query: string, options: readonly ArgOption[]): ArgOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...options]
  const score = (o: ArgOption) => {
    const label = o.label.toLowerCase()
    if (label.split(/[\s\-_./]+/).some((w) => w.startsWith(q)) || label.startsWith(q)) return 0
    if (fuzzy(q, label)) return 1
    if (o.value.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q)) return 2
    return 3
  }
  return options
    .map((o) => ({ o, s: score(o) }))
    .filter((x) => x.s < 3)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.o)
}
