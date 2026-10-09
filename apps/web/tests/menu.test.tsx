import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  arrangeMenu,
  copyAction,
  type MenuAction,
  MenuRows,
  menuPosition,
  openContextMenu,
} from '../src/client/ui/Menu.tsx'

const item = (label: string, extra: Partial<MenuAction> = {}): MenuAction => ({ label, run() {}, ...extra })

test('a menu drops what does not apply and puts destructive commands last, behind a separator', () => {
  const del = item('Delete', { destructive: true })
  const labels = (entries: ReturnType<typeof arrangeMenu>) =>
    entries.map((e) => (e === 'separator' ? '—' : e.label))
  expect(labels(arrangeMenu([del, item('Rename'), false, undefined, item('Export')]))).toEqual([
    'Rename',
    'Export',
    '—',
    'Delete',
  ])
  // No separator at either end or two in a row, whatever the caller left out.
  expect(labels(arrangeMenu(['separator', item('Copy'), 'separator', false, 'separator']))).toEqual(['Copy'])
  expect(labels(arrangeMenu([del]))).toEqual(['Delete'])
  expect(arrangeMenu([false, 'separator'])).toEqual([])
})

test('a context menu opens below and right of the pointer, flipping and clamping at the window edges', () => {
  const size = { width: 200, height: 120 }
  const view = { width: 1000, height: 700 }
  expect(menuPosition({ x: 100, y: 100 }, size, view)).toEqual({ left: 100, top: 100 })
  // Near the right and bottom edges it opens to the left and above.
  expect(menuPosition({ x: 950, y: 650 }, size, view)).toEqual({ left: 750, top: 530 })
  // A menu taller than the room above and below stays inside the window.
  expect(menuPosition({ x: 10, y: 60 }, { width: 200, height: 690 }, view)).toEqual({ left: 10, top: 8 })
})

test('menu rows are menu items reached by the arrow keys, with shortcut hints and red destructive rows', () => {
  const html = renderToStaticMarkup(
    <MenuRows
      entries={[item('New task', { combo: 'mod+n' }), 'separator', item('Delete', { destructive: true })]}
      onClose={() => {}}
    />,
  )
  expect(html.match(/role="menuitem"/g)).toHaveLength(2)
  expect(html).toContain('tabindex="-1"')
  expect(html).toContain('aria-keyshortcuts=')
  expect(html).toContain('<hr')
  expect(html).toContain('text-bad-ink')
  expect(html).toContain('h-[22px]')
})

test('with no menu host on screen a right-click is left alone, and a copy entry copies what it was given', () => {
  let prevented = false
  const event = { preventDefault: () => (prevented = true) } as never
  openContextMenu(event, 'Chat', [item('Rename')])
  expect(prevented).toBe(false)
  const entry = copyAction('Copy link', 'http://localhost/?chat=a')
  expect(entry.label).toBe('Copy link')
  expect(entry.icon).toBeDefined()
})
