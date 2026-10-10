import { type MouseEvent, useEffect, useRef } from 'react'
import { readStored } from '../ui/hooks.ts'

/** Whether links in chats open in the built-in browser (⋯ › Open links in built-in browser); kept in this browser. */
export const BROWSER_LINKS_KEY = 'myr-browser-links'
/** Asks the Browser view to open a URL in a new tab; whoever takes it cancels the event. */
const OPEN_IN_BROWSER = 'myr:open-in-browser'

/**
 * A plain click on a link in a chat: with the setting on, it opens in the built-in browser instead of a new browser
 * tab, when a Browser view is there to take it (a chats-only device has none, and its links open as before).
 */
export function openLinkHere(e: MouseEvent<HTMLAnchorElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  if (readStored<string>(BROWSER_LINKS_KEY, '0') !== '1') return
  const url = e.currentTarget.href
  if (!/^https?:/i.test(url)) return
  const event = new CustomEvent(OPEN_IN_BROWSER, { detail: { url }, cancelable: true })
  if (!window.dispatchEvent(event)) e.preventDefault()
}

/** Takes links opened with `openLinkHere` while `enabled`. */
export function useBrowserLinks(enabled: boolean, open: (url: string) => void) {
  const latest = useRef(open)
  latest.current = open
  useEffect(() => {
    if (!enabled) return
    const take = (e: Event) => {
      e.preventDefault()
      latest.current((e as CustomEvent<{ url: string }>).detail.url)
    }
    window.addEventListener(OPEN_IN_BROWSER, take)
    return () => window.removeEventListener(OPEN_IN_BROWSER, take)
  }, [enabled])
}
