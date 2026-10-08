import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MyrEvent } from '@myrmidon/protocol'
import { PluginHost } from '../src/plugin-host.ts'
import { PluginStore } from '../src/plugins.ts'

let dir: string
let home: string
let store: PluginStore
let host: PluginHost

const code = (greeting: string) => `
export function activate(ctx) {
  ctx.tools.add({
    name: 'greet',
    description: 'Greets someone',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: (args, call) => \`\${ctx.settings.get().greeting ?? '${greeting}'}, \${args.name} (from \${call.agent})\`,
  })
  ctx.prompts.add('Greetings', 'Always greet warmly.', 'lead')
  ctx.events.on('chat/reply', (event) => ctx.log(\`saw a reply from \${event.payload.agent}\`))
  ctx.onDispose(() => Bun.write(ctx.dir + '/disposed', 'yes'))
}
`

function plugin(name: string, source: string, settings?: object) {
  const at = join(home, 'plugins', name)
  mkdirSync(join(at, 'server'), { recursive: true })
  writeFileSync(join(at, 'server', 'index.ts'), source)
  if (settings) writeFileSync(join(at, 'myrmidon.json'), JSON.stringify({ settings }))
  return at
}

const call = { colonyId: 'c1', agent: 'lead' }
const run = async (h: PluginHost, args: object) => {
  const tool = h.tools(call)[0]
  const r = await tool?.execute('call-1', args as never)
  return (r?.content[0] as { text: string } | undefined)?.text
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-plugin-host-'))
  home = join(dir, 'home')
  store = new PluginStore(home)
  host = new PluginHost(store)
})

afterEach(async () => {
  await host.stop()
  rmSync(dir, { recursive: true, force: true })
})

test("a plugin's code adds a tool, a prompt section and a listener, and reads its settings", async () => {
  plugin('nova', code('Hello'), { greeting: { type: 'string', default: 'Hello' } })
  await host.start()
  expect(host.status('nova')).toMatchObject({ loaded: true, tools: ['nova_greet'] })
  expect(host.tools(call).map((t) => t.name)).toEqual(['nova_greet'])
  expect(await run(host, { name: 'Ana' })).toBe('Hello, Ana (from lead)')

  // Settings are read when the tool runs, so a change applies at once.
  store.setSettings('nova', { greeting: 'Welcome' })
  expect(await run(host, { name: 'Ana' })).toBe('Welcome, Ana (from lead)')
  expect(() => store.setSettings('nova', { greeting: 3 })).toThrow('must be a string')
  expect(() => store.setSettings('nova', { colour: 'red' })).toThrow('no setting called colour')

  expect(host.prompts('lead')).toEqual(['## Greetings\nAlways greet warmly.'])
  expect(host.prompts('worker')).toEqual([])

  host.dispatch('c1', [{ type: 'chat/reply', payload: { agent: 'lead' } } as unknown as MyrEvent])
  await Bun.sleep(20)
  expect(host.status('nova').log.join('\n')).toContain('saw a reply from lead')
})

test('editing the code reloads the plugin; switching it off removes everything it added', async () => {
  const at = plugin('nova', code('Hello'))
  await host.start()
  expect(await run(host, { name: 'Ana' })).toBe('Hello, Ana (from lead)')

  writeFileSync(join(at, 'server', 'index.ts'), code('Hi').replace("'greet'", "'wave'"))
  // File events can take seconds to arrive on a busy machine.
  for (let i = 0; i < 300 && host.tools(call)[0]?.name !== 'nova_wave'; i++) await Bun.sleep(50)
  expect(host.tools(call).map((t) => t.name)).toEqual(['nova_wave'])
  expect(await run(host, { name: 'Ana' })).toBe('Hi, Ana (from lead)')
  // The old version cleaned up after itself before the new one loaded.
  expect(existsSync(join(at, 'disposed'))).toBe(true)

  store.setEnabled('nova', false)
  await host.sync()
  expect(host.tools(call)).toEqual([])
  expect(host.prompts('lead')).toEqual([])
  expect(host.status('nova').loaded).toBe(false)
}, 30_000)

/** A plugin that counts its activations in a file of its own. */
const counting = `
import { appendFileSync } from 'node:fs'
export function activate(ctx) {
  appendFileSync(ctx.dir + '/activations', 'x')
  ctx.tools.add({ name: 'greet', description: 'Greets', run: () => 'hi' })
}
`
const activations = (at: string) =>
  existsSync(join(at, 'activations')) ? readFileSync(join(at, 'activations'), 'utf8').length : 0

test('starting loads a plugin once: file events from before the watch began do not reload it', async () => {
  const at = plugin('nova', counting)
  await host.start()
  // Past the reload debounce and the file system's own delay in reporting.
  await Bun.sleep(1500)
  expect(activations(at)).toBe(1)
})

test('overlapping reloads of one plugin run one after another and leave one working copy', async () => {
  const at = plugin('nova', counting)
  await host.start()
  const info = store.list().find((p) => p.name === 'nova')
  if (!info) throw new Error('no plugin')
  await Promise.all([host.load(info), host.load(info), host.load(info)])
  expect(host.status('nova')).toMatchObject({ loaded: true, tools: ['nova_greet'] })
  expect(host.status('nova').error).toBeUndefined()
  expect(activations(at)).toBe(4)
})

test('a plugin that fails to load is reported and leaves the others working', async () => {
  plugin('broken', 'export function activate() { throw new Error("no API key set") }')
  plugin('nova', code('Hello'))
  plugin('empty', 'export const nothing = 1')
  await host.start()
  expect(host.status('broken')).toMatchObject({ loaded: false, error: 'no API key set' })
  expect(host.status('empty').error).toContain('activate(ctx)')
  expect(host.tools(call).map((t) => t.name)).toEqual(['nova_greet'])
})

test('a tool can fail by throwing or by returning an error; both reach the agent as errors', async () => {
  plugin(
    'nova',
    `export function activate(ctx) {
      ctx.tools.add({ name: 'fail', description: 'Fails', run: () => { throw new Error('rate limited') } })
      ctx.tools.add({ name: 'soft', description: 'Fails softly', run: () => ({ text: 'not found', isError: true }) })
    }`,
  )
  await host.start()
  const [fail, soft] = host.tools(call)
  // A throw goes up to the colony's tool wrapper, which hands it to the agent as an ERROR result.
  await expect(fail?.execute('1', {} as never)).rejects.toThrow('rate limited')
  expect(await soft?.execute('2', {} as never)).toMatchObject({
    isError: true,
    content: [{ text: 'not found' }],
  })
})
