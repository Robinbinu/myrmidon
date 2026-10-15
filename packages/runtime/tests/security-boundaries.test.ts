/**
 * Permission and sandbox boundaries, as deterministic regressions (docs/verification.md, tier 6). The `security`
 * group (tests/groups.ts) runs this beside the boundary tests that live with their features (full-access, read-access,
 * permissions, sandbox, projects…); this file holds the cases those did not pin.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decide, type PermissionCall, type PermissionLevels } from '@myrmidon/protocol'
import { ColonyWorkspace, fullAccessIn } from '../src/index.ts'

let root: string
let project: string
let outside: string
let home: string
let ws: ColonyWorkspace
let unconfined = false
const agent = 'lead'

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'myr-boundaries-')))
  project = join(root, 'project')
  outside = join(root, 'outside')
  home = join(root, 'home')
  for (const dir of [project, outside, home, join(root, 'project-evil'), join(home, '.ssh')]) mkdirSync(dir)
  writeFileSync(join(outside, 'secret.txt'), 'not yours')
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key')
  unconfined = false
  ws = new ColonyWorkspace(join(root, 'colony'), project, () => unconfined, {
    home,
    dataDir: join(root, 'data'),
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the file tools stay in the workspace', () => {
  test('a relative path cannot climb out of the project, for writing or reading', () => {
    for (const path of ['../outside/secret.txt', 'src/../../outside/x', '../../../../etc/hosts'])
      for (const resolve of [ws.resolveInWorkdir, ws.resolveForRead])
        expect(() => resolve.call(ws, agent, path)).toThrow('outside your project')
  })

  test('a folder whose name starts like the project is not inside it', () => {
    expect(() => ws.resolveInWorkdir(agent, join(root, 'project-evil', 'a.txt'))).toThrow(
      'outside your project',
    )
    expect(() => ws.resolveForRead(agent, `${project}-evil/a.txt`)).toThrow('outside your project')
  })

  test('a link in the project to a file or folder outside it reaches neither for writing', () => {
    symlinkSync(join(outside, 'secret.txt'), join(project, 'link.txt'))
    symlinkSync(outside, join(project, 'out'))
    expect(() => ws.resolveInWorkdir(agent, 'link.txt')).toThrow('outside your project')
    expect(() => ws.resolveInWorkdir(agent, 'out/new.txt')).toThrow('outside your project')
    expect(ws.keepsInside(agent, 'out/new.txt')).toBe(false)
  })

  test("a link in an agent's scratch to a file outside it is refused", () => {
    const scratch = ws.scratch(agent)
    symlinkSync(join(outside, 'secret.txt'), join(scratch, 'copy.txt'))
    symlinkSync(outside, join(scratch, 'dir'))
    expect(() => ws.resolveInScratch(agent, 'copy.txt')).toThrow('escapes your scratch directory')
    expect(() => ws.resolveInScratch(agent, 'dir/x.png')).toThrow('escapes your scratch directory')
    expect(() => ws.resolveInScratch(agent, '../other-agent/x')).toThrow('escapes your scratch directory')
  })

  // Known gap, found writing this file (2026-10-15): realPath() resolves the deepest path that exists, and a link
  // whose target is missing does not "exist", so the link itself is taken as the real path. fs_write then follows it
  // and created the file outside the project; realPath now follows such a link before judging it.
  test('a dangling link in the project cannot make a write land outside it', () => {
    symlinkSync(join(outside, 'planted.txt'), join(project, 'dangling.txt'))
    symlinkSync(join(outside, 'missing-dir'), join(project, 'dangling-dir'))
    expect(() => ws.resolveInWorkdir(agent, 'dangling.txt')).toThrow('outside your project')
    expect(() => ws.resolveInWorkdir(agent, 'dangling-dir/x.txt')).toThrow('outside your project')
  })

  test("a dangling link in an agent's scratch cannot make a write land outside it", () => {
    symlinkSync(join(outside, 'planted.png'), join(ws.scratch(agent), 'image.png'))
    expect(() => ws.resolveInScratch(agent, 'image.png')).toThrow('escapes your scratch directory')
  })

  test('with full access any path resolves, but a hidden secret is written back only inside', () => {
    unconfined = true
    expect(ws.resolveInWorkdir(agent, join(outside, 'secret.txt'))).toBe(join(outside, 'secret.txt'))
    expect(ws.keepsInside(agent, join(outside, 'secret.txt'))).toBe(false)
    expect(ws.keepsInside(agent, '~/.ssh/id_ed25519')).toBe(false)
    expect(ws.keepsInside(agent, 'notes.md')).toBe(true)
  })
})

describe('Full Access never lifts what the person denied or the project forbids', () => {
  const shell = (command: string): PermissionCall => ({ tool: 'shell', kind: 'command', command })
  const edit: PermissionCall = { tool: 'fs_write', kind: 'edit', where: 'project' }
  const full = (rules: PermissionLevels['global']['rules']): PermissionLevels => ({
    global: { preset: 'full', rules },
  })

  test('a deny rule still denies, and an ask rule still asks, under the Full preset', () => {
    const levels = full([
      { kind: 'command', target: 'git push', decision: 'deny' },
      { kind: 'tool', target: 'fs_write', decision: 'ask' },
    ])
    expect(decide(levels, shell('git push origin main')).decision).toBe('deny')
    expect(decide(levels, shell('cd repo && git push')).decision).toBe('deny')
    expect(decide(levels, edit).decision).toBe('ask')
    expect(decide(levels, shell('ls')).decision).toBe('allow')
  })

  test('a command a deny rule cannot read in full asks instead of running, under the Full preset', () => {
    const levels = full([{ kind: 'command', target: 'rm', decision: 'deny' }])
    expect(decide(levels, shell('$(echo r)m -rf build')).decision).toBe('ask')
  })

  test("a channel member's round asks for every outside step under the Full preset", () => {
    expect(decide(full([]), shell('touch x'), { askAll: true }).decision).toBe('ask')
    expect(decide(full([]), edit, { askAll: true }).decision).toBe('ask')
  })

  test('a read-only project denies edits even when the chat asks for Full', () => {
    const levels: PermissionLevels = {
      global: { preset: 'full', rules: [] },
      project: { preset: 'read-only', rules: [] },
      chat: { preset: 'full', rules: [{ kind: 'edit', target: '*', decision: 'allow' }] },
    }
    expect(decide(levels, edit).decision).toBe('deny')
    expect(decide(levels, { ...edit, where: 'private' }).decision).toBe('allow')
  })

  test('the round itself never has full access when a channel member started it or the project is read-only', () => {
    expect(fullAccessIn({ fullAccess: true })).toBe(true)
    expect(fullAccessIn({ fullAccess: true, askAll: true })).toBe(false)
    expect(
      fullAccessIn({
        fullAccess: true,
        permissions: {
          global: { preset: 'full', rules: [] },
          project: { preset: 'read-only', rules: [] },
        },
      }),
    ).toBe(false)
  })
})
