import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ModelOption, TeamConfig } from '../src/client/api.ts'
import {
  helperMode,
  helpersHint,
  helpersLabel,
  readSavedHelpers,
  saveHelpers,
  withHelperMode,
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

const models: ModelOption[] = ['a/lead', 'b/judge'].map((ref) => ({
  ref,
  provider: ref.split('/')[0] as string,
  id: ref.split('/')[1] as string,
  name: ref,
  reasoning: false,
}))

test('the helpers setting reads the same wherever it is summed up', () => {
  expect(helperMode({ ...base, roster: [], extraWorkers: 0 })).toBe('never')
  expect(helpersLabel({ ...base, roster: [], extraWorkers: 0 })).toBe('No crewmates')
  expect(helpersLabel(base)).toBe('2 crewmates · auto')
  // "Always" is still the same two crewmates, not a differently counted "team of 3".
  expect(helpersLabel({ ...base, helpers: 'always' })).toBe('2 crewmates · always')
  expect(helpersLabel({ ...base, roster: base.roster.slice(0, 1) })).toBe('1 crewmate · auto')
  expect(helpersLabel({ ...base, mode: 'swarm', helpers: 'always' })).toBe('2 crewmates · always')
  // The line under a summary is the chosen option's own hint, so it never contradicts the label.
  expect(helpersHint({ ...base, helpers: 'always' })).toBe('Every message starts with the whole crew')
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
  // A specialist that isn't a name is dropped rather than sent to the server.
  store.set(
    'myr-helpers-saved',
    JSON.stringify({ mode: 'orchestrated', roster: [{ role: 'coder', model: 'a/lead', specialist: 7 }] }),
  )
  expect(readSavedHelpers()?.roster).toEqual([{ role: 'coder', model: 'a/lead' }])
})

test('helpers brought back on a model that is gone since run on the lead model instead', () => {
  saveHelpers({
    mode: 'orchestrated',
    roster: [
      { role: 'researcher', model: 'gone/model', specialist: 'ada' },
      { role: 'coder', model: 'a/lead' },
    ],
    extraWorkers: 1,
  })
  const off = { ...base, roster: [], extraWorkers: 0 }
  expect(withHelperMode(off, 'auto', models).roster).toEqual([
    { role: 'researcher', model: 'a/lead', specialist: 'ada' },
    { role: 'coder', model: 'a/lead' },
  ])
})

test('turning helpers off and on again brings back the same team, swarm included', () => {
  const swarm: TeamConfig = { ...base, mode: 'swarm', extraWorkers: 0, helpers: 'always' }
  const off = withHelperMode(swarm, 'never', models)
  expect(off).toMatchObject({ mode: 'orchestrated', roster: [], extraWorkers: 0 })
  expect(off.helpers).toBeUndefined()
  expect(helperMode(off)).toBe('never')
  // Read back from storage, as after a reload: nothing about the team lives only in memory.
  const { helpers: _always, ...auto } = swarm
  expect(withHelperMode(off, 'auto', models)).toEqual(auto)
  expect(withHelperMode(off, 'always', models)).toEqual(swarm)
  // With nothing set aside, helpers start as two on the lead's model.
  store.clear()
  expect(withHelperMode(off, 'auto', models).roster.map((r) => r.role)).toEqual(['researcher', 'coder'])
})
