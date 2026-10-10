import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import type { StreamFn } from '@oh-my-pi/pi-agent-core'
import type { AssistantMessage, AssistantMessageEvent, Message, ToolCall } from '@oh-my-pi/pi-ai'
import { AssistantMessageEventStream } from '@oh-my-pi/pi-ai/utils/event-stream'
import {
  parseRuleAgents,
  parseRuleConditionAndScope,
  type Rule,
  type RuleFrontmatter,
  ruleAppliesToAgent,
} from '@oh-my-pi/pi-coding-agent/capability/rule'
import {
  type TtsrCheckOptions,
  TtsrManager,
  type TtsrMatchContext,
} from '@oh-my-pi/pi-coding-agent/export/ttsr'
import { sanitizeRuleName } from '@oh-my-pi/pi-coding-agent/modes/controllers/omfg-rule'
import { type TtsrTool, TtsrToolInspector } from '@oh-my-pi/pi-coding-agent/session/ttsr-outputs'
import { parseFrontmatter } from '@oh-my-pi/pi-utils/frontmatter'
import { RULE_FILE_MAX_BYTES, RULES_MAX_FILES } from './config.ts'
import { prompts } from './prompts.ts'
import { readProjectStreamRules } from './rule-files.ts'

/**
 * Stream rules: omp's Time Traveling Stream Rules (TTSR). A rule is a Markdown file whose frontmatter `condition` is a
 * regular expression watched against what an agent writes as the model streams it (its prose, its reasoning, or a
 * tool call's arguments, as `scope` says). When it matches, the reply is stopped before it lands, the rule's body is
 * added to the request as guidance, and the same request is sent again, so a known mistake never reaches a file, a
 * command or the person.
 *
 * The rule format, its matching and the guidance are omp 18.8.7's, used as a library where it exports them
 * (capability/rule.ts parses triggers and scope, export/ttsr.ts `TtsrManager` buffers and matches the stream,
 * session/ttsr-outputs.ts reads tool calls); the retry itself is a port of session/ttsr-coordinator.ts to Myrmidon's
 * stream function (see `StreamRuleGuard`). Only `condition` rules are enforced: omp's `astCondition` (ast-grep) and
 * `question` (a judge model) are not, and a rule with only those is left out.
 *
 * Rules are files the person writes, like skills: their own in `<home>/rules/*.md` for every chat, and a project's
 * in its `.myrmidon/rules/` (or any rule folder another tool reads, rule-files.ts, so omp's `.omp/rules` work as-is).
 * Unlike hooks they run nothing, so a project's own rules are read too.
 */

export type StreamRule = Rule

/** Where a rule came from, for the person: theirs (every chat) or the project's. */
export type StreamRuleScope = 'person' | 'project'

/**
 * omp's `buildRule` (discovery/helpers.ts) with its frontmatter parser quiet, as rule-files.ts reads rules: a broken
 * file is skipped, not logged on every turn. Undefined when it is switched off or has no `condition` to enforce.
 */
export function parseStreamRule(
  name: string,
  source: string,
  path: string,
  level: 'user' | 'project',
): StreamRule | undefined {
  const { frontmatter, body } = parseFrontmatter(source, { source: path, level: 'off' })
  const fm = frontmatter as RuleFrontmatter
  if (fm.enabled === false) return undefined
  const { condition, astCondition, question, scope } = parseRuleConditionAndScope(fm)
  if (!condition?.length) return undefined
  const mode = fm.interruptMode
  const agents = parseRuleAgents(fm.agents)
  return {
    name,
    path,
    content: body.trim(),
    ...(typeof fm.description === 'string' ? { description: fm.description } : {}),
    condition,
    ...(astCondition ? { astCondition } : {}),
    ...(question ? { question } : {}),
    ...(scope ? { scope } : {}),
    ...(agents ? { agents } : {}),
    ...(mode === 'never' || mode === 'prose-only' || mode === 'tool-only' || mode === 'always'
      ? { interruptMode: mode }
      : {}),
    _source: { provider: 'myrmidon', providerName: 'Myrmidon', path, level },
  }
}

/** Whether omp's manager takes the rule: its conditions compile and its scope reaches some stream. */
export function enforceable(rule: StreamRule): boolean {
  return new TtsrManager().addRule(rule)
}

