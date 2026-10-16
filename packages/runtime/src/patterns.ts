import { ACCESS_GROUPS, type ColonyState, groupsOff, LEAD_WORK_GROUPS, toolHidden } from '@myrmidon/protocol'
import { levelsOf, presetOf } from './permissions.ts'
import type { ProjectContext } from './project-context.ts'
import { prompts } from './prompts.ts'
import type { AgentSpec, ColonySpec } from './spec.ts'
import type { Effort } from './thinking.ts'

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
/** Exploring in a fold of the context that collapses into a report: on demand, as omp marks them discoverable. */
const CHECKPOINT = ['checkpoint', 'rewind']
const READ = ['read_task', ...LOOK, 'observe', ...WEB, 'read_docs', 'use_skill', ...CHECKPOINT]
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
  'find',
  'ast_grep',
  'ast_edit',
  'lsp',
  'security_scan',
  'request_read',
  'shell',
  'eval',
  'debug',
  'run_checks',
  'autoresearch',
  'start_server',
  'server_logs',
  'stop_server',
  'create_tool',
  'github',
  ...BROWSER,
  'mcp',
  ...ACCESS_GROUPS.remote,
  ...ACCESS_GROUPS.computer,
]
const USER = [
  'reply_user',
  'check_in',
  'ask_user',
  'remember',
  'recall',
  'search_chats',
  'learn',
  'manage_skill',
]
/** Structural search and rewrite, and language servers: loaded on demand, as omp marks them discoverable. */
const CODE_INTEL = ['ast_grep', 'ast_edit', 'lsp']
/** Code cells whose state lasts the round: loaded on demand, as omp marks its eval discoverable. */
const CELLS = ['eval']
/** A debugger and a security scan: loaded on demand, as omp marks its debug and security_scan discoverable. */
const CHECKING = ['debug', 'security_scan']
/** Pictures and speech, published like files: loaded on demand, as omp marks generate_image and tts discoverable. */
const MEDIA = ['generate_image', 'tts']
/** Delivering files to the person: written ones, and pictures and speech made for them. */
const PUBLISH = ['publish_artifact', ...MEDIA]
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
        ...ACCESS_GROUPS.computer,
        // In a project, quick questions are often about its code: reading it needs no team.
        ...(spec.chat.project
          ? ['fs_read', 'fs_list', 'grep', 'glob', 'find', 'ast_grep', 'request_read']
          : []),
        'list_artifacts',
        'read_artifact',
        // "Draw me…", "read this aloud": the picture or the sound is the answer.
        ...MEDIA,
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
      return [...READ, 'message', 'append_note', ...PUBLISH, ...BUILD]
    const crewmates =
      spec.tier === 'solo' && isLead(spec, agent) && spec.team?.crewmates?.length ? ['ask_crewmate'] : []
    if (spec.tier !== 'team' || spec.agents.length === 1)
      return [
        ...READ,
        'append_note',
        ...PUBLISH,
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
        ...PUBLISH,
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
        // It assigns tasks and never holds one, so it has no claim, release or submit.
        ...PUBLISH,
        ...USER,
        ...review,
        ...plugin,
        ...spawn,
        ...(spec.agents.length > 1 ? ['dismiss_crewmate'] : []),
      ]
    }
    // A worker speaks to the person only when they wrote to it directly (@name).
    return [...READ, ...TALK, ...HOLD, ...PUBLISH, ...BUILD, 'reply_person']
  }
  const work = [...PUBLISH, ...BUILD]
  if (isLead(spec, agent))
    return [...READ, ...TALK, 'create_task', 'reject_task', ...HOLD, ...work, 'request_final_verification']
  if (spec.pattern === 'lead-workers') return [...READ, ...TALK, ...HOLD, ...work]
  return [...READ, ...TALK, 'create_task', 'reject_task', ...HOLD, ...work, 'request_final_verification']
}

