import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ApprovalRequest,
  type EventPayloads,
  foldColony,
  type MyrEvent,
  type QuestionChoice,
  roundSlice,
} from '@myrmidon/protocol'
import { APPROVAL_MS } from '../config.ts'
import { prompts } from '../prompts.ts'
import { channelCopy as t } from './copy.ts'
import { chunk, duration, money, toolPhrase } from './format.ts'
import {
  type ChannelConfig,
  ChannelLedger,
  type ChannelPerson,
  ChannelStore,
  type PairingRequest,
} from './store.ts'
import type {
  AdapterFactory,
  AdapterStatus,
  ChannelAdapter,
  ChannelChat,
  ChannelField,
  Inbound,
  OutMessage,
  SentRef,
} from './types.ts'

/** What the hub needs of Myrmidon's chats (ChatService, wrapped with the person's default team). */
export interface ChannelChats {
  /** Delivers to the chat's running round, or starts one; a new chat when `chatId` is undefined. */
  send(
    text: string,
    chatId: string | undefined,
    options?: {
      project?: string
      attachments?: readonly { name: string; bytes: Uint8Array }[]
      /** Said aloud on a voice call. */
      voice?: boolean
      /**
       * Written by someone other than the owner: the round asks before every call that changes something, whatever
       * the owner allowed.
       */
      askAll?: boolean
    },
  ): Promise<{ chatId: string; colonyId: string; started: boolean; round?: number }>
  rename(chatId: string, title: string): Promise<unknown>
  stop(chatId: string): Promise<void>
  /** Every event as it is appended to any colony. */
  onEvents(listener: (colonyId: string, events: readonly MyrEvent[]) => void): () => void
  /** Replies as they are written (`text` is the reply so far). */
  onStream?(listener: (colonyId: string, agent: string, text: string, done: boolean) => void): () => void
  read(colonyId: string): Promise<readonly MyrEvent[]>
  decideApproval(colonyId: string, id: string, approved: boolean): Promise<void>
  /** Lets a tool run without asking from now on (the person's per-tool rule in Settings). */
  allowAlways(tool: string): Promise<void>
  /** An artifact's latest version, for sending the files a round made. */
  artifact(colonyId: string, name: string): Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** Speech to text for voice notes; absent when nothing can do it. */
  transcribe?(audio: Uint8Array, mimeType: string, name: string): Promise<string>
}

/** A platform the hub can run: its name, the settings it needs, and how to make its adapter from them. */
export interface ChannelKind {
  readonly label: string
  readonly fields: readonly ChannelField[]
  readonly make: AdapterFactory
  /** A line for Settings on how to get the settings (create a bot, link a device…). */
  readonly setup?: string
  /**
   * Access rules this platform starts with, where the general defaults would not suit it: email and SMS answer only
   * listed people (a pairing code by email or paid text helps no one), group-only platforms answer in any group.
   */
  readonly defaults?: Partial<Pick<ChannelConfig, 'dm' | 'groups' | 'mention'>>
}

/** One channel as Settings shows it; secret values never leave the hub. */
export interface ChannelInfo {
  readonly id: string
  readonly label: string
  readonly setup?: string
  readonly fields: readonly ChannelField[]
  /** The non-secret values, and which secret ones are set. */
  readonly values: Readonly<Record<string, string>>
  readonly secretsSet: readonly string[]
  readonly configured: boolean
  readonly enabled: boolean
  readonly project?: string
  readonly dm: ChannelConfig['dm']
  readonly groups: ChannelConfig['groups']
  readonly mention: boolean
  readonly stream: ChannelConfig['stream']
  readonly perPerson: boolean
  readonly allow: readonly string[]
  readonly status: AdapterStatus | { readonly state: 'off' }
  readonly health: ChannelHealth
  readonly people: readonly ChannelPerson[]
  readonly approvedGroups: readonly { id: string; title: string; approvedAt: string }[]
  readonly pending: readonly Omit<PairingRequest, 'codeHash'>[]
}

/** How a channel has been doing since this gateway started (OpenClaw's per-account health). */
export interface ChannelHealth {
  readonly connectedAt?: string
  /** Times it went from connected to reconnecting. */
  readonly reconnects: number
  readonly lastError?: string
  readonly lastIn?: string
  readonly lastOut?: string
  /** Answers still owed (failed to send and waiting for a retry). */
  readonly owed: number
}

/** Something that happened on a channel, for its Activity tab and the System page. Names only, never message text. */
export interface ChannelEvent {
  readonly at: string
  readonly channel: string
  readonly kind: 'connected' | 'trouble' | 'in' | 'out' | 'failed' | 'pairing' | 'approved' | 'approval'
  readonly text: string
}

export type ChannelPatch = Partial<
  Pick<ChannelConfig, 'enabled' | 'dm' | 'groups' | 'mention' | 'stream' | 'perPerson' | 'allow'>
> & { values?: Record<string, string>; project?: string | null }

/** Events kept per channel for its Activity tab. */
const ACTIVITY_KEEP = 100
/** Typing lasts about 5 s on Telegram; renewing it a little sooner keeps it steady. */
const TYPING_MS = 4000
/** More messages than this from one chat in a minute are dropped (a loop, or someone flooding). */
const FLOOD_PER_MINUTE = 20
/** Retries of an answer that failed to send, after these waits (Hermes: 30 s, then 120 s). */
const RETRY_MS = [30_000, 120_000]
/** Files a finished round sends at most; more are listed by name. */
const MAX_FILES = 5
/** Files coming in larger than this are refused (Myrmidon's attachment limit). */
const MAX_IN_BYTES = 10 * 1024 * 1024
const DEFAULT_FILE_LIMIT = 20 * 1024 * 1024
/** The longest review preview an approval message shows. */
const PREVIEW_CHARS = 1200

