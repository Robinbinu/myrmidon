import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandCommand } from '@myrmidon/protocol'
import { HookStore } from '../src/hooks.ts'
import { PluginStore } from '../src/plugins.ts'
import { SkillLibrary } from '../src/skills.ts'

let dir: string
let home: string
let source: string

/** A plugin as Claude Code lays one out: manifest, a skill, a command, a hook and an MCP server. */
function claudePlugin(at: string) {
  const write = (path: string, text: string) => {
    mkdirSync(join(at, path, '..'), { recursive: true })
    writeFileSync(join(at, path), text)
  }
  write(
    '.claude-plugin/plugin.json',
    JSON.stringify({
      name: 'nova-kit',
      version: '1.2.0',
      description: 'Design helpers',
      author: { name: 'Nova' },
    }),
  )
  write(
    'skills/palette/SKILL.md',
    '---\nname: palette\ndescription: Picks a colour palette\n---\nUse three colours.',
  )
  write(
    'commands/review-ui.md',
    '---\ndescription: Review a screen\nargument-hint: <file>\n---\nReview the UI in $1 for: $ARGUMENTS',
  )
  write(
    'hooks/hooks.json',
    JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'fs_write',
            hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/fmt.sh' }],
          },
        ],
      },
    }),
  )
  write(
    '.mcp.json',
    JSON.stringify({
      mcpServers: { colors: { command: '${CLAUDE_PLUGIN_ROOT}/bin/colors', args: ['--stdio'] } },
    }),
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-plugins-'))
  home = join(dir, 'home')
  source = join(dir, 'nova-kit-src')
  claudePlugin(source)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('a Claude Code plugin installs from a folder and every part reaches Myrmidon', async () => {
  const plugins = new PluginStore(home)
  const installed = await plugins.install(source)
  const root = join(home, 'plugins', 'nova-kit')
  expect(installed).toMatchObject({
    name: 'nova-kit',
    version: '1.2.0',
    description: 'Design helpers',
    author: 'Nova',
    enabled: true,
    skills: ['palette'],
    hooks: 1,
    mcpServers: ['colors'],
  })
  expect(installed.commands).toEqual([
    {
      name: 'review-ui',
      plugin: 'nova-kit',
      description: 'Review a screen',
      argumentHint: '<file>',
      prompt: 'Review the UI in $1 for: $ARGUMENTS',
    },
  ])

  // Skills come in through the skill library, after the person's own.
  const skills = new SkillLibrary(home, join(dir, 'no-claude'), () => plugins.skillRoots())
  expect(skills.list().map((s) => [s.name, s.source])).toEqual([['palette', 'plugin']])
  // Hooks and servers find the plugin's own folder.
  const hooks = new HookStore(home, () => plugins.hooks())
  expect(hooks.has('PostToolUse')).toBe(true)
  expect(hooks.active().hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe(`${root}/scripts/fmt.sh`)
  expect(hooks.read()).toEqual({ hooks: {} })
  expect(plugins.mcpServers()).toEqual({
    'nova-kit_colors': { command: `${root}/bin/colors`, args: ['--stdio'] },
  })
  // A command sends its prompt with what was typed after it.
  const [command] = plugins.commands()
  expect(command && expandCommand(command, 'home.tsx contrast and spacing')).toBe(
    'Review the UI in home.tsx for: home.tsx contrast and spacing',
  )

  // Switched off, the plugin adds nothing; on again, everything is back.
  plugins.setEnabled('nova-kit', false)
  expect(skills.list()).toEqual([])
  expect(hooks.has('PostToolUse')).toBe(false)
  expect(plugins.mcpServers()).toEqual({})
  expect(plugins.commands()).toEqual([])
  plugins.setEnabled('nova-kit', true)
  expect(plugins.commands()).toHaveLength(1)

  plugins.remove('nova-kit')
  expect(existsSync(root)).toBe(false)
  expect(plugins.list()).toEqual([])
})

test('a plugin installs from a git repository, without its history', async () => {
  const repo = join(dir, 'nova-kit.git')
  const sh = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], { cwd })
  sh(source, ['init', '-q'])
  sh(source, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
  sh(source, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'plugin'])
  sh(dir, ['clone', '-q', '--bare', source, repo])
  const plugins = new PluginStore(home)
  expect((await plugins.install(repo)).name).toBe('nova-kit')
  expect(existsSync(join(home, 'plugins', 'nova-kit', '.git'))).toBe(false)
})

test('a folder with nothing a plugin adds is refused, and a name can only be taken once', async () => {
  const plugins = new PluginStore(home)
  const empty = join(dir, 'empty')
  mkdirSync(empty)
  writeFileSync(join(empty, 'README.md'), 'hi')
  await expect(plugins.install(empty)).rejects.toThrow('not a plugin')
  await plugins.install(source)
  await expect(plugins.install(source)).rejects.toThrow('already installed')
  expect(plugins.list().map((p) => p.name)).toEqual(['nova-kit'])
})

test('a broken part is reported and the rest of the plugin still loads', async () => {
  writeFileSync(join(source, 'hooks', 'hooks.json'), '{ not json')
  const plugins = new PluginStore(home)
  const p = await plugins.install(source)
  expect(p.error).toContain('hooks/hooks.json')
  expect(p.skills).toEqual(['palette'])
  expect(plugins.hooks()).toEqual({ hooks: {} })
})

test("an agent's draft belongs to its round, and a plugin the person installed is never overwritten", async () => {
  const { writeDraft, isOwnDraft, adoptDraft } = await import('../src/plugin-builder.ts')
  const plugins = new PluginStore(home)
  const files = { 'commands/hi.md': 'Say hi to $ARGUMENTS' }
  writeDraft(plugins, 'round-a', { name: 'greeter', description: 'Says hi', files })
  expect(plugins.list().find((p) => p.name === 'greeter')).toMatchObject({ enabled: false })
  expect(isOwnDraft(plugins, 'round-a', 'greeter')).toBe(true)
  expect(() => writeDraft(plugins, 'round-b', { name: 'greeter', description: 'Takes over', files })).toThrow(
    'already exists',
  )
  adoptDraft(plugins, 'greeter')
  expect(isOwnDraft(plugins, 'round-a', 'greeter')).toBe(false)
  expect(plugins.list().find((p) => p.name === 'greeter')?.enabled).toBe(true)
  // Approved, it is the person's now: not even the round that made it can rewrite it.
  expect(() => writeDraft(plugins, 'round-a', { name: 'greeter', description: 'Changed', files })).toThrow(
    'already exists',
  )
  await plugins.install(source)
  expect(() =>
    writeDraft(plugins, 'round-a', { name: 'nova-kit', description: 'Replace it', files }),
  ).toThrow('already exists')
})
