import { expect, test } from 'bun:test'
import { alive } from '../src/leash.ts'
import { spawnLeashed } from '../src/leashed.ts'
import {
  commandShell,
  EMBEDDED_SHELL_NAME,
  gitSh,
  powershellScript,
  type ShellProbe,
  shellEnv,
  terminalShell,
} from '../src/shell.ts'

/** A machine as the shell choice sees it: which programs are on PATH, which files exist. */
function probe(
  platform: NodeJS.Platform,
  onPath: Record<string, string> = {},
  files: readonly string[] = [],
  env: Record<string, string> = {},
): ShellProbe {
  return {
    platform,
    env,
    which: (name) => onPath[name] ?? null,
    exists: (path) => files.includes(path),
  }
}

const WINDOWS_ENV = {
  SystemRoot: 'C:\\WINDOWS',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\Ana Lima\\AppData\\Local',
  ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe',
}
const GIT_SH = 'C:\\Program Files\\Git\\bin\\sh.exe'
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

test('macOS and Linux run commands in /bin/sh, as before', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const shell = commandShell(probe(platform, { pwsh: '/usr/local/bin/pwsh' }))
    expect(shell).toMatchObject({ name: 'sh', syntax: 'posix' })
    expect(shell.argv('echo hi && ls')).toEqual(['/bin/sh', '-c', 'echo hi && ls'])
  }
})

test("Windows prefers Git for Windows' sh, found beside git when it is not on PATH", () => {
  const machine = probe(
    'win32',
    { git: 'C:\\Program Files\\Git\\cmd\\git.exe', pwsh: PWSH },
    [GIT_SH],
    WINDOWS_ENV,
  )
  expect(gitSh(machine)).toBe(GIT_SH)
  const shell = commandShell(machine)
  expect(shell).toMatchObject({ name: 'Git Bash', syntax: 'posix' })
  expect(shell.argv('ls -la')).toEqual([GIT_SH, '-c', 'ls -la'])
})

test("Windows takes an sh on PATH, but not System32's bash family (WSL's)", () => {
  const onPath = 'C:\\Program Files\\Git\\usr\\bin\\sh.exe'
  expect(gitSh(probe('win32', { sh: onPath }, [], WINDOWS_ENV))).toBe(onPath)
  const wsl = probe('win32', { sh: 'C:\\Windows\\System32\\sh.exe' }, [], WINDOWS_ENV)
  expect(gitSh(wsl)).toBeUndefined()
})

test("Git Bash's commands run with Git's own folders first on PATH, whichever sh.exe was found", () => {
  const bins = ['C:\\Program Files\\Git\\usr\\bin', 'C:\\Program Files\\Git\\mingw64\\bin']
  for (const sh of [GIT_SH, 'C:\\Program Files\\Git\\usr\\bin\\sh.exe']) {
    const shell = commandShell(probe('win32', { sh }, [sh, ...bins], WINDOWS_ENV))
    expect(shell.bins).toEqual(bins)
    // Windows names it Path; a second PATH beside it would leave which one wins to chance.
    expect(shellEnv({ Path: 'C:\\WINDOWS\\system32', HOME: 'h' }, shell)).toEqual({
      Path: `${bins.join(';')};C:\\WINDOWS\\system32`,
      HOME: 'h',
    })
  }
  const sh = commandShell(probe('linux'))
  const env = { PATH: '/usr/bin' }
  expect(shellEnv(env, sh)).toBe(env)
})

test('Windows finds a per-user Git install with no git on PATH', () => {
  const user = 'C:\\Users\\Ana Lima\\AppData\\Local\\Programs\\Git\\bin\\sh.exe'
  expect(gitSh(probe('win32', {}, [user], WINDOWS_ENV))).toBe(user)
})

test('without Git, Windows runs commands in PowerShell 7, else Windows PowerShell, else cmd.exe', () => {
  const pwsh = commandShell(probe('win32', { pwsh: PWSH, powershell: WINDOWS_POWERSHELL }, [], WINDOWS_ENV))
  expect(pwsh).toMatchObject({ name: 'PowerShell 7', syntax: 'powershell' })
  expect(pwsh.argv('dir')).toEqual([
    PWSH,
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    powershellScript('dir'),
  ])
  // Not on PATH (a trimmed PATH), but every Windows has it in System32.
  const builtIn = commandShell(probe('win32', {}, [WINDOWS_POWERSHELL], WINDOWS_ENV))
  expect(builtIn).toMatchObject({ name: 'Windows PowerShell', syntax: 'powershell' })
  expect(builtIn.argv('dir')[0]).toBe(WINDOWS_POWERSHELL)
  const cmd = commandShell(probe('win32', {}, [], WINDOWS_ENV))
  expect(cmd).toMatchObject({ name: 'cmd.exe', syntax: 'cmd' })
  expect(cmd.argv('dir /b')).toEqual([WINDOWS_ENV.ComSpec, '/d', '/s', '/c', 'dir /b'])
})

