import { type EventPayloads, foldColony, type MyrEvent, roundSlice } from '@myrmidon/protocol'
import { prompts } from '../prompts.ts'
import { channelCopy as t } from './copy.ts'
import { chunk, duration, money, toolPhrase } from './format.ts'
import { ChannelLedger, type ChannelPerson, ChannelStore, type PairingRequest } from './store.ts'
import type { AdapterFactory, AdapterStatus, ChannelAdapter, Inbound, SentRef } from './types.ts'

/** What the hub needs of Myrmidon's chats (ChatService, wrapped with the person's default team). */
export interface ChannelChats {
  /** Delivers to the chat's running round, or starts one; a new chat when `chatId` is undefined. */
  send(
    text: string,
    chatId: string | undefined,
    project?: string,
  ): Promise<{ chatId: string; colonyId: string; started: boolean; round?: number }>
  rename(chatId: string, title: string): Promise<unknown>
  stop(chatId: string): Promise<void>
  /** Every event as it is appended to any colony. */
  onEvents(listener: (colonyId: string, events: readonly MyrEvent[]) => void): () => void
  read(colonyId: string): Promise<readonly MyrEvent[]>
}

/** A platform the hub can run: its name and how to make its adapter from a token. */
export interface ChannelKind {
  readonly label: string
  readonly make: AdapterFactory
}

/** One channel as Settings shows it; tokens never leave the hub. */
export interface ChannelInfo {
  readonly id: string
  readonly label: string
  readonly configured: boolean
  readonly enabled: boolean
  readonly project?: string
  readonly status: AdapterStatus | { readonly state: 'off' }
  readonly people: readonly ChannelPerson[]
  readonly groups: readonly { id: string; title: string; approvedAt: string }[]
  readonly pending: readonly Omit<PairingRequest, 'codeHash'>[]
}

/** Typing lasts about 5 s on Telegram; renewing it a little sooner keeps it steady. */
const TYPING_MS = 4000
/** More messages than this from one chat in a minute are dropped (a loop, or someone flooding). */
const FLOOD_PER_MINUTE = 20

/** A round started from a channel, followed until it ends: its status line and what each agent is doing. */
interface Tracker {
  readonly channel: string
  readonly adapter: ChannelAdapter
  readonly chat: string
  readonly chatId: string
  readonly colonyId: string
  readonly started: number
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
  done: boolean
}

/**
 * Everything channels share (after Hermes's gateway and OpenClaw's channel core): who may talk (pairing codes, an
 * owner, approved groups that need a mention), which Myrmidon chat a conversation continues, commands, a status
 * line that follows the round, the answer split to the platform's limit, and dropping redeliveries. Platforms only
 * receive and send (`ChannelAdapter`).
 */
export class ChannelHub {
  readonly store: ChannelStore
  private readonly _ledger: ChannelLedger
  private readonly _running = new Map<string, ChannelAdapter>()
  private readonly _status = new Map<string, AdapterStatus>()
  private readonly _lanes = new Map<string, Promise<void>>()
  private readonly _trackers = new Map<string, Tracker>()
  private readonly _recent = new Map<string, number[]>()
  private _offEvents?: () => void

  constructor(
    private readonly options: {
      readonly dir: string
      readonly chats: ChannelChats
      readonly kinds: Readonly<Record<string, ChannelKind>>
      readonly log?: (message: string) => void
    },
  ) {
    this.store = new ChannelStore(options.dir)
    this._ledger = new ChannelLedger(options.dir)
  }

  /** Starts every channel that is switched on and has a token. */
  async start() {
    for (const id of Object.keys(this.options.kinds)) await this._restart(id).catch(() => {})
  }

  async stop() {
    this._offEvents?.()
    this._offEvents = undefined
    for (const tracker of this._trackers.values()) this._release(tracker)
    this._trackers.clear()
    for (const adapter of this._running.values()) await adapter.stop().catch(() => {})
    this._running.clear()
    this._ledger.close()
  }

  list(): ChannelInfo[] {
    return Object.entries(this.options.kinds).map(([id, kind]) => {
      const c = this.store.get(id)
      return {
        id,
        label: kind.label,
        configured: Boolean(c.token),
        enabled: c.enabled,
        ...(c.project ? { project: c.project } : {}),
        status: this._running.has(id) ? (this._status.get(id) ?? { state: 'connecting' }) : { state: 'off' },
        people: c.people,
        groups: c.groups,
        pending: c.pending.map(({ codeHash: _hash, ...rest }) => rest),
      }
    })
  }

