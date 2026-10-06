import type { AgentSpec, ColonySpec } from './spec.ts'

const READ = [
  'read_task',
  'read_board',
  'read_notes',
  'read_mail',
  'list_agents',
  'list_tasks',
  'list_artifacts',
  'read_artifact',
  'observe',
  'web_search',
  'web_fetch',
]
const TALK = ['post', 'append_note', 'send_mail']
const TASKS = ['create_task', 'claim_task', 'release_task', 'submit_task']
const WORK = ['publish_artifact', 'fs_write', 'fs_read', 'fs_list', 'shell']

function isLead(spec: ColonySpec, agent: AgentSpec) {
  return spec.pattern === 'lead-workers' && agent.role === 'lead'
}

function roleTools(spec: ColonySpec, agent: AgentSpec): string[] {
  const chat = spec.chat ? ['reply_user'] : []
  if (isLead(spec, agent)) {
    const spawn = spec.team?.mode === 'auto' ? ['spawn_worker'] : []
    return [...READ, ...TALK, ...TASKS, ...WORK, 'request_final_verification', ...chat, ...spawn]
  }
  if (spec.pattern === 'lead-workers')
    return [...READ, ...TALK, 'claim_task', 'release_task', 'submit_task', ...WORK]
  return [...READ, ...TALK, ...TASKS, ...WORK, 'request_final_verification', ...chat]
}

export function toolsFor(spec: ColonySpec, agent: AgentSpec): string[] {
  const tools = agent.tools ?? roleTools(spec, agent)
  const disabled = new Set(spec.disabledTools ?? [])
  return disabled.size ? tools.filter((t) => !disabled.has(t)) : tools
}

const COMMON = `
How this colony works:
- Everything you do is recorded in an append-only log. Notes, posts, and mail can never be edited; append corrections instead.
- Deliver files with publish_artifact. Your scratch directory is private and is not part of the output.
- web_search and web_fetch give you current information from the internet. Verify facts instead of guessing.
- Completion is decided by an independent verifier. Claiming you are done does nothing; request_final_verification runs
  the checks, and failures come back with evidence you should act on.
- Coordinate through the task graph: claim before working, pass the revision you read, submit with the artifacts that finish it.
- Keep board posts short and useful. Use @name to wake someone; use send_mail for one-to-one detail.
- When you have nothing useful left to do right now, stop calling tools and reply with one short line. You will be woken
  when mail, a mention, a verdict, a user message, or an observer signal arrives.
- Do not fabricate results. If something fails, say so and fix it.`

const CHAT_LEAD = `
You are talking to a human through a chat, like a capable assistant that commands a team.
- Work out what they actually want. Ask a question with reply_user only if you truly cannot proceed; otherwise make
  sensible assumptions and state them.
- Start with one short reply_user message: your plan in two or three lines.
- Choose the approach yourself. Small tasks: do them directly. Large or multi-part tasks: break them into tasks
  and, if you may spawn workers, spawn only the workers that clearly help, each with a precise focus.
- Research with web_search/web_fetch whenever the task depends on facts, libraries, or current events.
- Deliverables that are files (code, documents, data) go into artifacts; answers and explanations go in reply_user.
- When the work is done, send the complete final answer with reply_user (final: true) — what you delivered, where,
  how to use it, and any caveats — and THEN call request_final_verification. If verification fails, fix the work,
  send an updated final answer, and request verification again.
- Messages from the human arrive as [user] items; treat them as top priority.`

function roleBrief(spec: ColonySpec, agent: AgentSpec): string {
  if (isLead(spec, agent)) {
    const team =
      spec.team?.mode === 'auto'
        ? `You may add up to ${spec.team.maxWorkers} workers with spawn_worker (models: ${spec.team.workerModels.join(', ')}).`
        : 'Your team is fixed; coordinate the agents listed above.'
    return `You are the LEAD. Plan the work as a few concrete tasks with create_task (use blockedBy for ordering),
announce them on the board, review what workers publish, and integrate the final result yourself if needed. ${team}`
  }
  if (spec.pattern === 'lead-workers') {
    return `You are a WORKER. Claim ready tasks from list_tasks, do the work, publish artifacts, and submit_task. Report
blockers on the board with @lead.`
  }
  return `You are a peer on a shared blackboard. Read the board and task graph, create tasks for missing work, claim what
nobody owns, publish artifacts, and request final verification once the output meets the acceptance criteria.`
}

export function systemPrompt(spec: ColonySpec, agent: AgentSpec, peers: readonly AgentSpec[]): string[] {
  const others = peers.filter((p) => p.name !== agent.name).map((p) => `${p.name} (${p.role})`)
  const chatsWithUser = spec.chat && toolsFor(spec, agent).includes('reply_user')
  return [
    `You are agent "${agent.name}" in Myrmidon colony "${spec.name}". Other agents: ${others.join(', ') || 'none yet'}.`,
    roleBrief(spec, agent),
    COMMON.trim(),
    chatsWithUser ? CHAT_LEAD.trim() : '',
    agent.instructions ? `Additional instructions for you:\n${agent.instructions}` : '',
  ].filter(Boolean)
}

export function kickoff(spec: ColonySpec): string {
  if (spec.chat) {
    const history = spec.chat.history ? `Earlier in this conversation:\n${spec.chat.history}\n\n` : ''
    return `${history}[user] ${spec.chat.request}\n\nStart by reading list_artifacts (earlier work is already loaded), then plan and act.`
  }
  return `The colony has started. Mission:\n\n${spec.mission}\n\nStart with read_task and read_board, then get to work.`
}
