import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { integrityOf, PendingInstalls, parseInstallSource } from '../src/install-sources.ts'
import { writeTar } from '../src/omp/plugins.ts'
import { PluginStore } from '../src/plugins.ts'

let dir: string
let home: string
const savedGlobal = process.env.GIT_CONFIG_GLOBAL

const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

/** A plugin with a command, server code and an MCP server. */
const PLUGIN = (version: string) => ({
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'lint-kit', version, description: 'Lints' }),
  'commands/lint.md': '---\ndescription: Lint it\n---\nLint $ARGUMENTS',
  'server/index.ts': 'export function activate() {}',
  '.mcp.json': JSON.stringify({ mcpServers: { linter: { command: 'lint-server' } } }),
})

const sh = (cwd: string, args: string[]) => {
  // Given no env, Bun.spawnSync passes the one the process started with: the tests change GIT_CONFIG_GLOBAL.
  const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    env: { ...process.env },
  })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return r.stdout.toString().trim()
}

/** A git repository holding `files`, committed and tagged; returns its file:// URL and the commit. */
function repo(name: string, files: Record<string, string>, tag?: string) {
  const at = join(dir, name)
  write(at, files)
  sh(at, ['init', '-q', '-b', 'main'])
  sh(at, ['add', '-A'])
  sh(at, ['commit', '-qm', 'first'])
  if (tag) sh(at, ['tag', tag])
  return { at, url: pathToFileURL(at).href, commit: sh(at, ['rev-parse', 'HEAD']) }
}

/** An npm tarball as `npm pack` lays one out: everything under `package/`. */
function tarball(files: Record<string, string>) {
  const enc = new TextEncoder()
  const tar = writeTar(
    Object.entries(files).map(([path, text]) => ({
      path: `package/${path}`,
      content: enc.encode(text),
      executable: false,
    })),
  )
  return Bun.gzipSync(tar)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-installs-'))
  home = join(dir, 'home')
  // The person's own git config points every repository at a hooks folder whose post-checkout writes a marker.
  const hooks = join(dir, 'person-hooks')
  write(hooks, { 'post-checkout': `#!/bin/sh\ntouch "${join(dir, 'hook-ran')}"\n` })
  chmodSync(join(hooks, 'post-checkout'), 0o755)
  writeFileSync(join(dir, 'gitconfig'), `[core]\n\thooksPath = ${hooks}\n`)
  process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig')
})

afterEach(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal
  rmSync(dir, { recursive: true, force: true })
})

test('sources are read as the person means them', () => {
  expect(parseInstallSource('npm:@acme/kit@^1.2')).toEqual({ kind: 'npm', spec: '@acme/kit@^1.2' })
  expect(parseInstallSource('github:acme/kit#v2')).toEqual({
    kind: 'git',
    url: 'https://github.com/acme/kit',
    ref: 'v2',
  })
  expect(parseInstallSource('https://gitlab.com/acme/kit.git')).toMatchObject({ kind: 'git' })
  expect(parseInstallSource('/tmp/kit-1.0.0.tgz')).toEqual({ kind: 'npm', spec: '/tmp/kit-1.0.0.tgz' })
  expect(parseInstallSource('/tmp/kit')).toEqual({ kind: 'folder', path: '/tmp/kit' })
  expect(() => parseInstallSource('npm:rm -rf')).not.toThrow()
})

test('nothing installs until the person confirms what they were shown', async () => {
  const src = join(dir, 'src')
  write(src, PLUGIN('1.0.0'))
  const plugins = new PluginStore(home)
  const preview = await plugins.prepare(src)
  expect(preview).toMatchObject({
    name: 'lint-kit',
    version: '1.0.0',
    kind: 'folder',
    server: 'server/index.ts',
    mcpServers: ['linter'],
    commands: ['lint'],
    hooks: 0,
  })
  expect(plugins.list()).toEqual([])
  await expect(plugins.confirm('00000000-0000-0000-0000-000000000000')).rejects.toThrow('not reviewed')
  plugins.cancel(preview.id)
  await expect(plugins.confirm(preview.id)).rejects.toThrow('not reviewed')
  expect(plugins.list()).toEqual([])
  // A review left too long expires, and its fetched copy is deleted.
  const pending = new PendingInstalls<object>(join(dir, 'pending'), 1000)
  const staged = pending.stage(0)
  pending.hold(staged.id, {}, 0)
  expect(() => pending.take(staged.id, 5000)).toThrow('expired')
  expect(existsSync(staged.dir)).toBe(false)
})

