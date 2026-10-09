// A stand-in for Cua Driver's CLI: `serve --embedded --socket <path>` listens on the socket until stopped, `mcp
// --embedded --socket <path>` is a stdio MCP server with the desktop tools computer use calls (answering from a
// made-up desktop: Notes, Safari, Terminal and Messages), and `manifest` prints its version. Every tool call is
// appended to $FAKE_CUA_LOG as a JSON line so tests can check what was asked. Both modes refuse to run unless
// embedded mode is set, as Myrmidon must always set it.
import { appendFileSync, existsSync } from 'node:fs'

const [mode, ...rest] = process.argv.slice(2)
const socket = rest[rest.indexOf('--socket') + 1] ?? ''

if (mode === 'manifest') {
  process.stdout.write(JSON.stringify({ binary_version: '9.9.9', schema_version: '1' }))
  process.exit(0)
}
if (process.env.CUA_DRIVER_EMBEDDED !== '1' || !rest.includes('--embedded')) {
  process.stderr.write('not embedded\n')
  process.exit(3)
}
if (mode === 'serve') {
  Bun.listen({ unix: socket, socket: { data() {} } })
  process.stderr.write(`listening on ${socket}\n`)
  await new Promise(() => {})
}
if (mode !== 'mcp' || !existsSync(socket)) {
  process.stderr.write('no daemon socket\n')
  process.exit(4)
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const APPS = [
  { name: 'Notes', bundle_id: 'com.apple.Notes', pid: 101 },
  { name: 'Safari', bundle_id: 'com.apple.Safari', pid: 102 },
  { name: 'Terminal', bundle_id: 'com.apple.Terminal', pid: 103 },
  { name: 'Messages', bundle_id: 'com.apple.MobileSMS', pid: 104 },
  { name: 'Myrmidon', bundle_id: 'dev.myrmidon.app', pid: 105 },
]
const window = (pid: number) => ({
  window_id: pid * 10,
  pid,
  app_name: APPS.find((a) => a.pid === pid)?.name,
  title: 'Untitled',
  bounds: { x: 100, y: 50, width: 1600, height: 1000 },
  z_index: 3,
  is_on_screen: true,
})
const tool = (name: string, properties: Record<string, unknown> = {}) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties },
})
const tools = [
  tool('list_apps'),
  tool('launch_app', { bundle_id: {} }),
  tool('list_windows', { pid: {} }),
  tool('get_window_state', {
    pid: {},
    window_id: {},
    max_dimension: {},
    max_elements: {},
    include_screenshot: {},
    query: {},
  }),
  tool('click'),
  tool('double_click'),
  tool('right_click'),
  tool('move_cursor'),
  tool('drag'),
  tool('scroll'),
  tool('type_text'),
  tool('press_key'),
  tool('hotkey'),
  tool('zoom'),
  tool('check_permissions'),
]

function answer(name: string, args: Record<string, unknown>) {
  const ok = (text: string, structuredContent?: unknown) => ({
    content: [{ type: 'text', text }],
    ...(structuredContent ? { structuredContent } : {}),
  })
  switch (name) {
    case 'list_apps':
      return ok('apps', { apps: APPS.map((a) => ({ ...a, running: true })) })
    case 'launch_app': {
      const app = APPS.find((a) => a.bundle_id === args.bundle_id)
      if (!app) return { content: [{ type: 'text', text: 'no such app' }], isError: true }
      return ok('launched', { pid: app.pid, bundle_id: app.bundle_id, windows: [window(app.pid)] })
    }
    case 'list_windows':
      return ok('windows', { windows: [window(Number(args.pid))] })
    case 'get_window_state': {
      const edge = Number(args.max_dimension ?? 3200)
      const width = Math.min(edge, 3200)
      const height = Math.round((width * 1000) / 1600)
      const elements = [
        { element_index: 0, role: 'AXTextArea', label: 'Body', frame: { x: 100, y: 100, w: 1600, h: 800 } },
        { element_index: 1, role: 'AXButton', label: 'Send', frame: { x: 1500, y: 950, w: 100, h: 40 } },
      ]
      return {
        content: [
          ...(args.include_screenshot === false ? [] : [{ type: 'image', data: PNG, mimeType: 'image/png' }]),
          { type: 'text', text: `window_id=${args.window_id}` },
        ],
        structuredContent: {
          app_name: APPS.find((a) => a.pid === args.pid)?.name,
          window_title: 'Untitled',
          window_bounds: { x: 100, y: 50, width: 1600, height: 1000 },
          screenshot_width: width,
          screenshot_height: height,
          snapshot_id: 's0000abcd',
          elements,
        },
      }
    }
    case 'zoom':
      return { content: [{ type: 'image', data: PNG, mimeType: 'image/jpeg' }] }
    case 'check_permissions':
      return ok('perms', {
        accessibility: true,
        screen_recording: true,
        source: { attribution: 'host', embedded: true },
      })
    default:
      return ok(`${name} done`)
  }
}

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
        serverInfo: { name: 'cua-driver', version: '9.9.9' },
      })
    else if (msg.method === 'tools/list') reply(msg.id, { tools })
    else if (msg.method === 'tools/call') {
      const name = String(msg.params?.name)
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      if (process.env.FAKE_CUA_LOG)
        appendFileSync(process.env.FAKE_CUA_LOG, `${JSON.stringify({ name, args })}\n`)
      reply(msg.id, answer(name, args))
    } else reply(msg.id, {})
  }
}
