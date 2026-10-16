import { afterEach, expect, jest, test } from 'bun:test'
import { foldColony, type MyrEvent } from '@myrmidon/protocol'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

afterEach(() => {
  jest.useRealTimers()
})

/** A crew round's log as the runtime writes it: created at 1 s, started at 2 s, still running. */
function running(): MyrEvent[] {
  const rows: [string, unknown][] = [
    [
      'colony/created',
      {
        name: 'build me a site',
        mission: 'build me a site',
        pattern: 'lead-workers',
        agents: [
          { name: 'lead', role: 'lead', model: 'mock/lead', tools: ['reply_user'] },
          { name: 'ada', role: 'worker', model: 'mock/ada', tools: ['fs_write'] },
        ],
        chat: { chatId: 'chat-c', round: 1, request: 'build me a site' },
        tier: 'team',
        budget: { wallMs: 0 },
      },
    ],
    ['colony/started', { pid: 1, hostname: 'test', models: {}, rules: [] }],
  ]
  return rows.map(
    ([type, payload], i) =>
      ({
        colonyId: 'colony-c',
        seq: i + 1,
        id: `e${i + 1}`,
        time: new Date((i + 1) * 1000).toISOString(),
        type,
        actor: { kind: 'system', id: 'lead' },
        trace: { traceId: 't', spanId: 's' },
        schema: 1,
        payload,
      }) as MyrEvent,
  )
}

test("the run card's LED clock moves while the round runs, with no new event to redraw it", async () => {
  // 61 s after the round was created, as the card first draws.
  jest.useFakeTimers({ now: new Date(62_000) })
  const { RoundView } = await import('../src/client/chat/RoundView.tsx')
  const { LiveReplies } = await import('../src/client/use-colony.ts')
  const events = running()
  const head = events.at(-1)?.seq ?? 0
  const colony = {
    events,
    state: foldColony('colony-c', events),
    cursor: head,
    head,
    live: true,
    setCursor() {},
    setLive() {},
    streams: new LiveReplies(),
  }
  const view = await mount(
    <RoundView
      colonyId="colony-c"
      colony={colony}
      round={1}
      onOpenColony={() => {}}
      onRetry={() => {}}
      onLearn={() => {}}
      onAnswer={async () => {}}
      onResume={async () => {}}
      models={[]}
      retry="hidden"
    />,
  )
  const clock = () =>
    [...view.host.querySelectorAll('svg[role="img"]')]
      .map((s) => s.getAttribute('aria-label') ?? '')
      .find((label) => /^\d\d:\d\d$/.test(label))
  expect(clock()).toBe('01:01')
  // No event arrives: only the clock's own tick may move it.
  await act(async () => jest.advanceTimersByTime(5_000))
  expect(clock()).toBe('01:06')
  await view.unmount()
})