/** A round started from a channel, followed until it ends. */
interface Tracker {
  readonly channel: string
  readonly adapter: ChannelAdapter
  readonly to: ChannelChat
  readonly chatId: string
  readonly colonyId: string
  readonly started: number
  readonly stream: ChannelConfig['stream']
  /** The member (not the owner) whose message started or steered the round: it asks for every step. */
  member?: string
  ref?: SentRef
  shown?: string
  readonly agents: Map<string, string>
  readonly approvals: Set<string>
  question: boolean
  /** The round handed its request to a bigger one: the next round continues this status line. */
  escalating: boolean
  lastEdit: number
  flush?: ReturnType<typeof setTimeout>
  typing?: ReturnType<typeof setInterval>
  /** `partial` streaming: the reply so far and the message it is written into. */
  draft?: { text: string; ref?: SentRef; shown?: string }
  done: boolean
}

/** An approval sent to a chat, by its short key (button data has little room). */
interface OpenApproval {
  readonly channel: string
  readonly colonyId: string
  readonly id: string
  readonly tool: string
  readonly text: string
  readonly messages: { adapter: ChannelAdapter; ref: SentRef; to: ChannelChat }[]
  /** Asked for in a member's round: "always" is not offered (it would widen the owner's own rules). */
  readonly member: boolean
}

/** Questions with options sent to a chat, answered one press at a time, then sent together. */
interface OpenQuestions {
  readonly channel: string
  readonly chatId: string
  readonly choices: readonly QuestionChoice[]
  readonly answers: (string | undefined)[]
  readonly messages: (SentRef | undefined)[]
  readonly adapter: ChannelAdapter
  readonly to: ChannelChat
}

const key = () => randomBytes(4).toString('base64url').slice(0, 6)

/**
 * Everything channels share, ported from Hermes's gateway and OpenClaw's channel core: who may talk (pairing codes,
 * allowlists, an owner, groups by approval and mention), which Myrmidon chat a conversation continues, commands,
 * progress (a status line, a streamed reply, or nothing), approvals and questions with buttons, files and voice
 * notes, the answer split to the platform's limit and delivered through a ledger that survives restarts, and
 * dropping redeliveries. Platforms only receive and send (`ChannelAdapter`).
 */
export class ChannelHub {
  readonly store: ChannelStore
  private readonly _ledger: ChannelLedger
  private readonly _running = new Map<string, ChannelAdapter>()
  private readonly _status = new Map<string, AdapterStatus>()
  private readonly _lanes = new Map<string, Promise<void>>()
  private readonly _trackers = new Map<string, Tracker>()
  private readonly _recent = new Map<string, number[]>()
  /** Chats told to slow down in their current burst, so a flood hears it once. */
  private readonly _slowed = new Set<string>()
  private readonly _approvals = new Map<string, OpenApproval>()
  private readonly _questions = new Map<string, OpenQuestions>()
  private readonly _retries = new Set<ReturnType<typeof setTimeout>>()
  private readonly _health = new Map<string, Omit<ChannelHealth, 'owed'>>()
  private readonly _activity = new Map<string, ChannelEvent[]>()
  private _offEvents?: () => void
  private _offStream?: () => void

  constructor(
    private readonly options: {
      readonly dir: string
      readonly chats: ChannelChats
      /** The platforms available now: built in, and any a plugin registers. */
      readonly kinds: () => Readonly<Record<string, ChannelKind>>
      /** Where webhooks for a channel arrive, when this gateway has a public address. */
      readonly webhookUrl?: (channel: string) => string | undefined
      readonly log?: (message: string) => void
    },
  ) {
    this.store = new ChannelStore(options.dir)
    this._ledger = new ChannelLedger(options.dir)
  }

  /** Starts every channel that is switched on and set up. */
  async start() {
    // A damaged settings file is said once, not once for every platform.
    try {
      this.store.check()
    } catch (err) {
      return this.options.log?.(err instanceof Error ? err.message : String(err))
    }
    for (const id of Object.keys(this.options.kinds()))
      await this._restart(id).catch((err) => this._log(id, err))
  }

  /** Brings running channels in line with the platforms available (a plugin added or removed one). */
  async refresh() {
    const kinds = this.options.kinds()
    for (const id of [...this._running.keys()]) if (!kinds[id]) await this._restart(id).catch(() => {})
    for (const id of Object.keys(kinds)) if (!this._running.has(id)) await this._restart(id).catch(() => {})
  }

  async stop() {
    this._offEvents?.()
    this._offStream?.()
    this._offEvents = undefined
    this._offStream = undefined
    for (const tracker of this._trackers.values()) this._release(tracker)
    this._trackers.clear()
    for (const timer of this._retries) clearTimeout(timer)
    for (const adapter of this._running.values()) await adapter.stop().catch(() => {})
    this._running.clear()
    this._ledger.close()
  }

  list(): ChannelInfo[] {
    return Object.entries(this.options.kinds()).map(([id, kind]) => {
      const c = this.store.get(id)
      const secret = new Set(kind.fields.filter((f) => f.secret).map((f) => f.key))
      return {
        id,
        label: kind.label,
        ...(kind.setup ? { setup: kind.setup } : {}),
        fields: kind.fields,
        values: Object.fromEntries(Object.entries(c.values).filter(([k]) => !secret.has(k))),
        secretsSet: Object.keys(c.values).filter((k) => secret.has(k) && c.values[k]),
        configured: this._configured(kind, c),
        enabled: c.enabled,
        ...(c.project ? { project: c.project } : {}),
        dm: c.dm,
        groups: c.groups,
        mention: c.mention,
        stream: c.stream,
        perPerson: c.perPerson,
        allow: c.allow,
        status: this._running.has(id) ? (this._status.get(id) ?? { state: 'connecting' }) : { state: 'off' },
        health: { reconnects: 0, ...this._health.get(id), owed: this._ledger.owed(id).length },
        people: c.people,
        approvedGroups: c.approvedGroups,
        pending: c.pending.map(({ codeHash: _hash, ...rest }) => rest),
      }
    })
  }

  private _configured(kind: ChannelKind, c: ChannelConfig) {
    return kind.fields.every((f) => f.optional || Boolean(c.values[f.key]))
  }

