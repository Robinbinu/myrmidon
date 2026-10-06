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
