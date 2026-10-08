import { expect, test } from 'bun:test'
import type { MyrEvent } from '@myrmidon/protocol'
import type { ColonyHost } from '../src/host.ts'
import { flowStepFailure, logLines, mcpBreaker, similar, sniffImage } from '../src/tools.ts'

test('task dedupe catches rewordings but not numbered siblings', () => {
  expect(similar('Research Flask in depth', 'Research Flask in depth: stats and features')).toBeGreaterThan(
    0.3,
  )
  expect(similar('Write the Flask example app', 'Write a Flask example app')).toBe(1)
  expect(similar('Write example app for framework #1', 'Write example app for framework #2')).toBe(0)
  expect(similar('Write example app for framework #1', 'Write example app for second-ranked framework')).toBe(
    0,
  )
  expect(similar('Compare bundler speed', 'Write the final report')).toBe(0)
})

test('an MCP server that keeps failing is switched off for the round, and success resets it', () => {
  const host = {} as ColonyHost
  const fail = { content: [{ type: 'text' as const, text: 'ERROR: 401 bad api key' }], isError: true }
  const ok = { content: [{ type: 'text' as const, text: 'fine' }] }
  const stagehand = () => mcpBreaker(host, 'mcp__stagehand_browserbase_act')
  stagehand()?.record(fail)
  stagehand()?.record(fail)
  stagehand()?.record(ok)
  stagehand()?.record(fail)
  stagehand()?.record(fail)
  expect(stagehand()?.refusal()).toBeUndefined()
  stagehand()?.record(fail)
  expect(stagehand()?.refusal()).toContain('401 bad api key')
  // Other servers, other colonies and harness tools are unaffected.
  expect(mcpBreaker(host, 'mcp__github_search')?.refusal()).toBeUndefined()
  expect(mcpBreaker({} as ColonyHost, 'mcp__stagehand_browserbase_act')?.refusal()).toBeUndefined()
  expect(mcpBreaker(host, 'web_fetch')).toBeUndefined()
})

test('read_log lists what agents did, filtered by agent or tool, with each call matched to its outcome', () => {
  const ev = (type: string, payload: Record<string, unknown>, second: number) =>
    ({
      type,
      payload,
      time: `2026-10-07T12:00:${String(second).padStart(2, '0')}.000Z`,
    }) as unknown as MyrEvent
  const events = [
    ev('tool/call', { agent: 'kai', callId: 'c1', tool: 'shell', args: { command: 'bun test' } }, 1),
    ev(
      'tool/call',
      { agent: 'nova', callId: 'c1', tool: 'web_fetch', args: { url: 'https://example.org' } },
      2,
    ),
    ev('tool/result', { agent: 'kai', callId: 'c1', tool: 'shell', ok: true, output: 'exit 1\n3 fail' }, 3),
    ev('tool/result', { agent: 'nova', callId: 'c1', tool: 'web_fetch', ok: false, output: 'ERROR: 404' }, 4),
    ev('task/changed', { by: 'kai', task: { id: 'task-1', status: 'submitted' } }, 5),
  ]
  expect(logLines(events, {})).toEqual([
    '12:00:01 kai shell({"command":"bun test"}) → ok: exit 1',
    '12:00:02 nova web_fetch({"url":"https://example.org"}) → FAILED: ERROR: 404',
    '12:00:05 kai task-1 → submitted',
  ])
  expect(logLines(events, { agent: 'kai', tool: 'shell' })).toEqual([
    '12:00:01 kai shell({"command":"bun test"}) → ok: exit 1',
  ])
})

test('a request that plainly needs the browser or a dev server starts with those tools loaded', async () => {
  const { preloaded } = await import('../src/patterns.ts')
  const names = ['fs_read', 'browser_open', 'browser_click', 'request_login', 'start_server', 'server_logs']
  expect(preloaded('Open https://example.com and read the heading', names)).toEqual([
    'browser_open',
    'browser_click',
    'request_login',
  ])
  expect(preloaded('Start the dev server and check the home page', names)).toEqual([
    'start_server',
    'server_logs',
  ])
  expect(preloaded('Summarize this text for me', names)).toEqual([])
})

test('MCP tools ask first unless their server marks them read-only; the person can allow, ask or turn off each', async () => {
  const { needsApproval } = await import('../src/tools.ts')
  const none = {}
  expect(needsApproval(none, 'mcp__notes_list', true)).toBe(false)
  expect(needsApproval(none, 'mcp__notes_delete', false)).toBe(true)
  expect(needsApproval(none, 'web_search', false)).toBe(false)
  // A rule for one tool beats the rule for every MCP tool, which beats the read-only default.
  expect(needsApproval({ allowTools: ['mcp__notes_delete'] }, 'mcp__notes_delete', false)).toBe(false)
  expect(needsApproval({ askTools: ['mcp__notes_list'] }, 'mcp__notes_list', true)).toBe(true)
  expect(needsApproval({ askTools: ['mcp'] }, 'mcp__notes_list', true)).toBe(true)
  expect(needsApproval({ allowTools: ['mcp'] }, 'mcp__notes_delete', false)).toBe(false)
  expect(needsApproval({ askTools: ['mcp'], allowTools: ['mcp__notes_list'] }, 'mcp__notes_list', true)).toBe(
    false,
  )
  expect(needsApproval({ askTools: ['shell'] }, 'shell', false)).toBe(true)
  // A round someone else started asks for everything that is not read-only, even what the person allowed.
  expect(needsApproval({ askAll: true, allowTools: ['shell'] }, 'shell', false)).toBe(true)
  expect(needsApproval({ askAll: true, allowTools: ['mcp'] }, 'mcp__notes_delete', false)).toBe(true)
  expect(needsApproval({ askAll: true }, 'fs_read', true)).toBe(false)
})

test('a failed browser-flow step reports its own error even when the page can no longer be read', async () => {
  const step = { click: 'text=No such button' }
  const gone = await flowStepFailure(1, step, new Error('no element matches'), () =>
    Promise.reject(new Error('Protocol error (Accessibility.getFullAXTree): Session closed')),
  )
  expect(gone).toStartWith('step 2 ({"click":"text=No such button"}) failed: no element matches\n')
  expect(gone).toContain('the page could not be read: Protocol error')
  const read = await flowStepFailure(0, step, 'timeout', async () => 'url: http://x/')
  expect(read).toBe('step 1 ({"click":"text=No such button"}) failed: timeout\nurl: http://x/')
})

test('a picture is served as one only when its bytes are one, whatever it is called', () => {
  expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image/png')
  expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
  expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
  // SVG can carry script: never served as an image.
  expect(sniffImage(new TextEncoder().encode('<svg onload="alert(1)"/>'))).toBeUndefined()
  expect(sniffImage(new TextEncoder().encode('just text'))).toBeUndefined()
})
