export type MyrErrorCode =
  | 'INVALID_COLONY_ID'
  | 'UNKNOWN_EVENT_TYPE'
  | 'DUPLICATE_EVENT_TYPE'
  | 'INVALID_PAYLOAD'
  | 'ACTOR_NOT_ALLOWED'
  | 'HEAD_MISMATCH'
  | 'GUARD_REJECTED'
  | 'UNSUPPORTED_SCHEMA'
  | 'COLONY_NOT_FOUND'
  | 'BLOB_NOT_FOUND'
  | 'BLOB_CORRUPT'

export class MyrError extends Error {
  constructor(
    readonly code: MyrErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'MyrError'
  }
}
