import { localDate } from '../clock.ts'
import { prompts } from '../prompts.ts'
import { type CrewInfo, has, type PromptFacts } from './facts.ts'

/**
 * Where a section sits for prompt caching, after Hermes' three tiers: `stable` depends only on the agent's role,
 * tools and settings, so it repeats byte for byte across rounds; `context` is the person's and plugins' own text;
 * `volatile` changes between rounds (the date, the project's state, memory, skills).
 */
export type Tier = 'stable' | 'context' | 'volatile'

/**
 * One guarded piece of an agent's system prompt, after Gemini CLI's `withSection(key, factory, guard)` and the
 * OpenHands section registry: `guard` says whether it applies to this agent at all, `render` writes it from the
 * facts with words from prompts.ts. `version` goes up whenever its words change, so a run's log says which prompt
 * an agent had. Sections sharing a `block` render into one system block, joined by that block's separator.
 */
export interface Section {
  readonly key: string
  readonly tier: Tier
  readonly version: number
  readonly block?: BlockKey
  readonly guard: (f: PromptFacts) => boolean
  readonly render: (f: PromptFacts) => string
}

/** How a block's sections join: texts that start with a line break carry it themselves (see prompts.ts). */
export const BLOCKS = {
  capabilities: '\n',
  role: '',
  colony: '\n',
  speaker: '\n',
  environment: '\n',
} as const

export type BlockKey = keyof typeof BLOCKS

const any = (f: PromptFacts, ...tools: string[]) => tools.some((t) => has(f, t))
const team = (f: PromptFacts) => f.mode.size > 1
const crewmate = (f: PromptFacts) => f.agent.kind === 'crewmate'

const lines = (crew: readonly CrewInfo[], fallback: (c: CrewInfo) => string) =>
  crew.map((c) => `- ${c.name}: ${c.specialty ?? fallback(c)} (${c.model})`).join('\n')

function roster(f: PromptFacts): string {
  return lines(f.mode.roster, (c) => c.role) || '- (none yet)'
}

/** The round from this agent's point of view: its role decides, not the round's tier alone. */
function roundLine(f: PromptFacts): string {
  const say = prompts.capabilities.modes
  const { kind } = f.agent
  if (kind === 'answer') return say.answer
  if (kind === 'crewmate') return say.crewmate(f.agent.lead)
  if (kind === 'solo' && has(f, 'ask_crewmate')) return say.soloCrew(f.mode.crewmatesOnCall.length)
  if (f.mode.tier === 'solo' || (f.mode.chat && f.mode.size === 1)) return say.solo
  if (f.mode.team === 'swarm') return say.swarm(f.mode.size)
  if (f.mode.team) return say.orchestrated(f.mode.size - 1)
  return say.colony(f.mode.pattern, f.mode.size)
}

/** What the agent can do, one clause per tool group it really has; deferred tools say how to load them. */
function abilities(f: PromptFacts): string[] {
  const say = prompts.capabilities
  const load = (tool: string, query: string) => (f.tools.deferred.includes(tool) ? say.load(query) : '')
  const { access } = f
  return [
    has(f, 'web_search') && (access.web ? say.web : say.noWeb),
    has(f, 'shell') &&
      (access.fullAccess
        ? say.shellFull
        : access.sandbox !== 'none'
          ? say.shell(access.sandbox)
          : say.noShell),
    has(f, 'publish_artifact') && say.publish,
    has(f, 'browser_open') &&
      (access.browser
        ? `${say.browser}${has(f, 'publish_artifact') ? say.browserPublished : ''}${load('browser_open', 'browser')}`
        : say.noBrowser),
    has(f, 'mcp') && `${say.mcp}${has(f, 'browser_open') ? say.mcpBrowser : ''}`,
    has(f, 'computer') && access.computer && `${say.computer}${load('computer', 'computer')}`,
    has(f, 'create_tool') &&
      access.sandbox !== 'none' &&
      `${say.makeTools}${load('create_tool', 'create_tool')}`,
    has(f, 'create_task') && say.createTasks,
    has(f, 'add_crewmate') && say.addWorkers,
    has(f, 'reply_user') && say.talk,
  ].filter((a): a is string => typeof a === 'string' && a.length > 0)
}

