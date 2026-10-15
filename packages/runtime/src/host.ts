import type { BlobStore, EventLog } from '@myrmidon/core'
import type {
  ActorRef,
  CallRecord,
  ColonyId,
  ColonyState,
  EventDraft,
  MyrEvent,
  PermissionCall,
  PermissionVerdict,
  Review,
} from '@myrmidon/protocol'
import type { Advisor } from './advisor.ts'
import type { ModelError } from './agent.ts'
import type { BrowserHub } from './browser.ts'
import type { ComputerHub } from './computer/driver.ts'
import type { MediaTools } from './media.ts'
import type { AgentTool } from './omp/agent-core.ts'
import type { Judge } from './omp/ai.ts'
import type { PluginHost } from './plugin-host.ts'
import type { ProjectContext } from './project-context.ts'
import type { Sandbox } from './sandbox.ts'
import type { ColonySpec } from './spec.ts'
import type { SshHost, SshHub } from './ssh.ts'
import type { StreamRule } from './stream-rules.ts'
import type { WebTools } from './web.ts'
import type { ColonyWorkspace } from './workspace.ts'

/** An agent's branch for an experiment (ColonyHost.experimentTree). */
export interface ExperimentTree {
  readonly workdir: string
  readonly branch: string
  keep(message: string): Promise<string>
  revert(): Promise<void>
  finish(): Promise<string[]>
}

