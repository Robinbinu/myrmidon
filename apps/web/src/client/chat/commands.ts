/**
 * Slash commands typed in the composer, modelled on omp's: one line, run instead of being sent. Like omp's, a command
 * can offer completions for its argument (`/model ` lists models, `/mode ` the two modes).
 */

import type { PluginCommand } from '@myrmidon/protocol'
import { copy } from '../copy.ts'

export type CommandGroup = 'Round' | 'Workflows' | 'Team & model' | 'Chat' | 'App' | 'Plugins'
export const GROUPS: readonly CommandGroup[] = [
  'Round',
  'Workflows',
  'Team & model',
  'Chat',
  'App',
  'Plugins',
]

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
  /** A plugin's command: sends this prompt, with the argument in place, instead of running app code. */
  readonly prompt?: string
  /**
   * A workflow: one of the skills Myrmidon comes with (review, ship...). Sends the message this makes from the
   * argument, which asks the agent to follow that skill. A plugin's command of the same name takes its place.
   */
  readonly workflow?: (arg: string) => string
}

/** The skills Myrmidon comes with that have a command of their own, in menu order. */
const WORKFLOWS = ['review', 'ship', 'qa', 'investigate', 'retro'] as const

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'plan',
    args: copy.commands.list.plan.args,
    description: copy.commands.list.plan.description,
    needsArg: true,
    group: 'Round',
  },
  {
    name: 'goal',
    args: copy.commands.list.goal.args,
    description: copy.commands.list.goal.description,
    needsArg: true,
    group: 'Round',
  },
  {
    name: 'steer',
    args: copy.commands.list.steer.args,
    description: copy.commands.list.steer.description,
    needsArg: true,
    group: 'Round',
    when: 'running',
  },
  {
    name: 'queue',
    args: copy.commands.list.queue.args,
    description: copy.commands.list.queue.description,
    needsArg: true,
    group: 'Round',
    when: 'running',
  },
  { name: 'stop', description: copy.commands.list.stop.description, group: 'Round', when: 'running' },
  {
    name: 'resume',
    description: copy.commands.list.resume.description,
    group: 'Round',
    when: 'resumable',
  },
  { name: 'retry', description: copy.commands.list.retry.description, group: 'Round', when: 'idle' },
  ...WORKFLOWS.map(
    (name): SlashCommand => ({
      name,
      args: copy.commands.list[name].args,
      description: copy.commands.list[name].description,
      ...(name === 'investigate' ? { needsArg: true } : {}),
      group: 'Workflows',
      workflow: copy.commands.list[name].send,
    }),
  ),
  {
    name: 'model',
    args: copy.commands.list.model.args,
    description: copy.commands.list.model.description,
    needsArg: true,
    group: 'Team & model',
  },
  {
    name: 'mode',
    args: 'orchestrated | swarm',
    description: copy.commands.list.mode.description,
    needsArg: true,
    group: 'Team & model',
    options: [
      {
        value: 'orchestrated',
        label: copy.commands.list.mode.options.orchestrated.label,
        description: copy.commands.list.mode.options.orchestrated.description,
      },
      {
        value: 'swarm',
        label: copy.commands.list.mode.options.swarm.label,
        description: copy.commands.list.mode.options.swarm.description,
      },
    ],
  },
  {
    name: 'thinking',
    args: 'low | medium | high | auto',
    description: copy.commands.list.thinking.description,
    needsArg: true,
    group: 'Team & model',
    options: [
      {
        value: 'auto',
        label: copy.commands.list.thinking.options.auto.label,
        description: copy.commands.list.thinking.options.auto.description,
      },
      {
        value: 'low',
        label: copy.commands.list.thinking.options.low.label,
        description: copy.commands.list.thinking.options.low.description,
      },
      {
        value: 'medium',
        label: copy.commands.list.thinking.options.medium.label,
        description: copy.commands.list.thinking.options.medium.description,
      },
      {
        value: 'high',
        label: copy.commands.list.thinking.options.high.label,
        description: copy.commands.list.thinking.options.high.description,
      },
    ],
  },
  { name: 'team', description: copy.commands.list.team.description, group: 'Team & model' },
  { name: 'new', description: copy.commands.list.new.description, group: 'Chat' },
  {
    name: 'rename',
    args: copy.commands.list.rename.args,
    description: copy.commands.list.rename.description,
    needsArg: true,
    group: 'Chat',
    when: 'chat',
  },
  { name: 'attach', description: copy.commands.list.attach.description, group: 'Chat' },
  {
    name: 'export',
    args: 'md | html | share',
    description: copy.commands.list.export.description,
    group: 'Chat',
    when: 'chat',
    options: (['md', 'html', 'share'] as const).map((value) => ({
      value,
      label: copy.commands.list.export.options[value].label,
      description: copy.commands.list.export.options[value].description,
    })),
  },
  { name: 'family', description: copy.commands.list.family.description, group: 'Chat', when: 'chat' },
  { name: 'learn', description: copy.commands.list.learn.description, group: 'Chat', when: 'chat' },
  { name: 'fresh', description: copy.commands.list.fresh.description, group: 'Chat', when: 'chat' },
  {
    name: 'rule',
    args: copy.commands.list.rule.args,
    description: copy.commands.list.rule.description,
    needsArg: true,
    group: 'Chat',
    when: 'chat',
  },
  { name: 'mcp', description: copy.commands.list.mcp.description, group: 'App' },
  { name: 'settings', description: copy.commands.list.settings.description, group: 'App' },
  { name: 'help', description: copy.commands.list.help.description, group: 'App' },
]

