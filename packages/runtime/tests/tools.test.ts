import { expect, test } from 'bun:test'
import type { ColonyHost } from '../src/host.ts'
import { mcpBreaker, similar } from '../src/tools.ts'

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
