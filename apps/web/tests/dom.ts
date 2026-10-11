import { afterAll, beforeAll } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
// Motion notes as it loads whether there is a page and whose requestAnimationFrame to use. Loaded first inside one
// file's page, it goes on scheduling on that page once it is gone, and no later file's animation ever ends; loaded
// here, before any page, it is the same Motion whichever file the run starts with.
import 'motion/react'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

const flags = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

/**
 * Gives the calling test file a browser page (happy-dom) for its own tests only. Bun runs every test file in one
 * process and the rest of the suite expects no `window` or `document`, so the page goes up before this file's first
 * test and comes down after its last. Statically imported modules load before it, as they do in every other file;
 * import one that reads the page as it loads from inside a test instead.
 */
export function withDom() {
  beforeAll(() => {
    GlobalRegistrator.register({ url: 'http://localhost/' })
    // Tells React it runs under a test, else it warns that act() is not supported here.
    flags.IS_REACT_ACT_ENVIRONMENT = true
  })
  afterAll(async () => {
    delete flags.IS_REACT_ACT_ENVIRONMENT
    await GlobalRegistrator.unregister()
  })
}

/** Renders `ui` into a fresh element on the page, with its effects run. */
export async function mount(ui: ReactNode) {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  await act(async () => root.render(ui))
  return {
    host,
    async unmount() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

/** Presses `key` on whatever has focus, the way a browser delivers it: bubbling up to the window. */
export async function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}
