/**
 * The page side of the shell: a script WebKit runs in the window's main frame before the page's own, and the
 * messages it exchanges with the main process.
 *
 * The page asks through Electrobun's `__electrobunSendToHost` (a `host-message` event in the main process) and the
 * main process answers by running `__myrmidonDesktopReply(...)` in the page. Electrobun gives that send function to
 * every frame, agent-built previews in iframes included, so each request carries a secret only this script holds:
 * it runs in the main frame alone, and only on the shell's own Myrmidon.
 */
import { DESKTOP_SHORTCUT_EVENT } from '../../web/src/client/ui/desktop.ts'

/** One request per method of the page's DesktopBridge, with its arguments. */
export type Request =
  | { id: number; method: 'pickFolder' }
  | { id: number; method: 'reveal'; path: string }
  | { id: number; method: 'notify'; title: string; body: string }
  | { id: number; method: 'setBadge'; count: number }
  | { id: number; method: 'computerControl'; active: boolean }

const CHANNEL = 'myrmidon-desktop'

/** The script for BrowserWindow's `preload`: marks the page as the desktop shell and defines window.myrmidonDesktop. */
export function preloadScript(options: { origin: string; secret: string; titlebarInsetPx: number }): string {
  const config = JSON.stringify({ ...options, channel: CHANNEL })
  return `(() => {
  const config = ${config}
  if (location.origin !== config.origin) return
  const root = document.documentElement
  root.dataset.shell = 'desktop'
  root.style.setProperty('--titlebar-inset', config.titlebarInsetPx + 'px')
  const pending = new Map()
  let next = 0
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++next
      pending.set(id, { resolve, reject })
      window.__electrobunSendToHost({ channel: config.channel, secret: config.secret, id, method, ...params })
    })
  Object.defineProperty(window, '__myrmidonDesktopReply', {
    value: (id, ok, value) => {
      const waiting = pending.get(id)
      if (!waiting) return
      pending.delete(id)
      if (ok) waiting.resolve(value)
      else waiting.reject(new Error(String(value)))
    },
  })
  Object.defineProperty(window, 'myrmidonDesktop', {
    value: Object.freeze({
      pickFolder: () => call('pickFolder', {}),
      reveal: (path) => call('reveal', { path }),
      notify: (title, body) => call('notify', { title, body }),
      setBadge: (count) => call('setBadge', { count }),
      computerControl: (active) => call('computerControl', { active }),
    }),
  })
})()`
}

/** A host message from the page, if it is a well-formed request carrying the secret. */
export function parseRequest(detail: unknown, secret: string): Request | undefined {
  if (!detail || typeof detail !== 'object') return undefined
  const m = detail as Record<string, unknown>
  if (m.channel !== CHANNEL || m.secret !== secret || typeof m.id !== 'number') return undefined
  const id = m.id
  switch (m.method) {
    case 'pickFolder':
      return { id, method: 'pickFolder' }
    case 'reveal':
      return typeof m.path === 'string' && m.path ? { id, method: 'reveal', path: m.path } : undefined
    case 'notify':
      return typeof m.title === 'string' && typeof m.body === 'string'
        ? { id, method: 'notify', title: m.title, body: m.body }
        : undefined
    case 'setBadge':
      return typeof m.count === 'number' && Number.isInteger(m.count) && m.count >= 0
        ? { id, method: 'setBadge', count: m.count }
        : undefined
    case 'computerControl':
      return typeof m.active === 'boolean' ? { id, method: 'computerControl', active: m.active } : undefined
    default:
      return undefined
  }
}

/** Settles request `id` in the page. */
export function replyScript(
  id: number,
  result: { ok: true; value?: unknown } | { ok: false; error: string },
): string {
  const value = result.ok ? (result.value ?? null) : result.error
  return `window.__myrmidonDesktopReply?.(${JSON.stringify(id)}, ${JSON.stringify(result.ok)}, ${JSON.stringify(value)})`
}

/** Sets the toolbar's room for the window buttons, on the dashboard only (the page the preload marked). */
export function insetScript(px: number): string {
  return `(() => { const root = document.documentElement; if (root.dataset.shell === 'desktop') root.style.setProperty('--titlebar-inset', ${JSON.stringify(`${px}px`)}) })()`
}

/** Runs the page's handler for a shortcut (`mod+n`), as an app-menu item does. */
export function shortcutScript(combo: string): string {
  return `window.dispatchEvent(new CustomEvent(${JSON.stringify(DESKTOP_SHORTCUT_EVENT)}, { detail: ${JSON.stringify(combo)} }))`
}

/** The Dock badge for a count of chats that need the person: none at 0. */
export const badgeLabel = (count: number): string | undefined => (count > 0 ? String(count) : undefined)