/** Everything a tool or service needs from the running colony, without depending on the runner. */
export interface ColonyHost {
  readonly id: ColonyId
  readonly spec: ColonySpec
  readonly log: EventLog
  readonly blobs: BlobStore
  readonly workspace: ColonyWorkspace
  /** Where commands run: the OS sandbox, or with full access none (`unconfined`). */
  readonly sandbox: Sandbox
  readonly unsafeNoSandbox: boolean
  /** The round has full access right now (see `fullAccessIn`): no sandbox, any path, any address. */
  readonly fullAccess: boolean
  /** Live projection; current as of the last committed event. */
  state(): ColonyState
  /**
   * A tool call of this agent the log recorded before the round was resumed (see `readTranscript`): resuming answers an
   * unfinished step from it instead of running the call again.
   */
  recordedCall?(agent: string, callId: string): CallRecord | undefined
  append(draft: EventDraft): Promise<MyrEvent>
  /**
   * Builds events from current state and appends them only if no other event landed in between.
   * Retries on conflict, so `build` must be a pure function of state.
   */
  appendAtomic(build: (state: ColonyState) => EventDraft[]): Promise<MyrEvent[]>
  requestTaskVerification(taskId: string, by: string): void
  requestFinalVerification(by: string, summary: string): Promise<string>
  /** Auto review: runs the reviewer on the work so far and returns its verdict, without ending the round. */
  requestReview(by: string, summary: string): Promise<string>
  /** Adds a worker at run time (auto team mode). Returns a message for the calling agent. */
  /** Adds a worker: a new one for `label`, or (with `specialist`) one of the person's saved specialists by name. */
  spawnWorker(by: string, label: string, focus: string, model?: string, specialist?: string): Promise<string>
  /**
   * The lead asks one of its on-call crewmates for a piece of work: the crewmate joins (or, already here, gets the
   * job by mail), does it, and its reply to the lead comes back here, not as a wake-up.
   */
  askCrewmate(by: string, name: string, job: string): Promise<string>
  /** Lets a worker go: it stops now and later rounds of the chat leave it out. */
  dismissWorker(by: string, name: string, reason: string): Promise<string>
  deadline(): number
  /** What this round has used so far, against its limits; a chat's colony keeps running totals across rounds. */
  spent(): { cost: number; tokens: number }
  /** An agent's tool batch has finished (all calls in one model response have results). */
  /**
   * While a chat winds down after its final answer, each agent has one last word: past that, the reason it may not
   * message (and its turn ends). Outside wind-down, nothing.
   */
  closing?(agent: string): string | undefined
  batchEnded(agent: string): void
  /** The round's advisor, when it has one: agents show it their steps that called tools. */
  readonly advisor?: Advisor
  /** An agent's model failed for good (a refusal, or an error that retries did not fix): pause for the person. */
  modelFailed(agent: string, model: string, error: ModelError): Promise<void>
  /** An agent's working checklist (update_todo), kept in view and checked when it stops. */
  setTodos(agent: string, items: readonly TodoItem[]): void
  /** A swarm's opening huddle: peers are proposing how to split the work, and nobody may start it yet. */
  huddling(): boolean
  /** Search and page fetching for agents. */
  readonly web: WebTools
  /**
   * The model that judges find's names and passages for this agent: the cheapest the person can use, as chat titles
   * pick one. Absent (tests, bare hosts), find ranks by words alone.
   */
  judge?(agent: string): Judge | undefined
  /** Pictures and speech for agents (generate_image, tts); absent in runs without the model runtime. */
  readonly media?: MediaTools
  /** Tools of the connected MCP servers, offered to agents allowed `mcp`. */
  mcpTools(): AgentTool[]
  /** The MCP server marks this tool read-only (it changes nothing), so by default it runs without asking. */
  mcpReadOnly(tool: string): boolean
  /** The configured MCP server an MCP tool comes from, for rules that name a server. */
  mcpServer(tool: string): string | undefined
  /**
   * What the permission model says about one of this agent's calls (allow, ask, deny, and why), under the round's
   * levels as they are now.
   */
  permit(agent: string, call: PermissionCall): PermissionVerdict
  /** A tool denied outright to this agent (by name, by its MCP server, or every MCP tool): left out of its tools. */
  hidden(agent: string, tool: string, server?: string): boolean
  /** Tools of the person's plugins, for one agent; offered, like MCP tools, to agents allowed `mcp`. */
  pluginTools(agent: string): AgentTool[]
  /** Sections the person's plugins add to the system prompt of an agent that leads or one that works. */
  pluginPrompts(role: 'lead' | 'worker'): string[]
  /**
   * The speaking agent's reply as it is being written (`done` when the model message ends). Live only: shown to
   * whoever is watching, never logged; the finished reply arrives as chat/reply. `plain`: the model's own text, not
   * a reply tool's, so it may turn out to be narration before a tool call ("Let me look…") rather than an answer.
   */
  streamed(agent: string, text: string, done: boolean, plain: boolean): void
  /** The person's plugins, for agents that build one (create_plugin); absent where plugins are not set up. */
  readonly plugins?: PluginHost
  /**
   * Tools changed (a tool was made, rules changed): rebuild every agent's tool list for its next step. `made` is a tool
   * an agent just made, loaded for that agent at once so it can call it; the rest load it with find_tools.
   */
  toolsChanged(made?: { readonly by: string; readonly tool: string }): void
  /** A real browser for agents; absent when no Chrome is installed. */
  readonly browser?: BrowserHub
  /**
   * The person's Mac (computer use), while this round may use it: switched on in Settings when it started, and only
   * the person wrote into it. Absent otherwise, so the computer tool is left out or refuses.
   */
  readonly computer?: ComputerHub
  /**
   * The person's remote hosts this round may reach over SSH, with what reaches them: set up in Settings → Tools, and
   * only while the person alone wrote into the round (a channel member's message takes them away at once).
   */
  remotes(): { readonly hub: SshHub; readonly hosts: readonly SshHost[] } | undefined
  /** The project's instructions, check commands and layout, read when the round started; absent outside projects. */
  readonly project?: ProjectContext
  /**
   * Waits for the person to sign in to `site` in this agent's browser (they take control, sign in, and hand back).
   * Resolves with how it ended; the round keeps running meanwhile.
   */
  requestLogin(
    agent: string,
    site: string,
    url: string,
    reason: string,
  ): Promise<'handed-back' | 'timeout' | 'stopped'>
  /** This round's random marker for untrusted content, so a page cannot fake the end of its own block. */
  readonly boundary: string
  /** Records web content an agent was shown, and returns what it saw recently (newest last). */
  rememberUntrusted(agent: string, source: string, text: string): void
  recentUntrusted(agent: string): readonly { source: string; text: string }[]
  /**
   * Asks the person to approve one tool call (an "ask" project's edits and commands); resolves false if they deny
   * it, it times out, or the round stops first.
   */
  requestApproval(agent: string, tool: string, summary: string): Promise<boolean>
  /**
   * Like requestApproval, with the full change shown for the person to look over and, where a field is editable,
   * rewrite. `key` is the call's receipt key, so its result is kept once it has run. `permission`: the call and the
   * verdict that asked, so the card can say why and offer to remember the answer, and the request is decided again
   * when the rules change while it waits.
   */
  reviewChange(
    agent: string,
    tool: string,
    summary: string,
    options: {
      review?: Review
      key?: string
      read?: string
      permission?: { call: PermissionCall; verdict: PermissionVerdict }
    },
  ): Promise<ReviewDecision>
  /**
   * A sandboxed agent asks to read a folder outside what it may read: the person allows it once (this round) or for
   * the chat. Refused for the person's keys and other chats' data, and in a round a channel member writes into.
   */
  requestRead(agent: string, path: string, reason?: string): Promise<string>
  /**
   * Starts a long-running command (a dev server) in the agent's sandbox and waits until it serves: on `port` if
   * given, else at the first local URL it prints. Returns that URL.
   */
  startServer(agent: string, name: string, command: string, port?: number): Promise<string>
  /**
   * The localhost ports this colony's running servers opened: the only private addresses its agents' web reads and
   * browser may reach. With full access, `all`: every address.
   */
  localPorts(): ReadonlySet<number> | 'all'
  /** The latest output of a server this colony started. */
  serverLogs(name: string): string
  stopServer(name: string, reason: string): Promise<void>
  /** What this round changed in its project folder, as a unified diff; undefined outside projects. */
  projectDiff(): Promise<string | undefined>
  /**
   * Merges an agent's worktree changes into the project folder and returns the files merged (none without a
   * worktree). Throws, with what to do, when they conflict.
   */
  mergeWork(agent: string): Promise<string[]>
  /**
   * Autoresearch: the agent's own branch of the project to experiment on, a worktree made now if it has none (any
   * round of a git project whose preset lets agents change it without asking). `keep` commits a trial, `revert` drops
   * it, and `finish` merges what was kept into the project folder and, for a worktree made for the experiment, puts
   * the agent back in the folder. Throws, with why, where there is no such branch to be had.
   */
  experimentTree(agent: string): Promise<ExperimentTree>
  /** Runs the person's PreToolUse hooks; throws, with the hook's reason, when one blocks the call. */
  beforeTool(agent: string, tool: string, input: unknown): Promise<void>
  /** Runs the person's PostToolUse hooks; returns what they want the agent to know ('' for nothing). */
  afterTool(agent: string, tool: string, input: unknown, output: string): Promise<string>
  /** The person's stream rules and the project's (stream-rules.ts), read afresh at each agent turn. */
  streamRules?(): readonly StreamRule[]
  /** The skills agents may use in this colony (enabled ones, including its project's). */
  skills(): { name: string; description: string }[]
  /** A skill's instructions, or one of its files, for an agent (use_skill). */
  useSkill(agent: string, name: string, file?: string): Promise<string>
  /** Loads an agent's on-demand tools matching `query` (find_tools); says what it loaded. */
  loadTools(agent: string, query: string): string
  /** Brings the project folder's current state into an agent's worktree; the files it changed there. */
  refreshWork(agent: string): Promise<string[]>
  /** Proposes a memory for the person to keep across chats, maybe in place of kept ones (`replaces`). */
  proposeMemory(
    agent: string,
    input: {
      text: string
      kind: string
      scope: 'everywhere' | 'project'
      why: string
      replaces?: readonly string[]
    },
  ): Promise<string>
  /** The person's kept memories best matching `query`, for this chat's scope (recall). */
  recallMemory(query: string): string | Promise<string>
  /** Ends this round and has the chat rerun its request at a bigger tier, keeping the work so far. */
  escalate(by: string, to: 'solo' | 'team', reason: string): Promise<string>
}

export const agentActor = (name: string): ActorRef => ({ kind: 'agent', id: name })

export interface TodoItem {
  readonly text: string
  readonly done: boolean
}

/** The person's answer to a review: whether to go ahead, the fields they rewrote (by key), and anything they said. */
export interface ReviewDecision {
  readonly approved: boolean
  readonly edits?: Readonly<Record<string, string>>
  readonly note?: string
}