test('a PowerShell command keeps its text and exits with the failing program’s code, as sh -c does', () => {
  const script = powershellScript('npm test; echo "done"')
  const lines = script.split('\n')
  expect(lines).toContain('npm test; echo "done"')
  // After the command, so a failing last statement decides the exit code.
  expect(lines.at(-1)).toBe('if (-not $?) { exit $(if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }) }')
  expect(script).toContain("$ProgressPreference = 'SilentlyContinue'")
})

test("the person's terminal: their login shell; Linux falls back to bash, then sh; Windows to PowerShell", () => {
  expect(terminalShell(probe('darwin', {}, [], { SHELL: '/opt/homebrew/bin/fish' }))).toEqual([
    '/opt/homebrew/bin/fish',
    '-l',
  ])
  expect(terminalShell(probe('darwin'))).toEqual(['/bin/zsh', '-l'])
  expect(terminalShell(probe('linux', {}, ['/bin/bash']))).toEqual(['/bin/bash', '-l'])
  expect(terminalShell(probe('linux'))).toEqual(['/bin/sh', '-l'])
  expect(terminalShell(probe('win32', { pwsh: PWSH }, [], WINDOWS_ENV))).toEqual([PWSH, '-NoLogo'])
  expect(terminalShell(probe('win32', {}, [], WINDOWS_ENV))).toEqual([WINDOWS_ENV.ComSpec])
})

test('the host shell runs a command here', async () => {
  const proc = Bun.spawn(commandShell().argv('echo one && echo two'), { stdout: 'pipe' })
  expect((await new Response(proc.stdout).text()).trim().split(/\r?\n/)).toEqual(['one', 'two'])
  expect(await proc.exited).toBe(0)
})

test('without Git Bash, Windows runs commands in the built-in bash, before PowerShell; macOS and Linux never do', () => {
  const machine = { ...probe('win32', { pwsh: PWSH }, [], WINDOWS_ENV), embedded: true }
  const shell = commandShell(machine)
  expect(shell).toMatchObject({ name: EMBEDDED_SHELL_NAME, syntax: 'posix', bins: [] })
  expect(shell.argv('ls -la')[0]).toBe(process.execPath)
  expect(shell.argv('ls -la').at(-1)).toBe('ls -la')
  const withGit = { ...probe('win32', { sh: GIT_SH }, [GIT_SH], WINDOWS_ENV), embedded: true }
  expect(commandShell(withGit).name).toBe('Git Bash')
  for (const platform of ['darwin', 'linux'] as const)
    expect(commandShell({ ...probe(platform), embedded: true }).argv('ls')).toEqual(['/bin/sh', '-c', 'ls'])
  // The person's own terminal stays PowerShell.
  expect(terminalShell(machine)).toEqual([PWSH, '-NoLogo'])
})

/** The built-in bash as Windows without Git Bash gets it, on any OS. */
const builtIn = () => commandShell({ ...probe('win32', {}, [], WINDOWS_ENV), embedded: true })

test('the built-in bash runs POSIX commands with their env, stdin, stderr apart and exit code', async () => {
  const proc = Bun.spawn(
    builtIn().argv(
      'read line; echo "got $line $MYR_X"; printf "%s\\n" b a | sort | head -1; echo oops >&2; exit 3',
    ),
    {
      stdin: new Blob(['{"hook":1}\n']),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, MYR_X: 'set' },
    },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(out.split(/\r?\n/).filter(Boolean)).toEqual(['got {"hook":1} set', 'a'])
  expect(err.trim()).toBe('oops')
  expect(code).toBe(3)
})

test('stopping a built-in bash command on its leash stops the programs it started', async () => {
  // A program of its own (not a builtin), as a dev server or a test runner would be.
  const bun = process.execPath.replaceAll('\\', '/')
  const program = `"${bun}" -e "console.log(process.pid); setTimeout(() => {}, 30000)"`
  const proc = spawnLeashed(builtIn().argv(program), { stdout: 'pipe', stderr: 'ignore' })
  const first = await proc.stdout.getReader().read()
  const pid = Number(new TextDecoder().decode(first.value).trim())
  expect(pid).toBeGreaterThan(0)
  expect(alive(pid)).toBe(true)
  const started = Date.now()
  proc.stdin.end()
  await proc.exited
  for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(100)
  expect(alive(pid)).toBe(false)
  expect(Date.now() - started).toBeLessThan(10_000)
})
