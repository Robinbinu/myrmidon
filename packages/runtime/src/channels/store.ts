import { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelChat, ChannelSender } from './types.ts'

/** Someone allowed to talk to the agents through a channel. */
export interface ChannelPerson {
  readonly id: string
  readonly name: string
  readonly handle?: string
  /** The first person approved; only the owner approves risky steps. */
  readonly role: 'owner' | 'member'
  readonly approvedAt: string
}

export interface ChannelGroup {
  readonly id: string
  readonly title: string
  readonly approvedAt: string
}

/** A stranger (or a group) waiting for the owner to approve the code they were sent. */
export interface PairingRequest {
  /** For approving from Settings without the code. */
  readonly id: string
  readonly codeHash: string
  readonly kind: 'person' | 'group'
  readonly sender: ChannelSender
  readonly chat: ChannelChat
  readonly createdAt: string
  readonly expires: string
}

export interface ChannelConfig {
  token?: string
  enabled: boolean
  /** The project new chats from this channel work in. */
  project?: string
  people: ChannelPerson[]
  groups: ChannelGroup[]
  pending: PairingRequest[]
  /** Platform chat id → the Myrmidon chat it continues. */
  chats: Record<string, string>
  /** When each sender last got a code (one per sender per PAIR_EVERY_MS). */
  asked: Record<string, string>
}

/** No look-alike characters, so a code read off a phone survives retyping (as Hermes and OpenClaw do). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
export const PAIR_TTL_MS = 60 * 60_000
const PAIR_EVERY_MS = 10 * 60_000
/** Codes waiting at once per channel; more strangers are ignored until some expire. */
const MAX_PENDING = 3

const hash = (code: string) => createHash('sha256').update(code.trim().toUpperCase()).digest('hex')
const empty = (): ChannelConfig => ({
  enabled: false,
  people: [],
  groups: [],
  pending: [],
  chats: {},
  asked: {},
})

/** `<home>/channels/channels.json`, readable only by this user (it holds bot tokens). */
export class ChannelStore {
  private readonly _file: string

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this._file = join(dir, 'channels.json')
  }

  private _all(): Record<string, ChannelConfig> {
    if (!existsSync(this._file)) return {}
    try {
      return JSON.parse(readFileSync(this._file, 'utf8')) as Record<string, ChannelConfig>
    } catch {
      return {}
    }
  }

  get(channel: string): ChannelConfig {
    const now = Date.now()
    const config = { ...empty(), ...this._all()[channel] }
    config.pending = config.pending.filter((p) => Date.parse(p.expires) > now)
    return config
  }

  /** Changes one channel's settings and saves them atomically. */
  update<T>(channel: string, change: (config: ChannelConfig) => T): T {
    const all = this._all()
    const config = this.get(channel)
    const result = change(config)
    all[channel] = config
    const tmp = `${this._file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this._file)
    return result
  }

  /**
   * A pairing code for a stranger or a group: undefined when they already have one waiting, asked too recently, or
   * the channel has as many waiting as it allows.
   */
  request(channel: string, kind: PairingRequest['kind'], sender: ChannelSender, chat: ChannelChat) {
    return this.update(channel, (c) => {
      const now = Date.now()
      const who = kind === 'group' ? `group:${chat.id}` : sender.id
      const last = c.asked[who]
      if (last && now - Date.parse(last) < PAIR_EVERY_MS) return undefined
      if (c.pending.length >= MAX_PENDING) return undefined
      const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
      c.pending.push({
        id: randomBytes(5).toString('hex'),
        codeHash: hash(code),
        kind,
        sender,
        chat,
        createdAt: new Date(now).toISOString(),
        expires: new Date(now + PAIR_TTL_MS).toISOString(),
      })
      // Forget askers whose window has passed, so the map stays small.
      for (const [k, at] of Object.entries(c.asked))
        if (now - Date.parse(at) >= PAIR_EVERY_MS) delete c.asked[k]
      c.asked[who] = new Date(now).toISOString()
      return code
    })
  }

  /** Approves a waiting request by its code or its id; the first person approved becomes the owner. */
  approve(channel: string, by: { code: string } | { request: string }) {
    return this.update(channel, (c) => {
      const found = c.pending.find((p) => ('code' in by ? p.codeHash === hash(by.code) : p.id === by.request))
      if (!found) return undefined
      c.pending = c.pending.filter((p) => p !== found)
      const at = new Date().toISOString()
      if (found.kind === 'group') {
        const group: ChannelGroup = {
          id: found.chat.id,
          title: found.chat.title ?? found.chat.id,
          approvedAt: at,
        }
        c.groups = [...c.groups.filter((g) => g.id !== group.id), group]
        return { request: found, group }
      }
      const person: ChannelPerson = {
        id: found.sender.id,
        name: found.sender.name,
        ...(found.sender.handle ? { handle: found.sender.handle } : {}),
        role: c.people.some((p) => p.role === 'owner') ? 'member' : 'owner',
        approvedAt: at,
      }
      c.people = [...c.people.filter((p) => p.id !== person.id), person]
      return { request: found, person }
    })
  }

  revoke(channel: string, kind: 'person' | 'group' | 'request', id: string): boolean {
    return this.update(channel, (c) => {
      const before = c.people.length + c.groups.length + c.pending.length
      if (kind === 'person') c.people = c.people.filter((p) => p.id !== id)
      if (kind === 'group') c.groups = c.groups.filter((g) => g.id !== id)
      if (kind === 'request') c.pending = c.pending.filter((p) => p.id !== id)
      return c.people.length + c.groups.length + c.pending.length < before
    })
  }
}

/** How long a message id is remembered for dropping redeliveries (OpenClaw keeps 7 days). */
const SEEN_MS = 7 * 24 * 60 * 60_000

/** `<home>/channels/channels.sqlite`: messages already received, and small values adapters keep (offsets). */
export class ChannelLedger {
  private readonly _db: Database

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this._db = new Database(join(dir, 'channels.sqlite'), { create: true })
    this._db.run('pragma journal_mode = wal')
    this._db.run(
      'create table if not exists seen (channel text not null, chat text not null, message text not null, at integer not null, primary key (channel, chat, message))',
    )
    this._db.run('create table if not exists kv (key text primary key, value text not null)')
    this._db.run('delete from seen where at < ?', [Date.now() - SEEN_MS])
  }

  /** Records a message; false when it was already recorded (a redelivery). */
  first(channel: string, chat: string, message: string): boolean {
    const r = this._db.run('insert or ignore into seen (channel, chat, message, at) values (?, ?, ?, ?)', [
      channel,
      chat,
      message,
      Date.now(),
    ])
    return r.changes > 0
  }

  get(key: string): string | undefined {
    return (this._db.query('select value from kv where key = ?').get(key) as { value: string } | null)?.value
  }

  set(key: string, value: string) {
    this._db.run(
      'insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
      [key, value],
    )
  }

  close() {
    this._db.close()
  }
}