  /** Saves a channel's token (checked first), whether it runs, and its project; then restarts it. */
  async configure(id: string, patch: { token?: string; enabled?: boolean; project?: string | null }) {
    const kind = this._kind(id)
    if (patch.token !== undefined) {
      const token = patch.token.trim()
      // A token is only kept once the platform accepts it.
      if (token) await kind.make({ token }).check()
      this.store.update(id, (c) => {
        c.token = token || undefined
        if (token && patch.enabled === undefined) c.enabled = true
      })
    }
    this.store.update(id, (c) => {
      if (patch.enabled !== undefined) c.enabled = patch.enabled
      if (patch.project === null) delete c.project
      else if (patch.project !== undefined) c.project = patch.project
    })
    await this._restart(id)
    return this.list().find((c) => c.id === id)
  }

  /** Approves a waiting code (typed, or picked in Settings) and tells whoever asked. */
  async approve(id: string, by: { code: string } | { request: string }) {
    this._kind(id)
    const approved = this.store.approve(id, by)
    if (!approved) return undefined
    const adapter = this._running.get(id)
    const text = approved.group
      ? t.pairing.groupApproved
      : t.pairing.approved(approved.person?.role === 'owner')
    await adapter?.send(approved.request.chat.id, { text }).catch(() => {})
    return approved
  }

  revoke(id: string, kind: 'person' | 'group' | 'request', target: string): boolean {
    this._kind(id)
    return this.store.revoke(id, kind, target)
  }

  private _kind(id: string): ChannelKind {
    const kind = this.options.kinds[id]
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
    const c = this.store.get(id)
    if (!c.enabled || !c.token) return
    // Rounds are followed from the first channel that runs, whether started at launch or from Settings.
    this._offEvents ??= this.options.chats.onEvents((colonyId, events) => this._onEvents(colonyId, events))
    const adapter = this._kind(id).make({ token: c.token })
    this._running.set(id, adapter)
    await adapter.start({
      receive: (message) => this._receive(id, adapter, message),
      get: (key) => this._ledger.get(`${id}:${key}`),
      set: (key, value) => this._ledger.set(`${id}:${key}`, value),
      status: (status) => this._status.set(id, status),
      log: (message) => this.options.log?.(`${id}: ${message}`),
    })
  }

  /** Records the message (dropping a redelivery), then handles it in its chat's lane, in order. */
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

  private _flooded(channel: string, chat: string): boolean {
    const key = `${channel}:${chat}`
    const now = Date.now()
    const recent = (this._recent.get(key) ?? []).filter((at) => now - at < 60_000)
    recent.push(now)
    this._recent.set(key, recent)
    return recent.length > FLOOD_PER_MINUTE
  }

  private async _handle(channel: string, adapter: ChannelAdapter, m: Inbound) {
    const reply = (text: string) => adapter.send(m.chat.id, { text })
    const config = this.store.get(channel)
    const person = config.people.find((p) => p.id === m.sender.id)
    if (m.chat.kind === 'group') {
      if (!m.mentioned) return
      if (!config.groups.some((g) => g.id === m.chat.id)) {
        // Only someone already approved can ask for a group; strangers in it are ignored.
        const code = person && this.store.request(channel, 'group', m.sender, m.chat)
        if (code) await reply(t.pairing.group(code, channel))
        return
      }
      if (!person) return
    } else if (!person) {
      // Not acted on, not kept: a stranger gets a code, at most once per window (deny by default).
      const code = this.store.request(channel, 'person', m.sender, m.chat)
      if (code) await reply(t.pairing.code(code, channel))
      return
    }
    if (this._flooded(channel, m.chat.id)) return
    if (m.unsupported && !m.text.trim()) {
      await reply(t.unsupported)
      return
    }
    const command = /^\/([a-z_]+)(?:\s+([\s\S]*))?$/i.exec(m.text.trim())
    if (command) {
      await this._command(channel, adapter, m, (command[1] ?? '').toLowerCase())
      return
    }
    await this._forward(channel, adapter, m, person, config.chats[m.chat.id], config.project)
  }

