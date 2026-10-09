import type { ColonyState } from '@myrmidon/protocol'
import type { ProjectContext } from './project-context.ts'
import { prompts } from './prompts.ts'
import type { AgentSpec, ColonySpec } from './spec.ts'

const LOOK = [
  'read_notes',
  'read_messages',
  'list_agents',
  'list_tasks',
  'list_artifacts',
  'read_artifact',
  'read_log',
]
const WEB = ['web_search', 'web_fetch']
const READ = ['read_task', ...LOOK, 'observe', ...WEB, 'read_docs', 'use_skill']
const TALK = ['message', 'create_group', 'update_group', 'append_note']
const HOLD = ['claim_task', 'release_task', 'submit_task']
const BROWSER = [
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
]
/** `mcp` stands for every tool of the connected MCP servers. */
const BUILD = [
  'update_todo',
  'fs_write',
  'fs_edit',
  'fs_read',
  'fs_list',
  'grep',
  'glob',
  'shell',
  'run_checks',
  'start_server',
  'server_logs',
  'stop_server',
  'create_tool',
  ...BROWSER,
  'mcp',
]
const USER = ['reply_user', 'check_in', 'ask_user', 'remember']
/** For the agent that speaks: features of Myrmidon itself are built as plugins the person switches on. */
const PLUGIN = ['create_plugin', 'test_plugin', 'propose_plugin']

export function isLead(spec: ColonySpec, agent: AgentSpec) {
  return spec.pattern === 'lead-workers' && agent.role === 'lead'
}

/** The agent that speaks for a chat round: the lead, or the single agent of an answer/solo round. */
export function speaksForColony(spec: ColonySpec, agent: AgentSpec): boolean {
  if (!spec.chat) return false
  if (spec.team?.mode === 'swarm' && spec.tier === 'team') return false
  return isLead(spec, agent) || spec.agents.length === 1
}

/** In a chat with a project folder, every agent that works can show the person a change before it lands. */
function roleTools(spec: ColonySpec, agent: AgentSpec): string[] {
  const tools = baseRoleTools(spec, agent)
  return spec.chat?.project && spec.tier !== 'answer' ? [...tools, 'propose'] : tools
}

function baseRoleTools(spec: ColonySpec, agent: AgentSpec): string[] {
  if (spec.chat) {
    const escalation = spec.chat.escalate?.length && speaksForColony(spec, agent) ? ['escalate'] : []
    // In auto review the speaking agent decides when the reviewer looks at the work.
    const review =
      spec.review === 'auto' && spec.acceptance.length > 0 && speaksForColony(spec, agent)
        ? ['request_review']
        : []
    if (spec.tier === 'answer')
      return [
        ...WEB,
        // A quick lookup on a site still needs searching and clicking; these act only in the agent's own browser.
        ...BROWSER,
        // In a project, quick questions are often about its code: reading it needs no team.
        ...(spec.chat.project ? ['fs_read', 'fs_list', 'grep', 'glob'] : []),
        'list_artifacts',
        'read_artifact',
        'read_docs',
        'use_skill',
        'mcp',
        ...USER,
        ...escalation,
        ...review,
      ]
    const plugin = speaksForColony(spec, agent) ? PLUGIN : []
    // A crewmate the lead asked for a piece of work: it works and answers the lead, never the person.
    if (spec.tier === 'solo' && agent.role === 'worker')
      return [...READ, 'message', 'append_note', 'publish_artifact', ...BUILD]
    const crewmates =
      spec.tier === 'solo' && isLead(spec, agent) && spec.team?.crewmates?.length ? ['ask_crewmate'] : []
    if (spec.tier !== 'team' || spec.agents.length === 1)
      return [
        ...READ,
        'append_note',
        'publish_artifact',
        ...BUILD,
        ...USER,
        ...crewmates,
        ...escalation,
        ...review,
        ...plugin,
      ]
    if (spec.team?.mode === 'swarm')
      return [
        ...READ,
        ...TALK,
        'create_task',
        'reject_task',
        ...HOLD,
        'publish_artifact',
        ...BUILD,
        ...USER,
        'reply_person',
      ]
    if (isLead(spec, agent)) {
      // A lead can add workers while it has room, and bring in the person's specialists whenever some can join.
      const spawn =
        (spec.team?.maxWorkers ?? 0) > spec.agents.length - 1 || spec.team?.specialists?.length
          ? ['add_crewmate']
          : []
      // A lead that can do the work itself never delegates: in a team it has no web, shell, or file tools.
      // It plans, assigns, reviews, integrates, and speaks; specialists research and build.
      return [
        'read_task',
        ...LOOK,
        'observe',
        'read_docs',
        ...TALK,
        'create_task',
        'assign_task',
        'reject_task',
        ...HOLD,
        'publish_artifact',
        ...USER,
        ...review,
        ...plugin,
        ...spawn,
        ...(spec.agents.length > 1 ? ['dismiss_crewmate'] : []),
      ]
    }
    // A worker speaks to the person only when they wrote to it directly (@name).
    return [...READ, ...TALK, ...HOLD, 'publish_artifact', ...BUILD, 'reply_person']
  }
  const work = ['publish_artifact', ...BUILD]
  if (isLead(spec, agent))
    return [...READ, ...TALK, 'create_task', 'reject_task', ...HOLD, ...work, 'request_final_verification']
  if (spec.pattern === 'lead-workers') return [...READ, ...TALK, ...HOLD, ...work]
  return [...READ, ...TALK, 'create_task', 'reject_task', ...HOLD, ...work, 'request_final_verification']
}

