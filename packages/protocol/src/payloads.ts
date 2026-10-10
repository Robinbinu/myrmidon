import type { EventId } from './event.ts'
import type {
  AgentRole,
  PermissionCall,
  PermissionLevel,
  PermissionOffer,
  PermissionSource,
  RoundAccess,
} from './permissions.ts'

/**
 * Goal mode (`/goal <condition>: <request>`): the round goes on until `condition` holds, checked on each final answer
 * (after omp's goal mode and `/loop --until`). `checks`: the project's own checks pass; `command`: the command exits 0;
 * `judge`: the reviewer (`judge`, passing at `threshold`) finds the condition holds. At most `maxChecks` checks.
 */
export interface RoundGoal {
  condition: string
  check: { kind: 'checks' } | { kind: 'command'; run: string } | { kind: 'judge' }
  maxChecks: number
  judge: string
  threshold: number
}

export type AgentStatus = 'provisioning' | 'ready' | 'working' | 'idle' | 'completed' | 'stopped' | 'failed'
export type ColonyStatus = 'created' | 'running' | 'completed' | 'stopped' | 'failed'
export type TaskStatus = 'pending' | 'in_progress' | 'submitted' | 'verified' | 'rejected' | 'deleted'
/**
 * How an agent's context was made to fit its model's window: `shake` elided old bulky tool output, `snapcompact`
 * archived the older part as text images a vision model reads, `summary` had a model summarize it.
 */
export type CompactionMethod = 'shake' | 'snapcompact' | 'summary'
/**
 * What the advisor saw go wrong in an agent's steps: it worked on the wrong thing, went on past a failed call, repeated
 * itself, left its task, was about to do something destructive nobody asked for, or called work done unchecked.
 */
export const ADVICE_KINDS = [
  'wrong-target',
  'ignored-error',
  'looping',
  'off-task',
  'unsafe',
  'unverified',
] as const
export type AdviceKind = (typeof ADVICE_KINDS)[number]
/**
 * A project's permissions: its level of the permission model (a preset, or "use global" when absent, its rules and
 * who may use what), and the folders beyond the project that sandboxed agents may read in its chats (never write;
 * `~` or absolute). See permissions.ts.
 */
export interface ProjectPermissions extends PermissionLevel {
  read?: string[]
}

/**
 * A project's permissions as they were saved before the permission model: `auto` (whatever the global sandbox
 * allowed), `ask` (edits and commands wait, except commands starting with an `allow` prefix), `read-only`, or `full`.
 * Still accepted on input and read from old logs; `projectLevelFrom` turns it into a level.
 */
export interface LegacyProjectPermissions {
  mode: 'auto' | 'ask' | 'read-only' | 'full'
  allow: string[]
  read?: string[]
}

/**
 * Kinds of step a person allowed for the rest of a chat from approval cards before the permission model (file changes,
 * shell commands). Read from old logs only; chat rules replace them (`rulesFromGrants`).
 */
export type ChatGrant = 'file' | 'command'

/**
 * An app on the person's Mac they let agents use in a chat (computer use), and how much: `view` screenshots only,
 * `click` also clicking and scrolling, `full` also typing and keys.
 */
export interface ComputerApp {
  bundleId: string
  name: string
  tier: 'view' | 'click' | 'full'
}

/** A tool call waiting for the person to approve or deny it. */
export interface ApprovalRequest {
  id: string
  agent: string
  tool: string
  /** What the call would do, in one line (a command, or "edit src/app.ts"). */
  summary: string
  /** The full change to look over before it happens, when there is one to show. */
  review?: Review
  /** The call's receipt key: once approved and done, the same call returns its result instead of running again. */
  key?: string
  /** Old logs: the kind of step the person could allow for the rest of the chat. */
  grant?: ChatGrant
  /** What the card may remember from the answer, most specific first (a command's prefix, then every command). */
  offer?: PermissionOffer[]
  /** Why the call asked: the rule or preset that decided it (or that someone else started the round). */
  why?: PermissionSource
  /** The call as the permission engine saw it, so a waiting request is decided again when the rules change. */
  call?: PermissionCall
  /** Whether the agent asking is the lead or crew, for rules that name who. */
  role?: AgentRole
  /** Set when an agent asks to read this folder outside what it may read: the person allows it once or for the chat. */
  read?: string
  /** `read` is (or lies in) a folder of keys or sign-ins: the card warns, and offers once or this chat only. */
  sensitive?: boolean
}

/**
 * A change shown in full for the person to look over (and, where `editable`, rewrite) before it happens: a file's
 * new content against its current one, a commit's message and patch, a command, or a call's arguments.
 */
