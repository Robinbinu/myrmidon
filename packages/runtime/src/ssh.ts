import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { validateHostName } from '@oh-my-pi/pi-coding-agent/ssh/config-writer'
import {
  resolveSshControlDir,
  supportsSshControlMaster,
} from '@oh-my-pi/pi-coding-agent/ssh/connection-manager'
import { buildSshTarget, wrapInPosixShell } from '@oh-my-pi/pi-coding-agent/ssh/utils'
import { assertOwnerPrivateDir } from '@oh-my-pi/pi-coding-agent/utils/owner-private-dir'
import { quotePosixArgument } from '@oh-my-pi/pi-coding-agent/utils/shell-quote'
import { SANDBOX_MAX_OUTPUT, SSH } from './config.ts'

/**
 * The person's remote hosts, reached with their own ssh client: an agent runs a command or reads a file on a host they
 * added in Settings → Tools, each call decided by the permission model (`ssh-host` rules name a host, tools.ts).
 * Myrmidon never holds a key: ssh finds it in the person's agent or keychain, and a host added from ~/.ssh/config
 * keeps its HostName, User, IdentityFile and ProxyJump there.
 *
 * After omp's ssh connection manager (pi-coding-agent/src/ssh/connection-manager.ts), whose pure parts are reused: one
 * shared connection per host (ControlMaster, where the platform has it: not Windows), started with `-M -N -f` and
 * checked with `-O check` before use; BatchMode, so a password or passphrase prompt fails instead of waiting for
 * nobody; new host keys accepted once and changed ones refused; the argument-injection guard on host and user names;
 * and its control-socket sizing. Unlike omp, the sockets live in Myrmidon's home, and nothing about a host is cached
 * on disk.
 */

/** A remote host as Settings keeps it: `host` is an address or an alias from ~/.ssh/config. */
export interface SshHost {
  /** What agents and rules call it. */
  readonly name: string
  readonly host: string
  readonly user?: string
  readonly port?: number
}

/** A Host entry of ~/.ssh/config, for Settings to offer: its alias with what the file says it reaches. */
export interface SshConfigHost {
  readonly name: string
  readonly hostName?: string
  readonly user?: string
  readonly port?: number
}

/** Whether `name` may name a host, by omp's rule for its own host names (letters, digits, dash, underscore, dot). */
export function sshHostNameError(name: string): string | undefined {
  return validateHostName(name)
}

/**
 * The aliases a ~/.ssh/config text names, in order, with the HostName, User and Port each block gives them (the first
 * value wins, as in ssh). Patterns (`*`, `?`, `!`) are not hosts one can connect to and are left out; `include` reads
 * an Include line's files, relative to ~/.ssh.
 */
export function parseSshConfig(text: string, include?: (pattern: string) => string[]): SshConfigHost[] {
  const out = new Map<string, { name: string; hostName?: string; user?: string; port?: number }>()
  let current: { name: string; hostName?: string; user?: string; port?: number }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line)
    if (!m) continue
    const key = (m[1] ?? '').toLowerCase()
    const value = (m[2] ?? '').trim().replace(/^"(.*)"$/, '$1')
    if (key === 'host') {
      current = value
        .split(/\s+/)
        .filter((alias) => alias && !/[*?!]/.test(alias) && !validateHostName(alias))
        .map((alias) => {
          const entry = out.get(alias) ?? { name: alias }
          out.set(alias, entry)
          return entry
        })
    } else if (key === 'match') {
      current = []
    } else if (key === 'include' && include) {
      for (const pattern of value.split(/\s+/))
        for (const text of include(pattern))
          for (const h of parseSshConfig(text)) if (!out.has(h.name)) out.set(h.name, { ...h })
    } else {
      for (const entry of current) {
        if (key === 'hostname') entry.hostName ??= value
        if (key === 'user') entry.user ??= value
        if (key === 'port' && /^\d{1,5}$/.test(value)) entry.port ??= Number(value)
      }
    }
  }
  return [...out.values()]
}

