import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context as LlmContext } from '@oh-my-pi/pi-ai'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import {
  bootRuntime,
  ColonyRun,
  detectSandbox,
  ModelResolver,
  parseColonySpec,
  type Runtime,
} from '../src/index.ts'

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-colony-'))
  runtime = await bootRuntime(home)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(home, { recursive: true, force: true })
})

/** A scripted model: the nth model call of this agent returns script[n]. */
function scripted(resolver: ModelResolver, ref: string, script: MockContent[][]) {
  const mock = createMockModel({
    handler: (ctx: LlmContext) => {
      const n = ctx.messages.filter((m) => m.role === 'assistant').length
      return { content: script[n] ?? ['nothing more to do'] }
    },
  })
  resolver.register(ref, { model: mock.model, streamFn: mock.stream })
}

const tool = (name: string, args: Record<string, unknown>): MockContent => ({
  type: 'toolCall',
  name,
  arguments: args,
})

test('a colony coordinates, publishes, and completes only through verification', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/lead', [
    [tool('create_task', { subject: 'Write greeting' })],
    [tool('publish_artifact', { name: 'hello.txt', content: 'hello colony\n' })],
    [tool('post', { text: '@helper hello.txt is published, please check it' })],
    [tool('request_final_verification', { summary: 'hello.txt published' })],
  ])
  scripted(resolver, 'mock/helper', [[tool('read_artifact', { name: 'hello.txt' })], ['looks right']])

  const acceptance: unknown[] = [
    { verifier: 'checks', rules: [{ artifact: 'hello.txt', contains: 'hello' }] },
  ]
  if (detectSandbox().kind !== 'none')
    acceptance.push({ verifier: 'command', run: 'grep -q colony hello.txt', against: ['hello.txt'] })

  const spec = parseColonySpec({
    name: 'Greeting',
    mission: 'Publish hello.txt containing a greeting.',
    pattern: 'lead-workers',
    agents: [
      { name: 'lead', role: 'lead', model: 'mock/lead' },
      { name: 'helper', role: 'worker', model: 'mock/helper' },
    ],
    acceptance,
    budget: { wall: '60s' },
  })
  const run = new ColonyRun(runtime, spec, { resolver, quietMs: 500 })
  await run.start()
  const final = await run.done

  expect(final.status).toBe('completed')
  expect(final.artifacts['hello.txt']?.at(-1)?.version).toBe(1)
  expect(final.tasks['task-1']?.subject).toBe('Write greeting')
  expect(final.verdicts.filter((v) => v.target === 'colony').every((v) => v.pass)).toBe(true)
  expect(final.links['lead→helper']).toBeGreaterThan(0)

  const events = await runtime.ctx.log.read(run.id)
  const types = events.map((e) => e.type)
  expect(types).toContain('colony/completed')
  expect(types).toContain('llm/response')
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
  expect(await Bun.file(join(run.workspace.mirrorRoot, 'artifacts', 'hello.txt')).text()).toBe(
    'hello colony\n',
  )
})

test('failed verification does not complete the colony', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/solo', [
    [tool('publish_artifact', { name: 'out.txt', content: 'wrong' })],
    [tool('request_final_verification', { summary: 'done' })],
  ])
  const spec = parseColonySpec({
    name: 'Strict',
    mission: 'Publish out.txt containing ok.',
    agents: [{ name: 'solo', model: 'mock/solo' }],
    acceptance: [{ verifier: 'checks', rules: [{ artifact: 'out.txt', contains: 'ok' }] }],
    budget: { wall: '30s' },
  })
  const run = new ColonyRun(runtime, spec, { resolver, quietMs: 200 })
  await run.start()
  const final = await run.done
  expect(final.status).toBe('stopped')
  expect(final.statusReason).toContain('stalled')
  expect(final.verdicts.some((v) => v.target === 'colony' && !v.pass)).toBe(true)
})

test('agents cannot escape their scratch directory', async () => {
  const resolver = new ModelResolver()
  scripted(resolver, 'mock/escape', [
    [tool('fs_write', { path: '../other/evil.txt', content: 'x' })],
    [tool('publish_artifact', { name: '../../etc/passwd', content: 'x' })],
  ])
  const spec = parseColonySpec({
    name: 'Escape',
    mission: 'Try to escape.',
    agents: [{ name: 'escape', model: 'mock/escape' }],
    acceptance: [{ verifier: 'checks', rules: [{ artifact: 'never.txt' }] }],
    budget: { wall: '20s' },
  })
  const run = new ColonyRun(runtime, spec, { resolver, quietMs: 200 })
  await run.start()
  await run.done
  const results = (await runtime.ctx.log.read(run.id)).filter((e) => e.type === 'tool/result')
  const outputs = results.map((e) => e.payload as { ok: boolean; output: string })
  expect(outputs.every((o) => !o.ok)).toBe(true)
  expect(outputs[0]?.output).toContain('outside your scratch directory')
  expect(outputs[1]?.output).toContain('invalid artifact name')
})