export interface Review {
  readonly kind: 'file' | 'commit' | 'command' | 'call'
  readonly title: string
  readonly fields: readonly ReviewField[]
}

export interface ReviewField {
  readonly key: string
  readonly label: string
  readonly value: string
  /** `code`: monospace; `text`: prose; `patch`: a unified diff, shown as one. */
  readonly format: 'text' | 'code' | 'patch'
  /** The content this replaces, shown as a diff against `value`. */
  readonly before?: string
  readonly editable: boolean
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
      /** Old logs hold a project's permissions in their old shape. */
      project?: {
        id: string
        name: string
        path: string
        permissions?: ProjectPermissions | LegacyProjectPermissions
      }
      /** Bigger tiers this round's agent may hand the request to (escalate). */
      escalate?: ('solo' | 'team')[]
      /** What the person keeps across chats (memory), as prompt lines, when the round started. */
      memory?: string[]
      /** The person started this round by writing to these crew members directly (@name): they start it, not the lead. */
      addressed?: string[]
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
    /** Every call that changes something outside the colony waits for approval (a round a channel member started). */
    askAll?: boolean
    /** When the reviewer runs: off, auto (the speaking agent asks), or always. */
    review?: 'off' | 'auto' | 'always'
    /**
     * The round runs with full access: no sandbox, file tools reach any path, the web any address. Approvals still
     * apply. Never set on a round someone other than the person started (`askAll`).
     */
    fullAccess?: boolean
    /** Agents may see and control the person's Mac (computer use); never set alongside `askAll`. */
    computerUse?: boolean
    /** Goal mode: the round goes on until this holds (see `RoundGoal`). */
    goal?: RoundGoal
    /**
     * Prewalk: the lead plans on its own model, then hands off once to this cheaper one to carry the plan out, at its
     * first change (a file edit or a task); `agent/handoff` logs the switch.
     */
    prewalk?: string
    /** What the round's agents may do as it starts, to tell them what changed next time (see `RoundAccess`). */
    access?: RoundAccess
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
    /**
     * The project's instruction and rule files the round's agents were given (AGENTS.md, .cursor/rules/…), relative to
     * the project; absent when it has none, and on a resume, which reads the same files again.
     */
    rules?: string[]
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
  /** A reviewer read the round and proposes a skill (or, with `update`, a change to one it learned before). */
  'skill/proposed': {
    id: string
    name: string
    description: string
    body: string
    why: string
    update?: { description: string; body: string }
  }
  'skill/decided': { id: string; kept: boolean }
  /**
   * One of the person's stream rules stopped an agent's reply as the model wrote it: `source` says what matched (its
   * prose, its reasoning, or a call to `tool`), and the request went again with the rule's guidance. `path` is the
   * rule's file, relative to the project or the home folder.
   */
  'rule/fired': {
    agent: string
    rule: string
    description?: string
    source: 'text' | 'thinking' | 'tool'
    tool?: string
    path: string
  }
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
  /** What an app on the person's Mac showed after an agent's desktop action (computer use), for the chat's steps. */
  'computer/keyframe': {
    agent: string
    blob: string
    app: string
    title: string
    /** The desktop action, as the computer tool names it (left_click, type, open_app…). */
    action: string
    label?: string
    /** Where it acted, in the screenshot's pixels. */
    point?: { x: number; y: number }
    width: number
    height: number
  }
  /** The apps the person let agents use in this chat, the whole set after a change. */
  'computer/apps': { apps: ComputerApp[] }
  /** An agent took (or let go of) an app on the person's Mac: the "controlling your Mac" indicator follows it. */
  'computer/control': { agent: string; app?: string; active: boolean }
  /** An agent needed computer use and could not have it yet: the driver is missing, or macOS grants are. */
  'computer/blocked': {
    agent: string
    reason: 'install' | 'grants'
    missing?: ('accessibility' | 'screen-recording')[]
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
  /** `edits`: review fields the person rewrote before approving, by key; `note`: what they said with their answer. */
  'approval/decided': {
    id: string
    approved: boolean
    by: 'person' | 'timeout' | 'stopped'
    edits?: Record<string, string>
    note?: string
  }
  /** A call the person approved has run: its result, kept so the same call is not run twice. */
  'review/done': { key: string; agent: string; tool: string; output: string }
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
    /** From here on the round asks before every outside step: someone other than the person wrote into it. */
    askAll?: boolean
    /** Whether the round has full access from here on, when that changed. */
    fullAccess?: boolean
    interrupted: string[]
    /** What the round's agents may do from here on, as they were just told it. */
    access?: RoundAccess
  }
  /** Something a plugin put in the log (ctx.events.emit), for the UI and other plugins. */
  'plugin/event': { plugin: string; type: string; data: Record<string, unknown> }
  /**
   * An agent's context neared its model's window and was made to fit. `methods` ran in order, each because the ones
   * before it left the context too big; the last settled it (logs from before there were methods hold `summary`).
   * `messages` are folded into a summary or archive so far, `elided` the tool results shaken this time, `frames` the
   * archive's images.
   */
  'agent/compacted': {
    agent: string
    messages: number
    tokens: number
    summaryChars: number
    methods: CompactionMethod[]
    elided: number
    frames: number
    /** The estimated context size after the pass. */
    tokensAfter?: number
  }
  /**
   * The prompt an agent starts with, by section: each section's key, the version of its words and a hash of what it
   * rendered, so two runs can be compared by what their agents were told. `totalTokens` is a rough size.
   */
  'agent/prompt': {
    agent: string
    sections: { key: string; version: number; hash: string }[]
    family: string
    totalTokens: number
  }
  /** The person switched a running agent to another model; it takes effect on the agent's next step. */
  'agent/model': { agent: string; model: string; previous: string }
  /**
   * An agent's model failed in a way another model could get past, so it went on with the next of the person's
   * fallback models (Settings → Crew & budget), its conversation intact: `previous` failed with `message`.
   */
  'agent/fallback': {
    agent: string
    model: string
    previous: string
    kind: 'refusal' | 'error'
    message: string
  }
  /**
   * Prewalk: the lead planned on `previous` and, at its first change (`after`: the tool, e.g. fs_edit or create_task),
   * handed off once to the cheaper `model` it carries the plan out on, its conversation intact.
   */
  'agent/handoff': { agent: string; model: string; previous: string; after: string }
  /**
   * The advisor (Settings → Crew & budget) read an agent's latest steps, saw a concrete problem, and steered the agent
   * with `note`, which it reads at its next step. Silent reviews are not logged.
   */
  'agent/advised': { agent: string; model: string; note: string; kind?: AdviceKind }
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
  /** `to`: crew members the person wrote to directly (@name); they hear it first and may answer the person. */
  'chat/user': {
    text: string
    mode?: 'steer' | 'queue'
    attachments?: string[]
    to?: string[]
    /** Said aloud on a voice call. */
    voice?: boolean
    /** What the agents should know that the chat does not show, e.g. a voice call's transcript. */
    context?: string
    /** An answer given on a question card: the question's message and what was picked, shown in the card itself. */
    answers?: QuestionAnswers
  }
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
    /** The plan the question asks the person to approve, in markdown (ask_user in plan mode). */
    plan?: string
  }
  /** The user renamed the conversation; the newest rename across its rounds wins. */
  /** `by: 'auto'` when Myrmidon named the chat from what it is about; a name anyone gave it is never replaced. */
  'chat/renamed': { title: string; by?: 'auto' }
  /** What the person allows without asking for the rest of the chat, across its runs: the whole set after a change. */
  /** `reads`: folders sandboxed agents may read for the rest of the chat; absent in events from before reads existed. */
  'chat/allowed': { grants: ChatGrant[]; reads?: string[] }
  /** The chat's level of the permission model after the person changed it (preset, rules, who may use what). */
  'chat/permissions': PermissionLevel
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
  /** A message in the team chat, which everyone on the crew is in; `replyTo` is the number (seq) it answers. */
  'board/posted': { agent: string; text: string; mentions: string[]; replyTo?: number }
  'note/appended': { agent: string; text: string; corrects?: EventId; section?: NoteSection }
  /**
   * A message to one agent, or to a group (`to` is then the group's name and `members` who it reached).
   * `replyTo`: the number (log seq) of the message this answers, so conversations read as threads.
   */
  'mail/sent': {
    from: string
    to: string
    subject: string
    body: string
    replyTo?: number
    members?: string[]
  }
  /** A group chat: a name and who is in it (its creator included). */
  'group/created': { name: string; members: string[]; by: string }
  /** People added to or taken out of a group; a member who removes themselves has left. */
  'group/changed': { name: string; add: string[]; remove: string[]; by: string }
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

/** What the person chose for one question: options picked, their own words, or skipped. */
export interface QuestionPick {
  readonly picked: readonly string[]
  readonly other?: string
  readonly skipped?: boolean
}

/** An answer to a question card: the message that asked (its seq) and one pick per question, in order. */
export interface QuestionAnswers {
  readonly seq: number
  readonly picks: readonly QuestionPick[]
}

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
