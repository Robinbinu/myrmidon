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
]
const TALK = ['post', 'append_note', 'send_mail']
const TASKS = ['create_task', 'claim_task', 'release_task', 'submit_task']
const WORK = ['publish_artifact', 'fs_write', 'fs_read', 'fs_list', 'shell']

function roleTools(pattern: ColonySpec['pattern'], role: string): string[] {
  if (pattern === 'lead-workers' && role === 'lead') {
    return [...READ, ...TALK, ...TASKS, ...WORK, 'request_final_verification']
  }
  if (pattern === 'lead-workers')
    return [...READ, ...TALK, 'claim_task', 'release_task', 'submit_task', ...WORK]
  return [...READ, ...TALK, ...TASKS, ...WORK, 'request_final_verification']
}

export function toolsFor(spec: ColonySpec, agent: AgentSpec): string[] {
  return agent.tools ?? roleTools(spec.pattern, agent.role)
}

const COMMON = `
How this colony works:
- Everything you do is recorded in an append-only log. Notes, posts, and mail can never be edited; append corrections instead.
- The ONLY way to deliver work is publish_artifact. Your scratch directory is private and is not part of the output.
- Completion is decided by an independent verifier against the acceptance criteria. Claiming you are done does nothing;
  request_final_verification runs the checks, and failures come back with evidence you should act on.
- Coordinate through the task graph: claim before working, pass the revision you read, submit with the artifacts that finish it.
- Keep board posts short and useful. Use @name to wake someone; use send_mail for one-to-one detail.
- When you have nothing useful left to do right now, stop calling tools and reply with one short line. You will be woken
  when mail, a mention, a verdict, or an observer signal arrives.
- Do not fabricate results. If something fails, say so on the board and fix it.`

function roleBrief(spec: ColonySpec, agent: AgentSpec): string {
  if (spec.pattern === 'lead-workers' && agent.role === 'lead') {
    return `You are the LEAD. Break the mission into a small number of concrete tasks with create_task (use blockedBy for
ordering), assign or announce them on the board, review what workers publish, integrate the final artifacts yourself if
needed, then call request_final_verification. Fix and resubmit if verification fails.`
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
  return [
    `You are agent "${agent.name}" in Myrmidon colony "${spec.name}". Other agents: ${others.join(', ') || 'none'}.`,
    roleBrief(spec, agent),
    COMMON.trim(),
    agent.instructions ? `Additional instructions for you:\n${agent.instructions}` : '',
  ].filter(Boolean)
}

export function kickoff(spec: ColonySpec): string {
  return `The colony has started. Mission:\n\n${spec.mission}\n\nStart with read_task and read_board, then get to work.`
}
