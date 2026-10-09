import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/**
 * Devices paired with a Myrmidon gateway that is reachable beyond this machine, after Hermes and OpenClaw: each gets
 * its own token, which the person can revoke, and a scope. Only a hash of each token is stored.
 */

/**
 * `full`: everything. `chat`: chats, the changes their crews made, and approvals, but not the terminal, the person's
 * own browser, keys, Settings, plugins, devices or browsing a project's files.
 */
export type DeviceScope = 'full' | 'chat'

export interface Device {
  readonly id: string
  readonly name: string
  readonly scope: DeviceScope
  /** SHA-256 of the device token, hex. */
  readonly tokenHash: string
  readonly createdAt: string
  /** Paired by another Myrmidon acting as a hub, which keeps the token itself. */
  readonly hub?: boolean
  lastSeenAt?: string
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/** `<home>/devices.json`, readable only by this user. */
export class DeviceStore {
  private readonly _file: string
  private _cache?: Device[]

  constructor(home: string) {
    this._file = join(home, 'devices.json')
  }

  list(): Device[] {
    if (this._cache) return this._cache
    if (!existsSync(this._file)) {
      this._cache = []
      return this._cache
    }
    try {
      const raw = JSON.parse(readFileSync(this._file, 'utf8')) as unknown
      this._cache = Array.isArray(raw)
        ? (raw as Device[]).filter((d) => d && typeof d.tokenHash === 'string')
        : []
    } catch {
      this._cache = []
    }
    return this._cache
  }

  /** Pairs a device: returns it and its token, which is shown once and never stored. */
  add(name: string, scope: DeviceScope, hub = false): { device: Device; token: string } {
    const token = randomBytes(32).toString('base64url')
    const device: Device = {
      id: `dev-${randomBytes(6).toString('hex')}`,
      name: name.trim().slice(0, 60) || 'Device',
      scope,
      tokenHash: hash(token),
      createdAt: new Date().toISOString(),
      ...(hub ? { hub: true } : {}),
    }
    this._write([...this.list(), device])
    return { device, token }
  }

  /** The device a token belongs to, noting when it was last seen (at most once a minute, to spare the disk). */
  find(token: string): Device | undefined {
    if (!token) return undefined
    const h = hash(token)
    const device = this.list().find((d) => d.tokenHash === h)
    if (device && Date.now() - Date.parse(device.lastSeenAt ?? '0') > 60_000) {
      device.lastSeenAt = new Date().toISOString()
      this._write(this.list())
    }
    return device
  }

  revoke(id: string): boolean {
    const all = this.list()
    const rest = all.filter((d) => d.id !== id)
    if (rest.length === all.length) return false
    this._write(rest)
    return true
  }

  private _write(list: Device[]) {
    this._cache = list
    writePrivateJson(this._file, list)
  }
}

/** Writes JSON readable only by this user, atomically (a crash leaves the old file, never half a new one). */
export function writePrivateJson(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/** No look-alike characters (0/O, 1/I/L), so a code read aloud or retyped survives. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 10
export const PAIRING_MS = 10 * 60_000
/** Wrong codes before every open code is withdrawn: guessing cannot outlast the pairing window. */
const MAX_WRONG = 10

/** Single-use pairing codes, kept only in memory: a restart withdraws them all. */
export class PairingCodes {
  private readonly _codes = new Map<string, { scope: DeviceScope; expires: number }>()
  private _wrong = 0

  create(scope: DeviceScope): string {
    const bytes = randomBytes(CODE_LENGTH)
    const code = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('')
    this._codes.set(code, { scope, expires: Date.now() + PAIRING_MS })
    this._wrong = 0
    return code
  }

  /** The scope a code grants, once; undefined for a wrong, used or expired code. */
  take(code: string): DeviceScope | undefined {
    const key = code.trim().toUpperCase()
    const entry = this._codes.get(key)
    this._codes.delete(key)
    if (entry && entry.expires > Date.now()) return entry.scope
    if (++this._wrong >= MAX_WRONG) this._codes.clear()
    return undefined
  }
}

/**
 * Requests a `chat` device may not make: the terminal, the person's own browser, keys and providers, Settings and permission changes, plugins,
 * MCP servers, hooks, browsing the server's folders or a project's files, git actions on projects, managing devices,
 * other gateways, and channels.
 */
export function needsFull(method: string, path: string): boolean {
  const write = method !== 'GET' && method !== 'HEAD'
  // Other gateways, reached through this one: a chats-only device must not borrow this hub's access to them.
  if (path.startsWith('/gw/')) return true
  if (
    /^\/api\/(terminal|browser|credentials|providers|logins|devices|gateways|channels|import-omp|folders|mcp-reload|setup)(\/|$)/.test(
      path,
    )
  )
    return true
  if (/^\/api\/projects\/[^/]+\/(permissions|git\/(?!changes|diff|commits)[^/]+)$/.test(path)) return true
  // Browsing a project's files reaches every file in it (`.env` and other keys included), not just what a chat changed.
  if (/^\/api\/projects\/[^/]+\/(file|tree|find)$/.test(path)) return true
  // Skills and schedules are managed in Settings; a schedule can also deliver to a channel.
  if (write && /^\/api\/(settings|plugins|mcp|hooks|skills|schedules)(\/|$)/.test(path)) return true
  // Taking back apps a chat may control on the person's Mac is a permission change, as is a chat's preset or rules
  // (approving a step, and remembering it for that chat, stays open: see the approvals route).
  if (write && /^\/api\/chats\/[^/]+\/(computer-apps|permissions)$/.test(path)) return true
  // Installing the computer-use driver and asking for its grants; Stop stays open to every device, as a safety stop.
  if (write && /^\/api\/computer\/(install|grants|restart)(\/|$)/.test(path)) return true
  // Installing speech engines, keys and samples, and phoning someone; calling (a GET that upgrades) stays open.
  if (write && /^\/api\/voice\/(phonon|kitten|keys|sample|phone)(\/|$)/.test(path)) return true
  // Adding or removing a project; reading the list stays open so chats show their folder.
  if (write && /^\/api\/projects(\/[^/]+)?$/.test(path)) return true
  return false
}

/** What the audit log records; never a token or a code. */
export type AuthEvent = 'paired' | 'pair-failed' | 'revoked' | 'rejected'

const AUDIT_MAX_BYTES = 5 * 1024 * 1024

/**
 * `<home>/logs/device-auth.log`: one JSON line per pairing, failed code, revocation or rejected device, so the person
 * can see who got in and who tried (after Hermes's dashboard-auth log). Rotated once at 5 MB.
 */
export class AuthAudit {
  private readonly _file: string

  constructor(home: string) {
    const dir = join(home, 'logs')
    mkdirSync(dir, { recursive: true })
    this._file = join(dir, 'device-auth.log')
  }

  record(event: AuthEvent, fields: Record<string, string | undefined> = {}) {
    try {
      if (existsSync(this._file) && statSync(this._file).size > AUDIT_MAX_BYTES)
        renameSync(this._file, `${this._file}.1`)
      const line = { at: new Date().toISOString(), event, ...fields }
      appendFileSync(this._file, `${JSON.stringify(line)}\n`, { mode: 0o600 })
    } catch (err) {
      // The log helps the person audit; it must never stop a request.
      console.error(`device-auth log: ${err instanceof Error ? err.message : err}`)
    }
  }
}
