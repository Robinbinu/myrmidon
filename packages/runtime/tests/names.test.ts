import { expect, test } from 'bun:test'
import { colorSlot, identityOf } from '@myrmidon/protocol'
import { CALL_SIGNS, pickName } from '../src/index.ts'

test('a full crew gets distinct names and distinct colours', () => {
  for (let run = 0; run < 50; run++) {
    const taken = new Set(['lead'])
    for (let i = 0; i < 8; i++) taken.add(pickName(taken))
    const workers = [...taken].filter((n) => n !== 'lead')
    expect(workers).toHaveLength(8)
    expect(new Set(workers.map(colorSlot)).size).toBe(8)
    for (const w of workers) expect(CALL_SIGNS as readonly string[]).toContain(w)
  }
})

test('identities are stable and the lead keeps its own colour', () => {
  expect(identityOf('nova')).toEqual(identityOf('nova'))
  expect(identityOf('lead').color).toBe('#ffb31a')
  expect(identityOf('nova').form).toBe('gumdrop')
})
