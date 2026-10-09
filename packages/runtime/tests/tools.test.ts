import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MyrEvent } from '@myrmidon/protocol'
import { clockTime, localDate } from '../src/clock.ts'
import { READ_LOG_RESULT_CHARS } from '../src/config.ts'
import type { ColonyHost } from '../src/host.ts'
import {
  flowStepFailure,
  logEntry,
  logLines,
  matchTools,
  mcpBreaker,
  readRange,
  similar,
  sniffImage,
  TOOL_DEFS,
} from '../src/tools.ts'

test('fs_read reads a range of lines, cuts at a whole line under the cap, and says how to read on', () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
  // A whole file that fits comes back unchanged, so fs_edit snippets can be copied from it.
  expect(readRange(text)).toBe(text)
  expect(readRange(`${text}\n`)).toBe(`${text}\n`)
  expect(readRange(text, 3, 2)).toBe(
    '(lines 3-4 of 10)\nline 3\nline 4\n… lines 5-10 not shown: fs_read with offset: 5 reads on.',
  )
  expect(readRange(text, 9)).toBe('(lines 9-10 of 10)\nline 9\nline 10')
  // Over the cap, the cut falls at a line boundary and names where to go on.
  expect(readRange(text, 1, undefined, 21)).toBe(
    '(lines 1-3 of 10)\nline 1\nline 2\nline 3\n… lines 4-10 not shown: fs_read with offset: 4 reads on.',
  )
  // One line longer than the cap is cut rather than skipped.
  expect(readRange('x'.repeat(50), 1, undefined, 10)).toBe('(lines 1-1 of 1)\nxxxxxxxxxx…')
  expect(() => readRange(text, 11)).toThrow('offset 11 is past the end: the file has 10 lines')
  expect(() => readRange(text, 0)).toThrow('offset is a line number')
  expect(() => readRange(text, 1, 0)).toThrow('limit is a number of lines')
})

