import { expect, test } from 'bun:test'
import { LONG_HISTORY_EVENTS, withinBudget } from '../../../tests/perf-budgets.ts'
import { foldColony, type MyrEvent } from '../src/index.ts'

// A crew of five working through a long chat: each step is a model reply, a tool call and its result, and now and
// then a status change, a board message or a note, as a real round's log reads.
const AGENTS = ['lead', 'researcher', 'coder', 'writer', 'reviewer']

function history(count: number, from = 1): MyrEvent[] {
  const events: MyrEvent[] = []
  let seq = from - 1
  const ev = (type: string, payload: Record<string, unknown>) => {
    seq++
    events.push({
      id: `e${seq}`,
      seq,
      colonyId: 'c',
      time: new Date(Date.UTC(2026, 9, 15, 8, 0, 0, seq)).toISOString(),
      type,
      actor: { kind: 'agent', id: 'x' },
      trace: { traceId: 't', spanId: 's' },
      schema: 1,
      payload,
    } as MyrEvent)
  }
  if (from === 1)
    ev('colony/created', {
      name: 'Long run',
      mission: 'Long run',
      pattern: 'lead-workers',
      agents: AGENTS.map((name) => ({ name, role: name, model: 'm/one', tools: [] })),
      acceptance: [],
      budget: { wallMs: 0 },
      unsafeNoSandbox: false,
    })
  for (let step = 0; events.length < count; step++) {
    const agent = AGENTS[step % AGENTS.length] as string
    const callId = `c${seq}`
    if (step % 25 === 0) ev('agent/status', { agent, status: 'working', detail: `step ${step}` })
    ev('llm/response', {
      agent,
      model: 'm/one',
      text: `Thinking about step ${step}. `.repeat(8),
      toolCalls: [{ id: callId, name: 'shell', arguments: { command: 'ls' } }],
      usage: { input: 2_000, output: 200, totalTokens: 2_200 },
      stopReason: 'toolUse',
    })
    ev('tool/call', { agent, callId, tool: 'shell', args: { command: 'ls' } })
    ev('tool/result', { agent, callId, tool: 'shell', ok: true, output: 'file.ts\n'.repeat(20) })
    if (step % 10 === 0) ev('board/posted', { agent, text: `done with ${step}`, mentions: [] })
    if (step % 15 === 0) ev('note/appended', { agent, text: `finding ${step}` })
  }
  return events.slice(0, count)
}

test(`folding a ${LONG_HISTORY_EVENTS}-event log stays within its budget`, async () => {
  const events = history(LONG_HISTORY_EVENTS)
  const { result: state } = await withinBudget('foldLongHistory', () => foldColony('c', events))
  expect(state.lastSeq).toBe(LONG_HISTORY_EVENTS)
  expect(Object.keys(state.agents)).toEqual(AGENTS)
  const calls = events.filter((e) => e.type === 'tool/call').length
  expect(Object.values(state.agents).reduce((n, a) => n + a.toolCalls, 0)).toBe(calls)
})

test('streamed batches refolded onto a long log stay within their budget', async () => {
  // use-colony.ts appends each streamed batch and folds the whole log again: the cost of a live long session.
  let events = history(LONG_HISTORY_EVENTS)
  const { result: state } = await withinBudget('streamOntoLongHistory', () => {
    let last = foldColony('c', events)
    for (let batch = 0; batch < 200; batch++) {
      events = [...events, ...history(10, events.length + 1)]
      last = foldColony('c', events)
    }
    return last
  })
  expect(state.lastSeq).toBe(LONG_HISTORY_EVENTS + 2_000)
})
