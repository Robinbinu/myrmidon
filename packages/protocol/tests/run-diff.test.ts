import { expect, test } from 'bun:test'
import type { MyrEvent } from '../src/index.ts'
import { runDiff } from '../src/index.ts'

function run(model: string, tools: string[], files: Record<string, string>): MyrEvent[] {
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
