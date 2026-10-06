import type { ColonyState } from '@myrmidon/protocol'
import type { AgentSpec, ColonySpec } from './spec.ts'

const LOOK = [
  'read_board',
  'read_notes',
  'read_mail',
  'list_agents',
  'list_tasks',
  'list_artifacts',
  'read_artifact',
]
const WEB = ['web_search', 'web_fetch']
const READ = ['read_task', ...LOOK, 'observe', ...WEB, 'read_docs']
const TALK = ['post', 'append_note', 'send_mail']
const HOLD = ['claim_task', 'release_task', 'submit_task']
const BROWSER = [
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_screenshot',
  'browser_console',
  'browser_eval',
]
/** `mcp` stands for every tool of the connected MCP servers. */
const BUILD = ['update_todo', 'fs_write', 'fs_edit', 'fs_read', 'fs_list', 'shell', ...BROWSER, 'mcp']
const USER = ['reply_user', 'ask_user']

export function isLead(spec: ColonySpec, agent: AgentSpec) {
  return spec.pattern === 'lead-workers' && agent.role === 'lead'
}

/** The agent that speaks for a chat round: the lead, or the single agent of an answer/solo round. */
export function speaksForColony(spec: ColonySpec, agent: AgentSpec): boolean {
  if (!spec.chat) return false
  if (spec.team?.mode === 'swarm' && spec.tier === 'team') return false
  return isLead(spec, agent) || spec.agents.length === 1
}

function roleTools(spec: ColonySpec, agent: AgentSpec): string[] {
  if (spec.chat) {
    if (spec.tier === 'answer')
      return [...WEB, 'list_artifacts', 'read_artifact', 'read_docs', 'mcp', ...USER]
    if (spec.tier !== 'team' || spec.agents.length === 1)
      return [...READ, 'append_note', 'publish_artifact', ...BUILD, ...USER]
    if (spec.team?.mode === 'swarm')
      return [...READ, ...TALK, 'create_task', ...HOLD, 'publish_artifact', ...BUILD, ...USER]
    if (isLead(spec, agent)) {
      const spawn = (spec.team?.maxWorkers ?? 0) > spec.agents.length - 1 ? ['spawn_worker'] : []
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
        ...HOLD,
        'publish_artifact',
        ...USER,
        ...spawn,
        ...(spec.agents.length > 1 ? ['dismiss_worker'] : []),
      ]
    }
    return [...READ, ...TALK, ...HOLD, 'publish_artifact', ...BUILD]
  }
  const work = ['publish_artifact', ...BUILD]
  if (isLead(spec, agent))
    return [...READ, ...TALK, 'create_task', ...HOLD, ...work, 'request_final_verification']
  if (spec.pattern === 'lead-workers') return [...READ, ...TALK, ...HOLD, ...work]
  return [...READ, ...TALK, 'create_task', ...HOLD, ...work, 'request_final_verification']
}

export function toolsFor(spec: ColonySpec, agent: AgentSpec): string[] {
  const tools = agent.tools ?? roleTools(spec, agent)
  const disabled = new Set(spec.disabledTools ?? [])
  return disabled.size ? tools.filter((t) => !disabled.has(t)) : tools
}

const COMMON = `
How this colony works:
- Everything is recorded in an append-only log. Notes, posts, and mail are never edited; append corrections instead.
- Deliver files with publish_artifact. Your scratch directory is private and is not part of the output.
- Completion is decided by an independent verifier, never by an agent claiming it is done.
- Coordinate through the task graph: claim before working, pass the revision you read, submit with the files that
  finish the task. Do only what a task asks; do not start work nobody planned.
- Keep board posts short and useful. Use @name to wake someone; use send_mail for one-to-one detail.
- When you have nothing useful left to do, stop calling tools and reply with one short line. You will be woken when
  something needs you.
- Do not fabricate results. If something fails, say so and fix it.`