/** The person's ~/.ssh/config, with the files it includes; empty when there is none. */
export function readSshConfig(home = homedir()): SshConfigHost[] {
  const dir = join(home, '.ssh')
  const file = join(dir, 'config')
  if (!existsSync(file)) return []
  const include = (pattern: string): string[] => {
    const expanded = pattern.startsWith('~/') ? join(home, pattern.slice(2)) : pattern
    const base = isAbsolute(expanded) ? dirname(expanded) : dir
    const glob = isAbsolute(expanded) ? expanded.slice(base.length + 1) : expanded
    try {
      return [...new Bun.Glob(glob).scanSync({ cwd: base, absolute: true })].map((f) =>
        readFileSync(f, 'utf8'),
      )
    } catch {
      return []
    }
  }
  try {
    return parseSshConfig(readFileSync(file, 'utf8'), include)
  } catch {
    return []
  }
}

export interface SshRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/**
 * Reads a stream to its end, or until `stop` aborts, keeping its first `max` bytes, so a flood of output cannot fill
 * memory and a process left holding the pipe (ssh's backgrounded connection) cannot hold the read forever.
 */
async function capture(
  stream: ReadableStream<Uint8Array>,
  max: number,
  stop: AbortSignal,
): Promise<{ bytes: Uint8Array; cut: boolean }> {
  const kept: Uint8Array[] = []
  let size = 0
  let cut = false
  const reader = stream.getReader()
  stop.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true })
  for (;;) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    if (size >= max) {
      cut = true
      continue
    }
    const part = chunk.subarray(0, max - size)
    if (part.length < chunk.length) cut = true
    kept.push(part)
    size += part.length
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const k of kept) {
    bytes.set(k, at)
    at += k.length
  }
  return { bytes, cut }
}

export interface SshHubOptions {
  /** Where the shared connections' sockets go (in Myrmidon's home); a short fallback is used when it is too long. */
  readonly controlDir: string
  /** The ssh program; `ssh` on the PATH unless given (tests give a stand-in). */
  readonly binary?: string
  readonly platform?: NodeJS.Platform
}

/** Runs commands and reads files on the person's hosts, keeping one connection open per host while it is used. */
export class SshHub {
  private readonly _binary: string
  private readonly _platform: NodeJS.Platform
  private readonly _control?: { dir: string; shared: boolean }
  /** Hosts whose shared connection was checked lately, by name, and what it was checked for. */
  private readonly _verified = new Map<string, { at: number; target: string; host: SshHost }>()
  private readonly _pending = new Map<string, Promise<void>>()

  constructor(options: SshHubOptions) {
    this._binary = options.binary ?? 'ssh'
    this._platform = options.platform ?? process.platform
    if (supportsSshControlMaster(this._platform))
      this._control = resolveSshControlDir({
        canonicalDir: options.controlDir,
        platform: this._platform,
        uid: process.getuid?.(),
      })
  }

  /** Whether ssh can be run here. */
  available(): boolean {
    return isAbsolute(this._binary) ? existsSync(this._binary) : Bun.which(this._binary) !== null
  }

  private _options(host: SshHost): string[] {
    const control = this._control
      ? [
          '-o',
          'ControlMaster=auto',
          '-o',
          `ControlPath=${join(this._control.dir, '%C.sock')}`,
          '-o',
          `ControlPersist=${SSH.persistS}`,
        ]
      : []
    return [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `ConnectTimeout=${SSH.connectS}`,
      ...control,
      ...(host.port ? ['-p', String(host.port)] : []),
    ]
  }

