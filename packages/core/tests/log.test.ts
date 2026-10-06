import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ActorRef, EventId } from '@myrmidon/protocol'
import { BlobStore, colonyId, EventLog, MyrError, REDACTED, Schema, sqliteLogStore } from '../src/index.ts'

const agent: ActorRef = { kind: 'agent', id: 'a1' }
const verifier: ActorRef = { kind: 'verifier', id: 'checks' }
const system: ActorRef = { kind: 'system', id: 'myrmidon' }
const C = colonyId('test-colony')

let home: string
let root: Context

async function boot() {
  root = new Context()
  await root.plugin(sqliteLogStore, { home })
  await root.plugin(EventLog)
  await new Promise((r) => setTimeout(r, 5))
  root.log.registerType({ type: 'note/appended', version: 1, schema: Schema.object({ text: Schema.string().required() }) })
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-log-'))
  await boot()
})

afterEach(async () => {
  await root.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
})

describe('EventLog', () => {
  test('appends with gap-free seq and reads back after restart', async () => {
    await root.log.append(C, [
      { type: 'note/appended', actor: agent, payload: { text: 'one' } },
      { type: 'note/appended', actor: agent, payload: { text: 'two' } },
    ])
    await root.log.appendOne(C, { type: 'note/appended', actor: agent, payload: { text: 'three' } })
    await root.fiber.dispose()
    await boot()
    const events = await root.log.read(C)
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(events.map((e) => (e.payload as { text: string }).text)).toEqual(['one', 'two', 'three'])
    expect(await root.log.colonies()).toEqual([C])
  })

  test('the database itself refuses updates and deletes', async () => {
    await root.log.appendOne(C, { type: 'note/appended', actor: agent, payload: { text: 'keep' } })
    const db = new Database(join(home, 'colonies', C, 'events.sqlite'))
    expect(() => db.run(`update events set payload = '{}'`)).toThrow('append-only')
    expect(() => db.run('delete from events')).toThrow('append-only')
    db.close()
  })

  test('rejects unknown types and invalid payloads', async () => {
    await expect(root.log.appendOne(C, { type: 'nope/x', actor: agent, payload: {} })).rejects.toThrow(MyrError)
    await expect(
      root.log.appendOne(C, { type: 'note/appended', actor: agent, payload: { text: 5 } }),
    ).rejects.toThrow('invalid note/appended payload')
  })

  test('only verifiers may append verdicts', async () => {
    const draft = { type: 'verifier/verdict', payload: { target: 'x', verifierId: 'v', pass: true, evidence: '' } }
    await expect(root.log.appendOne(C, { ...draft, actor: agent })).rejects.toThrow('may not append')
    await root.log.appendOne(C, { ...draft, actor: verifier })
  })

  test('completion requires passing verdicts from this colony', async () => {
    await expect(
      root.log.appendOne(C, { type: 'colony/completed', actor: system, payload: { verdicts: [] } }),
    ).rejects.toThrow('at least one verdict')
    const fail = await root.log.appendOne(C, {
      type: 'verifier/verdict',
      actor: verifier,
      payload: { target: 'colony', verifierId: 'v', pass: false, evidence: 'no' },
    })
    await expect(
      root.log.appendOne(C, { type: 'colony/completed', actor: system, payload: { verdicts: [fail.id] } }),
    ).rejects.toThrow('failing verdict')
    await expect(
      root.log.appendOne(C, {
        type: 'colony/completed',
        actor: system,
        payload: { verdicts: ['01900000-0000-7000-8000-000000000000' as EventId] },
      }),
    ).rejects.toThrow('not a verdict')
    const pass = await root.log.appendOne(C, {
      type: 'verifier/verdict',
      actor: verifier,
      payload: { target: 'colony', verifierId: 'v', pass: true, evidence: 'ok' },
    })
    await root.log.appendOne(C, { type: 'colony/completed', actor: system, payload: { verdicts: [pass.id] } })
    await expect(
      root.log.appendOne(C, { type: 'colony/completed', actor: agent, payload: { verdicts: [pass.id] } }),
    ).rejects.toThrow('may not append')
  })

  test('expectedHead gives compare-and-set appends', async () => {
    await root.log.appendOne(C, { type: 'note/appended', actor: agent, payload: { text: 'a' } })
    await root.log.append(C, [{ type: 'note/appended', actor: agent, payload: { text: 'b' } }], { expectedHead: 1 })
    await expect(
      root.log.append(C, [{ type: 'note/appended', actor: agent, payload: { text: 'c' } }], { expectedHead: 1 }),
    ).rejects.toThrow('expected head 1')
  })

  test('concurrent appends never collide', async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        root.log.appendOne(C, { type: 'note/appended', actor: agent, payload: { text: `n${i}` } }),
      ),
    )
    const seqs = (await root.log.read(C)).map((e) => e.seq)
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  })

  test('redacts secrets before storing', async () => {
    root.log.registerSecret('hunter2-super-secret')
    await root.log.appendOne(C, {
      type: 'note/appended',
      actor: agent,
      payload: { text: 'key sk-ant-abcdefghijklmnopqrstuvwxyz and hunter2-super-secret' },
    })
    const [event] = await root.log.read(C)
    expect((event?.payload as { text: string }).text).toBe(`key ${REDACTED} and ${REDACTED}`)
  })

  test('emits log/appended only after commit', async () => {
    const seen: number[] = []
    root.on('log/appended', (_c, events) => seen.push(...events.map((e) => e.seq)))
    await root.log.appendOne(C, { type: 'note/appended', actor: agent, payload: { text: 'x' } })
    await root.log.appendOne(C, { type: 'nope/x', actor: agent, payload: {} }).catch(() => {})
    expect(seen).toEqual([1])
  })
})

describe('BlobStore', () => {
  test('stores by content hash and detects corruption', async () => {
    const blobs = new BlobStore(join(home, 'blobs'))
    const { hash, size } = await blobs.put('hello')
    expect(size).toBe(5)
    expect(await blobs.text(hash)).toBe('hello')
    expect((await blobs.put('hello')).hash).toBe(hash)
    await Bun.write(join(home, 'blobs', hash.slice(0, 2), hash.slice(2)), 'tampered')
    await expect(blobs.get(hash)).rejects.toThrow('hash check')
  })
})
