import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectSandbox, fullAccessIn, unconfinedSandbox } from '../src/sandbox.ts'

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

test('full access runs the command itself, with no sandbox around it; the default wraps it', () => {
  const spec = { command: 'echo hi', cwd: root, writable: [root] }
  const bare = unconfinedSandbox().argv(spec)
  expect(bare).toEqual(['/bin/sh', '-c', 'echo hi'])
  expect(bare.some((a) => /sandbox-exec|bwrap/.test(a))).toBe(false)
  const confined = detectSandbox()
  if (confined.kind === 'sandbox-exec') expect(confined.argv(spec)[0]).toBe('sandbox-exec')
  if (confined.kind === 'bubblewrap') expect(confined.argv(spec)[0]).toEndWith('bwrap')
})

test.skipIf(detectSandbox().kind === 'none')(
  'a full-access command writes outside its folders and sees the real home; a confined one cannot',
  async () => {
    const scratch = join(root, 'scratch')
    const outside = join(root, 'outside')
    mkdirSync(scratch)
    mkdirSync(outside)
    const spec = {
      command: `touch "${outside}/x" && echo "$HOME"`,
      cwd: scratch,
      writable: [scratch],
      timeoutMs: 10_000,
    }
    const confined = await detectSandbox().run(spec)
    expect(confined.code).not.toBe(0)
    expect(existsSync(join(outside, 'x'))).toBe(false)
    const free = await unconfinedSandbox().run(spec)
    expect(free.code).toBe(0)
    expect(existsSync(join(outside, 'x'))).toBe(true)
    expect(free.stdout.trim()).toBe(homedir())
  },
)

test('a full-access command that runs too long is stopped, with what it started', async () => {
  const marker = join(root, 'late')
  const started = Date.now()
  const r = await unconfinedSandbox().run({
    command: `(sleep 3 && touch "${marker}") & sleep 30`,
    cwd: root,
    writable: [root],
    timeoutMs: 500,
  })
  expect(r.timedOut).toBe(true)
  expect(r.code).toBeNull()
  expect(Date.now() - started).toBeLessThan(10_000)
  await Bun.sleep(3_500)
  expect(existsSync(marker)).toBe(false)
}, 20_000)

test('full access never holds for a round someone else wrote into, nor in a read-only project', () => {
  const chat = (preset: 'auto' | 'read-only' | 'full') => ({
    chatId: 'c',
    round: 1,
    request: 'r',
    history: '',
    project: { id: 'p', name: 'p', path: root, permissions: { preset, rules: [] } },
  })
  expect(fullAccessIn({ fullAccess: true })).toBe(true)
  expect(fullAccessIn({})).toBe(false)
  expect(fullAccessIn({ fullAccess: true, askAll: true })).toBe(false)
  expect(fullAccessIn({ fullAccess: true, chat: chat('read-only') })).toBe(false)
  expect(fullAccessIn({ fullAccess: true, chat: chat('full') })).toBe(true)
})
