import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CommandPalette, matchScore, type PaletteItem, rankPalette } from '../src/client/CommandPalette.tsx'
import { stepChat } from '../src/client/chat/chat-order.ts'
import { SHORTCUT_GROUPS, shortcutLabel } from '../src/client/ui/ShortcutList.tsx'

const item = (id: string, group: PaletteItem['group'], label: string, keywords?: string): PaletteItem => ({
  id,
  group,
  label,
  icon: null,
  ...(keywords ? { keywords } : {}),
  run() {},
})

test('a query matches the start of the label best, then a word in it, then anywhere, then its letters in order', () => {
  expect(matchScore('new chat', 'new')).toBeGreaterThan(matchScore('open a new chat', 'new') ?? -1)
  expect(matchScore('open a new chat', 'new')).toBeGreaterThan(matchScore('renew', 'new') ?? -1)
  expect(matchScore('renew', 'new')).toBeGreaterThan(matchScore('new chat', 'nwc') ?? -1)
  expect(matchScore('new chat', 'nwc')).toBe(1)
  expect(matchScore('settings', 'xyz')).toBeUndefined()
})

test('the command menu lists groups in order, best match first, and leaves out what does not match', () => {
  const items = [
    item('s1', 'settings', 'Models'),
    item('c1', 'chats', 'Fix the login bug'),
    item('c2', 'chats', 'Login page copy'),
    item('a1', 'actions', 'New chat'),
    item('c3', 'chats', 'Weekly report', 'the login numbers'),
  ]
  expect(rankPalette(items, 'login').map((i) => i.id)).toEqual(['c2', 'c1', 'c3'])
  // With nothing typed it offers actions and recent chats, not every Settings page.
  expect(rankPalette(items, '').map((i) => i.id)).toEqual(['a1', 'c1', 'c2', 'c3'])
})

test('the command menu is a dialog whose field drives a list box', () => {
  const html = renderToStaticMarkup(
    <CommandPalette items={[item('a1', 'actions', 'New chat')]} onClose={() => {}} />,
  )
  expect(html).toContain('role="dialog"')
  expect(html).toContain('role="combobox"')
  expect(html).toContain('role="listbox"')
  expect(html).toContain('role="option"')
  expect(html).toContain('aria-selected="true"')
  expect(html).toMatch(/aria-activedescendant="[^"]+"/)
})

test('the previous and next chat wrap around the sidebar order', () => {
  const order = ['a', 'b', 'c']
  expect(stepChat(order, 'b', 1)).toBe('c')
  expect(stepChat(order, 'c', 1)).toBe('a')
  expect(stepChat(order, 'a', -1)).toBe('c')
  expect(stepChat(order, undefined, 1)).toBe('a')
  expect(stepChat(order, 'gone', -1)).toBe('c')
  expect(stepChat([], 'a', 1)).toBeUndefined()
})

test('the shortcut list writes each shortcut for the platform, runs of keys included', () => {
  expect(shortcutLabel({ combo: 'mod+1', through: '9' }, true)).toBe('⌘1–9')
  expect(shortcutLabel({ combo: 'mod+1', through: '9' }, false)).toBe('Ctrl+1–9')
  const combos = SHORTCUT_GROUPS.flatMap((g) => g.items.map((s) => s.combo))
  expect(combos).toContain('mod+k')
  expect(combos).toContain('mod+/')
  expect(new Set(combos).size).toBe(combos.length)
})
