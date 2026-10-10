import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
