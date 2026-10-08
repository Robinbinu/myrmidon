import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpHub } from '../src/mcp.ts'

const dirs: string[] = []
const hubs: McpHub[] = []
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')

test('an MCP server in mcp.json becomes agent tools, without inheriting our secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myr-mcp-'))
  dirs.push(dir)
  process.env.FAKE_PROVIDER_API_KEY = 'sk-should-not-leak'
  const hub = new McpHub(dir)
  hubs.push(hub)
  await hub.add('echo', { command: 'bun', args: [join(import.meta.dir, 'fixtures', 'echo-mcp.ts')] })
  const [server] = hub.servers()
  expect(server?.status).toBe('connected')
  expect(server?.tools.length).toBe(3)

  const tools = new Map(hub.tools().map((t) => [t.name, t]))
  const echo = [...tools.values()].find((t) => t.name.endsWith('echo'))
  const env = [...tools.values()].find((t) => t.name.endsWith('env'))
  if (!echo || !env) throw new Error('the echo server tools did not load')
  expect(textOf(await echo.execute('c1', { text: 'hi' } as never))).toContain('echo: hi')
  const leaked = textOf(await env.execute('c2', { name: 'FAKE_PROVIDER_API_KEY' } as never))
  expect(leaked).not.toContain('sk-should-not-leak')

  await hub.setEnabled('echo', false)
  expect(hub.servers()[0]?.status).toBe('disabled')
  expect(hub.tools()).toHaveLength(0)
  await hub.remove('echo')
  expect(hub.servers()).toHaveLength(0)
})
