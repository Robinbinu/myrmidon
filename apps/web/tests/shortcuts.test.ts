import { expect, test } from 'bun:test'
import { comboLabel, matchCombo } from '../src/client/ui/shortcuts.ts'

const key = (
  k: string,
  code: string,
  mods: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>> = {},
) => ({
  key: k,
  code,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
})

test('mod means Command or Control, and Shift makes a different shortcut for letters', () => {
  expect(matchCombo('mod+k', key('k', 'KeyK', { meta: true }))).toBe(true)
  expect(matchCombo('mod+k', key('k', 'KeyK', { ctrl: true }))).toBe(true)
  expect(matchCombo('mod+k', key('k', 'KeyK'))).toBe(false)
  expect(matchCombo('mod+n', key('N', 'KeyN', { meta: true, shift: true }))).toBe(false)
  expect(matchCombo('escape', key('Escape', 'Escape'))).toBe(true)
})

test('shifted and optioned shortcuts match the physical key', () => {
  // ⇧⌘[ types "{" on a US layout; ⌥⌘N types "˜" on a Mac.
  expect(matchCombo('mod+shift+[', key('{', 'BracketLeft', { meta: true, shift: true }))).toBe(true)
  expect(matchCombo('mod+shift+[', key('[', 'BracketLeft', { meta: true }))).toBe(false)
  expect(matchCombo('mod+alt+n', key('˜', 'KeyN', { meta: true, alt: true }))).toBe(true)
  expect(matchCombo('mod+n', key('˜', 'KeyN', { meta: true, alt: true }))).toBe(false)
})

test('a symbol that needs Shift on some layouts still matches', () => {
  // German layout: "/" is Shift+7.
  expect(matchCombo('/', key('/', 'Digit7', { shift: true }))).toBe(true)
  expect(matchCombo('/', key('/', 'Slash'))).toBe(true)
  expect(matchCombo('/', key('?', 'Slash', { shift: true }))).toBe(false)
})

test('labels follow the platform', () => {
  expect(comboLabel('mod+n', true)).toBe('⌘N')
  expect(comboLabel('mod+shift+[', true)).toBe('⇧⌘[')
  expect(comboLabel('mod+alt+n', true)).toBe('⌥⌘N')
  expect(comboLabel('mod+shift+[', false)).toBe('Ctrl+Shift+[')
  expect(comboLabel('escape', true)).toBe('Esc')
  expect(comboLabel('mod+,', false)).toBe('Ctrl+,')
})
