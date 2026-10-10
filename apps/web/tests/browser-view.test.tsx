import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { CONFIRM_ARM_DELAY_MS } from '../src/client/ui-config.ts'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
const realSocket = globalThis.WebSocket
afterEach(() => {
  globalThis.fetch = realFetch
  globalThis.WebSocket = realSocket
})

/** A stand-in for the live socket: records what the page sends and lets the test push what the server would. */
class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 1
  sent: unknown[] = []
  onopen?: () => void
  onmessage?: (m: { data: string }) => void
  onclose?: () => void
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
    queueMicrotask(() => this.onopen?.())
  }
  send(text: string) {
    this.sent.push(JSON.parse(text))
  }
  close() {
    this.readyState = 3
  }
  push(e: unknown) {
    this.onmessage?.({ data: JSON.stringify(e) })
  }
}

const tab = (id: string, url: string, title: string) => ({
  id,
  url,
  title,
  loading: false,
  canGoBack: false,
  canGoForward: false,
})

function serverOf(state: { tabs: ReturnType<typeof tab>[] }) {
  const asked: string[] = []
  const settings = { cookies: 'quit', allowedSites: [] as string[], viewport: 'responsive' }
  const whole = () => ({ available: true, tabs: state.tabs, settings, maxTabs: 3, maxHtmlBytes: 1000 })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost/')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    asked.push(`${method} ${url.pathname}${body ? ` ${JSON.stringify(body)}` : ''}`)
    if (url.pathname === '/api/browser') return Response.json(whole())
    if (url.pathname === '/api/browser/tabs') {
      if (body?.url === 'localhost:3000')
        return Response.json(
          {
            error: 'localhost:3000 is not one of the allowed sites',
            code: 'blocked',
            site: 'localhost:3000',
          },
          { status: 403 },
        )
      const next = tab(`t${state.tabs.length + 1}`, body?.url ? `http://${body.url}/` : 'about:blank', '')
      state.tabs = [...state.tabs, next]
      return Response.json({ tab: next })
    }
    if (url.pathname === '/api/browser/settings') {
      Object.assign(settings, body)
      return Response.json(whole())
    }
    const closing = /^\/api\/browser\/tabs\/([^/]+)$/.exec(url.pathname)?.[1]
    if (closing && method === 'DELETE') {
      state.tabs = state.tabs.filter((t) => t.id !== closing)
      return Response.json(whole())
    }
    return Response.json({})
  }) as unknown as typeof fetch
  return { asked, settings }
}

const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)))

test('the tab strip shows each tab, opens and closes them, and streams the one picked', async () => {
  FakeSocket.all = []
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  const state = { tabs: [tab('t1', 'http://localhost:4372/', 'Myrmidon'), tab('t2', 'about:blank', '')] }
  const { asked } = serverOf(state)
  const { BrowserView } = await import('../src/client/chat/BrowserView.tsx')
  const { host, unmount } = await mount(
    <MotionConfig reducedMotion="always">
      <BrowserView />
    </MotionConfig>,
  )
  await settle()
  const tabs = () => [...host.querySelectorAll('[data-tab]')].map((t) => t.textContent)
  expect(tabs()).toEqual(['Myrmidon', 'New tab'])
  // The newest tab is shown first, with its own socket.
  expect(host.querySelector('[data-tab][aria-current="true"]')?.textContent).toBe('New tab')
  expect(FakeSocket.all.at(-1)?.url).toContain('/api/browser/tabs/t2/live')

  await act(async () => (host.querySelector('[data-tab]') as HTMLElement).click())
  await settle()
  expect(FakeSocket.all.at(-1)?.url).toContain('/api/browser/tabs/t1/live')
  expect((host.querySelector('input[aria-label="Address"]') as HTMLInputElement).value).toBe(
    'http://localhost:4372/',
  )
  // The server's frames and tab changes reach the view.
  await act(async () => {
    FakeSocket.all.at(-1)?.push({ type: 'frame', data: 'AAAA', width: 640, height: 400 })
    FakeSocket.all.at(-1)?.push({
      type: 'tabs',
      tabs: [tab('t1', 'http://localhost:4372/next', 'Next page'), state.tabs[1]],
    })
  })
  expect(tabs()).toEqual(['Next page', 'New tab'])
  expect(host.querySelector('img[src^="data:image/jpeg"]')).not.toBeNull()

  await act(async () => (host.querySelector('button[aria-label="New tab"]') as HTMLElement).click())
  await settle()
  expect(asked).toContain('POST /api/browser/tabs {}')
  expect(tabs()).toHaveLength(3)
  // Three is this server's limit: the + says so and does nothing.
  expect(
    (host.querySelector('button[aria-label="At most 3 tabs can be open"]') as HTMLButtonElement).disabled,
  ).toBe(true)

  await act(async () => (host.querySelector('button[aria-label="Close Next page"]') as HTMLElement).click())
  await settle()
  expect(asked).toContain('DELETE /api/browser/tabs/t1')
  expect(tabs()).toEqual(['New tab', 'New tab'])
  await unmount()
})

