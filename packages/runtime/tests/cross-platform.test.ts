import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromeCandidates } from '../src/browser.ts'
import { sandboxHiddenRoots, sandboxSecrets, sandboxSystemBins, sandboxToolchains } from '../src/config.ts'
import { ownerOnly, ownerOnlyCommand, windowsAccount } from '../src/owner-only.ts'
import { absoluteFolder, folderParent, isFsRoot, projectSecret, windowsDrives } from '../src/projects.ts'
import { expandHome, keysAt, readFolder, within } from '../src/read-access.ts'
import { confinedEnvFor, sandboxPath } from '../src/sandbox.ts'
import { PhononStream } from '../src/voice/phonon-stream.ts'
import { phononInstall, phononListenArgs, phononUnsupported, socketFolder } from '../src/voice/stt.ts'

/**
 * The system folders a confined PATH adds after the person's own: those this computer has (none, but on a Windows
 * host), less ones the person's PATH already named, compared as Windows does, ignoring case.
 */
const presentBesides = (system: readonly string[], named: readonly string[]) =>
  system.filter((dir) => existsSync(dir) && !named.some((n) => n.toLowerCase() === dir.toLowerCase()))

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
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'myr-xp-')))
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
  expect(sandboxHiddenRoots('linux', 1000)).toEqual([
    '/mnt',
    '/media',
    '/run/media',
    '/home',
    '/tmp/.X11-unix',
    '/run/user/1000',
  ])
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
    ...presentBesides(system, ['C:\\WINDOWS\\System32', 'C:\\WINDOWS']),
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
  expect(env.PATH).toBe(
    ['C:\\WINDOWS\\system32', ...presentBesides(sandboxSystemBins('win32'), ['C:\\WINDOWS\\system32'])].join(
      ';',
    ),
  )
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

test('Chrome is looked for where each system installs it, Edge last on Windows', () => {
  const win = chromeCandidates(
    'win32',
    {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local',
    },
    'C:\\Users\\ada',
  )
  expect(win[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  expect(win).toContain('C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
  expect(win.at(-1)).toMatch(/\\msedge\.exe$/)
  expect(win.findIndex((p) => p.endsWith('msedge.exe'))).toBeGreaterThan(
    win.findLastIndex((p) => p.endsWith('chrome.exe')),
  )
  const linux = chromeCandidates('linux', {}, '/home/ada')
  expect(linux[0]).toBe('/usr/bin/google-chrome')
  expect(linux).toContain('/snap/bin/chromium')
  expect(linux).toContain('/var/lib/flatpak/exports/bin/com.google.Chrome')
  expect(linux).toContain('/home/ada/.local/share/flatpak/exports/bin/com.google.Chrome')
})

test('Phonon-2 installs MLX only on Apple silicon, says where it cannot run, and listens on a port on Windows', () => {
  expect(phononInstall('darwin', 'arm64')).toContain('mlx')
  for (const [platform, arch] of [
    ['win32', 'x64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'x64'],
  ] as const) {
    expect(phononInstall(platform, arch)).not.toContain('mlx')
    expect(phononInstall(platform, arch)).not.toContain('mlx-audio')
    expect(phononUnsupported(platform, arch)).toBeUndefined()
  }
  expect(phononUnsupported('win32', 'arm64')).toContain('Windows on Arm')
  expect(phononListenArgs({ unix: '/x/phonon.sock' })).toEqual(['--unix-socket', '/x/phonon.sock'])
  expect(phononListenArgs({ port: 4567, token: 'k' })).toEqual([
    '--host',
    '127.0.0.1',
    '--port',
    '4567',
    '--api-key',
    'k',
  ])
  const long = `/Users/${'a'.repeat(120)}/voice/phonon.sock`
  expect(socketFolder(long, 'win32', 'C:\\Users\\ada\\AppData\\Local\\Temp')).toMatch(
    /^C:\\Users\\ada\\AppData\\Local\\Temp\\myr-/,
  )
  expect(socketFolder(long, 'linux')).toMatch(/^\/tmp\/myr-/)
})

test('Phonon’s live stream reaches a loopback port with its key, as on Windows', async () => {
  let auth: string | null = null
  let config: unknown
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      auth = req.headers.get('authorization')
      if (auth !== 'Bearer s3cret') return new Response('no', { status: 401 })
      return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
    },
    websocket: {
      message(ws, msg) {
        if (typeof msg === 'string') {
          config = JSON.parse(msg)
          ws.send(JSON.stringify({ type: 'partial', text: 'hello' }))
        }
      },
    },
  })
  servers.push(server)
  const heard: string[] = []
  const stream = new PhononStream({ port: server.port ?? 0, token: 's3cret' }, 16_000, (t) => heard.push(t))
  const end = Date.now() + 3000
  while (!heard.length && Date.now() < end) await Bun.sleep(5)
  stream.close()
  expect(auth as string | null).toBe('Bearer s3cret')
  expect(config).toEqual({ sample_rate: 16_000, format: 'pcm_s16le' })
  expect(heard).toEqual(['hello'])
})

test('a file of keys is left to its owner: mode 0600 here, its access list on Windows', () => {
  const file = join(temp(), 'server.json')
  writeFileSync(file, '{}', { mode: 0o644 })
  ownerOnly(file)
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)

  expect(windowsAccount({ USERNAME: 'ada', USERDOMAIN: 'DESKTOP-1' })).toBe('DESKTOP-1\\ada')
  expect(ownerOnlyCommand('C:\\Users\\ada\\.myrmidon\\server.json', 'DESKTOP-1\\ada', 'C:\\WINDOWS')).toEqual(
    [
      'C:\\WINDOWS\\System32\\icacls.exe',
      'C:\\Users\\ada\\.myrmidon\\server.json',
      '/inheritance:r',
      '/grant:r',
      'DESKTOP-1\\ada:F',
    ],
  )
  const ran: string[][] = []
  const logged: string[] = []
  const env = { USERNAME: 'ada', USERDOMAIN: 'PC', SystemRoot: 'C:\\WINDOWS' }
  ownerOnly('C:\\x\\models.yml', 0o600, {
    platform: 'win32',
    env,
    run: (argv) => {
      ran.push(argv)
      return { ok: true, output: '' }
    },
    log: (l) => logged.push(l),
  })
  expect(ran[0]?.slice(-3)).toEqual(['/inheritance:r', '/grant:r', 'PC\\ada:F'])
  expect(logged).toEqual([])
  // Best effort: a failure is logged, never thrown, so the file is still saved.
  ownerOnly('C:\\x\\models.yml', 0o600, {
    platform: 'win32',
    env,
    run: () => ({ ok: false, output: 'Access is denied.' }),
    log: (l) => logged.push(l),
  })
  ownerOnly('C:\\x\\models.yml', 0o600, {
    platform: 'win32',
    env,
    run: () => {
      throw new Error('Executable not found')
    },
    log: (l) => logged.push(l),
  })
  expect(logged).toHaveLength(2)
  expect(logged[0]).toContain('Access is denied.')
  expect(logged[1]).toContain('Executable not found')
})
