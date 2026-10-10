import { expect, test } from 'bun:test'
import { commandShell, gitSh, powershellScript, type ShellProbe, terminalShell } from '../src/shell.ts'

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
