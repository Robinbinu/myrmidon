import { afterEach, expect, jest, test } from 'bun:test'
import { foldColony, type MyrEvent, roundSlice } from '@myrmidon/protocol'
import { act } from 'react'
import { colonyLog } from './colony-load.ts'
import { mount, withDom } from './dom.ts'

withDom()

// use-colony.ts and ColonyScreen.tsx reach api.ts, which reads the page as it loads: imported inside the tests.
const colonyModule = () => import('../src/client/use-colony.ts')
const screenModule = () => import('../src/client/ColonyScreen.tsx')

/** A seeded run of numbers, so a failing case can be made again. */
function numbers(seed: number) {
  let s = seed
  return (n: number) => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648
    return s % n
  }
}

test('folding each batch onto the last fold gives the state a fold of the whole log gives', async () => {
  const { foldTo } = await colonyModule()
  for (const seed of [1, 2, 3]) {
    const log = colonyLog(6000, seed)
    const next = numbers(seed)
    let fold: ReturnType<typeof foldTo> | undefined
    let shown = 0
    let cursor = 0
    let checks = 0
    while (shown < log.length) {
      shown = Math.min(log.length, shown + 1 + next(400))
      const events = log.slice(0, shown)
      // Mostly live; now and then the replay cursor goes back or forward, as the replay bar moves it.
      const roll = next(10)
      cursor = roll === 0 ? next(shown + 1) : roll === 1 ? Math.min(shown, cursor + next(50)) : shown
      fold = foldTo(fold, 'c-load', events, cursor)
      expect(fold.state).toEqual(foldColony('c-load', events, cursor))
      checks++
    }
    expect(checks).toBeGreaterThan(20)
  }
})

test('a fold hands out a new state when the log moved and the same one when it did not', async () => {
  const { foldTo } = await colonyModule()
  const log = colonyLog(300, 9)
  const first = foldTo(undefined, 'c', log.slice(0, 200), 200)
  const more = foldTo(first, 'c', log, 300)
  expect(more.state).not.toBe(first.state)
  expect(foldTo(more, 'c', log, 300)).toBe(more)
  // A log loaded again (other event objects, same seqs) is folded from the start, not on top of the old one.
  const reloaded = log.map((e) => ({ ...e }))
  expect(foldTo(more, 'c', reloaded, 300).working).not.toBe(more.working)
})

test('the activity stream built on batch by batch matches one built from the whole log, and keeps its items', async () => {
  const { buildItems, foldItems } = await screenModule()
  const log = colonyLog(8000, 4)
  const next = numbers(4)
  let fold: ReturnType<typeof foldItems> | undefined
  let shown = 0
  let agent: string | undefined
  while (shown < log.length) {
    shown = Math.min(log.length, shown + 1 + next(300))
    if (next(12) === 0) agent = [undefined, 'ada', 'lead'][next(3)]
    const events = log.slice(0, shown)
    const before = fold
    fold = foldItems(fold, events, shown, agent)
    expect(fold.shown).toEqual(buildItems(events, shown, agent))
    // Items that were shown and did not change are the same objects, so their rows skip re-rendering.
    if (before && before.agent === agent) {
      const old = new Map(before.shown.map((i) => [i.id, i]))
      const kept = fold.shown.filter((i) => old.get(i.id) === i)
      const changed = fold.shown.filter((i) => old.has(i.id) && old.get(i.id) !== i)
      expect(kept.length + changed.length).toBeGreaterThan(0)
      // Only a tool call whose result came in is replaced.
      for (const i of changed) expect(i.kind).toBe('tool')
    }
  }
})

test('a reply being written reaches its listeners at most once a frame budget, ending on its latest text', async () => {
  jest.useFakeTimers()
  try {
    const { LiveReplies } = await colonyModule()
    const { STREAM_RENDER_MS } = await import('../src/client/ui-config.ts')
    const replies = new LiveReplies()
    let heard = 0
    replies.subscribe(() => heard++)
    for (let i = 1; i <= 100; i++) {
      replies.take({ agent: 'lead', text: 'word '.repeat(i), done: false }, 7)
      jest.advanceTimersByTime(2)
    }
    jest.advanceTimersByTime(STREAM_RENDER_MS)
    // 100 pieces over 200ms: one change heard per STREAM_RENDER_MS, not one per piece.
    expect(heard).toBeLessThanOrEqual(Math.ceil(200 / STREAM_RENDER_MS) + 1)
    expect(heard).toBeGreaterThan(1)
    expect(replies.get().lead).toEqual({ text: 'word '.repeat(100), since: 7, done: false })
  } finally {
    jest.useRealTimers()
  }
})

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
const realFetch = globalThis.fetch
const realSocket = globalThis.WebSocket
let unmount: (() => Promise<void>) | undefined
afterEach(async () => {
  await unmount?.()
  unmount = undefined
  socket = undefined
  globalThis.fetch = realFetch
  globalThis.WebSocket = realSocket
})

/** A colony server: the log so far on load, then whatever the test sends down the stream. */
function serve(initial: MyrEvent[]) {
  globalThis.fetch = (async () => Response.json(initial)) as unknown as typeof fetch
  globalThis.WebSocket = LiveSocket as unknown as typeof WebSocket
  return (data: unknown) => act(async () => socket?.onmessage?.({ data: JSON.stringify(data) }))
}
const settle = () => act(async () => Bun.sleep(10))
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0

