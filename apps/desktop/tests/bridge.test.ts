import { expect, test } from 'bun:test'
import type { DesktopBridge } from '../../web/src/client/ui/desktop.ts'
import { badgeLabel, parseRequest, preloadScript, replyScript, shortcutScript } from '../src/bridge.ts'

const ORIGIN = 'http://127.0.0.1:4318'
const SECRET = 'secret-1'

interface Page {
  root: { dataset: Record<string, string>; style: Record<string, string> }
  sent: unknown[]
  window: Record<string, unknown>
}

/** Runs the preload as WebKit would at document start, in a page at `origin`. */
function load(origin: string): Page {
  const sent: unknown[] = []
  const style: Record<string, string> = {}
  const root = {
    dataset: {} as Record<string, string>,
    style: Object.assign(style, {
      setProperty: (k: string, v: string) => {
        style[k] = v
      },
    }),
  }
  const window: Record<string, unknown> = { __electrobunSendToHost: (m: unknown) => sent.push(m) }
  const script = preloadScript({ origin: ORIGIN, secret: SECRET, titlebarInsetPx: 78 })
  new Function('window', 'document', 'location', script)(window, { documentElement: root }, { origin })
  return { root, sent, window }
}

/** Runs a script the main process sends into the page. */
const evaluate = (page: Page, script: string) => new Function('window', script)(page.window)

test('on its own Myrmidon the page is marked as the desktop shell, with room for the traffic lights', () => {
  const page = load(ORIGIN)
  expect(page.root.dataset.shell).toBe('desktop')
  expect(page.root.style['--titlebar-inset']).toBe('78px')
  expect(typeof page.window.myrmidonDesktop).toBe('object')
})

test('any other page in the window gets neither the bridge nor the marks', () => {
  const page = load('https://example.com')
  expect(page.root.dataset.shell).toBeUndefined()
  expect(page.window.myrmidonDesktop).toBeUndefined()
})

test('a bridge call reaches the main process with the secret and settles with its reply', async () => {
  const page = load(ORIGIN)
  const bridge = page.window.myrmidonDesktop as DesktopBridge
  const picked = bridge.pickFolder()
  const request = parseRequest(page.sent[0], SECRET)
  expect(request).toEqual({ id: 1, method: 'pickFolder' })
  evaluate(page, replyScript(1, { ok: true, value: '/Users/me/work' }))
  expect(await picked).toBe('/Users/me/work')

  const revealed = bridge.reveal('/nope')
  evaluate(page, replyScript(2, { ok: false, error: 'Error: gone' }))
  await expect(revealed).rejects.toThrow('Error: gone')
})

test('requests without the secret, or with bad arguments, are ignored', () => {
  const ok = { channel: 'myrmidon-desktop', secret: SECRET, id: 3 }
  expect(parseRequest({ ...ok, secret: 'guess', method: 'pickFolder' }, SECRET)).toBeUndefined()
  expect(parseRequest({ ...ok, method: 'rmrf' }, SECRET)).toBeUndefined()
  expect(parseRequest({ ...ok, method: 'reveal', path: '' }, SECRET)).toBeUndefined()
  expect(parseRequest({ ...ok, method: 'setBadge', count: -1 }, SECRET)).toBeUndefined()
  expect(parseRequest({ ...ok, method: 'setBadge', count: 1.5 }, SECRET)).toBeUndefined()
  expect(parseRequest({ ...ok, method: 'notify', title: 'x' }, SECRET)).toBeUndefined()
  expect(parseRequest('hello', SECRET)).toBeUndefined()
  expect(parseRequest({ ...ok, method: 'notify', title: 'Done', body: 'Run finished' }, SECRET)).toEqual({
    id: 3,
    method: 'notify',
    title: 'Done',
    body: 'Run finished',
  })
})

test('a menu item becomes the shortcut event the page listens for', () => {
  const events: { type: string; detail: unknown }[] = []
  const window = { dispatchEvent: (e: CustomEvent) => events.push({ type: e.type, detail: e.detail }) }
  new Function('window', shortcutScript('mod+,'))(window)
  expect(events).toEqual([{ type: 'myrmidon:shortcut', detail: 'mod+,' }])
})

test('the Dock shows the count of chats that need the person, and nothing at zero', () => {
  expect(badgeLabel(0)).toBeUndefined()
  expect(badgeLabel(4)).toBe('4')
})
