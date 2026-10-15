import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ActorRef } from '@myrmidon/protocol'
import { LONG_HISTORY_EVENTS, withinBudget } from '../../../tests/perf-budgets.ts'
import { colonyId, EventLog, Schema, sqliteLogStore } from '../src/index.ts'

const agent: ActorRef = { kind: 'agent', id: 'a1' }
const BATCH = 50

let home: string
let root: Context

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-perf-log-'))
  root = new Context()
  await root.plugin(sqliteLogStore, { home })
  await root.plugin(EventLog)
  await new Promise((r) => setTimeout(r, 5))
  root.log.registerType({
    type: 'note/appended',
    version: 1,
    schema: Schema.object({ text: Schema.string().required() }),
  })
})

afterEach(async () => {
  await root.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
})

const note = (i: number) => ({
  type: 'note/appended',
  actor: agent,
  payload: { text: `step ${i}: ${'tool output '.repeat(20)}` },
})

async function fill(id: ReturnType<typeof colonyId>, count: number) {
  for (let i = 0; i < count; i += BATCH)
    await root.log.append(
      id,
      Array.from({ length: Math.min(BATCH, count - i) }, (_, j) => note(i + j)),
    )
}

test(`a ${LONG_HISTORY_EVENTS}-event log appends and reads back within its budgets`, async () => {
  const C = colonyId('long')
  await withinBudget('appendLongHistory', () => fill(C, LONG_HISTORY_EVENTS))
  const { result: all } = await withinBudget('readLongHistory', async () => {
    const whole = await root.log.read(C)
    const page = await root.log.read(C, { from: LONG_HISTORY_EVENTS - 99 })
    expect(page).toHaveLength(100)
    return whole
  })
  expect(all).toHaveLength(LONG_HISTORY_EVENTS)
  expect(all.map((e) => e.seq).every((seq, i) => seq === i + 1)).toBe(true)
}, 60_000)

test('20 colonies appending at once keep gap-free logs within the budget', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => colonyId(`agent-${i}`))
  await withinBudget('concurrentAppends', () => Promise.all(ids.map((id) => fill(id, 500))))
  for (const id of ids) {
    const events = await root.log.read(id)
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 500 }, (_, i) => i + 1))
  }
}, 60_000)
