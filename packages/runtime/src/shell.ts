import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

/**
 * The shells Myrmidon runs commands in, per OS. macOS and Linux use `/bin/sh` for agents' commands and hooks; Windows
 * has no `/bin/sh`, so it uses Git for Windows' `sh` when installed (agents write POSIX commands, and most projects'
 * scripts assume them), else PowerShell, else cmd.exe. Agents are told which one runs their commands (the prompt's
 * environment block), so they write its syntax.
 */

/** The syntax a shell's commands are written in. */
export type ShellSyntax = 'posix' | 'powershell' | 'cmd'

export interface CommandShell {
  /** What the prompt calls it: `sh`, `Git Bash`, `PowerShell 7`, `Windows PowerShell`, `cmd.exe`. */
  readonly name: string
  readonly syntax: ShellSyntax
  /** The program and arguments that run `command` to completion. */
  argv(command: string): string[]
}

/** What picking a shell looks at, injected so each OS's choice is tested on any OS. */
export interface ShellProbe {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  which(name: string): string | null
  exists(path: string): boolean
}

export const hostProbe = (): ShellProbe => ({
  platform: process.platform,
  env: process.env,
  which: (name) => Bun.which(name),
  exists: existsSync,
})

const POSIX_SH: CommandShell = { name: 'sh', syntax: 'posix', argv: (command) => ['/bin/sh', '-c', command] }

/**
 * PowerShell runs the command as given; the last line makes its exit code the command's, as `sh -c` does: the native
 * program's code when it failed, else 1 when the last statement failed. Progress bars are off, since Windows
 * PowerShell writes them to a redirected stderr as CLIXML, and output is UTF-8 so non-ASCII text survives the pipe
 * (where there is a console to set it on: a hidden one may refuse).
 */
export function powershellScript(command: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}',
    command,
    'if (-not $?) { exit $(if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }) }',
  ].join('\n')
}

/**
 * Git for Windows' `sh.exe`: on PATH (not System32's, which is WSL's), else beside `git` (`<Git>\cmd\git.exe` →
 * `<Git>\bin\sh.exe`, which sets up Git's own PATH for coreutils), else in the usual install folders.
 */
export function gitSh(probe: ShellProbe): string | undefined {
  const { env } = probe
  const system = (env.SystemRoot ?? env.windir ?? 'C:\\Windows').toLowerCase()
  const onPath = probe.which('sh')
  if (onPath && !onPath.toLowerCase().startsWith(system)) return onPath
  const roots: string[] = []
  const git = probe.which('git')
  if (git) {
    // `<Git>\cmd\git.exe`, `<Git>\bin\git.exe` or `<Git>\mingw64\bin\git.exe`.
    const dir = win32.dirname(git)
    roots.push(win32.dirname(dir), win32.dirname(win32.dirname(dir)))
  }
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432])
    if (base) roots.push(win32.join(base, 'Git'))
  if (env.LOCALAPPDATA) roots.push(win32.join(env.LOCALAPPDATA, 'Programs', 'Git'))
  return roots.map((root) => win32.join(root, 'bin', 'sh.exe')).find((path) => probe.exists(path))
}

/** PowerShell 7 (`pwsh`) or the Windows PowerShell every Windows has, as a program to run. */
function powershell(probe: ShellProbe): { path: string; name: string } | undefined {
  const pwsh = probe.which('pwsh')
  if (pwsh) return { path: pwsh, name: 'PowerShell 7' }
  const builtIn = probe.which('powershell')
  if (builtIn) return { path: builtIn, name: 'Windows PowerShell' }
  const system = probe.env.SystemRoot ?? probe.env.windir
  const path = system && win32.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return path && probe.exists(path) ? { path, name: 'Windows PowerShell' } : undefined
}

/** The shell agents' commands and the person's hooks run in on this OS. */
export function commandShell(probe: ShellProbe = hostProbe()): CommandShell {
  if (probe.platform !== 'win32') return POSIX_SH
  const sh = gitSh(probe)
  if (sh) return { name: 'Git Bash', syntax: 'posix', argv: (command) => [sh, '-c', command] }
  const ps = powershell(probe)
  if (ps)
    return {
      name: ps.name,
      syntax: 'powershell',
      argv: (command) => [
        ps.path,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        powershellScript(command),
      ],
    }
  // Only where PowerShell is missing. Arguments reach cmd.exe quoted by C runtime rules, which it does not read, so a
  // command with double quotes in it may arrive changed.
  const cmd = probe.env.ComSpec ?? 'cmd.exe'
  return { name: 'cmd.exe', syntax: 'cmd', argv: (command) => [cmd, '/d', '/s', '/c', command] }
}

let host: CommandShell | undefined
/** `commandShell()` for this machine, looked up once. */
export function hostShell(): CommandShell {
  host ??= commandShell()
  return host
}

/**
 * The person's own interactive shell for the terminal view: their login shell on macOS (zsh by default) and Linux
 * (bash, else sh: zsh is rarely installed there), PowerShell (else cmd.exe) on Windows.
 */
export function terminalShell(probe: ShellProbe = hostProbe()): string[] {
  if (probe.platform === 'win32') {
    const ps = powershell(probe)
    return ps ? [ps.path, '-NoLogo'] : [probe.env.ComSpec ?? 'cmd.exe']
  }
  if (probe.env.SHELL) return [probe.env.SHELL, '-l']
  if (probe.platform === 'darwin') return ['/bin/zsh', '-l']
  return [probe.exists('/bin/bash') ? '/bin/bash' : '/bin/sh', '-l']
}