test('a plugin installs from a git repository at a tag, pinned to its commit, and no hook runs', async () => {
  const r = repo('lint-kit', PLUGIN('1.0.0'), 'v1.0.0')
  const plugins = new PluginStore(home)
  const preview = await plugins.prepare(`${r.url}`)
  expect(preview).toMatchObject({ kind: 'git', commit: r.commit, version: '1.0.0' })
  const p = await plugins.confirm(preview.id)
  expect(p.installed).toMatchObject({
    origin: { kind: 'git', url: r.url },
    commit: r.commit,
    version: '1.0.0',
  })
  expect(existsSync(join(home, 'plugins', 'lint-kit', '.git'))).toBe(false)
  expect(existsSync(join(dir, 'hook-ran'))).toBe(false)
  // The person's hooks do run for their own clones: the marker above stays away only because installs turn them off.
  sh(dir, ['clone', '-q', r.at, join(dir, 'own-clone')])
  expect(existsSync(join(dir, 'hook-ran'))).toBe(true)
})

test('an update shows what changes and swaps the plugin in; removing forgets where it came from', async () => {
  const r = repo('lint-kit', PLUGIN('1.0.0'))
  const plugins = new PluginStore(home)
  await plugins.confirm((await plugins.prepare(r.url)).id)
  write(r.at, PLUGIN('1.1.0'))
  sh(r.at, ['commit', '-qam', 'second'])
  const next = sh(r.at, ['rev-parse', 'HEAD'])
  const update = await plugins.prepareUpdate('lint-kit')
  expect(update).toMatchObject({
    version: '1.1.0',
    commit: next,
    replaces: { version: '1.0.0', commit: r.commit },
  })
  // Still the old one until the person says yes.
  expect(plugins.list()[0]?.version).toBe('1.0.0')
  const p = await plugins.confirm(update.id)
  expect(p).toMatchObject({ version: '1.1.0', enabled: true, installed: { commit: next } })
  plugins.remove('lint-kit')
  expect(plugins.list()).toEqual([])
  expect(JSON.parse(readFileSync(join(home, 'plugins.json'), 'utf8')).installed).toEqual({})
})

test('an npm tarball installs without running its scripts or its dependencies’ scripts', async () => {
  const helper = join(dir, 'helper')
  write(helper, {
    'package.json': JSON.stringify({
      name: 'helper',
      version: '1.0.0',
      scripts: { postinstall: `touch "${join(dir, 'dep-script-ran')}"` },
    }),
    'index.js': 'module.exports = 1',
  })
  const tgz = join(dir, 'lint-kit-1.0.0.tgz')
  writeFileSync(
    tgz,
    tarball({
      ...PLUGIN('1.0.0'),
      'package.json': JSON.stringify({
        name: 'lint-kit',
        version: '1.0.0',
        scripts: {
          preinstall: `touch "${join(dir, 'own-script-ran')}"`,
          postinstall: `touch "${join(dir, 'own-script-ran')}"`,
        },
        dependencies: { helper: `file:${helper}` },
      }),
    }),
  )
  const plugins = new PluginStore(home)
  const preview = await plugins.prepare(tgz)
  expect(preview).toMatchObject({ kind: 'npm', version: '1.0.0', dependencies: ['helper'] })
  expect(preview.integrity).toBe(integrityOf(new Uint8Array(readFileSync(tgz))))
  const p = await plugins.confirm(preview.id)
  expect(existsSync(join(p.dir, 'node_modules', 'helper', 'index.js'))).toBe(true)
  expect(existsSync(join(dir, 'own-script-ran'))).toBe(false)
  expect(existsSync(join(dir, 'dep-script-ran'))).toBe(false)
})

