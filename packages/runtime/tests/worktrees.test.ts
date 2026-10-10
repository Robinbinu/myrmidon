import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectWorktrees } from '../src/worktrees.ts'

let dir: string
let repo: string

const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return r.stdout.toString()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-wt-'))
  repo = join(dir, 'repo')
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'b.txt'), 'bee\n')
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'add', '-A')
  sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('workers edit their own worktrees and their changes merge into the folder', async () => {
  // An uncommitted change in the folder is part of what workers start from.
  writeFileSync(join(repo, 'b.txt'), 'bee (edited, not committed)\n')
  const trees = await ProjectWorktrees.open(repo, join(dir, 'worktrees'), 'col-1')
  if (!trees) throw new Error('expected a git project')
  const ada = await trees.create('ada')
  const bo = await trees.create('bo')
  expect(ada.branch).toBe('myr/col-1/ada')
  expect(readFileSync(join(ada.workdir, 'b.txt'), 'utf8')).toBe('bee (edited, not committed)\n')
  expect(lstatSync(join(ada.workdir, 'node_modules')).isSymbolicLink()).toBe(true)

  writeFileSync(join(ada.workdir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
  writeFileSync(join(bo.workdir, 'c.txt'), 'new file\n')
  expect(await trees.merge('ada')).toEqual({ kind: 'merged', files: ['a.txt'] })
  expect(await trees.merge('bo')).toEqual({ kind: 'merged', files: ['c.txt'] })
  expect(await trees.merge('bo')).toEqual({ kind: 'nothing' })
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\nfour\n')
  expect(readFileSync(join(repo, 'c.txt'), 'utf8')).toBe('new file\n')
  // The person's branch, index and uncommitted edits are untouched; no symlink was committed anywhere.
  expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
  expect(sh(repo, 'diff', '--cached', '--name-only')).toBe('')
  expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('bee (edited, not committed)\n')
  expect(sh(repo, 'ls-tree', '-r', '--name-only', 'myr/col-1/ada')).not.toContain('node_modules')

  expect(await trees.close()).toEqual([
    { agent: 'ada', kept: false },
    { agent: 'bo', kept: false },
  ])
  expect(existsSync(ada.workdir)).toBe(false)
  expect(sh(repo, 'branch', '--list', 'myr/*')).toBe('')
  // Removing a worktree removes its link to the folder's dependencies (a junction on Windows), not what it points to.
  expect(readFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
})

test('a conflict goes back to the worker with markers, and its resolution merges', async () => {
  const trees = await ProjectWorktrees.open(repo, join(dir, 'worktrees'), 'col-2')
  if (!trees) throw new Error('expected a git project')
  const ada = await trees.create('ada')
  // Someone else changes the same line in the folder meanwhile.
  writeFileSync(join(repo, 'a.txt'), 'one\nTWO (lead)\nthree\n')
  writeFileSync(join(ada.workdir, 'a.txt'), 'one\ntwo (ada)\nthree\n')
  expect(await trees.merge('ada')).toEqual({ kind: 'conflict', files: ['a.txt'] })
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\nTWO (lead)\nthree\n')
  const marked = readFileSync(join(ada.workdir, 'a.txt'), 'utf8')
  expect(marked).toContain('<<<<<<<')
  expect(marked).toContain('TWO (lead)')
  expect(marked).toContain('two (ada)')

  writeFileSync(join(ada.workdir, 'a.txt'), 'one\nTWO (lead) and two (ada)\nthree\n')
  expect(await trees.merge('ada')).toEqual({ kind: 'merged', files: ['a.txt'] })
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\nTWO (lead) and two (ada)\nthree\n')
})

test('a worktree with unmerged changes is kept with its branch when the round ends', async () => {
  const trees = await ProjectWorktrees.open(repo, join(dir, 'worktrees'), 'col-3')
  if (!trees) throw new Error('expected a git project')
  const ada = await trees.create('ada')
  writeFileSync(join(ada.workdir, 'b.txt'), 'unfinished\n')
  expect(await trees.close()).toEqual([{ agent: 'ada', kept: true }])
  expect(sh(repo, 'show', 'myr/col-3/ada:b.txt')).toBe('unfinished\n')
  expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('bee\n')
})

test('a project in a subfolder of a repository works in the same subfolder of the worktree', async () => {
  mkdirSync(join(repo, 'app'))
  writeFileSync(join(repo, 'app', 'main.ts'), 'export {}\n')
  const trees = await ProjectWorktrees.open(join(repo, 'app'), join(dir, 'worktrees'), 'col-4')
  if (!trees) throw new Error('expected a git project')
  const ada = await trees.create('ada')
  expect(readFileSync(join(ada.workdir, 'main.ts'), 'utf8')).toBe('export {}\n')
  writeFileSync(join(ada.workdir, 'main.ts'), 'export const x = 1\n')
  expect(await trees.merge('ada')).toEqual({ kind: 'merged', files: ['app/main.ts'] })
  expect(readFileSync(join(repo, 'app', 'main.ts'), 'utf8')).toBe('export const x = 1\n')
})

test('a folder outside git has no worktrees', async () => {
  const plain = join(dir, 'plain')
  mkdirSync(plain)
  expect(await ProjectWorktrees.open(plain, join(dir, 'worktrees'), 'col-5')).toBeUndefined()
})

test('a worktree takes in what others merged since it was made, keeping its own unmerged work', async () => {
  const trees = await ProjectWorktrees.open(repo, join(dir, 'worktrees'), 'col-6')
  if (!trees) throw new Error('expected a git project')
  const ada = await trees.create('ada')
  const bo = await trees.create('bo')
  writeFileSync(join(ada.workdir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
  expect(await trees.merge('ada')).toEqual({ kind: 'merged', files: ['a.txt'] })

  // bo, idle until now, starts its task on the latest code.
  writeFileSync(join(bo.workdir, 'c.txt'), 'bo started this\n')
  expect(await trees.refresh('bo')).toEqual({ kind: 'merged', files: ['a.txt'] })
  expect(readFileSync(join(bo.workdir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\nfour\n')
  expect(readFileSync(join(bo.workdir, 'c.txt'), 'utf8')).toBe('bo started this\n')
  expect(await trees.refresh('bo')).toEqual({ kind: 'nothing' })
  // Its merge carries only its own change, not ada's again.
  expect(await trees.merge('bo')).toEqual({ kind: 'merged', files: ['c.txt'] })
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\nfour\n')

  // A refresh that would conflict leaves the worktree alone.
  writeFileSync(join(repo, 'b.txt'), 'bee (lead)\n')
  writeFileSync(join(bo.workdir, 'b.txt'), 'bee (bo)\n')
  expect(await trees.refresh('bo')).toEqual({ kind: 'conflict', files: ['b.txt'] })
  expect(readFileSync(join(bo.workdir, 'b.txt'), 'utf8')).toBe('bee (bo)\n')
})
