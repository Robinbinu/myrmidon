import { afterEach, expect, jest, test } from 'bun:test'
import type { MyrEvent } from '@myrmidon/protocol'
import { act, useState } from 'react'
import { copy } from '../src/client/copy.ts'
import { mount, withDom } from './dom.ts'

withDom()

const START = '2026-10-15T09:00:00.000Z'
const at = (s: number) => new Date(Date.parse(START) + s * 1000).toISOString()

const realFetch = globalThis.fetch
const realSocket = globalThis.WebSocket
let unmount: (() => Promise<void>) | undefined
afterEach(async () => {
  await unmount?.()
  unmount = undefined
  restore()
  jest.useRealTimers()
  globalThis.fetch = realFetch
  globalThis.WebSocket = realSocket
})

/** The value under the header's time label. */
const shown = () =>
  [...document.querySelectorAll('span.section-label')].find(
    (l) => l.textContent === copy.colonyScreen.stats.time,
  )?.nextElementSibling?.textContent

const tick = (ms: number) => act(async () => jest.advanceTimersByTime(ms))

/** Fake timers from `start`, with a count of the intervals left running (React keeps timeouts of its own). */
function clockAt(start: string) {
  jest.useFakeTimers({ now: new Date(start) })
  const live = new Set<unknown>()
  const set = globalThis.setInterval
  const clear = globalThis.clearInterval
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    const id = set(fn, ms)
    live.add(id)
    return id
  }) as typeof setInterval
  globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => {
    live.delete(id)
    clear(id)
  }) as typeof clearInterval
  restore = () => {
    globalThis.setInterval = set
    globalThis.clearInterval = clear
  }
  return { intervals: () => live.size }
}
let restore = () => {}

test('a running colony counts up on its own clock and holds its final time once it ends', async () => {
  const clock = clockAt(at(0))
  const { RunTime } = await import('../src/client/ColonyScreen.tsx')
  let renders = 0
  let end: (endedAt: string) => void = () => {}
  // A stand-in for the screen around the clock: it must not re-render as the clock ticks.
  function Header() {
    const [endedAt, setEndedAt] = useState<string>()
    end = setEndedAt
    renders++
    return <RunTime createdAt={START} endedAt={endedAt} />
  }
  const view = await mount(<Header />)
  unmount = view.unmount
  expect(shown()).toBe('0s')
  await tick(5000)
  expect(shown()).toBe('5s')
  await tick(60_000)
  expect(shown()).toBe('1m 5s')
  expect(renders).toBe(1)
  expect(clock.intervals()).toBe(1)

  await act(async () => end(at(70)))
  expect(shown()).toBe('1m 10s')
  expect(clock.intervals()).toBe(0)
  await tick(30_000)
  expect(shown()).toBe('1m 10s')
})

test('the clock stops when its screen goes away', async () => {
  const clock = clockAt(at(0))
  const { RunTime } = await import('../src/client/ColonyScreen.tsx')
  const view = await mount(<RunTime createdAt={START} />)
  expect(clock.intervals()).toBe(1)
  await view.unmount()
  expect(clock.intervals()).toBe(0)
})

test('a finished colony shows its final time and keeps no clock', async () => {
  const clock = clockAt(at(500))
  const { RunTime } = await import('../src/client/ColonyScreen.tsx')
  const view = await mount(<RunTime createdAt={START} endedAt={at(42)} />)
  unmount = view.unmount
  expect(shown()).toBe('42s')
  expect(clock.intervals()).toBe(0)
})

function event(seq: number, type: string, payload: unknown): MyrEvent {
  return {
    colonyId: 'c1',
    seq,
    id: `e${seq}`,
    time: at(seq - 1),
    type,
    actor: { kind: 'system', id: 'runtime' },
    trace: { traceId: 't', spanId: 's' },
    schema: 1,
    payload,
  } as unknown as MyrEvent
}

let socket: { onmessage: ((m: { data: string }) => void) | null } | undefined
class LiveSocket {
  onopen = null
  onmessage: ((m: { data: string }) => void) | null = null
  onclose = null
  readyState = 1
  constructor() {
    socket = this
  }
  close() {}
}

test('the crew screen header moves on while the colony runs, without a refresh, and stops when it completes', async () => {
  clockAt(at(2))
  const log = [
    event(1, 'colony/created', {
      name: 'Clock',
      mission: 'm',
      pattern: 'p',
      agents: [{ name: 'lead', role: 'lead', model: 'm/x', tools: [] }],
      acceptance: [],
      budget: { wallMs: 600_000 },
      unsafeNoSandbox: false,
    }),
    event(2, 'colony/started', {}),
  ]
  globalThis.fetch = (async () => Response.json(log)) as unknown as typeof fetch
  globalThis.WebSocket = LiveSocket as unknown as typeof WebSocket
  const { ColonyScreen } = await import('../src/client/ColonyScreen.tsx')
  const view = await mount(<ColonyScreen id="c1" />)
  unmount = view.unmount
  await act(async () => {})
  expect(shown()).toBe('2s')
  await tick(3000)
  expect(shown()).toBe('5s')
  await tick(10_000)
  expect(shown()).toBe('15s')

  // The run ends at 0:20 as the clock reads 0:20; later seconds no longer count.
  jest.setSystemTime(new Date(at(20)))
  await act(async () =>
    socket?.onmessage?.({ data: JSON.stringify([event(21, 'colony/completed', { verdicts: [] })]) }),
  )
  expect(shown()).toBe('20s')
  await tick(30_000)
  expect(shown()).toBe('20s')
})
