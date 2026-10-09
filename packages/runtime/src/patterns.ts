import {
  ACCESS_GROUPS,
  type ColonyState,
  effectivePreset,
  groupsOff,
  LEAD_WORK_GROUPS,
  rulesIn,
  toolHidden,
} from '@myrmidon/protocol'
import { localDate, personZone, zoneOffset } from './clock.ts'
import { levelsOf } from './permissions.ts'
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
  'request_read',
  'shell',
  'run_checks',
  'start_server',
  'server_logs',
  'stop_server',
  'create_tool',
  ...BROWSER,
  'mcp',
  'computer',
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
        // "What's on my screen", "check this in Notes": only when the person switched computer use on.
        'computer',
        // In a project, quick questions are often about its code: reading it needs no team.
        ...(spec.chat.project ? ['fs_read', 'fs_list', 'grep', 'glob', 'request_read'] : []),
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
      // It plans, assigns, reviews, integrates, and speaks. Its own hands (files, shell, web…) are the groups the
      // person lets a lead use (see withRoleAccess); with them all off it only delegates.
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
  'computer',
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
  const computer =
    /\b(my (mac|screen|desktop|computer)|on (my|the) screen|desktop app|native app|the app\b|open (the )?\w+ app|finder|system settings|simulator|xcode|computer use)\b/i.test(
      request,
    )
  return names.filter(
    (n) =>
      (browser && (n.startsWith('browser_') || n === 'request_login')) ||
      (server && ['start_server', 'server_logs', 'stop_server'].includes(n)) ||
      (plugin && (PLUGIN.includes(n) || n === 'read_docs')) ||
      (computer && n === 'computer'),
  )
}

export function onDemand(name: string): boolean {
  return ON_DEMAND.has(name) || /^(browser_|mcp__|tool_)/.test(name)
}

/** Whether the agent speaking for the chat has someone to hand work to: a team, or crewmates on call. */
function leadsCrew(spec: ColonySpec): boolean {
  return spec.tier === 'team'
    ? spec.agents.length > 1
    : spec.tier === 'solo' && !!spec.team?.crewmates?.length
}

/**
 * Who may use what (the permission model's access and whole-tool denies). The lead, while it leads a crew, follows
 * the lead column and gets the build tools of every group it is allowed (a hands-on lead); everyone who does the
 * work, an agent working alone included, follows the crew column. A tool denied outright is left out.
 */
function withRoleAccess(
  spec: ColonySpec,
  agent: AgentSpec,
  tools: readonly string[],
  own: boolean,
): string[] {
  const levels = levelsOf(spec)
  const role = speaksForColony(spec, agent) ? 'lead' : 'crew'
  const leading = role === 'lead' && leadsCrew(spec)
  const off = new Set(groupsOff(levels, leading ? 'lead' : 'crew').flatMap((g) => ACCESS_GROUPS[g]))
  const hands =
    leading && !own && isLead(spec, agent) && spec.tier === 'team' && spec.team?.mode !== 'swarm'
      ? LEAD_WORK_GROUPS.flatMap((g) => ACCESS_GROUPS[g])
      : []
  return [...new Set([...tools, ...hands])].filter((t) => !off.has(t) && !toolHidden(levels, t, role))
}

