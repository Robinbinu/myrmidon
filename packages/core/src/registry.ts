import type { ActorKind, ActorRef, MyrEvent } from '@myrmidon/protocol'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { MyrError } from './errors.ts'

export interface EventTypeDefinition {
  readonly type: string
  /** Current payload version, starting at 1. */
  readonly version: number
  readonly schema: StandardSchemaV1
  /** Actor kinds allowed to append this type; omitted means any. */
  readonly actors?: readonly ActorKind[]
  /** `migrations[n]` upgrades a version-n payload to version n+1. */
  readonly migrations?: Readonly<Record<number, (payload: unknown) => unknown>>
}

export class EventTypeRegistry {
  private readonly _types = new Map<string, EventTypeDefinition>()

  register(def: EventTypeDefinition): () => void {
    if (this._types.has(def.type)) throw new MyrError('DUPLICATE_EVENT_TYPE', `event type already registered: ${def.type}`)
    if (!Number.isInteger(def.version) || def.version < 1) throw new RangeError(`bad version for ${def.type}`)
    this._types.set(def.type, def)
    return () => {
      if (this._types.get(def.type) === def) this._types.delete(def.type)
    }
  }

  get(type: string): EventTypeDefinition | undefined {
    return this._types.get(type)
  }

  types(): string[] {
    return [...this._types.keys()].sort()
  }

  async validate(type: string, actor: ActorRef, payload: unknown): Promise<{ version: number; payload: unknown }> {
    const def = this._types.get(type)
    if (!def) throw new MyrError('UNKNOWN_EVENT_TYPE', `unknown event type: ${type}`)
    if (def.actors && !def.actors.includes(actor.kind)) {
      throw new MyrError('ACTOR_NOT_ALLOWED', `${actor.kind} may not append ${type}`)
    }
    const result = await def.schema['~standard'].validate(payload)
    if (result.issues) {
      const detail = result.issues.map((i) => i.message).join('; ')
      throw new MyrError('INVALID_PAYLOAD', `invalid ${type} payload: ${detail}`)
    }
    return { version: def.version, payload: result.value }
  }

  /** Brings a stored event to the current payload version. Unknown types pass through untouched. */
  upgrade(event: MyrEvent): MyrEvent {
    const def = this._types.get(event.type)
    if (!def || event.schema === def.version) return event
    if (event.schema > def.version) {
      throw new MyrError('UNSUPPORTED_SCHEMA', `${event.type} v${event.schema} is newer than v${def.version}`)
    }
    let payload = event.payload
    for (let v = event.schema; v < def.version; v++) {
      const step = def.migrations?.[v]
      if (!step) throw new MyrError('UNSUPPORTED_SCHEMA', `no migration for ${event.type} v${v}`)
      payload = step(payload)
    }
    return { ...event, schema: def.version, payload }
  }
}
