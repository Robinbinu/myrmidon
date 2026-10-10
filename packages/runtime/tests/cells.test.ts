import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionCall } from '@myrmidon/protocol'
import { createMockModel } from '@oh-my-pi/pi-ai/providers/mock'
import { CellKernels, type CellScope, cellKernels } from '../src/cells.ts'
import { CELL_OUTPUT_CHARS } from '../src/config.ts'
import type { ColonyHost } from '../src/host.ts'
import { bootRuntime, ColonyRun, ModelResolver, parseColonySpec } from '../src/index.ts'
import { prompts } from '../src/prompts.ts'
import { detectSandbox, type Sandbox, type SandboxRun } from '../src/sandbox.ts'
import { TOOL_DEFS } from '../src/tools.ts'

let dir: string
const kernels = new CellKernels()

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'myr-cells-')))
})

afterEach(() => {
  kernels.close('c1')
  kernels.close('c2')
  cellKernels.close('c1')
  rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  kernels.close('c1')
  kernels.close('c2')
})

/** A scope as tools.ts builds one, without a sandbox: the runtime runs as it is, as with full access. */
function scope(agent = 'kai', colonyId = 'c1'): CellScope {
  return {
    colonyId,
    agent,
    access: { unconfined: true, readOnly: false },
    cwd: dir,
    filesDir: join(dir, '.cells'),
    launch: (argv, env) => ({ argv: [...argv], env: { ...process.env, ...env } }),
    python: () => Bun.which('python3') ?? undefined,
  }
}

const js = (code: string, more: { timeoutSeconds?: number; reset?: boolean } = {}, s = scope()) =>
  kernels.run(s, { language: 'js', code, ...more })

/** Whether a process is still running. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await Bun.sleep(50)
  return check()
}

test('a JavaScript cell keeps what earlier cells defined, and shows output and the last value', async () => {
  expect((await js('const x = 41\nlet seen = []\nconsole.log("set up")')).text).toBe('set up')
  const r = await js('seen.push(x); x + 1')
  expect(r).toMatchObject({ ok: true })
  expect(r.text).toBe('42')
  expect((await js('seen.length')).text).toBe('1')
  // Writing to stdout directly, as a child process or Bun.$ would, is output too.
  expect((await js('process.stdout.write("raw\\n"); await Bun.sleep(10); "done"')).text).toContain('raw')
  // Top-level await and the working directory.
  writeFileSync(join(dir, 'data.txt'), 'hello')
  expect((await js('await Bun.file("data.txt").text()')).text).toContain('hello')
  expect((await js('process.cwd()')).text).toContain(dir)
}, 30_000)

test('a cell that throws fails with its error and leaves the state as it was', async () => {
  await js('const kept = "still here"')
  const r = await js('throw new TypeError("boom")')
  expect(r.ok).toBe(false)
  expect(r.text).toContain('TypeError: boom')
  expect((await js('kept')).text).toContain('still here')
  // omp's host helpers have no host here.
  const tool = await js('await tool.shell({ command: "ls" })')
  expect(tool.ok).toBe(false)
  expect(tool.text).toContain('not available in eval cells')
}, 30_000)

test('a cell past its time is stopped with its runtime, said once, and the next starts fresh', async () => {
  await js('const before = 1')
  const pid = Number((await js('process.pid')).text)
  const r = await js('while (true) {}', { timeoutSeconds: 1 })
  expect(r.ok).toBe(false)
  expect(r.text).toBe(prompts.cells.timedOut(1))
  expect(await until(() => !running(pid))).toBe(true)
  const next = await js('typeof before')
  // The timeout already said the state was lost; the next cell does not say it again.
  expect(next.text).toBe('undefined')
}, 30_000)

test("a cell's output is cut at the limit, with how much was left out", async () => {
  const r = await js(`console.log("x".repeat(${CELL_OUTPUT_CHARS * 2}))`)
  expect(r.ok).toBe(true)
  expect(r.text.length).toBeLessThan(CELL_OUTPUT_CHARS + 200)
  expect(r.text).toContain('more characters of output left out')
}, 30_000)

test('a runtime that dies says so: in the cell it died in, or in the next one when it died between cells', async () => {
  await js('const a = 1')
  const died = await js('process.exit(3)')
  expect(died.ok).toBe(false)
  expect(died.text).toContain('exit 3')
  expect((await js('typeof a')).text).toBe('undefined')
  // Dying on its own between cells: the next cell is told its state is gone.
  await js('const b = 2; setTimeout(() => process.exit(4), 50); "later"')
  await Bun.sleep(1_000)
  const next = await js('typeof b')
  expect(next.text).toStartWith('[The JavaScript runtime had stopped (exit 4)')
  expect(next.text).toEndWith('undefined')
}, 30_000)

test('reset starts afresh, and each agent and language has its own runtime', async () => {
  await js('const mine = "kai"')
  const other = scope('ana')
  expect((await js('typeof mine', {}, other)).text).toBe('undefined')
  const reset = await js('typeof mine', { reset: true })
  expect(reset.text).toBe(`${prompts.cells.reset('JavaScript')}\nundefined`)
}, 30_000)

test('closing a round stops its runtimes and a running cell, and leaves other rounds running', async () => {
  const pid = Number((await js('process.pid')).text)
  const elsewhere = Number((await js('process.pid', {}, scope('kai', 'c2'))).text)
  // Something the cell started in the background is stopped with it.
  const child = Number((await js('Bun.spawn(["sleep", "60"]).pid')).text)
  const long = js('await Bun.sleep(60_000)')
  await Bun.sleep(200)
  kernels.close('c1')
  expect((await long).text).toBe(prompts.cells.stopped)
  expect(await until(() => !running(pid) && !running(child))).toBe(true)
  expect(running(elsewhere)).toBe(true)
  // One agent of a round (a dismissed crewmate).
  kernels.close('c2', 'kai')
  expect(await until(() => !running(elsewhere))).toBe(true)
  expect(kernels.size).toBe(0)
}, 30_000)

test('a runtime started with access the round has since lost is stopped, and its next cell says why', async () => {
  await js('const kept = 1')
  const pid = Number((await js('process.pid')).text)
  // Tightening that does not touch it (still unconfined, nothing read-only) leaves it running.
  kernels.stopLooser('c1', { unconfined: true, readOnly: false })
  expect((await js('kept')).text).toBe('1')
  // Full access taken back.
  kernels.stopLooser('c1', { unconfined: false, readOnly: false })
  expect(await until(() => !running(pid))).toBe(true)
  const next = await js('typeof kept')
  expect(next.text).toBe(`${prompts.cells.lost('JavaScript', prompts.cells.looser)}\nundefined`)
}, 30_000)

const python = Bun.which('python3')

test.skipIf(!python)(
  'a Python cell keeps its state, prints, and reports a traceback',
  async () => {
    const py = (code: string) => kernels.run(scope(), { language: 'py', code })
    expect((await py('import json\nrows = [1, 2, 3]\nprint("loaded")')).text).toBe('loaded')
    expect((await py('sum(rows)')).text).toBe('6')
    const r = await py('1 / 0')
    expect(r.ok).toBe(false)
    expect(r.text).toContain('ZeroDivisionError')
    expect((await py('json.dumps(rows)')).text).toContain('[1, 2, 3]')
  },
  60_000,
)

test('without python3, a Python cell says so plainly', async () => {
  const none = { ...scope(), python: () => undefined }
  await expect(kernels.run(none, { language: 'py', code: '1' })).rejects.toThrow(prompts.cells.noPython)
})

/**
 * A host for the eval tool: decides every call with `decision`, and runs commands through `sandbox` (by default a
 * stand-in confinement that only records what it was asked to confine, and runs the command line with sh).
 */
