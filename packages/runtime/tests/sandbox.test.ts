import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectSandbox } from '../src/sandbox.ts'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'myr-sandbox-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('a command run in the project keeps HOME and TMPDIR in the agent scratch, not the project', async () => {
  const project = join(root, 'project')
  const scratch = join(root, 'scratch')
  mkdirSync(project)
  mkdirSync(scratch)
  const caches = '$HOME/Library/Caches/com.apple.python'
  const r = await detectSandbox().run({
    command: `mkdir -p "${caches}" && touch "${caches}/x.pyc" "$TMPDIR/t" && echo "$HOME"`,
    cwd: project,
    writable: [project, scratch],
    timeoutMs: 10_000,
  })
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(readdirSync(project)).toEqual([])
  expect(r.stdout.trim()).toBe(join(scratch, '.home'))
  expect(existsSync(join(scratch, '.home/Library/Caches/com.apple.python/x.pyc'))).toBe(true)
  expect(existsSync(join(scratch, '.tmp/t'))).toBe(true)
})
