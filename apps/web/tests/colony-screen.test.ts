import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { MyrEvent } from '@myrmidon/protocol'
import { copy } from '../src/client/copy.ts'

// The crew console reaches api.ts, which reads the page's address and storage when it loads.
const page = globalThis as unknown as Record<string, unknown>
let screen: typeof import('../src/client/ColonyScreen.tsx')
beforeAll(async () => {
  page.window = new EventTarget()
  page.location = { hash: '', pathname: '/', search: '', host: 'localhost', protocol: 'http:' }
  screen = await import('../src/client/ColonyScreen.tsx')
})
afterAll(() => {
  delete page.window
  delete page.location
})

const verdict = {
  id: 'e1',
  seq: 1,
  type: 'verifier/verdict',
  time: '2026-10-06T12:00:00Z',
  actor: { kind: 'verifier', id: 'llm-judge#0' },
  payload: { target: 'colony', verifierId: 'llm-judge#0', pass: true, evidence: '' },
} as unknown as MyrEvent

const verified = {
  ...verdict,
  id: 'e2',
  seq: 2,
  type: 'task/changed',
  payload: {
    by: 'verifier',
    task: {
      id: 't1',
      revision: 3,
      subject: 'Parse',
      description: '',
      status: 'verified',
      blockedBy: [],
      artifacts: [],
    },
  },
} as unknown as MyrEvent

test('the activity names the reviewer by its role, not its runtime ids', () => {
  const items = screen.buildItems([verdict, verified], 2)
  expect(items.map((i) => i.agent)).toEqual([
    copy.colonyScreen.agents.reviewer,
    copy.colonyScreen.agents.reviewer,
  ])
})
