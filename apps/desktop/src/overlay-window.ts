/**
 * macOS: what makes a computer-use overlay window sit over the whole screen on every Space. Electrobun's always-on-top
 * is the floating level, under the menu bar, and a window it shows belongs to the one Space it opened on: from a
 * full-screen app, that is a Space of its own, so the see-through window shows black round the glow. So the window is
 * set up through the Objective-C runtime (src/objc.ts) before it is first shown, as key-value settings run on the
 * main thread.
 */
import { type Id, nsString, objcRuntime } from './objc.ts'
import type { Platform } from './platform.ts'

/** NSWindowCollectionBehavior: every Space, beside full-screen windows too, left alone by Mission Control and Cmd-`. */
const CAN_JOIN_ALL_SPACES = 1 << 0
const STATIONARY = 1 << 4
const IGNORES_CYCLE = 1 << 6
const FULL_SCREEN_AUXILIARY = 1 << 8

/** NSPopUpMenuWindowLevel: above the menu bar (24), its status items (25) and the Dock (20). */
const POP_UP_MENU_LEVEL = 101

/** The overlay window's settings, by their key-value names on NSWindow. */
export const overlayWindowValues = {
  level: POP_UP_MENU_LEVEL,
  collectionBehavior: CAN_JOIN_ALL_SPACES | STATIONARY | IGNORES_CYCLE | FULL_SCREEN_AUXILIARY,
  ignoresMouseEvents: true,
  hasShadow: false,
} as const

/**
 * The overlay's WKWebView: it keeps painting when macOS calls the window covered, which it may for a window that
 * takes no clicks.
 */
export const overlayWebViewValues = { windowOcclusionDetectionEnabled: false } as const

/**
 * Sets up `window` (a hidden BrowserWindow's `ptr`) and its webview (the BrowserView's `ptr`, Electrobun's
 * WKWebViewImpl) to be shown as the overlay, and returns once that is done, so the caller shows it after. Elsewhere it
 * does nothing and says so: Linux and Windows use Electrobun's always-on-top.
 */
export function prepareOverlayWindow(
  window: Id,
  webview: Id,
  platform: Platform = process.platform as Platform,
) {
  if (platform !== 'darwin' || !window || !webview) return false
  const { send0, sel } = objcRuntime()
  apply(window, overlayWindowValues)
  apply(send0(webview, sel('webView')), overlayWebViewValues)
  return true
}

function apply(target: Id, values: Record<string, number | boolean>) {
  const { send0, send2, sendInt, sendBool, sendOnMain, sel, cls } = objcRuntime()
  const dict = send0(send0(cls('NSMutableDictionary'), sel('alloc')), sel('init'))
  for (const [name, value] of Object.entries(values)) {
    // Owned (+1) objects, released once the dictionary holds them: Bun's thread has no autorelease pool.
    const blank = send0(cls('NSNumber'), sel('alloc'))
    const number =
      typeof value === 'boolean'
        ? sendBool(blank, sel('initWithBool:'), value)
        : sendInt(blank, sel('initWithLongLong:'), BigInt(value))
    const key = nsString(name)
    send2(dict, sel('setObject:forKey:'), number, key)
    send0(key, sel('release'))
    send0(number, sel('release'))
  }
  // Waits, so the window is set up before Electrobun shows it.
  sendOnMain(
    target,
    sel('performSelectorOnMainThread:withObject:waitUntilDone:'),
    sel('setValuesForKeysWithDictionary:'),
    dict,
    true,
  )
  send0(dict, sel('release'))
}