  /**
   * Saves a channel's settings (new values are checked with the platform first), access rules and project; then
   * restarts it.
   */
  async configure(id: string, patch: ChannelPatch) {
    const kind = this._kind(id)
    // The first time a channel is configured it starts from its platform's own rules.
    if (kind.defaults && !this.store.exists(id))
      this.store.update(id, (c) => {
        Object.assign(c, kind.defaults)
      })
    if (patch.values) {
      const values = { ...this.store.get(id).values }
      for (const [k, v] of Object.entries(patch.values)) {
        if (!kind.fields.some((f) => f.key === k)) throw new Error(`${kind.label} has no setting ${k}`)
        if (v.trim()) values[k] = v.trim()
        else delete values[k]
      }
      const filled = kind.fields.every((f) => f.optional || Boolean(values[f.key]))
      // Settings are only kept once the platform accepts them.
      if (filled) await kind.make(values).check()
      this.store.update(id, (c) => {
        c.values = values
        if (filled && patch.enabled === undefined) c.enabled = true
      })
    }
    this.store.update(id, (c) => {
      if (patch.enabled !== undefined) c.enabled = patch.enabled
      if (patch.dm !== undefined) c.dm = patch.dm
      if (patch.groups !== undefined) c.groups = patch.groups
      if (patch.mention !== undefined) c.mention = patch.mention
      if (patch.stream !== undefined) c.stream = patch.stream
      if (patch.perPerson !== undefined) c.perPerson = patch.perPerson
      if (patch.allow) c.allow = patch.allow.map((a) => a.trim()).filter(Boolean)
      if (patch.project === null) delete c.project
      else if (patch.project !== undefined) c.project = patch.project
    })
    await this._restart(id)
    return this.list().find((c) => c.id === id)
  }

  /** Approves a waiting request by its code (typed in Settings or the CLI) and tells whoever asked. */
  async approve(id: string, by: { code: string; request?: string }) {
    this._kind(id)
    const approved = this.store.approve(id, by)
    if (!approved) return undefined
    this._note(id, 'approved', t.activity.approved(approved.group?.title ?? approved.person?.name ?? ''))
    const adapter = this._running.get(id)
    const text = approved.group
      ? t.pairing.groupApproved
      : t.pairing.approved(approved.person?.role === 'owner', adapter?.commandPrefix ?? '/')
    await adapter?.send(approved.request.chat, { text }).catch(() => {})
    return approved
  }

  /**
   * Removes a channel: stops it and forgets everything it kept (settings and token, people, codes, which chats it
   * continues, answers owed, its adapter's files such as a linked device's keys). Chats it started stay in Myrmidon.
   */
  async remove(id: string) {
    this._kind(id)
    const running = this._running.get(id)
    this._running.delete(id)
    await running?.stop().catch(() => {})
    for (const tracker of [...this._trackers.values()])
      if (tracker.channel === id) {
        this._release(tracker)
        this._trackers.delete(tracker.colonyId)
      }
    for (const [k, a] of this._approvals) if (a.channel === id) this._approvals.delete(k)
    for (const [k, q] of this._questions) if (q.channel === id) this._questions.delete(k)
    this._status.delete(id)
    this._health.delete(id)
    this._activity.delete(id)
    this.store.remove(id)
    this._ledger.forget(id)
    rmSync(join(this.options.dir, id), { recursive: true, force: true })
  }

  /** Makes an approved person the channel's owner, from Settings. */
  setOwner(id: string, person: string): boolean {
    this._kind(id)
    return this.store.setOwner(id, person)
  }

  revoke(id: string, kind: 'person' | 'group' | 'request', target: string): boolean {
    this._kind(id)
    return this.store.revoke(id, kind, target)
  }

  /** A channel's recent events, newest first; every channel's, interleaved, without an id. */
  activity(id?: string): ChannelEvent[] {
    const all = id ? (this._activity.get(id) ?? []) : [...this._activity.values()].flat()
    return [...all].sort((a, b) => b.at.localeCompare(a.at))
  }

