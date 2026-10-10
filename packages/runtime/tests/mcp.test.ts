import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpHub } from '../src/mcp.ts'

const dirs: string[] = []
const hubs: McpHub[] = []
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  // Bun runs every test file in one process, so a key set here would reach every later file.
  delete process.env.FAKE_PROVIDER_API_KEY
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
  // Each tool knows its server, for permission rules that name a whole server.
  expect(hub.serverOf(echo.name)).toBe('echo')
  expect(hub.toolList().every((t) => t.server === 'echo')).toBe(true)
  expect(hub.serverOf('mcp__other_tool')).toBeUndefined()

  await hub.setEnabled('echo', false)
  expect(hub.servers()[0]?.status).toBe('disabled')
  expect(hub.tools()).toHaveLength(0)
  await hub.remove('echo')
  expect(hub.servers()).toHaveLength(0)
})

test("names in Myrmidon's own namespace are refused, so no server hides or stands in for the computer-use driver", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myr-mcp-'))
  dirs.push(dir)
  const echo = { command: 'bun', args: [join(import.meta.dir, 'fixtures', 'echo-mcp.ts')] }
  // One written into mcp.json by hand (or imported), and one a plugin adds.
  // omp folds runs of `_` and trims them at the ends, so these name tools `mcp__myrmidon_…` too.
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify({ mcpServers: { myrmidon_computer: echo, _myrmidon_computer: echo } }),
  )
  const hub = new McpHub(dir, () => ({ 'myrmidon-computer-extra': echo, '-myrmidon-x': echo }))
  hubs.push(hub)
  for (const name of ['myrmidon-computer', 'myrmidon_computer', 'Myrmidon.Computer-2', 'myrmidon'])
    await expect(hub.add(name, echo)).rejects.toThrow(/reserved for Myrmidon/)
  await hub.setInternal('myrmidon-computer', echo)

  expect(hub.servers().map((s) => [s.name, s.status, s.error?.includes('reserved for Myrmidon')])).toEqual([
    ['myrmidon_computer', 'error', true],
    ['_myrmidon_computer', 'error', true],
    ['myrmidon-computer-extra', 'error', true],
    ['-myrmidon-x', 'error', true],
  ])
  expect(hub.tools()).toHaveLength(0)
  expect(hub.internalTool('myrmidon-computer', 'echo')).toBeDefined()
  // A name just outside it is anyone's.
  await hub.add('myrmidonx', echo)
  expect(hub.tools().map((t) => t.name)).toContain('mcp__myrmidonx_echo')
  // Myrmidon's own servers keep to the namespace too.
  await expect(hub.setInternal('computer', echo)).rejects.toThrow(/myrmidon/)
})