// Budgets for the median batch of 50 events (React's development build, with lots of room for a busy machine). Before
// folds were kept, the chat page took 230-700ms a batch at this size in a production build (every round folded the
// log again); kept, about 2ms there.
const CHAT_BATCH_MS = 150
const SCREEN_BATCH_MS = 250

test('a long chat applies each batch within budget, slices stay exact, and streamed replies re-render only their reader', async () => {
  const { useColony, useLiveReplies, useRoundSlice } = await colonyModule()
  const log = colonyLog(22_000, 7)
  const send = serve(log.slice(0, 20_000))
  const slices = new Map<number, ReturnType<typeof useRoundSlice>>()
  let view: ReturnType<typeof useColony> | undefined
  function Round({ colony, round }: { colony: ReturnType<typeof useColony>; round: number }) {
    slices.set(round, useRoundSlice(colony, round))
    return null
  }
  let chatRenders = 0
  let replyRenders = 0
  function Replies({ colony }: { colony: ReturnType<typeof useColony> }) {
    replyRenders++
    return <p id="replies">{useLiveReplies(colony.streams).lead?.text}</p>
  }
  function Chat() {
    const colony = useColony('c-load')
    view = colony
    chatRenders++
    return (
      <>
        {colony.state.rounds.map((r) => (
          <Round key={r.round} colony={colony} round={r.round} />
        ))}
        <Replies colony={colony} />
      </>
    )
  }
  unmount = (await mount(<Chat />)).unmount
  await settle()
  expect(view?.state.rounds.length).toBeGreaterThan(40)
  const times: number[] = []
  for (let i = 0; i < 20; i++) {
    const t = performance.now()
    await send(log.slice(20_000 + i * 50, 20_000 + (i + 1) * 50))
    times.push(performance.now() - t)
  }
  expect(median(times)).toBeLessThan(CHAT_BATCH_MS)
  const renders = { chat: chatRenders, replies: replyRenders }
  for (let i = 0; i < 50; i++) await send({ type: 'stream', agent: 'lead', text: `word ${i}`, done: false })
  await act(async () => Bun.sleep(100))
  expect(chatRenders).toBe(renders.chat)
  expect(replyRenders).toBeGreaterThan(renders.replies)
  expect(document.getElementById('replies')?.textContent).toBe('word 49')
  // The kept slices are the ones slicing from scratch gives, for every round.
  const colony = view as NonNullable<typeof view>
  expect(colony.head).toBe(21_000)
  expect(colony.state).toEqual(foldColony('c-load', colony.events))
  for (const r of colony.state.rounds) {
    const fresh = roundSlice(colony.state, colony.events, r.round)
    const kept = slices.get(r.round)
    expect(kept?.events).toEqual(fresh.events)
    expect(kept?.state).toEqual(fresh.state)
    expect(kept?.info).toEqual(fresh.info)
    expect({ ...kept?.metrics, wallMs: 0 }).toEqual({ ...fresh.metrics, wallMs: 0 })
  }
}, 30_000)

test('the crew screen keeps up with a long log: batches within budget, newest first, and its controls still work', async () => {
  const { ColonyScreen } = await screenModule()
  const { copy } = await import('../src/client/copy.ts')
  const log = colonyLog(20_000, 7)
  const send = serve(log)
  unmount = (await mount(<ColonyScreen id="c-load" />)).unmount
  await settle()
  await send([{ ...log[0], seq: 20_001, id: 'e20001', type: 'colony/completed', payload: { verdicts: [] } }])
  const times: number[] = []
  for (let i = 0; i < 20; i++) {
    const seq = 20_002 + i
    const t = performance.now()
    await send([
      {
        ...log[0],
        seq,
        id: `e${seq}`,
        type: 'board/posted',
        payload: { agent: 'ada', text: `marker ${seq}`, mentions: [] },
      },
    ])
    times.push(performance.now() - t)
  }
  expect(median(times)).toBeLessThan(SCREEN_BATCH_MS)
  // The newest event heads the stream, in log order.
  const first = document.querySelector('ol li')?.textContent ?? ''
  expect(first).toContain('marker 20021')

  for (let i = 0; i < 20; i++) await send({ type: 'stream', agent: 'lead', text: `word ${i}`, done: false })
  await settle()

  const button = (text: string) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement
  const position = () => document.body.textContent?.match(/#(\d+)\/(\d+)/)?.slice(1)
  expect(position()).toEqual(['20021', '20021'])
  await act(async () =>
    (document.querySelector(`[aria-label="${copy.colonyScreen.replay.stepBack}"]`) as HTMLElement).click(),
  )
  expect(position()).toEqual(['20020', '20021'])
  expect(document.querySelector('ol li')?.textContent).toContain('marker 20020')
  await act(async () => button(copy.colonyScreen.replay.live).click())
  expect(position()).toEqual(['20021', '20021'])
  // Picking an agent shows its activity only; Everyone shows all of it again.
  const grace = [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('grace'))
  await act(async () => (grace as HTMLButtonElement).click())
  expect(document.querySelector('ol li')?.textContent).not.toContain('marker')
  const everyone = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith(copy.colonyScreen.everyone),
  ) as HTMLButtonElement
  await act(async () => everyone.click())
  expect(document.querySelector('ol li')?.textContent).toContain('marker 20021')
}, 30_000)
