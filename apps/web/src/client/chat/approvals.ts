import type { ColonyState, EventPayloads, MyrEvent } from '@myrmidon/protocol'

export type Pending = ColonyState['approvals'][string]

/**
 * The calls this round asked the person about, by where they were asked in its log. The colony's own list is not
 * enough: a call left undecided when an earlier round died (the server went down) stays undecided in it forever.
 */
export function roundApprovals(
  state: ColonyState,
  events: readonly MyrEvent[],
): { seq: number; approval: Pending }[] {
  return events.flatMap((e) => {
    if (e.type !== 'approval/requested') return []
    const a = state.approvals[(e.payload as EventPayloads['approval/requested']).id]
    return a ? [{ seq: e.seq, approval: a }] : []
  })
}

/** The round is paused on a call only the person can let through. */
export const awaitingApproval = (state: ColonyState, events: readonly MyrEvent[]) =>
  roundApprovals(state, events).some((r) => !r.approval.decided)