/**
 * Tools an agent loads when it needs them (find_tools) instead of carrying their definitions in every model call:
 * the browser, dev servers, tool making, the person's MCP servers, made tools, and rarely used lookups. Anything
 * not listed here is always loaded.
 */
const ON_DEMAND = new Set([
  'request_login',
  'start_server',
  'server_logs',
  'stop_server',
  'create_tool',
  'read_log',
  'read_docs',
  ...PLUGIN,
])

/**
 * On-demand tools a request plainly calls for, loaded from the start so the agent does not spend a step asking:
 * a URL or web page means the browser, a dev server means the server tools.
 */
export function preloaded(request: string, names: readonly string[]): string[] {
  const browser =
    /https?:\/\/|\bbrows|\bwebsite|\bweb ?page|\bsite\b|\bclick|\bsign ?in\b|\blog ?in\b|\bform\b|\bscreenshot|\bdownload|\bupload/i.test(
      request,
    )
  const server = /\bdev server|\blocalhost\b|\bserve it\b|\bstart (the )?(app|server)\b/i.test(request)
  const plugin = /\bplugin|\bmyrmidon\b/i.test(request)
  return names.filter(
    (n) =>
      (browser && (n.startsWith('browser_') || n === 'request_login')) ||
      (server && ['start_server', 'server_logs', 'stop_server'].includes(n)) ||
      (plugin && (PLUGIN.includes(n) || n === 'read_docs')),
  )
}

export function onDemand(name: string): boolean {
  return ON_DEMAND.has(name) || /^(browser_|mcp__|tool_)/.test(name)
}

export function toolsFor(spec: ColonySpec, agent: AgentSpec): string[] {
  const tools = agent.tools ?? roleTools(spec, agent)
  const disabled = new Set([...(spec.disabledTools ?? []), ...(agent.withoutTools ?? [])])
  const allowed = disabled.size ? tools.filter((t) => !disabled.has(t)) : tools
  // Whoever has tools that load on demand gets the tool that loads them; MCP and made tools are among them.
  return allowed.some((t) => t === 'mcp' || t === 'shell' || onDemand(t))
    ? [...allowed, 'find_tools']
    : allowed
}

function roster(spec: ColonySpec, self: AgentSpec): string {
  return (
    spec.agents
      .filter((a) => a.name !== self.name)
      .map((a) => `- ${a.name}: ${a.specialty ?? a.role} (${a.model})`)
      .join('\n') || '- (none yet)'
  )
}

/** When the round's agent may hand the request to a bigger tier, and what that costs. */
function escalationNote(spec: ColonySpec): string {
  const to = spec.chat?.escalate ?? []
  if (to.length === 0) return ''
  const options = to
    .map((t) => (t === 'team' ? prompts.escalation.team : prompts.escalation.solo))
    .join(' or ')
  return prompts.escalation.note(options)
}