test('a token budget stops the colony once the models have used it', async () => {
  const resolver = new ModelResolver()
  let calls = 0
  const mock = createMockModel({
    handler: () => {
      calls += 1
      return { content: [tool('post', { text: `step ${calls}` })], usage: { input: 400, output: 100 } }
    },
  })
  resolver.register('mock/hungry', { model: mock.model, streamFn: mock.stream })
  const spec = parseColonySpec({
    name: 'Tokens',
    mission: 'Keep going.',
    agents: [{ name: 'hungry', model: 'mock/hungry' }],
    budget: { wall: '20s', tokens: 1200 },
  })
  const run = new ColonyRun(runtime, spec, { resolver, quietMs: 200 })
  await run.start()
  const final = await run.done
  expect(final.status).toBe('stopped')
  expect(final.statusReason).toContain('tokens reached limit 1,200')
  expect(calls).toBeLessThan(6)
})

test.skipIf(detectSandbox().kind === 'none')(
  'an agent makes a tool, it must pass its test run, and the team can call it; kept tools load into new colonies',
  async () => {
    const resolver = new ModelResolver()
    const shout = {
      name: 'shout',
      description: 'Upper-cases a phrase and adds an exclamation mark.',
      inputs: [{ name: 'text', type: 'string', description: 'The phrase' }],
      language: 'bash',
      source:
        'echo "$MYR_INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin)[\'text\'].upper() + \'!\')"\n',
    }
    scripted(resolver, 'mock/maker', [
      [tool('create_tool', { ...shout, name: 'broken', source: 'exit 3\n', test: '{"text": "x"}' })],
      [tool('create_tool', { ...shout, test: '{"text": "test"}' })],
      [tool('tool_shout', { text: 'made by an agent' })],
    ])
    const spec = parseColonySpec({
      name: 'Maker',
      mission: 'Make a tool.',
      agents: [{ name: 'maker', model: 'mock/maker', tools: ['shell', 'create_tool'] }],
      budget: { wall: '20s' },
    })
    const run = new ColonyRun(runtime, spec, { resolver, quietMs: 200 })
    await run.start()
    const final = await run.done
    const results = (await runtime.ctx.log.read(run.id))
      .filter((e) => e.type === 'tool/result')
      .map((e) => e.payload as { tool: string; ok: boolean; output: string })
    expect(results[0]).toMatchObject({ tool: 'create_tool', ok: false })
    expect(results[0]?.output).toContain('failed its test run')
    expect(results[1]).toMatchObject({ tool: 'create_tool', ok: true })
    expect(results[1]?.output).toContain('TEST!')
    expect(results[2]).toMatchObject({ tool: 'tool_shout', ok: true, output: 'MADE BY AN AGENT!' })
    expect(Object.keys(final.madeTools)).toEqual(['shout'])

    // Kept in the library, the tool is there from the start of the next colony.
    const { ToolLibrary } = await import('../src/index.ts')
    const library = new ToolLibrary(join(home, 'tools'))
    const {
      seq: _s,
      time: _t,
      agent: _a,
      ...made
    } = final.madeTools.shout as NonNullable<(typeof final.madeTools)['shout']>
    library.save(made)
    scripted(resolver, 'mock/user', [[tool('tool_shout', { text: 'again' })]])
    const next = new ColonyRun(
      runtime,
      parseColonySpec({
        name: 'User',
        mission: 'Use the tool.',
        agents: [{ name: 'user', model: 'mock/user', tools: ['shell'] }],
        budget: { wall: '20s' },
      }),
      { resolver, quietMs: 200, library },
    )
    await next.start()
    const after = await next.done
    expect(after.madeTools.shout?.library).toBe(true)
    const used = (await runtime.ctx.log.read(next.id)).find((e) => e.type === 'tool/result')
    expect(used?.payload).toMatchObject({ tool: 'tool_shout', ok: true, output: 'AGAIN!' })
  },
)