function roleBrief(f: PromptFacts): string {
  const { agent } = f
  const specialty = agent.specialty ? { specialty: agent.specialty } : {}
  switch (agent.kind) {
    case 'answer':
      return prompts.roles.answer
    case 'crewmate':
      return prompts.roles.crewmate({ name: agent.name, ...specialty, model: agent.model, lead: agent.lead })
    case 'solo':
      return prompts.roles.solo
    case 'swarm-peer':
      return prompts.roles.swarmPeer({
        name: agent.name,
        peers: f.mode.size,
        ...specialty,
        roster: roster(f),
      })
    case 'team-lead': {
      const saved = lines(f.mode.specialists, (c) => c.role)
      return prompts.roles.chatLead({
        roster: roster(f),
        extra: f.mode.canAdd,
        ...(f.mode.team ? { workerModels: f.mode.workerModels } : {}),
        ...(saved ? { saved } : {}),
      })
    }
    case 'colony-lead':
      return prompts.roles.lead(roster(f))
    case 'team-worker':
      return prompts.roles.chatWorker({ name: agent.name, ...specialty, model: agent.model })
    case 'colony-worker':
      return prompts.roles.worker
    case 'colony-peer':
      return prompts.roles.peer
  }
}

/** The speaker sections apply to the agent that answers the person in a chat round. */
const speaker = (f: PromptFacts) => f.mode.chat && f.agent.speaks && has(f, 'reply_user')

function reviewNote(f: PromptFacts): string {
  const { setting, judge = '' } = f.review
  return setting === 'off'
    ? prompts.review.off
    : setting === 'auto'
      ? prompts.review.auto(judge)
      : prompts.review.always(judge)
}

const env = prompts.environment
const project = (f: PromptFacts) => f.access.project