/**
 * Tools an agent loads when it needs them (find_tools) instead of carrying their definitions in every model call:
 * the browser, dev servers, tool making, GitHub (omp marks it discoverable), the person's MCP servers, made tools,
 * and rarely used lookups. Anything not listed here is always loaded.
 */
const ON_DEMAND = new Set([
  'github',
  'autoresearch',
  'request_login',
  'start_server',
  'server_logs',
  'stop_server',
  'create_tool',
  'read_log',
  'read_docs',
  ...CODE_INTEL,
  ...CELLS,
  ...CHECKING,
  ...CHECKPOINT,
  // Retiring and rewriting skills is rare; learn, which carries a skill too, stays loaded as omp's is essential.
  'manage_skill',
  ...MEDIA,
  ...ACCESS_GROUPS.remote,
  ...ACCESS_GROUPS.computer,
  ...PLUGIN,
])

/**
 * On-demand tools that only work together, so loading one loads the rest: the computer works in apps open_app opens,
 * and rewind ends what checkpoint starts.
 */
const LOADED_TOGETHER: readonly (readonly string[])[] = [ACCESS_GROUPS.computer, CHECKPOINT]

/** These tool names with the tools that load together with them. */
export function withCompanions(names: readonly string[]): string[] {
  return [...new Set(names.flatMap((n) => LOADED_TOGETHER.find((g) => g.includes(n)) ?? [n]))]
}

/**
 * On-demand tools a request plainly calls for, loaded from the start so the agent does not spend a step asking:
 * a URL or web page means the browser, a dev server means the server tools, a pull request or CI means github.
 */