export interface SlashContext {
  readonly running: boolean
  readonly chat: boolean
  /** The chat's latest round stopped before finishing. */
  readonly resumable: boolean
}

let fromPlugins: SlashCommand[] = []

/**
 * The enabled plugins' commands join the menu; a built-in command keeps its name, except a workflow, which gives way to
 * a plugin's command of its name (the person installed that one).
 */
export function setPluginCommands(commands: readonly PluginCommand[]) {
  const taken = new Set(SLASH_COMMANDS.filter((c) => !c.workflow).map((c) => c.name))
  fromPlugins = commands
    .filter((c) => !taken.has(c.name))
    .map((c) => ({
      name: c.name,
      description: c.description || copy.commands.fromPlugin(c.plugin),
      ...(c.argumentHint ? { args: c.argumentHint, needsArg: true } : {}),
      group: 'Plugins' as const,
      prompt: c.prompt,
    }))
}

/** Every command the menu offers: the app's own, then the plugins'. */
export function allCommands(): readonly SlashCommand[] {
  const plugins = new Set(fromPlugins.map((c) => c.name))
  return [...SLASH_COMMANDS.filter((c) => !(c.workflow && plugins.has(c.name))), ...fromPlugins]
}

/** Why a command can't run now, or undefined when it can. */
export function unavailable(command: SlashCommand, ctx: SlashContext): string | undefined {
  switch (command.when) {
    case 'running':
      return ctx.running ? undefined : copy.commands.unavailable.notRunning
    case 'idle':
      return !ctx.chat
        ? copy.commands.unavailable.noChat
        : ctx.running
          ? copy.commands.unavailable.waitForRound
          : undefined
    case 'chat':
      return ctx.chat ? undefined : copy.commands.unavailable.noChat
    case 'resumable':
      return ctx.resumable && !ctx.running ? undefined : copy.commands.unavailable.nothingToResume
    default:
      return undefined
  }
}

/** `/name rest` → the command and its argument; undefined for ordinary text or an unknown name. */
export function parseSlash(text: string): { command: SlashCommand; arg: string } | undefined {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  const command = m && allCommands().find((c) => c.name === m[1])
  return command ? { command, arg: (m?.[2] ?? '').trim() } : undefined
}

/**
 * Where the composer's text is in a command: choosing a name (`/mo`), or giving a known command its argument
 * (`/model cla`). Undefined for ordinary text.
 */
export function slashStage(
  text: string,
): { stage: 'name'; query: string } | { stage: 'arg'; command: SlashCommand; query: string } | undefined {
  const name = /^\/([a-z0-9-]*)$/.exec(text)
  if (name) return { stage: 'name', query: name[1] ?? '' }
  const arg = /^\/([a-z][a-z0-9-]*) ([^\n]*)$/.exec(text)
  const command = arg && allCommands().find((c) => c.name === arg[1])
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
 * Commands for what was typed after the slash: the command of exactly that name first (so `/mode` never runs
 * `/model`), then name prefixes, then other names containing the letters in order, then commands whose description
 * mentions the word. Commands that can't run now sink below the rest, except an exact name.
 */
export function rankCommands(query: string, ctx: SlashContext): RankedCommand[] {
  const scored: { ranked: RankedCommand; score: number }[] = []
  for (const command of allCommands()) {
    const reason = unavailable(command, ctx)
    const prefix = command.name.startsWith(query)
    const inName = prefix ? undefined : fuzzy(query, command.name)
    const inText =
      !prefix && !inName && query.length >= 3 && command.description.toLowerCase().includes(query)
    if (!prefix && !inName && !inText) continue
    const matches = prefix ? [...query].map((_, i) => i) : (inName ?? [])
    const score = command.name === query ? -1 : (prefix ? 0 : inName ? 1 : 2) + (reason ? 10 : 0)
    scored.push({ ranked: { command, matches, ...(reason ? { unavailable: reason } : {}) }, score })
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.ranked)
}

export type MenuSection = 'recent' | CommandGroup | 'unavailable'

/**
 * Every command, for the menu before anything is typed: the recent ones that can run, then each group's other
 * commands that can run, then all that can't run now. Each command appears once.
 */
export function menuSections(
  ctx: SlashContext,
  recent: readonly string[],
): { section: MenuSection; commands: SlashCommand[] }[] {
  const all = allCommands()
  const ready = all.filter((c) => !unavailable(c, ctx))
  const recentReady = recent.flatMap((n) => ready.filter((c) => c.name === n))
  const sections: { section: MenuSection; commands: SlashCommand[] }[] = [
    { section: 'recent', commands: recentReady },
    ...GROUPS.map((group) => ({
      section: group,
      commands: ready.filter((c) => c.group === group && !recentReady.includes(c)),
    })),
    { section: 'unavailable', commands: all.filter((c) => !ready.includes(c)) },
  ]
  return sections.filter((s) => s.commands.length > 0)
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
