import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectCopies } from '../src/copies.ts'
import { projectGit } from '../src/project-context.ts'
import { ProjectWorktrees } from '../src/worktrees.ts'

let dir: string
let project: string

beforeEach(() => {
  // In the temp folder, on the same volume as the copies, as a project and its chat's folder usually are.
  dir = mkdtempSync(join(tmpdir(), 'myr-copies-'))
  project = join(dir, 'project')
  mkdirSync(join(project, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(project, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(project, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
  writeFileSync(join(project, 'b.txt'), 'bee\n')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Copies of the project, or undefined where this computer cannot clone it (most Linux file systems). */
const open = async () => {
  const copies = await ProjectCopies.open(project, join(dir, 'worktrees'))
  if (process.platform === 'darwin') expect(copies).toBeDefined()
  return copies
}

const text = (path: string) => readFileSync(path, 'utf8')

test('a folder outside git gets copies for its workers, not worktrees, and their changes merge into it', async () => {
  expect(await ProjectWorktrees.open(project, join(dir, 'worktrees'), 'col-1')).toBeUndefined()
  const copies = await open()
  if (!copies) return
  const ada = await copies.create('ada')
  const bo = await copies.create('bo')
  expect(ada.branch).toBe('')
  expect(text(join(ada.workdir, 'b.txt'))).toBe('bee\n')
  // Dependencies come along, so builds and tests run in the copy.
  expect(existsSync(join(ada.workdir, 'node_modules', 'dep', 'index.js'))).toBe(true)

  writeFileSync(join(ada.workdir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n')
  writeFileSync(join(bo.workdir, 'c.txt'), 'new file\n')
  rmSync(join(bo.workdir, 'b.txt'))
  // What it installs stays in its copy.
  writeFileSync(join(bo.workdir, 'node_modules', 'dep', 'index.js'), 'module.exports = 2\n')
  expect(text(join(project, 'a.txt'))).toBe('one\ntwo\nthree\nfour\nfive\n')
  expect(await copies.merge('ada')).toEqual({ kind: 'merged', files: ['a.txt'] })
  expect(await copies.merge('bo')).toEqual({ kind: 'merged', files: ['b.txt', 'c.txt'] })
  expect(await copies.merge('bo')).toEqual({ kind: 'nothing' })
  expect(text(join(project, 'a.txt'))).toBe('one\ntwo\nthree\nfour\nfive\nsix\n')
  expect(text(join(project, 'c.txt'))).toBe('new file\n')
  expect(existsSync(join(project, 'b.txt'))).toBe(false)
  expect(text(join(project, 'node_modules', 'dep', 'index.js'))).toBe('module.exports = 1\n')

  expect(await copies.close()).toEqual([
    { agent: 'ada', kept: false },
    { agent: 'bo', kept: false },
  ])
  expect(existsSync(ada.workdir)).toBe(false)
})

test('two workers changing one file merge both changes; overlapping changes conflict with markers to resolve', async () => {
  const copies = await open()
  if (!copies) return
  const ada = await copies.create('ada')
  const bo = await copies.create('bo')
  writeFileSync(join(ada.workdir, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\n')
  writeFileSync(join(bo.workdir, 'a.txt'), 'one\ntwo\nthree\nfour\nFIVE\n')
  expect(await copies.merge('ada')).toEqual({ kind: 'merged', files: ['a.txt'] })
  expect(await copies.merge('bo')).toEqual({ kind: 'merged', files: ['a.txt'] })
  expect(text(join(project, 'a.txt'))).toBe('ONE\ntwo\nthree\nfour\nFIVE\n')

  const cy = await copies.create('cy')
  writeFileSync(join(cy.workdir, 'a.txt'), 'uno\ntwo\nthree\nfour\nFIVE\n')
  writeFileSync(join(ada.workdir, 'a.txt'), 'eins\ntwo\nthree\nfour\nfive\n')
  expect(await copies.merge('cy')).toEqual({ kind: 'merged', files: ['a.txt'] })
  const conflict = await copies.merge('ada')
  expect(conflict).toEqual({ kind: 'conflict', files: ['a.txt'] })
  // The project keeps what landed; the worker's copy has both sides.
  expect(text(join(project, 'a.txt'))).toBe('uno\ntwo\nthree\nfour\nFIVE\n')
  const marked = text(join(ada.workdir, 'a.txt'))
  expect(marked).toContain('<<<<<<<')
  expect(marked).toContain('uno')
  expect(marked).toContain('eins')
  // Resolved and submitted again, it lands.
  writeFileSync(join(ada.workdir, 'a.txt'), 'uno eins\ntwo\nthree\nfour\nFIVE\n')
  expect(await copies.merge('ada')).toEqual({ kind: 'merged', files: ['a.txt'] })
  expect(text(join(project, 'a.txt'))).toBe('uno eins\ntwo\nthree\nfour\nFIVE\n')
})

test('a copy takes in what others merged since it was made, keeping its own unmerged work', async () => {
  const copies = await open()
  if (!copies) return
  const ada = await copies.create('ada')
  const bo = await copies.create('bo')
  writeFileSync(join(ada.workdir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n')
  expect(await copies.merge('ada')).toEqual({ kind: 'merged', files: ['a.txt'] })
  writeFileSync(join(bo.workdir, 'b.txt'), 'bee, bo\n')
  expect(await copies.refresh('bo')).toEqual({ kind: 'merged', files: ['a.txt'] })
  expect(text(join(bo.workdir, 'a.txt'))).toBe('one\ntwo\nthree\nfour\nfive\nsix\n')
  expect(text(join(bo.workdir, 'b.txt'))).toBe('bee, bo\n')
  expect(await copies.refresh('bo')).toEqual({ kind: 'nothing' })
  // Only bo's own change is left to merge.
  expect(await copies.merge('bo')).toEqual({ kind: 'merged', files: ['b.txt'] })

  // A refresh that would conflict leaves the copy alone.
  writeFileSync(join(ada.workdir, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\n')
  expect(await copies.merge('ada')).toEqual({ kind: 'merged', files: ['a.txt'] })
  writeFileSync(join(bo.workdir, 'a.txt'), 'uno\ntwo\nthree\nfour\nfive\nsix\n')
  expect(await copies.refresh('bo')).toEqual({ kind: 'conflict', files: ['a.txt'] })
  expect(text(join(bo.workdir, 'a.txt'))).toBe('uno\ntwo\nthree\nfour\nfive\nsix\n')
})

test('a Jujutsu workspace inside a git checkout gets no worktrees of the outer repository, nor its git state', async () => {
  const outer = join(dir, 'outer')
  const workspace = join(outer, 'app')
  mkdirSync(join(workspace, '.jj', 'repo', 'store'), { recursive: true })
  writeFileSync(join(workspace, '.jj', 'repo', 'store', 'type'), 'git')
  const init = Bun.spawnSync(['git', 'init', '-q', outer])
  expect(init.exitCode).toBe(0)
  expect(await ProjectWorktrees.open(workspace, join(dir, 'worktrees'), 'col-jj')).toBeUndefined()
  expect(projectGit(workspace)).toBeUndefined()
  expect(projectGit(outer)).toBeDefined()
})

test('a copy with unmerged changes is kept when the round ends', async () => {
  const copies = await open()
  if (!copies) return
  const ada = await copies.create('ada')
  writeFileSync(join(ada.workdir, 'b.txt'), 'unmerged\n')
  expect(await copies.close()).toEqual([{ agent: 'ada', kept: true }])
  expect(text(join(ada.workdir, 'b.txt'))).toBe('unmerged\n')
})
