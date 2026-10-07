import type { EventId } from './event.ts'

export type AgentStatus = 'provisioning' | 'ready' | 'working' | 'idle' | 'completed' | 'stopped' | 'failed'
export type ColonyStatus = 'created' | 'running' | 'completed' | 'stopped' | 'failed'
export type TaskStatus = 'pending' | 'in_progress' | 'submitted' | 'verified' | 'rejected' | 'deleted'
/**
 * How freely agents may change a project folder. `auto`: anything the sandbox allows (checkpoints can rewind it);
 * `ask`: edits to project files and shell commands wait for the person, except commands starting with an `allow`
 * prefix; `read-only`: agents read the project but cannot change it.
 */
export interface ProjectPermissions {
  mode: 'auto' | 'ask' | 'read-only'
  allow: string[]
}

/** A tool call waiting for the person to approve or deny it. */
export interface ApprovalRequest {
  id: string
  agent: string
  tool: string
  /** What the call would do, in one line (a command, or "edit src/app.ts"). */
  summary: string
}

export interface MadeToolInput {
  name: string
  type: 'string' | 'number' | 'boolean'
  description: string
  optional?: boolean
}

export type SignalKind = 'deadline' | 'budget' | 'stall' | 'unclaimed' | 'blocked' | 'conflict'

export interface AgentInfo {
  readonly name: string
  readonly role: string
  readonly model: string
  readonly tools: readonly string[]
  /** What a specialist worker is for, e.g. `researcher` or `coder`. */
  readonly specialty?: string
  /** A spawned worker's brief from the lead, kept so the worker can join later rounds as it was. */
  readonly focus?: string
}

/**
 * How a chat colony's team works. `orchestrated`: a lead plans and assigns tasks to specialists;
 * `swarm`: equal peers coordinate through shared notes and tasks. `auto`/`manual` are older names
 * for lead-run teams, kept so earlier logs still read.
 */
export type TeamMode = 'orchestrated' | 'swarm' | 'auto' | 'manual'

/** What kind of shared note this is; one live `plan` per colony. */
export type NoteSection = 'plan' | 'decision' | 'finding' | 'status' | 'user'

export interface TaskSnapshot {
  readonly id: string
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TaskStatus
  readonly owner?: string
  readonly blockedBy: readonly string[]
  readonly artifacts: readonly string[]
  /** The agent this task is meant for; only it is woken when the task appears. */
  readonly assignee?: string
  /** Artifact names this task will produce; nobody else may publish them while it is in progress. */
  readonly outputs?: readonly string[]
}

export interface UsageInfo {
  readonly input: number
  readonly output: number
  readonly totalTokens: number
  /** USD; undefined when the provider did not report cost. */
  readonly cost?: number
}

