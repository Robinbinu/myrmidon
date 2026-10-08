import { expect, test } from 'bun:test'
import { groupByFolder } from '../src/client/chat/DiffView.tsx'

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
