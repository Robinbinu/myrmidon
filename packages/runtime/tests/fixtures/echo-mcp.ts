// A minimal stdio MCP server for tests: `echo` (marked read-only), `shout` (not marked, so it may change things),
// and `env` to show what the process inherited.
const tools = [
  {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'shout',
    description: 'Shout the text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'env',
    description: 'Report an environment variable.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
]

const reply = (id: unknown, result: unknown) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)

let buffer = ''
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  let nl = buffer.indexOf('\n')
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    nl = buffer.indexOf('\n')
    if (!line) continue
    const msg = JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown> }
    if (msg.id === undefined) continue
    if (msg.method === 'initialize')
      reply(msg.id, {
        protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo', version: '1.0.0' },
      })
    else if (msg.method === 'tools/list') reply(msg.id, { tools })
    else if (msg.method === 'tools/call') {
      const args = (msg.params?.arguments ?? {}) as Record<string, string>
      const text =
        msg.params?.name === 'echo'
          ? `echo: ${args.text}`
          : msg.params?.name === 'shout'
            ? `${args.text?.toUpperCase()}!`
            : `${args.name}=${process.env[args.name ?? ''] ?? '(unset)'}`
      reply(msg.id, { content: [{ type: 'text', text }] })
    } else reply(msg.id, {})
  }
}

export {}