test.skipIf(detectSandbox().kind === 'none')(
  'the judge sees what the agents observed and is told its memory may be out of date',
  async () => {
    const resolver = new ModelResolver()
    scripted(resolver, 'mock/looker', [
      [tool('shell', { command: 'echo the page heading is OBSERVED-HEADING' })],
      [tool('publish_artifact', { name: 'answer.txt', content: 'The heading is OBSERVED-HEADING.' })],
      [tool('request_final_verification', { summary: 'answered' })],
    ])
    let seen: LlmContext | undefined
    const judge = createMockModel({
      handler: (ctx: LlmContext) => {
        seen = ctx
        return { content: ['{"score": 1, "reasons": "matches the observation"}'] }
      },
    })
    resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
    const spec = parseColonySpec({
      name: 'Look',
      mission: 'Report the heading.',
      agents: [
        {
          name: 'looker',
          model: 'mock/looker',
          tools: ['shell', 'publish_artifact', 'request_final_verification'],
        },
      ],
      acceptance: [
        { verifier: 'llm-judge', model: 'mock/judge', rubric: 'Correct heading.', threshold: 0.7 },
      ],
      budget: { wall: '20s' },
    })
    const run = new ColonyRun(runtime, spec, { resolver, quietMs: 200 })
    await run.start()
    expect((await run.done).status).toBe('completed')
    expect(String(seen?.systemPrompt)).toContain(`Today is ${new Date().toISOString().slice(0, 10)}`)
    const prompt = JSON.stringify(seen?.messages)
    expect(prompt).toContain('OBSERVED (latest tool results')
    expect(prompt).toContain('looker shell')
    expect(prompt).toContain('the page heading is OBSERVED-HEADING')
  },
)

test('a running agent can be switched to another model from its next step', async () => {
  const resolver = new ModelResolver()
  const calls: string[] = []
  let run: ColonyRun | undefined
  const first = createMockModel({
    handler: () => {
      calls.push('one')
      // Switched while this call is in flight: the call finishes here, the next step goes to the new model.
      void run?.switchModels({ worker: 'mock/two' })
      return { content: [tool('post', { text: 'step one' })] }
    },
  })
  const second = createMockModel({
    handler: (ctx: LlmContext) => {
      calls.push('two')
      expect(JSON.stringify(ctx.messages)).toContain('step one')
      return { content: ['done'] }
    },
  })
  resolver.register('mock/one', { model: first.model, streamFn: first.stream })
  resolver.register('mock/two', { model: second.model, streamFn: second.stream })
  const spec = parseColonySpec({
    name: 'Switch',
    mission: 'Keep going.',
    agents: [{ name: 'worker', model: 'mock/one' }],
    budget: { wall: '20s' },
  })
  run = new ColonyRun(runtime, spec, { resolver, quietMs: 200 })
  await run.start()
  const final = await run.done
  expect(calls.slice(0, 2)).toEqual(['one', 'two'])
  expect(final.agents.worker?.info.model).toBe('mock/two')
  const switched = (await runtime.ctx.log.read(run.id)).find((e) => e.type === 'agent/model')
  expect(switched?.payload).toEqual({ agent: 'worker', model: 'mock/two', previous: 'mock/one' })
})

test('recovery marks colonies with a dead runner process as stopped', async () => {
  const { colonyId } = await import('@myrmidon/core')
  const { recoverOrphans } = await import('../src/index.ts')
  const { hostname } = await import('node:os')
  const id = colonyId('orphan-test')
  const system = { kind: 'system', id: 'myrmidon' } as const
  await runtime.ctx.log.append(id, [
    {
      type: 'colony/created',
      actor: system,
      payload: {
        name: 'Orphan',
        mission: 'm',
        pattern: 'blackboard',
        agents: [{ name: 'a', role: 'worker', model: 'x/y', tools: [] }],
        budget: { wallMs: 600_000 },
      },
    },
    { type: 'colony/started', actor: system, payload: { pid: 2 ** 22 + 12345, hostname: hostname() } },
  ])
  expect(await recoverOrphans(runtime.ctx.log)).toEqual([id])
  const events = await runtime.ctx.log.read(id)
  expect(events.at(-1)?.type).toBe('colony/stopped')
  expect(await recoverOrphans(runtime.ctx.log)).toEqual([])
  // Resumed by this (live) process: the latest start counts, not the dead first one.
  await runtime.ctx.log.append(id, [
    {
      type: 'colony/started',
      actor: system,
      payload: { pid: process.pid, hostname: hostname(), resumed: true },
    },
  ])
  expect(await recoverOrphans(runtime.ctx.log)).toEqual([])
})
