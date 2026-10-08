import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DiffView, folderIds, folderStartsOpen, groupByFolder } from '../src/client/chat/DiffView.tsx'
import { FOLDER_FOLD_AT } from '../src/client/ui-config.ts'

const cache = Array.from({ length: FOLDER_FOLD_AT + 1 }, (_, i) => ({
  path: `Library/Caches/m${i}.pyc`,
  status: '?',
}))

test('a crowded folder starts folded, unless it holds the file the list opens on', () => {
  const items = [{ path: 'calc.py' }, { path: 'src/a.ts' }, ...cache]
  expect(folderIds(items)).toEqual(['Library', 'src'])
  expect(folderStartsOpen(items, 'src')).toBe(true)
  expect(folderStartsOpen(items, 'Library')).toBe(false)
  expect(folderStartsOpen(items, 'Library', 'Library/Caches/m3.pyc')).toBe(true)
})

test('a diff opened on a file in a crowded folder shows that file', () => {
  const html = (open?: string) =>
    renderToStaticMarkup(<DiffView files={cache} patch="" {...(open ? { open } : {})} />)
  expect(html()).not.toContain('m3.pyc')
  expect(html('Library/Caches/m3.pyc')).toContain('m3.pyc')
})

const files = (...paths: string[]) => paths.map((path) => ({ path }))

test('top-level files come before folders, however the folders sort', () => {
  const groups = groupByFolder(
    files(
      'Library/Caches/com.apple.python/a.pyc',
      'Library/Caches/com.apple.python/b.pyc',
      'test_calc.py',
      'calc.py',
    ),
  )
  expect(groups.map((g) => g.folder)).toEqual(['', 'Library'])
  expect(groups[0]?.items.map((f) => f.path)).toEqual(['calc.py', 'test_calc.py'])
  expect(groups[1]?.items).toHaveLength(2)
})

test('folders and their files sort by name, ignoring case and reading numbers as numbers', () => {
  const groups = groupByFolder(files('src/b.ts', 'Docs/x.md', 'src/file10.ts', 'src/file2.ts', 'src/A.ts'))
  expect(groups.map((g) => g.folder)).toEqual(['Docs', 'src'])
  expect(groups[1]?.items.map((f) => f.path)).toEqual([
    'src/A.ts',
    'src/b.ts',
    'src/file2.ts',
    'src/file10.ts',
  ])
})
