import { afterEach, expect, test } from 'bun:test'
import type { MyrEvent } from '@myrmidon/protocol'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { browsingNow } from '../src/client/chat/activity.ts'
import { currentStep } from '../src/client/chat/steps.ts'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
const realSocket = globalThis.WebSocket
afterEach(() => {
  globalThis.fetch = realFetch
  globalThis.WebSocket = realSocket
})

let seq = 0
const ev = (type: string, payload: object) =>
  ({
    seq: ++seq,
    type,
    time: '2026-10-16T10:00:00.000Z',
    actor: { kind: 'agent', id: 'wren' },
    payload,
  }) as unknown as MyrEvent
const browsing = [
  ev('tool/call', {
    agent: 'wren',
    callId: 'c1',
    tool: 'browser_open',
    args: { url: 'https://shop.example/cart' },
  }),
  ev('tool/call', { agent: 'kai', callId: 'c2', tool: 'shell', args: { command: 'ls' } }),
]

test('an agent busy in its browser is known with its site, and only while the round runs', () => {
  expect([...browsingNow(browsing, true)]).toEqual([['wren', 'shop.example']])
  expect(browsingNow(browsing, false).size).toBe(0)
  // The page the browser shows wins over the URL first opened.
  const moved = [
    ...browsing,
    ev('browser/keyframe', { agent: 'wren', url: 'https://pay.example/checkout', action: 'click' }),
    ev('tool/call', {
      agent: 'wren',
      callId: 'c3',
      tool: 'browser_act',
      args: { steps: [{ click: '1_2' }] },
    }),
  ]
  expect(browsingNow(moved, true).get('wren')).toBe('pay.example')
  expect(currentStep(moved)).toBe('wren is browsing pay.example')
})

class FakeSocket {
  readyState = 1
  onopen?: () => void
  onmessage?: (m: { data: string }) => void
  constructor(readonly url: string) {
    queueMicrotask(() => this.onopen?.())
  }
  send() {}
  close() {}
}

const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)))

test("the browser place shows each agent's live tab, marked as browsing its site, and the person's own browser", async () => {
  globalThis.WebSocket = FakeSocket as never
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost/')
    if (url.pathname === '/api/colonies/c1/browsers')
      return Response.json({
        tabs: [{ agent: 'wren', url: 'https://shop.example/cart', title: 'Cart', controlledBy: 'agent' }],
      })
    if (url.pathname === '/api/browser')
      return Response.json({
        available: true,
        tabs: [],
        settings: { cookies: 'quit', allowedSites: [], viewport: 'responsive' },
        maxTabs: 3,
        maxHtmlBytes: 1000,
      })
    return Response.json({})
  }) as typeof fetch
  const { BrowserPlace } = await import('../src/client/chat/BrowserPlace.tsx')
  const { host, unmount } = await mount(
    <MotionConfig reducedMotion="always">
      <BrowserPlace colonyId="c1" live events={browsing} fullAccess />
    </MotionConfig>,
  )
  await settle()
  const tabs = [...host.querySelectorAll('[role="tab"]')]
  expect(tabs.map((t) => t.textContent)).toEqual(['wrenbrowsing shop.exampleLive', 'Your browser'])
  // The agent's tab is shown first: its own live view, with the take-over control.
  expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
  expect(host.textContent).toContain('Take control')
  await act(async () => (tabs[1] as HTMLElement).click())
  await settle()
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Your browser')
  unmount()
})

test('a device without full access sees the agents’ tabs but not a browser of its own', async () => {
  globalThis.WebSocket = FakeSocket as never
  globalThis.fetch = (async () => Response.json({ tabs: [] })) as unknown as typeof fetch
  const { BrowserPlace } = await import('../src/client/chat/BrowserPlace.tsx')
  const { host, unmount } = await mount(
    <BrowserPlace colonyId="c2" live={false} events={[]} fullAccess={false} />,
  )
  await settle()
  expect(host.querySelectorAll('[role="tab"]').length).toBe(0)
  expect(host.textContent).toContain('No agent has opened a browser in this chat yet.')
  unmount()
})