export class StreamRuleStore {
  /** The person's own rules, for every chat. */
  readonly dir: string

  constructor(home: string) {
    this.dir = join(home, 'rules')
  }

  /**
   * The rules agents keep to: a project's first (its own, then other tools' rule folders), then the person's; of two
   * with one name, the first wins, as a project's rule overrides a personal one in omp.
   */
  list(project?: string): StreamRule[] {
    const out = new Map<string, StreamRule>()
    const add = (rule: StreamRule | undefined) => {
      if (rule && !out.has(rule.name)) out.set(rule.name, rule)
    }
    if (project && existsSync(project))
      for (const file of readProjectStreamRules(project))
        add(parseStreamRule(file.name, file.source, file.path, 'project'))
    for (const file of this._files()) {
      try {
        add(parseStreamRule(file.name, readFileSync(file.path, 'utf8'), file.path, 'user'))
      } catch {
        // A file removed or unreadable since it was listed is not a rule now.
      }
    }
    return [...out.values()]
  }

  /** Saves a rule's file for the person (every chat) or in the project; returns where it went. */
  write(name: string, text: string, where: StreamRuleScope, project?: string): string {
    const safe = sanitizeRuleName(name)
    if (!safe) throw new Error('a rule needs a name with a letter or digit')
    if (where === 'project' && !project) throw new Error('this chat has no project to save the rule in')
    const dir = where === 'project' ? join(project as string, '.myrmidon', 'rules') : this.dir
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${safe}.md`)
    writeFileSync(`${path}.tmp`, text.endsWith('\n') ? text : `${text}\n`)
    renameSync(`${path}.tmp`, path)
    return path
  }

  /** Where a rule of this name would be saved, and whether one is there already. */
  target(name: string, where: StreamRuleScope, project?: string): { path: string; exists: boolean } {
    const dir = where === 'project' && project ? join(project, '.myrmidon', 'rules') : this.dir
    const path = join(dir, `${sanitizeRuleName(name)}.md`)
    return { path, exists: existsSync(path) }
  }

  private _files(): { name: string; path: string }[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => /\.mdc?$/.test(f) && !f.startsWith('.'))
      .sort()
      .slice(0, RULES_MAX_FILES)
      .flatMap((f) => {
        const path = join(this.dir, f)
        try {
          const real = realpathSync.native(path)
          const stat = statSync(real)
          return stat.isFile() && stat.size <= RULE_FILE_MAX_BYTES
            ? [{ name: f.replace(/\.mdc?$/, ''), path: real }]
            : []
        } catch {
          return []
        }
      })
  }
}

/** One rule stopping a reply. */
export interface StreamRuleFire {
  readonly rule: StreamRule
  /** Where it matched: the agent's prose, its reasoning, or a tool call's arguments. */
  readonly source: TtsrMatchContext['source']
  readonly tool?: string
  /** The rule's file, as the person would find it. */
  readonly path: string
}

/**
 * How a tool call reads to a rule, after omp's `matcherDigest` hooks on its edit and write tools: what the call
 * writes, not its JSON. Other tools are matched as their serialized arguments, as in omp.
 */
const text = (key: string) => (args: unknown) => {
  const value = (args as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'string' ? value : undefined
}
const DIGESTS: Record<string, (args: unknown) => string | undefined> = {
  fs_write: text('content'),
  fs_edit: text('new'),
  shell: text('command'),
  reply_user: text('text'),
  reply_person: text('text'),
}
const TOOLS: readonly TtsrTool[] = Object.entries(DIGESTS).map(([name, matcherDigest]) => ({
  name,
  matcherDigest,
}))

/** Mid-stream checks may let a condition that can span lines wait; the end of a block settles it (omp). */
const PARTIAL: TtsrCheckOptions = { final: false }
const FINAL: TtsrCheckOptions = { final: true }

/**
 * One agent's stream rules, enforced inside its stream function: the one place every model call of the agent loop
 * passes (secret hiding and the model fallback hook in there too).
 *
 * omp aborts the whole agent run on a match and continues it with the guidance appended to the session
 * (ttsr-coordinator.ts). Here the retry stays inside the one model call instead: the agent loop sees a reply that
 * restarts (a second `start` event, which pi-agent-core takes as a new attempt replacing the partial one), so tool
 * calls the abandoned attempt began are never run, the round's queues and steering are untouched, and nothing
 * half-written is recorded. As in omp's default `discard` mode the abandoned text is dropped and only the guidance
 * goes into the retried request. The guidance is not kept in the conversation afterwards, so the rule stays armed:
 * a later step that makes the same mistake is stopped again, up to `retries` stops a turn.
 */
export class StreamRuleGuard {
  private _rules: readonly StreamRule[] = []
  private _left: number

  constructor(
    private readonly options: {
      /** Stops a turn may make; past them, replies pass unchecked until the next turn. */
      readonly retries: number
      /** Where the agent works, so a tool call's relative path matches a rule's file glob. */
      readonly cwd: () => string
      /** The project the round works in, to name a rule's file relative to it. */
      readonly project?: string
      readonly onFire: (fire: StreamRuleFire) => void
    },
  ) {
    this._left = options.retries
  }

  /** A new turn: the rules as they are now (a rule saved mid-round counts from here), and a fresh retry budget. */
  newTurn(rules: readonly StreamRule[]) {
    this._rules = rules
    this._left = this.options.retries
  }

  /** `inner` with the rules enforced: a request whose reply breaks one is stopped and sent again with its guidance. */
  wrap(inner: StreamFn): StreamFn {
    return async (model, context, options) => {
      const rules = this._rules
      if (rules.length === 0 || this._left <= 0) return inner(model, context, options)
      const out = new AssistantMessageEventStream()
      const first = await this._attempt(inner, model, context, options)
      void this._relay(inner, model, context, options, first, rules, out).catch((err) => out.fail(err))
      return out
    }
  }

  private async _attempt(
    inner: StreamFn,
    model: Parameters<StreamFn>[0],
    context: Parameters<StreamFn>[1],
    options: Parameters<StreamFn>[2],
  ) {
    // Its own abort, so a match stops the provider (the rest of the reply is not wanted) without aborting the run.
    const abort = new AbortController()
    const signal = options?.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal
    return { abort, stream: await inner(model, context, { ...options, signal }) }
  }

  private async _relay(
    inner: StreamFn,
    model: Parameters<StreamFn>[0],
    context: Parameters<StreamFn>[1],
    options: Parameters<StreamFn>[2],
    first: Awaited<ReturnType<StreamRuleGuard['_attempt']>>,
    rules: readonly StreamRule[],
    out: AssistantMessageEventStream,
  ) {
    let attempt = first
    let messages = context.messages
    // Each rule stops one request at most, as omp's default `repeatMode: once`: a reply that breaks it again after
    // its guidance is let through rather than retried without end.
    const stopped = new Set<string>()
    for (;;) {
      const manager = new TtsrManager()
      for (const rule of rules) if (!stopped.has(rule.name)) manager.addRule(rule)
      const watch = this._left > 0 && manager.hasRules()
      const inspector = new TtsrToolInspector(() => TOOLS, this.options.cwd)
      let hit: { rules: StreamRule[]; context: TtsrMatchContext } | undefined
      for await (const event of attempt.stream) {
        if (watch) {
          const found = check(manager, inspector, event)
          if (found && found.rules.length > 0) {
            hit = found
            break
          }
        }
        out.push(event)
      }
      if (!hit) {
        if (!out.done) out.end(await attempt.stream.result())
        return
      }
      attempt.abort.abort(new Error(`stream rule matched: ${hit.rules.map((r) => r.name).join(', ')}`))
      this._left -= 1
      for (const rule of hit.rules) {
        stopped.add(rule.name)
        this.options.onFire({
          rule,
          source: hit.context.source,
          ...(hit.context.toolName ? { tool: hit.context.toolName } : {}),
          path: this._display(rule.path),
        })
      }
      const guidance: Message = {
        role: 'user',
        content: hit.rules
          .map((r) =>
            prompts.streamRules.interrupt({ name: r.name, path: this._display(r.path), content: r.content }),
          )
          .join('\n\n'),
        timestamp: Date.now(),
      }
      messages = [...messages, guidance]
      attempt = await this._attempt(inner, model, { ...context, messages }, options)
    }
  }

  /** A rule's file relative to the project or the home folder, as omp names it in its guidance. */
  private _display(path: string): string {
    const within = (root: string | undefined) => {
      if (!root) return undefined
      const rel = relative(root, path)
      return rel && !rel.startsWith('..') && !rel.startsWith(sep) ? rel.split(sep).join('/') : undefined
    }
    const inProject = within(this.options.project)
    if (inProject) return inProject
    const inHome = within(homedir())
    return inHome ? `~/${inHome}` : path
  }
}

/** The rules for one agent: those whose `agents` name it (the lead also answers to omp's `main`), or every agent. */
export function rulesFor(rules: readonly StreamRule[], agent: string, lead: boolean): StreamRule[] {
  return rules.filter((r) => ruleAppliesToAgent(r, agent) || (lead && ruleAppliesToAgent(r, 'main')))
}

/**
 * Checks one streamed event against the rules (omp ttsr-coordinator.ts `checkMessageUpdate` and `#checkStream`),
 * returning the rules that should stop the reply. A rule whose `interruptMode` says not to stop this kind of output
 * lets it through: omp would remind the agent afterwards instead, which a retry inside the call cannot do.
 */
function check(
  manager: TtsrManager,
  inspector: TtsrToolInspector,
  event: AssistantMessageEvent,
): { rules: StreamRule[]; context: TtsrMatchContext } | undefined {
  let context: TtsrMatchContext
  let found: Rule[]
  switch (event.type) {
    case 'start':
      // A provider restarting its reply: the buffers describe the discarded attempt.
      manager.resetBuffer()
      return undefined
    case 'text_delta':
    case 'thinking_delta':
      context = { source: event.type === 'text_delta' ? 'text' : 'thinking' }
      found = manager.checkDelta(event.delta, context, PARTIAL)
      break
    case 'text_end':
    case 'thinking_end':
      if (event.content.length === 0) return undefined
      context = { source: event.type === 'text_end' ? 'text' : 'thinking' }
      found = manager.checkDelta('', context, FINAL)
      break
    case 'toolcall_delta': {
      const block = event.partial.content[event.contentIndex]
      const call = block?.type === 'toolCall' ? (block as ToolCall) : undefined
      context = inspector.matchContext(call, event.contentIndex)
      found = checkTool(manager, inspector, event.delta, context, call, false)
      break
    }
    case 'toolcall_end':
      context = inspector.matchContext(event.toolCall, event.contentIndex)
      found = checkTool(manager, inspector, '', context, event.toolCall, true)
      break
    default:
      return undefined
  }
  const rules = found.filter((rule) => interrupts(rule, context))
  return rules.length ? { rules, context } : undefined
}

function checkTool(
  manager: TtsrManager,
  inspector: TtsrToolInspector,
  delta: string,
  context: TtsrMatchContext,
  call: ToolCall | undefined,
  final: boolean,
): Rule[] {
  const options = final ? FINAL : PARTIAL
  const entries = inspector.entries(call)
  if (entries)
    return entries.flatMap((e) =>
      manager.checkSnapshot(e.digest, inspector.perFileContext(context, e.path), options),
    )
  const digest = inspector.digest(call)
  if (digest !== undefined) return manager.checkSnapshot(digest, context, options)
  // A provider that sends a call whole, with no deltas, leaves the delta buffer empty: the final arguments seed it.
  const args = final ? call?.arguments : undefined
  if (args !== undefined && args !== null)
    return manager.checkSnapshot(typeof args === 'string' ? args : JSON.stringify(args), context)
  return manager.checkDelta(delta, context, options)
}

/** omp's `#shouldInterrupt`, for one rule: `always` (the default) stops prose and tool calls alike. */
function interrupts(rule: Rule, context: TtsrMatchContext): boolean {
  const mode = rule.interruptMode ?? 'always'
  if (mode === 'always') return true
  if (mode === 'prose-only') return context.source === 'text' || context.source === 'thinking'
  if (mode === 'tool-only') return context.source === 'tool'
  return false
}

/** A finished reply as rules see it (omp's `TtsrToolInspector.outputs`), for checking a drafted rule against. */
export function replyOutputs(message: AssistantMessage, cwd: string) {
  return new TtsrToolInspector(
    () => TOOLS,
    () => cwd,
  ).outputs(message)
}