/** Every section, in the order the prompt reads; `assemble` keeps this order within each tier. */
export const SECTIONS: readonly Section[] = [
  {
    key: 'identity',
    tier: 'stable',
    version: 1,
    guard: () => true,
    render: (f) => prompts.system.identity(f.agent.name),
  },
  {
    key: 'harness',
    tier: 'stable',
    version: 1,
    block: 'capabilities',
    guard: () => true,
    render: () => prompts.capabilities.harness,
  },
  {
    key: 'round',
    tier: 'stable',
    version: 1,
    block: 'capabilities',
    guard: () => true,
    render: (f) => prompts.capabilities.round(roundLine(f)),
  },
  {
    key: 'abilities',
    tier: 'stable',
    version: 1,
    block: 'capabilities',
    guard: (f) => abilities(f).length > 0,
    render: (f) => prompts.capabilities.can(abilities(f).join('; ')),
  },
  {
    key: 'limits',
    tier: 'stable',
    version: 1,
    block: 'capabilities',
    guard: () => true,
    render: (f) =>
      `${prompts.capabilities.limits}${has(f, 'create_tool') ? prompts.capabilities.madeToolsKept : ''}`,
  },
  {
    key: 'docs',
    tier: 'stable',
    version: 1,
    block: 'capabilities',
    guard: (f) => has(f, 'read_docs'),
    render: (f) => prompts.capabilities.docs(!f.agent.works),
  },
  {
    key: 'role',
    tier: 'stable',
    version: 1,
    block: 'role',
    guard: () => true,
    render: roleBrief,
  },
  {
    key: 'crewmates',
    tier: 'stable',
    version: 1,
    block: 'role',
    guard: (f) => f.agent.kind === 'solo' && has(f, 'ask_crewmate') && f.mode.crewmatesOnCall.length > 0,
    render: (f) =>
      prompts.roles.crewmates(
        lines(f.mode.crewmatesOnCall, () => 'crewmate'),
        has(f, 'escalate'),
      ),
  },
  {
    key: 'escalation',
    tier: 'stable',
    version: 1,
    block: 'role',
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
  {
    key: 'craft',
    tier: 'stable',
    version: 1,
    guard: (f) => f.agent.works,
    render: () => prompts.system.craft.trim(),
  },
  ...colonySections(),
  ...speakerSections(),
  {
    key: 'review-tasks',
    tier: 'stable',
    version: 1,
    guard: (f) => has(f, 'submit_task'),
    render: (f) => prompts.review.tasks(f.review.taskJudge),
  },
  {
    key: 'instructions',
    tier: 'context',
    version: 1,
    guard: (f) => f.agent.instructions !== undefined,
    render: (f) => prompts.system.additional(f.agent.instructions ?? ''),
  },
  {
    key: 'plugins',
    tier: 'context',
    version: 1,
    guard: (f) => f.context.plugins.length > 0,
    render: (f) => f.context.plugins.join('\n\n'),
  },
  ...environmentSections(),
]

/**
 * How a team coordinates, one section per rule so each goes only to agents whose tools use it (a crewmate the solo
 * lead asks has no tasks, groups or team chat).
 */
function colonySections(): Section[] {
  const say = prompts.system.colony
  const rules: Omit<Section, 'tier' | 'version' | 'block'>[] = [
    { key: 'log', guard: team, render: () => say.log },
    {
      key: 'deliver',
      guard: (f) => team(f) && !crewmate(f) && has(f, 'publish_artifact'),
      render: () => say.deliver,
    },
    {
      key: 'verifier',
      guard: (f) => team(f) && !crewmate(f) && f.review.verifier,
      render: () => say.verifier,
    },
    { key: 'tasks', guard: (f) => team(f) && has(f, 'claim_task'), render: () => say.tasks },
    {
      key: 'messaging',
      guard: (f) => team(f) && !crewmate(f) && has(f, 'message'),
      // An example names someone this agent can actually message.
      render: (f) =>
        say.messaging({ example: f.mode.roster[0]?.name ?? '<name>', groups: has(f, 'create_group') }),
    },
    // A crewmate's brief says how it finishes: by answering the lead.
    { key: 'finish', guard: (f) => team(f) && !crewmate(f), render: () => say.finish },
    // Agents that work hear it in the craft section's delivery contract.
    { key: 'honest', guard: (f) => team(f) && !f.agent.works, render: () => say.honest },
    { key: 'refusals', guard: team, render: () => say.refusals },
    { key: 'reuse', guard: team, render: () => say.reuse },
  ]
  const sections = rules.map((r): Section => ({ ...r, tier: 'stable', version: 1, block: 'colony' }))
  return [
    {
      key: 'colony',
      tier: 'stable',
      version: 1,
      block: 'colony',
      guard: (f) => sections.some((s) => s.guard(f)),
      render: () => say.head,
    },
    ...sections,
  ]
}

/** Talking to the person, for the agent that speaks; each rule only where its tools exist (A4, A5). */
function speakerSections(): Section[] {
  const say = prompts.system.speaker
  const rules: Omit<Section, 'tier' | 'version' | 'block'>[] = [
    { key: 'speaker', guard: speaker, render: () => say.head },
    { key: 'speaker-direct', guard: speaker, render: (f) => say.direct(has(f, 'web_search')) },
    // Scoping questions are about building, so only an agent that can build asks them.
    {
      key: 'speaker-scoping',
      guard: (f) => speaker(f) && any(f, 'publish_artifact', 'fs_write'),
      render: () => say.scoping,
    },
    {
      key: 'speaker-ask',
      guard: (f) => speaker(f) && has(f, 'ask_user'),
      render: (f) => say.ask(has(f, 'check_in')),
    },
    {
      key: 'speaker-files',
      guard: (f) => speaker(f) && has(f, 'publish_artifact'),
      render: () => say.files,
    },
    { key: 'speaker-done', guard: speaker, render: () => say.done },
    { key: 'speaker-myrmidon', guard: speaker, render: (f) => say.myrmidon(has(f, 'read_docs')) },
    {
      key: 'speaker-plugins',
      guard: (f) => speaker(f) && has(f, 'create_plugin'),
      render: () => say.plugins,
    },
    { key: 'speaker-priority', guard: speaker, render: () => say.priority },
    { key: 'speaker-review', guard: speaker, render: (f) => `- ${reviewNote(f)}` },
  ]
  return rules.map((r) => ({ ...r, tier: 'stable', version: 1, block: 'speaker' }))
}

/** Facts about where the agent runs; last, since they change between rounds. */
function environmentSections(): Section[] {
  const facts: Omit<Section, 'tier' | 'version' | 'block'>[] = [
    {
      key: 'today',
      guard: () => true,
      render: (f) =>
        env.today({
          date: localDate(f.env.now),
          weekday: f.env.now.toLocaleDateString('en-US', { weekday: 'long' }),
          zone: f.env.zone,
        }),
    },
    {
      key: 'worktree',
      guard: (f) => project(f) !== undefined && f.access.worktree !== undefined,
      render: (f) =>
        env.worktree({
          name: project(f)?.name ?? '',
          workdir: f.access.worktree?.path ?? '',
          branch: f.access.worktree?.branch ?? '',
          path: project(f)?.path ?? '',
        }),
    },
    {
      key: 'project',
      guard: (f) => project(f) !== undefined && f.access.worktree === undefined,
      render: (f) =>
        env.project({
          name: project(f)?.name ?? '',
          path: project(f)?.path ?? '',
          propose: has(f, 'propose'),
        }),
    },
    // For agents that can change the project; in a read-only one there is nothing to change.
    {
      key: 'project-rules',
      guard: (f) =>
        project(f) !== undefined &&
        project(f)?.mode !== 'read-only' &&
        any(f, 'fs_write', 'fs_edit', 'shell'),
      render: () => env.projectRules,
    },
    {
      key: 'untrusted',
      guard: (f) =>
        f.env.boundary !== undefined &&
        f.tools.names.some((t) => t.startsWith('web_') || t.startsWith('browser_') || t === 'mcp'),
      render: (f) => env.untrusted(f.env.boundary ?? ''),
    },
    { key: 'full-access', guard: (f) => f.access.fullAccess, render: () => env.fullAccess },
    {
      key: 'computer',
      guard: (f) => f.access.computer && has(f, 'computer'),
      render: (f) => env.computer(f.env.boundary),
    },
    {
      key: 'read-only',
      guard: (f) => project(f)?.mode === 'read-only',
      render: (f) => env.readOnly(project(f)?.name, has(f, 'propose')),
    },
    {
      key: 'ask',
      guard: (f) => project(f)?.mode === 'ask',
      render: (f) => env.ask(project(f)?.name, project(f)?.allow ?? []),
    },
    {
      key: 'skills',
      guard: (f) => f.context.skills.length > 0,
      render: (f) =>
        env.skills(
          f.context.skills
            .filter((s) => s.fits)
            .map(
              (s) =>
                `- ${s.name}: ${s.description.length > 220 ? `${s.description.slice(0, 217)}…` : s.description}`,
            )
            .join('\n'),
          f.context.skills.filter((s) => !s.fits).map((s) => s.name),
        ),
    },
    {
      key: 'on-demand',
      guard: (f) => has(f, 'find_tools'),
      render: (f) => env.onDemand({ later: f.tools.deferred, mcp: has(f, 'mcp') }),
    },
    { key: 'memory', guard: (f) => f.context.memory.length > 0, render: (f) => env.memory(f.context.memory) },
    { key: 'remember', guard: (f) => has(f, 'remember'), render: () => env.remember },
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
      key: 'project-instructions',
      guard: (f) => f.context.instructions !== undefined,
      render: (f) =>
        env.instructions(f.context.instructions?.files ?? [], f.context.instructions?.text ?? ''),
    },
    { key: 'nested', guard: (f) => f.context.nested.length > 0, render: (f) => env.nested(f.context.nested) },
    {
      key: 'shell',
      guard: (f) => has(f, 'shell'),
      render: (f) => {
        const shell = { platform: f.env.platform, sandbox: f.access.sandbox, runtimes: f.env.runtimes }
        return f.access.fullAccess
          ? env.shellFull({ ...shell, project: project(f) !== undefined })
          : project(f)
            ? env.shellProject(shell)
            : env.shellScratch(shell)
      },
    },
    {
      key: 'reads',
      guard: (f) => !f.access.fullAccess && any(f, 'shell', 'fs_read'),
      render: (f) => env.reads({ folders: f.access.reads, ask: has(f, 'request_read') && f.audience.owner }),
    },
  ]
  return facts.map((s) => ({ ...s, tier: 'volatile', version: 1, block: 'environment' }))
}