export function preloaded(request: string, names: readonly string[]): string[] {
  const browser =
    /https?:\/\/|\bbrows|\bwebsite|\bweb ?page|\bsite\b|\bclick|\bsign ?in\b|\blog ?in\b|\bform\b|\bscreenshot|\bdownload|\bupload/i.test(
      request,
    )
  const server = /\bdev server|\blocalhost\b|\bserve it\b|\bstart (the )?(app|server)\b/i.test(request)
  const plugin = /\bplugin|\bmyrmidon\b/i.test(request)
  const code =
    /\b(renam\w*|refactor\w*|codemod|references?|call ?sites?|callers|go ?to ?definition|type errors?|diagnostics|ast[ -]grep)\b/i.test(
      request,
    )
  const cells =
    /\b(repl|notebook|jupyter|pandas|numpy|dataframes?|data ?analysis|analy[sz]e (the )?data|crunch|interactive(ly)?)\b/i.test(
      request,
    )
  const debug = /\b(debug(ger|ging)?|breakpoints?|step through)\b/i.test(request)
  const security =
    /\b(security (scan|audit|review|check)|leaked (secrets?|keys?|tokens?)|secret scan\w*|vulnerab\w*|CVEs?|npm audit|pip-audit)\b/i.test(
      request,
    )
  const github =
    /\bgithub\b|\bpull requests?\b|\bPRs?\b|\bPR ?#?\d+|\bissue ?#\d+|\bCI\b|\bworkflow runs?\b|\bactions? runs?\b/i.test(
      request,
    )
  const picture =
    /\b(draw|paint|sketch|illustrat\w*|logos?|pictures?|photos?|posters?|wallpapers?|avatars?|(generate|make|create|design|edit)\b[^.]{0,30}\b(images?|icons?|banners?|art(work)?))\b/i.test(
      request,
    )
  const speech =
    /\b(aloud|read (it|this|that) out|narrat\w*|voice-?overs?|text[ -]to[ -]speech|tts|audio (file|version|clip)|pronounc\w*)\b/i.test(
      request,
    )
  const computer =
    /\b(my (mac|screen|desktop|computer)|on (my|the) screen|desktop app|native app|the app\b|open (the )?\w+ app|finder|system settings|simulator|xcode|computer use)\b/i.test(
      request,
    )
  const experiment =
    /\b(autoresearch|experiment loop|experiments?\b[^.]{0,40}\b(metric|benchmark)|optimi[sz]e\b[^.]{0,40}\bbenchmark)/i.test(
      request,
    )
  const remote = /\bssh\b|\bremote (host|server|machine|box)s?\b|\bon (the|my|our) (server|vps|box)\b/i.test(
    request,
  )
  return names.filter(
    (n) =>
      (browser && (n.startsWith('browser_') || n === 'request_login')) ||
      (server && ['start_server', 'server_logs', 'stop_server'].includes(n)) ||
      (plugin && (PLUGIN.includes(n) || n === 'read_docs')) ||
      (code && CODE_INTEL.includes(n)) ||
      (cells && CELLS.includes(n)) ||
      (debug && n === 'debug') ||
      (security && n === 'security_scan') ||
      (github && n === 'github') ||
      (picture && n === 'generate_image') ||
      (speech && n === 'tts') ||
      (computer && ACCESS_GROUPS.computer.includes(n)) ||
      (remote && ACCESS_GROUPS.remote.includes(n)) ||
      (experiment && n === 'autoresearch'),
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
  // Remote hosts are the person's: only a round of theirs with hosts set up reaches them.
  const remote = spec.remotes?.length && !spec.askAll ? [] : ACCESS_GROUPS.remote
  // An experiment keeps and reverts changes on a branch of the project, unasked: only where changes need no approval.
  const preset = presetOf(spec)
  const experiment = spec.chat?.project && (preset === 'auto' || preset === 'full') ? [] : ['autoresearch']
  const disabled = new Set([
    ...(spec.disabledTools ?? []),
    ...(agent.withoutTools ?? []),
    ...remote,
    ...experiment,
  ])
  const allowed = disabled.size ? tools.filter((t) => !disabled.has(t)) : tools
  // Whoever has tools that load on demand gets the tool that loads them; MCP and made tools are among them.
  return allowed.some((t) => t === 'mcp' || t === 'shell' || onDemand(t))
    ? [...allowed, 'find_tools']
    : allowed
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
  /** What computer use runs on (Settings → Computer use → Engine); Cua Driver when absent. */
  readonly computerEngine?: 'cua' | 'omp'
  readonly project?: ProjectContext
  /** The agent's own git worktree of the project, when it has one. */
  readonly worktree?: { workdir: string; branch: string; copy?: true }
  /** The agent's scratch directory. */
  readonly scratch?: string
  /** Skills the agent can load by name. */
  readonly skills?: readonly { name: string; description: string }[]
  /** Sections the person's plugins add for this agent. */
  readonly plugins?: readonly string[]
  /** Secrets reach the model as placeholders (Settings → Permissions; provider-secrets.ts). */
  readonly secretsHidden?: boolean
}

/**
 * How hard a reasoning model thinks per step. Planning and solo work decide the outcome, so they think hard;
 * workers on a scoped task think moderately; a direct answer stays quick.
 */
export function thinkingFor(spec: ColonySpec, agent: AgentSpec): Effort {
  // As omp's ultrathink: the top level, which each model then clamps to the highest it has.
  if (spec.ultrathink) return 'max'
  if (spec.tier === 'answer') return 'low'
  if (spec.thinking) return spec.thinking
  // A lone chat agent often just answers; it thinks harder when the person asks for it.
  if (spec.chat && spec.agents.length === 1) return 'medium'
  if (spec.agents.length === 1 || isLead(spec, agent)) return 'high'
  return 'medium'
}

/** Runtimes present on this machine, checked once, so agents know what they can actually run. */
export const RUNTIMES = ['bun', 'node', 'python3', 'deno', 'uv', 'git'].filter((c) => Bun.which(c) !== null)

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

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/**
 * The state an agent needs on waking, so it does not spend a turn re-reading empty boards. `request: false` leaves out
 * the request, for a message that already opens with it.
 */