/** Payload shape for every event type the core and runtime register. */
export interface EventPayloads {
  'colony/created': {
    name: string
    mission: string
    pattern: string
    agents: AgentInfo[]
    acceptance: unknown[]
    /** `tokens` counts every token the models process, cached input included (what the run card shows). */
    budget: { wallMs: number; costUsd?: number; tokens?: number; maxTurns?: number }
    unsafeNoSandbox: boolean
    chat?: {
      chatId: string
      round: number
      request: string
      history?: string
      project?: { id: string; name: string; path: string; permissions?: ProjectPermissions }
      /** Bigger tiers this round's agent may hand the request to (escalate). */
      escalate?: ('solo' | 'team')[]
      /** What the person keeps across chats (memory), as prompt lines, when the round started. */
      memory?: string[]
    }
    team?: { mode: TeamMode; maxWorkers: number; workerModels: string[] }
    /** How much machinery this round uses: a direct answer, one agent, or the full team. */
    tier?: 'answer' | 'solo' | 'team'
    /** The rest of the spec, so an interrupted colony can be resumed exactly as it was created. */
    observerMs?: number
    thinking?: 'low' | 'medium' | 'high'
    taskJudge?: string
    disabledTools?: string[]
    /** Tools whose every call waits for the person's approval. */
    askTools?: string[]
    allowTools?: string[]
    /** When the reviewer runs: off, auto (the speaking agent asks), or always. */
    review?: 'off' | 'auto' | 'always'
  }
  /**
   * `pid`/`hostname` identify the runner process so orphaned colonies can be detected. `resumed` marks a
   * stopped or interrupted colony picking up where it left off.
   */
  'colony/started': {
    pid?: number
    hostname?: string
    resumed?: boolean
    /** Agents switched to another model on resume (agent → model). */
    models?: Record<string, string>
  }
  'colony/stopped': { reason: string }
  /**
   * A chat's follow-up starts its next round in the same colony: the round's whole spec, as at creation, so a
   * resumed round knows how it was set up. Files, notes, tasks and agents' conversations carry on.
   */
  'round/started': EventPayloads['colony/created']
  /** An agent proposes something to remember across chats; the person keeps or discards it. */
  'memory/proposed': {
    id: string
    agent: string
    text: string
    kind: 'preference' | 'decision' | 'lesson' | 'fact'
    /** Set: for this project's chats only. */
    project?: string
    why: string
  }
  'memory/decided': { id: string; kept: boolean }
  /**
   * One of the person's hooks ran. `outcome`: `blocked` stopped the tool, `asked` sent it to the person,
   * `feedback` told the agent something after the tool, `failed` means the hook itself errored.
   */
  'hook/ran': {
    event: 'PreToolUse' | 'PostToolUse' | 'Stop'
    agent?: string
    tool?: string
    command: string
    code: number
    ms: number
    outcome: 'ok' | 'blocked' | 'asked' | 'feedback' | 'failed'
    message?: string
  }
  /** An agent loaded a skill's instructions, or one of its bundled files. */
  'skill/used': { agent: string; name: string; file?: string }
  /** The round's agent found the request bigger than its tier: the chat reruns it at `to`, with this round's work. */
  'colony/escalated': { by: string; to: 'solo' | 'team'; reason: string }
  'agent/joined': { agent: AgentInfo; by: string; focus: string }
  /**
   * A frame of an agent's browser after one action, for replaying what it did: a JPEG screenshot (blob), where its
   * cursor was, and the element it acted on, in CSS pixels of a `width` x `height` viewport.
   */
  'browser/keyframe': {
    agent: string
    blob: string
    url: string
    title: string
    action: 'open' | 'click' | 'type' | 'press'
    label?: string
    cursor?: { x: number; y: number }
    box?: { x: number; y: number; width: number; height: number }
    width: number
    height: number
  }
  /** An agent's model refused or failed; the round pauses so the person can continue with another model. */
  'agent/error': {
    agent: string
    model: string
    kind: 'refusal' | 'overflow' | 'error'
    message: string
    /** For an overflow: the conversation's estimated size and the model's window, in tokens. */
    tokens?: number
    window?: number
  }
  /** The lead let a worker go: it stops now and is not brought into later rounds of the chat. */
  'agent/dismissed': { agent: string; by: string; reason: string }
  'approval/requested': ApprovalRequest
  /** An agent needs the person to sign in to a site in its browser; the person takes control, signs in, hands back. */
  'login/requested': { agent: string; site: string; url: string; reason: string }
  'login/finished': { agent: string; outcome: 'handed-back' | 'timeout' | 'stopped' }
  /** An agent did something that looks like following instructions from web content (possible prompt injection). */
  'safety/flagged': { agent: string; tool: string; reason: string; source: string }
  /** An agent started a long-running process (a dev server) reachable at `url` on this machine. */
  'server/started': { agent: string; name: string; command: string; url: string }
  'server/stopped': { name: string; reason: string }
  /** A worker in a git project got its own worktree: a branch made from the folder as it was, in a folder of its own. */
  'worktree/created': { agent: string; branch: string; path: string }
  /** The harness merged a worker's worktree changes into the project folder. */
  'worktree/merged': { agent: string; files: string[] }
  /** A worker's worktree took in what others merged into the project since it was made, before a new task. */
  'worktree/updated': { agent: string; files: string[] }
  /** A worker's changes conflict with the project; its worktree now holds both sides with conflict markers. */
  'worktree/conflict': { agent: string; files: string[] }
  /** The round ended: the worktree is removed, or `kept` (with its branch) because it holds unmerged changes. */
  'worktree/closed': { agent: string; kept: boolean }
  'approval/decided': { id: string; approved: boolean; by: 'person' | 'timeout' | 'stopped' }
  /** A snapshot of the chat's project folder (shadow git commit) when the round started or ended. */
  /** `round`: the chat round it belongs to (an end snapshot can land after the next round started). */
  'checkpoint/created': { commit: string; phase: 'start' | 'end'; round?: number }
  /** The person rewound the project folder to `commit`; `undo` is the snapshot taken just before. */
  /** `files`: the paths the rewind put back, so undoing it restores exactly those. */
  'checkpoint/restored': { commit: string; undo: string; changed: number; files?: string[] }
  /**
   * The person changed tool rules or a project's permissions during the round. `interrupted`: agents whose turn in
   * progress was stopped because the rules got stricter.
   */
  'permissions/changed': {
    off: string[]
    ask: string[]
    allow: string[]
    project?: string
    interrupted: string[]
  }
  /** Something a plugin put in the log (ctx.events.emit), for the UI and other plugins. */
  'plugin/event': { plugin: string; type: string; data: Record<string, unknown> }
  /** An agent's context neared its model's window: its older messages were summarized for the model. */
  'agent/compacted': { agent: string; messages: number; tokens: number; summaryChars: number }
  /** The person switched a running agent to another model; it takes effect on the agent's next step. */
  'agent/model': { agent: string; model: string; previous: string }
  /**
   * An agent made a tool the colony can call: a script that reads its inputs as JSON from `MYR_INPUT` and prints
   * its result. `library` marks one loaded from the person's tool library rather than made in this colony.
   */
  'tool/created': {
    agent: string
    name: string
    description: string
    inputs: MadeToolInput[]
    /** `browser`: `source` is a JSON list of browser steps run in the caller's browser, not a script. */
    language: 'typescript' | 'python' | 'bash' | 'browser'
    source: string
    library?: boolean
  }
  /**
   * `steer` (the default) is read at the agent's next step; `queue` waits until it finishes what it is
   * doing. Only meaningful for messages sent while a round is running.
   */
  'chat/user': { text: string; mode?: 'steer' | 'queue'; attachments?: string[] }
  /** `question` marks a reply that waits on the user before the colony can continue. */
  /**
   * `question`: the round waits for the answer (ask_user). `assumption`: a check-in the person may answer while the
   * work goes on; until they do, the agent proceeds on this assumption (check_in).
   */
  'chat/reply': {
    agent: string
    text: string
    final: boolean
    question?: boolean
    assumption?: string
    /** Questions with options the person can click (ask_user); they may also type an answer or skip one. */
    choices?: QuestionChoice[]
  }
  /** The user renamed the conversation; the newest rename across its rounds wins. */
  'chat/renamed': { title: string }
  'colony/failed': { reason: string }
  'colony/completed': { verdicts: EventId[] }
  'agent/status': { agent: string; status: AgentStatus; detail?: string }
  'agent/turn': { agent: string; phase: 'start' | 'end'; turn: number; trigger: string }
  'llm/response': {
    agent: string
    model: string
    text: string
    thinking?: string
    toolCalls: { id: string; name: string; arguments: unknown }[]
    usage?: UsageInfo
    stopReason: string
    error?: string
  }
  /** `readOnly`: an MCP tool its server marks read-only, so the call changes nothing. */
  'tool/call': { agent: string; callId: string; tool: string; args: unknown; readOnly?: boolean }
  'tool/result': { agent: string; callId: string; tool: string; ok: boolean; output: string }
  'board/posted': { agent: string; text: string; mentions: string[] }
  'note/appended': { agent: string; text: string; corrects?: EventId; section?: NoteSection }
  /** `replyTo`: the number (log seq) of the mail this answers, so mail reads as threads. */
  'mail/sent': { from: string; to: string; subject: string; body: string; replyTo?: number }
  /** `mail` is a mail/sent event, or a chat/user message the agent has now read. */
  'mail/delivered': { mail: EventId; to: string }
  /** `reason` says why, when an agent sent the task back (reject_task). */
  'task/changed': { task: TaskSnapshot; by: string; reason?: string }
  'artifact/versioned': {
    name: string
    version: number
    blob: string
    size: number
    parentVersion?: number
    author: string
    mediaType: string
  }
  'observer/signal': {
    kind: SignalKind
    severity: 'info' | 'warn' | 'critical'
    facts: string
    targets: string[]
  }
  'verifier/requested': { target: string; by: string }
  'verifier/verdict': {
    target: string
    verifierId: string
    pass: boolean
    score?: number
    evidence: string
  }
}

export type EventType = keyof EventPayloads

/** One option of a question an agent asks. */
export interface QuestionOption {
  readonly label: string
  /** What picking it means, in a line. */
  readonly description?: string
}

/** A question an agent asks with options to click, as Claude Code's AskUserQuestion does. */
export interface QuestionChoice {
  readonly question: string
  /** A short tag, e.g. "Audience". */
  readonly header?: string
  readonly options: readonly QuestionOption[]
  /** Several options can be picked. */
  readonly multiSelect?: boolean
}
