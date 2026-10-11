import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CELL_WORKER_COMMAND, EMBEDDED_SHELL_COMMAND } from '../../../packages/runtime/src/config.ts'
import { KITTEN_WORKER_COMMAND } from '../../../packages/runtime/src/voice/tts.ts'
import { asPlatform, executableName } from '../src/platform.ts'

// The real release build of the server, run from outside the repository as the app runs it: what it reads from the
// source tree at runtime is not there, so only what the build carries works.
let dir: string
let bin: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-sidecar-'))
  const script = join(import.meta.dir, '..', 'scripts', 'build-sidecar.ts')
  const build = Bun.spawnSync([process.execPath, script, dir], { stdout: 'pipe', stderr: 'pipe' })
  if (build.exitCode !== 0)
    throw new Error(`the sidecar did not build: ${build.stderr.toString().slice(-2000)}`)
  bin = join(dir, executableName('myrmidon', asPlatform(process.platform)))
}, 300_000)
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("the compiled server carries Kitten's worker and the native runtime it loads", () => {
  const empty = join(dir, 'no-model')
  mkdirSync(empty)
  expect(existsSync(join(dir, 'onnxruntime_binding.node'))).toBe(true)
  const run = Bun.spawnSync([bin, KITTEN_WORKER_COMMAND, empty], {
    cwd: dir,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // Past loading onnxruntime and kitten-tts-js, the worker stops at the missing model: not at a missing file of its
  // own, a native library it could not load, or the CLI's usage.
  expect(run.stderr.toString()).toContain(`no such file or directory, open '${join(empty, 'config.json')}'`)
  expect(run.stdout.toString()).toBe('')
  expect(run.exitCode).not.toBe(0)
}, 60_000)

test('the compiled server carries the JavaScript cell runtime, and it runs a cell', async () => {
  const run = (code: string) => ({
    type: 'run',
    runId: 'cell-1',
    code,
    filename: 'cell-1.js',
    snapshot: { cwd: dir, sessionId: 's' },
  })
  const proc = Bun.spawn([bin, CELL_WORKER_COMMAND], {
    cwd: dir,
    env: { ...process.env, MYR_CELL_FRAME: '#' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  for (const m of [{ type: 'init', snapshot: { cwd: dir, sessionId: 's' } }, run('6 * 7')])
    proc.stdin.write(`${JSON.stringify(m)}\n`)
  await proc.stdin.flush()
  const timer = setTimeout(() => proc.kill(), 30_000)
  type Frame = { type: string; chunk?: string; ok?: boolean }
  const frames: Frame[] = []
  let out = ''
  for await (const chunk of proc.stdout) {
    out += new TextDecoder().decode(chunk)
    const lines = out.split('\n')
    out = lines.pop() ?? ''
    frames.push(...lines.filter((l) => l.startsWith('#')).map((l) => JSON.parse(l.slice(1)) as Frame))
    // The runtime lives until its parent closes stdin, as when Myrmidon goes.
    if (frames.some((f) => f.type === 'result')) proc.stdin.end()
  }
  clearTimeout(timer)
  expect(frames.map((f) => f.type)).toContain('ready')
  expect(frames.find((f) => f.type === 'text')?.chunk).toBe('42\n')
  expect(frames.find((f) => f.type === 'result')?.ok).toBe(true)
}, 60_000)

test('the compiled server carries the built-in bash Windows without Git Bash runs commands in', () => {
  const run = Bun.spawnSync([bin, EMBEDDED_SHELL_COMMAND, 'echo hi | tr a-z A-Z; echo err >&2; exit 5'], {
    cwd: dir,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(run.stdout.toString().trim()).toBe('HI')
  expect(run.stderr.toString().trim()).toBe('err')
  expect(run.exitCode).toBe(5)
}, 60_000)