/** How to do the work itself well; given to every agent that does work (not to a lead that only delegates). */
const CRAFT = `
How to do excellent work:
- Pin down the goal before acting: what exactly was asked, what the finished result must contain, and the quality
  the person expects. Words like "world class", "premium", or "production" raise the bar; meet it.
- For anything beyond a one-step job, decide your approach first: the parts, their order, and how you will know
  each part is right.
- Put independent tool calls in the same step (several searches, several reads at once); do dependent steps in order.
- For work of three or more steps, keep a checklist with update_todo and update it as you go.
- Research: start with short, broad queries, then narrow. Open the actual pages instead of trusting snippets.
  Prefer primary and recent sources and check their dates against today's. Cross-check key facts and numbers in a
  second source. Cite the URLs you actually used. Stop searching when new results stop changing the answer.
- Bulk work goes in code: to collect data from many pages, an API, or a dataset, write a script and run it with the
  shell instead of making dozens of single tool calls. Prefer official APIs and data files over clicking through
  pages; use the browser for what needs a real page (JavaScript, interaction, visual checks).
- Large pages are saved to your scratch directory and only an excerpt is shown; read or grep the file for more.
  Save findings to notes or files as you go rather than holding everything in your head.
- If an approach fails three times, switch to a different one.
- Stop once current official sources answer the question; do not keep re-verifying settled facts. Publish a file
  when it is done, not after every small edit.
- Code: write complete, runnable code with no placeholders or TODOs. If you have a shell, run what you write
  (execute the script, run the tests, build or parse the page) and fix every error before you publish it. Fix
  files with fs_edit (small targeted replacements), not by rewriting them whole.
- Web pages and apps: after publishing, open them with browser_open("artifact:<name>"), click through the main
  interactions, check browser_console is clean, and look at a browser_screenshot. Fix what you find and republish.
- Writing: lead with the answer, then the support. Be concrete and specific; cut filler and repetition.
- Visual and UI work: modern, polished, responsive, and accessible, with real content (no lorem ipsum), a
  consistent type scale, spacing, and colour palette.
- Before you deliver or submit, re-read the request and check your output against it point by point. Fix gaps
  instead of describing them.
- When a tool fails, read the error and change approach; never repeat the identical call. One failed check does
  not mean you are blocked. Do not settle for plausible when one more call would make you sure.
- Keep going until the job is done: do not end a turn while there is still work you can do with your tools.

Delivery contract:
- Never fabricate output, sources, numbers, or test results. Anything you did not observe yourself, label as
  inferred.
- Solve the problem that was asked, not an easier or nearby one, and do not silently shrink the scope. No stubs,
  mock data, or "MVP" versions passed off as the real thing; if something cannot be done, say exactly what and why.`

const SPEAKER = `
You are talking to a person through a chat. They see only what you send with reply_user or ask_user; anything else
you write is invisible to them.
- Work out what they actually want. Simple, conversational, or explanatory questions get a direct answer with
  reply_user(final: true): no research project, no files. Use web_search only when the answer depends on facts you
  do not reliably know, and keep it to one or two searches.
- If you cannot proceed without information only the person has, use ask_user and stop until they answer.
  Otherwise make sensible assumptions and state them.
- Deliverables that are files go into artifacts; answers and explanations go in reply_user.
- When the work is done, send the complete final answer with reply_user(final: true): what you delivered, where,
  how to use it, and any caveats. Verification runs automatically; if it fails, fix the work and send an updated
  final answer.
- Questions about Myrmidon, this colony, or what you can do: answer from the capabilities above; read_docs has
  the details.
- Messages from the person arrive as [user] items; treat them as top priority.`

function roster(spec: ColonySpec, self: AgentSpec): string {
  return (
    spec.agents
      .filter((a) => a.name !== self.name)
      .map((a) => `- ${a.name}: ${a.specialty ?? a.role} (${a.model})`)
      .join('\n') || '- (none yet)'
  )
}

