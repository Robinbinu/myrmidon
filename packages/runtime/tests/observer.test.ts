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
