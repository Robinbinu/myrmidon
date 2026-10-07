import Schema from '@deepseek-ai/schemastery'
import type { ColonyId, EventPayloads } from '@myrmidon/protocol'
import { MyrError } from './errors.ts'
import type { EventTypeDefinition } from './registry.ts'
import type { LogStore, PreparedEvent } from './store.ts'

export interface GuardContext {
  readonly colonyId: ColonyId
  readonly event: PreparedEvent
  /** Earlier events in the same batch, not yet committed. */
  readonly pending: readonly PreparedEvent[]
  readonly store: LogStore
}

/** Throws to reject an event. Guards run inside the per-colony append queue. */
export type Guard = (ctx: GuardContext) => Promise<void> | void

/** Types the log itself owns, because the invariants depend on them. */
export const CORE_EVENT_TYPES: readonly EventTypeDefinition[] = [
  {
    type: 'verifier/verdict',
    version: 1,
    actors: ['verifier'],
    schema: Schema.object({
      target: Schema.string().required(),
      verifierId: Schema.string().required(),
      pass: Schema.boolean().required(),
      score: Schema.number(),
      evidence: Schema.string().default(''),
    }),
  },
  {
    type: 'colony/completed',
    version: 1,
    actors: ['system'],
    schema: Schema.object({ verdicts: Schema.array(Schema.string()).required() }),
  },
]

/** Completion is accepted only when it cites passing verdicts that exist in this colony. */
export const completionGuard: Guard = async ({ colonyId, event, pending, store }) => {
  if (event.type !== 'colony/completed') return
  const { verdicts } = event.payload as EventPayloads['colony/completed']
  if (verdicts.length === 0)
    throw new MyrError('GUARD_REJECTED', 'colony/completed must cite at least one verdict')
  for (const id of verdicts) {
    const found = pending.find((p) => p.id === id) ?? (await store.get(colonyId, id))
    if (found?.type !== 'verifier/verdict') {
      throw new MyrError(
        'GUARD_REJECTED',
        `colony/completed cites ${id}, which is not a verdict in ${colonyId}`,
      )
    }
    if ((found.payload as EventPayloads['verifier/verdict']).pass !== true) {
      throw new MyrError('GUARD_REJECTED', `colony/completed cites failing verdict ${id}`)
    }
  }
}
