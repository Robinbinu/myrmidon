import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { HOOK_MAX_OUTPUT, HOOK_MAX_TIMEOUT_S, HOOK_TIMEOUT_S } from './config.ts'
import { hostShell, shellEnv } from './shell.ts'

/**
 * The person's hooks: commands Myrmidon runs at fixed points (before a tool, after it, when a round ends), so a
 * rule holds every time instead of depending on an agent remembering it — "format after every edit", "never
 * touch .env". The format is Claude Code's, so hooks written for it work here: `<home>/hooks.json` holds
 * `{ "hooks": { "PreToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "…" }] }] } }`.
 * A hook gets the event as JSON on stdin; exit code 2 blocks the tool (before) or tells the agent (after).
 * Hooks run as the person, outside the sandbox, and only from the person's own config, never from a project.
 */

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Stop'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

export interface HookCommand {
  readonly type: 'command'
  readonly command: string
  /** Seconds, as in Claude Code; 60 by default. */
  readonly timeout?: number
}

export interface HookGroup {
  /** Tool names to match: a regular expression, `*` or empty for every tool. Ignored for Stop. */
  readonly matcher?: string
  readonly hooks: readonly HookCommand[]
}

export interface HooksConfig {
  readonly hooks: { readonly [E in HookEvent]?: readonly HookGroup[] }
}

export interface HookRun {
  readonly command: string
  readonly code: number
  readonly ms: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** What a set of hooks decided about one event. */
export interface HookOutcome {
  readonly runs: HookRun[]
  /** Before a tool: why it must not run. */
  readonly blocked?: string
  /** Before a tool: the hook wants the person to approve it. */
  readonly ask?: string
  /** After a tool: what the hooks want the agent to know. */
  readonly feedback: string[]
}

/** Claude Code's names for Myrmidon's tools, so its matchers (Bash, Edit|Write, …) work unchanged. */
const CLAUDE_NAMES: Record<string, string> = {
  shell: 'Bash',
  fs_read: 'Read',
  fs_write: 'Write',
  fs_edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  update_todo: 'TodoWrite',
}

export function matches(matcher: string | undefined, tool: string): boolean {
  const m = (matcher ?? '').trim()
  if (!m || m === '*') return true
  // Plain names and `mcp__*` style globs as well as regular expressions.
  const pattern = /^[\w|*-]+$/.test(m) ? m.replaceAll('*', '.*') : m
  let re: RegExp
  try {
    re = new RegExp(`^(?:${pattern})$`)
  } catch {
    return false
  }
  return re.test(tool) || (CLAUDE_NAMES[tool] !== undefined && re.test(CLAUDE_NAMES[tool]))
}

/** Keeps only well-formed hooks from a hooks file in Claude Code's format. */
export function checkedHooks(raw: unknown): HooksConfig {
  const hooks = (raw as { hooks?: unknown })?.hooks
  if (!hooks || typeof hooks !== 'object') return { hooks: {} }
  const out: Record<string, HookGroup[]> = {}
  for (const event of HOOK_EVENTS) {
    const groups = (hooks as Record<string, unknown>)[event]
    if (!Array.isArray(groups)) continue
    out[event] = groups.flatMap((g): HookGroup[] => {
      const group = g as { matcher?: unknown; hooks?: unknown }
      const commands = Array.isArray(group.hooks)
        ? group.hooks.flatMap((h): HookCommand[] => {
            const c = h as { type?: unknown; command?: unknown; timeout?: unknown }
            if (c.type !== 'command' || typeof c.command !== 'string' || !c.command.trim()) return []
            return [
              {
                type: 'command',
                command: c.command,
                ...(typeof c.timeout === 'number' && c.timeout > 0
                  ? { timeout: Math.min(c.timeout, HOOK_MAX_TIMEOUT_S) }
                  : {}),
              },
            ]
          })
        : []
      if (commands.length === 0) return []
      return [{ ...(typeof group.matcher === 'string' ? { matcher: group.matcher } : {}), hooks: commands }]
    })
  }
  return { hooks: out }
}

export class HookStore {
  private readonly _file: string

  constructor(
    home: string,
    /** Hooks the person's enabled plugins add, run after their own. */
    private readonly plugins: () => HooksConfig = () => ({ hooks: {} }),
  ) {
    this._file = join(home, 'hooks.json')
  }

  read(): HooksConfig {
    if (!existsSync(this._file)) return { hooks: {} }
    try {
      return checkedHooks(JSON.parse(readFileSync(this._file, 'utf8')))
    } catch {
      return { hooks: {} }
    }
  }

