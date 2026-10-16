import { clockMinutes, localDate } from '../clock.ts'
import { RULES_MAX_LISTED } from '../config.ts'
import { prompts } from '../prompts.ts'
import { type CrewInfo, has, type PromptFacts, type ToolGroup } from './facts.ts'
import { FAMILY_BLOCKS } from './families.ts'

/**
 * Where a section sits for prompt caching, after Hermes' three tiers: `stable` depends only on the agent's role,
 * tools and settings, so it repeats byte for byte across rounds; `context` is the person's, the project's and
 * plugins' own text; `volatile` changes between rounds (the date, paths, the project's state).
 */
export type Tier = 'stable' | 'context' | 'volatile'

/**
 * The prompt's headings in reading order (the skeleton of docs/research/2026-10-09-harness-prompts.md §4.3), each in
 * one tier, with how its sections join: rules join line by line, paragraphs with a blank line.
 */
export const HEADINGS = {
  you: { tier: 'stable', join: '\n' },
  finish: { tier: 'stable', join: '\n' },
  safety: { tier: 'stable', join: '\n' },
  method: { tier: 'stable', join: '\n\n' },
  others: { tier: 'stable', join: '\n' },
  person: { tier: 'stable', join: '\n' },
  instructions: { tier: 'context', join: '\n\n' },
  plugins: { tier: 'context', join: '\n\n' },
  environment: { tier: 'volatile', join: '\n' },
} as const satisfies Record<keyof typeof prompts.system.headings, { tier: Tier; join: string }>

export type HeadingKey = keyof typeof HEADINGS

/**
 * One guarded piece of an agent's system prompt, after Gemini CLI's `withSection(key, factory, guard)` and the
 * OpenHands section registry: `guard` says whether it applies to this agent at all, `render` writes it from the
 * facts with words from prompts.ts. `version` goes up whenever its words change, so a run's log says which prompt
 * an agent had. Its heading decides its tier.
 */
export interface Section {
  readonly key: string
  readonly heading: HeadingKey
  readonly version: number
  readonly guard: (f: PromptFacts) => boolean
  readonly render: (f: PromptFacts) => string
}

export const tierOf = (s: Section): Tier => HEADINGS[s.heading].tier

const any = (f: PromptFacts, ...tools: string[]) => tools.some((t) => has(f, t))
const team = (f: PromptFacts) => f.mode.size > 1
const crewmate = (f: PromptFacts) => f.agent.kind === 'crewmate'
const project = (f: PromptFacts) => f.access.project
const say = prompts.system

const groupWords = (groups: readonly ToolGroup[]) => groups.map((g) => prompts.capabilities.groups[g])

const crewLines = (crew: readonly CrewInfo[], fallback: (c: CrewInfo) => string) =>
  crew
    .map((c) =>
      prompts.capabilities.crewLine({
        name: c.name,
        what: c.specialty ?? fallback(c),
        model: c.model,
        tools: groupWords(c.tools),
      }),
    )
    .join('\n')

function roster(f: PromptFacts): string {
  return crewLines(f.mode.roster, (c) => c.role) || prompts.capabilities.noCrew
}

