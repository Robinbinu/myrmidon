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
  // AltGr on Windows arrives as Ctrl+Alt but types a character: AltGr+7 is "{" on a German layout.
  const altGr = {
    ...key('{', 'Digit7', { ctrl: true, alt: true }),
    getModifierState: (k: string) => k === 'AltGraph',
  }
  expect(matchCombo('mod+alt+7', altGr)).toBe(false)
  expect(matchCombo('mod+alt+7', key('7', 'Digit7', { ctrl: true, alt: true }))).toBe(true)
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
  expect(comboLabel('shift+enter', true)).toBe('⇧↩')
  expect(comboLabel('shift+enter', false)).toBe('Shift+Enter')
})

test('ctrl means the Control key on every platform, never Command', () => {
  expect(matchCombo('ctrl+tab', key('Tab', 'Tab', { ctrl: true }))).toBe(true)
  expect(matchCombo('ctrl+tab', key('Tab', 'Tab', { meta: true }))).toBe(false)
  expect(matchCombo('ctrl+shift+tab', key('Tab', 'Tab', { ctrl: true, shift: true }))).toBe(true)
  expect(matchCombo('ctrl+tab', key('Tab', 'Tab', { ctrl: true, shift: true }))).toBe(false)
  expect(matchCombo('ctrl+shift+t', key('T', 'KeyT', { ctrl: true, shift: true }))).toBe(true)
  expect(comboLabel('ctrl+shift+tab', true)).toBe('⌃⇧⇥')
  expect(comboLabel('ctrl+tab', false)).toBe('Ctrl+Tab')
})