test('the ⋯ menu changes the viewport and cookies, keeps allowed sites, and asks before clearing', async () => {
  FakeSocket.all = []
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  const state = { tabs: [tab('t1', 'http://localhost:4372/', 'Myrmidon')] }
  const { asked, settings } = serverOf(state)
  const { BrowserView } = await import('../src/client/chat/BrowserView.tsx')
  const { host, unmount } = await mount(
    <MotionConfig reducedMotion="always">
      <BrowserView />
    </MotionConfig>,
  )
  await settle()
  const openMenu = () =>
    act(async () => (host.querySelector('button[aria-label="Browser options"]') as HTMLElement).click())
  const item = (name: string) =>
    [...host.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((el) =>
      el.textContent?.startsWith(name),
    )
  await openMenu()
  const dialog = host.querySelector('[role="dialog"][aria-label="Browser options"]')
  expect(dialog).not.toBeNull()
  for (const name of ['Open in your browser', 'Copy URL', 'Save screenshot', 'Open HTML file…'])
    expect(item(name)?.getAttribute('role')).toBe('menuitem')
  expect(item('Responsive')?.getAttribute('aria-checked')).toBe('true')
  expect(item('Open links in built-in browser')?.getAttribute('role')).toBe('menuitemcheckbox')

  await act(async () => item('Phone')?.click())
  await settle()
  expect(settings.viewport).toBe('phone')
  expect(item('Phone')?.getAttribute('aria-checked')).toBe('true')
  await act(async () => item('Always')?.click())
  await settle()
  expect(asked).toContain('PUT /api/browser/settings {"cookies":"always"}')

  await act(async () => item('Open links in built-in browser')?.click())
  expect(localStorage.getItem('myr-browser-links')).toBe('1')

  // Clearing takes a second, confirming click.
  const clear = () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('browsing data'),
    )
  await act(async () => clear()?.click())
  expect(asked.some((a) => a.startsWith('POST /api/browser/clear'))).toBe(false)
  expect(clear()?.textContent).toBe('Yes, clear browsing data')
  // A click as quick as a double-click's second is not taken as the confirmation.
  await act(async () => await new Promise((r) => setTimeout(r, CONFIRM_ARM_DELAY_MS + 20)))
  await act(async () => clear()?.click())
  await settle()
  expect(asked).toContain('POST /api/browser/clear {}')

  await openMenu()
  await act(async () => item('Manage allowed sites…')?.click())
  const input = host.querySelector('input[aria-label="Port or address on this computer"]') as HTMLInputElement
  expect(input).not.toBeNull()
  // happy-dom's input events do not reach React's change tracking, so the box gets its typing through its handler.
  await act(async () => {
    const props = Object.entries(input).find(([k]) => k.startsWith('__reactProps'))?.[1] as {
      onChange(e: { target: { value: string } }): void
    }
    props.onChange({ target: { value: '5173' } })
  })
  await act(async () => (input.form as HTMLFormElement).requestSubmit())
  await settle()
  expect(asked).toContain('PUT /api/browser/settings {"allowedSites":["5173"]}')
  await unmount()
})

