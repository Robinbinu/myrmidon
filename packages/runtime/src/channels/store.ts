import { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { channelCopy } from './copy.ts'
import type { ChannelChat, ChannelSender } from './types.ts'

/** Someone allowed to talk to the agents through a channel. */
export interface ChannelPerson {
  readonly id: string
  readonly name: string
  readonly handle?: string
  /** The first person approved by code, or whoever Settings makes it; only the owner approves risky steps. */
  readonly role: 'owner' | 'member'
  /**
   * How the owner became it: their own code, or Settings. Absent for an owner from before this was kept, who may have
   * become it just by an allowlist match (Settings asks the person to confirm them).
   */
  readonly by?: 'code' | 'settings'
  readonly approvedAt: string
  /** Their direct chat with the bot, where approvals for rounds they cannot see are sent. */
  readonly dm?: string
}

export interface ChannelGroup {
  readonly id: string
  readonly title: string
  readonly approvedAt: string
}

/** A stranger (or a group) waiting for the owner to approve the code they were sent. */
export interface PairingRequest {
  /** Names the request in Settings, to decline it or to approve it with the code its sender was sent. */
  readonly id: string
  readonly codeHash: string
  readonly kind: 'person' | 'group'
  readonly sender: ChannelSender
  readonly chat: ChannelChat
  readonly createdAt: string
  readonly expires: string
}

/**
 * Who may talk in direct chats (OpenClaw's `dmPolicy`): `pairing` sends strangers a code to approve, `allowlist`
 * ignores anyone not approved or listed, `open` lets anyone in as a member, `disabled` answers no direct chats.
 */
export type DmPolicy = 'pairing' | 'allowlist' | 'open' | 'disabled'
/** Groups: `approve` needs each group approved first, `open` answers any group, `disabled` none. */
export type GroupPolicy = 'approve' | 'open' | 'disabled'
/** What the chat shows while a round works: an updating status line, the reply as it is written, or nothing. */
export type StreamMode = 'progress' | 'partial' | 'final'

export interface ChannelConfig {
  /** The platform's settings by field (tokens, addresses); secret ones never leave the hub. */
  values: Record<string, string>
  enabled: boolean
  /** The project new chats from this channel work in. */
  project?: string
  dm: DmPolicy
  groups: GroupPolicy
  /** In groups, answer only when mentioned or replied to (on by default, as in both projects). */
  mention: boolean
  stream: StreamMode
  /** In groups, one conversation per person instead of one for the whole group (Hermes's default). */
  perPerson: boolean
  /** IDs or @handles let in without pairing. */
  allow: string[]
  people: ChannelPerson[]
  approvedGroups: ChannelGroup[]
  pending: PairingRequest[]
  /** Platform conversation key → the Myrmidon chat it continues. */
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
const defaults = (): ChannelConfig => ({
  values: {},
  enabled: false,
  dm: 'pairing',
  groups: 'approve',
  mention: true,
  stream: 'progress',
  perPerson: false,
  allow: [],
  people: [],
  approvedGroups: [],
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

  /**
   * Every channel's settings. A file that cannot be read throws rather than reading as empty: the next save would
   * otherwise overwrite every token and approved person with nothing.
   */
  private _all(): Record<string, Partial<ChannelConfig> & { token?: string; groups?: unknown }> {
    if (!existsSync(this._file)) return {}
    let all: unknown
    try {
      all = JSON.parse(readFileSync(this._file, 'utf8'))
    } catch (err) {
      throw new Error(channelCopy.unreadable(err instanceof Error ? err.message : String(err)))
    }
    if (!all || typeof all !== 'object' || Array.isArray(all))
      throw new Error(channelCopy.unreadable(channelCopy.notObject))
    return all as Record<string, Partial<ChannelConfig>>
  }

  /** Throws when the settings file cannot be read, as every read and write would. */
  check() {
    this._all()
  }

  /** Whether a channel has been configured at all (so a platform's own defaults apply only the first time). */
  exists(channel: string): boolean {
    return channel in this._all()
  }

  get(channel: string): ChannelConfig {
    const now = Date.now()
    const saved = this._all()[channel] ?? {}
    // Step 1 kept a bare `token` and the approved groups under `groups`.
    const { token, groups, ...rest } = saved
    const config: ChannelConfig = {
      ...defaults(),
      ...rest,
      values: { ...(token ? { token } : {}), ...saved.values },
      ...(Array.isArray(groups) ? { approvedGroups: groups as ChannelGroup[] } : {}),
      ...(typeof groups === 'string' ? { groups: groups as GroupPolicy } : {}),
    }
    config.pending = config.pending.filter((p) => Date.parse(p.expires) > now)
    return config
  }

  /** Changes one channel's settings and saves them atomically. */
  update<T>(channel: string, change: (config: ChannelConfig) => T): T {
    const all = this._all() as Record<string, unknown>
    const config = this.get(channel)
    const result = change(config)
    all[channel] = config
    this._save(all)
    return result
  }

  /** Forgets a channel entirely: its settings, secrets, people, groups, codes and chats. */
  remove(channel: string) {
    const all = this._all()
    if (!(channel in all)) return
    delete all[channel]
    this._save(all)
  }

  private _save(all: Record<string, unknown>) {
    // The version before each save stays beside it, so a bad save or hand edit can be undone.
    if (existsSync(this._file)) {
      copyFileSync(this._file, `${this._file}.bak`)
      chmodSync(`${this._file}.bak`, 0o600)
    }
    const tmp = `${this._file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this._file)
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

  /**
   * Approves a waiting request by the code its sender was sent (with `request`, only that one), so approving proves
   * the code reached whoever approves; the first person approved becomes the owner.
   */
  approve(channel: string, by: { code: string; request?: string }) {
    return this.update(channel, (c) => {
      const found = c.pending.find(
        (p) => p.codeHash === hash(by.code) && (by.request === undefined || p.id === by.request),
      )
      if (!found) return undefined
      c.pending = c.pending.filter((p) => p !== found)
      const at = new Date().toISOString()
      if (found.kind === 'group') {
        const group: ChannelGroup = {
          id: found.chat.id,
          title: found.chat.title ?? found.chat.id,
          approvedAt: at,
        }
        c.approvedGroups = [...c.approvedGroups.filter((g) => g.id !== group.id), group]
        return { request: found, group }
      }
      const person: ChannelPerson = {
        id: found.sender.id,
        name: found.sender.name,
        ...(found.sender.handle ? { handle: found.sender.handle } : {}),
        ...(c.people.some((p) => p.role === 'owner') ? { role: 'member' } : { role: 'owner', by: 'code' }),
        approvedAt: at,
        ...(found.chat.kind === 'dm' ? { dm: found.chat.id } : {}),
      }
      c.people = [...c.people.filter((p) => p.id !== person.id), person]
      return { request: found, person }
    })
  }

  /** Makes an approved person the owner (the one before becomes a member); false when no such person is approved. */
  setOwner(channel: string, personId: string): boolean {
    return this.update(channel, (c) => {
      if (!c.people.some((p) => p.id === personId)) return false
      c.people = c.people.map(({ by: _by, ...p }) =>
        p.id === personId ? { ...p, role: 'owner', by: 'settings' } : { ...p, role: 'member' },
      )
      return true
    })
  }

  /** Remembers a person's direct chat the first time they write there (people let in by a list or `open`). */
  noteDm(channel: string, personId: string, chat: string) {
    const c = this.get(channel)
    const p = c.people.find((x) => x.id === personId)
    if (!p || p.dm === chat) return
    this.update(channel, (cfg) => {
      cfg.people = cfg.people.map((x) => (x.id === personId ? { ...x, dm: chat } : x))
    })
  }

  revoke(channel: string, kind: 'person' | 'group' | 'request', id: string): boolean {
    return this.update(channel, (c) => {
      const before = c.people.length + c.approvedGroups.length + c.pending.length
      if (kind === 'person') c.people = c.people.filter((p) => p.id !== id)
      if (kind === 'group') c.approvedGroups = c.approvedGroups.filter((g) => g.id !== id)
      if (kind === 'request') c.pending = c.pending.filter((p) => p.id !== id)
      return c.people.length + c.approvedGroups.length + c.pending.length < before
    })
  }
}

/** How long a message id is remembered for dropping redeliveries (OpenClaw keeps 7 days). */
const SEEN_MS = 7 * 24 * 60 * 60_000
/** Answers older than this are not redelivered after a restart (Hermes: 24 hours). */
export const OUTBOX_FRESH_MS = 24 * 60 * 60_000
/** Attempts per answer before it is given up (Hermes: 3). */
export const OUTBOX_ATTEMPTS = 3

/**
 * An answer owed to a chat, after Hermes's delivery ledger: `pending` before the send, `attempting` during it,
 * `failed` after a refusal; delivered ones are removed. After a crash an `attempting` one may already have
 * arrived, so it is resent with a visible marker rather than silently twice.
 */
export interface OutboxEntry {
  readonly id: string
  readonly channel: string
  readonly chat: string
  readonly thread?: string
  readonly text: string
  readonly state: 'pending' | 'attempting' | 'failed'
  readonly attempts: number
  readonly created: number
  readonly error?: string
}

/** `<home>/channels/channels.sqlite`: messages already received, answers owed, and small values (offsets). */
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
    this._db.run(
      'create table if not exists outbox (id text primary key, channel text not null, chat text not null, thread text, text text not null, state text not null, attempts integer not null, created integer not null, error text)',
    )
    this._db.run('delete from seen where at < ?', [Date.now() - SEEN_MS])
    this._db.run('delete from outbox where created < ? or attempts >= ?', [
      Date.now() - OUTBOX_FRESH_MS,
      OUTBOX_ATTEMPTS,
    ])
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

  owe(channel: string, chat: string, thread: string | undefined, text: string): string {
    const id = randomBytes(8).toString('hex')
    this._db.run(
      "insert into outbox (id, channel, chat, thread, text, state, attempts, created) values (?, ?, ?, ?, ?, 'pending', 0, ?)",
      [id, channel, chat, thread ?? null, text, Date.now()],
    )
    return id
  }

  attempting(id: string) {
    this._db.run("update outbox set state = 'attempting', attempts = attempts + 1 where id = ?", [id])
  }

  delivered(id: string) {
    this._db.run('delete from outbox where id = ?', [id])
  }

  failed(id: string, error: string) {
    this._db.run("update outbox set state = 'failed', error = ? where id = ?", [error.slice(0, 300), id])
  }

  /** Answers still owed on a channel: fresh, with attempts left. */
  owed(channel: string): OutboxEntry[] {
    return (
      this._db
        .query('select * from outbox where channel = ? and created >= ? and attempts < ? order by created')
        .all(channel, Date.now() - OUTBOX_FRESH_MS, OUTBOX_ATTEMPTS) as (Omit<
        OutboxEntry,
        'thread' | 'error'
      > & {
        thread: string | null
        error: string | null
      })[]
    ).map(({ thread, error, ...row }) => ({
      ...row,
      ...(thread ? { thread } : {}),
      ...(error ? { error } : {}),
    }))
  }

  /** Forgets what a removed channel left here: messages seen, answers owed and its adapter's values. */
  forget(channel: string) {
    this._db.run('delete from seen where channel = ?', [channel])
    this._db.run('delete from outbox where channel = ?', [channel])
    this._db.run("delete from kv where key like ? escape '\\'", [`${channel.replace(/[\\%_]/g, '\\$&')}:%`])
  }

  close() {
    this._db.close()
  }
}
