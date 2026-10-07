import { expect, test } from 'bun:test'
import { clampWidth, dragWidth, readWidth } from '../src/client/ui/split.ts'

test('widths stay within their limits and are whole pixels', () => {
  expect(clampWidth(100, 220, 360)).toBe(220)
  expect(clampWidth(500, 220, 360)).toBe(360)
  expect(clampWidth(250.6, 220, 360)).toBe(251)
})

test('a left pane grows as its divider moves right, a right pane as it moves left', () => {
  expect(dragWidth(260, 40, 'left', 220, 360)).toBe(300)
  expect(dragWidth(440, 40, 'right', 320, 640)).toBe(400)
  expect(dragWidth(440, -400, 'right', 320, 640)).toBe(640)
})

test('a stored width is used only when it is a number', () => {
  expect(readWidth('300', 260, 220, 360)).toBe(300)
  expect(readWidth('9000', 260, 220, 360)).toBe(360)
  expect(readWidth(null, 260, 220, 360)).toBe(260)
  expect(readWidth('wide', 260, 220, 360)).toBe(260)
  expect(readWidth('', 260, 220, 360)).toBe(260)
})