test('a port that is not allowed is refused with an offer to allow it and open it', async () => {
  FakeSocket.all = []
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  const state = { tabs: [tab('t1', 'about:blank', '')] }
  const { asked } = serverOf(state)
  const { BrowserView } = await import('../src/client/chat/BrowserView.tsx')
  const { host, unmount } = await mount(
    <MotionConfig reducedMotion="always">
      <BrowserView open={{ url: 'localhost:3000', at: 1 }} />
    </MotionConfig>,
  )
  await settle()
  const alert = host.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('localhost:3000')
  const allow = [...(alert?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Allow and open')
  await act(async () => allow?.click())
  await settle()
  expect(asked).toContain('PUT /api/browser/settings {"allowedSites":["localhost:3000"]}')
  expect(asked.filter((a) => a === 'POST /api/browser/tabs {"url":"localhost:3000"}')).toHaveLength(2)
  await unmount()
})

test('links in chats open here only when asked, and only where a Browser view takes them', async () => {
  const { openLinkHere, useBrowserLinks, BROWSER_LINKS_KEY } = await import(
    '../src/client/chat/browser-links.ts'
  )
  const { VIEWS } = await import('../src/client/chat/Workspace.tsx')
  expect(VIEWS.find((v) => v.value === 'browser')?.fullOnly).toBe(true)
  const click = () => {
    let prevented = false
    const event = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      currentTarget: { href: 'https://example.com/docs' },
      preventDefault: () => {
        prevented = true
      },
    }
    openLinkHere(event as never)
    return prevented
  }
  localStorage.setItem(BROWSER_LINKS_KEY, '0')
  expect(click()).toBe(false)
  localStorage.setItem(BROWSER_LINKS_KEY, '1')
  // No Browser view (a chats-only device): the link opens as it always did.
  expect(click()).toBe(false)
  const opened: string[] = []
  function Taker() {
    useBrowserLinks(true, (url) => opened.push(url))
    return null
  }
  const { unmount } = await mount(<Taker />)
  expect(click()).toBe(true)
  expect(opened).toEqual(['https://example.com/docs'])
  await unmount()
  localStorage.removeItem(BROWSER_LINKS_KEY)
})

test('the page gets the keyboard with its modifiers, copy comes back out, and a page cannot ask to be allowed', async () => {
  FakeSocket.all = []
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  const state = { tabs: [tab('t1', 'http://localhost:4372/', 'Myrmidon'), tab('t2', 'about:blank', '')] }
  const { asked } = serverOf(state)
  const { BrowserView } = await import('../src/client/chat/BrowserView.tsx')
  const { isMac } = await import('../src/client/ui/platform.ts')
  const { host, unmount } = await mount(
    <MotionConfig reducedMotion="always">
      <BrowserView />
    </MotionConfig>,
  )
  await settle()
  const ws = FakeSocket.all.at(-1) as FakeSocket
  const keys = host.querySelector('textarea[aria-label^="Type into"]') as HTMLTextAreaElement
  // happy-dom's events do not reach React's handlers here (as for typing, see the Explorer's test): they get called.
  const handlers = (el: Element) =>
    Object.entries(el).find(([k]) => k.startsWith('__reactProps'))?.[1] as Record<
      string,
      (e: unknown) => void
    >
  const press = (key: string, init: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}) =>
    act(async () => {
      handlers(keys).onKeyDown?.({
        key,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        ...init,
        getModifierState: () => false,
        nativeEvent: { isComposing: false },
        preventDefault() {},
      })
    })
  const mod = isMac ? { metaKey: true } : { ctrlKey: true }
  const modName = isMac ? 'Meta' : 'Control'
  ws.sent = []
  await press('Tab', { shiftKey: true })
  await press('ArrowLeft', { shiftKey: true })
  await press('a', mod)
  await press('c', mod)
  await press('x', mod)
  await press('😀')
  await press('A', { shiftKey: true })
  // An app shortcut stays the app's: nothing goes to the page.
  await press('j', mod)
  expect(ws.sent).toEqual([
    { type: 'key', key: 'Tab', modifiers: ['Shift'] },
    { type: 'key', key: 'ArrowLeft', modifiers: ['Shift'] },
    { type: 'key', key: 'a', modifiers: [modName] },
    { type: 'copy' },
    { type: 'copy', cut: true },
    { type: 'text', text: '😀' },
    { type: 'text', text: 'A' },
  ])
  // Text an input method composed arrives whole.
  await act(async () => {
    handlers(keys).onCompositionEnd?.({ data: '日本', currentTarget: { value: '日本' } })
  })
  expect(ws.sent.at(-1)).toEqual({ type: 'text', text: '日本' })

  // A page that tried to open a local port is named, and offers nothing to allow.
  await act(async () =>
    ws.push({ type: 'refused', site: 'localhost:8888', from: 'evil.example', local: true }),
  )
  const alert = host.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('evil.example tried to open localhost:8888')
  expect([...(alert?.querySelectorAll('button') ?? [])].map((b) => b.textContent)).toEqual([''])

  // Delete on a focused tab closes it, so a tab that is not shown can be closed from the keyboard too.
  const first = host.querySelector('[data-tab="t1"]') as HTMLButtonElement
  await act(async () => {
    handlers(first.closest('ul') as Element).onKeyDown?.({
      key: 'Delete',
      target: first,
      preventDefault() {},
    })
  })
  await settle()
  expect(asked).toContain('DELETE /api/browser/tabs/t1')
  await unmount()
})