test('the fs_read tool passes offset and limit through to the file it resolves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myr-read-'))
  try {
    writeFileSync(join(dir, 'notes.md'), 'a\nb\nc\nd\n')
    const host = {
      workspace: { resolveForRead: (_: string, p: string) => join(dir, p) },
    } as unknown as ColonyHost
    const read = TOOL_DEFS.find((d) => d.name === 'fs_read')
    expect(await read?.run({ path: 'notes.md', offset: 2, limit: 2 }, 'kai', host)).toBe(
      '(lines 2-3 of 4)\nb\nc\n… lines 4-4 not shown: fs_read with offset: 4 reads on.',
    )
    expect(await read?.run({ path: 'notes.md' }, 'kai', host)).toBe('a\nb\nc\nd\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

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

/** Runs `fn` with the process in time zone `zone`, as if the person lived there. */
function inZone<T>(zone: string, fn: () => T): T {
  // Set back, never deleted: once TZ is deleted, Bun ignores later changes to it.
  const before = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  process.env.TZ = zone
  try {
    return fn()
  } finally {
    process.env.TZ = before
  }
}

const ev = (seq: number, type: string, payload: Record<string, unknown>, second: number) =>
  ({
    seq,
    type,
    payload,
    time: `2026-10-07T12:00:${String(second).padStart(2, '0')}.000Z`,
  }) as unknown as MyrEvent

test('read_log shows each call with what it returned, filtered by agent or tool, and one entry in full', () => {
  const long = `PASS ${'x'.repeat(READ_LOG_RESULT_CHARS)}\n2/2 PASS`
  const events = [
    ev(1, 'tool/call', { agent: 'kai', callId: 'c1', tool: 'shell', args: { command: 'bun test' } }, 1),
    ev(
      2,
      'tool/call',
      { agent: 'nova', callId: 'c1', tool: 'web_fetch', args: { url: 'https://example.org' } },
      2,
    ),
    ev(
      3,
      'tool/result',
      { agent: 'kai', callId: 'c1', tool: 'shell', ok: true, output: 'exit 1\n3 fail' },
      3,
    ),
    ev(
      4,
      'tool/result',
      { agent: 'nova', callId: 'c1', tool: 'web_fetch', ok: false, output: 'ERROR: 404' },
      4,
    ),
    ev(5, 'task/changed', { by: 'kai', task: { id: 'task-1', status: 'submitted' } }, 5),
    ev(6, 'tool/call', { agent: 'kai', callId: 'c2', tool: 'shell', args: { command: 'bun test b' } }, 6),
    ev(7, 'tool/result', { agent: 'kai', callId: 'c2', tool: 'shell', ok: true, output: long }, 7),
  ]
  inZone('UTC', () => {
    const lines = logLines(events, {})
    expect(lines.slice(0, 3)).toEqual([
      '#1 12:00:01 kai shell({"command":"bun test"}) → ok\n  exit 1\n  3 fail',
      '#2 12:00:02 nova web_fetch({"url":"https://example.org"}) → FAILED\n  ERROR: 404',
      '#5 12:00:05 kai task-1 → submitted',
    ])
    // A long result is cut, and says how to see the rest; the entry shows it whole.
    expect(lines[3]).toContain(`more chars: read_log(entry: 6)`)
    expect(lines[3]).not.toContain('2/2 PASS')
    expect(logEntry(events, 6)).toContain('2/2 PASS')
    expect(logEntry(events, 6)).toContain('"command": "bun test b"')
    expect(() => logEntry(events, 99)).toThrow('no entry #99')
    expect(logLines(events, { agent: 'kai', tool: 'shell' })[0]).toBe(
      '#1 12:00:01 kai shell({"command":"bun test"}) → ok\n  exit 1\n  3 fail',
    )
  })
})

test('agents see every time in one zone, the one their prompt names', async () => {
  const { systemPrompt } = await import('../src/prompt/assemble.ts')
  const { parseColonySpec } = await import('../src/spec.ts')
  const spec = parseColonySpec({ name: 'Zone', mission: 'x', agents: [{ name: 'a', model: 'm' }] })
  const agent = spec.agents[0] as (typeof spec.agents)[number]
  inZone('Asia/Kolkata', () => {
    const prompt = systemPrompt(spec, agent, { sandbox: 'none', web: false, browser: false }).join('\n')
    expect(prompt).toMatch(/time zone, Asia\/(Kolkata|Calcutta) \(UTC\+05:30\)/)
    // 12:00:01 UTC is 17:30:01 there: read_log says so, not the UTC time.
    expect(logLines(events(), {})[0]).toStartWith('#1 17:30:01 kai')
    expect(clockTime('2026-10-07T12:00:01.000Z')).toBe('17:30:01')
    expect(localDate('2026-10-07T20:00:00.000Z')).toBe('2026-10-08')
  })
  function events() {
    return [ev(1, 'tool/call', { agent: 'kai', callId: 'c1', tool: 'shell', args: {} }, 1)]
  }
})

test('find_tools loads every tool a query names, and names the ones it matched but did not load', () => {
  const BROWSER = Array.from({ length: 14 }, (_, i) => `browser_${i}`)
  const tools = [
    ...BROWSER.map((name) => ({ name, description: `Browser action ${name}.` })),
    { name: 'browser_type', description: 'Type into a field.' },
    { name: 'browser_upload', description: 'Choose a file for an upload field.' },
    { name: 'read_log', description: 'Read what agents did.' },
    { name: 'request_login', description: 'Ask the person to sign in to a site in your browser.' },
    { name: 'start_server', description: 'Start a dev server.' },
    { name: 'server_logs', description: 'A server output.' },
    { name: 'create_tool', description: 'Make a reusable tool.' },
  ] as unknown as Parameters<typeof matchTools>[0]
  const names = (r: ReturnType<typeof matchTools>) => ({
    found: r.found.map((t) => t.name).sort(),
    more: r.more.map((t) => t.name),
  })
  const browser = names(matchTools(tools, 'browser read_log'))
  // All 16 browser tools and read_log, past any limit: browser_type and browser_upload included.
  expect(browser.found).toEqual([...BROWSER, 'browser_type', 'browser_upload', 'read_log'].sort())
  // A tool that only mentions the browser is named, not silently dropped.
  expect(browser.more).toEqual(['request_login'])
  expect(names(matchTools(tools, 'dev server')).found).toEqual(['server_logs', 'start_server'])
  expect(names(matchTools(tools, 'make a tool')).found).toEqual(['create_tool'])
  expect(names(matchTools(tools, 'request_login')).found).toEqual(['request_login'])
  // Matching descriptions only: capped, and the rest are named.
  const capped = names(matchTools(tools, 'action', 5))
  expect(capped.found).toHaveLength(5)
  expect(capped.more).toHaveLength(9)
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
