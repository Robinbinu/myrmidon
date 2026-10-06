import type { BlobStore, EventLog } from '@myrmidon/core'
import type { ActorRef, ColonyId, ColonyState, EventDraft, MyrEvent } from '@myrmidon/protocol'
import type { Sandbox } from './sandbox.ts'
import type { ColonySpec } from './spec.ts'
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
  deadline(): number
}

export const agentActor = (name: string): ActorRef => ({ kind: 'agent', id: name })
