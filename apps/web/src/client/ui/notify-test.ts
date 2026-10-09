import { desktop } from './desktop.ts'

/**
 * How a test notification went. `waiting`: the desktop app is in front, and macOS does not show the notifications
 * of the app in front (its shell has no foreground presentation), so the test goes out as Myrmidon goes to the
 * background. `cancelled`: the screen that asked for it closed first.
 */
export type TestNotice =
  | { state: 'sent'; desktop: boolean }
  | { state: 'waiting' }
  | { state: 'blocked' }
  | { state: 'unsupported' }
  | { state: 'failed'; error: string }
  | { state: 'cancelled' }

/** Resolves once the window is in the background: blurred or hidden. */
function background(signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (left: boolean) => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onBlur)
      signal?.removeEventListener('abort', onAbort)
      resolve(left)
    }
    const onBlur = () => {
      if (!document.hasFocus() || document.hidden) done(true)
    }
    const onAbort = () => done(false)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onBlur)
    signal?.addEventListener('abort', onAbort)
  })
}

/**
 * Sends one notification because the person asked for it. Unlike a chat's (App.tsx `notify`), it does not depend on
 * Settings' switch, and in a browser it shows even while Myrmidon is in front.
 */
export async function testNotification(
  title: string,
  body: string,
  options: { signal?: AbortSignal; onWaiting?(): void } = {},
): Promise<TestNotice> {
  const shell = desktop()
  if (shell) {
    if (document.hasFocus()) {
      options.onWaiting?.()
      if (!(await background(options.signal))) return { state: 'cancelled' }
    }
    try {
      await shell.notify(title, body)
      return { state: 'sent', desktop: true }
    } catch (err) {
      return { state: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  }
  if (typeof Notification === 'undefined') return { state: 'unsupported' }
  let permission = Notification.permission
  if (permission === 'default') permission = await Notification.requestPermission()
  if (options.signal?.aborted) return { state: 'cancelled' }
  if (permission !== 'granted') return { state: 'blocked' }
  try {
    // No tag: a second test tagged like the first would quietly replace it in the list, with no banner at all.
    new Notification(title, { body })
    return { state: 'sent', desktop: false }
  } catch {
    // Chrome on Android shows notifications only from a service worker, which Myrmidon does not have.
    return { state: 'unsupported' }
  }
}
