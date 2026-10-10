import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxHiddenRoots, sandboxSecrets, sandboxSystemBins, sandboxToolchains } from '../src/config.ts'
import { absoluteFolder, folderParent, isFsRoot, projectSecret, windowsDrives } from '../src/projects.ts'
import { expandHome, keysAt, readFolder, within } from '../src/read-access.ts'
import { confinedEnvFor, sandboxPath } from '../src/sandbox.ts'

/**
 * Myrmidon runs on macOS, Linux and Windows. These check the Windows and Linux rules of the path and OS helpers with
 * the platform passed in, so they run on any computer; CI runs the rest of the suite on each system.
 */

const dirs: string[] = []
const servers: { stop(force?: boolean): unknown }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'myr-xp-')))
  dirs.push(d)
  return d
}

test('a path is within a folder by its own system’s rules: separators, drive roots, case', () => {
  expect(within('C:\\Users\\ada\\proj\\a.ts', 'C:\\Users\\ada\\proj', 'win32')).toBe(true)
  expect(within('C:\\Users\\ada\\project2', 'C:\\Users\\ada\\proj', 'win32')).toBe(false)
  expect(within('D:\\x', 'D:\\', 'win32')).toBe(true)
  expect(within('/srv/x', '/', 'linux')).toBe(true)
  // NTFS and APFS ignore case by default, so ~/.SSH is ~/.ssh there; ext4 does not.
  expect(within('c:\\users\\ada\\.SSH\\id_ed25519', 'C:\\Users\\ada\\.ssh', 'win32')).toBe(true)
  expect(within('/Users/ada/.SSH/id_ed25519', '/Users/ada/.ssh', 'darwin')).toBe(true)
  expect(within('/home/ada/.SSH/id_ed25519', '/home/ada/.ssh', 'linux')).toBe(false)
})

test('~ is the home folder on every system, and a typed folder must be absolute', () => {
  expect(expandHome('~\\code\\app', 'C:\\Users\\ada', 'win32')).toBe('C:\\Users\\ada\\code\\app')
  expect(expandHome('~/code/app', 'C:\\Users\\ada', 'win32')).toBe('C:\\Users\\ada\\code\\app')
  expect(expandHome('~\\code', '/home/ada', 'linux')).toBe('~\\code')
  expect(readFolder('D:\\work', 'C:\\Users\\ada', 'win32')).toBe('D:\\work')
  expect(() => readFolder('work', 'C:\\Users\\ada', 'win32')).toThrow('a drive (C:\\)')

  expect(absoluteFolder('C:\\Users\\ada\\code', 'C:\\Users\\ada', 'win32')).toBe('C:\\Users\\ada\\code')
  expect(absoluteFolder('~\\code', 'C:\\Users\\ada', 'win32')).toBe('C:\\Users\\ada\\code')
  expect(absoluteFolder('~/code', '/home/ada', 'linux')).toBe('/home/ada/code')
  expect(() => absoluteFolder('code', 'C:\\Users\\ada', 'win32')).toThrow('use an absolute path')
})

test('the folder picker stops going up at a drive on Windows and at / elsewhere, and lists the drives', () => {
  expect(isFsRoot('C:\\', 'win32')).toBe(true)
  expect(isFsRoot('\\\\server\\share\\', 'win32')).toBe(true)
  expect(isFsRoot('C:\\Users', 'win32')).toBe(false)
  expect(isFsRoot('/', 'linux')).toBe(true)
  expect(folderParent('C:\\', 'win32')).toBeUndefined()
  expect(folderParent('C:\\Users\\ada', 'win32')).toBe('C:\\Users')
  expect(folderParent('/', 'darwin')).toBeUndefined()
  expect(folderParent('/home/ada', 'linux')).toBe('/home')
  expect(windowsDrives((p) => p === 'C:\\' || p === 'E:\\')).toEqual(['C:\\', 'E:\\'])
})

test('a secret named in another case stays hidden where the file system ignores case', () => {
  const home = temp()
  const project = join(home, 'everything')
  mkdirSync(project)
  // Not there yet, so its real path cannot give the case: the comparison has to.
  const shouted = join(home, '.AWS', 'credentials')
  const caseless = process.platform === 'darwin' || process.platform === 'win32'
  expect(keysAt(shouted, home)).toBe(caseless ? join(home, '.aws') : undefined)
  // Inside a project around the home, the same goes for the file views.
  mkdirSync(join(home, '.ssh'))
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key')
  expect(projectSecret(home, '.ssh/id_ed25519', { home })).toBe(true)
  if (caseless) expect(projectSecret(home, '.SSH/id_ed25519', { home })).toBe(true)
})

