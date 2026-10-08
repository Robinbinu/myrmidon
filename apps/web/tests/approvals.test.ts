import { expect, test } from 'bun:test'
import { foldColony, type MyrEvent } from '@myrmidon/protocol'
import { awaitingApproval, roundApprovals } from '../src/client/chat/approvals.ts'

let seq = 0
const event = (type: string, payload: unknown): MyrEvent =>
  ({
    colonyId: 'c',
    seq: ++seq,
    id: `e${seq}`,
    time: new Date(seq * 1000).toISOString(),
    type,
    actor: { kind: 'system', id: 'test' },
    trace: { traceId: 't', spanId: 's' },
    schema: 1,
    payload,
  }) as MyrEvent

const request = (id: string) =>
  event('approval/requested', { id, agent: 'lead', tool: 'fs_edit', summary: id })

test('a call an earlier round left undecided does not hold up a later round', () => {
  seq = 0
  // Round 1 asked, then the server died: the log has the request and never a decision.
  const earlier = [request('stale')]
  const now = [request('asked'), event('approval/decided', { id: 'asked', approved: true, by: 'person' })]
  const state = foldColony('c', [...earlier, ...now])
  expect(Object.values(state.approvals).some((a) => !a.decided)).toBe(true)
  expect(awaitingApproval(state, now)).toBe(false)
  expect(roundApprovals(state, now).map((r) => r.approval.id)).toEqual(['asked'])
})

test("a round's own undecided call is waiting on the person", () => {
  seq = 0
  const round = [request('asked')]
  expect(awaitingApproval(foldColony('c', round), round)).toBe(true)
})
