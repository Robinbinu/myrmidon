import type { ColonyId, EventId } from '@myrmidon/protocol'
import { MyrError } from './errors.ts'

// Colony ids become directory names, so the pattern also rules out path traversal.
const COLONY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function colonyId(value: string): ColonyId {
  if (!COLONY_ID.test(value))
    throw new MyrError('INVALID_COLONY_ID', `invalid colony id: ${JSON.stringify(value)}`)
  return value as ColonyId
}

/**
 * An opaque id: it names the colony's directory, which agents see in their paths, so it must not carry the chat's
 * title or anything else from the interface. Older ids began with a slug of the title; they still load.
 */
export function newColonyId(): ColonyId {
  return colonyId(`colony-${Date.now().toString(36)}-${hex(4)}`)
}

export function newEventId(): EventId {
  return Bun.randomUUIDv7() as EventId
}

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

export const newTraceId = () => hex(16)
export const newSpanId = () => hex(8)