function host(decision: 'allow' | 'ask' | 'deny', sandbox?: Sandbox) {
  const calls: PermissionCall[] = []
  const confined: Omit<SandboxRun, 'timeoutMs'>[] = []
  const standIn: Sandbox = {
    kind: 'sandbox-exec',
    argv: (spec) => {
      confined.push(spec)
      return ['/bin/sh', '-c', spec.command]
    },
    run: () => Promise.reject(new Error('not used')),
    start: () => {
      throw new Error('not used')
    },
    env: (spec) => ({ PATH: process.env.PATH ?? '', HOME: dir, ...spec.env }),
  }
  mkdirSync(join(dir, 'scratch'), { recursive: true })
  const h = {
    id: 'c1',
    spec: { agents: [], chat: {} },
    sandbox: sandbox ?? standIn,
    unsafeNoSandbox: false,
    state: () => ({ rounds: [{ round: 1 }], receipts: {}, approvals: {} }),
    permit: (_: string, call: PermissionCall) => {
      calls.push(call)
      return decision === 'deny'
        ? { decision, source: { by: 'preset', scope: 'global', preset: 'ask' }, preset: 'ask' }
        : { decision, source: { by: 'preset', scope: 'global', preset: 'auto' }, preset: 'auto' }
    },
    reviewChange: async () => ({ approved: true, edits: { command: '"rewritten by the person"' } }),
    workspace: {
      colonyDir: dir,
      workdir: () => dir,
      scratch: () => join(dir, 'scratch'),
      confinement: () => ({ readable: [], hidden: [] }),
    },
  } as unknown as ColonyHost
  return { host: h, calls, confined }
}

const evalTool = TOOL_DEFS.find((d) => d.name === 'eval')

