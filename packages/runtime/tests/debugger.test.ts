import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ACCESS_GROUPS, type PermissionCall } from '@myrmidon/protocol'
import { selectLaunchAdapter } from '@oh-my-pi/pi-coding-agent/dap/config'
import { type DebugArgs, type DebugScope, DebugSessions, debugSessions } from '../src/debugger.ts'
import type { ColonyHost } from '../src/host.ts'
import { onDemand, preloaded } from '../src/patterns.ts'
import { prompts } from '../src/prompts.ts'
import type { Sandbox, SandboxRun } from '../src/sandbox.ts'
import { TOOL_DEFS } from '../src/tools.ts'

const say = prompts.debugger
const python = Bun.which('python3')
/** debugpy, the adapter omp uses for Python, for the python3 on PATH; the Python tests need it. */
const debugpy = !!python && Bun.spawnSync([python, '-c', 'import debugpy']).exitCode === 0
const noDebugpy = !debugpy
if (noDebugpy)
  console.warn('debugger tests: skipping Python, debugpy is not installed for python3 (pip install debugpy)')

let dir: string
const sessions = new DebugSessions()

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'myr-debug-')))
})

afterEach(async () => {
  await sessions.close('c1')
  await debugSessions.close('c1')
  rmSync(dir, { recursive: true, force: true })
})

/** A scope as tools.ts builds one, without a sandbox: the adapter runs as it is, as with full access. */
function scope(more: Partial<DebugScope> = {}): DebugScope {
  return {
    colonyId: 'c1',
    agent: 'kai',
    access: { unconfined: true, readOnly: false },
    cwd: dir,
    resolveRead: (path) => resolve(dir, path),
    python: () => python ?? undefined,
    start: async (adapter) => adapter,
    approve: async (expression) => expression,
    ...more,
  }
}

const debug = (args: DebugArgs, s = scope()) => sessions.run(s, args)

const PROGRAM = [
  'import os, sys',
  'def add(a, b):',
  '    total = a + b',
  '    return total',
  'x = 41',
  'y = add(x, 1)',
  'print("result", y, flush=True)',
  'sys.exit(int(os.environ.get("EXIT", "0")))',
].join('\n')

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await Bun.sleep(50)
  return check()
}

test('debug and security_scan load on demand, in the shell and files groups, and a request can preload them', () => {
  expect(onDemand('debug')).toBe(true)
  expect(onDemand('security_scan')).toBe(true)
  expect(ACCESS_GROUPS.shell).toContain('debug')
  expect(ACCESS_GROUPS.files).toContain('security_scan')
  expect(
    preloaded('Debug why the parser crashes, set a breakpoint in parse', ['debug', 'security_scan']),
  ).toEqual(['debug'])
  expect(
    preloaded('Check the repo for leaked secrets and vulnerable dependencies', ['debug', 'security_scan']),
  ).toEqual(['security_scan'])
  const def = TOOL_DEFS.find((d) => d.name === 'debug')
  expect(def?.tier).toBe('exec')
  expect(def?.tierOf?.({ action: 'stack' })).toBe('read')
  expect(def?.tierOf?.({ action: 'evaluate' })).toBe('exec')
})

test.skipIf(noDebugpy)(
  'a Python program stops at a breakpoint, shows its variables and stack, evaluates, steps, and runs to its end',
  async () => {
    writeFileSync(join(dir, 'prog.py'), PROGRAM)
    const launched = await debug({
      action: 'launch',
      program: 'prog.py',
      breakpoints: [{ file: 'prog.py', line: 3 }],
    })
    expect(launched).toContain('Launched prog.py under debugpy.')
    expect(launched).toContain('Breakpoint prog.py:3')
    expect(launched).toContain('Stopped (breakpoint) in add at prog.py:3.')
    const vars = await debug({ action: 'variables' })
    expect(vars).toContain('a = 41 (int)')
    expect(vars).toContain('b = 1 (int)')
    expect(await debug({ action: 'evaluate', expression: 'a * 2' })).toBe('82 (int)')
    const stepped = await debug({ action: 'step_over' })
    expect(stepped).toContain('in add at prog.py:4.')
    const stack = await debug({ action: 'stack' })
    expect(stack).toContain('#0 add at prog.py:4')
    expect(stack).toContain('#1 <module> at prog.py:6')
    // The caller's frame, by its index in the stack.
    expect(await debug({ action: 'evaluate', expression: 'x', frame: 1 })).toBe('41 (int)')
    const ended = await debug({ action: 'continue' })
    expect(ended).toContain(say.ended(0))
    expect(ended).toContain('result 42')
    await expect(debug({ action: 'step_over' })).rejects.toThrow(say.ended(0))
    // What it printed stays readable after it ended, until the next launch.
    expect(await debug({ action: 'output' })).toContain('result 42')
  },
  60_000,
)

