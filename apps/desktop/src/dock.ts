/**
 * The Dock icon's badge. Electrobun has no API for it, so this sets `NSApp.dockTile.badgeLabel` through the
 * Objective-C runtime with bun:ffi (the main process runs on Bun). The main process is not on the main thread, and
 * AppKit must be, so the setter is queued there with performSelectorOnMainThread, which keeps the label alive until
 * it runs. Only macOS has the runtime, so it is loaded on the first badge there and never on Linux or Windows.
 */
import { nsString, objcRuntime } from './objc.ts'
import type { Platform } from './platform.ts'

/** Shows `label` on the Dock icon, or clears the badge for undefined. Elsewhere there is no Dock: it does nothing. */
export function setDockBadge(label: string | undefined, platform: Platform = process.platform as Platform) {
  if (platform !== 'darwin') return
  const { send0, sendOnMain, sel, cls } = objcRuntime()
  const app = send0(cls('NSApplication'), sel('sharedApplication'))
  const tile = send0(app, sel('dockTile'))
  const text = label === undefined ? null : nsString(label)
  sendOnMain(
    tile,
    sel('performSelectorOnMainThread:withObject:waitUntilDone:'),
    sel('setBadgeLabel:'),
    text,
    false,
  )
  // The queued call holds its own reference to the label.
  if (text) send0(text, sel('release'))
}
