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

test('a ready task meant for someone nudges only them, not every idle crewmate', () => {
  const state = emptyColonyState('c1')
  state.status = 'running'
  state.budget = { wallMs: 3_600_000 }
  for (const name of ['pm', 'designer', 'qa'])
    state.agents[name] = { info: { name }, status: 'idle', toolCalls: 0 } as unknown as AgentView
  const task = (id: string, assignee?: string, blockedBy: string[] = []) => ({
    id,
    revision: 1,
    subject: id,
    description: '',
    status: 'pending' as const,
    blockedBy,
    artifacts: [],
    ...(assignee ? { assignee } : {}),
  })
  state.tasks = { 'task-1': task('task-1', 'pm'), 'task-2': task('task-2', 'designer', ['task-1']) }
  const host = { state: () => state, deadline: () => Date.now() + 3_600_000 } as unknown as ColonyHost
  const nudged = () => new FactualObserver(host).tick().find((s) => s.kind === 'unclaimed')?.targets
  expect(nudged()).toEqual(['pm'])
  // A task meant for nobody in particular still goes to everyone idle.
  state.tasks['task-3'] = task('task-3')
  expect(nudged()).toEqual(['pm', 'designer', 'qa'])
})
