import { chmodSync } from 'node:fs'
import { userInfo } from 'node:os'
import { win32 } from 'node:path'

/**
 * Files that hold keys and sign-ins (server.json's token, models.yml, mcp.json, paired devices, channel accounts) are
 * kept to the person's own account. On macOS and Linux that is mode 0600. On Windows chmod only sets the read-only
 * flag, and a new file inherits its folder's access list, so the file's list is replaced instead: inherited entries
 * dropped, full control for this account alone.
 */

/** The icacls command that leaves `path` to `account` alone (`icacls` itself from the system folder `systemRoot`). */
export function ownerOnlyCommand(path: string, account: string, systemRoot = 'C:\\Windows'): string[] {
  return [
    win32.join(systemRoot, 'System32', 'icacls.exe'),
    path,
    '/inheritance:r',
    '/grant:r',
    `${account}:F`,
  ]
}

/** This account as icacls names it: `DOMAIN\user` when Windows says the domain (the computer's name, if none). */
export function windowsAccount(env: Record<string, string | undefined> = process.env): string {
  const user = env.USERNAME ?? userInfo().username
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user
}

export interface OwnerOnlyOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: Record<string, string | undefined>
  /** Runs a command and says whether it worked (tests stand in for icacls). */
  readonly run?: (argv: string[]) => { ok: boolean; output: string }
  readonly log?: (line: string) => void
}

const runSync = (argv: string[]) => {
  const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
  return { ok: r.exitCode === 0, output: `${r.stdout.toString()}${r.stderr.toString()}`.trim() }
}

/**
 * Makes `path` readable and writable by this account alone: `mode` (0600 by default) where modes exist, its access list
 * on Windows. That is best effort there: the file is still written when icacls fails, and the failure is logged.
 */
export function ownerOnly(path: string, mode = 0o600, options: OwnerOnlyOptions = {}): void {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    chmodSync(path, mode)
    return
  }
  const env = options.env ?? process.env
  const argv = ownerOnlyCommand(path, windowsAccount(env), env.SystemRoot ?? env.SYSTEMROOT ?? env.windir)
  let result: { ok: boolean; output: string }
  try {
    result = (options.run ?? runSync)(argv)
  } catch (err) {
    result = { ok: false, output: err instanceof Error ? err.message : String(err) }
  }
  if (!result.ok)
    (options.log ?? console.warn)(
      `could not limit ${path} to this account: ${result.output || 'icacls failed'}`,
    )
}
