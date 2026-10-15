/**
 * The round and agent lifecycle under interruption, error, cancellation and recovery (docs/lifecycle.md): each test
 * injects one fault with scripted models and checks the invariant it could break.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ColonyState, EventPayloads, MyrEvent } from '@myrmidon/protocol'
import {
  bootRuntime,
  ColonyRun,
  detectSandbox,
  ModelResolver,
  parseColonySpec,
  type Runtime,
} from '../src/index.ts'
import type { Context as LlmContext } from '../src/omp/ai.ts'
import { createMockModel, type MockContent } from '../src/omp/mock.ts'

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-lifecycle-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(home, { recursive: true, force: true })
})

const tool = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})

/** A model whose nth call (counted by the assistant messages it is shown) returns script[n]. */
function scripted(resolver: ModelResolver, ref: string, script: MockContent[][]) {
  const mock = createMockModel({
    handler: (ctx: LlmContext) => {
      const n = ctx.messages.filter((m) => m.role === 'assistant').length
      return { content: script[n] ?? ['nothing more to do'] }
    },
  })
  resolver.register(ref, { model: mock.model, streamFn: mock.stream })
}

const read = (run: ColonyRun) => runtime.ctx.log.read(run.id)
const ofType = <T extends keyof EventPayloads>(events: readonly MyrEvent[], type: T) =>
  events.filter((e) => e.type === type).map((e) => e.payload as EventPayloads[T])

async function until(run: ColonyRun, done: (events: MyrEvent[], state: ColonyState) => boolean, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25))
    if (done(await read(run), run.state())) return
  throw new Error('the run never got there')
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.skipIf(detectSandbox().kind === 'none')(
  'stopping during a command stops the command and what it started, and the turn ends',
  async () => {
    const resolver = new ModelResolver()
    scripted(resolver, 'mock/solo', [
      [tool('shell', { command: 'sleep 30 & echo $! > child.pid; wait', timeoutSeconds: 120 })],
    ])
    const spec = parseColonySpec({
      name: 'Stop mid-command',
      mission: 'Wait a while.',
      agents: [{ name: 'solo', model: 'mock/solo', tools: ['shell'] }],
      budget: { wall: '60s' },
    })
    const run = new ColonyRun(runtime, spec, { resolver, quietMs: 20_000 })
    await run.start()
    const pidFile = join(run.workspace.workdir('solo'), 'child.pid')
    await until(run, () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const child = Number(readFileSync(pidFile, 'utf8'))
    expect(alive(child)).toBe(true)

    const at = Date.now()
    await run.stop('stopped by user')
    await run.done
    // The command's tree is gone at once, not when its own timeout comes.
    await until(run, () => !alive(child), 5_000)
    // The call ends as stopped and the turn is recorded as over: nothing is left running in the log.
    await until(run, (events) => ofType(events, 'tool/result').length === 1, 5_000)
    expect(Date.now() - at).toBeLessThan(5_000)
    const [result] = ofType(await read(run), 'tool/result')
    expect(result).toMatchObject({ tool: 'shell', ok: false })
    expect(result?.output).toMatch(/stopped/i)
    await until(
      run,
      (events) => ofType(events, 'agent/turn').some((t) => t.agent === 'solo' && t.phase === 'end'),
      5_000,
    )
  },
  30_000,
)