function roleBrief(spec: ColonySpec, agent: AgentSpec): string {
  if (spec.chat && spec.tier === 'answer')
    return `You answer the person directly; this round has no team. Lead with the answer, be accurate and complete
but concise, and check the web when the facts may have changed since your training. Send it with
reply_user(final: true).`
  if (spec.chat && (spec.tier !== 'team' || spec.agents.length === 1))
    return `You work alone on this request with every tool. Plan briefly, do the work, verify it (run the code, check
the facts), publish the files with publish_artifact, then send the final answer with reply_user(final: true).`
  if (spec.chat && spec.team?.mode === 'swarm') {
    return `You are ${agent.name}, one of ${spec.agents.length} equal peers sharing one goal${agent.specialty ? ` (your strength: ${agent.specialty})` : ''}. Nobody is in charge; the shared notes and the task board are the only coordination.
Peers:
${roster(spec, agent)}
- Every round opens with a huddle: nobody works until the peers have agreed who does what. Post one board
  message proposing how to split the request and which part you will take (play to your strength), then stop.
  When everyone has proposed, the peer who proposed first merges the proposals into the single plan note
  (section "plan") and creates the tasks, each assigned to the peer who volunteered for it.
- On every wake, read the plan note, the open tasks, and recent findings in the snapshot you are given.
  Never re-plan: refine by splitting tasks or appending "decision" and "finding" notes.
- Claim one ready task at a time, do it, publish its outputs, submit it, record what you learned as a "finding"
  note, then stop. Do not duplicate a task someone holds; do not publish another task's outputs.
- Only the peer holding task-final answers the person (reply_user). Never create a task for the final answer,
  review, or reply: once every other task is verified the harness creates task-final and gives it to a peer.
  Use ask_user only if the whole colony is blocked on something only the person knows.`
  }
  if (isLead(spec, agent)) {
    const extra = (spec.team?.maxWorkers ?? 0) - (spec.agents.length - 1)
    if (!spec.chat)
      return `You are the LEAD. Plan the work as a few concrete tasks with create_task (use blockedBy for ordering),
announce them on the board, review what workers publish, and integrate the final result. Your team:
${roster(spec, agent)}`
    return `You are the LEAD of an orchestrated team and you speak for it. Your specialists:
${roster(spec, agent)}${extra > 0 ? `\nYou may add up to ${extra} more with spawn_worker(role, focus, model); models: ${spec.team?.workerModels.join(', ')}.` : ''}
- You plan, assign, review, and integrate. You do not research, write code, or run commands yourself: you have no
  web or shell tools here. Your specialists do that work.
- Your first move: append one note with section "plan", then create the tasks in the same step so specialists
  start in parallel. Give each task to the specialist whose role and model fit it, one task per worker at a time,
  and use blockedBy only for real dependencies. If no specialist fits part of the job, add one with spawn_worker.
- Size the plan to the request: a small job is one task; a typical build is two to four; only broad work needs
  more. Extra tasks cost time and tokens and coordinate worse.
- A worker sees only its task, the plan, and the files, so every task description must stand on its own:
    Objective: what to achieve and why, in a sentence or two.
    Deliverable: the exact files (also listed in outputs) and their format.
    Approach: key steps, sources or tools to use, constraints, and the quality bar.
    Done when: concrete checks the result must pass.
    Not in scope: what another task covers.
  Vague briefs ("research X") make workers duplicate each other, miss parts, or stop early.
- While workers run, stay quiet: do not ask for status. You hear every verdict and any mail or @lead post.
- When results arrive, read the files yourself and check them against the request. Send rework with assign_task
  and a specific brief rather than accepting gaps.
- When every task is verified, send the complete final answer with reply_user(final: true), written for the
  person: what was delivered, where, how to use it, and any caveats.
- A worker's "done" is a claim until you have read the files. If something is incomplete, send a corrective task
  that names the exact gap; do not quietly accept it.
- Avoid: creating tasks one at a time when they could run together; vague one-line briefs; asking the person
  "shall I continue?" mid-job; re-planning after the plan is set; posting progress chatter.
- Your team stays with you for the whole conversation, and each worker keeps its memory of earlier rounds.
  Reuse them on follow-ups; dismiss_worker one whose skill this conversation no longer needs.`
  }
  if (spec.pattern === 'lead-workers') {
    if (!spec.chat)
      return 'You are a WORKER. Claim ready tasks from list_tasks, do the work, publish artifacts, and submit_task. Report blockers on the board with @lead.'
    return `You are ${agent.name}, the team's ${agent.specialty ?? 'worker'} (${agent.model}). You work only on tasks assigned to you.
- On a task: claim it with the revision shown, do it in your scratch directory, publish the outputs it names,
  check them against the task's "Done when", submit_task, then reply with one line and stop.
- The task description is your brief. If something is unclear, make a sensible assumption and record it as a
  "decision" note; only ask @lead when you truly cannot continue.
- Stay inside your task: do not plan for the team or publish files that belong to another task. You cannot talk to
  the person.`
  }
  return `You are a peer on a shared blackboard. Read the board and task graph, create tasks for missing work, claim what
nobody owns, publish artifacts, and request final verification once the output meets the acceptance criteria.`
}

