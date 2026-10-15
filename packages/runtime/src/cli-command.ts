import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CLI_COMMAND } from './config.ts'
import { prompts } from './prompts.ts'

/**
 * Whether this is a compiled Myrmidon (the desktop app's server, apps/desktop/src/sidecar.ts): Bun serves a compiled
 * executable's modules from a virtual folder, `/$bunfs/root` (`B:\~BUN\root` on Windows). Run from source, there is
 * no executable of Myrmidon's own to link: process.execPath is Bun.
 */
const COMPILED = /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(import.meta.path)

/** This Myrmidon's own executable when it is the compiled one, the file `myrmidon` links to; otherwise undefined. */
export const compiledBinary = (): string | undefined => (COMPILED ? process.execPath : undefined)

/**
 * unavailable: not the compiled app (a development build); missing: nothing at the link; installed: it is this app's
 * command; broken: a link into a copy of the app that is gone (the app moved or was deleted); elsewhere: a link to
 * another copy of the app; taken: something there that is not Myrmidon's, which is never touched.
 */
export type CliCommandState = 'unavailable' | 'missing' | 'installed' | 'broken' | 'elsewhere' | 'taken'

export interface CliCommandStatus {
  state: CliCommandState
  /** Where the command goes: ~/.local/bin/myrmidon. */
  link: string
  /** What the link points to now, when it is a link. */
  target?: string
  /** Why it cannot be installed here. */
  reason?: string
  /** Whether ~/.zprofile has the block that puts the link's folder on PATH. */
  profileBlock: boolean
}

export class CliCommandError extends Error {}

/**
 * The `myrmidon` command in a terminal, installed from the desktop app the way VS Code installs `code`, but with no
 * password: a link in ~/.local/bin to the app's own executable, and, when a login shell does not have that folder on
 * PATH already, one marked block in ~/.zprofile that puts it there. Removing takes away only the link when it points
 * into a Myrmidon app, and only that block.
 */
export class CliCommand {
  readonly link: string
  private readonly _home: string
  private readonly _binary: string | undefined
  private readonly _loginPath: () => Promise<string | undefined>

  constructor(
    options: {
      home?: string
      /** The executable to link to; undefined in a development build, where installing is not offered. */
      binary?: string | undefined
      /** The PATH a new terminal window gets; asks a zsh login shell unless given. */
      loginPath?: () => Promise<string | undefined>
    } = {},
  ) {
    this._home = options.home ?? homedir()
    this._binary = options.binary
    this.link = join(this._home, CLI_COMMAND.folder, CLI_COMMAND.name)
    this._loginPath = options.loginPath ?? (() => loginShellPath(this._home))
  }

  private get _profile(): string {
    return join(this._home, CLI_COMMAND.profile)
  }

  status(): CliCommandStatus {
    const profileBlock = hasBlock(readText(this._profile))
    if (!this._binary)
      return { state: 'unavailable', link: this.link, reason: prompts.cliCommand.unavailable, profileBlock }
    const stat = lstatSync(this.link, { throwIfNoEntry: false })
    if (!stat) return { state: 'missing', link: this.link, profileBlock }
    if (!stat.isSymbolicLink()) return { state: 'taken', link: this.link, profileBlock }
    const target = resolve(dirname(this.link), readlinkSync(this.link))
    const at = { link: this.link, target, profileBlock }
    if (!existsSync(target)) return { state: this._ours(target) ? 'broken' : 'taken', ...at }
    if (sameFile(target, this._binary)) return { state: 'installed', ...at }
    return { state: this._ours(target) ? 'elsewhere' : 'taken', ...at }
  }

