import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { colonyId, newEventId, SqliteLogStore } from '@myrmidon/core'
import { DELIVERED_VERIFIER, type EventId } from '@myrmidon/protocol'

const home = mkdtempSync(join(tmpdir(), 'myr-cli-events-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

/** Writes a finished colony whose completion cites `verdicts`, and prints it with `myrmidon events`. */
async function printed(name: string, verdicts: { id: EventId; verifierId: string }[]) {
  const id = colonyId(name)
  const store = new SqliteLogStore(home)
  const event = (type: string, payload: object, eventId: EventId = newEventId()) => ({
    colonyId: id,
    id: eventId,
    time: '2026-10-08T12:00:00.000Z',
    type,
    actor: { kind: 'system' as const, id: 'test' },
    trace: { traceId: 't', spanId: 's' },
    schema: 1,
    payload,
  })
  await store.append(id, [
    ...verdicts.map((v) =>
      event(
        'verifier/verdict',
        { target: 'colony', verifierId: v.verifierId, pass: true, evidence: 'ok' },
        v.id,
      ),
    ),
    event('colony/completed', { verdicts: verdicts.map((v) => v.id) }),
  ])
  store.close()
  const proc = Bun.spawn(['bun', join(import.meta.dir, '../src/main.ts'), 'events', name, '--home', home], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  return Bun.stripANSI(out)
}

test('a round nobody reviewed completes as not reviewed, not as passing its checks', async () => {
  const out = await printed('unreviewed', [{ id: newEventId(), verifierId: DELIVERED_VERIFIER }])
  expect(out).toContain('completed (not reviewed)')
  expect(out).not.toContain('acceptance checks passed')
  expect(out).not.toContain('PASS')
})

test('a reviewed round still says its checks passed', async () => {
  const out = await printed('reviewed', [{ id: newEventId(), verifierId: 'llm-judge#0' }])
  expect(out).toContain('all acceptance checks passed')
  expect(out).toContain('PASS llm-judge#0')
})