/** "a, b and c" (or "a, b or c") */
const list = (items: readonly string[], and = 'and') =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`

/** The round from this agent's point of view: its role decides, not the round's tier alone. */
function roundLine(f: PromptFacts): string {
  const modes = prompts.capabilities.modes
  const { kind } = f.agent
  if (kind === 'answer') return modes.answer
  if (kind === 'crewmate') return modes.crewmate(f.agent.lead)
  if (kind === 'solo' && has(f, 'ask_crewmate')) return modes.soloCrew(f.mode.crewmatesOnCall.length)
  if (f.mode.tier === 'solo' || (f.mode.chat && f.mode.size === 1)) return modes.solo
  if (f.mode.team === 'swarm') return modes.swarm(f.mode.size)
  if (f.mode.team) return modes.orchestrated(f.mode.size - 1)
  return modes.colony(f.mode.pattern, f.mode.size)
}

/** What the agent can do, one clause per tool group it really has; deferred tools say how to load them. */
function abilities(f: PromptFacts): string[] {
  const can = prompts.capabilities
  const load = (tool: string, query: string) => (f.tools.deferred.includes(tool) ? can.load(query) : '')
  const { access } = f
  return [
    has(f, 'web_search') && (access.web ? can.web : can.noWeb),
    has(f, 'shell') &&
      (access.fullAccess
        ? can.shellFull
        : access.sandbox !== 'none'
          ? can.shell(access.sandbox)
          : can.noShell),
    has(f, 'publish_artifact') && can.publish,
    has(f, 'browser_open') &&
      (access.browser
        ? `${can.browser}${has(f, 'publish_artifact') ? can.browserPublished : ''}${load('browser_open', 'browser')}`
        : can.noBrowser),
    has(f, 'mcp') && `${can.mcp}${has(f, 'browser_open') ? can.mcpBrowser : ''}`,
    has(f, 'computer') && access.computer && `${can.computer}${load('computer', 'computer')}`,
    has(f, 'desktop') && access.computer && `${can.desktop}${load('desktop', 'desktop')}`,
    has(f, 'ssh') && access.remotes.length > 0 && `${can.ssh(access.remotes)}${load('ssh', 'ssh')}`,
    has(f, 'autoresearch') && `${can.autoresearch}${load('autoresearch', 'autoresearch')}`,
    has(f, 'create_tool') &&
      access.sandbox !== 'none' &&
      `${can.makeTools}${load('create_tool', 'create_tool')}`,
    has(f, 'create_task') && can.createTasks,
    has(f, 'add_crewmate') && can.addWorkers,
    has(f, 'reply_user') && can.talk,
  ].filter((a): a is string => typeof a === 'string' && a.length > 0)
}

/** Tool groups a team lead's crewmates have and it does not, in a fixed order. */
function lacks(f: PromptFacts): ToolGroup[] {
  const crew = new Set(f.mode.roster.flatMap((c) => c.tools))
  return (['web', 'browser', 'shell', 'files', 'computer'] as const).filter(
    (g) => crew.has(g) && !f.agent.groups.includes(g),
  )
}

function roleBrief(f: PromptFacts): string {
  const { agent } = f
  const specialty = agent.specialty ? { specialty: agent.specialty } : {}
  switch (agent.kind) {
    case 'answer':
      return prompts.roles.answer({
        project: project(f) !== undefined && has(f, 'fs_read'),
        escalate: has(f, 'escalate') && f.mode.escalateTo.length > 0,
      })
    case 'crewmate':
      return prompts.roles.crewmate({ ...specialty, model: agent.model, lead: agent.lead })
    case 'solo':
      return has(f, 'ask_crewmate') && f.mode.crewmatesOnCall.length > 0
        ? prompts.roles.soloCrew
        : prompts.roles.solo
    case 'swarm-peer':
      return prompts.roles.swarmPeer({ peers: f.mode.size, ...specialty, roster: roster(f) })
    case 'team-lead': {
      const saved = crewLines(f.mode.specialists, (c) => c.role)
      return prompts.roles.chatLead({
        roster: roster(f),
        extra: f.mode.canAdd,
        ...(f.mode.team ? { workerModels: f.mode.workerModels } : {}),
        ...(saved ? { saved } : {}),
        lacks: list(groupWords(lacks(f)), 'or'),
        handsOn: agent.groups.length > 0,
      })
    }
    case 'colony-lead':
      return prompts.roles.lead(roster(f))
    case 'team-worker':
      return prompts.roles.chatWorker({
        ...specialty,
        model: agent.model,
        lead: agent.lead,
        reply: has(f, 'reply_person'),
      })
    case 'colony-worker':
      return prompts.roles.worker
    case 'colony-peer':
      return prompts.roles.peer
  }
}

/** What the agent's own brief is called, when it was delegated one. */
function brief(f: PromptFacts): 'job' | 'task' | undefined {
  const { kind } = f.agent
  if (kind === 'crewmate') return 'job'
  if (kind === 'team-worker' || kind === 'swarm-peer' || kind === 'colony-worker' || kind === 'colony-peer')
    return 'task'
  return undefined
}

function finish(f: PromptFacts): string {
  const end = say.finish
  switch (f.agent.kind) {
    case 'answer':
      return end.answer
    case 'solo':
      return end.solo
    case 'crewmate':
      return end.crewmate(f.agent.lead)
    case 'team-worker':
      return end.worker
    case 'swarm-peer':
      return end.peer
    case 'team-lead':
      return end.lead
    default:
      return end.colony
  }
}

/** The speaker sections apply to the agent that answers the person in a chat round. */
const speaker = (f: PromptFacts) => f.mode.chat && f.agent.speaks && has(f, 'reply_user')
/** An agent that makes things the person asked for, itself or through tasks: scoping questions are about this. */
const builds = (f: PromptFacts) => any(f, 'publish_artifact', 'fs_write', 'create_task')

function reviewNote(f: PromptFacts): string {
  const { setting } = f.review
  return setting === 'off'
    ? prompts.review.off
    : setting === 'auto'
      ? prompts.review.auto
      : prompts.review.always
}

/** What returns outside content to this agent, in words (not tool names, which differ per agent). */
function outsideSources(f: PromptFacts): string[] {
  return [
    any(f, 'web_search', 'web_fetch') && 'web results and pages saved under web/',
    f.tools.names.some((t) => t.startsWith('browser_')) && 'browser pages',
    has(f, 'mcp') && 'MCP tool results',
    has(f, 'ssh') && 'what remote hosts return',
  ].filter((s): s is string => typeof s === 'string')
}

/** The verification bullets this agent has the tools for (§4.6). */
function verifyBullets(f: PromptFacts): string[] {
  const v = say.verify
  const shell = has(f, 'shell') && f.access.sandbox !== 'none'
  const checks = has(f, 'run_checks') && f.context.checks.length > 0
  return [
    (shell || checks) && v.code(checks),
    ['browser_open', 'browser_console', 'browser_screenshot'].every((t) => has(f, t)) &&
      f.access.browser &&
      v.page,
    shell && v.script,
    has(f, 'web_search') && f.access.web && v.research,
    f.agent.kind === 'team-worker' &&
      project(f) !== undefined &&
      f.review.verifier &&
      (shell || checks) &&
      v.team,
  ].filter((s): s is string => typeof s === 'string')
}

/** The ranked working method (§4.5), numbered, each item only where its tools exist. */
function method(f: PromptFacts): string {
  const m = say.method
  const job = brief(f)
  const items = [
    m.goal,
    has(f, 'update_todo') && m.todo,
    m.parallel,
    has(f, 'fs_read') && m.read,
    any(f, 'shell') && ['fs_read', 'grep', 'glob', 'fs_edit'].every((t) => has(f, t)) && m.dedicated,
    m.failures,
    verifyBullets(f).length > 0 && m.verify,
    m.recheck(job === 'job' ? m.briefJob : job === 'task' ? m.briefTask : m.briefRequest),
  ].filter((s): s is string => typeof s === 'string')
  return [m.head, ...items.map((item, i) => `${i + 1}. ${item}`)].join('\n')
}

function leadMethod(f: PromptFacts): string {
  const l = say.lead
  return [
    l.size,
    l.assign(has(f, 'add_crewmate')),
    l.brief,
    l.running,
    l.check(has(f, 'read_log')),
    project(f) !== undefined && f.review.verifier && l.checks,
    l.avoid,
    l.keep(has(f, 'dismiss_crewmate')),
  ]
    .filter((s): s is string => typeof s === 'string')
    .join('\n')
}

/** Where commands may write, in words. */
function writes(f: PromptFacts): string {
  const s = say.safety
  if (f.access.worktree) return s.writesWorktree
  return project(f) && f.access.preset !== 'read-only' ? s.writesProject : s.writesScratch
}

const env = prompts.environment

const OS: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }

/** Where commands and file tools may write, as the environment block lists it. */
function writeRoots(f: PromptFacts): string {
  if (f.access.worktree) return 'worktree, scratch'
  return project(f) && f.access.preset !== 'read-only' ? 'project, scratch' : 'scratch'
}

/** Where this agent's shell starts, in words. */
function shellStart(f: PromptFacts): string {
  return f.access.worktree ? 'your worktree' : project(f) ? 'the project folder' : 'your scratch directory'
}

/** The working directory and scratch lines, for an agent with file tools or a shell. */
function places(f: PromptFacts): string[] {
  const p = project(f)
  const { scratch, git } = f.env
  if (p && f.access.worktree)
    return [
      env.worktree({
        name: p.name,
        workdir: f.access.worktree.path,
        branch: f.access.worktree.branch,
        path: p.path,
        ...(f.access.worktree.copy ? { copy: true } : {}),
        ...(git?.branch ? { base: git.branch } : {}),
      }),
      ...(scratch ? [env.scratch(scratch)] : []),
    ]
  if (p)
    return [
      env.project({ name: p.name, path: p.path, ...(git ? { git } : {}) }),
      ...(scratch ? [env.scratch(scratch)] : []),
    ]
  return scratch ? [env.scratchOnly(scratch)] : []
}

/**
 * The facts of where the agent runs, as one tagged block (§4.10): time, model and machine, sandbox, the round's limits
 * and reviewer, where it works, and its shell.
 */
function environment(f: PromptFacts): string {
  const files = f.tools.names.some((t) => t.startsWith('fs_') || t === 'grep' || t === 'glob')
  const shell = has(f, 'shell')
  const runtimes = f.env.runtimes
  const lines = [
    env.today({
      date: localDate(f.env.now),
      weekday: f.env.now.toLocaleDateString('en-US', { weekday: 'long' }),
      time: clockMinutes(f.env.now),
      zone: f.env.zone,
      log: has(f, 'read_log'),
    }),
    env.machine({ model: f.model.ref, os: OS[f.env.platform] ?? f.env.platform }),
    // Only an agent that writes is told where it may write; reading limits are under Safety.
    (shell || any(f, 'fs_write', 'fs_edit')) &&
      (f.access.fullAccess
        ? env.fullAccess
        : env.sandbox({
            kind: f.access.sandbox !== 'none' ? f.access.sandbox : 'none, so no shell',
            writes: writeRoots(f),
          })),
    env.budget({ minutes: Math.round(f.env.budget.wallMs / 60_000), turns: f.env.budget.maxTurns }),
    // The final answer's reviewer matters to whoever may send it.
    has(f, 'reply_user') &&
      env.reviewer({ setting: f.review.setting, ...(f.review.judge ? { judge: f.review.judge } : {}) }),
    ...(shell || files ? places(f) : []),
    shell &&
      (f.access.fullAccess
        ? env.shellFull({ start: shellStart(f), runtimes })
        : f.access.sandbox !== 'none' && env.shell({ start: shellStart(f), runtimes })),
    // Only Windows has a choice of shells, and agents assume sh unless told.
    shell && f.env.platform === 'win32' && f.env.shell && env.shellSyntax(f.env.shell),
    f.env.boundary !== undefined && outsideSources(f).length > 0 && env.untrusted(f.env.boundary),
  ].filter((s): s is string => typeof s === 'string')
  return `<environment>\n${lines.join('\n')}\n</environment>`
}

/** A skill as one line: its name and the first sentence of what it is for. */
function skillLine(s: { name: string; description: string }): string {
  const first = s.description.split(/(?<=[.!?])\s/)[0] ?? s.description
  return `- ${s.name}: ${first.length > 160 ? `${first.slice(0, 157)}…` : first}`
}

/** A project rule as one line: its name, what it is for, and the file that holds it, after omp's <domain-rules>. */
function ruleLine(r: PromptFacts['context']['rules'][number]): string {
  const about =
    r.description && r.description.length > 160 ? `${r.description.slice(0, 157)}…` : r.description
  return prompts.system.context.ruleLine(r.name, r.file, r.globs ?? [], about)
}

type Rule = Omit<Section, 'heading' | 'version'> & { version?: number }
const under = (heading: HeadingKey, rules: Rule[]): Section[] =>
  rules.map((r) => ({ version: 1, ...r, heading }))

/** Every section, in the order the prompt reads; `assemble` keeps this order within each tier. */
export const SECTIONS: readonly Section[] = [
  ...under('you', [
    { key: 'identity', guard: () => true, render: (f) => say.identity(f.agent.name) },
    { key: 'round', guard: () => true, render: (f) => prompts.capabilities.round(roundLine(f)) },
    { key: 'role', version: 2, guard: () => true, render: roleBrief },
    // For agents that answer the person or plan for others; the rest find their tools in their schemas.
    {
      key: 'abilities',
      guard: (f) => (f.agent.speaks || !f.mode.chat) && abilities(f).length > 0,
      render: (f) => prompts.capabilities.can(abilities(f).join('; ')),
    },
    {
      key: 'precedence',
      guard: (f) => f.mode.chat,
      render: (f) => {
        const b = brief(f)
        return say.precedence(b === 'job' ? 'job text' : b === 'task' ? 'task text' : undefined)
      },
    },
  ]),
  ...under('finish', [
    { key: 'finish', version: 2, guard: () => true, render: finish },
    { key: 'contract', guard: (f) => f.agent.works, render: () => say.contract },
    { key: 'honest', guard: (f) => !f.agent.works && f.agent.kind === 'team-lead', render: () => say.honest },
    {
      key: 'verifier',
      guard: (f) => team(f) && !crewmate(f) && f.review.verifier,
      render: () => say.verifier,
    },
    { key: 'review', version: 2, guard: speaker, render: reviewNote },
    {
      key: 'review-tasks',
      guard: (f) => has(f, 'submit_task') && f.agent.kind !== 'team-lead',
      render: (f) => prompts.review.tasks(f.review.taskJudge),
    },
  ]),
  ...under('safety', [
    {
      key: 'untrusted',
      version: 2,
      guard: (f) => f.env.boundary !== undefined && outsideSources(f).length > 0,
      render: (f) => say.safety.untrusted(list(outsideSources(f))),
    },
    { key: 'refusals', guard: () => true, render: () => say.safety.refusals },
    {
      key: 'irreversible',
      guard: (f) => any(f, 'shell', 'fs_write', 'browser_open', 'computer', 'desktop', 'mcp'),
      render: (f) =>
        say.safety.irreversible(has(f, 'ask_user') ? say.safety.askPerson : say.safety.askNobody),
    },
    { key: 'credentials', guard: () => true, render: (f) => say.safety.credentials(has(f, 'request_login')) },
    {
      key: 'secret-placeholders',
      guard: (f) => f.access.secretsHidden === true,
      render: () => say.safety.placeholders,
    },
    {
      key: 'sandbox',
      version: 2,
      guard: (f) => !f.access.fullAccess && any(f, 'shell', 'fs_read'),
      render: (f) =>
        say.safety.sandbox({
          ...(has(f, 'shell') && f.access.sandbox !== 'none' ? { kind: f.access.sandbox } : {}),
          writes: writes(f),
          folders: f.access.reads,
          ask: has(f, 'request_read') && f.audience.owner,
          project: project(f) !== undefined,
        }),
    },
    {
      key: 'full-access',
      guard: (f) => f.access.fullAccess,
      render: (f) => say.safety.fullAccess(has(f, 'ask_user')),
    },
    {
      key: 'read-only',
      guard: (f) => project(f) !== undefined && f.access.preset === 'read-only',
      render: (f) => say.safety.readOnly(project(f)?.name, has(f, 'propose')),
    },
    {
      key: 'ask',
      guard: (f) => f.access.preset === 'ask',
      render: (f) => say.safety.ask(project(f)?.name, f.access.allow, has(f, 'ask_user')),
    },
    {
      key: 'computer-safety',
      guard: (f) => f.access.computer && (has(f, 'computer') || has(f, 'desktop')),
      render: () => say.safety.computer,
    },
    { key: 'limits', guard: () => true, render: () => say.safety.limits },
  ]),
  ...under('method', [
    {
      key: 'answer-method',
      guard: (f) => f.agent.kind === 'answer',
      render: (f) => say.answerMethod(has(f, 'web_search')),
    },
    { key: 'method', guard: (f) => f.agent.works, render: method },
    {
      key: 'verify',
      guard: (f) => f.agent.works && verifyBullets(f).length > 0,
      render: (f) => [say.verify.head, ...verifyBullets(f)].join('\n'),
    },
    { key: 'lead-method', version: 2, guard: (f) => f.agent.kind === 'team-lead', render: leadMethod },
    {
      key: 'project-rules',
      guard: (f) =>
        project(f) !== undefined && f.access.preset !== 'read-only' && any(f, 'fs_write', 'fs_edit', 'shell'),
      render: () => say.projectRules,
    },
    {
      key: 'project',
      guard: (f) =>
        project(f) !== undefined && f.access.worktree === undefined && any(f, 'fs_write', 'shell'),
      render: (f) => say.project(has(f, 'propose')),
    },
    {
      key: 'worktree',
      guard: (f) => f.access.worktree !== undefined && has(f, 'submit_task'),
      render: (f) => (f.access.worktree?.copy ? say.projectCopy : say.worktree),
    },
    {
      key: 'escalation',
      guard: (f) =>
        (f.agent.kind === 'answer' || f.agent.kind === 'solo') &&
        has(f, 'escalate') &&
        f.mode.escalateTo.length > 0,
      render: (f) =>
        prompts.escalation.note(
          f.mode.escalateTo
            .map((t) => (t === 'team' ? prompts.escalation.team : prompts.escalation.solo))
            .join(' or '),
        ),
    },
    // One section per model-family block, shown only to agents on a model of that family.
    ...FAMILY_BLOCKS.map((b) => ({
      key: `family:${b.key}`,
      guard: (f: PromptFacts) => b.families.includes(f.model.family),
      render: () => b.text,
    })),
    { key: 'plugins-how', guard: (f) => has(f, 'create_plugin'), render: () => say.plugins },
    { key: 'docs', guard: (f) => has(f, 'read_docs'), render: (f) => say.docs(f.agent.works) },
  ]),
  ...under('others', [
    {
      key: 'crewmates',
      version: 2,
      guard: (f) => f.agent.kind === 'solo' && has(f, 'ask_crewmate') && f.mode.crewmatesOnCall.length > 0,
      render: (f) =>
        say.crewmates({
          list: crewLines(f.mode.crewmatesOnCall, () => 'crewmate'),
          log: has(f, 'read_log'),
          escalate: has(f, 'escalate'),
        }),
    },
    { key: 'log', guard: team, render: () => say.colony.log },
    // A team lead plans and assigns; the claim-and-submit rules are for whoever does the tasks.
    {
      key: 'tasks',
      guard: (f) => team(f) && has(f, 'claim_task') && f.agent.kind !== 'team-lead',
      render: () => say.colony.tasks,
    },
    { key: 'swarm', guard: (f) => f.agent.kind === 'swarm-peer', render: () => say.colony.swarm },
    {
      key: 'swarm-ask',
      guard: (f) => f.agent.kind === 'swarm-peer' && has(f, 'ask_user'),
      render: () => say.colony.swarmAsk,
    },
    {
      key: 'messaging',
      version: 2,
      guard: (f) => team(f) && !crewmate(f) && has(f, 'message'),
      // An example names someone this agent can actually message.
      render: (f) =>
        say.colony.messaging({ example: f.mode.roster[0]?.name ?? '<name>', groups: has(f, 'create_group') }),
    },
    {
      key: 'assume',
      guard: (f) => f.agent.kind === 'team-worker' && has(f, 'append_note'),
      render: (f) => say.colony.assume(f.agent.lead),
    },
    {
      key: 'crewmate-ask',
      guard: (f) => crewmate(f) && has(f, 'message'),
      render: (f) => say.colony.crewmateAsk(f.agent.lead),
    },
  ]),
  ...under('person', [
    { key: 'speaker', guard: speaker, render: () => say.speaker.head },
    {
      key: 'scoping',
      guard: (f) => speaker(f) && builds(f) && has(f, 'ask_user'),
      render: (f) => say.speaker.scoping(has(f, 'check_in')),
    },
    {
      key: 'no-scoping',
      guard: (f) => speaker(f) && !builds(f) && has(f, 'ask_user'),
      render: (f) => say.speaker.noScoping(has(f, 'escalate')),
    },
    { key: 'files', guard: (f) => speaker(f) && has(f, 'publish_artifact'), render: () => say.speaker.files },
    { key: 'myrmidon', guard: speaker, render: (f) => say.speaker.myrmidon(has(f, 'read_docs')) },
    {
      key: 'remember',
      guard: (f) => speaker(f) && has(f, 'remember'),
      render: (f) => say.speaker.remember(project(f) !== undefined),
    },
    { key: 'final', guard: speaker, render: (f) => say.speaker.final(builds(f)) },
  ]),
  ...under('instructions', [
    {
      key: 'context-note',
      guard: (f) =>
        f.agent.instructions !== undefined ||
        f.context.instructions !== undefined ||
        f.context.rules.length > 0 ||
        f.context.memory.length > 0 ||
        f.context.skills.length > 0,
      render: () => say.context.note,
    },
    {
      key: 'instructions',
      guard: (f) => f.agent.instructions !== undefined,
      render: (f) => say.context.instructions(f.agent.instructions ?? ''),
    },
    {
      key: 'project-instructions',
      guard: (f) => f.context.instructions !== undefined,
      render: (f) =>
        say.context.project(f.context.instructions?.files ?? [], f.context.instructions?.text ?? ''),
    },
    {
      key: 'nested',
      guard: (f) => f.context.nested.length > 0,
      render: (f) => say.context.nested(f.context.nested),
    },
    {
      key: 'rulebook',
      guard: (f) => f.context.rules.length > 0,
      render: (f) =>
        say.context.rules(
          f.context.rules.slice(0, RULES_MAX_LISTED).map(ruleLine),
          f.context.rules.length - RULES_MAX_LISTED,
          has(f, 'fs_read'),
        ),
    },
    {
      key: 'memory',
      version: 2,
      guard: (f) => f.context.memory.length > 0 || f.context.memorySummary !== undefined,
      render: (f) =>
        say.context.memory(
          f.context.memory,
          f.context.memoryMore,
          has(f, 'recall'),
          has(f, 'remember'),
          f.context.memorySummary,
        ),
    },
    {
      key: 'skills',
      guard: (f) => f.context.skills.length > 0,
      render: (f) =>
        say.context.skills(
          f.context.skills
            .filter((s) => s.fits)
            .map(skillLine)
            .join('\n'),
          f.context.skills.filter((s) => !s.fits).map((s) => s.name),
        ),
    },
  ]),
  ...under('plugins', [
    {
      key: 'plugins',
      guard: (f) => f.context.plugins.length > 0,
      render: (f) => f.context.plugins.join('\n\n'),
    },
  ]),
  ...under('environment', [
    { key: 'environment', version: 3, guard: () => true, render: environment },
    {
      key: 'layout',
      guard: (f) => f.context.layout !== undefined,
      render: (f) => env.layout(f.context.layout ?? ''),
    },
    {
      key: 'checks',
      guard: (f) => f.context.checks.length > 0 && has(f, 'run_checks'),
      render: (f) => env.checks(f.context.checks.map((c) => `${c.name} \`${c.command}\``).join(', ')),
    },
    {
      key: 'on-demand',
      version: 2,
      guard: (f) => has(f, 'find_tools'),
      render: (f) =>
        env.onDemand({ later: f.tools.deferred, mcp: has(f, 'mcp'), made: any(f, 'shell', 'browser_open') }),
    },
  ]),
]
