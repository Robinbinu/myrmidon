import { expect, test } from 'bun:test'
import { type AgentView, emptyColonyState } from '@myrmidon/protocol'
import type { ColonyHost } from '../src/host.ts'
import { FactualObserver } from '../src/observer.ts'

test('an agent making tool calls is not reported as stalled', () => {
  const state = emptyColonyState('c1')
  state.status = 'running'
  state.budget = { wallMs: 3_600_000 }
  const agent = { info: { name: 'wren' }, status: 'working', toolCalls: 0 } as unknown as AgentView
  state.agents.wren = agent
  const host = { state: () => state, deadline: () => Date.now() + 3_600_000 } as unknown as ColonyHost
  const observer = new FactualObserver(host)
  const stalls = () => observer.tick().filter((s) => s.kind === 'stall').length

  observer.tick()
  for (let i = 0; i < 4; i++) {
    agent.toolCalls += 3
    expect(stalls()).toBe(0)
  }
  expect(stalls() + stalls()).toBe(1)
})

test('an unclaimed ready task is reported once per revision, not on every tick', () => {
  const state = emptyColonyState('c1')
  state.status = 'running'
  state.budget = { wallMs: 3_600_000 }
  state.agents.wren = { info: { name: 'wren' }, status: 'idle', toolCalls: 0 } as unknown as AgentView
  const task = {
    id: 'task-1',
    revision: 1,
    subject: 'Fix it',
    status: 'pending',
    blockedBy: [],
    artifacts: [],
  }
  state.tasks['task-1'] = task as never
  const host = { state: () => state, deadline: () => Date.now() + 3_600_000 } as unknown as ColonyHost
  const observer = new FactualObserver(host)
  const unclaimed = () => observer.tick().filter((s) => s.kind === 'unclaimed').length
  expect(unclaimed()).toBe(1)
  expect(unclaimed()).toBe(0)
  expect(unclaimed()).toBe(0)
  // Released and pending again: a new revision is news once more.
  state.tasks['task-1'] = { ...task, revision: 3 } as never
  expect(unclaimed()).toBe(1)
  expect(unclaimed()).toBe(0)
})
