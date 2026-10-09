import { expect, test } from 'bun:test'
import { applyEvent, emptyColonyState, type MyrEvent } from '@myrmidon/protocol'
import { crewLinks, linkWidth } from '../src/client/ColonyMap.tsx'
import { MAP_LINK_WIDTH } from '../src/client/ui-config.ts'

let seq = 0
const ev = (type: string, payload: object) =>
  ({
    id: `e${++seq}`,
    seq,
    type,
    time: '2026-10-06T12:00:00Z',
    actor: { kind: 'agent', id: 'x' },
    payload,
  }) as unknown as MyrEvent

const task = (assignee?: string, revision = 1) => ({
  id: 't1',
  revision,
  subject: 'Write the parser',
  description: '',
  status: 'pending',
  blockedBy: [],
  artifacts: [],
  ...(assignee ? { assignee } : {}),
})

test('handing a task to a crewmate counts as one message from the lead, however often the task changes', () => {
  const state = emptyColonyState('c1')
  applyEvent(state, ev('task/changed', { task: task('nova'), by: 'lead' }))
  applyEvent(state, ev('task/changed', { task: task('nova', 2), by: 'lead' }))
  applyEvent(state, ev('task/changed', { task: task('nova', 3), by: 'nova' }))
  expect(state.links).toEqual({ 'lead→nova': 1 })
  applyEvent(state, ev('task/changed', { task: task('kai', 4), by: 'lead' }))
  expect(state.links).toEqual({ 'lead→nova': 1, 'lead→kai': 1 })
})

test('the map draws one link per pair that talked, with both directions and every message counted', () => {
  const links = crewLinks(
    { 'lead→nova': 3, 'nova→lead': 2, 'lead→kai': 1, 'lead→user': 4, 'nova→nova': 1 },
    new Set(['lead', 'nova', 'kai']),
  )
  expect(links).toEqual([
    { a: 'lead', b: 'nova', count: 5, toB: true, toA: true },
    { a: 'kai', b: 'lead', count: 1, toB: false, toA: true },
  ])
})

test('busier links are drawn thicker, from the thinnest line to the thickest', () => {
  expect(linkWidth(1, 1)).toBe(MAP_LINK_WIDTH.min)
  expect(linkWidth(1, 40)).toBe(MAP_LINK_WIDTH.min)
  expect(linkWidth(40, 40)).toBeCloseTo(MAP_LINK_WIDTH.max)
  const widths = [2, 5, 10, 20].map((n) => linkWidth(n, 40))
  expect(widths).toEqual([...widths].sort((x, y) => x - y))
  expect(new Set(widths).size).toBe(widths.length)
})
