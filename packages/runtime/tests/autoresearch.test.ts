import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ColonyState, type EventPayloads, foldColony, type MyrEvent } from '@myrmidon/protocol'
import { createMockModel, type MockContent } from '@oh-my-pi/pi-ai/providers/mock'
import { better, experimentFrom, metricOf } from '../src/autoresearch.ts'
import {
  bootRuntime,
  ChatService,
  detectSandbox,
  ModelResolver,
  ProjectStore,
  type Runtime,
  SettingsStore,
  type TeamConfig,
} from '../src/index.ts'

test('the metric is the METRIC line named, or the only one printed', () => {
  const out = 'building…\nMETRIC ms=12.5\nMETRIC bytes=300\n'
  expect(metricOf(out, 'ms')).toEqual({ name: 'ms', value: 12.5 })
  expect(metricOf(out, 'cpu')).toBeUndefined()
  // Two metrics and none named: which one decides is not for the harness to guess.
  expect(metricOf(out)).toBeUndefined()
  expect(metricOf('METRIC score=0.91')).toEqual({ name: 'score', value: 0.91 })
  expect(metricOf('no metric here')).toBeUndefined()
  expect(better(9, 10, 'lower')).toBe(true)
  expect(better(10, 10, 'lower')).toBe(false)
  expect(better(0.92, 0.91, 'higher')).toBe(true)
})

test("an agent's experiment is read back from the log, so a resumed round carries on", () => {
  const event = (type: string, payload: unknown, seq: number) =>
    ({ type, payload, seq, actor: { kind: 'agent', id: 'lead' } }) as unknown as MyrEvent
  const trial = (n: number, outcome: string, metric: number, best: number) =>
    event(
      'experiment/trial',
      { agent: 'lead', trial: n, description: `t${n}`, outcome, metric, best, ms: 5 },
      n + 2,
    )
  const log = [
    event(
      'experiment/started',
      {
        agent: 'lead',
        measure: 'bench',
        metric: 'ms',
        direction: 'lower',
        trials: 5,
        until: '2030-01-01T00:00:00.000Z',
        branch: 'myr/x/lead',
      },
      1,
    ),
    trial(0, 'baseline', 10, 10),
    trial(1, 'kept', 8, 8),
    trial(2, 'reverted', 9, 8),
    event('experiment/trial', { agent: 'kai', trial: 1, outcome: 'kept', metric: 1, best: 1, ms: 1 }, 6),
  ]
  const exp = experimentFrom(log, 'lead')
  expect(exp).toMatchObject({
    metric: 'ms',
    baseline: 10,
    best: 8,
    runs: 2,
    kept: 1,
    finished: false,
    trials: 5,
  })
  expect(exp?.until).toBe(Date.parse('2030-01-01T00:00:00.000Z'))
  expect(
    experimentFrom([...log, event('experiment/finished', { agent: 'lead', files: [] }, 7)], 'lead')?.finished,
  ).toBe(true)
  expect(experimentFrom(log, 'nobody')).toBeUndefined()
})

let home: string
let runtime: Runtime

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'myr-autoresearch-'))
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

const config: TeamConfig = {
  mode: 'orchestrated',
  leadModel: 'mock/lead',
  roster: [],
  judgeModel: 'mock/judge',
}

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text())
  return (await new Response(p.stdout).text()).trim()
}

async function waitFor(colonyId: string, until: (s: ColonyState) => boolean) {
  for (let i = 0; i < 400; i++) {
    const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
    if (until(s)) return s
    await Bun.sleep(50)
  }
  throw new Error('colony did not reach the expected state')
}

