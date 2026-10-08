import { expect, test } from 'bun:test'
import type { MyrEvent } from '../src/index.ts'
import { foldColony, reviewVerdicts, runDiff } from '../src/index.ts'

function run(
  model: string,
  tools: string[],
  files: Record<string, string>,
  verdict?: { verifierId: string; pass: boolean; score?: number },
): MyrEvent[] {
  let seq = 0
  const ev = (type: string, payload: Record<string, unknown>) =>
    ({
      id: `e${++seq}`,
      seq,
      colonyId: 'c',
      time: new Date(Date.UTC(2026, 9, 7, 12, 0, seq)).toISOString(),
      type,
      actor: { kind: 'system', id: 'x' },
      trace: { traceId: 't', spanId: 's' },
      schema: 1,
      payload,
    }) as MyrEvent
  return [
    ev('colony/created', {
      name: 'Build it',
      mission: 'Build it',
      pattern: 'lead-workers',
      agents: [{ name: 'lead', role: 'lead', model, tools: [] }],
      acceptance: [],
      budget: { wallMs: 60_000 },
      unsafeNoSandbox: false,
      tier: 'solo',
    }),
    ...tools.map((tool, i) => ev('tool/call', { agent: 'lead', callId: `c${i}`, tool, args: {} })),
    ...Object.entries(files).map(([name, blob]) =>
      ev('artifact/versioned', { name, version: 1, blob, size: 1, author: 'lead', mediaType: 'text/plain' }),
    ),
    ...(verdict ? [ev('verifier/verdict', { target: 'colony', evidence: 'x', ...verdict })] : []),
  ]
}

test('a run diff lines up tools, files and agents of two runs', () => {
  const diff = runDiff(
    { id: 'a', events: run('m/one', ['shell', 'shell', 'fs_read'], { 'app.ts': 'h1', 'notes.md': 'h2' }) },
    {
      id: 'b',
      events: run('m/two', ['shell', 'web_search', 'web_search'], {
        'app.ts': 'h9',
        'notes.md': 'h2',
        'x.css': 'h3',
      }),
    },
  )
  expect(diff.a.models).toEqual(['m/one'])
  expect(diff.b.tier).toBe('solo')
  expect(diff.tools).toEqual([
    { tool: 'web_search', a: 0, b: 2 },
    { tool: 'fs_read', a: 1, b: 0 },
    { tool: 'shell', a: 2, b: 1 },
  ])
  expect(diff.files).toEqual([
    { name: 'app.ts', in: 'both', same: false },
    { name: 'notes.md', in: 'both', same: true },
    { name: 'x.css', in: 'b' },
  ])
  expect(diff.agents).toEqual([
    {
      name: 'lead',
      a: { model: 'm/one', turns: 0, tokens: 0, toolCalls: 3 },
      b: { model: 'm/two', turns: 0, tokens: 0, toolCalls: 3 },
    },
  ])
})

test('a round nobody reviewed has no judge result, while a judged one keeps its verdict', () => {
  const diff = runDiff(
    { id: 'a', events: run('m/one', [], {}, { verifierId: 'delivered', pass: true }) },
    { id: 'b', events: run('m/one', [], {}, { verifierId: 'judge#0', pass: true, score: 0.9 }) },
  )
  expect(diff.a.judge).toBeUndefined()
  expect(diff.b.judge).toEqual({ pass: true, score: 0.9 })
  // The console's verdict list and count, and what agents are told about verification, leave delivery out too.
  const unreviewed = foldColony('a', run('m/one', [], {}, { verifierId: 'delivered', pass: true }))
  expect(unreviewed.verdicts).toHaveLength(1)
  expect(reviewVerdicts(unreviewed)).toEqual([])
})

test('a run side names its task, and a team mode only when the run used a team', () => {
  const withTeam = (tier: string) =>
    run('m/one', [], {}).map((e) =>
      e.type === 'colony/created'
        ? {
            ...e,
            payload: {
              ...(e.payload as object),
              tier,
              team: { mode: 'orchestrated', maxWorkers: 3, workerModels: [] },
            },
          }
        : e,
    ) as MyrEvent[]
  const diff = runDiff({ id: 'a', events: withTeam('solo') }, { id: 'b', events: withTeam('team') })
  expect(diff.a.task).toBe('Build it')
  expect(diff.a.mode).toBeUndefined()
  expect(diff.b.mode).toBe('orchestrated')
})