export function toolsFor(spec: ColonySpec, agent: AgentSpec): string[] {
  const tools = withRoleAccess(spec, agent, agent.tools ?? roleTools(spec, agent), agent.tools !== undefined)
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
    const escalates = toolsFor(spec, agent).includes('escalate')
    return prompts.roles.solo(escalationNote(spec), list ? prompts.roles.crewmates(list, escalates) : '')
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
  /** The round may use the person's Mac (computer use). */
  readonly computer?: boolean
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
  const lines = [
    prompts.environment.today({
      date: localDate(now),
      weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
      zone: `${personZone()} (${zoneOffset(now)})`,
    }),
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
  else if (project)
    lines.push(
      prompts.environment.project({
        name: project.name,
        path: project.path,
        propose: tools.includes('propose'),
      }),
    )
  if (env.boundary && tools.some((t) => t.startsWith('web_') || t.startsWith('browser_') || t === 'mcp'))
    lines.push(prompts.environment.untrusted(env.boundary))
  const levels = levelsOf(spec)
  const preset = effectivePreset(levels).preset
  if (env.sandbox === 'unconfined') lines.push(prompts.environment.fullAccess)
  if (env.computer && tools.includes('computer')) lines.push(prompts.environment.computer(env.boundary))
  if (preset === 'read-only' && project)
    lines.push(prompts.environment.readOnly(project.name, tools.includes('propose')))
  else if (preset === 'ask') {
    const allowed = rulesIn(levels).flatMap((r) =>
      r.kind === 'command' && r.decision === 'allow' ? [r.target] : [],
    )
    lines.push(prompts.environment.ask(project?.name, allowed.includes('*') ? [] : [...new Set(allowed)]))
  }
  if (env.skills?.length && tools.includes('use_skill')) {
    const skills = env.skills.slice(0, 40)
    const fits = skillsFor(spec.chat?.request ?? spec.mission, skills)
    lines.push(
      prompts.environment.skills(
        fits
          .map(
            (s) =>
              `- ${s.name}: ${s.description.length > 220 ? `${s.description.slice(0, 217)}…` : s.description}`,
          )
          .join('\n'),
        skills.filter((s) => !fits.includes(s)).map((s) => s.name),
      ),
    )
  }
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
  if (project && env.project?.checks.length && tools.includes('run_checks'))
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
  if (env.sandbox !== 'unconfined' && (tools.includes('shell') || tools.includes('fs_read')))
    lines.push(
      prompts.environment.reads({
        folders: spec.askAll ? [] : (spec.reads ?? []),
        ask: tools.includes('request_read') && !spec.askAll,
      }),
    )
  return lines.join('\n')
}

// Words too common in requests and skill descriptions to say a skill fits.
const COMMON_WORDS = new Set(
  'about after also because before being both build code could create does done each file files find from have help into just know like look make many more most much need only other over please should show some such take task tasks tell than that their them then there these they this those very want what when where which while will with work would write your'.split(
    ' ',
  ),
)

/**
 * The skills a request may need: those whose name or description shares a word with it. They are listed with their
 * descriptions; the rest go by name only, so every agent does not carry every playbook's description.
 */
export function skillsFor<T extends { name: string; description: string }>(
  request: string,
  skills: readonly T[],
): T[] {
  const words = (text: string) =>
    (text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !COMMON_WORDS.has(w))
  const asked = new Set(words(request))
  if (asked.has('skill') || asked.has('skills')) return [...skills]
  return skills.filter((s) =>
    words(`${s.name.replace(/[-_]/g, ' ')} ${s.description}`).some((w) => asked.has(w)),
  )
}

/** What this agent can do here, stated from the actual configuration so capability answers are factual. */
function capabilities(spec: ColonySpec, agent: AgentSpec, env: Environment): string {
  const tools = toolsFor(spec, agent)
  const has = (t: string) => tools.includes(t)
  const say = prompts.capabilities
  const ready = new Set(preloaded(spec.chat?.request ?? spec.mission, tools))
  // A capability whose tools load on demand says how to load them.
  const load = (tool: string, query: string) =>
    has('find_tools') && onDemand(tool) && !ready.has(tool) ? say.load(query) : ''
  const lead = spec.agents.find((a) => isLead(spec, a))?.name ?? 'lead'
  const onCall = spec.team?.crewmates?.length ?? 0
  const mode =
    spec.tier === 'answer'
      ? say.modes.answer
      : spec.chat && spec.tier === 'solo' && agent.role === 'worker'
        ? say.modes.crewmate(lead)
        : spec.chat && spec.tier === 'solo' && has('ask_crewmate')
          ? say.modes.soloCrew(onCall)
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
        has('browser_open') &&
          (env.browser ? `${say.browser}${load('browser_open', 'browser')}` : say.noBrowser),
        has('mcp') && say.mcp,
        has('computer') && env.computer && `${say.computer}${load('computer', 'computer')}`,
        has('create_tool') &&
          env.sandbox !== 'none' &&
          `${say.makeTools}${load('create_tool', 'create_tool')}`,
        has('create_task') && say.createTasks,
        has('add_crewmate') && say.addWorkers,
        has('reply_user') && say.talk,
      ]
        .filter(Boolean)
        .join('; '),
    ),
    `${say.limits}${has('create_tool') ? say.madeToolsKept : ''}`,
    say.docs(!doesWork(spec, agent)),
  ].join('\n')
}

