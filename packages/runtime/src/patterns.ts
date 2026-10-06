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
const BUILD = ['fs_write', 'fs_read', 'fs_list', 'shell']
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
    if (spec.tier === 'answer') return [...WEB, 'list_artifacts', 'read_artifact', 'read_docs', ...USER]
    if (spec.tier !== 'team' || spec.agents.length === 1)
      return [...READ, 'append_note', 'publish_artifact', ...BUILD, ...USER]
    if (spec.team?.mode === 'swarm')
      return [...READ, ...TALK, 'create_task', ...HOLD, 'publish_artifact', ...BUILD, ...USER]
    if (isLead(spec, agent)) {
      const spawn = (spec.team?.maxWorkers ?? 0) > spec.agents.length - 1 ? ['spawn_worker'] : []
      // A lead that can do the work itself never delegates; in a team it plans, assigns, and integrates.
      return [...READ, ...TALK, 'create_task', 'assign_task', ...HOLD, 'publish_artifact', ...USER, ...spawn]
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

const SPEAKER = `
You are talking to a person through a chat.
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
    return 'You answer the person directly. Reply with reply_user(final: true); this round has no team.'
  if (spec.chat && (spec.tier !== 'team' || spec.agents.length === 1))
    return 'You work alone on this request: do the work yourself, publish any files, and send the final answer.'
  if (spec.chat && spec.team?.mode === 'swarm') {
    return `You are ${agent.name}, one of ${spec.agents.length} equal peers sharing one goal${agent.specialty ? ` (your strength: ${agent.specialty})` : ''}. Nobody is in charge; the shared notes and the task board are the only coordination.
Peers:
${roster(spec, agent)}
- On every wake, read the plan note, the open tasks, and recent findings in the snapshot you are given.
- If no plan exists, write exactly one note with section "plan" and propose 2-6 tasks (create_task with the
  outputs each will produce); then claim one. Otherwise never re-plan: refine by splitting tasks or appending
  "decision" and "finding" notes.
- Claim one ready task at a time, do it, publish its outputs, submit it, record what you learned as a "finding"
  note, then stop. Do not duplicate a task someone holds; do not publish another task's outputs.
- Only the peer holding task-final answers the person (reply_user). Use ask_user only if the whole colony is
  blocked on something only the person knows.`
  }
  if (isLead(spec, agent)) {
    const extra = (spec.team?.maxWorkers ?? 0) - (spec.agents.length - 1)
    if (!spec.chat)
      return `You are the LEAD. Plan the work as a few concrete tasks with create_task (use blockedBy for ordering),
announce them on the board, review what workers publish, and integrate the final result. Your team:
${roster(spec, agent)}`
    return `You are the LEAD of an orchestrated team and you speak for it. Your specialists:
${roster(spec, agent)}${extra > 0 ? `\nYou may add up to ${extra} more with spawn_worker(role, focus, model); models: ${spec.team?.workerModels.join(', ')}.` : ''}
- You plan and integrate; you do not write code or run commands yourself.
- For a job worth a team: append one note with section "plan", then create tasks with create_task(assignee,
  outputs, blockedBy). Give each task to the specialist whose role and model fit it, one task per worker at a
  time. Workers are asleep until assigned and see only their task, the plan, and the files.
- Then wait. You hear about every task verdict. Re-assign rejected work with assign_task.
- When every task is verified, read the files and send the complete final answer with reply_user(final: true).`
  }
  if (spec.pattern === 'lead-workers') {
    if (!spec.chat)
      return 'You are a WORKER. Claim ready tasks from list_tasks, do the work, publish artifacts, and submit_task. Report blockers on the board with @lead.'
    return `You are ${agent.name}, the team's ${agent.specialty ?? 'worker'} (${agent.model}). You work only on tasks assigned to you.
- On a task: claim it with the revision shown, do it in your scratch directory, publish the outputs it names,
  submit_task, then reply with one line and stop.
- Do not plan for the team, do not probe the environment unless the task needs it, and do not publish files that
  belong to another task. You cannot talk to the person; blockers go to @lead on the board.`
  }
  return `You are a peer on a shared blackboard. Read the board and task graph, create tasks for missing work, claim what
nobody owns, publish artifacts, and request final verification once the output meets the acceptance criteria.`
}

export interface Environment {
  readonly sandbox: string
  readonly web: boolean
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
      has('create_task') && 'create tasks',
      has('spawn_worker') && 'add specialist workers',
      has('reply_user') && 'talk to the person',
    ]
      .filter(Boolean)
      .join('; ')}.`,
    'You cannot change your own tools, models, or permissions, or install plugins into Myrmidon; you can write such code as files.',
    'Harness docs: read_docs lists overview, modes, coordination, verification, chat, limits, and tools. Read them when asked what Myrmidon or you can do, or when unsure how something here works.',
  ].join('\n')
}

export function systemPrompt(spec: ColonySpec, agent: AgentSpec, env: Environment): string[] {
  const team = spec.agents.length > 1
  return [
    `You are agent "${agent.name}" in Myrmidon colony "${spec.name}".`,
    capabilities(spec, agent, env),
    roleBrief(spec, agent),
    team ? COMMON.trim() : '',
    spec.chat && toolsFor(spec, agent).includes('reply_user') && speaksForColony(spec, agent)
      ? SPEAKER.trim()
      : '',
    agent.instructions ? `Additional instructions for you:\n${agent.instructions}` : '',
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
  if (spec.team.mode === 'swarm') return spec.agents[0]?.name === agent.name
  return isLead(spec, agent)
}

export function kickoff(spec: ColonySpec, state: ColonyState): string {
  if (!spec.chat)
    return `The colony has started. Mission:\n\n${spec.mission}\n\nStart with read_task and read_board, then get to work.`
  const history = spec.chat.history ? `Earlier in this conversation:\n${spec.chat.history}\n\n` : ''
  const request = `${history}[user] ${spec.chat.request}`
  if (spec.tier === 'answer') return request
  const files = Object.keys(state.artifacts)
  const carried = files.length > 0 ? `\n\nFiles from earlier rounds: ${files.join(', ')}.` : ''
  if (spec.tier !== 'team' || spec.agents.length === 1) return `${request}${carried}`
  if (spec.team?.mode === 'swarm')
    return `${request}\n\nYou are the first peer awake. Write the plan note and propose the first tasks, then claim one.\n\n${snapshot(spec, state)}`
  return `${request}\n\n${snapshot(spec, state)}`
}
