/**
 * The Dock icon's badge. Electrobun has no API for it, so this sets `NSApp.dockTile.badgeLabel` through the
 * Objective-C runtime with bun:ffi (the main process runs on Bun). The main process is not on the main thread, and
 * AppKit must be, so the setter is queued there with performSelectorOnMainThread, which keeps the label alive until
 * it runs. Only macOS has the runtime, so it is loaded on the first badge there and never on Linux or Windows.
 */
import { dlopen, FFIType, type Pointer } from 'bun:ffi'
import type { Platform } from './platform.ts'

/** An Objective-C object, class or selector. */
type Id = Pointer | bigint | null

const LIBOBJC = '/usr/lib/libobjc.A.dylib'

function loadObjc() {
  const { ptr, bool, cstring } = FFIType
  const runtime = dlopen(LIBOBJC, {
    objc_getClass: { args: [cstring], returns: ptr },
    sel_registerName: { args: [cstring], returns: ptr },
  }).symbols

  // objc_msgSend takes whatever the method takes; each shape needs its own binding to call it correctly on arm64.
  const msgSend = <const Args extends readonly FFIType[]>(args: Args, returns: FFIType) =>
    dlopen(LIBOBJC, { objc_msgSend: { args: [ptr, ptr, ...args], returns } }).symbols.objc_msgSend

  return {
    send0: msgSend([], ptr) as (target: Id, sel: Id) => Id,
    sendString: msgSend([ptr], ptr) as (target: Id, sel: Id, bytes: Uint8Array) => Id,
    sendOnMain: msgSend([ptr, ptr, bool], FFIType.void) as (
      target: Id,
      sel: Id,
      action: Id,
      arg: Id,
      wait: boolean,
    ) => void,
    sel: (name: string) => runtime.sel_registerName(cString(name)),
    cls: (name: string) => runtime.objc_getClass(cString(name)),
  }
}

const cString = (text: string) => new TextEncoder().encode(`${text}\0`)
let objc: ReturnType<typeof loadObjc> | undefined

/** Shows `label` on the Dock icon, or clears the badge for undefined. Elsewhere there is no Dock: it does nothing. */
export function setDockBadge(label: string | undefined, platform: Platform = process.platform as Platform) {
  if (platform !== 'darwin') return
  objc ??= loadObjc()
  const { send0, sendString, sendOnMain, sel, cls } = objc
  const app = send0(cls('NSApplication'), sel('sharedApplication'))
  const tile = send0(app, sel('dockTile'))
  const text =
    label === undefined
      ? null
      : sendString(send0(cls('NSString'), sel('alloc')), sel('initWithUTF8String:'), cString(label))
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
