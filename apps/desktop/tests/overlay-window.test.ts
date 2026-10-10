import { expect, test } from 'bun:test'
import { overlayWindowValues, prepareOverlayWindow } from '../src/overlay-window.ts'

test('the overlay sits above the menu bar, on every Space, and lets clicks through', () => {
  // NSMainMenuWindowLevel is 24 and NSStatusWindowLevel 25.
  expect(overlayWindowValues.level).toBeGreaterThan(25)
  const behavior = overlayWindowValues.collectionBehavior
  expect(behavior & (1 << 0)).toBeTruthy() // canJoinAllSpaces: never a Space of its own
  expect(behavior & (1 << 8)).toBeTruthy() // fullScreenAuxiliary: beside a full-screen window
  expect(behavior & ((1 << 7) | (1 << 9))).toBe(0) // neither full-screen primary nor none
  expect(overlayWindowValues.ignoresMouseEvents).toBe(true)
})

test('only macOS changes the window natively; elsewhere Electrobun keeps it on top', () => {
  expect(prepareOverlayWindow(1n, 1n, 'linux')).toBe(false)
  expect(prepareOverlayWindow(1n, 1n, 'win32')).toBe(false)
  expect(prepareOverlayWindow(null, 1n, 'darwin')).toBe(false)
})
