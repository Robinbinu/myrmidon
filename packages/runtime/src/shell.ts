import { existsSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { EMBEDDED_SHELL_COMMAND } from './config.ts'

/**
 * The shells Myrmidon runs commands in, per OS. macOS and Linux use `/bin/sh` for agents' commands and hooks; Windows
 * has no `/bin/sh`, so it uses Git for Windows' `sh` when installed (agents write POSIX commands, and most projects'
 * scripts assume them), else the bash Myrmidon carries (embedded-shell.ts), else PowerShell, else cmd.exe. Agents are
 * told which one runs their commands (the prompt's environment block), so they write its syntax.
 */

/** The syntax a shell's commands are written in. */
export type ShellSyntax = 'posix' | 'powershell' | 'cmd'

export interface CommandShell {
  /** What the prompt calls it: `sh`, `Git Bash`, `PowerShell 7`, `Windows PowerShell`, `cmd.exe`. */
  readonly name: string
  readonly syntax: ShellSyntax
  /** The program and arguments that run `command` to completion. */
  argv(command: string): string[]
  /**
   * Folders the shell's own commands live in, put first on a command's PATH (see `shellEnv`): Git's `usr\bin` and
   * `mingw64\bin` for Git Bash, whose `sh.exe` finds `mkdir` and the rest only there. None for the other shells.
   */
  readonly bins: readonly string[]
}

/** What picking a shell looks at, injected so each OS's choice is tested on any OS. */
export interface ShellProbe {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  which(name: string): string | null
  exists(path: string): boolean
  /** Whether the bash Myrmidon carries can run here; only Windows without Git Bash uses it. */
  readonly embedded?: boolean
}

export const hostProbe = (): ShellProbe => ({
  platform: process.platform,
  env: process.env,
  which: (name) => Bun.which(name),
  exists: existsSync,
  embedded: true,
})

const POSIX_SH: CommandShell = {
  name: 'sh',
  syntax: 'posix',
  argv: (command) => ['/bin/sh', '-c', command],
  bins: [],
}

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

/**
 * The folders of Git for Windows' own programs, for the `sh.exe` at `sh` (`<Git>\bin\sh.exe` or
 * `<Git>\usr\bin\sh.exe`): a PATH without them (a confined command's keeps only system folders and toolchains)
 * leaves its commands not found.
 */
export function gitBins(sh: string, probe: ShellProbe): string[] {
  const dir = win32.dirname(sh)
  const up = win32.dirname(dir)
  const root = win32.basename(up).toLowerCase() === 'usr' ? win32.dirname(up) : up
  return [win32.join(root, 'usr', 'bin'), win32.join(root, 'mingw64', 'bin')].filter((d) => probe.exists(d))
}

/** What the prompt and Settings call the bash Myrmidon carries. */
export const EMBEDDED_SHELL_NAME = 'built-in bash'

const EMBEDDED_WORKER = join(import.meta.dir, 'embedded-shell.ts')

/**
 * The bash Myrmidon carries (omp's brush, coreutils inside), run in a process of its own: from its file, or by a
 * compiled Myrmidon, which has no file to run, starting itself (apps/desktop/src/sidecar.ts). It runs outside any OS
 * sandbox, which Windows does not have yet; macOS and Linux never use it.
 */
const EMBEDDED_SHELL: CommandShell = {
  name: EMBEDDED_SHELL_NAME,
  syntax: 'posix',
  argv: (command) => [
    process.execPath,
    existsSync(EMBEDDED_WORKER) ? EMBEDDED_WORKER : EMBEDDED_SHELL_COMMAND,
    command,
  ],
  bins: [],
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
  if (sh)
    return {
      name: 'Git Bash',
      syntax: 'posix',
      argv: (command) => [sh, '-c', command],
      bins: gitBins(sh, probe),
    }
  if (probe.embedded) return EMBEDDED_SHELL
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
      bins: [],
    }
  // Only where the built-in bash and PowerShell are missing. Arguments reach cmd.exe quoted by C runtime rules, which it does not read, so a
  // command with double quotes in it may arrive changed.
  const cmd = probe.env.ComSpec ?? 'cmd.exe'
  return { name: 'cmd.exe', syntax: 'cmd', argv: (command) => [cmd, '/d', '/s', '/c', command], bins: [] }
}

let host: CommandShell | undefined
/** `commandShell()` for this machine, looked up once. */
export function hostShell(): CommandShell {
  host ??= commandShell()
  return host
}

/**
 * `env` for a command `shell` runs: its own folders (`CommandShell.bins`) first on PATH, kept under the name PATH has
 * there (Windows' environment names ignore case, and it is usually `Path`).
 */
export function shellEnv<T extends Record<string, string | undefined>>(
  env: T,
  shell: CommandShell = hostShell(),
): T {
  if (!shell.bins.length) return env
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [key]: [...shell.bins, env[key]].filter(Boolean).join(win32.delimiter) }
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