  private async _command(channel: string, adapter: ChannelAdapter, m: Inbound, name: string) {
    const reply = (text: string) => adapter.send(m.chat.id, { text })
    const chatId = this.store.get(channel).chats[m.chat.id]
    const tracker = [...this._trackers.values()].find((x) => x.channel === channel && x.chat === m.chat.id)
    if (name === 'start' || name === 'help') return void (await reply(t.commands.help))
    if (name === 'new') {
      this.store.update(channel, (c) => {
        delete c.chats[m.chat.id]
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
    await reply(t.commands.unknown(name))
  }

  private async _forward(
    channel: string,
    adapter: ChannelAdapter,
    m: Inbound,
    person: ChannelPerson | undefined,
    existing: string | undefined,
    project: string | undefined,
  ) {
    const label = this._kind(channel).label
    const text =
      person && person.role !== 'owner' ? prompts.channels.member(m.sender.name, label, m.text) : m.text
    let sent: Awaited<ReturnType<ChannelChats['send']>>
    try {
      sent = await this.options.chats.send(text, existing, project)
    } catch (err) {
      await adapter.send(m.chat.id, { text: t.failed(err instanceof Error ? err.message : String(err)) })
      return
    }
    if (sent.chatId !== existing) {
      this.store.update(channel, (c) => {
        c.chats[m.chat.id] = sent.chatId
      })
      const who = m.chat.kind === 'group' ? (m.chat.title ?? m.sender.name) : m.sender.name
      await this.options.chats.rename(sent.chatId, t.title(label, who)).catch(() => {})
    }
    if (sent.started) await this._track(channel, adapter, m.chat.id, sent.chatId, sent.colonyId)
    else await adapter.typing(m.chat.id).catch(() => {})
  }

  private async _track(
    channel: string,
    adapter: ChannelAdapter,
    chat: string,
    chatId: string,
    colonyId: string,
  ) {
    if (this._trackers.has(colonyId)) return
    const tracker: Tracker = {
      channel,
      adapter,
      chat,
      chatId,
      colonyId,
      started: Date.now(),
      agents: new Map(),
      approvals: new Set(),
      question: false,
      escalating: false,
      lastEdit: 0,
      done: false,
    }
    this._trackers.set(colonyId, tracker)
    tracker.typing = setInterval(() => {
      if (!tracker.question && !tracker.approvals.size) void adapter.typing(chat).catch(() => {})
    }, TYPING_MS)
    void adapter.typing(chat).catch(() => {})
    tracker.shown = t.status.working
    tracker.ref = await adapter.send(chat, { text: tracker.shown }).catch(() => undefined)
    tracker.lastEdit = Date.now()
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
          // Options as a numbered list, answered by replying (buttons come with approvals in the chat).
          const choices = (p.choices ?? []).map(
            (c) => `\n\n${c.question}\n${c.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}`,
          )
          void this._sendLong(tracker.adapter, tracker.chat, `${p.text}${choices.join('')}`)
          break
        }
        case 'chat/user':
          tracker.question = false
          break
        case 'approval/requested':
          tracker.approvals.add((e.payload as EventPayloads['approval/requested']).id)
          break
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

  private _statusText(tracker: Tracker): string {
    const head = `${t.status.working} · ${duration(Date.now() - tracker.started)}`
    if (tracker.approvals.size) return `${head}\n${t.status.waitingApproval}`
    if (tracker.question) return `${head}\n${t.status.waitingAnswer}`
    const lines = [...tracker.agents].map(([agent, doing]) => `• ${agent}: ${doing}`)
    return [head, ...(lines.length ? lines : [`• ${t.status.starting}`])].join('\n')
  }

  /** Edits the status line at most once per `editMs`, with what is true at the moment it runs. */
  private _schedule(tracker: Tracker) {
    if (tracker.flush || tracker.done) return
    const wait = Math.max(0, tracker.adapter.limits.editMs - (Date.now() - tracker.lastEdit))
    tracker.flush = setTimeout(() => {
      tracker.flush = undefined
      if (tracker.done || !tracker.ref) return
      const text = this._statusText(tracker)
      if (text === tracker.shown) return
      tracker.shown = text
      tracker.lastEdit = Date.now()
      void tracker.adapter.edit(tracker.ref, { text }).catch(() => {})
    }, wait)
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
    if (answer) await this._sendLong(tracker.adapter, tracker.chat, answer.text)
    const start = info?.startSeq ?? 0
    const files = new Set(
      events
        .filter((e) => e.seq >= start && e.type === 'artifact/versioned')
        .map((e) => (e.payload as EventPayloads['artifact/versioned']).name),
    )
    if (files.size) await tracker.adapter.send(tracker.chat, { text: t.files([...files]) }).catch(() => {})
  }

  /** A message split to the platform's limit, sent in order. */
  private async _sendLong(adapter: ChannelAdapter, chat: string, text: string) {
    for (const piece of chunk(text, adapter.limits.text))
      await adapter.send(chat, { text: piece }).catch(() => {})
  }
}
