import { expect, test } from 'bun:test'
import type { MyrEvent } from '../src/index.ts'
import { auditOf } from '../src/index.ts'

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

const call = (agent: string, callId: string, tool: string, args: unknown, ok?: boolean) => [
  ev('tool/call', { agent, callId, tool, args }),
  ...(ok === undefined ? [] : [ev('tool/result', { agent, callId, tool, ok, output: '' })]),
]

test('the audit lists the files, URLs and commands each agent touched, grouped by target', () => {
  const audit = auditOf([
    ...call('lead', 'c1', 'fs_read', { path: 'src/app.ts' }, true),
    ...call('worker', 'c2', 'fs_edit', { path: 'src/app.ts', old: 'a', new: 'b' }, true),
    ...call('worker', 'c3', 'shell', { command: 'bun test' }, false),
    ...call('lead', 'c4', 'web_fetch', { url: 'https://example.com/docs' }, true),
    ...call('lead', 'c5', 'web_search', { query: 'bun sqlite' }, true),
    ...call('lead', 'c6', 'grep', { pattern: 'TODO', path: 'src' }, true),
    ...call('worker', 'c7', 'browser_open', { url: 'https://example.com/docs' }),
    ...call('lead', 'c8', 'publish_artifact', { name: 'index.html', fromScratch: 'index.html' }, true),
    ...call('lead', 'c9', 'update_todo', { items: [] }, true),
  ])
  expect(audit.entries.map((e) => [e.kind, e.action, e.target])).toEqual([
    ['file', 'read', 'src/app.ts'],
    ['file', 'edit', 'src/app.ts'],
    ['command', 'run', 'bun test'],
    ['url', 'fetch', 'https://example.com/docs'],
    ['search', 'search', 'bun sqlite'],
    ['file', 'search', 'src · TODO'],
    ['url', 'open', 'https://example.com/docs'],
    ['file', 'publish', 'artifact:index.html'],
    ['other', 'call', 'update_todo {"items":[]}'],
  ])
  expect(audit.entries.find((e) => e.tool === 'browser_open')?.ok).toBeUndefined()
  const file = audit.targets.find((t) => t.target === 'src/app.ts')
  expect(file).toMatchObject({
    kind: 'file',
    actions: ['read', 'edit'],
    agents: ['lead', 'worker'],
    count: 2,
  })
  const url = audit.targets.find((t) => t.target === 'https://example.com/docs')
  expect(url).toMatchObject({ actions: ['fetch', 'open'], count: 2, failed: 0 })
  expect(audit.targets.find((t) => t.target === 'bun test')?.failed).toBe(1)
  // Newest first.
  expect(audit.targets[0]?.target).toBe('update_todo {"items":[]}')
})

test('the audit keeps what the person, a hook or the safety check stopped', () => {
  const audit = auditOf([
    ev('approval/requested', { id: 'a1', agent: 'lead', tool: 'shell', summary: 'rm -rf build' }),
    ev('approval/decided', { id: 'a1', approved: false, by: 'person' }),
    ev('approval/requested', { id: 'a2', agent: 'lead', tool: 'fs_write', summary: 'write x' }),
    ev('approval/decided', { id: 'a2', approved: true, by: 'person' }),
    ev('approval/requested', { id: 'a3', agent: 'lead', tool: 'shell', summary: 'ls' }),
    ev('approval/decided', { id: 'a3', approved: false, by: 'stopped' }),
    ev('hook/ran', {
      event: 'PreToolUse',
      agent: 'worker',
      tool: 'fs_edit',
      command: 'deny-env.sh',
      code: 2,
      ms: 3,
      outcome: 'blocked',
      message: 'no .env edits',
    }),
    ev('safety/flagged', {
      agent: 'worker',
      tool: 'web_fetch',
      reason: 'followed page text',
      source: 'x.com',
    }),
  ])
  expect(audit.stops.map((s) => [s.by, s.agent, s.tool, s.why])).toEqual([
    ['person', 'lead', 'shell', 'rm -rf build'],
    ['hook', 'worker', 'fs_edit', 'no .env edits'],
    ['safety', 'worker', 'web_fetch', 'followed page text'],
  ])
})

test("a stopped round's outside effects: commands, changing MCP calls and page actions, not reads or failures", async () => {
  const { outsideEffects, describeEffect } = await import('../src/index.ts')
  const effects = outsideEffects([
    ...call('lead', 'e1', 'fs_write', { path: 'notes.md', content: 'x' }, true),
    ...call('lead', 'e2', 'shell', { command: 'npm publish' }, true),
    ...call('lead', 'e3', 'shell', { command: 'bad' }, false),
    ...call('lead', 'e4', 'web_fetch', { url: 'https://example.com' }, true),
    ...call('lead', 'e5', 'mcp__github_create_issue', { title: 'Bug' }, true),
    ev('tool/call', {
      agent: 'lead',
      callId: 'e6',
      tool: 'mcp__github_list_issues',
      args: {},
      readOnly: true,
    }),
    ...call('lead', 'e7', 'browser_act', { steps: [{ click: '1_5' }] }, true),
    ...call('lead', 'e8', 'shell', { command: 'deploy.sh' }),
  ])
  expect(effects.map(describeEffect)).toEqual([
    'ran `npm publish`',
    'called mcp__github_create_issue {"title":"Bug"}',
    'act on a web page {"steps":[{"click":"1_5"}]}',
    'ran `deploy.sh` (still running when it stopped)',
  ])
})