test.skipIf(detectSandbox().kind === 'none')(
  'an experiment loop on its own branch keeps what measures better, reverts the rest, and brings the kept change in',
  async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'myr-autoresearch-project-')))
    try {
      writeFileSync(join(folder, 'size.txt'), '10\n')
      await git(folder, 'init', '-q')
      await git(folder, 'add', '-A')
      await git(folder, 'commit', '-q', '-m', 'start')
      const projects = new ProjectStore(home)
      const project = projects.add(folder)
      const measure = 'echo "METRIC size=$(cat size.txt)"'
      const script: MockContent[][] = [
        [tool('autoresearch', { action: 'start', measure, direction: 'lower', trials: 3, minutes: 5 })],
        [tool('fs_write', { path: 'size.txt', content: '6\n' })],
        [tool('autoresearch', { action: 'trial', description: 'smaller' })],
        [tool('fs_write', { path: 'size.txt', content: '8\n' })],
        [tool('autoresearch', { action: 'trial', description: 'bigger again' })],
        [tool('fs_write', { path: 'size.txt', content: 'oops\n' })],
        [tool('autoresearch', { action: 'trial', description: 'broken measure' })],
        // Every trial is used: a fourth is refused.
        [tool('autoresearch', { action: 'trial', description: 'one more' })],
        [tool('autoresearch', { action: 'finish' })],
        [tool('reply_user', { text: 'Smaller now.', final: true })],
      ]
      let call = 0
      const resolver = new ModelResolver()
      const lead = createMockModel({ handler: () => ({ content: script[call++] ?? ['ok'] }) })
      resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
      const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "ok"}'] }) })
      resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
      const settings = new SettingsStore(home)
      const chats = new ChatService(runtime, { resolver, settings, projects })
      const { colonyId } = await chats.send(
        'Make size.txt smaller with an autoresearch loop',
        config,
        undefined,
        {
          project: project.id,
        },
      )
      await waitFor(colonyId, (s) => s.status !== 'running' && s.status !== 'created')
      const events = await runtime.ctx.log.read(colonyId as never)
      const of = <T extends keyof EventPayloads>(type: T) =>
        events.filter((e) => e.type === type).map((e) => e.payload as EventPayloads[T])
      const results = of('tool/result').filter((r) => r.tool === 'autoresearch')
      expect(results.map((r) => r.ok)).toEqual([true, true, true, true, false, true])
      expect(results[0]?.output).toContain('Baseline size = 10')
      expect(results[4]?.output).toContain('all 3 trials are used')
      expect(of('experiment/started')).toEqual([
        expect.objectContaining({ agent: 'lead', metric: 'size', direction: 'lower', trials: 3, measure }),
      ])
      expect(of('experiment/trial').map((t) => [t.trial, t.outcome, t.metric, t.best])).toEqual([
        [0, 'baseline', 10, 10],
        [1, 'kept', 6, 6],
        [2, 'reverted', 8, 6],
        [3, 'failed', undefined, 6],
      ])
      // The kept trial is a commit on the agent's branch; the rest left no trace there.
      const kept = of('experiment/trial')[1]?.commit ?? ''
      expect(await git(folder, 'log', '-1', '--format=%s', kept)).toBe('autoresearch trial 1: smaller')
      expect(of('experiment/finished')).toEqual([
        { agent: 'lead', trials: 3, kept: 1, baseline: 10, best: 6, files: ['size.txt'] },
      ])
      // Only the kept change reached the project; the person's own history is untouched.
      expect(readFileSync(join(folder, 'size.txt'), 'utf8')).toBe('6\n')
      expect(await git(folder, 'log', '--format=%s')).toBe('start')
      await chats.stopAll()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  },
)

test('autoresearch is offered only in a project whose changes need no approval', async () => {
  const { toolsFor } = await import('../src/patterns.ts')
  const lead = { name: 'lead', role: 'lead', model: 'mock/lead' }
  const spec = (preset: 'auto' | 'ask' | 'full', project = true) =>
    ({
      name: 'c',
      mission: 'm',
      pattern: 'lead-workers',
      agents: [lead],
      acceptance: [],
      budget: { wallMs: 60_000, maxTurns: 5 },
      observer: { intervalMs: 30_000 },
      tier: 'solo',
      permissions: { global: { preset, rules: [] } },
      chat: {
        chatId: 'c',
        round: 1,
        request: 'r',
        history: '',
        ...(project ? { project: { id: 'p', name: 'p', path: '/tmp/p' } } : {}),
      },
    }) as never
  expect(toolsFor(spec('auto'), lead)).toContain('autoresearch')
  expect(toolsFor(spec('full'), lead)).toContain('autoresearch')
  expect(toolsFor(spec('ask'), lead)).not.toContain('autoresearch')
  expect(toolsFor(spec('auto', false), lead)).not.toContain('autoresearch')
})