export function snapshot(spec: ColonySpec, s: ColonyState, { request = true } = {}): string {
  const plan = s.notes.filter((n) => n.section === 'plan').at(-1)
  const tasks = Object.values(s.tasks).filter((t) => t.status !== 'deleted')
  const files = Object.entries(s.artifacts)
  const notes = s.notes.filter((n) => n.section !== 'plan').slice(-5)
  // Without the request line, the person's message that is the request is left out of the conversation too.
  const talk = s.chatMessages
    .filter((m) => request || !(m.from === 'user' && m.text === (spec.chat?.request ?? spec.mission)))
    .slice(-4)
  return [
    request ? `REQUEST: ${spec.chat?.request ?? spec.mission}` : '',
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
  // A crewmate the lead asks for a job starts with the job (its focus); the person's request is the lead's.
  if (spec.chat && spec.tier === 'solo' && agent.role === 'worker') return agent.focus !== undefined
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
  // A crewmate on call opens with its job (the assembled kickoff prefix), never the person's request.
  if (spec.tier === 'solo' && spec.agents.find((a) => a.name === agent)?.role === 'worker') return ''
  if (to?.length && agent && !to.includes(agent))
    return prompts.kickoff.addressedElsewhere(to, spec.chat.request)
  const history = spec.chat.history && !remembers ? prompts.kickoff.history(spec.chat.history) : ''
  // Where the chat left off: after the history, nearest the request. An agent that remembers the chat gets it as its
  // mental model of the earlier rounds, whose tool output it no longer has word for word.
  const handoff = spec.chat.handoff
  const note = handoff
    ? (remembers ? prompts.kickoff.mentalModel : prompts.kickoff.handoff)(
        handoff.text,
        handoff.at.slice(0, 10),
      )
    : ''
  // This round's request, not the chat's first one: a colony serves every round of its chat.
  const from = state.rounds.at(-1)?.startSeq ?? 0
  const attached = state.chatMessages.find((m) => m.from === 'user' && m.seq >= from)?.attachments
  const plan = spec.planFirst ? prompts.kickoff.planFirst : ''
  const goal = spec.goal
    ? prompts.kickoff.goal({
        condition: spec.goal.condition,
        check: spec.goal.check,
        max: spec.goal.maxChecks,
      })
    : ''
  // Only the lead hands off (ColonyRun._handOff), so only the lead is told to plan for it.
  const lead = spec.agents.find((a) => a.name === agent)?.role === 'lead'
  const prewalk = spec.prewalk && lead ? prompts.kickoff.prewalk(spec.prewalk) : ''
  // Magic words (magic-words.ts): orchestrating is the lead's job, so only the lead is told how.
  const ultrathink = spec.ultrathink ? prompts.kickoff.ultrathink : ''
  const speaker = spec.agents.find((a) => a.name === agent)
  const orchestrate =
    spec.orchestrate && speaker && isLead(spec, speaker)
      ? prompts.kickoff.orchestrate(toolsFor(spec, speaker))
      : ''
  const context = spec.chat.context ? prompts.chat.context(spec.chat.context) : ''
  const spoken = spec.chat.voice ? prompts.chat.spoken : ''
  const changed = agent && spec.chat.accessNotices?.[agent] ? `${spec.chat.accessNotices[agent]}\n\n` : ''
  const request = `${history}${note}${changed}${context}[user] ${spec.chat.request}${attachedNote(attached)}${spoken}${ultrathink}${plan}${goal}${prewalk}${orchestrate}`
  if (spec.tier === 'answer') return request
  const files = Object.keys(state.artifacts).filter((f) => !attached?.includes(f))
  const carried = files.length > 0 ? prompts.kickoff.carried(files) : ''
  // The message opens with the request, so the snapshot leaves its own copy out.
  const board = snapshot(spec, state, { request: false })
  if (to?.length) return prompts.kickoff.addressed(`${request}${carried}`, board)
  if (spec.tier !== 'team' || spec.agents.length === 1) return `${request}${carried}`
  if (spec.team?.mode === 'swarm') return prompts.kickoff.huddle(request, board)
  return `${request}\n\n${board}`
}