  /**
   * Links the command to this app (replacing a link to another copy of it, or a broken one) and, unless a login shell
   * finds ~/.local/bin already, adds the PATH block to ~/.zprofile. Installing again changes nothing.
   */
  async install(): Promise<CliCommandStatus> {
    const now = this.status()
    const binary = this._binary
    if (now.state === 'unavailable' || !binary) throw new CliCommandError(prompts.cliCommand.unavailable)
    if (now.state === 'taken') throw new CliCommandError(prompts.cliCommand.taken(this.link))
    if (now.state !== 'installed') this._linkTo(binary)
    if (!now.profileBlock) {
      const folder = join(this._home, CLI_COMMAND.folder)
      const path = await this._loginPath().catch(() => undefined)
      if (!path?.split(':').some((p) => p.replace(/\/+$/, '') === folder)) {
        const before = readText(this._profile)
        writeFileSync(this._profile, withBlock(before))
      }
    }
    return this.status()
  }

  /** Takes the command away: the link only when it is Myrmidon's, and the PATH block only as this added it. */
  remove(): CliCommandStatus {
    const now = this.status()
    if (now.state === 'unavailable') throw new CliCommandError(prompts.cliCommand.unavailable)
    if (now.state === 'installed' || now.state === 'broken' || now.state === 'elsewhere')
      unlinkSync(this.link)
    const before = readText(this._profile)
    if (before !== undefined && hasBlock(before)) writeFileSync(this._profile, withoutBlock(before))
    return this.status()
  }

  /**
   * At launch, for a person who installed the command: a link left pointing at a copy of the app that moved or was
   * replaced points at this one again. Nothing is created that is not there: a removed link stays removed.
   */
  repair(): boolean {
    const now = this.status()
    if (!this._binary || (now.state !== 'broken' && now.state !== 'elsewhere')) return false
    this._linkTo(this._binary)
    return true
  }

  private _ours(target: string): boolean {
    return CLI_COMMAND.appBinary.test(target) || (!!this._binary && target === this._binary)
  }

  private _linkTo(binary: string) {
    mkdirSync(dirname(this.link), { recursive: true })
    if (lstatSync(this.link, { throwIfNoEntry: false })) unlinkSync(this.link)
    symlinkSync(binary, this.link)
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return a === b
  }
}

const p = prompts.cliCommand
const BLOCK = [p.blockStart, p.blockNote, `export PATH="$HOME/${CLI_COMMAND.folder}:$PATH"`, p.blockEnd]

export const hasBlock = (text: string | undefined): boolean =>
  !!text?.split('\n').some((line) => line === p.blockStart)

/** The file with the PATH block at its end (last, so its folder comes first on PATH), after a blank line. */
export function withBlock(text: string | undefined): string {
  if (hasBlock(text)) return text ?? ''
  const body = text ?? ''
  const gap = !body ? '' : body.endsWith('\n') ? '\n' : '\n\n'
  return `${body}${gap}${BLOCK.join('\n')}\n`
}

/** The file without the PATH block (from its start line to its end line) and the blank line put before it. */
export function withoutBlock(text: string): string {
  const lines = text.split('\n')
  const start = lines.indexOf(p.blockStart)
  const end = lines.indexOf(p.blockEnd, start)
  if (start < 0 || end < 0) return text
  const from = start > 0 && lines[start - 1] === '' ? start - 1 : start
  lines.splice(from, end - from + 1)
  return lines.join('\n')
}

/**
 * The PATH a new Terminal window starts with: a zsh login shell's (macOS opens every Terminal window as one), which
 * reads /etc/zprofile (path_helper) and ~/.zprofile but not ~/.zshrc. Undefined when it does not answer in time.
 */
async function loginShellPath(home: string): Promise<string | undefined> {
  const mark = '__MYRMIDON_PATH__'
  const proc = Bun.spawn([CLI_COMMAND.shell, '-l', '-c', `printf '\\n${mark}%s' "$PATH"`], {
    env: { ...process.env, HOME: home },
    cwd: home,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: CLI_COMMAND.probeMs,
  })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  const at = out.lastIndexOf(mark)
  return proc.exitCode === 0 && at >= 0 ? out.slice(at + mark.length) : undefined
}
