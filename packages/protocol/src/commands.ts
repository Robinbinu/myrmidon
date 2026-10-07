/** A slash command a plugin adds: typed as `/<name>`, it sends its prompt instead (Claude Code's command format). */
export interface PluginCommand {
  readonly name: string
  readonly plugin: string
  readonly description: string
  /** Shown after the name, e.g. `<file>`. */
  readonly argumentHint?: string
  /** The prompt sent in its place; `$ARGUMENTS` (and `$1`, `$2`…) stand for what follows the name. */
  readonly prompt: string
}

/** What a command sends: its prompt with what was typed after the name in place. */
export function expandCommand(command: Pick<PluginCommand, 'prompt'>, args: string): string {
  const words = args.trim().split(/\s+/).filter(Boolean)
  return command.prompt
    .replaceAll('$ARGUMENTS', args.trim())
    .replace(/\$(\d+)/g, (_, n: string) => words[Number(n) - 1] ?? '')
}
