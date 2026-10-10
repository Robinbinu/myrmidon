/**
 * Calls into AppKit through the Objective-C runtime with bun:ffi, for what Electrobun has no API for (the Dock badge,
 * a screen overlay's window). The main process is not on the main thread and AppKit must be, so changes are queued
 * there with performSelectorOnMainThread, which takes one object: setters that take numbers go through
 * key-value coding (`setValuesForKeysWithDictionary:`), which unboxes them. Only macOS has the runtime, so it loads on
 * first use there and never on Linux or Windows.
 */
import { dlopen, FFIType, type Pointer } from 'bun:ffi'

/** An Objective-C object, class or selector. */
export type Id = Pointer | bigint | null

const LIBOBJC = '/usr/lib/libobjc.A.dylib'

function load() {
  const { ptr, bool, cstring, i64 } = FFIType
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
    send2: msgSend([ptr, ptr], ptr) as (target: Id, sel: Id, a: Id, b: Id) => Id,
    sendInt: msgSend([i64], ptr) as (target: Id, sel: Id, n: bigint) => Id,
    sendBool: msgSend([bool], ptr) as (target: Id, sel: Id, b: boolean) => Id,
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
let objc: ReturnType<typeof load> | undefined

export function objcRuntime() {
  objc ??= load()
  return objc
}

/** An NSString, owned by the caller (+1). */
export function nsString(text: string): Id {
  const { send0, sendString, sel, cls } = objcRuntime()
  return sendString(send0(cls('NSString'), sel('alloc')), sel('initWithUTF8String:'), cString(text))
}
