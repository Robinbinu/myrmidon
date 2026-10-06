import type { BlobStore, EventLog } from '@myrmidon/core'
import type { ActorRef, ColonyId, ColonyState, EventDraft, MyrEvent } from '@myrmidon/protocol'
import type { AgentTool } from '@oh-my-pi/pi-agent-core'
import type { BrowserHub } from './browser.ts'
import type { ProjectContext } from './project-context.ts'
import type { Sandbox } from './sandbox.ts'
import type { ColonySpec } from './spec.ts'
import type { WebTools } from './web.ts'
import type { ColonyWorkspace } from './workspace.ts'

/** Everything a tool or service needs from the running colony, without depending on the runner. */
export interface ColonyHost {
  readonly id: ColonyId
  readonly spec: ColonySpec
  readonly log: EventLog
  readonly blobs: BlobStore
  readonly workspace: ColonyWorkspace
  readonly sandbox: Sandbox
  readonly unsafeNoSandbox: boolean
  /** Live projection; current as of the last committed event. */
  state(): ColonyState
  append(draft: EventDraft): Promise<MyrEvent>
  /**
   * Builds events from current state and appends them only if no other event landed in between.
   * Retries on conflict, so `build` must be a pure function of state.
   */
  appendAtomic(build: (state: ColonyState) => EventDraft[]): Promise<MyrEvent[]>
  requestTaskVerification(taskId: string, by: string): void
  requestFinalVerification(by: string, summary: string): Promise<string>
  /** Adds a worker at run time (auto team mode). Returns a message for the calling agent. */
  spawnWorker(by: string, label: string, focus: string, model?: string): Promise<string>
  /** Lets a worker go: it stops now and later rounds of the chat leave it out. */
  dismissWorker(by: string, name: string, reason: string): Promise<string>
  deadline(): number
  /** An agent's tool batch has finished (all calls in one model response have results). */
  batchEnded(agent: string): void
  /** An agent's model failed for good (a refusal, or an error that retries did not fix): pause for the person. */
  modelFailed(
    agent: string,
    model: string,
    error: { kind: 'refusal' | 'error'; message: string },
  ): Promise<void>
  /** An agent's working checklist (update_todo), kept in view and checked when it stops. */
  setTodos(agent: string, items: readonly TodoItem[]): void
  /** A swarm's opening huddle: peers are proposing how to split the work, and nobody may start it yet. */
  huddling(): boolean
  /** Search and page fetching for agents. */
  readonly web: WebTools
  /** Tools of the connected MCP servers, offered to agents allowed `mcp`. */
  mcpTools(): AgentTool[]
  /** A tool was made (create_tool): rebuild every agent's tool list so it appears on their next step. */
  toolsChanged(): void
  /** A real browser for agents; absent when no Chrome is installed. */
  readonly browser?: BrowserHub
  /** The project's instructions, check commands and layout, read when the round started; absent outside projects. */
  readonly project?: ProjectContext
}

export const agentActor = (name: string): ActorRef => ({ kind: 'agent', id: name })

export interface TodoItem {
  readonly text: string
  readonly done: boolean
}