test('each system hides its own keys and opens its own toolchains', () => {
  const win = sandboxSecrets('win32')
  for (const p of ['.ssh', '.aws', '_netrc', 'AppData/Roaming', 'AppData/Local/Google/Chrome/User Data'])
    expect(win).toContain(p)
  expect(win.some((p) => p.startsWith('Library/'))).toBe(false)
  const linux = sandboxSecrets('linux')
  for (const p of ['.ssh', '.config', '.pki', '.var/app', 'snap']) expect(linux).toContain(p)
  expect(linux.some((p) => p.startsWith('Library/'))).toBe(false)
  expect(sandboxSecrets('darwin')).toContain('Library/Keychains')

  // Toolchains inside a hidden folder open again (the deepest rule decides); npm's global npmrc closes again.
  const tools = sandboxToolchains('win32')
  for (const p of ['.bun', '.cargo/bin', 'scoop/shims', 'AppData/Local/Programs', 'AppData/Roaming/npm'])
    expect(tools).toContain(p)
  expect(win).toContain('AppData/Roaming/npm/etc')
  expect(sandboxToolchains('linux')).not.toContain('Library/pnpm')

  expect(sandboxHiddenRoots('darwin')).toEqual(['/Volumes', '/Users/Shared', '/private/var/folders'])
  expect(sandboxHiddenRoots('linux', 1000)).toEqual(['/mnt', '/media', '/run/media', '/run/user/1000'])
  expect(sandboxHiddenRoots('win32')).toEqual([])
})

test('a confined command’s PATH is split and joined with ; on Windows, keeping only the system’s folders', () => {
  const system = sandboxSystemBins('win32', { SystemRoot: 'C:\\WINDOWS', ProgramFiles: 'C:\\Program Files' })
  expect(system).toContain('C:\\WINDOWS\\System32')
  expect(system).toContain('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0')
  expect(system).toContain('C:\\Program Files\\Git\\cmd')
  const person = [
    'c:\\windows\\system32',
    'C:\\Program Files\\Some App\\bin',
    'C:\\WINDOWS',
    'C:\\Users\\ada\\Desktop\\tools',
  ].join(';')
  // Windows' folder names ignore case; the person's spelling is kept.
  expect(sandboxPath(person, temp(), 'win32', system).split(';')).toEqual([
    'c:\\windows\\system32',
    'C:\\WINDOWS',
  ])
  expect(sandboxPath('/usr/bin:/opt/evil', temp(), 'linux', ['/usr/bin'])).toBe('/usr/bin')
})

test('on Windows a confined command keeps the variables programs need and gets its own profile folders', () => {
  const base = {
    Path: 'C:\\WINDOWS\\system32;C:\\secret\\bin',
    SystemRoot: 'C:\\WINDOWS',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe',
    PROCESSOR_ARCHITECTURE: 'AMD64',
    GITHUB_TOKEN: 'ghp_secret',
    APPDATA: 'C:\\Users\\ada\\AppData\\Roaming',
  }
  const dirs = { person: temp(), home: 'D:\\scratch\\.home', tmp: 'D:\\scratch\\.tmp' }
  const env = confinedEnvFor(base, dirs, 'win32')
  expect(env.PATH).toBe('C:\\WINDOWS\\system32')
  expect(env.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD')
  expect(env.SystemRoot).toBe('C:\\WINDOWS')
  expect(env.ComSpec).toBe('C:\\WINDOWS\\system32\\cmd.exe')
  expect(env.PROCESSOR_ARCHITECTURE).toBe('AMD64')
  expect(env.GITHUB_TOKEN).toBeUndefined()
  expect(env.USERPROFILE).toBe('D:\\scratch\\.home')
  expect(env.APPDATA).toBe('D:\\scratch\\.home\\AppData\\Roaming')
  expect(env.TEMP).toBe('D:\\scratch\\.tmp')
  // Elsewhere only PATH, HOME and TMPDIR, as before.
  expect(Object.keys(confinedEnvFor({ PATH: '/usr/bin', SECRET: 'x' }, dirs, 'linux')).sort()).toEqual([
    'HOME',
    'PATH',
    'TMPDIR',
  ])
})