test.skipIf(noDebugpy)(
  'without breakpoints it stops at the start; one set then is hit, and terminate ends it',
  async () => {
    writeFileSync(join(dir, 'prog.py'), PROGRAM)
    expect(await debug({ action: 'launch', program: 'prog.py' })).toContain('Stopped (entry)')
    expect(await debug({ action: 'set_breakpoint', file: 'prog.py', line: 7 })).toContain(
      'Breakpoint prog.py:7',
    )
    // A conditional one that never holds is never hit.
    await debug({ action: 'set_breakpoint', file: 'prog.py', line: 3, condition: 'a == 0' })
    expect(await debug({ action: 'continue' })).toContain('Stopped (breakpoint) in <module> at prog.py:7.')
    await expect(debug({ action: 'launch', program: 'prog.py' })).rejects.toThrow(say.alreadyRunning)
    expect(await debug({ action: 'remove_breakpoint', file: 'prog.py', line: 7 })).toBe(
      say.breakpointRemoved('prog.py', 7),
    )
    expect(await debug({ action: 'terminate' })).toContain(say.terminated)
    await expect(debug({ action: 'stack' })).rejects.toThrow(say.noSession)
    expect(sessions.size).toBe(0)
  },
  60_000,
)

test.skipIf(noDebugpy)(
  'a program that keeps running is reported as running, and closing the round stops it and its adapter',
  async () => {
    writeFileSync(
      join(dir, 'loop.py'),
      'import os, time\nprint("pid", os.getpid(), flush=True)\nwhile True:\n    time.sleep(0.05)\n',
    )
    await debug({ action: 'launch', program: 'loop.py' })
    const r = await debug({ action: 'continue', timeoutSeconds: 1 })
    expect(r).toContain(say.running)
    const pid = Number(/pid (\d+)/.exec(r)?.[1])
    expect(pid).toBeGreaterThan(0)
    expect(running(pid)).toBe(true)
    // pause reaches a running program.
    expect(await debug({ action: 'pause' })).toContain('Stopped (pause)')
    await debug({ action: 'continue', timeoutSeconds: 1 })
    await sessions.close('c1')
    expect(await until(() => !running(pid))).toBe(true)
    expect(sessions.size).toBe(0)
  },
  60_000,
)

test.skipIf(noDebugpy)(
  'a session started with access the round has since lost is ended, and its next call says why',
  async () => {
    writeFileSync(join(dir, 'prog.py'), PROGRAM)
    await debug({ action: 'launch', program: 'prog.py' })
    sessions.stopLooser('c1', { unconfined: false, readOnly: false })
    await expect(debug({ action: 'continue' })).rejects.toThrow(say.looser)
  },
  60_000,
)

test('calls before a launch, and launches of what cannot be debugged, say so plainly', async () => {
  await expect(debug({ action: 'continue' })).rejects.toThrow(say.noSession)
  await expect(debug({ action: 'launch' })).rejects.toThrow(say.needsProgram)
  await expect(debug({ action: 'launch', program: 'missing.py' })).rejects.toThrow(say.notFound('missing.py'))
  await expect(debug({ action: 'attach' })).rejects.toThrow(say.needsPort)
  await expect(debug({ action: 'attach', port: 70_000 })).rejects.toThrow(say.badNumber('port', 1, 65_535))
  // A folder: only an adapter that takes one (Delve) may debug it; a native debugger, if one is installed, may not.
  mkdirSync(join(dir, 'pkg'))
  await expect(debug({ action: 'launch', program: 'pkg' })).rejects.toThrow(
    /cannot debug a folder|No debug adapter/,
  )
  expect(await debug({ action: 'status' })).toStartWith('No debug session.')
})

// vscode-js-debug is omp's JavaScript adapter: its dapDebugServer.js from JS_DEBUG_DAP_SERVER, Mason, or ~/.local/opt.
const jsDebug = selectLaunchAdapter(join(tmpdir(), 'x.js'), tmpdir()).kind === 'adapter'
if (!jsDebug)
  console.warn(
    'debugger tests: skipping JavaScript, vscode-js-debug is not installed (set JS_DEBUG_DAP_SERVER to its dapDebugServer.js)',
  )

