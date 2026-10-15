/**
 * The round and agent lifecycle under interruption, error, cancellation and recovery (docs/lifecycle.md): each test
 * injects one fault with scripted models and checks the invariant it could break.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ColonyState, EventPayloads, MyrEvent, TaskSnapshot } from '@myrmidon/protocol'
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

test('a resume after a crash between a call and its transcript keeps the recorded result instead of running it again', async () => {
  const script = [[tool('publish_artifact', { name: 'hello.txt', content: 'hello\n' })], ['all done']]
  const spec = () =>
    parseColonySpec({
      name: 'Crash after publish',
      mission: 'Publish hello.txt once.',
      agents: [{ name: 'solo', model: 'mock/solo', tools: ['publish_artifact'] }],
      budget: { wall: '60s' },
    })
  const first = new ModelResolver()
  scripted(first, 'mock/solo', script)
  const run = new ColonyRun(runtime, spec(), { resolver: first, quietMs: 20_000 })
  await run.start()
  await until(run, (events) =>
    ofType(events, 'agent/turn').some((t) => t.phase === 'end' && t.trigger === 'kickoff'),
  )
  await run.stop('test: the process is about to die')
  await run.done
  // The process died after logging the call's result but before its transcript got it: the transcript ends on the
  // assistant's call.
  const transcript = join(run.workspace.colonyDir, 'agents', 'solo.jsonl')
  const lines = readFileSync(transcript, 'utf8').trim().split('\n')
  const callAt = lines.findIndex((l) => l.includes('"toolCall"'))
  expect(callAt).toBeGreaterThan(-1)
  writeFileSync(transcript, `${lines.slice(0, callAt + 1).join('\n')}\n`)

  const second = new ModelResolver()
  const seen: string[] = []
  const mock = createMockModel({
    handler: (ctx: LlmContext) => {
      seen.push(JSON.stringify(ctx.messages))
      const n = ctx.messages.filter((m) => m.role === 'assistant').length
      return { content: script[n] ?? ['nothing more to do'] }
    },
  })
  second.register('mock/solo', { model: mock.model, streamFn: mock.stream })
  const resumed = new ColonyRun(runtime, spec(), { resolver: second, quietMs: 20_000, resumeId: run.id })
  await resumed.resume('Myrmidon restarted during this run')
  await until(resumed, () => seen.length > 0)
  await until(resumed, (events) => ofType(events, 'agent/turn').filter((t) => t.phase === 'end').length >= 2)
  await resumed.stop('test over')
  const final = await resumed.done
  // Published once: the resumed agent saw the call's recorded result and went on from there.
  expect(final.artifacts['hello.txt']).toHaveLength(1)
  expect(seen[0]).toContain('"toolResult"')
  // The repair is kept, so a later resume reads a whole conversation too.
  const kept = readFileSync(transcript, 'utf8')
  expect(kept.indexOf('"toolResult"')).toBeGreaterThan(kept.indexOf('"toolCall"'))
}, 30_000)

test('a run is not completed while a task is still being worked on or a call waits for the person', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [
    [
      tool('create_task', { subject: 'Check out.txt', assignee: 'worker' }),
      tool('publish_artifact', { name: 'out.txt', content: 'ok\n' }),
    ],
    ['the worker is checking'],
  ])
  // The worker claims the task and is still working on it: its next model call never returns.
  let calls = 0
  const worker = createMockModel({
    handler: async () => {
      calls += 1
      if (calls === 1) return { content: [tool('claim_task', { id: 'task-1', revision: 1 })] }
      await new Promise(() => {})
      return { content: ['never'] }
    },
  })
  resolver.register('mock/worker', { model: worker.model, streamFn: worker.stream })
  const spec = parseColonySpec({
    name: 'Open work',
    mission: 'Publish out.txt containing ok.',
    pattern: 'lead-workers',
    agents: [
      { name: 'lead', role: 'lead', model: 'mock/lead' },
      { name: 'worker', role: 'worker', model: 'mock/worker' },
    ],
    acceptance: [{ verifier: 'checks', rules: [{ artifact: 'out.txt', contains: 'ok' }] }],
    budget: { wall: '60s' },
  })
  const run = new ColonyRun(runtime, spec, { resolver, quietMs: 20_000 })
  await run.start()
  await until(run, (_, s) => s.tasks['task-1']?.status === 'in_progress' && !!s.artifacts['out.txt'])

  const refused = await run.requestFinalVerification('lead', 'out.txt is published')
  expect(refused).toContain('task-1')
  expect(run.state().status).toBe('running')
  expect(ofType(await read(run), 'verifier/requested')).toHaveLength(0)

  // The task is done, but a call still waits for the person: that holds completion too.
  await run.appendAtomic((s) => [
    {
      type: 'task/changed',
      actor: { kind: 'system', id: 'myrmidon' },
      payload: {
        by: 'scheduler',
        task: { ...(s.tasks['task-1'] as TaskSnapshot), revision: 3, status: 'verified' },
      },
    },
  ])
  const asked = run.reviewChange('worker', 'shell', 'shell rm -rf build', {})
  await until(run, (_, s) => Object.values(s.approvals).some((a) => !a.decided))
  const waiting = await run.requestFinalVerification('lead', 'out.txt is published')
  expect(waiting).toContain('shell rm -rf build')
  expect(run.state().status).toBe('running')

  // Once nothing is open, the run completes through its checks as before.
  const id = Object.values(run.state().approvals).find((a) => !a.decided)?.id ?? ''
  await run.decideApproval(id, false)
  expect((await asked).approved).toBe(false)
  await run.requestFinalVerification('lead', 'out.txt is published')
  expect((await run.done).status).toBe('completed')
}, 30_000)

test('a run whose process died is closed whole: nothing of it still looks under way, and what was running is kept', async () => {
  const { colonyId } = await import('@myrmidon/core')
  const { hostname } = await import('node:os')
  const { recoverOrphans } = await import('../src/index.ts')
  const { foldColony, unfinishedCalls } = await import('@myrmidon/protocol')
  const id = colonyId('died-mid-run')
  const system = { kind: 'system', id: 'myrmidon' } as const
  const lead = { kind: 'agent', id: 'lead' } as const
  const dead = Bun.spawn(['true'])
  await dead.exited
  await runtime.ctx.log.append(id, [
    {
      type: 'colony/created',
      actor: system,
      payload: {
        name: 'Died',
        mission: 'm',
        pattern: 'blackboard',
        agents: [{ name: 'lead', role: 'lead', model: 'x/y', tools: [] }],
        budget: { wallMs: 600_000 },
      },
    },
    { type: 'colony/started', actor: system, payload: { pid: dead.pid, hostname: hostname() } },
    { type: 'agent/status', actor: system, payload: { agent: 'lead', status: 'working' } },
    {
      type: 'server/started',
      actor: lead,
      payload: { agent: 'lead', name: 'web', command: 'npm run dev', url: 'http://localhost:5173' },
    },
    {
      type: 'login/requested',
      actor: lead,
      payload: { agent: 'lead', site: 'example.com', url: 'https://example.com/login', reason: 'deploy' },
    },
    {
      type: 'approval/requested',
      actor: lead,
      payload: { id: 'ap1', agent: 'lead', tool: 'shell', summary: 'make deploy' },
    },
    {
      type: 'tool/call',
      actor: lead,
      payload: { agent: 'lead', callId: 'c1', tool: 'shell', args: { command: 'npm publish' } },
    },
  ])
  expect(await recoverOrphans(runtime.ctx.log)).toEqual([id])
  const events = await runtime.ctx.log.read(id)
  const s = foldColony(id, events)
  expect(s.status).toBe('stopped')
  expect(s.agents.lead?.status).toBe('stopped')
  expect(s.approvals.ap1?.decided).toMatchObject({ approved: false, by: 'stopped' })
  expect(s.logins.lead?.finished).toBe('stopped')
  expect(s.servers.web?.stopped).toBeDefined()
  // What was running when it died stays visible: the person decides whether it ran before resuming.
  expect(unfinishedCalls(events).map((c) => c.args)).toEqual([{ command: 'npm publish' }])
})