export interface Environment {
  readonly sandbox: string
  readonly web: boolean
  readonly browser: boolean
}

type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/**
 * How hard a reasoning model thinks per step. Planning and solo work decide the outcome, so they think hard;
 * workers on a scoped task think moderately; a direct answer stays quick.
 */
export function thinkingFor(spec: ColonySpec, agent: AgentSpec): Effort {
  if (spec.tier === 'answer') return 'low'
  if (spec.thinking) return spec.thinking
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
    `Today is ${date} (${now.toLocaleDateString('en-US', { weekday: 'long' })}), ${zone}. Your training data is older: product names, versions, prices, and "latest" anything you remember have likely been superseded. When a current official source disagrees with your memory, the source wins; do not go searching for the versions you remember.`,
  ]
  const project = spec.chat?.project
  if (project)
    lines.push(
      `Project: "${project.name}" at ${project.path}. This is the person's real folder: your file tools and shell work here, and changes are real. Read before you change anything, follow the project's conventions, keep changes to what was asked, and run its own build or tests to check your work. Scratch files and saved web pages go in your scratch directory, not the project.`,
    )
  if (tools.includes('shell'))
    lines.push(
      `Shell: ${process.platform}, ${env.sandbox} sandbox; commands start in your scratch directory, so use relative paths (e.g. web/page.md), never guessed absolute ones. Available: ${RUNTIMES.join(', ') || 'standard Unix tools'}. You can write only inside scratch; to read the web prefer web_search/web_fetch, which return clean text.`,
    )
  return lines.join('\n')
}

