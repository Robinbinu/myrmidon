import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitCommit, gitStatus, gitWorkingChanges } from '../src/git.ts'

let dir: string
const sh = (...args: string[]) =>
  Bun.spawnSync(['git', '-c', 'user.name=Ada', '-c', 'user.email=ada@x', ...args], { cwd: dir })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-git-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('a folder that is not a repository says so', async () => {
  expect(await gitStatus(dir)).toEqual({ repo: false })
})

test('status, working changes, history and a commit read from the project’s own repository', async () => {
  sh('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.ts'), 'one\n')
  sh('add', '-A')
  sh('commit', '-qm', 'First commit')
  writeFileSync(join(dir, 'a.ts'), 'one\ntwo\n')
  sh('commit', '-qam', 'Add two')
  writeFileSync(join(dir, 'a.ts'), 'one\ntwo\nthree\n')
  writeFileSync(join(dir, 'b.ts'), 'staged\n')
  sh('add', 'b.ts')
  writeFileSync(join(dir, 'notes.md'), 'untracked\n')

  const status = await gitStatus(dir)
  if (!status.repo) throw new Error('expected a repo')
  expect(status.branch).toBe('main')
  expect(status.files).toEqual([
    { path: 'a.ts', index: '.', worktree: 'M' },
    { path: 'b.ts', index: 'A', worktree: '.' },
    { path: 'notes.md', index: '?', worktree: '?' },
  ])
  expect(status.log.map((c) => c.subject)).toEqual(['Add two', 'First commit'])
  expect(status.log[0]?.author).toBe('Ada')

  const working = await gitWorkingChanges(dir)
  expect(working.files).toEqual([
    { path: 'a.ts', status: 'M', added: 1, removed: 0 },
    { path: 'b.ts', status: 'A', added: 1, removed: 0 },
    { path: 'notes.md', status: '?', added: 1, removed: 0 },
  ])
  expect(working.patch).toContain('+three')
  expect(working.patch).toContain('+untracked')

  const commit = await gitCommit(dir, status.log[0]?.hash ?? '')
  expect(commit.subject).toBe('Add two')
  expect(commit.files).toEqual([{ path: 'a.ts', status: 'M', added: 1, removed: 0 }])
  expect(commit.patch).toContain('+two')
  await expect(gitCommit(dir, 'HEAD; rm -rf /')).rejects.toThrow('not a commit hash')
})

test('stage, unstage, discard and commit act only on the given project paths', async () => {
  sh('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.ts'), 'one\n')
  sh('add', '-A')
  sh('commit', '-qm', 'First commit')
  writeFileSync(join(dir, 'a.ts'), 'one\ntwo\n')
  writeFileSync(join(dir, 'new.ts'), 'fresh\n')

  const { gitStage, gitUnstage, gitDiscard, gitCommitChanges, gitFileDiff } = await import('../src/git.ts')
  expect(await gitFileDiff(dir, 'a.ts', 'unstaged')).toContain('+two')
  expect(await gitFileDiff(dir, 'new.ts', 'untracked')).toContain('+fresh')
  // "Untracked" shows only a file git lists as new: never an ignored one (a .env) nor a tracked one in full.
  writeFileSync(join(dir, '.gitignore'), '.env\n')
  writeFileSync(join(dir, '.env'), 'API_KEY=sk-1\n')
  await expect(gitFileDiff(dir, '.env', 'untracked')).rejects.toThrow('not a new file')
  await expect(gitFileDiff(dir, 'a.ts', 'untracked')).rejects.toThrow('not a new file')
  await expect(gitFileDiff(dir, '*.ts', 'untracked')).rejects.toThrow('not a new file')
  await expect(gitStage(dir, ['../outside'])).rejects.toThrow('not a project path')
  await expect(gitStage(dir, ['--all'])).rejects.toThrow('not a project path')
  // Git for Windows reads either separator, so both kinds of escape are refused on every system.
  for (const outside of [
    '..\\outside',
    'a\\..\\..\\outside',
    'C:\\Windows\\win.ini',
    'C:win.ini',
    '\\\\host\\share\\x',
  ])
    await expect(gitStage(dir, [outside])).rejects.toThrow('not a project path')

  await gitStage(dir, ['a.ts'])
  let status = await gitStatus(dir)
  if (!status.repo) throw new Error('expected a repo')
  expect(status.files.find((f) => f.path === 'a.ts')).toMatchObject({ index: 'M', worktree: '.' })
  expect(await gitFileDiff(dir, 'a.ts', 'staged')).toContain('+two')
  await gitUnstage(dir, ['a.ts'])
  status = await gitStatus(dir)
  if (!status.repo) throw new Error('expected a repo')
  expect(status.files.find((f) => f.path === 'a.ts')).toMatchObject({ index: '.', worktree: 'M' })

  await gitDiscard(dir, ['new.ts'])
  expect(await Bun.file(join(dir, 'new.ts')).exists()).toBe(false)
  await expect(gitCommitChanges(dir, '  ')).rejects.toThrow('commit message')
  const short = await gitCommitChanges(dir, 'Add two', true)
  status = await gitStatus(dir)
  if (!status.repo) throw new Error('expected a repo')
  expect(status.files).toEqual([])
  expect(status.log[0]).toMatchObject({ short, subject: 'Add two' })
})