function roleBrief(spec: ColonySpec, agent: AgentSpec): string {
  if (spec.chat && spec.tier === 'answer') return prompts.roles.answer(escalationNote(spec))
  if (spec.chat && spec.tier === 'solo' && agent.role === 'worker') {
    const lead = spec.agents.find((a) => isLead(spec, a))?.name ?? 'lead'
    return prompts.roles.crewmate({
      name: agent.name,
      ...(agent.specialty ? { specialty: agent.specialty } : {}),
      model: agent.model,
      lead,
    })
  }
  if (spec.chat && (spec.tier !== 'team' || spec.agents.length === 1)) {
    const onCall = isLead(spec, agent) ? (spec.team?.crewmates ?? []) : []
    const list = onCall.map((c) => `- ${c.name}: ${c.specialty ?? 'crewmate'} (${c.model})`).join('\n')
    return prompts.roles.solo(escalationNote(spec), list ? prompts.roles.crewmates(list) : '')
  }
  if (spec.chat && spec.team?.mode === 'swarm') {
    return prompts.roles.swarmPeer({
      name: agent.name,
      peers: spec.agents.length,
      ...(agent.specialty ? { specialty: agent.specialty } : {}),
      roster: roster(spec, agent),
    })
  }
  if (isLead(spec, agent)) {
    const extra = (spec.team?.maxWorkers ?? 0) - (spec.agents.length - 1)
    if (!spec.chat) return prompts.roles.lead(roster(spec, agent))
    const saved = spec.team?.specialists
      ?.map((s) => `- ${s.name}: ${s.specialty ?? s.role} (${s.model})`)
      .join('\n')
    return prompts.roles.chatLead({
      roster: roster(spec, agent),
      extra,
      ...(spec.team ? { workerModels: spec.team.workerModels } : {}),
      ...(saved ? { saved } : {}),
    })
  }
  if (spec.pattern === 'lead-workers') {
    if (!spec.chat) return prompts.roles.worker
    return prompts.roles.chatWorker({
      name: agent.name,
      ...(agent.specialty ? { specialty: agent.specialty } : {}),
      model: agent.model,
    })
  }
  return prompts.roles.peer
}

export interface Environment {
  /** This round's marker for untrusted content blocks. */
  readonly boundary?: string
  /** The sandbox kind commands run in; `unconfined` means the round has full access. */
  readonly sandbox: string
  readonly web: boolean
  readonly browser: boolean
  readonly project?: ProjectContext
  /** The agent's own git worktree of the project, when it has one. */
  readonly worktree?: { workdir: string; branch: string }
  /** Skills the agent can load by name. */
  readonly skills?: readonly { name: string; description: string }[]
  /** Sections the person's plugins add for this agent. */
  readonly plugins?: readonly string[]
}

type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/**
 * How hard a reasoning model thinks per step. Planning and solo work decide the outcome, so they think hard;
 * workers on a scoped task think moderately; a direct answer stays quick.
 */
export function thinkingFor(spec: ColonySpec, agent: AgentSpec): Effort {
  if (spec.tier === 'answer') return 'low'
  if (spec.thinking) return spec.thinking
  // A lone chat agent often just answers; it thinks harder when the person asks for it.
  if (spec.chat && spec.agents.length === 1) return 'medium'
  if (spec.agents.length === 1 || isLead(spec, agent)) return 'high'
  return 'medium'
}

/** Runtimes present on this machine, checked once, so agents know what they can actually run. */
const RUNTIMES = ['bun', 'node', 'python3', 'deno', 'uv', 'git'].filter((c) => Bun.which(c) !== null)

