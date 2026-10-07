import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import type { PluginInfo, PluginStore } from './plugins.ts'
import type { Sandbox } from './sandbox.ts'

/**
 * Plugins agents build when the person asks for a feature of Myrmidon itself: a draft written into the plugins
 * folder switched off, checked in the OS sandbox (its code never runs in Myrmidon's process before the person
 * says yes), then proposed to the person, who switches it on.
 */

const NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/
/** The only places a plugin's files go: Claude Code's parts and Myrmidon's. */
const PARTS =
  /^(\.claude-plugin\/plugin\.json|\.mcp\.json|myrmidon\.json|README\.md|(skills|commands|hooks|server|ui)\/.+)$/
/** Marks a draft and the round that made it, so only that round can rewrite it. */
const DRAFT = '.draft'

/** Writes (or rewrites) a draft plugin; it stays switched off until the person approves it. */
export function writeDraft(
  store: PluginStore,
  colonyId: string,
  input: { name: string; description: string; files: Record<string, string> },
): PluginInfo {
  if (!NAME.test(input.name)) throw new Error('name must be lowercase letters, digits and dashes')
  const dir = join(store.dir, input.name)
  const files = { ...input.files }
  files['.claude-plugin/plugin.json'] ??= `${JSON.stringify(
    {
      name: input.name,
      version: '0.1.0',
      description: input.description,
      author: { name: 'Myrmidon agent' },
    },
    null,
    2,
  )}\n`
  // Every path is checked before anything on disk changes, so a bad one cannot cost the draft that is there.
  const writes = Object.entries(files).map(([path, content]) => {
    const clean = normalize(path).replaceAll('\\', '/')
    const full = resolve(dir, clean)
    if (!PARTS.test(clean) || clean.split('/').includes('..') || !full.startsWith(dir + sep))
      throw new Error(
        `${path} is not a plugin file: use skills/, commands/, hooks/hooks.json, .mcp.json, myrmidon.json, server/ or ui/`,
      )
    return { full, content }
  })
  if (existsSync(dir)) {
    const owner = existsSync(join(dir, DRAFT)) ? readFileSync(join(dir, DRAFT), 'utf8').trim() : undefined
    if (owner !== colonyId)
      throw new Error(`a plugin called ${input.name} already exists; choose another name or ask the person`)
    rmSync(dir, { recursive: true, force: true })
  }
  for (const { full, content } of writes) {
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  writeFileSync(join(dir, DRAFT), colonyId)
  store.setEnabled(input.name, false)
  const plugin = store.list().find((p) => p.name === input.name)
  if (!plugin) throw new Error('the plugin was written but could not be read back')
  return plugin
}

/** Whether a plugin is a draft made by this round. */
export function isOwnDraft(store: PluginStore, colonyId: string, name: string): boolean {
  const marker = join(store.dir, name, DRAFT)
  return existsSync(marker) && readFileSync(marker, 'utf8').trim() === colonyId
}

/** Approved: it is no longer a draft, and it is switched on. */
export function adoptDraft(store: PluginStore, name: string) {
  rmSync(join(store.dir, name, DRAFT), { force: true })
  store.setEnabled(name, true)
}

export interface PluginTest {
  readonly tool: string
  readonly args: Record<string, unknown>
}

/**
 * Checks a plugin the way it would load: its parts must read cleanly, its code and UI must build, and its code is
 * activated with a stand-in context in the OS sandbox, where each tool runs on its test input.
 */
export async function testPlugin(
  plugin: PluginInfo,
  options: { sandbox: Sandbox; scratch: string; tests: readonly PluginTest[]; allowUnsandboxed: boolean },
): Promise<string> {
  const lines: string[] = [
    `${plugin.name}: ${[
      plugin.skills.length && `${plugin.skills.length} skill(s)`,
      plugin.commands.length && `${plugin.commands.length} command(s)`,
      plugin.hooks && `${plugin.hooks} hook(s)`,
      plugin.mcpServers.length && `${plugin.mcpServers.length} MCP server(s)`,
      plugin.server && 'code',
      plugin.ui && 'UI',
    ]
      .filter(Boolean)
      .join(', ')}`,
  ]
  if (plugin.error) lines.push(`PROBLEM reading its files: ${plugin.error}`)
  if (plugin.ui) {
    const ui = await Bun.build({
      entrypoints: [join(plugin.dir, plugin.ui)],
      target: 'browser',
      external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@myrmidon/ui'],
    })
    lines.push(
      ui.success ? 'UI builds.' : `PROBLEM building the UI:\n${ui.logs.map((l) => l.message).join('\n')}`,
    )
  }
  if (!plugin.server) return lines.join('\n')
  const built = await Bun.build({ entrypoints: [join(plugin.dir, plugin.server)], target: 'bun' })
  const bundle = built.outputs[0]
  if (!built.success || !bundle) {
    lines.push(`PROBLEM building the code:\n${built.logs.map((l) => l.message).join('\n')}`)
    return lines.join('\n')
  }
  if (options.sandbox.kind === 'none' && !options.allowUnsandboxed) {
    lines.push('The code builds. It was not run: running plugin code before approval needs the OS sandbox.')
    return lines.join('\n')
  }
  const dir = join(options.scratch, `.plugin-test-${plugin.name}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.js'), await bundle.text())
  writeFileSync(join(dir, 'harness.js'), harness(plugin, options.tests))
  const run = await options.sandbox.run({
    command: `"${process.execPath}" harness.js`,
    cwd: dir,
    writable: [dir],
    timeoutMs: 60_000,
    // A compiled Myrmidon runs scripts as Bun does with this set.
    env: { BUN_BE_BUN: '1' },
  })
  const out = run.stdout.trim().split('\n').at(-1) ?? ''
  try {
    const r = JSON.parse(out) as {
      error?: string
      tools: string[]
      prompts: { section: string; scope: string }[]
      results: { tool: string; ok: boolean; output?: string; error?: string }[]
    }
    if (r.error) lines.push(`PROBLEM: activate(ctx) failed: ${r.error}`)
    lines.push(`Tools: ${r.tools.map((t) => `${plugin.name}_${t}`).join(', ') || 'none'}`)
    if (r.prompts.length)
      lines.push(`Prompt sections: ${r.prompts.map((p) => `${p.section} (${p.scope})`).join(', ')}`)
    for (const t of r.results)
      lines.push(
        t.ok ? `${t.tool} → ${(t.output ?? '').slice(0, 800)}` : `PROBLEM: ${t.tool} threw: ${t.error}`,
      )
    const untested = r.tools.filter((t) => !r.results.some((x) => x.tool === t))
    if (untested.length) lines.push(`Not run (no test input given): ${untested.join(', ')}`)
  } catch {
    lines.push(`PROBLEM running the code (exit ${run.code}):\n${(run.stderr || run.stdout).slice(-2000)}`)
  }
  return lines.join('\n')
}

/** The script that activates a plugin with a stand-in context and runs its tools on their test inputs. */
function harness(plugin: PluginInfo, tests: readonly PluginTest[]): string {
  const defaults = Object.fromEntries(
    Object.entries(plugin.settings).flatMap(([k, s]) => (s.default === undefined ? [] : [[k, s.default]])),
  )
  return `
const tools = [], prompts = [], logs = []
const ctx = {
  name: ${JSON.stringify(plugin.name)},
  dir: process.cwd(),
  tools: { add: (t) => tools.push(t) },
  prompts: { add: (section, text, scope = 'all') => prompts.push({ section, scope }) },
  events: { on() {}, emit: async () => {} },
  settings: { get: () => (${JSON.stringify(defaults)}) },
  log: (m) => logs.push(String(m)),
  onDispose() {},
}
const results = []
let error
try {
  const mod = await import('./plugin.js')
  if (typeof mod.activate !== 'function') throw new Error('server/index.ts must export activate(ctx)')
  await mod.activate(ctx)
  for (const test of ${JSON.stringify(tests)}) {
    const tool = tools.find((t) => t.name === test.tool || ${JSON.stringify(`${plugin.name}_`)} + t.name === test.tool)
    if (!tool) { results.push({ tool: test.tool, ok: false, error: 'no such tool' }); continue }
    try {
      const out = await tool.run(test.args ?? {}, { colonyId: 'test', agent: 'test' })
      results.push({ tool: tool.name, ok: true, output: typeof out === 'string' ? out : out?.text })
    } catch (e) {
      results.push({ tool: tool.name, ok: false, error: String(e?.message ?? e) })
    }
  }
} catch (e) {
  error = String(e?.message ?? e)
}
console.log(JSON.stringify({ error, tools: tools.map((t) => t.name), prompts, logs, results }))
`
}