test('an npm package comes from the registry at the version asked, checked against its hash', async () => {
  const bytes = tarball(PLUGIN('2.1.0'))
  const meta = (integrity: string) => ({
    'dist-tags': { latest: '2.1.0' },
    versions: {
      '2.0.0': { dist: { tarball: 'https://registry.test/lint-kit-2.0.0.tgz', integrity } },
      '2.1.0': { dist: { tarball: 'https://registry.test/lint-kit-2.1.0.tgz', integrity } },
    },
  })
  let integrity = integrityOf(bytes)
  const asked: string[] = []
  const fetchFn = async (input: string | URL) => {
    const url = String(input)
    asked.push(url)
    if (url === 'https://registry.npmjs.org/@acme%2flint-kit') return Response.json(meta(integrity))
    if (url.endsWith('.tgz')) return new Response(bytes)
    return new Response('no', { status: 404 })
  }
  const plugins = new PluginStore(home, fetchFn)
  const preview = await plugins.prepare('npm:@acme/lint-kit@^2')
  expect(preview).toMatchObject({ kind: 'npm', version: '2.1.0', source: 'npm:@acme/lint-kit@^2' })
  expect(asked.at(-1)).toBe('https://registry.test/lint-kit-2.1.0.tgz')
  plugins.cancel(preview.id)
  integrity = 'sha512-AAAA'
  await expect(plugins.prepare('npm:@acme/lint-kit')).rejects.toThrow('does not match its published hash')
  expect(plugins.list()).toEqual([])
}, 10_000)

test('a Claude Code marketplace is added from git, browsed, and its plugins install through the same review', async () => {
  const market = repo('acme-market', {
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'acme',
      owner: { name: 'Acme' },
      metadata: { pluginRoot: 'plugins' },
      plugins: [
        { name: 'lint-kit', source: './lint-kit', version: '1.0.0', description: 'Lints' },
        { name: 'remote-kit', source: { source: 'github', repo: 'acme/remote-kit', ref: 'v3' } },
        { name: 'npm-kit', source: { source: 'npm', package: '@acme/npm-kit', version: '1.0.0' } },
        { name: 'bad name!', source: './x' },
        { name: 'escapes', source: '../../etc' },
      ],
    }),
    ...Object.fromEntries(Object.entries(PLUGIN('1.0.0')).map(([k, v]) => [`plugins/lint-kit/${k}`, v])),
  })
  const plugins = new PluginStore(home)
  const added = await plugins.marketplaces.add(market.url)
  expect(added).toMatchObject({ name: 'acme', kind: 'git', commit: market.commit, owner: 'Acme' })
  // omp's parser skips entries it cannot read and keeps the rest.
  expect(added.plugins.map((p) => [p.name, p.source])).toEqual([
    ['lint-kit', './lint-kit'],
    ['remote-kit', 'github:acme/remote-kit#v3'],
    ['npm-kit', 'npm:@acme/npm-kit@1.0.0'],
  ])
  expect(plugins.marketplaces.resolve('acme', 'remote-kit').fetch).toEqual({
    kind: 'git',
    url: 'https://github.com/acme/remote-kit.git',
    ref: 'v3',
  })
  await expect(plugins.marketplaces.add(market.url)).rejects.toThrow('already added')

  const preview = await plugins.prepare({ marketplace: 'acme', plugin: 'lint-kit' })
  expect(preview).toMatchObject({ name: 'lint-kit', source: 'lint-kit@acme', commit: market.commit })
  const p = await plugins.confirm(preview.id)
  expect(p.installed?.origin).toEqual({ kind: 'marketplace', marketplace: 'acme', plugin: 'lint-kit' })
  expect(existsSync(join(dir, 'hook-ran'))).toBe(false)

  plugins.marketplaces.remove('acme')
  expect(plugins.marketplaces.list()).toEqual([])
  // Plugins installed from it stay.
  expect(plugins.list().map((x) => x.name)).toEqual(['lint-kit'])
})

test('a marketplace catalog that is not one is refused, naming what is wrong', async () => {
  const folder = join(dir, 'not-market')
  write(folder, { '.claude-plugin/marketplace.json': JSON.stringify({ name: 'x', plugins: [] }) })
  const plugins = new PluginStore(home)
  await expect(plugins.marketplaces.add(folder)).rejects.toThrow('owner')
  await expect(plugins.marketplaces.add(join(dir, 'missing'))).rejects.toThrow('marketplace.json')
})