  private async _spawn(
    args: string[],
    timeoutMs: number,
    max = SANDBOX_MAX_OUTPUT,
  ): Promise<SshRun & { bytes: Uint8Array }> {
    const proc = Bun.spawn([this._binary, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeoutMs)
    const stop = new AbortController()
    try {
      const output = Promise.all([
        capture(proc.stdout, max, stop.signal),
        capture(proc.stderr, max, stop.signal),
      ])
      const code = await proc.exited
      // `ssh -f` leaves its backgrounded connection holding the pipes: what was written is read, then the rest goes.
      const drained = await Promise.race([output.then(() => true), Bun.sleep(SSH.drainMs).then(() => false)])
      if (!drained) stop.abort()
      const [out, err] = await output
      const text = (b: Uint8Array) => new TextDecoder().decode(b)
      return { code, stdout: text(out.bytes), stderr: text(err.bytes), timedOut, bytes: out.bytes }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Starts the host's shared connection unless one is open, as omp's ensureConnection does. */
  private async _connect(host: SshHost): Promise<void> {
    const control = this._control
    if (!control) return
    const target = buildSshTarget(host.user, host.host)
    const key = `${target}:${host.port ?? ''}`
    mkdirSync(control.dir, { recursive: true, mode: 0o700 })
    // A fallback in the shared temp folder may have been made by someone else first.
    if (control.shared) assertOwnerPrivateDir(control.dir, 'SSH control directory')
    const seen = this._verified.get(host.name)
    if (seen && seen.target === key && Date.now() - seen.at < 30_000) return
    const pending = this._pending.get(key)
    if (pending) return pending
    const start = (async () => {
      const options = this._options(host)
      const check = await this._spawn(['-O', 'check', ...options, target], SSH.connectS * 1000)
      if (check.code !== 0) {
        const master = await this._spawn(['-M', '-N', '-f', ...options, target], (SSH.connectS + 5) * 1000)
        if (master.code !== 0)
          throw new Error(
            `could not connect to ${host.name}${master.stderr.trim() ? `: ${master.stderr.trim()}` : ''}`,
          )
      }
      this._verified.set(host.name, { at: Date.now(), target: key, host })
    })()
    this._pending.set(key, start)
    try {
      await start
    } finally {
      this._pending.delete(key)
    }
  }

  /** Runs `command` on the host through its login shell, as `ssh host command` does. */
  async run(host: SshHost, command: string, timeoutMs: number): Promise<SshRun> {
    const target = buildSshTarget(host.user, host.host)
    await this._connect(host)
    const r = await this._spawn(['-n', ...this._options(host), target, command], timeoutMs)
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
  }

  /**
   * A file's text, up to `maxBytes`, read with POSIX `head` under `sh` (omp's ssh:// read): a Windows host without a
   * POSIX shell cannot be read this way, and says so.
   */
  async read(
    host: SshHost,
    path: string,
    maxBytes: number,
    timeoutMs: number,
  ): Promise<{ text: string; truncated: boolean }> {
    const target = buildSshTarget(host.user, host.host)
    await this._connect(host)
    const command = wrapInPosixShell('sh', `head -c ${maxBytes + 1} -- ${quotePosixArgument(path)}`)
    const r = await this._spawn(['-n', ...this._options(host), target, command], timeoutMs, maxBytes + 1)
    if (r.timedOut) throw new Error(`reading ${path} on ${host.name} took too long`)
    if (r.code !== 0)
      throw new Error(r.stderr.trim() || `reading ${path} on ${host.name} failed (exit ${r.code})`)
    const truncated = r.bytes.length > maxBytes
    return { text: new TextDecoder().decode(r.bytes.subarray(0, maxBytes)), truncated }
  }

  /** Whether the host answers (Settings' Test button), and why not when it does not. */
  async test(host: SshHost): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.available()) return { ok: false, error: 'ssh is not installed on this computer' }
    try {
      const r = await this.run(host, 'echo myrmidon-ok', SSH.testS * 1000)
      if (r.code === 0 && r.stdout.includes('myrmidon-ok')) return { ok: true }
      return { ok: false, error: (r.timedOut ? 'timed out' : r.stderr.trim()) || `exit ${r.code}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Closes every shared connection this hub started. */
  async close(): Promise<void> {
    for (const { host } of [...this._verified.values()]) await this.forget(host)
  }

  /**
   * Closes the shared connection to `host` (a host removed or changed in Settings), so the next call connects as it is
   * set up now.
   */
  async forget(host: SshHost): Promise<void> {
    this._verified.delete(host.name)
    if (!this._control) return
    await this._spawn(
      ['-O', 'exit', ...this._options(host), buildSshTarget(host.user, host.host)],
      SSH.connectS * 1000,
    ).catch(() => {})
  }
}
