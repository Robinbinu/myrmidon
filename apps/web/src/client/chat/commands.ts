/** Slash commands typed in the composer, modelled on omp's: one line, run instead of being sent. */
export interface SlashCommand {
  readonly name: string
  /** Shown after the name in the menu, e.g. `<title>`; omitted for commands that take nothing. */
  readonly args?: string
  readonly description: string
  /** The argument is required: picking the command from the menu fills it in rather than running it. */
  readonly needsArg?: boolean
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'plan',
    args: '<request>',
    description: 'Plan first: see the plan and approve it before any work',
    needsArg: true,
  },
  {
    name: 'steer',
    args: '<message>',
    description: 'Send to the running round, read at its next step',
    needsArg: true,
  },
  {
    name: 'queue',
    args: '<message>',
    description: 'Send to the running round, read when it finishes its current work',
    needsArg: true,
  },
  { name: 'stop', description: 'Stop the running round' },
  { name: 'resume', description: 'Pick a stopped round back up where it left off' },
  { name: 'retry', description: 'Run the last request again as a new round' },
  { name: 'new', description: 'Start a new chat' },
  { name: 'rename', args: '<title>', description: 'Rename this chat', needsArg: true },
  {
    name: 'mode',
    args: 'orchestrated | swarm',
    description: 'Lead with specialists, or equal peers',
    needsArg: true,
  },
  {
    name: 'model',
    args: '<name>',
    description: 'Switch the lead model, right away if a round is running',
    needsArg: true,
  },
  {
    name: 'thinking',
    args: 'low | medium | high | auto',
    description: 'How hard reasoning models think in work rounds',
    needsArg: true,
  },
  { name: 'team', description: 'Open the team and model picker' },
  { name: 'attach', description: 'Attach files to your next message' },
  { name: 'export', description: 'Download this chat as Markdown' },
  { name: 'mcp', description: 'Manage MCP servers' },
  { name: 'settings', description: 'Open settings' },
  { name: 'help', description: 'List the commands' },
]

/** `/name rest` → the command and its argument; undefined for ordinary text or an unknown name. */
export function parseSlash(text: string): { command: SlashCommand; arg: string } | undefined {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  const command = m && SLASH_COMMANDS.find((c) => c.name === m[1])
  return command ? { command, arg: (m?.[2] ?? '').trim() } : undefined
}

/** Commands matching what has been typed after the slash, for the menu. */
export function matchSlash(text: string): SlashCommand[] {
  const m = /^\/([a-z]*)$/.exec(text)
  if (!m) return []
  const typed = m[1] ?? ''
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(typed))
}