function environment(spec: ColonySpec, env: Environment, tools: readonly string[]): string {
  const now = new Date()
  const date = now.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const lines = [
    prompts.environment.today({ date, weekday: now.toLocaleDateString('en-US', { weekday: 'long' }), zone }),
  ]
  const project = spec.chat?.project
  if (project && env.worktree)
    lines.push(
      prompts.environment.worktree({
        name: project.name,
        workdir: env.worktree.workdir,
        branch: env.worktree.branch,
        path: project.path,
      }),
    )
  else if (project) lines.push(prompts.environment.project({ name: project.name, path: project.path }))
  if (env.boundary && tools.some((t) => t.startsWith('web_') || t.startsWith('browser_') || t === 'mcp'))
    lines.push(prompts.environment.untrusted(env.boundary))
  const permissions = project?.permissions
  if (env.sandbox === 'unconfined') lines.push(prompts.environment.fullAccess)
  if (permissions?.mode === 'read-only') lines.push(prompts.environment.readOnly(project?.name))
  else if (permissions?.mode === 'ask') lines.push(prompts.environment.ask(project?.name, permissions.allow))
  if (env.skills?.length && tools.includes('use_skill'))
    lines.push(
      prompts.environment.skills(
        env.skills
          .slice(0, 40)
          .map(
            (s) =>
              `- ${s.name}: ${s.description.length > 220 ? `${s.description.slice(0, 217)}…` : s.description}`,
          )
          .join('\n'),
      ),
    )
  if (tools.includes('find_tools')) {
    const ready = new Set(preloaded(spec.chat?.request ?? spec.mission, tools))
    const later = tools.filter((t) => onDemand(t) && !ready.has(t))
    lines.push(prompts.environment.onDemand({ later, mcp: tools.includes('mcp') }))
  }
  const memory = spec.chat?.memory
  if (memory?.length) lines.push(prompts.environment.memory(memory))
  if (tools.includes('remember')) lines.push(prompts.environment.remember)
  const guide = env.project?.instructions
  if (project && env.project?.layout) lines.push(prompts.environment.layout(env.project.layout))
  if (project && env.project?.checks.length)
    lines.push(
      prompts.environment.checks(env.project.checks.map((c) => `${c.name} \`${c.command}\``).join(', ')),
    )
  if (project && guide) {
    if (guide.text) lines.push(prompts.environment.instructions(guide.files, guide.text))
    if (guide.nested.length) lines.push(prompts.environment.nested(guide.nested))
  }
  if (tools.includes('shell')) {
    const shell = { platform: process.platform, sandbox: env.sandbox, runtimes: RUNTIMES }
    lines.push(
      env.sandbox === 'unconfined'
        ? prompts.environment.shellFull({ ...shell, project: !!project })
        : project
          ? prompts.environment.shellProject(shell)
          : prompts.environment.shellScratch(shell),
    )
  }
  return lines.join('\n')
}

/** What this agent can do here, stated from the actual configuration so capability answers are factual. */
function capabilities(spec: ColonySpec, agent: AgentSpec, env: Environment): string {
  const tools = toolsFor(spec, agent)
  const has = (t: string) => tools.includes(t)
  const say = prompts.capabilities
  const mode =
    spec.tier === 'answer'
      ? say.modes.answer
      : spec.tier === 'solo' || (spec.chat && spec.agents.length === 1)
        ? say.modes.solo
        : spec.team?.mode === 'swarm'
          ? say.modes.swarm(spec.agents.length)
          : spec.team
            ? say.modes.orchestrated(spec.agents.length - 1)
            : say.modes.colony(spec.pattern, spec.agents.length)
  return [
    say.harness,
    say.round(mode),
    say.can(
      [
        has('web_search') && (env.web ? say.web : say.noWeb),
        has('shell') &&
          (env.sandbox === 'unconfined'
            ? say.shellFull
            : env.sandbox !== 'none'
              ? say.shell(env.sandbox)
              : say.noShell),
        has('publish_artifact') && say.publish,
        has('browser_open') && (env.browser ? say.browser : say.noBrowser),
        has('mcp') && say.mcp,
        has('create_tool') && env.sandbox !== 'none' && say.makeTools,
        has('create_task') && say.createTasks,
        has('add_crewmate') && say.addWorkers,
        has('reply_user') && say.talk,
      ]
        .filter(Boolean)
        .join('; '),
    ),
    say.limits,
    say.docs,
  ].join('\n')
}

/** Agents that do hands-on work (everyone except a lead that only delegates, and direct answers). */
function doesWork(spec: ColonySpec, agent: AgentSpec): boolean {
  if (spec.tier === 'answer') return false
  return !(isLead(spec, agent) && spec.chat && spec.agents.length > 1)
}

/** What happens to the speaking agent's final answer under this round's reviewer setting. */
function reviewNote(spec: ColonySpec): string {
  if (spec.acceptance.length === 0 || spec.review === 'off') return prompts.review.off
  if (spec.review === 'auto') return prompts.review.auto
  return prompts.review.always
}