test('the eval tool is decided as a command and starts its runtime confined, with its own files readable', async () => {
  const { host: h, calls, confined } = host('allow')
  expect(evalTool?.tier).toBe('exec')
  expect(await evalTool?.run({ language: 'js', code: 'const n = 2' }, 'kai', h)).toBe(prompts.cells.noOutput)
  expect(await evalTool?.run({ language: 'js', code: 'n * 21' }, 'kai', h)).toBe('42')
  expect(calls.map((c) => c.kind)).toEqual(['command', 'command'])
  expect(calls[1]).toMatchObject({ tool: 'eval', command: 'n * 21', readOnly: false })
  // One runtime, started once, in the agent's working directory, by a clean environment inside the confinement.
  expect(confined).toHaveLength(1)
  expect(confined[0]).toMatchObject({ cwd: dir, writable: [dir, join(dir, 'scratch')] })
  expect(confined[0]?.readable).toContain(join(dir, 'cells'))
  expect(confined[0]?.command).toStartWith('exec /usr/bin/env -i ')
  expect(confined[0]?.command).toContain(join(dir, 'cells', 'js-cells-'))
}, 30_000)

test('a denied cell never runs, and one the person rewrote runs as they wrote it', async () => {
  const denied = host('deny')
  await expect(evalTool?.run({ language: 'js', code: '1' }, 'kai', denied.host)).rejects.toThrow(
    'is not permitted',
  )
  expect(denied.confined).toHaveLength(0)
  const asked = host('ask')
  expect(await evalTool?.run({ language: 'js', code: '"as the agent wrote it"' }, 'kai', asked.host)).toBe(
    'rewritten by the person',
  )
})

// The person's real home stays hidden, so the runtime must start from what the sandbox opens (bun, its own files).
const sandbox = detectSandbox()

test.skipIf(sandbox.kind === 'none')(
  "a round's cell runtimes are stopped when the round ends",
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'myr-cells-round-'))
    const runtime = await bootRuntime(home)
    try {
      const resolver = new ModelResolver()
      const solo = createMockModel({
        handler: (ctx) =>
          ctx.messages.some((m) => m.role === 'assistant')
            ? { content: ['done for now'] }
            : {
                content: [
                  {
                    type: 'toolCall',
                    name: 'eval',
                    arguments: { language: 'js', code: 'globalThis.kept = 1; process.pid' },
                  },
                ],
              },
      })
      resolver.register('mock/solo', { model: solo.model, streamFn: solo.stream })
      const spec = parseColonySpec({
        name: 'Cells',
        // "REPL" loads eval from the start (see `preloaded`).
        mission: 'Explore the numbers in a REPL and publish out.txt containing ok.',
        agents: [{ name: 'solo', model: 'mock/solo' }],
        acceptance: [{ verifier: 'checks', rules: [{ artifact: 'out.txt', contains: 'ok' }] }],
        budget: { wall: '30s' },
      })
      const run = new ColonyRun(runtime, spec, { resolver, quietMs: 200 })
      await run.start()
      const final = await run.done
      expect(final.status).toBe('stopped')
      const result = (await runtime.ctx.log.read(run.id)).find(
        (e) => e.type === 'tool/result' && (e.payload as { tool: string }).tool === 'eval',
      )?.payload as { ok: boolean; output: string } | undefined
      expect(result?.ok).toBe(true)
      const pid = Number(result?.output)
      expect(pid).toBeGreaterThan(0)
      expect(await until(() => !running(pid))).toBe(true)
    } finally {
      await runtime.dispose()
      rmSync(home, { recursive: true, force: true })
    }
  },
  60_000,
)

test.skipIf(sandbox.kind !== 'sandbox-exec' && sandbox.kind !== 'bubblewrap')(
  'in the real OS sandbox a cell writes its working directory and nowhere else',
  async () => {
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'myr-cells-outside-')))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'top secret')
      const { host: h } = host('allow', sandbox)
      Object.assign((h as unknown as { workspace: object }).workspace, {
        confinement: () => ({ readable: [], hidden: [outside] }),
      })
      const run = (code: string) => evalTool?.run({ language: 'js', code }, 'kai', h)
      expect(await run('await Bun.write("inside.txt", "ok"); "wrote"')).toBe('wrote')
      expect(readFileSync(join(dir, 'inside.txt'), 'utf8')).toBe('ok')
      await expect(run(`await Bun.write(${JSON.stringify(join(outside, 'x.txt'))}, "no")`)).rejects.toThrow(
        /EPERM|EACCES|EROFS|not permitted|denied/i,
      )
      expect(existsSync(join(outside, 'x.txt'))).toBe(false)
      await expect(
        run(`await Bun.file(${JSON.stringify(join(outside, 'secret.txt'))}).text()`),
      ).rejects.toThrow(/EPERM|EACCES|ENOENT|not permitted|denied/i)
      // State still carries over inside the sandbox.
      expect(await run('typeof Bun')).toBe('object')
      if (python) {
        const py = (code: string) => evalTool?.run({ language: 'py', code }, 'kai', h)
        expect(await py('text = open("inside.txt").read()\ntext')).toBe("'ok'")
        await expect(py(`open(${JSON.stringify(join(outside, 'secret.txt'))}).read()`)).rejects.toThrow(
          /PermissionError|Operation not permitted|FileNotFoundError/,
        )
        expect(await py('text.upper()')).toBe("'OK'")
      }
    } finally {
      cellKernels.close('c1')
      rmSync(outside, { recursive: true, force: true })
    }
  },
  60_000,
)
