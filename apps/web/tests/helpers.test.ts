import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { TeamConfig } from '../src/client/api.ts'
import {
  helperMode,
  helpersHint,
  helpersLabel,
  readSavedHelpers,
  saveHelpers,
} from '../src/client/chat/helpers.ts'

const base: TeamConfig = {
  mode: 'orchestrated',
  leadModel: 'a/lead',
  roster: [
    { role: 'researcher', model: 'a/lead' },
    { role: 'coder', model: 'a/lead' },
  ],
  extraWorkers: 2,
  judgeModel: 'b/judge',
}

test('the helpers setting reads the same wherever it is summed up', () => {
  expect(helperMode({ ...base, roster: [], extraWorkers: 0 })).toBe('never')
  expect(helpersLabel({ ...base, roster: [], extraWorkers: 0 })).toBe('No helpers')
  expect(helpersLabel(base)).toBe('2 helpers · auto')
  // "Always" is still the same two helpers, not a differently counted "team of 3".
  expect(helpersLabel({ ...base, helpers: 'always' })).toBe('2 helpers · always')
  expect(helpersLabel({ ...base, roster: base.roster.slice(0, 1) })).toBe('1 helper · auto')
  expect(helpersLabel({ ...base, mode: 'swarm', helpers: 'always' })).toBe('2 peers · always')
  // The line under a summary is the chosen option's own hint, so it never contradicts the label.
  expect(helpersHint({ ...base, helpers: 'always' })).toBe('Every message starts with the whole team')
})

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  })
})
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage')
})

test('helpers turned off are kept across a reload, and a damaged record is ignored', () => {
  expect(readSavedHelpers()).toBeUndefined()
  saveHelpers({ mode: 'swarm', roster: base.roster, extraWorkers: 0 })
  expect(readSavedHelpers()).toEqual({ mode: 'swarm', roster: base.roster, extraWorkers: 0 })
  store.set('myr-helpers-saved', JSON.stringify({ mode: 'swarm', roster: [{ role: 'x' }], extraWorkers: -3 }))
  expect(readSavedHelpers()).toBeUndefined()
  store.set('myr-helpers-saved', '{not json')
  expect(readSavedHelpers()).toBeUndefined()
})