test.skipIf(!jsDebug)(
  'a JavaScript program stops at a breakpoint and shows its variables',
  async () => {
    writeFileSync(
      join(dir, 'prog.js'),
      'function add(a, b) {\n  const total = a + b\n  return total\n}\nconsole.log(add(41, 1))\n',
    )
    const launched = await debug({
      action: 'launch',
      program: 'prog.js',
      breakpoints: [{ file: 'prog.js', line: 3 }],
    })
    expect(launched).toContain('prog.js:3')
    expect(await debug({ action: 'variables' })).toContain('total = 42')
    expect(await debug({ action: 'continue' })).toContain('42')
  },
  60_000,
)

/**
 * A host for the debug tool: decides every call with `decision`, and confines adapters with a stand-in that records
 * what it was asked to confine and runs the command line with sh, so the clean environment it builds is really used.
 */
function host(decision: 'allow' | 'ask' | 'deny') {
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
    // The person's HOME, so python3 finds a debugpy installed with pip --user.
    env: (spec) => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dir, ...spec.env }),
  }
  mkdirSync(join(dir, 'scratch'), { recursive: true })
  const h = {
    id: 'c1',
    spec: { agents: [], chat: {} },
    sandbox: standIn,
    unsafeNoSandbox: false,
    state: () => ({ rounds: [{ round: 1 }], receipts: {}, approvals: {} }),
    permit: (_: string, call: PermissionCall) => {
      calls.push(call)
      return decision === 'deny'
        ? { decision, source: { by: 'preset', scope: 'global', preset: 'ask' }, preset: 'ask' }
        : { decision, source: { by: 'preset', scope: 'global', preset: 'auto' }, preset: 'auto' }
    },
    reviewChange: async () => ({ approved: true, edits: { command: 'a + 100' } }),
    workspace: {
      colonyDir: dir,
      workdir: () => dir,
      scratch: () => join(dir, 'scratch'),
      confinement: () => ({ readable: [], hidden: [] }),
      resolveForRead: (_: string, path: string) => resolve(dir, path),
    },
  } as unknown as ColonyHost
  return { host: h, calls, confined }
}

const debugTool = TOOL_DEFS.find((d) => d.name === 'debug')

test.skipIf(!python)('a denied launch never starts its adapter', async () => {
  writeFileSync(join(dir, 'prog.py'), PROGRAM)
  const denied = host('deny')
  await expect(debugTool?.run({ action: 'launch', program: 'prog.py' }, 'kai', denied.host)).rejects.toThrow(
    'is not permitted',
  )
  expect(denied.calls).toHaveLength(1)
  expect(denied.calls[0]).toMatchObject({ tool: 'debug', kind: 'command', readOnly: false })
  expect(denied.calls[0]?.command).toContain('-m debugpy.adapter')
  expect(denied.calls[0]?.command).toContain(join(dir, 'prog.py'))
  expect(denied.confined).toHaveLength(0)
})

// The stand-in confinement runs its command line with /bin/sh.
test.skipIf(noDebugpy || process.platform === 'win32')(
  'the debug tool starts its adapter confined, decided as a command, and an expression the person rewrote runs as written',
  async () => {
    writeFileSync(join(dir, 'prog.py'), PROGRAM)
    const asked = host('ask')
    const launched = await debugTool?.run(
      {
        action: 'launch',
        program: 'prog.py',
        args: ['two words'],
        breakpoints: [{ file: 'prog.py', line: 3 }],
      },
      'kai',
      asked.host,
    )
    expect(launched).toContain('Stopped (breakpoint) in add at prog.py:3.')
    // The program and its arguments are on the command line the person decided, quoted as sh reads them.
    expect(asked.calls[0]?.command).toEndWith(`${join(dir, 'prog.py')} 'two words'`)
    // Started once, in the working directory, by a clean environment inside the confinement.
    expect(asked.confined).toHaveLength(1)
    expect(asked.confined[0]).toMatchObject({ cwd: dir, writable: [dir, join(dir, 'scratch')] })
    expect(asked.confined[0]?.command).toStartWith('exec /usr/bin/env -i ')
    expect(asked.confined[0]?.command).toContain("'-m' 'debugpy.adapter'")
    // Reads and stepping are not asked about again; an evaluation is a command of its own.
    await debugTool?.run({ action: 'variables' }, 'kai', asked.host)
    expect(asked.calls).toHaveLength(1)
    expect(await debugTool?.run({ action: 'evaluate', expression: 'a * 2' }, 'kai', asked.host)).toBe(
      '141 (int)',
    )
    expect(asked.calls[1]).toMatchObject({ tool: 'debug', kind: 'command', command: 'a * 2' })
  },
  60_000,
)
