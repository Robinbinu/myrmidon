/**
 * Where the app runs and the document-level behavior that makes it feel like a desktop app rather than a page.
 * The desktop shell sets `data-shell` itself before the page loads; in a browser it is `browser`.
 */

export type Platform = 'mac' | 'windows' | 'linux' | 'other'

export function detectPlatform(userAgent: string): Platform {
  if (/Mac|iPhone|iPad/.test(userAgent)) return 'mac'
  if (/Windows/.test(userAgent)) return 'windows'
  if (/Linux|X11|CrOS/.test(userAgent)) return 'linux'
  return 'other'
}

export const isMac = typeof navigator !== 'undefined' && detectPlatform(navigator.userAgent) === 'mac'

const EDITABLE = 'input, textarea, [contenteditable="true"], [contenteditable=""]'

/** Whether the browser's own menu should open: in text fields and over selected text (spell check, Copy). */
export function keepsBrowserMenu(
  target: { closest(selector: string): unknown } | null,
  selection: string,
): boolean {
  if (selection.trim()) return true
  return !!target?.closest(EDITABLE)
}

export function installNativeBehavior() {
  const root = document.documentElement
  root.dataset.platform = detectPlatform(navigator.userAgent)
  root.dataset.shell ??= 'browser'
  const active = (on: boolean) => {
    root.dataset.windowActive = String(on)
  }
  active(document.hasFocus())
  window.addEventListener('focus', () => active(true))
  window.addEventListener('blur', () => active(false))
  // App menus call preventDefault themselves; anything left over on chrome gets no browser menu.
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return
    const target = e.target instanceof Element ? e.target : null
    if (!keepsBrowserMenu(target, window.getSelection()?.toString() ?? '')) e.preventDefault()
  })
  // Native apps do not drag ghost copies of their images and links; elements meant to be dragged opt in.
  document.addEventListener('dragstart', (e) => {
    const target = e.target instanceof Element ? e.target : null
    if (!target?.closest('[draggable="true"]')) e.preventDefault()
  })
}
