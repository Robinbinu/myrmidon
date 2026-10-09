import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, readProjectFile } from '../src/projects.ts'

let home: string
let folders: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'myr-projects-'))
  folders = realpathSync(mkdtempSync(join(tmpdir(), 'myr-folders-')))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(folders, { recursive: true, force: true })
})

test('a new project folder asks first; one added before that keeps working as it did', () => {
  const older = join(folders, 'older')
  const newer = join(folders, 'newer')
  mkdirSync(older)
  mkdirSync(newer)
  // An entry written before new folders started on ask: no stored mode, which means autonomous.
  writeFileSync(
    join(home, 'projects.json'),
    JSON.stringify([{ id: 'older-abc123', name: 'older', path: older, addedAt: '2026-10-01T00:00:00.000Z' }]),
  )
  const store = new ProjectStore(home)
  const added = store.add(newer)
  expect(added.permissions).toEqual({ mode: 'ask', allow: [] })
  expect(store.get(added.id)?.permissions?.mode).toBe('ask')
  expect(store.get('older-abc123')?.permissions).toBeUndefined()
  // Adding a folder already on the list returns it as it is, without resetting its mode.
  expect(store.add(older).permissions).toBeUndefined()
  store.setPermissions(added.id, { mode: 'auto', allow: [] })
  expect(store.add(newer).permissions?.mode).toBe('auto')
})

test('a project file opens by its path in the folder, and nothing outside the folder does', () => {
  const root = join(folders, 'app')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'calc.py'), 'def add(a, b):\n    return a + b\n')
  writeFileSync(join(folders, 'secret.txt'), 'outside')
  symlinkSync(join(folders, 'secret.txt'), join(root, 'link.txt'))
  writeFileSync(join(root, 'logo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))

  expect(readProjectFile(root, 'src/calc.py')).toEqual({
    path: 'src/calc.py',
    text: 'def add(a, b):\n    return a + b\n',
  })
  // Agents may name a file by its full path; one inside the folder opens the same way.
  expect(readProjectFile(root, join(root, 'src', 'calc.py')).path).toBe('src/calc.py')
  for (const outside of ['../secret.txt', join(folders, 'secret.txt'), 'link.txt', 'src/../../secret.txt'])
    expect(() => readProjectFile(root, outside)).toThrow(/not in this project/)
  expect(() => readProjectFile(root, 'gone.py')).toThrow(/no longer in the folder/)
  expect(() => readProjectFile(root, 'src')).toThrow(/not a file/)
  expect(() => readProjectFile(root, 'logo.png')).toThrow(/not a text file/)
})
