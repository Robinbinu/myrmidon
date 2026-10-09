import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../src/projects.ts'

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