  /** Which channel each Myrmidon chat came from, so the app can show its logo. */
  chatChannels(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const id of Object.keys(this.options.kinds()))
      for (const chatId of Object.values(this.store.get(id).chats)) out[chatId] = id
    return out
  }

  private _note(channel: string, kind: ChannelEvent['kind'], text: string) {
    const list = this._activity.get(channel) ?? []
    list.push({ at: new Date().toISOString(), channel, kind, text })
    if (list.length > ACTIVITY_KEEP) list.splice(0, list.length - ACTIVITY_KEEP)
    this._activity.set(channel, list)
  }

  private _touch(channel: string, patch: Partial<Omit<ChannelHealth, 'owed'>>) {
    this._health.set(channel, { reconnects: 0, ...this._health.get(channel), ...patch })
  }

  /**
   * Sends the owner a message on a channel (the first running one with an owner when none is named): the agents'
   * `channels_send` tool, and anything else that needs to reach the person.
   */
  async notify(text: string, channel?: string): Promise<string> {
    for (const [id, adapter] of this._running) {
      if (channel && id !== channel) continue
      const owner = this.store.get(id).people.find((p) => p.role === 'owner' && p.dm)
      if (!owner?.dm) continue
      await this._deliver(id, adapter, { id: owner.dm, kind: 'dm' }, text)
      return `${this._kind(id).label} · ${owner.name}`
    }
    throw new Error(t.notify.noOwner)
  }

  /** Follows a round started elsewhere (a schedule) in the owner's chat: its status line and its answer. */
  async follow(channel: string, chatId: string, colonyId: string) {
    const adapter = this._running.get(channel)
    const owner = this.store.get(channel).people.find((p) => p.role === 'owner' && p.dm)
    if (!adapter || !owner?.dm) throw new Error(t.notify.noOwner)
    await this._track(channel, adapter, { id: owner.dm, kind: 'dm' }, chatId, colonyId)
  }

  /** A webhook for a channel, passed to its adapter (which checks the platform's signature). */
  async webhook(id: string, req: Request): Promise<Response> {
    const adapter = this._running.get(id)
    if (!adapter?.webhook) return new Response('not found', { status: 404 })
    return adapter.webhook(req)
  }

  private _kind(id: string): ChannelKind {
    const kind = this.options.kinds()[id]
    if (!kind) throw new Error(`no channel called ${id}`)
    return kind
  }

  private async _restart(id: string) {
    const running = this._running.get(id)
    if (running) {
      this._running.delete(id)
      await running.stop().catch(() => {})
    }
    this._status.delete(id)
    const kind = this.options.kinds()[id]
    if (!kind) return
    const c = this.store.get(id)
    if (!c.enabled || !this._configured(kind, c)) return
    // Rounds are followed from the first channel that runs, whether started at launch or from Settings.
    this._offEvents ??= this.options.chats.onEvents((colonyId, events) => this._onEvents(colonyId, events))
    this._offStream ??= this.options.chats.onStream?.((colonyId, _agent, text, done) =>
      this._onStream(colonyId, text, done),
    )
    const adapter = kind.make(c.values)
    this._running.set(id, adapter)
    const webhookUrl = this.options.webhookUrl?.(id)
    const dir = join(this.options.dir, id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    await adapter.start({
      dir,
      receive: (message) => this._receive(id, adapter, message),
      get: (k) => this._ledger.get(`${id}:${k}`),
      set: (k, value) => this._ledger.set(`${id}:${k}`, value),
      status: (status) => {
        const was = this._status.get(id)?.state
        this._status.set(id, status)
        if (status.state === 'on' && was !== 'on') {
          this._touch(id, { connectedAt: new Date().toISOString() })
          this._note(id, 'connected', t.activity.connected(status.account))
          // Back online: answers owed from before (a restart, an outage) go out now.
          void this._redeliver(id, adapter)
        }
        if ((status.state === 'retrying' || status.state === 'error') && was !== status.state) {
          const reconnects = (this._health.get(id)?.reconnects ?? 0) + (was === 'on' ? 1 : 0)
          this._touch(id, { lastError: status.error, reconnects })
          this._note(id, 'trouble', status.error)
        }
      },
      log: (message) => this.options.log?.(`${id}: ${message}`),
      ...(webhookUrl ? { webhookUrl } : {}),
    })
  }

  /** Records the message (dropping a redelivery), then handles it in its conversation's lane, in order. */
  private async _receive(channel: string, adapter: ChannelAdapter, message: Inbound) {
    if (!this._ledger.first(channel, message.chat.id, message.messageId)) return
    const lane = `${channel}:${message.chat.id}`
    const next = (this._lanes.get(lane) ?? Promise.resolve())
      .then(() => this._handle(channel, adapter, message))
      .catch((err) => this._log(channel, err))
    this._lanes.set(lane, next)
    void next.finally(() => {
      if (this._lanes.get(lane) === next) this._lanes.delete(lane)
    })
  }

  private _log(channel: string, err: unknown) {
    this.options.log?.(`${channel}: ${err instanceof Error ? err.message : String(err)}`)
  }

  /**
   * Something failed on a sender's behalf: why goes to the log and the channel's Activity tab, for the owner; the
   * sender is told only that it failed, since the reason can name this machine's paths, keys or setup.
   */
  private _failed(channel: string, err: unknown) {
    this._log(channel, err)
    this._note(channel, 'trouble', t.activity.refused(err instanceof Error ? err.message : String(err)))
  }

  private _flooded(channel: string, chat: string): boolean {
    const k = `${channel}:${chat}`
    const now = Date.now()
    const recent = (this._recent.get(k) ?? []).filter((at) => now - at < 60_000)
    recent.push(now)
    this._recent.set(k, recent)
    return recent.length > FLOOD_PER_MINUTE
  }

  /** The conversation a message belongs to: the chat, its thread, and the person when groups are per person. */
  private _conversation(c: ChannelConfig, m: Inbound) {
    return [m.chat.id, m.chat.thread, c.perPerson && m.chat.kind === 'group' ? m.sender.id : undefined]
      .filter(Boolean)
      .join(':')
  }

  /** Whether a sender is on the typed allowlist, by id or @handle (adapters give a handle only where it is vouched for). */
  private _listed(c: ChannelConfig, m: Inbound) {
    const handle = m.sender.handle?.toLowerCase()
    return c.allow.some((a) => a === m.sender.id || (handle && a.replace(/^@/, '').toLowerCase() === handle))
  }

  /**
   * Who this sender is to the channel, or undefined to stay silent. Strangers in a direct chat under `pairing` get a
   * code; listed people are added as members (only a code approved in Settings, or Settings itself, makes an owner);
   * `open` lets anyone in as a member without keeping them.
   */
  private async _admit(
    channel: string,
    adapter: ChannelAdapter,
    c: ChannelConfig,
    m: Inbound,
  ): Promise<ChannelPerson | undefined> {
    const known = c.people.find((p) => p.id === m.sender.id)
    if (m.chat.kind === 'group') {
      if (c.groups === 'disabled') return undefined
      if (c.mention && !m.mentioned && !m.press) return undefined
      const approvedGroup = c.approvedGroups.some((g) => g.id === m.chat.id)
      if (!approvedGroup && c.groups === 'approve') {
        // Only someone already approved can ask for a group; strangers in it are ignored.
        const code = known && m.mentioned && this.store.request(channel, 'group', m.sender, m.chat)
        if (code) await adapter.send(m.chat, { text: t.pairing.group(code, channel) })
        return undefined
      }
    } else if (c.dm === 'disabled') return undefined
    if (known) {
      if (m.chat.kind === 'dm') this.store.noteDm(channel, known.id, m.chat.id)
      return known
    }
    if (this._listed(c, m)) {
      const person: ChannelPerson = {
        id: m.sender.id,
        name: m.sender.name,
        ...(m.sender.handle ? { handle: m.sender.handle } : {}),
        role: 'member',
        approvedAt: new Date().toISOString(),
        ...(m.chat.kind === 'dm' ? { dm: m.chat.id } : {}),
      }
      this.store.update(channel, (cfg) => {
        cfg.people = [...cfg.people.filter((p) => p.id !== person.id), person]
      })
      return person
    }
    if (c.dm === 'open') return { id: m.sender.id, name: m.sender.name, role: 'member', approvedAt: '' }
    // Not acted on, not kept: in a direct chat under `pairing`, a code at most once per window.
    if (m.chat.kind === 'dm' && c.dm === 'pairing') {
      const code = this.store.request(channel, 'person', m.sender, m.chat)
      if (code) {
        await adapter.send(m.chat, { text: t.pairing.code(code, channel) })
        this._note(channel, 'pairing', t.activity.pairing(m.sender.name))
      }
    }
    return undefined
  }

  private async _handle(channel: string, adapter: ChannelAdapter, m: Inbound) {
    const c = this.store.get(channel)
    const person = await this._admit(channel, adapter, c, m)
    if (!person) return
    this._touch(channel, { lastIn: new Date().toISOString() })
    if (!m.press)
      this._note(
        channel,
        'in',
        t.activity.in(person.name, m.chat.kind === 'group' ? m.chat.title : undefined),
      )
    if (m.press) return this._press(channel, adapter, person, m)
    const reply = (text: string) => adapter.send(m.chat, { text })
    const lane = `${channel}:${m.chat.id}`
    if (this._flooded(channel, m.chat.id)) {
      if (this._slowed.has(lane)) return
      this._slowed.add(lane)
      return void (await reply(t.slowDown))
    }
    this._slowed.delete(lane)
    let text = m.text.trim()
    const attachments: { name: string; bytes: Uint8Array }[] = []
    for (const file of m.files ?? []) {
      if (file.size && file.size > MAX_IN_BYTES) {
        await reply(t.fileTooBig(file.name))
        continue
      }
      if (file.kind === 'voice' || file.kind === 'audio') {
        const heard = await this._transcribe(channel, file.mimeType, file.name, () => file.read(), reply)
        if (heard) text = text ? `${text}\n\n${heard}` : heard
        continue
      }
      const data = await file.read()
      if (data.byteLength > MAX_IN_BYTES) await reply(t.fileTooBig(file.name))
      else attachments.push({ name: file.name, bytes: data })
    }
    if (!text && !attachments.length) {
      if (m.unsupported) await reply(t.unsupported)
      return
    }
    const command = /^\/([a-z_]+)(?:\s+([\s\S]*))?$/i.exec(text)
    if (command && !attachments.length)
      return this._command(
        channel,
        adapter,
        m,
        person,
        (command[1] ?? '').toLowerCase(),
        command[2]?.trim() ?? '',
      )
    // A typed number answers a numbered list of options (platforms without buttons).
    const chatId = c.chats[this._conversation(c, m)]
    const open = [...this._questions.entries()].find(([, q]) => q.channel === channel && q.chatId === chatId)
    if (open && /^\d+$/.test(text)) {
      const [qKey, q] = open
      const qi = q.answers.findIndex((a) => a === undefined)
      const option = q.choices[qi]?.options[Number(text) - 1]
      if (option) return this._answerQuestion(qKey, qi, option.label)
    }
    await this._forward(channel, adapter, m, person, c, text, attachments)
  }

  /** A voice note as text, echoed back so the person sees what was heard (Hermes's `stt_echo_transcripts`). */
  private async _transcribe(
    channel: string,
    mimeType: string,
    name: string,
    read: () => Promise<Uint8Array>,
    reply: (text: string) => Promise<unknown>,
  ): Promise<string | undefined> {
    if (!this.options.chats.transcribe) {
      await reply(t.voice.cannot)
      return undefined
    }
    try {
      const heard = (await this.options.chats.transcribe(await read(), mimeType, name)).trim()
      if (heard) await reply(t.voice.heard(heard))
      return heard || undefined
    } catch (err) {
      this._failed(channel, err)
      await reply(t.voice.failed)
      return undefined
    }
  }

  private async _command(
    channel: string,
    adapter: ChannelAdapter,
    m: Inbound,
    person: ChannelPerson,
    name: string,
    arg: string,
  ) {
    const reply = (text: string) => adapter.send(m.chat, { text })
    const c = this.store.get(channel)
    const conversation = this._conversation(c, m)
    const chatId = c.chats[conversation]
    const tracker = [...this._trackers.values()].find((x) => x.chatId === chatId)
    const p = adapter.commandPrefix ?? '/'
    if (name === 'start' || name === 'help') return void (await reply(t.commands.help(p)))
    if (name === 'new') {
      this.store.update(channel, (cfg) => {
        delete cfg.chats[conversation]
      })
      return void (await reply(t.commands.fresh))
    }
    if (name === 'stop') {
      if (!chatId || !tracker) return void (await reply(t.commands.nothingRunning))
      await this.options.chats.stop(chatId)
      return void (await reply(t.commands.stopped))
    }
    if (name === 'status')
      return void (await reply(tracker ? this._statusText(tracker) : t.commands.nothingRunning))
    // Typed approvals, for platforms without buttons (and as a fallback anywhere): /approve KEY [always], /deny KEY.
    if (name === 'approve' || name === 'deny') {
      const [k, always] = arg.split(/\s+/)
      const decision = name === 'deny' ? 'd' : always === 'always' ? 'a' : 'o'
      return this._decide(channel, person, k ?? '', decision, (note) => reply(note))
    }
    await reply(t.commands.unknown(name, p))
  }

  private async _press(channel: string, adapter: ChannelAdapter, person: ChannelPerson, m: Inbound) {
    const press = m.press
    if (!press) return
    const ack = async (note?: string) => {
      await adapter.answerPress?.(press, note).catch(() => {})
    }
    const [kind, a, b, c] = press.data.split(':')
    if (kind === 'a' && a && b) return this._decide(channel, person, b, a as 'o' | 'a' | 'd', ack)
    if (kind === 'q' && a && b !== undefined && c !== undefined) {
      const q = this._questions.get(a)
      const choice = q?.choices[Number(b)]
      if (!q || !choice) return ack(t.approval.closed)
      const label = c === 's' ? t.question.skipped : choice.options[Number(c)]?.label
      if (!label) return ack()
      await ack(t.question.pressNoted)
      return this._answerQuestion(a, Number(b), label)
    }
    await ack()
  }

  /** The owner's decision on an approval, by button or typed command; anyone else is refused. */
  private async _decide(
    channel: string,
    person: ChannelPerson,
    k: string,
    decision: 'o' | 'a' | 'd',
    note: (text: string) => Promise<unknown>,
  ) {
    const open = this._approvals.get(k)
    if (!open || open.channel !== channel) return void (await note(t.approval.closed))
    if (person.role !== 'owner') return void (await note(t.approval.onlyOwner))
    this._approvals.delete(k)
    const approved = decision !== 'd'
    const always = decision === 'a' && !open.member
    try {
      if (always) await this.options.chats.allowAlways(open.tool)
      await this.options.chats.decideApproval(open.colonyId, open.id, approved)
    } catch {
      return void (await note(t.approval.gone))
    }
    const outcome = always
      ? t.approval.allowedAlways(person.name, open.tool)
      : approved
        ? t.approval.allowed(person.name)
        : t.approval.denied(person.name)
    for (const msg of open.messages)
      await this._settle(msg.adapter, msg.ref, msg.to, `${open.text}\n\n${outcome}`, outcome)
    await note(approved ? t.approval.pressAllowed : t.approval.pressDenied)
  }

  private async _answerQuestion(k: string, index: number, label: string) {
    const q = this._questions.get(k)
    if (!q || q.answers[index] !== undefined) return
    q.answers[index] = label
    const ref = q.messages[index]
    const choice = q.choices[index]
    if (ref && choice && q.adapter.can.edit)
      await q.adapter.edit(ref, { text: `${choice.question}\n${t.question.answered(label)}` }).catch(() => {})
    if (q.answers.some((a) => a === undefined)) return
    this._questions.delete(k)
    const text = q.choices
      .map((c, i) => t.question.answer(c.question, q.answers[i] ?? t.question.skipped))
      .join('\n')
    await this.options.chats.send(text, q.chatId).catch((err) => this._log(q.channel, err))
  }

  private async _forward(
    channel: string,
    adapter: ChannelAdapter,
    m: Inbound,
    person: ChannelPerson,
    c: ChannelConfig,
    text: string,
    attachments: { name: string; bytes: Uint8Array }[],
  ) {
    const label = this._kind(channel).label
    const conversation = this._conversation(c, m)
    const existing = c.chats[conversation]
    const member = person.role !== 'owner'
    const body = member ? prompts.channels.member(m.sender.name, label, text) : text
    let sent: Awaited<ReturnType<ChannelChats['send']>>
    try {
      sent = await this.options.chats.send(body, existing, {
        ...(c.project ? { project: c.project } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(member ? { askAll: true } : {}),
      })
    } catch (err) {
      this._failed(channel, err)
      await adapter.send(m.chat, { text: t.failed })
      return
    }
    if (sent.chatId !== existing) {
      this.store.update(channel, (cfg) => {
        cfg.chats[conversation] = sent.chatId
      })
      const who = m.chat.kind === 'group' ? (m.chat.title ?? m.sender.name) : m.sender.name
      await this.options.chats.rename(sent.chatId, t.title(label, who)).catch(() => {})
    }
    if (sent.started)
      await this._track(
        channel,
        adapter,
        m.chat,
        sent.chatId,
        sent.colonyId,
        member ? m.sender.name : undefined,
      )
    else {
      const tracker = this._trackers.get(sent.colonyId)
      if (tracker && member) tracker.member ??= m.sender.name
      await adapter.typing(m.chat).catch(() => {})
    }
  }

  private async _track(
    channel: string,
    adapter: ChannelAdapter,
    to: ChannelChat,
    chatId: string,
    colonyId: string,
    member?: string,
  ) {
    if (this._trackers.has(colonyId)) return
    const tracker: Tracker = {
      channel,
      adapter,
      to,
      chatId,
      colonyId,
      started: Date.now(),
      stream: adapter.can.edit ? this.store.get(channel).stream : 'final',
      ...(member ? { member } : {}),
      agents: new Map(),
      approvals: new Set(),
      question: false,
      escalating: false,
      lastEdit: 0,
      done: false,
    }
    this._trackers.set(colonyId, tracker)
    tracker.typing = setInterval(() => {
      if (!tracker.question && !tracker.approvals.size) void adapter.typing(to).catch(() => {})
    }, TYPING_MS)
    void adapter.typing(to).catch(() => {})
    if (tracker.stream === 'progress') {
      tracker.shown = t.status.working
      tracker.ref = await adapter.send(to, { text: tracker.shown }).catch(() => undefined)
      tracker.lastEdit = Date.now()
    }
    // A quick round may already have ended while the status line was being sent.
    const events = await this.options.chats.read(colonyId)
    const state = foldColony(colonyId, events)
    if (state.rounds.at(-1)?.endSeq !== undefined) return this._finish(tracker)
    // Agents already at work before this round was followed.
    for (const [name, agent] of Object.entries(state.agents))
      if (agent.status === 'working' && !tracker.agents.has(name)) tracker.agents.set(name, t.doing.thinking)
    this._schedule(tracker)
  }

  private _onEvents(colonyId: string, events: readonly MyrEvent[]) {
    for (const e of events) {
      // An approval decided anywhere (the app, a timeout) closes its message in every chat.
      if (e.type === 'approval/decided') this._closeApproval(e.payload as EventPayloads['approval/decided'])
    }
    const tracker = this._trackers.get(colonyId)
    if (!tracker || tracker.done) return
    let ended = false
    for (const e of events) {
      switch (e.type) {
        case 'agent/status': {
          const p = e.payload as EventPayloads['agent/status']
          if (p.status === 'working')
            tracker.agents.set(p.agent, tracker.agents.get(p.agent) ?? t.doing.thinking)
          else tracker.agents.delete(p.agent)
          break
        }
        case 'tool/call': {
          const p = e.payload as EventPayloads['tool/call']
          tracker.agents.set(p.agent, toolPhrase(p.tool, p.args))
          break
        }
        case 'chat/reply': {
          const p = e.payload as EventPayloads['chat/reply']
          // The final answer is sent once the round ends; questions and updates go out as they come.
          if (p.final) break
          if (p.question) tracker.question = true
          void this._reply(tracker, p.text, p.choices)
          break
        }
        case 'chat/user':
          tracker.question = false
          break
        case 'approval/requested': {
          const p = e.payload as EventPayloads['approval/requested']
          tracker.approvals.add(p.id)
          void this._askApproval(tracker, p).catch((err) => this._log(tracker.channel, err))
          break
        }
        case 'approval/decided':
          tracker.approvals.delete((e.payload as EventPayloads['approval/decided']).id)
          break
        case 'colony/escalated':
          tracker.escalating = true
          break
        case 'round/started':
          tracker.escalating = false
          break
        case 'colony/stopped':
          if (!tracker.escalating) ended = true
          break
        case 'colony/completed':
        case 'colony/failed':
          ended = true
          break
      }
    }
    if (ended) void this._finish(tracker).catch((err) => this._log(tracker.channel, err))
    else this._schedule(tracker)
  }

  /** `partial` mode: the speaking agent's reply written into one message as it grows. */
  private _onStream(colonyId: string, text: string, done: boolean) {
    const tracker = this._trackers.get(colonyId)
    if (!tracker || tracker.done || tracker.stream !== 'partial' || done) return
    tracker.draft = { ...tracker.draft, text }
    this._schedule(tracker)
  }

  /** An agent's message mid-round, with its question's options as buttons (or a numbered list). */
  private async _reply(tracker: Tracker, text: string, choices?: readonly QuestionChoice[]) {
    if (text.trim()) await this._deliver(tracker.channel, tracker.adapter, tracker.to, text)
    if (!choices?.length) return
    const k = key()
    const q: OpenQuestions = {
      channel: tracker.channel,
      chatId: tracker.chatId,
      choices,
      answers: choices.map(() => undefined),
      messages: [],
      adapter: tracker.adapter,
      to: tracker.to,
    }
    this._questions.set(k, q)
    for (const [qi, choice] of choices.entries()) {
      if (tracker.adapter.can.buttons) {
        const rows = [
          ...choice.options.map((o, oi) => [{ label: o.label, data: `q:${k}:${qi}:${oi}` }]),
          [{ label: t.question.skip, data: `q:${k}:${qi}:s` }],
        ]
        q.messages[qi] = await tracker.adapter
          .send(tracker.to, { text: choice.question, buttons: rows })
          .catch(() => undefined)
      } else {
        const list = choice.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')
        q.messages[qi] = await tracker.adapter
          .send(tracker.to, { text: `${choice.question}\n${list}\n\n${t.question.typed}` })
          .catch(() => undefined)
      }
    }
  }

  /**
   * An approval sent where the owner sees it: this chat when it is the owner's own, otherwise the owner's direct
   * chat (with a note here). Buttons where the platform has them; typed commands everywhere.
   */
  private async _askApproval(tracker: Tracker, request: ApprovalRequest) {
    const c = this.store.get(tracker.channel)
    const owner = c.people.find((p) => p.role === 'owner')
    const preview = request.review?.fields.find((f) => f.value)?.value
    const k = key()
    const member = tracker.member
    const text = [
      t.approval.ask(request.agent, request.summary),
      ...(member ? [t.approval.member(member)] : []),
      ...(preview
        ? [`\`\`\`\n${preview.slice(0, PREVIEW_CHARS)}${preview.length > PREVIEW_CHARS ? '\n…' : ''}\n\`\`\``]
        : []),
      t.approval.expires(Math.round(APPROVAL_MS / 60_000)),
    ].join('\n\n')
    const p = tracker.adapter.commandPrefix ?? '/'
    const message: OutMessage = tracker.adapter.can.buttons
      ? {
          text,
          buttons: [
            [{ label: t.approval.once, data: `a:o:${k}` }],
            ...(member ? [] : [[{ label: t.approval.always(request.tool), data: `a:a:${k}` }]]),
            [{ label: t.approval.deny, data: `a:d:${k}` }],
          ],
        }
      : { text: `${text}\n\n${member ? t.approval.typedOnce(k, p) : t.approval.typed(k, p)}` }
    const here = tracker.to.kind === 'dm' && owner?.dm === tracker.to.id
    // An owner with no private chat (group-only platforms like Twitch) is asked where the run is; only their press
    // counts there too.
    const target: ChannelChat | undefined = here
      ? tracker.to
      : owner?.dm
        ? { id: owner.dm, kind: 'dm' }
        : owner
          ? tracker.to
          : undefined
    if (!target) {
      await tracker.adapter.send(tracker.to, { text: t.approval.noOwner }).catch(() => {})
      return
    }
    const ref = await tracker.adapter.send(target, message)
    this._note(tracker.channel, 'approval', t.activity.approval(request.agent))
    this._approvals.set(k, {
      channel: tracker.channel,
      colonyId: tracker.colonyId,
      id: request.id,
      tool: request.tool,
      text,
      messages: [{ adapter: tracker.adapter, ref, to: target }],
      member: Boolean(member),
    })
    if (target !== tracker.to)
      await tracker.adapter.send(tracker.to, { text: t.approval.elsewhere }).catch(() => {})
  }

  private _closeApproval(decided: EventPayloads['approval/decided']) {
    for (const [k, open] of this._approvals) {
      if (open.id !== decided.id) continue
      this._approvals.delete(k)
      const outcome = t.approval.decidedElsewhere(decided.approved, decided.by)
      for (const msg of open.messages)
        void this._settle(msg.adapter, msg.ref, msg.to, `${open.text}\n\n${outcome}`, outcome)
    }
  }

  /**
   * Shows how something ended (an approval decided): by editing its message where the platform can, otherwise as a
   * short new message, so a chat that cannot edit still learns the outcome.
   */
  private async _settle(
    adapter: ChannelAdapter,
    ref: SentRef,
    to: ChannelChat,
    edited: string,
    alone: string,
  ) {
    if (adapter.can.edit) await adapter.edit(ref, { text: edited }).catch(() => {})
    else await adapter.send(to, { text: alone }).catch(() => {})
  }

  private _statusText(tracker: Tracker): string {
    const head = `${t.status.working} · ${duration(Date.now() - tracker.started)}`
    if (tracker.approvals.size) return `${head}\n${t.status.waitingApproval}`
    if (tracker.question) return `${head}\n${t.status.waitingAnswer}`
    const lines = [...tracker.agents].map(([agent, doing]) => `• ${agent}: ${doing}`)
    return [head, ...(lines.length ? lines : [`• ${t.status.starting}`])].join('\n')
  }

  /** Edits the status line (or the streamed draft) at most once per `editMs`, with what is true when it runs. */
  private _schedule(tracker: Tracker) {
    if (tracker.flush || tracker.done || tracker.stream === 'final') return
    const wait = Math.max(0, tracker.adapter.limits.editMs - (Date.now() - tracker.lastEdit))
    tracker.flush = setTimeout(() => {
      tracker.flush = undefined
      if (tracker.done) return
      tracker.lastEdit = Date.now()
      if (tracker.stream === 'partial') return void this._flushDraft(tracker)
      if (!tracker.ref) return
      const text = this._statusText(tracker)
      if (text === tracker.shown) return
      tracker.shown = text
      void tracker.adapter.edit(tracker.ref, { text }).catch(() => {})
    }, wait)
  }

  private async _flushDraft(tracker: Tracker) {
    const draft = tracker.draft
    if (!draft?.text.trim()) return
    const limit = tracker.adapter.limits.text - 20
    const text = draft.text.length > limit ? `${draft.text.slice(0, limit)} …` : `${draft.text} ▉`
    if (text === draft.shown) return
    draft.shown = text
    if (draft.ref) await tracker.adapter.edit(draft.ref, { text }).catch(() => {})
    else draft.ref = await tracker.adapter.send(tracker.to, { text }).catch(() => undefined)
  }

  private _release(tracker: Tracker) {
    tracker.done = true
    clearTimeout(tracker.flush)
    clearInterval(tracker.typing)
  }

  /** The round ended: the status line says how, then the answer arrives as a new message, then its files. */
  private async _finish(tracker: Tracker) {
    if (tracker.done) return
    this._release(tracker)
    this._trackers.delete(tracker.colonyId)
    const events = await this.options.chats.read(tracker.colonyId)
    const full = foldColony(tracker.colonyId, events)
    const { state } = roundSlice(full, events)
    const info = full.rounds.at(-1)
    const time = duration(Date.now() - tracker.started)
    const cost = money(Object.values(state.agents).reduce((n, a) => n + a.cost, 0) || undefined)
    const line =
      info?.status === 'completed'
        ? t.status.done(time, cost)
        : info?.status === 'failed'
          ? t.status.failed(info.statusReason)
          : t.status.stopped(time, info?.statusReason)
    if (tracker.ref) await tracker.adapter.edit(tracker.ref, { text: line }).catch(() => {})
    const answer = state.chatMessages.filter((m) => m.from !== 'user' && m.final).at(-1)
    if (answer) {
      // A streamed draft becomes the answer's first part.
      const draft = tracker.draft?.ref
      const pieces = chunk(answer.text, tracker.adapter.limits.text)
      if (draft && pieces.length) {
        await tracker.adapter.edit(draft, { text: pieces[0] ?? '' }).catch(() => {})
        for (const piece of pieces.slice(1))
          await this._deliver(tracker.channel, tracker.adapter, tracker.to, piece)
      } else await this._deliver(tracker.channel, tracker.adapter, tracker.to, answer.text)
    } else if (tracker.stream !== 'progress')
      await this._deliver(tracker.channel, tracker.adapter, tracker.to, line)
    await this._sendFiles(tracker, events, info?.startSeq ?? 0)
  }

  /** The files the round made: sent as files where the platform takes them (up to a few), else listed. */
  private async _sendFiles(tracker: Tracker, events: readonly MyrEvent[], start: number) {
    const names = [
      ...new Set(
        events
          .filter((e) => e.seq >= start && e.type === 'artifact/versioned')
          .map((e) => (e.payload as EventPayloads['artifact/versioned']).name),
      ),
    ]
    if (!names.length) return
    const { adapter } = tracker
    const unsent: string[] = []
    for (const [i, name] of names.entries()) {
      if (!adapter.can.files || !adapter.sendFile || i >= MAX_FILES) {
        unsent.push(name)
        continue
      }
      const file = await this.options.chats.artifact(tracker.colonyId, name).catch(() => undefined)
      if (!file?.data.byteLength || file.data.byteLength > (adapter.limits.file ?? DEFAULT_FILE_LIMIT)) {
        unsent.push(name)
        continue
      }
      await adapter
        .sendFile(tracker.to, {
          name: name.split('/').pop() ?? name,
          mimeType: file.mediaType,
          data: file.data,
        })
        .catch(() => unsent.push(name))
    }
    if (unsent.length) await adapter.send(tracker.to, { text: t.files(unsent) }).catch(() => {})
  }

  /**
   * Sends text split to the platform's limit, each piece through the ledger: owed before the send, removed once
   * delivered, retried after a refusal (Hermes's delivery ledger).
   */
  private async _deliver(channel: string, adapter: ChannelAdapter, to: ChannelChat, text: string) {
    for (const piece of chunk(text, adapter.limits.text)) {
      const id = this._ledger.owe(channel, to.id, to.thread, piece)
      await this._attempt(channel, adapter, { id, chat: to, text: piece }, 0)
    }
  }

  private async _attempt(
    channel: string,
    adapter: ChannelAdapter,
    entry: { id: string; chat: ChannelChat; text: string },
    tries: number,
  ) {
    this._ledger.attempting(entry.id)
    try {
      await adapter.send(entry.chat, { text: entry.text })
      this._ledger.delivered(entry.id)
      this._touch(channel, { lastOut: new Date().toISOString() })
      this._note(channel, 'out', t.activity.out)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      this._ledger.failed(entry.id, why)
      this._touch(channel, { lastError: why })
      this._note(channel, 'failed', t.activity.failed(why, RETRY_MS[tries] !== undefined))
      const wait = RETRY_MS[tries]
      if (wait === undefined) return
      const timer = setTimeout(() => {
        this._retries.delete(timer)
        if (this._running.get(channel) === adapter) void this._attempt(channel, adapter, entry, tries + 1)
      }, wait)
      this._retries.add(timer)
    }
  }

  /** Answers still owed when a channel comes back: sent again, marked when they may already have arrived. */
  private async _redeliver(channel: string, adapter: ChannelAdapter) {
    for (const owed of this._ledger.owed(channel)) {
      // Pending ones never started; ones caught mid-send or refused may have landed, so they say so.
      const text = owed.state === 'pending' ? owed.text : `${t.recovered}${owed.text}`
      const chat: ChannelChat = { id: owed.chat, kind: 'dm', ...(owed.thread ? { thread: owed.thread } : {}) }
      await this._attempt(channel, adapter, { id: owed.id, chat, text }, RETRY_MS.length)
    }
  }
}