/** Agents that do hands-on work (everyone except a lead that only delegates, and direct answers). */
function doesWork(spec: ColonySpec, agent: AgentSpec): boolean {
  if (spec.tier === 'answer') return false
  return !(isLead(spec, agent) && spec.chat && spec.agents.length > 1)
}

/** Whether the round's final answer is reviewed: never with no acceptance checks or the reviewer off. */
function reviewed(spec: ColonySpec): boolean {
  return spec.acceptance.length > 0 && spec.review !== 'off'
}

/** What happens to the speaking agent's final answer under this round's reviewer setting. */
function reviewNote(spec: ColonySpec): string {
  if (!reviewed(spec)) return prompts.review.off
  const judge = spec.acceptance.find((c) => c.verifier === 'llm-judge')
  const by = judge?.verifier === 'llm-judge' ? judge.model : spec.acceptance.map((c) => c.verifier).join(', ')
  return spec.review === 'auto' ? prompts.review.auto(by) : prompts.review.always(by)
}

/** The parts of how the colony works that apply to this agent: a solo-round crewmate has no tasks or team chat. */
function common(spec: ColonySpec, agent: AgentSpec): string {
  const tools = toolsFor(spec, agent)
  const crewmate = spec.chat !== undefined && spec.tier === 'solo' && agent.role === 'worker'
  return prompts.system.common({
    tasks: tools.includes('claim_task'),
    talk: !crewmate && tools.includes('message'),
    groups: tools.includes('create_group'),
    deliver: !crewmate && tools.includes('publish_artifact'),
    reviewed: !crewmate && (!spec.chat || reviewed(spec)),
    // The crewmate's brief says how it finishes: by answering the lead.
    finish: !crewmate,
    honest: !doesWork(spec, agent),
  })
}

export function systemPrompt(spec: ColonySpec, agent: AgentSpec, env: Environment): string[] {
  const team = spec.agents.length > 1
  const tools = toolsFor(spec, agent)
  return [
    prompts.system.identity(agent.name),
    capabilities(spec, agent, env),
    roleBrief(spec, agent),
    doesWork(spec, agent) ? prompts.system.craft.trim() : '',
    team ? common(spec, agent) : '',
    spec.chat && tools.includes('reply_user') && speaksForColony(spec, agent)
      ? `${prompts.system.speaker({ web: tools.includes('web_search'), plugins: tools.includes('create_plugin') }).trim()}\n- ${reviewNote(spec)}`
      : '',
    tools.includes('submit_task') ? prompts.review.tasks(spec.taskJudge) : '',
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
  // A crewmate the lead asks for a job is woken by the job; the person's request is the lead's.
  if (spec.chat && spec.tier === 'solo' && agent.role === 'worker') return false
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
  const changed = agent && spec.chat.accessNotices?.[agent] ? `${spec.chat.accessNotices[agent]}\n\n` : ''
  const request = `${history}${changed}${context}[user] ${spec.chat.request}${attachedNote(attached)}${spoken}${plan}`
  if (spec.tier === 'answer') return request
  const files = Object.keys(state.artifacts).filter((f) => !attached?.includes(f))
  const carried = files.length > 0 ? prompts.kickoff.carried(files) : ''
  if (to?.length) return prompts.kickoff.addressed(`${request}${carried}`, snapshot(spec, state))
  if (spec.tier !== 'team' || spec.agents.length === 1) return `${request}${carried}`
  if (spec.team?.mode === 'swarm') return prompts.kickoff.huddle(request, snapshot(spec, state))
  return `${request}\n\n${snapshot(spec, state)}`
}