  /** Saves a config, keeping only well-formed hooks; returns what was saved. */
  write(raw: unknown): HooksConfig {
    const config = checkedHooks(raw)
    writeFileSync(`${this._file}.tmp`, `${JSON.stringify(config, null, 2)}\n`)
    renameSync(`${this._file}.tmp`, this._file)
    return config
  }

  /** The hooks that run: the person's own file, then their enabled plugins'. */
  active(): HooksConfig {
    const own = this.read().hooks
    const added = this.plugins().hooks
    const hooks: { [E in HookEvent]?: HookGroup[] } = {}
    for (const e of HOOK_EVENTS) {
      const groups = [...(own[e] ?? []), ...(added[e] ?? [])]
      if (groups.length) hooks[e] = groups
    }
    return { hooks }
  }

  /** Whether any hook listens for this event (so callers can skip building its input). */
  has(event: HookEvent): boolean {
    return (this.active().hooks[event]?.length ?? 0) > 0
  }
}

async function runCommand(
  hook: HookCommand,
  input: object,
  cwd: string,
  env: Record<string, string>,
): Promise<HookRun> {
  const started = Date.now()
  // Claude Code's hooks are shell commands; on Windows Git Bash runs them when installed (see shell.ts).
  const proc = Bun.spawn(hostShell().argv(hook.command), {
    cwd,
    stdin: new Blob([JSON.stringify(input)]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: shellEnv({ ...process.env, ...env }),
    windowsHide: true,
  })
  let timedOut = false
  const timer = setTimeout(
    () => {
      timedOut = true
      proc.kill()
    },
    (hook.timeout ?? HOOK_TIMEOUT_S) * 1000,
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return {
    command: hook.command,
    code: timedOut ? -1 : code,
    ms: Date.now() - started,
    stdout: stdout.slice(0, HOOK_MAX_OUTPUT),
    stderr: (timedOut ? `timed out after ${hook.timeout ?? HOOK_TIMEOUT_S}s\n${stderr}` : stderr).slice(
      0,
      HOOK_MAX_OUTPUT,
    ),
    timedOut,
  }
}

/** Claude Code's JSON reply on stdout: a permission decision before a tool, or `decision: block`. */
function decision(stdout: string): { kind?: 'allow' | 'deny' | 'ask' | 'block'; reason?: string } {
  const text = stdout.trim()
  if (!text.startsWith('{')) return {}
  try {
    const out = JSON.parse(text) as {
      decision?: unknown
      reason?: unknown
      hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown }
    }
    const p = out.hookSpecificOutput?.permissionDecision
    if (p === 'allow' || p === 'deny' || p === 'ask')
      return {
        kind: p,
        ...(typeof out.hookSpecificOutput?.permissionDecisionReason === 'string'
          ? { reason: out.hookSpecificOutput.permissionDecisionReason }
          : {}),
      }
    if (out.decision === 'block')
      return { kind: 'block', ...(typeof out.reason === 'string' ? { reason: out.reason } : {}) }
  } catch {
    // Plain output is not a decision.
  }
  return {}
}

/**
 * Runs the hooks that listen for `event` (and match `tool`), in order, and sums up what they decided. Before a
 * tool, the first block or ask wins and stops the rest.
 */
export async function runHooks(
  config: HooksConfig,
  event: HookEvent,
  tool: string | undefined,
  input: object,
  cwd: string,
  env: Record<string, string>,
): Promise<HookOutcome> {
  const runs: HookRun[] = []
  const feedback: string[] = []
  for (const group of config.hooks[event] ?? []) {
    if (tool !== undefined && !matches(group.matcher, tool)) continue
    for (const hook of group.hooks) {
      const run = await runCommand(hook, input, cwd, env)
      runs.push(run)
      const said = decision(run.stdout)
      const why = (run.stderr || said.reason || '').trim()
      if (event === 'PreToolUse') {
        if (run.code === 2 || said.kind === 'deny' || said.kind === 'block')
          return { runs, feedback, blocked: why || 'a hook blocked this tool call' }
        if (said.kind === 'ask')
          return { runs, feedback, ask: said.reason ?? 'a hook asks you to approve this' }
      } else if (run.code === 2 || said.kind === 'block') feedback.push(why || 'a hook flagged this result')
    }
  }
  return { runs, feedback }
}

/** The tool input a hook sees: Myrmidon's arguments, plus Claude Code's `file_path` for file tools. */
export function hookToolInput(input: unknown, workdir: string): Record<string, unknown> {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const path = typeof args.path === 'string' ? args.path : undefined
  return path ? { ...args, file_path: isAbsolute(path) ? path : resolve(workdir, path) } : args
}
