import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextRun, parseCron, ScheduleStore, startScheduler } from '../src/schedules.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-sched-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const at = (s: string) => new Date(s)
const local = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

test('cron times: every quarter hour, weekdays at 9, monthly, and bad expressions', () => {
  // 2026-10-07 is a Wednesday.
  expect(local(nextRun('*/15 * * * *', at('2026-10-07T10:07:30')))).toBe('2026-10-07 10:15')
  expect(local(nextRun('0 9 * * 1-5', at('2026-10-07T09:00:00')))).toBe('2026-10-08 09:00')
  expect(local(nextRun('0 9 * * 1-5', at('2026-10-09T10:00:00')))).toBe('2026-10-12 09:00')
  expect(local(nextRun('30 18 1 * *', at('2026-10-07T00:00:00')))).toBe('2026-11-01 18:30')
  expect(local(nextRun('0 0 * * 7', at('2026-10-07T00:00:00')))).toBe('2026-10-11 00:00')
  expect(() => parseCron('* * *')).toThrow('five fields')
  expect(() => parseCron('61 * * * *')).toThrow('out of range')
  expect(() => nextRun('0 0 31 2 *', at('2026-10-07T00:00:00'))).toThrow('never runs')
})

test('due schedules start, record their chat, and move to their next time', async () => {
  const store = new ScheduleStore(dir)
  const daily = store.add({ request: 'Summarize new issues', cron: '0 9 * * *' }, at('2026-10-07T08:00:00'))
  expect(local(new Date(daily.nextRun ?? ''))).toBe('2026-10-07 09:00')
  expect(store.due(at('2026-10-07T08:59:00'))).toEqual([])
  expect(store.due(at('2026-10-07T09:00:30')).map((s) => s.id)).toEqual([daily.id])

  // Run it now: make it due, start the scheduler once.
  store.update(daily.id, { cron: '* * * * *' }, at('2020-01-01T00:00:00'))
  const started: string[] = []
  const stop = startScheduler(store, async (s) => {
    started.push(s.request)
    return 'chat-123'
  })
  for (let i = 0; i < 40 && !store.list()[0]?.lastRun; i++) await Bun.sleep(25)
  stop()
  expect(started).toEqual(['Summarize new issues'])
  const after = store.list()[0]
  expect(after?.lastRun?.chatId).toBe('chat-123')
  expect(Date.parse(after?.nextRun ?? '')).toBeGreaterThan(Date.now() - 60_000)
  store.update(daily.id, { enabled: false })
  expect(store.due(at('2100-01-01T00:00:00'))).toEqual([])
  expect(() => store.add({ request: 'x', cron: 'nope' })).toThrow()
})
