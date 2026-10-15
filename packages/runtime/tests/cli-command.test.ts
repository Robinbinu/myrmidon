import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliCommand, CliCommandError, compiledBinary, withBlock, withoutBlock } from '../src/cli-command.ts'
import { prompts } from '../src/prompts.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A throwaway home, and a copy of the app in it whose server is a script that answers --help. */
function world(appName = 'Myrmidon.app') {
  const root = mkdtempSync(join(tmpdir(), 'myr-cli-'))
  dirs.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  const binary = app(root, appName)
  return { root, home, binary }
}

function app(root: string, name: string): string {
  const sidecar = join(root, 'Applications', name, 'Contents', 'Resources', 'app', 'sidecar')
  mkdirSync(sidecar, { recursive: true })
  const binary = join(sidecar, 'myrmidon')
  writeFileSync(binary, '#!/bin/sh\necho "usage: myrmidon"\n')
  chmodSync(binary, 0o755)
  return binary
}

const profile = (home: string) => join(home, '.zprofile')
const link = (home: string) => join(home, '.local', 'bin', 'myrmidon')
const notOnPath = async () => '/usr/bin:/bin'

test('run from source, it is unavailable and says why; installing and removing refuse and change nothing', async () => {
  expect(compiledBinary()).toBeUndefined()
  const { home } = world()
  const command = new CliCommand({ home, binary: compiledBinary(), loginPath: notOnPath })
  expect(command.status()).toMatchObject({ state: 'unavailable', reason: prompts.cliCommand.unavailable })
  await expect(command.install()).rejects.toBeInstanceOf(CliCommandError)
  expect(() => command.remove()).toThrow(CliCommandError)
  expect(existsSync(join(home, '.local'))).toBe(false)
  expect(existsSync(profile(home))).toBe(false)
})

test('install links ~/.local/bin/myrmidon to the app and adds one PATH block to a new ~/.zprofile; again changes nothing', async () => {
  const { home, binary } = world()
  const command = new CliCommand({ home, binary, loginPath: notOnPath })
  expect(command.status().state).toBe('missing')
  const status = await command.install()
  expect(status).toMatchObject({ state: 'installed', link: link(home), target: binary, profileBlock: true })
  expect(readlinkSync(link(home))).toBe(binary)
  const text = readFileSync(profile(home), 'utf8')
  expect(text).toBe(
    [
      prompts.cliCommand.blockStart,
      prompts.cliCommand.blockNote,
      'export PATH="$HOME/.local/bin:$PATH"',
      prompts.cliCommand.blockEnd,
      '',
    ].join('\n'),
  )
  await command.install()
  expect(readFileSync(profile(home), 'utf8')).toBe(text)
  expect(Bun.spawnSync([link(home), '--help']).stdout.toString()).toContain('usage: myrmidon')
})

test("the block goes after the person's own lines, which stay as they were, and remove takes out exactly it", async () => {
  const { home, binary } = world()
  const mine = 'export EDITOR=vim\neval "$(/opt/homebrew/bin/brew shellenv)"\n'
  writeFileSync(profile(home), mine)
  const command = new CliCommand({ home, binary, loginPath: notOnPath })
  await command.install()
  const text = readFileSync(profile(home), 'utf8')
  expect(text.startsWith(`${mine}\n${prompts.cliCommand.blockStart}\n`)).toBe(true)
  const status = command.remove()
  expect(status).toMatchObject({ state: 'missing', profileBlock: false })
  expect(readFileSync(profile(home), 'utf8')).toBe(mine)
  expect(existsSync(link(home))).toBe(false)
})

test('no block when a login shell already finds ~/.local/bin, and the profile is left alone', async () => {
  const { home, binary } = world()
  const command = new CliCommand({
    home,
    binary,
    loginPath: async () => `/usr/bin:${join(home, '.local', 'bin')}/:/bin`,
  })
  expect((await command.install()).profileBlock).toBe(false)
  expect(existsSync(profile(home))).toBe(false)
})

test('a real zsh login shell is asked for its PATH: one ~/.zprofile already adding the folder gets no block', async () => {
  const { home, binary } = world()
  const own = 'export PATH="$HOME/.local/bin:$PATH"\n'
  writeFileSync(profile(home), own)
  expect((await new CliCommand({ home, binary }).install()).profileBlock).toBe(false)
  expect(readFileSync(profile(home), 'utf8')).toBe(own)
  // Without it, the same shell does not find the folder, so the block is added.
  const other = world()
  expect((await new CliCommand({ home: other.home, binary: other.binary }).install()).profileBlock).toBe(true)
})

test('something at the link that is not Myrmidon is never replaced or removed', async () => {
  const { root, home, binary } = world()
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  writeFileSync(link(home), '#!/bin/sh\necho mine\n')
  const command = new CliCommand({ home, binary, loginPath: notOnPath })
  expect(command.status().state).toBe('taken')
  await expect(command.install()).rejects.toThrow(prompts.cliCommand.taken(link(home)))
  command.remove()
  expect(readFileSync(link(home), 'utf8')).toContain('mine')
  // A link to another tool, even a broken one, is not Myrmidon's either.
  rmSync(link(home))
  symlinkSync(join(root, 'elsewhere', 'tool'), link(home))
  expect(command.status().state).toBe('taken')
  command.remove()
  expect(lstatSync(link(home)).isSymbolicLink()).toBe(true)
})

test('an app that moved leaves a broken link, which repair points at this copy; a removed link stays removed', async () => {
  const { root, home, binary } = world()
  const old = join(root, 'Old')
  mkdirSync(old)
  const before = new CliCommand({ home, binary, loginPath: notOnPath })
  await before.install()
  // Moved from Applications to elsewhere: the link points at nothing.
  renameSync(join(root, 'Applications'), join(old, 'Applications'))
  const moved = join(
    old,
    'Applications',
    'Myrmidon.app',
    'Contents',
    'Resources',
    'app',
    'sidecar',
    'myrmidon',
  )
  const after = new CliCommand({ home, binary: moved, loginPath: notOnPath })
  expect(after.status().state).toBe('broken')
  expect(after.repair()).toBe(true)
  expect(after.status()).toMatchObject({ state: 'installed', target: moved })
  expect(after.repair()).toBe(false)
  after.remove()
  expect(after.repair()).toBe(false)
  expect(existsSync(link(home))).toBe(false)
})

test('a link to another copy of the app is "elsewhere": repair and install point it here', async () => {
  const { root, home, binary } = world()
  const other = app(root, 'Myrmidon Beta.app')
  await new CliCommand({ home, binary: other, loginPath: notOnPath }).install()
  const command = new CliCommand({ home, binary, loginPath: notOnPath })
  expect(command.status()).toMatchObject({ state: 'elsewhere', target: other })
  expect(command.repair()).toBe(true)
  expect(readlinkSync(link(home))).toBe(binary)
})

test('the block helpers: idempotent, and removal keeps text around the block as it was', () => {
  const once = withBlock('a\n')
  expect(withBlock(once)).toBe(once)
  expect(withoutBlock(once)).toBe('a\n')
  expect(withoutBlock(withBlock(undefined))).toBe('')
  const between = `${withBlock('a\n')}b\n`
  expect(withoutBlock(between)).toBe('a\nb\n')
  expect(withoutBlock('no block here\n')).toBe('no block here\n')
})