export function systemPrompt(spec: ColonySpec, agent: AgentSpec, env: Environment): string[] {
  const team = spec.agents.length > 1
  return [
    prompts.system.identity(agent.name),
    capabilities(spec, agent, env),
    roleBrief(spec, agent),
    doesWork(spec, agent) ? prompts.system.craft.trim() : '',
    team ? prompts.system.common.trim() : '',
    spec.chat && toolsFor(spec, agent).includes('reply_user') && speaksForColony(spec, agent)
      ? `${prompts.system.speaker.trim()}\n- ${reviewNote(spec)}`
      : '',
    agent.instructions ? prompts.system.additional(agent.instructions) : '',
    ...(env.plugins ?? []),
    // Volatile facts go last so the stable part of the prompt can be cached.
    environment(spec, env, toolsFor(spec, agent)),
  ].filter(Boolean)
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** The state an agent needs on waking, so it does not spend a turn re-reading empty boards. */
export function snapshot(spec: ColonySpec, s: ColonyState): string {
  const plan = s.notes.filter((n) => n.section === 'plan').at(-1)
  const tasks = Object.values(s.tasks).filter((t) => t.status !== 'deleted')
  const files = Object.entries(s.artifacts)
  const notes = s.notes.filter((n) => n.section !== 'plan').slice(-5)
  const talk = s.chatMessages.slice(-4)
  return [
    `REQUEST: ${spec.chat?.request ?? spec.mission}`,
    talk.length > 0
      ? `CONVERSATION:\n${talk.map((m) => `- ${m.from}: ${clip(m.text, 300)}`).join('\n')}`
      : '',
    `PLAN: ${plan ? clip(plan.text, 1500) : '(none yet)'}`,
    `TASKS:\n${
      tasks
        .map(
          (t) =>
            `- ${t.id} r${t.revision} [${t.status}]${t.owner ? ` owner=${t.owner}` : ''}${t.assignee ? ` assignee=${t.assignee}` : ''}${t.outputs?.length ? ` outputs=${t.outputs.join(',')}` : ''} ${t.subject}`,
        )
        .join('\n') || '- (none yet)'
    }`,
    `FILES: ${files.map(([n, v]) => `${n} v${v.at(-1)?.version} (${v.at(-1)?.author})`).join(', ') || '(none)'}`,
    notes.length > 0
      ? `RECENT NOTES:\n${notes.map((n) => `- ${n.agent}${n.section ? ` [${n.section}]` : ''}: ${clip(n.text, 200)}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Whether this agent starts working when the colony starts, or sleeps until something wakes it. */
export function startsAwake(spec: ColonySpec, agent: AgentSpec): boolean {
  // A round the person opened by writing to someone directly starts with that someone.
  if (spec.chat?.addressed?.length) return spec.chat.addressed.includes(agent.name)
  if (!spec.chat || spec.tier !== 'team' || !spec.team) return true
  // Every swarm peer joins the opening huddle.
  if (spec.team.mode === 'swarm') return true
  return isLead(spec, agent)
}

/** Tells an agent which files the person attached to a message. */
export function attachedNote(names: readonly string[] | undefined): string {
  return names?.length ? prompts.kickoff.attached(names) : ''
}

/** `remembers`: the agent's own conversation from earlier rounds is restored, so the history is not repeated. */
export function kickoff(spec: ColonySpec, state: ColonyState, remembers = false, agent?: string): string {
  if (!spec.chat) return prompts.kickoff.mission(spec.mission)
  const to = spec.chat.addressed
  if (to?.length && agent && !to.includes(agent))
    return prompts.kickoff.addressedElsewhere(to, spec.chat.request)
  const history = spec.chat.history && !remembers ? prompts.kickoff.history(spec.chat.history) : ''
  // This round's request, not the chat's first one: a colony serves every round of its chat.
  const from = state.rounds.at(-1)?.startSeq ?? 0
  const attached = state.chatMessages.find((m) => m.from === 'user' && m.seq >= from)?.attachments
  const plan = spec.planFirst ? prompts.kickoff.planFirst : ''
  const context = spec.chat.context ? prompts.chat.context(spec.chat.context) : ''
  const spoken = spec.chat.voice ? prompts.chat.spoken : ''
  const request = `${history}${context}[user] ${spec.chat.request}${attachedNote(attached)}${spoken}${plan}`
  if (spec.tier === 'answer') return request
  const files = Object.keys(state.artifacts).filter((f) => !attached?.includes(f))
  const carried = files.length > 0 ? prompts.kickoff.carried(files) : ''
  if (to?.length) return prompts.kickoff.addressed(`${request}${carried}`, snapshot(spec, state))
  if (spec.tier !== 'team' || spec.agents.length === 1) return `${request}${carried}`
  if (spec.team?.mode === 'swarm') return prompts.kickoff.huddle(request, snapshot(spec, state))
  return `${request}\n\n${snapshot(spec, state)}`
}