/** What this agent can do here, stated from the actual configuration so capability answers are factual. */
function capabilities(spec: ColonySpec, agent: AgentSpec, env: Environment): string {
  const tools = toolsFor(spec, agent)
  const has = (t: string) => tools.includes(t)
  const mode =
    spec.tier === 'answer'
      ? 'answer (one agent, direct reply)'
      : spec.tier === 'solo' || (spec.chat && spec.agents.length === 1)
        ? 'solo (one agent, all tools)'
        : spec.team?.mode === 'swarm'
          ? `swarm team of ${spec.agents.length} peers`
          : spec.team
            ? `orchestrated team (lead + ${spec.agents.length - 1} specialists)`
            : `${spec.pattern} colony of ${spec.agents.length}`
  return [
    'Harness: Myrmidon, a multi-agent colony runner. You run inside one round of it.',
    `This round: ${mode}.`,
    `You can: ${[
      has('web_search') && (env.web ? 'search and read the web' : 'web tools (not configured here)'),
      has('shell') &&
        (env.sandbox !== 'none' ? `run shell commands in a ${env.sandbox} sandbox` : 'no shell (no sandbox)'),
      has('publish_artifact') && 'publish files for the person',
      has('browser_open') &&
        (env.browser
          ? 'drive a real headless browser (browser_*), including pages you publish'
          : 'no browser (Chrome not installed)'),
      has('mcp') && 'use the tools of connected MCP servers (named mcp__server_tool)',
      has('create_task') && 'create tasks',
      has('spawn_worker') && 'add specialist workers',
      has('reply_user') && 'talk to the person',
    ]
      .filter(Boolean)
      .join('; ')}.`,
    'You cannot change your own tools, models, or permissions, or install plugins into Myrmidon; you can write such code as files.',
    'Harness docs: read_docs lists overview, working (how to do excellent work here), modes, coordination, verification, chat, limits, and tools. Read them when asked what Myrmidon or you can do, or when unsure how to approach something.',
  ].join('\n')
}

/** Agents that do hands-on work (everyone except a lead that only delegates, and direct answers). */
function doesWork(spec: ColonySpec, agent: AgentSpec): boolean {
  if (spec.tier === 'answer') return false
  return !(isLead(spec, agent) && spec.chat && spec.agents.length > 1)
}

export function systemPrompt(spec: ColonySpec, agent: AgentSpec, env: Environment): string[] {
  const team = spec.agents.length > 1
  return [
    `You are agent "${agent.name}" in Myrmidon colony "${spec.name}".`,
    capabilities(spec, agent, env),
    roleBrief(spec, agent),
    doesWork(spec, agent) ? CRAFT.trim() : '',
    team ? COMMON.trim() : '',
    spec.chat && toolsFor(spec, agent).includes('reply_user') && speaksForColony(spec, agent)
      ? SPEAKER.trim()
      : '',
    agent.instructions ? `Additional instructions for you:\n${agent.instructions}` : '',
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
  if (!spec.chat || spec.tier !== 'team' || !spec.team) return true
  // Every swarm peer joins the opening huddle.
  if (spec.team.mode === 'swarm') return true
  return isLead(spec, agent)
}

/** Tells an agent which files the person attached to a message. */
export function attachedNote(names: readonly string[] | undefined): string {
  return names?.length ? `\n\nThe person attached ${names.join(', ')}; read them with read_artifact.` : ''
}

export function kickoff(spec: ColonySpec, state: ColonyState): string {
  if (!spec.chat)
    return `The colony has started. Mission:\n\n${spec.mission}\n\nStart with read_task and read_board, then get to work.`
  const history = spec.chat.history ? `Earlier in this conversation:\n${spec.chat.history}\n\n` : ''
  const attached = state.chatMessages.find((m) => m.from === 'user')?.attachments
  const plan = spec.planFirst
    ? '\n\nPlan first: the person wants to approve the plan before any work starts. Work out the approach (for a team: the tasks and who does each), present it with ask_user, and stop. Do not create tasks, publish files, or start the work until they approve.'
    : ''
  const request = `${history}[user] ${spec.chat.request}${attachedNote(attached)}${plan}`
  if (spec.tier === 'answer') return request
  const files = Object.keys(state.artifacts).filter((f) => !attached?.includes(f))
  const carried = files.length > 0 ? `\n\nFiles from earlier rounds: ${files.join(', ')}.` : ''
  if (spec.tier !== 'team' || spec.agents.length === 1) return `${request}${carried}`
  if (spec.team?.mode === 'swarm')
    return `${request}\n\nHuddle first: do no work yet. Read who your peers are (list_agents or the roster in your instructions), then post one board message proposing how to split this request and which part you will take, and why you are suited to it. Then stop; you will be woken when every peer has proposed.\n\n${snapshot(spec, state)}`
  return `${request}\n\n${snapshot(spec, state)}`
}
